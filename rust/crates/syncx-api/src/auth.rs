//! 账号口令、无状态签名会话、提权凭据。
//!
//! 与 Node 侧 `src/auth.ts` + `src/api/session.ts` **逐字节兼容** —— 这不是可选项:
//! 两个后端可能先后跑在同一个数据目录上,`auth.json` 里那份 scrypt 记录必须两端都认,
//! 否则「换成 Rust 后端 → 密码登录失败」而没有任何提示。
//!
//! 兼容点逐条列出(scrypt 参数最容易悄悄漂):
//!
//!  * scrypt N=16384, r=8, p=1, keyLen=64, salt=16 字节;
//!  * 会话 = `base64url(payload).base64url(HMAC-SHA256(key = HMAC(SESSION_CTX, base)))`;
//!  * `SESSION_CTX = "syncx-session-v1"`,TTL 24h;
//!  * 会话密钥的基:有账号 → 账号的 `hash`(改密码即让旧会话全失效);无账号 → control.token;
//!  * 提权密钥 = 同上再叠 `|elevate`,TTL 10 分钟。

use std::path::{Path, PathBuf};

use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use subtle::ConstantTimeEq;

type HmacSha256 = Hmac<Sha256>;

/// scrypt 参数。数值必须与 Node 侧 `SCRYPT` 常量逐项一致。
const LOG_N: u8 = 14; // N = 16384
const R: u32 = 8;
const P: u32 = 1;
const KEY_LEN: usize = 64;
const SALT_LEN: usize = 16;

/// 会话密钥派生上下文:改这个值等于让全部已签发会话失效。
const SESSION_CTX: &str = "syncx-session-v1";

/// 会话有效期:24 小时。
pub const SESSION_TTL_MS: i64 = 24 * 60 * 60 * 1000;
/// 提权有效期:10 分钟。
pub const ELEVATE_TTL_MS: i64 = 10 * 60 * 1000;

pub const COOKIE_NAME: &str = "syncx_session";
pub const ELEVATE_COOKIE: &str = "syncx_su";

/// `auth.json` 的落盘形态。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountRecord {
    pub username: String,
    pub algo: String,
    /// hex
    pub salt: String,
    /// hex,scrypt 派生结果
    pub hash: String,
    #[serde(rename = "createdAt", default)]
    pub created_at: i64,
    #[serde(rename = "updatedAt", default)]
    pub updated_at: i64,
}

/// 常量时间比较。长度不同直接 false(这也是一种信息泄露,但长度差异在
/// 定长十六进制的哈希比较里不存在,对 token 原文则无实际意义)。
pub fn safe_equal(a: &str, b: &str) -> bool {
    let ab = a.as_bytes();
    let bb = b.as_bytes();
    if ab.len() != bb.len() {
        return false;
    }
    ab.ct_eq(bb).into()
}

fn b64url(input: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(input)
}

fn b64url_decode(input: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(input).ok()
}

fn hmac_sha256(key: &[u8], message: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC 接受任意长度密钥");
    mac.update(message);
    mac.finalize().into_bytes().to_vec()
}

fn derive(password: &str, salt: &[u8]) -> Option<Vec<u8>> {
    let params = scrypt::Params::new(LOG_N, R, P, KEY_LEN).ok()?;
    let mut out = vec![0u8; KEY_LEN];
    scrypt::scrypt(password.as_bytes(), salt, &params, &mut out).ok()?;
    Some(out)
}

/// 读取账号记录。文件不存在或损坏返回 `None`(不抛 —— 一份坏 auth.json
/// 不该让整个 daemon 起不来,令牌通道仍然可用)。
pub fn load_account(file: &Path) -> Option<AccountRecord> {
    let raw = std::fs::read_to_string(file).ok()?;
    let record: AccountRecord = serde_json::from_str(&raw).ok()?;
    if record.algo != "scrypt" || record.salt.is_empty() || record.hash.is_empty() {
        return None;
    }
    Some(record)
}

/// 写入账号记录(0600,与 control.token 同一保护级别)。
fn write_account(file: &Path, record: &AccountRecord) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let body = format!("{}\n", serde_json::to_string_pretty(record)?);
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut handle = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(file)?;
        // 已存在的文件 mode 不会被 create 改,显式再设一次
        let _ = std::fs::set_permissions(
            file,
            <std::fs::Permissions as std::os::unix::fs::PermissionsExt>::from_mode(0o600),
        );
        handle.write_all(body.as_bytes())?;
    }
    #[cfg(not(unix))]
    {
        std::fs::write(file, body)?;
    }
    Ok(())
}

/// 设置(或覆盖)账号密码。
pub fn set_password(file: &Path, username: &str, password: &str) -> Result<AccountRecord, String> {
    let previous = load_account(file);
    let mut salt = [0u8; SALT_LEN];
    use rand::RngCore;
    rand::thread_rng().fill_bytes(&mut salt);
    let hash = derive(password, &salt).ok_or("scrypt 参数非法")?;
    let now = now_ms();
    let record = AccountRecord {
        username: username.to_string(),
        algo: "scrypt".to_string(),
        salt: hex::encode(salt),
        hash: hex::encode(hash),
        created_at: previous.map(|p| p.created_at).unwrap_or(now),
        updated_at: now,
    };
    write_account(file, &record).map_err(|e| e.to_string())?;
    Ok(record)
}

