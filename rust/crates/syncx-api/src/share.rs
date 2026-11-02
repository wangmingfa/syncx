//! 分享链接:限时、免登录的**单文件只读**下载(默认关闭,`shareEnabled` 显式开启)。
//!
//! 令牌形态与 Node 侧 `src/share.ts` 逐字节一致:
//! `<id(32 hex)>.<expiresAt>.<sig(32 hex)>`,签名为
//! `HMAC-SHA256(sha256("syncx-share-v1|" + controlToken), "syncx-share-v1|<id>|<expiresAt>")`
//! 的前 32 位 hex。
//!
//! 密钥由**控制令牌**派生(域分离),不新增任何落盘机密;轮换 `control.token`
//! 即吊销全部在外的分享链接 —— 想紧急止血时改令牌就行。
//!
//! 失败一律回 404(不区分原因),不给探测者判别 oracle。这是安全属性,不是省事:
//! 区分「签名错」与「记录不存在」等于告诉攻击者哪些 id 真实存在。

use rand::RngCore;
use sha2::{Digest, Sha256};
use std::path::Path;

use crate::auth::safe_equal;
use crate::config::{ConfigStore, ShareRecord};

/// 活跃分享记录上限:超了先拒创建(防 config.json 被人肉滚雪球)。
pub const SHARE_CAP: usize = 100;
/// 有效期合法区间:1 分钟 – 30 天。
pub const MIN_TTL_MS: i64 = 60_000;
pub const MAX_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1000;
/// 创建接口接受的 ttlHours 白名单(与 Web UI 的四个选项一致)。
pub const TTL_HOURS_WHITELIST: [i64; 4] = [1, 24, 168, 720];

fn derive_share_key(control_token: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(format!("syncx-share-v1|{control_token}").as_bytes());
    hasher.finalize().into()
}

fn sign(key: &[u8; 32], id: &str, expires_at: i64) -> String {
    use hmac::Mac;
    let mut mac = <hmac::Hmac<Sha256> as hmac::Mac>::new_from_slice(key).expect("HMAC 接受任意长度密钥");
    mac.update(format!("syncx-share-v1|{id}|{expires_at}").as_bytes());
    let digest = mac.finalize().into_bytes();
    hex::encode(digest)[..32].to_string()
}

/// 校验令牌形态。返回 `(id, expiresAt, sig)`,形态不符返回 `None`。
///
/// 先粗筛再验签:脏串不进 HMAC,也不做无谓的解码。
fn parse_token(token: &str) -> Option<(String, i64, String)> {
    let mut parts = token.split('.');
    let id = parts.next()?;
    let expires = parts.next()?;
    let sig = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    if id.len() != 32 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    if sig.len() != 32 || !sig.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    if expires.is_empty() || expires.len() > 16 || !expires.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((id.to_string(), expires.parse().ok()?, sig.to_string()))
}

#[derive(Debug)]
pub struct IssuedShare {
    pub record: ShareRecord,
    /// 直接拼进 `/s/<token>` 的完整令牌。
    pub url_token: String,
}

#[derive(Debug)]
pub enum ShareError {
    /// 有效期超区间。
    TtlOutOfRange,
    /// 活跃分享已达上限。
    CapReached,
    /// 记录不存在(撤销时)。
    NotFound,
    /// 配置文件读写失败。
    Store(std::io::Error),
}

impl std::fmt::Display for ShareError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ShareError::TtlOutOfRange => write!(f, "分享有效期须在 1 分钟到 30 天之间"),
            ShareError::CapReached => {
                write!(f, "活跃分享已达上限 {SHARE_CAP} 条,请先撤销一些")
            }
            ShareError::NotFound => write!(f, "分享不存在(可能已被撤销)"),
            ShareError::Store(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for ShareError {}

impl From<std::io::Error> for ShareError {
    fn from(error: std::io::Error) -> Self {
        ShareError::Store(error)
    }
}

/// 校验失败的抽象原因。路由统一渲染 404 —— **不要**把 reason 暴露给客户端。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShareVerdict {
    Malformed,
    BadSignature,
    UnknownOrExpired,
}

#[derive(Debug)]
pub enum ShareCheck {
    Ok(ShareRecord),
    Rejected(ShareVerdict),
}

/// 分享记录存储。每次操作都读盘:记录随 `config.json` 持久化,daemon 重启链接不失效。
#[derive(Debug, Clone)]
pub struct ShareStore {
    config: ConfigStore,
    control_token: String,
}

impl ShareStore {
    pub fn new(config: ConfigStore, control_token: impl Into<String>) -> Self {
        Self {
            config,
            control_token: control_token.into(),
        }
    }

