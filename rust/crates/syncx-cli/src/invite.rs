//! 一次性配对邀请码:生成、验签、吊销。
//!
//! 编码与校验规则必须与 Node 侧 `src/invite.ts` 逐位一致 —— 邀请码是**跨端**
//! 传给人的字符串,两个后端各造一套格式就等于把它们分成两个生态。
//!
//! 格式:`base64url(JSON({payload, sig}))`,其中
//!  * `payload` 是 `JSON.stringify({deviceId, publicKey, folder, ts})` 的**原文**
//!    (注意是字符串,不是对象 —— 验签必须对原文字节进行,重新序列化会改变键序);
//!  * `sig` 是 Ed25519 私钥对 payload 原文的签名,base64(标准字母表,非 url)。
//!
//! base64url 的无填充形态由 `base64` 的 `URL_SAFE_NO_PAD` 提供,与 Node 的
//! `'base64url'` 编码一致(两者都不补 `=`)。

use std::path::Path;

use base64::Engine;
use syncx_net::identity::{sign_challenge, verify_challenge, DeviceIdentity};

/// 邀请码有效期:1 小时。
pub const INVITE_TTL_MS: i64 = 60 * 60 * 1000;

/// 邀请码载荷。四个字段都是**跨端契约**(Node `InvitePayload` 同形),解析后原样带出;
/// `public_key` / `ts` 目前只有测试读,但它们不是噪音 —— 删掉任意一个,邀请码就再也
/// 没法验签或判过期,只是这个损失在编译期看不出来。
#[derive(Debug, Clone)]
pub struct InvitePayload {
    pub device_id: String,
    #[allow(dead_code)]
    pub public_key: String,
    pub folder: String,
    #[allow(dead_code)]
    pub ts: i64,
}

/// 邀请码失效的四种原因。文案与 Node 的 `throw new Error(...)` 一致 ——
/// CLI 直接把 `Display` 打给用户。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InviteError {
    InvalidCode,
    Revoked,
    BadSignature,
    Expired,
}

impl std::fmt::Display for InviteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            InviteError::InvalidCode => "invalid invitation code",
            InviteError::Revoked => "invitation revoked",
            InviteError::BadSignature => "invalid invitation signature",
            InviteError::Expired => "invitation expired",
        })
    }
}

impl std::error::Error for InviteError {}

fn revoke_file_path(config_dir: &Path) -> std::path::PathBuf {
    config_dir.join("revoked-invites.txt")
}

/// 吊销一个邀请码:追加到吊销列表(幂等,重复吊销不写第二行)。
pub fn revoke_invite_code(config_dir: &Path, code: &str) -> std::io::Result<()> {
    let file = revoke_file_path(config_dir);
    let existing = std::fs::read_to_string(&file).unwrap_or_default();
    let mut lines: Vec<String> = existing
        .trim()
        .split('\n')
        .filter(|line| !line.is_empty())
        .map(|line| line.to_string())
        .collect();
    if lines.iter().any(|line| line == code) {
        return Ok(());
    }
    lines.push(code.to_string());
    std::fs::write(&file, format!("{}\n", lines.join("\n")))
}

/// 邀请码是否已被吊销。
pub fn is_invite_revoked(config_dir: &Path, code: &str) -> bool {
    let Ok(content) = std::fs::read_to_string(revoke_file_path(config_dir)) else {
        return false;
    };
    let content = content.trim();
    if content.is_empty() {
        return false;
    }
    content.split('\n').any(|line| line == code)
}

fn b64url_encode(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn b64url_decode(text: &str) -> Option<Vec<u8>> {
    // Node 的 `Buffer.from(x, 'base64url')` 对填充是可选的;Rust 侧两种都试一次,
    // 免得对方实现补了 `=` 就解不开。
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(text)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(text))
        .ok()
}

