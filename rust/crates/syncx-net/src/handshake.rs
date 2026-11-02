//! 两阶段握手:Ed25519 验身份,X25519 协商会话密钥。对应 Node 侧 `src/handshake.ts`
//! 与 `src/net/server.ts` 的握手部分。
//!
//! 流程(每端都一样,服务端是先收的一方):
//!   1. 明文发本机 Ed25519 **公钥 PEM**;
//!   2. 收对端公钥 PEM,派生其 Device ID(见 `identity.rs`);
//!   3. 生成一次性 X25519 密钥对,把 **公钥的 SPKI DER** 用自己的 Ed25519 私钥签名,
//!      连同 DER(base64)与签名(base64)发过去(`kx` 消息);
//!   4. 收对端的 `kx`,用第 2 步拿到的公钥验签 —— 通过才说明这个 X25519 公钥
//!      确实属于那个设备,中间人换不了;
//!   5. 会话密钥 = `sha256(X25519 DH 共享密钥)`。
//!
//! **签名只盖 X25519 DER,不盖整个 kx。** 这样给 kx 加字段(历史上的 `listenPort`、
//! `caps`)不必让旧对端验签失败;代价是这些字段不被认证,所以它们**只能**影响
//! 编码方式与重连提示,绝不能用来决定信任谁。改这一点就等于打开降级攻击的门。

use base64::Engine;
use ed25519_dalek::Verifier;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey, StaticSecret};

use crate::identity::{DeviceIdentity, IdentityError};

/// 二进制信封能力标签。见 `wire.rs` 的二进制段。
pub const CAP_BINARY1: &str = "binary1";

/// 本机宣告的全部能力(随版本追加;空 = 什么都不宣告)。
pub const PEER_CAPS: &[&str] = &[CAP_BINARY1];

/// X25519 SubjectPublicKeyInfo 的 DER 前缀(12 字节)。
///
/// 与 Node `createPublicKey(...).export({type:'spki',format:'der'})` 逐字节一致:
/// OID 1.3.101.110(X25519),注意末字节是 `0x6e`,Ed25519 才是 `0x70`。
const X25519_SPKI_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00,
];

/// SPKI DER 的总长度:12 字节前缀 + 32 字节公钥。
///
/// 12 里有 2 字节外层 SEQUENCE 头、7 字节内层 `SEQUENCE { OID }`、3 字节 BIT STRING 头。
pub const X25519_SPKI_DER_LEN: usize = 12 + 32;

/// 一次性 X25519 密钥对。
pub struct X25519KeyPair {
    pub secret: StaticSecret,
    /// SPKI DER(44 字节 = 12 前缀 + 32 公钥)。**签名对象就是这段字节**,
    /// 长度算错会让 VERIFY 永远失败,而症状只是"握手失败"。
    pub public_der: [u8; X25519_SPKI_DER_LEN],
}

impl X25519KeyPair {
    pub fn generate() -> Self {
        use rand::RngCore;
        let mut bytes = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut bytes);
        let secret = StaticSecret::from(bytes);
        let public = PublicKey::from(&secret);

        let mut public_der = [0u8; X25519_SPKI_DER_LEN];
        public_der[..12].copy_from_slice(&X25519_SPKI_PREFIX);
        public_der[12..].copy_from_slice(public.as_bytes());
        Self { secret, public_der }
    }

    /// 供 `kx` 发送的 base64 DER。
    pub fn public_der_b64(&self) -> String {
        b64(&self.public_der)
    }
}

/// 握手第二阶段的消息。
///
/// 字段名与线上 JSON 完全一致(`x25519` / `sig` / `listenPort` / `caps`),
/// 不要改成 camelCase 之外的写法。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KxMessage {
    #[serde(rename = "type")]
    pub kind: String,
    /// base64 的 X25519 公钥 DER。
    pub x25519: String,
    /// base64 的 Ed25519 签名(对象是 `x25519` 解出来的 DER 字节)。
    pub sig: String,
    /// 本机 peer 监听端口。连接方带上它,接收方结合 socket 源 IP 就能反向重连。
    #[serde(
        rename = "listenPort",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub listen_port: Option<u16>,
    /// 能力标签。缺省 = 旧版对端,数据面退回文本编码。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caps: Option<Vec<String>>,
}