    pub fn enabled(&self) -> bool {
        self.config.load().share_enabled()
    }

    /// 当前有效(未过期未撤销)的分享,新→旧。只读,不落盘。
    pub fn list(&self, now: i64) -> Vec<ShareRecord> {
        let mut shares: Vec<ShareRecord> = self
            .config
            .load()
            .shares
            .unwrap_or_default()
            .into_iter()
            .filter(|s| s.expires_at > now)
            .collect();
        shares.sort_by_key(|share| std::cmp::Reverse(share.created_at));
        shares
    }

    /// 创建一条分享。调用方已确认目录存在且路径是可分享的普通文件。
    pub fn create(
        &self,
        folder_id: &str,
        path: &str,
        ttl_ms: i64,
        now: i64,
    ) -> Result<IssuedShare, ShareError> {
        if !(MIN_TTL_MS..=MAX_TTL_MS).contains(&ttl_ms) {
            return Err(ShareError::TtlOutOfRange);
        }
        let mut id_bytes = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut id_bytes);
        let id = hex::encode(id_bytes);
        let expires_at = now + ttl_ms;
        let record = ShareRecord {
            id: id.clone(),
            folder_id: folder_id.to_string(),
            path: path.to_string(),
            created_at: now,
            expires_at,
            downloads: None,
            last_download_at: None,
        };
        let record_for_save = record.clone();

        // 触顶就拒绝,不做静默淘汰:悄悄踢掉别人的链接比报错更糟。
        let mut cap_reached = false;
        self.config.mutate(|config| {
            let live: Vec<ShareRecord> = config
                .shares
                .as_ref()
                .map(|list| list.iter().filter(|s| s.expires_at > now).cloned().collect())
                .unwrap_or_default();
            if live.len() + 1 > SHARE_CAP {
                cap_reached = true;
                return Ok::<_, std::io::Error>(false);
            }
            let mut next = live;
            next.push(record_for_save.clone());
            config.shares = Some(next);
            Ok(true)
        })?;
        if cap_reached {
            return Err(ShareError::CapReached);
        }

        let url_token = format!(
            "{id}.{expires_at}.{}",
            sign(&derive_share_key(&self.control_token), &id, expires_at)
        );
        Ok(IssuedShare { record, url_token })
    }

    /// 撤销(删记录):即刻失效,哪怕令牌尚未过期。
    pub fn revoke(&self, id: &str) -> Result<ShareRecord, ShareError> {
        let mut removed: Option<ShareRecord> = None;
        self.config.mutate(|config| {
            let shares = config.shares.clone().unwrap_or_default();
            match shares.iter().find(|s| s.id == id) {
                Some(found) => removed = Some(found.clone()),
                None => return Ok::<_, std::io::Error>(false),
            }
            config.shares = Some(shares.into_iter().filter(|s| s.id != id).collect());
            Ok(true)
        })?;
        removed.ok_or(ShareError::NotFound)
    }

    /// 记一次匿名下载(计数 + 最近下载时间)。记录已被撤销时静默忽略 ——
    /// 撤销与下载竞态下计数丢了无所谓,不能因此让下载失败。
    pub fn note_download(&self, id: &str, now: i64) {
        let _ = self.config.mutate(|config| {
            let Some(shares) = config.shares.as_mut() else {
                return Ok::<_, std::io::Error>(false);
            };
            let Some(record) = shares.iter_mut().find(|s| s.id == id) else {
                return Ok(false);
            };
            record.downloads = Some(record.downloads.unwrap_or(0) + 1);
            record.last_download_at = Some(now);
            Ok(true)
        });
    }

    /// 校验匿名下载令牌:形态 → 验签(恒定时间)→ 记录在册且未过期未撤销。
    pub fn verify(&self, url_token: &str, now: i64) -> ShareCheck {
        let Some((id, expires_at, sig)) = parse_token(url_token) else {
            return ShareCheck::Rejected(ShareVerdict::Malformed);
        };
        if expires_at <= 0 || expires_at <= now {
            return ShareCheck::Rejected(ShareVerdict::UnknownOrExpired);
        }
        let expected = sign(&derive_share_key(&self.control_token), &id, expires_at);
        if !safe_equal(&expected, &sig) {
            return ShareCheck::Rejected(ShareVerdict::BadSignature);
        }
        let config = self.config.load();
        let Some(record) = config
            .shares
            .unwrap_or_default()
            .into_iter()
            .find(|s| s.id == id)
        else {
            return ShareCheck::Rejected(ShareVerdict::UnknownOrExpired);
        };
        // expiresAt 参与签名且必须与记录一致:记录被篡改/重建出不同有效期同样拒
        if record.expires_at != expires_at {
            return ShareCheck::Rejected(ShareVerdict::UnknownOrExpired);
        }
        ShareCheck::Ok(record)
    }
}