/// 校验密码。账号未设置时恒为 false。
pub fn verify_password(file: &Path, username: &str, password: &str) -> bool {
    let Some(record) = load_account(file) else {
        return false;
    };
    // 用户名也走常量时间比较,避免用响应耗时枚举用户名
    if !safe_equal(username, &record.username) {
        return false;
    }
    let Ok(salt) = hex::decode(&record.salt) else {
        return false;
    };
    let Some(hash) = derive(password, &salt) else {
        return false;
    };
    safe_equal(&hex::encode(hash), &record.hash)
}

/// 清除账号,退回「仅令牌登录」。文件不存在时不报错。
pub fn clear_password(file: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(file) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

/// 由「密码哈希」或「control.token」派生会话签名密钥。
pub fn session_secret(base: &str) -> String {
    hex::encode(hmac_sha256(SESSION_CTX.as_bytes(), base.as_bytes()))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionPayload {
    /// `password` / `token` / `elevate`
    pub via: String,
    pub sub: String,
    /// 过期时间(毫秒时间戳)
    pub exp: i64,
}

/// 签发会话:`<base64url(payload)>.<base64url(HMAC)>`。
pub fn sign_session(payload: &SessionPayload, secret: &str) -> String {
    let body = b64url(&serde_json::to_vec(payload).unwrap_or_default());
    let sig = b64url(&hmac_sha256(secret.as_bytes(), body.as_bytes()));
    format!("{body}.{sig}")
}

/// 校验会话。签名不符或已过期返回 `None`。
pub fn verify_session(value: &str, secret: &str) -> Option<SessionPayload> {
    let (body, sig) = value.split_once('.')?;
    if body.is_empty() || sig.is_empty() {
        return None;
    }
    let expected = b64url(&hmac_sha256(secret.as_bytes(), body.as_bytes()));
    if !safe_equal(sig, &expected) {
        return None;
    }
    let payload: SessionPayload = serde_json::from_slice(&b64url_decode(body)?).ok()?;
    if payload.exp <= now_ms() {
        return None;
    }
    Some(payload)
}

/// 会话/提权的签发与校验。闭包持有 control token 与账号文件路径,
/// 与 Node 的 `createSessionAuth` 一一对应。
#[derive(Debug, Clone)]
pub struct SessionAuth {
    token: String,
    auth_file: Option<PathBuf>,
}

impl SessionAuth {
    pub fn new(token: impl Into<String>, auth_file: Option<PathBuf>) -> Self {
        Self {
            token: token.into(),
            auth_file,
        }
    }

    /// 会话签名密钥的基:有账号用密码哈希(改密码即失效全部旧会话),
    /// 无账号用 control.token(未设密码时也能签发会话,但**cookie 里不是 token 原文**)。
    fn session_base(&self) -> String {
        match self.auth_file.as_deref().and_then(load_account) {
            Some(account) => account.hash,
            None => self.token.clone(),
        }
    }

    /// token 原文是否匹配。空串一律不通过 —— 否则「空 vs 空」的常量时间比较恒真,
    /// 整个控制 API 等于不设防。
    pub fn token_accepted(&self, candidate: Option<&str>) -> bool {
        match candidate {
            Some(value) if !value.is_empty() && !self.token.is_empty() => {
                safe_equal(value, &self.token)
            }
            _ => false,
        }
    }

    /// 凭据是否有效:Bearer/cookie 里的值可以是 token 原文,也可以是签名会话。
    pub fn credential_ok(&self, raw: Option<&str>) -> bool {
        let Some(raw) = raw.filter(|r| !r.is_empty()) else {
            return false;
        };
        if self.token_accepted(Some(raw)) {
            return true;
        }
        verify_session(raw, &session_secret(&self.session_base())).is_some()
    }

    /// 下发会话 cookie 值。
    pub fn session_cookie(&self, payload: &SessionPayload) -> String {
        sign_session(payload, &session_secret(&self.session_base()))
    }

    /// 敏感操作提权是否有效。与登录会话用**不同的签名密钥** —— 登录 cookie 冒充不了
    /// 提权 cookie,提权必须来自一次新鲜的密码/令牌校验。
    pub fn elevate_ok(&self, raw: Option<&str>) -> bool {
        let Some(raw) = raw.filter(|r| !r.is_empty()) else {
            return false;
        };
        verify_session(raw, &self.elevate_secret()).is_some()
    }

    fn elevate_secret(&self) -> String {
        session_secret(&format!("{}|elevate", self.session_base()))
    }

    /// 下发/续期提权 cookie 值(滑动:每次敏感请求成功后重新签发)。
    pub fn elevation_cookie(&self) -> String {
        let payload = SessionPayload {
            via: "elevate".to_string(),
            sub: "su".to_string(),
            exp: now_ms() + ELEVATE_TTL_MS,
        };
        sign_session(&payload, &self.elevate_secret())
    }

    pub fn has_account(&self) -> bool {
        self.auth_file.as_deref().and_then(load_account).is_some()
    }

    pub fn username(&self) -> Option<String> {
        self.auth_file
            .as_deref()
            .and_then(load_account)
            .map(|a| a.username)
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 组装 `Set-Cookie` 值。属性与 Node 逐字一致。
pub fn cookie_header(name: &str, value: &str, max_age_secs: i64) -> String {
    format!("{name}={value}; HttpOnly; SameSite=Lax; Path=/; Max-Age={max_age_secs}")
}

/// 清除 cookie(`Max-Age=0`)。
pub fn clear_cookie_header(name: &str) -> String {
    format!("{name}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "syncx-api-auth-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 与 Node 侧同一份口令必须派生出同一个哈希 —— 两端共用 auth.json 的前提。
    ///
    /// 期望值由 Node 现场算出(`node:crypto` 的 scryptSync,参数 N=16384/r=8/p=1,
    /// len=64)后固化。这是**跨实现**的断言:只要 scrypt 参数、盐编码或输出编码
    /// 任一处漂了,换成 Rust 后端就会「密码登录失败」且没有任何提示。
    #[test]
    fn scrypt_matches_node_derivation() {
        let salt = hex::decode("00112233445566778899aabbccddeeff").unwrap();
        let derived = hex::encode(derive("hunter2", &salt).unwrap());
        assert_eq!(
            derived,
            "162b9f7f4e53ff947ff972d4f4a1201cc2021a34527f2e93467b96e3b8cfdee4\
             40571bb671929b3a71c0aee2cb5e930adb22d758a09eee7b7263e1274f2b4635"
        );
        // 同参数同盐必须可复现(否则会话密钥基每次都变,所有会话立即失效)
        assert_eq!(hex::encode(derive("hunter2", &salt).unwrap()), derived);
        assert_ne!(hex::encode(derive("hunter3", &salt).unwrap()), derived);
    }

    /// 会话签名必须与 Node 逐字节一致:两个后端签发/验证同一枚 cookie。
    ///
    /// 锁定三件事:密钥派生(`HMAC(SESSION_CTX, base)`)、payload 的 JSON 键序
    /// (`via,sub,exp` —— serde 按字段声明顺序输出,与 Node 里写字的顺序相同)、
    /// base64url 无填充。
    #[test]
    fn session_matches_node_bytes() {
        assert_eq!(
            session_secret("base"),
            "8b88f9721be8e1911b857a6bb2496841763f3c0b507456dd6a4dcc408e920740"
        );
        let payload = SessionPayload {
            via: "password".to_string(),
            sub: "u".to_string(),
            exp: 1_800_000_000_000,
        };
        assert_eq!(
            sign_session(&payload, &session_secret("base")),
            "eyJ2aWEiOiJwYXNzd29yZCIsInN1YiI6InUiLCJleHAiOjE4MDAwMDAwMDAwMDB9\
             .6AjgMSI7kLootI7-wfocAL64wI6wiGNTbozNzNRfQRU"
        );
    }

    #[test]
    fn password_roundtrip() {
        let dir = temp_dir("pw");
        let file = dir.join("auth.json");
        assert!(!verify_password(&file, "u", "p"));
        set_password(&file, "u", "p@ssw0rd").unwrap();
        assert!(verify_password(&file, "u", "p@ssw0rd"));
        assert!(!verify_password(&file, "u", "wrong"));
        assert!(!verify_password(&file, "other", "p@ssw0rd"));
        clear_password(&file).unwrap();
        assert!(!verify_password(&file, "u", "p@ssw0rd"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn session_sign_and_verify() {
        let secret = session_secret("base");
        let payload = SessionPayload {
            via: "password".to_string(),
            sub: "u".to_string(),
            exp: now_ms() + 1000,
        };
        let value = sign_session(&payload, &secret);
        assert!(verify_session(&value, &secret).is_some());
        assert!(verify_session(&value, &session_secret("other")).is_none());
        // 过期即失效
        let expired = SessionPayload {
            exp: now_ms() - 1,
            ..payload
        };
        assert!(verify_session(&sign_session(&expired, &secret), &secret).is_none());
    }

    #[test]
    fn elevate_cannot_impersonate_session() {
        let dir = temp_dir("elevate");
        let file = dir.join("auth.json");
        let auth = SessionAuth::new("tok", Some(file));
        // 登录 cookie 不能当提权 cookie,提权 cookie 也不能当登录 cookie
        let session = auth.session_cookie(&SessionPayload {
            via: "token".to_string(),
            sub: "token".to_string(),
            exp: now_ms() + 1000,
        });
        assert!(auth.credential_ok(Some(&session)));
        assert!(!auth.elevate_ok(Some(&session)));
        let elevate = auth.elevation_cookie();
        assert!(auth.elevate_ok(Some(&elevate)));
        assert!(!auth.credential_ok(Some(&elevate)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_token_never_passes() {
        let auth = SessionAuth::new("", None);
        assert!(!auth.credential_ok(Some("")));
        assert!(!auth.token_accepted(Some("")));
        assert!(!auth.credential_ok(None));
    }
}
