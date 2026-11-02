//! 设备身份与 Device ID 派生。对应 Node 侧 `src/identity.ts`。
//!
//! **Device ID 的派生必须逐位一致**:它是设备在局域网里的唯一标识,两端算法
//! 不同就意味着同一台机器在 Node 与 Rust 下是两台设备,已有的配对/共享关系
//! 全部失效,而症状是"对方把我当成陌生设备" —— 不报错,只是要重新配对一次。
//!
//! Node 侧算法:`sha256(Ed25519 公钥的 PEM 文本)` 取前 6 字节(48 位),
//! 再把 48 位按 **5 位一组从低位到高位** 映射到 base32 字母表,得到 10 个字符。
//!
//! 注意这里哈希的是 **PEM 文本**而不是 DER:那是 Node 的历史选择,跨语言复刻时
//! 必须照抄 PEM 的具体字节(见 `pem_encode_public_key`,换行位置都影响结果)。

use base64::Engine;
use ed25519_dalek::pkcs8::{DecodePrivateKey, EncodePrivateKey};
use ed25519_dalek::{Signer, SigningKey, Verifier, VerifyingKey};

/// base32 字母表:RFC 4648,无填充,大写(与 Node 侧 `BASE32` 常量一致)。
const BASE32: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/// 设备身份:Ed25519 密钥对 + 由公钥派生的 Device ID。
#[derive(Debug, Clone)]
pub struct DeviceIdentity {
    pub device_id: String,
    /// PEM 形态的公钥(`-----BEGIN PUBLIC KEY-----` 包裹的 SPKI)。
    pub public_key_pem: String,
    /// PEM 形态的私钥(PKCS#8)。
    pub private_key_pem: String,
}

impl DeviceIdentity {
    /// 生成新身份。
    pub fn generate() -> Self {
        use rand::RngCore;
        let mut secret = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut secret);
        Self::from_secret_bytes(&secret)
    }

    /// 由 32 字节种子构造(测试用:同一份种子必须产出同一个 Device ID)。
    pub fn from_secret_bytes(secret: &[u8; 32]) -> Self {
        let signing = SigningKey::from_bytes(secret);
        let verifying = signing.verifying_key();

        let public_key_pem = pem_encode_public_key(&verifying.to_bytes());
        let private_key_pem = signing
            .to_pkcs8_pem(ed25519_dalek::pkcs8::spki::der::pem::LineEnding::LF)
            .expect("PKCS#8 编码应成功")
            .to_string();

        Self {
            device_id: derive_device_id(&public_key_pem),
            public_key_pem,
            private_key_pem,
        }
    }

    /// 从私钥 PEM 恢复(落盘的 `device.key` 是 JSON,读回后走这里)。
    pub fn from_private_key_pem(private_key_pem: &str) -> Result<Self, IdentityError> {
        let signing = SigningKey::from_pkcs8_pem(private_key_pem)
            .map_err(|e| IdentityError::InvalidKey(e.to_string()))?;
        let verifying = signing.verifying_key();
        let public_key_pem = pem_encode_public_key(&verifying.to_bytes());
        Ok(Self {
            device_id: derive_device_id(&public_key_pem),
            public_key_pem,
            private_key_pem: private_key_pem.to_string(),
        })
    }

    /// 解出内部签名密钥。
    pub fn signing_key(&self) -> Result<SigningKey, IdentityError> {
        SigningKey::from_pkcs8_pem(&self.private_key_pem)
            .map_err(|e| IdentityError::InvalidKey(e.to_string()))
    }
}

/// 把 32 字节 Ed25519 公钥编成 PEM(SPKI)。
///
/// 必须与 Node `createPublicKey(...).export({type:'spki', format:'pem'})` 的
/// 字节完全一致 —— Device ID 是对这段文本做哈希的:
///   - DER 头固定为 Ed25519 的 SPKI 前缀(12 字节);
///   - base64 每 64 字符换行;
///   - 结尾 `-----END PUBLIC KEY-----\n` 带一个换行。
fn pem_encode_public_key(raw_public_key: &[u8; 32]) -> String {
    /// Ed25519 SubjectPublicKeyInfo 的 DER 前缀:
    /// SEQUENCE { SEQUENCE { OID 1.3.101.112 }, BIT STRING { 32 字节 } }
    const SPKI_PREFIX: [u8; 12] = [
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ];

    let mut der = Vec::with_capacity(SPKI_PREFIX.len() + 32);
    der.extend_from_slice(&SPKI_PREFIX);
    der.extend_from_slice(raw_public_key);

    let b64 = base64::engine::general_purpose::STANDARD.encode(&der);
    let mut out = String::from("-----BEGIN PUBLIC KEY-----\n");
    for chunk in b64.as_bytes().chunks(64) {
        out.push_str(std::str::from_utf8(chunk).expect("base64 是 ASCII"));
        out.push('\n');
    }
    out.push_str("-----END PUBLIC KEY-----\n");
    out
}