fn b64_std_encode(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn b64_std_decode(text: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::STANDARD.decode(text).ok()
}

/// 生成一次性邀请码。`now` 是毫秒时间戳,由调用方给(测试注入固定时钟)。
pub fn create_invite_code(
    identity: &DeviceIdentity,
    folder: &str,
    now: i64,
) -> Result<String, Box<dyn std::error::Error>> {
    // 键序必须与 Node 的 `JSON.stringify({deviceId, publicKey, folder, ts})` 一致:
    // 验签对的是原文,键序变了签名就对不上。这里手写 JSON 而不是 serde_json 的
    // Value(Map 默认按字母序),就是为了把顺序钉死。
    let payload_json = format!(
        "{{\"deviceId\":{},\"publicKey\":{},\"folder\":{},\"ts\":{}}}",
        json_string(&identity.device_id),
        json_string(&identity.public_key_pem),
        json_string(folder),
        now
    );
    let signature = sign_challenge(identity, payload_json.as_bytes())?;
    let envelope = format!(
        "{{\"payload\":{},\"sig\":{}}}",
        json_string(&payload_json),
        json_string(&b64_std_encode(&signature))
    );
    Ok(b64url_encode(envelope.as_bytes()))
}

/// 解析并校验邀请码:`config_dir` 为 `None` 时跳过吊销校验(Node 侧同款)。
pub fn parse_invite_code(
    code: &str,
    config_dir: Option<&Path>,
    now: i64,
) -> Result<InvitePayload, InviteError> {
    if code.is_empty() {
        return Err(InviteError::InvalidCode);
    }
    if let Some(dir) = config_dir {
        if is_invite_revoked(dir, code) {
            return Err(InviteError::Revoked);
        }
    }
    let envelope_bytes = b64url_decode(code).ok_or(InviteError::InvalidCode)?;
    let envelope: serde_json::Value =
        serde_json::from_slice(&envelope_bytes).map_err(|_| InviteError::InvalidCode)?;
    let payload_json = envelope
        .get("payload")
        .and_then(|value| value.as_str())
        .ok_or(InviteError::InvalidCode)?;
    let signature_b64 = envelope
        .get("sig")
        .and_then(|value| value.as_str())
        .ok_or(InviteError::InvalidCode)?;

    let payload: serde_json::Value =
        serde_json::from_str(payload_json).map_err(|_| InviteError::InvalidCode)?;
    let device_id = payload
        .get("deviceId")
        .and_then(|value| value.as_str())
        .ok_or(InviteError::InvalidCode)?;
    let public_key = payload
        .get("publicKey")
        .and_then(|value| value.as_str())
        .ok_or(InviteError::InvalidCode)?;
    let folder = payload
        .get("folder")
        .and_then(|value| value.as_str())
        .ok_or(InviteError::InvalidCode)?;
    let ts = payload
        .get("ts")
        .and_then(|value| value.as_i64())
        .ok_or(InviteError::InvalidCode)?;

    let signature = b64_std_decode(signature_b64).ok_or(InviteError::BadSignature)?;
    let ok = verify_challenge(public_key, payload_json.as_bytes(), &signature)
        .map_err(|_| InviteError::BadSignature)?;
    if !ok {
        return Err(InviteError::BadSignature);
    }
    if now - ts > INVITE_TTL_MS {
        return Err(InviteError::Expired);
    }
    Ok(InvitePayload {
        device_id: device_id.to_string(),
        public_key: public_key.to_string(),
        folder: folder.to_string(),
        ts,
    })
}

/// JSON 字符串字面量(`"..."`,含转义)。只为把键序钉死,不引入完整的序列化器。
fn json_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// 当前毫秒时间戳。CLI 侧只用真实时钟;测试直接传 `now`。
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "syncx-cli-invite-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn round_trip_carries_every_field() {
        let identity = DeviceIdentity::generate();
        let code = create_invite_code(&identity, "D:/sync", 1_700_000_000_000).unwrap();
        let payload = parse_invite_code(&code, None, 1_700_000_000_500).unwrap();
        assert_eq!(payload.device_id, identity.device_id);
        assert_eq!(payload.public_key, identity.public_key_pem);
        assert_eq!(payload.folder, "D:/sync");
        assert_eq!(payload.ts, 1_700_000_000_000);
    }

    #[test]
    fn expired_after_one_hour() {
        let identity = DeviceIdentity::generate();
        let now = 1_700_000_000_000;
        let code = create_invite_code(&identity, "x", now).unwrap();
        assert_eq!(
            parse_invite_code(&code, None, now + INVITE_TTL_MS + 1).unwrap_err(),
            InviteError::Expired
        );
        assert!(parse_invite_code(&code, None, now + INVITE_TTL_MS).is_ok());
    }

    #[test]
    fn tampered_signature_is_rejected() {
        let identity = DeviceIdentity::generate();
        let code = create_invite_code(&identity, "x", now_ms()).unwrap();
        // 改一位 base64url 字符即破坏载荷/签名
        let mut bytes = code.into_bytes();
        let last = bytes.len() - 1;
        bytes[last] = if bytes[last] == b'A' { b'B' } else { b'A' };
        let broken = String::from_utf8(bytes).unwrap();
        assert!(matches!(
            parse_invite_code(&broken, None, now_ms()),
            Err(InviteError::InvalidCode) | Err(InviteError::BadSignature)
        ));
    }

    #[test]
    fn revoked_codes_are_refused() {
        let dir = temp_dir("revoke");
        let identity = DeviceIdentity::generate();
        let code = create_invite_code(&identity, "x", now_ms()).unwrap();
        assert!(parse_invite_code(&code, Some(&dir), now_ms()).is_ok());
        revoke_invite_code(&dir, &code).unwrap();
        revoke_invite_code(&dir, &code).unwrap(); // 幂等
        assert!(is_invite_revoked(&dir, &code));
        assert_eq!(
            parse_invite_code(&code, Some(&dir), now_ms()).unwrap_err(),
            InviteError::Revoked
        );
        let raw = std::fs::read_to_string(dir.join("revoked-invites.txt")).unwrap();
        assert_eq!(raw.matches(&code[..]).count(), 1, "重复吊销不能写两行");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn json_string_escapes_control_chars() {
        assert_eq!(json_string("a\"b\\c\nd"), "\"a\\\"b\\\\c\\nd\"");
        assert_eq!(json_string("\u{1}"), "\"\\u0001\"");
    }
}