/// 把 `path` 的最后一段转成 RFC 5987 的 `filename*=UTF-8''...` 参数值。
///
/// 用 `encodeURIComponent` 的等价字符集(不转义 `A-Za-z0-9-_.!~*'()`),
/// 否则中文名下载后变成一串百分号。
pub fn content_disposition(path: &str) -> String {
    let base = Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string());
    const KEEP: &[u8] = b"-_.!~*'()";
    let mut encoded = String::new();
    for byte in base.as_bytes() {
        let ch = *byte as char;
        if ch.is_ascii_alphanumeric() || KEEP.contains(byte) {
            encoded.push(ch);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    format!("attachment; filename*=UTF-8''{encoded}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(tag: &str) -> (ShareStore, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "syncx-api-share-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.json");
        (ShareStore::new(ConfigStore::new(&path), "tok"), dir)
    }

    fn enable(store: &ShareStore) {
        store
            .config
            .mutate(|config| {
                config.share_enabled = Some(true);
                Ok::<_, std::io::Error>(true)
            })
            .unwrap();
    }

    #[test]
    fn create_list_verify_revoke() {
        let (store, dir) = store("lifecycle");
        enable(&store);
        let now = 1_800_000_000_000;
        let issued = store.create("f", "a/b.txt", 60_000, now).unwrap();
        assert_eq!(store.list(now).len(), 1);
        assert!(matches!(store.verify(&issued.url_token, now), ShareCheck::Ok(_)));

        // 改一个字节即失效
        let mut tampered = issued.url_token.clone();
        tampered.pop();
        tampered.push(if issued.url_token.ends_with('0') { '1' } else { '0' });
        assert!(matches!(
            store.verify(&tampered, now),
            ShareCheck::Rejected(ShareVerdict::BadSignature)
        ));

        // 过期即失效
        assert!(matches!(
            store.verify(&issued.url_token, now + 60_001),
            ShareCheck::Rejected(ShareVerdict::UnknownOrExpired)
        ));

        // 撤销后立即失效
        store.revoke(&issued.record.id).unwrap();
        assert!(matches!(
            store.verify(&issued.url_token, now),
            ShareCheck::Rejected(ShareVerdict::UnknownOrExpired)
        ));
        assert!(store.revoke(&issued.record.id).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn token_signed_with_other_control_token_fails() {
        let (store, dir) = store("rotated");
        enable(&store);
        let now = 1_800_000_000_000;
        let issued = store.create("f", "x.txt", 60_000, now).unwrap();
        // 轮换控制令牌 = 吊销全部在外的链接
        let rotated = ShareStore::new(ConfigStore::new(store.config.path()), "new-token");
        assert!(matches!(
            rotated.verify(&issued.url_token, now),
            ShareCheck::Rejected(ShareVerdict::BadSignature)
        ));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn ttl_bounds_enforced() {
        let (store, dir) = store("ttl");
        enable(&store);
        let now = 1_800_000_000_000;
        assert!(store.create("f", "x", 59_999, now).is_err());
        assert!(store.create("f", "x", MAX_TTL_MS + 1, now).is_err());
        assert!(store.create("f", "x", 60_000, now).is_ok());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn malformed_tokens() {
        let (store, dir) = store("malformed");
        for token in ["", "abc", "x.y.z", "a.b", "../../etc/passwd"] {
            assert!(matches!(
                store.verify(token, 1_800_000_000_000),
                ShareCheck::Rejected(ShareVerdict::Malformed)
            ));
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn download_counter() {
        let (store, dir) = store("download");
        enable(&store);
        let now = 1_800_000_000_000;
        let issued = store.create("f", "x.txt", 60_000, now).unwrap();
        store.note_download(&issued.record.id, now + 5);
        store.note_download(&issued.record.id, now + 9);
        let listed = store.list(now);
        assert_eq!(listed[0].downloads, Some(2));
        assert_eq!(listed[0].last_download_at, Some(now + 9));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn disposition_encodes_utf8_name() {
        assert_eq!(
            content_disposition("dir/报告 v2.pdf"),
            "attachment; filename*=UTF-8''%E6%8A%A5%E5%91%8A%20v2.pdf"
        );
        assert_eq!(
            content_disposition("a/plain-file_1.txt"),
            "attachment; filename*=UTF-8''plain-file_1.txt"
        );
    }
}