/// 由公钥 PEM 派生 10 字符 Device ID。
///
/// 算法:`sha256(pem)` 前 6 字节 → 48 位整数 → **从低位起**每 5 位取一个 base32 字符,
/// 拼成 10 字符。
///
/// Node 的实现是:
/// ```js
/// let out = '';
/// for (let i = 0; i < 10; i++) {
///   out = BASE32[Number(value & 31n)] + out;   // 注意是前插
///   value >>= 5n;
/// }
/// ```
/// 前插 + 低位先取 = 结果里**最高位字符在最前**。复刻时要保持这个顺序,
/// 否则得到的是同一组字符的倒序 —— 看起来"很像",但互不认账。
pub fn derive_device_id(public_key_pem: &str) -> String {
    use sha2::{Digest, Sha256};

    let hash = Sha256::digest(public_key_pem.as_bytes());
    let mut value: u64 = 0;
    for byte in hash.iter().take(6) {
        value = (value << 8) | u64::from(*byte);
    }

    let mut chars = [0u8; 10];
    for idx in 0..10 {
        let slot = BASE32[(value & 31) as usize];
        // 低位先取,但放在结果的**最后** —— 等价于 Node 的前插
        chars[9 - idx] = slot;
        value >>= 5;
    }
    String::from_utf8(chars.to_vec()).expect("base32 字母表是 ASCII")
}

/// 用设备私钥对挑战字节签名。
pub fn sign_challenge(
    identity: &DeviceIdentity,
    challenge: &[u8],
) -> Result<Vec<u8>, IdentityError> {
    let signing = identity.signing_key()?;
    Ok(signing.sign(challenge).to_bytes().to_vec())
}

/// 验证签名。
pub fn verify_challenge(
    public_key_pem: &str,
    challenge: &[u8],
    signature: &[u8],
) -> Result<bool, IdentityError> {
    let verifying = parse_public_key_pem(public_key_pem)?;
    let sig_bytes: [u8; 64] = signature
        .try_into()
        .map_err(|_| IdentityError::InvalidKey("签名长度不是 64 字节".to_string()))?;
    let sig = ed25519_dalek::Signature::from_bytes(&sig_bytes);
    Ok(verifying.verify(challenge, &sig).is_ok())
}

/// 从 PEM 解出 Ed25519 公钥。`pub(crate)` 供握手验签复用,不对外暴露。
///
/// **三步都不能省**:PEM 解出的是 SPKI DER(带 `SEQUENCE { OID, BIT STRING }` 外壳),
/// 而 `VerifyingKey` 只吃裸的 32 字节。直接 `VerifyingKey::try_from(der)` 会报
/// "must be 32 bytes in length" —— 看起来像密钥坏了,实际是少剥了一层壳。
pub(crate) fn parse_public_key_pem(public_key_pem: &str) -> Result<VerifyingKey, IdentityError> {
    use ed25519_dalek::pkcs8::spki::der::pem::PemLabel;
    use ed25519_dalek::pkcs8::spki::der::Decode;

    let (label, der) = ed25519_dalek::pkcs8::spki::der::pem::decode_vec(public_key_pem.as_bytes())
        .map_err(|e| IdentityError::InvalidKey(e.to_string()))?;
    if label != ed25519_dalek::pkcs8::spki::SubjectPublicKeyInfoRef::PEM_LABEL {
        return Err(IdentityError::InvalidKey(format!(
            "PEM 标签不是公钥:{label}"
        )));
    }
    let spki = ed25519_dalek::pkcs8::spki::SubjectPublicKeyInfoRef::from_der(&der)
        .map_err(|e| IdentityError::InvalidKey(e.to_string()))?;
    VerifyingKey::from_bytes(
        spki.subject_public_key
            .raw_bytes()
            .try_into()
            .map_err(|_| IdentityError::InvalidKey("Ed25519 公钥不是 32 字节".to_string()))?,
    )
    .map_err(|e| IdentityError::InvalidKey(e.to_string()))
}

/// 身份层错误。
#[derive(Debug, thiserror::Error)]
pub enum IdentityError {
    #[error("密钥非法:{0}")]
    InvalidKey(String),
}