impl KxMessage {
    /// 对端是否宣告了二进制信封能力。
    pub fn supports_binary(&self) -> bool {
        self.caps
            .as_deref()
            .is_some_and(|caps| caps.iter().any(|c| c == CAP_BINARY1))
    }
}

pub fn encode_kx_message(kx: &KxMessage) -> String {
    serde_json::to_string(kx).expect("KxMessage 应可序列化")
}

pub fn decode_kx_message(raw: &str) -> Result<KxMessage, HandshakeError> {
    serde_json::from_str(raw).map_err(|e| HandshakeError::Malformed(e.to_string()))
}

/// 构造并用设备 Ed25519 私钥签名一条 `kx`。
///
/// `caps` 按「空则不宣告」处理 —— 空数组在线上是缺省,和旧对端同形。
pub fn build_kx_message(
    pair: &X25519KeyPair,
    identity: &DeviceIdentity,
    listen_port: Option<u16>,
    caps: &[&str],
) -> Result<KxMessage, HandshakeError> {
    let signing = identity
        .signing_key()
        .map_err(|e: IdentityError| HandshakeError::Malformed(e.to_string()))?;
    use ed25519_dalek::Signer;
    let sig = signing.sign(&pair.public_der).to_bytes();

    Ok(KxMessage {
        kind: "kx".to_string(),
        x25519: pair.public_der_b64(),
        sig: b64(&sig),
        listen_port,
        caps: if caps.is_empty() {
            None
        } else {
            Some(caps.iter().map(|c| c.to_string()).collect())
        },
    })
}

/// 验证对端 `kx`,返回它的 X25519 公钥(32 字节)。
///
/// 验签对象是 `x25519` 字段解出来的 **DER 字节本身**,不是重新编码一遍的结果 ——
/// 重编码虽然通常等价,但一旦有第二个合法编码形式就会验签失败,而这在跨语言实现里
/// 是真实存在的坑(见 `parse_x25519_der` 对前缀的严格检查)。
pub fn verify_kx_message(
    kx: &KxMessage,
    peer_public_key_pem: &str,
) -> Result<[u8; 32], HandshakeError> {
    let der = unb64(&kx.x25519)?;
    let sig_bytes = unb64(&kx.sig)?;

    let signing = identity::parse_public_key_pem(peer_public_key_pem)
        .map_err(|e| HandshakeError::Malformed(e.to_string()))?;
    let sig_array: [u8; 64] = sig_bytes
        .as_slice()
        .try_into()
        .map_err(|_| HandshakeError::BadSignature)?;
    let signature = ed25519_dalek::Signature::from_bytes(&sig_array);
    signing
        .verify(&der, &signature)
        .map_err(|_| HandshakeError::BadSignature)?;

    parse_x25519_der(&der)
}

/// 从 SPKI DER 取出 32 字节 X25519 公钥。
///
/// 只接受 44 字节且前缀完全匹配的形态。宽松解析(比如「取最后 32 字节」)
/// 会让畸形输入混进来,而这里的字节随后直接参与 DH —— 宁可直接拒绝。
fn parse_x25519_der(der: &[u8]) -> Result<[u8; 32], HandshakeError> {
    if der.len() != X25519_SPKI_DER_LEN || der[..12] != X25519_SPKI_PREFIX {
        return Err(HandshakeError::Malformed(
            "X25519 公钥 DER 形态不符".to_string(),
        ));
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&der[12..]);
    Ok(key)
}

/// ECDH 协商并派生会话密钥:`sha256(shared_secret)`。
pub fn derive_session_key(pair: &X25519KeyPair, peer_public: &[u8; 32]) -> [u8; 32] {
    let shared = pair.secret.diffie_hellman(&PublicKey::from(*peer_public));
    let mut hasher = Sha256::new();
    hasher.update(shared.as_bytes());
    hasher.finalize().into()
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn unb64(text: &str) -> Result<Vec<u8>, HandshakeError> {
    base64::engine::general_purpose::STANDARD
        .decode(text)
        .map_err(|e| HandshakeError::Malformed(e.to_string()))
}

/// 握手层错误。
#[derive(Debug, thiserror::Error)]
pub enum HandshakeError {
    #[error("握手消息格式非法:{0}")]
    Malformed(String),
    #[error("kx 签名校验失败")]
    BadSignature,
}

use crate::identity;
