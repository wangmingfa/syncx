///|
/// 两阶段握手:Ed25519 验身份,X25519 协商会话密钥。对应 Node 侧
/// `src/handshake.ts` 与 Rust `rust/crates/syncx-net/src/handshake.rs`。
/// 本文件是**协议层**:kx 消息模型/编解码/形态校验,不含 socket I/O
/// (mocket 传输层是另一里程碑)。X25519 原语来自三方库 `cc06b/mooncry`
/// (纯 MoonBit 实现),Ed25519 验签走 identity.mbt。
///
/// 流程(每端都一样,服务端是先收的一方):
///   1. 明文发本机 Ed25519 **公钥 PEM**;
///   2. 收对端公钥 PEM,派生其 Device ID(见 identity.mbt);
///   3. 生成一次性 X25519 密钥对,把 **公钥的 SPKI DER** 用自己的 Ed25519
///      私钥签名,连同 DER(base64)与签名(base64)发过去(`kx` 消息);
///   4. 收对端的 `kx`,用第 2 步拿到的公钥验签 —— 通过才说明这个 X25519
///      公钥确实属于那个设备,中间人换不了;
///   5. 会话密钥 = `sha256(X25519 DH 共享密钥)`。
///
/// **签名只盖 X25519 DER,不盖整个 kx。** 这样给 kx 加字段(历史上的
/// `listenPort`、`caps`)不必让旧对端验签失败;代价是这些字段不被认证,
/// 所以它们**只能**影响编码方式与重连提示,绝不能用来决定信任谁。改这一
/// 点就等于打开降级攻击的门。
///
/// hello / pairing 消息的构建与解析在 wire.mbt(`make_hello` 与
/// ControlMessage 的 PairingRequest / PairingAck),不在本文件重复。

///|
/// 二进制信封能力标签。见 wire.mbt 的二进制段。
pub const CAP_BINARY1 : String = "binary1"

///|
/// 本机宣告的全部能力(随版本追加;空 = 什么都不宣告)。
/// 调用方据此构建 kx 的 `caps` 字段,空数组在线上是缺省、与旧对端同形。
pub fn peer_caps() -> Array[String] {
  [CAP_BINARY1]
}

///|
/// X25519 SubjectPublicKeyInfo 的 DER 前缀(12 字节)。
///
/// 与 Node `createPublicKey(...).export({type:'spki',format:'der'})` 逐字节
/// 一致:OID 1.3.101.110(X25519),注意末字节是 `0x6e`,Ed25519 才是
/// `0x70`(见 identity.mbt 的公钥前缀)。
let x25519_spki_prefix : Bytes = @hex.decode("302a300506032b656e032100") catch {
  _ => panic()
}

///|
/// SPKI DER 的总长度:12 字节前缀 + 32 字节公钥。
///
/// 12 里有 2 字节外层 SEQUENCE 头、7 字节内层 `SEQUENCE { OID }`、
/// 3 字节 BIT STRING 头。
pub const X25519_SPKI_DER_LEN : Int32 = 44

///|
/// 握手层错误。
pub(all) suberror HandshakeError {
  /// 消息形态非法(base64 / JSON / DER 形状不符)。
  Malformed(String)
  /// kx 验签失败。
  BadSignature
}

///|
pub fn HandshakeError::to_text(self : HandshakeError) -> String {
  match self {
    Malformed(reason) => "握手消息非法:\{reason}"
    BadSignature => "kx 签名校验失败"
  }
}

///|
/// 一次性 X25519 密钥对。
pub(all) struct X25519KeyPair {
  /// 32 字节私钥。
  secret : Bytes
  /// SPKI DER(44 字节 = 12 前缀 + 32 公钥)。**签名对象就是这段字节**,
  /// 长度算错会让 VERIFY 永远失败,而症状只是「握手失败」。
  public_der : Bytes
}

///|
/// 握手第二阶段的消息。
///
/// 字段名与线上 JSON 完全一致(`type` / `x25519` / `sig` / `listenPort` /
/// `caps`),不要改成 camelCase 之外的写法。
pub(all) struct KxMessage {
  /// 线上判别字段,恒为 `"kx"`。
  kind : String
  /// base64 的 X25519 公钥 DER。
  x25519 : String
  /// base64 的 Ed25519 签名(对象是 `x25519` 解出来的 DER 字节)。
  sig : String
  /// 本机 peer 监听端口。连接方带上它,接收方结合 socket 源 IP 就能反向
  /// 重连。缺省时整个键不出现(旧对端不发送此字段)。
  listen_port : Int32?
  /// 能力标签。缺省 = 旧版对端,数据面退回文本编码。
  caps : Array[String]?
} derive(Eq, Debug)

///|
pub extend KxMessage with Eq::{equal, not_equal}

///|
pub extend KxMessage with @moonbitlang/core/debug.Debug::{to_repr}

///|
/// 对端是否宣告了二进制信封能力。
pub fn KxMessage::supports_binary(self : KxMessage) -> Bool {
  match self.caps {
    Some(caps) => {
      let mut found = false
      for c in caps {
        if c == CAP_BINARY1 {
          found = true
        }
      }
      found
    }
    None => false
  }
}

///|
pub fn KxMessage::to_json(self : KxMessage) -> Json {
  let map : Map[String, Json] = Map([])
  set_str(map, "type", self.kind)
  set_str(map, "x25519", self.x25519)
  set_str(map, "sig", self.sig)
  set_opt_u64(map, "listenPort", self.listen_port.map(fn(p) { p.to_int64() }))
  set_opt_str_array(map, "caps", self.caps)
  Json::object(map)
}

///|
pub fn KxMessage::from_json(value : Json) -> KxMessage raise HandshakeError {
  let obj = expect_object(value, "kx 消息") catch {
    e => raise Malformed(e.to_text())
  }
  {
    kind: req_str(obj, "type") catch {
      e => raise Malformed(e.to_text())
    },
    x25519: req_str(obj, "x25519") catch {
      e => raise Malformed(e.to_text())
    },
    sig: req_str(obj, "sig") catch {
      e => raise Malformed(e.to_text())
    },
    listen_port: kx_opt_port(obj, "listenPort"),
    caps: opt_str_array(obj, "caps") catch {
      e => raise Malformed(e.to_text())
    },
  }
}

///|
/// `listenPort`:可缺省;出现则必须是 0..65535 的整数(Rust serde 对 u16
/// 的口径:负数、小数、超界一律拒收)。
fn kx_opt_port(
  map : Map[String, Json],
  key : String,
) -> Int32? raise HandshakeError {
  match map.get(key) {
    Some(Number(n, ..)) => {
      let port = n.to_int64()
      if n != port.to_double() || port < 0L || port > 65535L {
        raise Malformed("字段 \{key} 应为 0..65535 的整数")
      }
      Some(port.to_int())
    }
    Some(_) => raise Malformed("字段 \{key} 应为数字")
    None => None
  }
}

///|
pub fn encode_kx_message(kx : KxMessage) -> String {
  kx.to_json().stringify()
}

///|
/// 解码 kx。畸形消息抛错,由调用方丢弃整条 —— 线上数据不可信,宽进严出。
pub fn decode_kx_message(raw : String) -> KxMessage raise HandshakeError {
  let json = @json.parse(raw) catch {
    e => raise Malformed("kx 不是合法 JSON:\{e}")
  }
  KxMessage::from_json(json)
}

///|
/// 构造并用设备 Ed25519 私钥签名一条 `kx`。
///
/// `caps` 按「空则不宣告」处理 —— 空数组在线上是缺省,和旧对端同形。
pub fn build_kx_message(
  pair : X25519KeyPair,
  identity : DeviceIdentity,
  listen_port : Int32?,
  caps : Array[String],
) -> KxMessage raise HandshakeError {
  // 签名对象是 X25519 公钥的 SPKI DER 本身,不是整个 kx(见文件头注释)。
  let sig = sign_challenge(identity, pair.public_der) catch {
    e => raise Malformed(e.to_text())
  }
  {
    kind: "kx",
    x25519: @base64.encode(pair.public_der),
    sig: @base64.encode(sig),
    listen_port,
    caps: if caps.is_empty() {
      None
    } else {
      Some(caps)
    },
  }
}

///|
/// 验证对端 `kx`,返回它的 X25519 公钥(32 字节)。
///
/// 验签对象是 `x25519` 字段解出来的 **DER 字节本身**,不是重新编码一遍的
/// 结果 —— 重编码虽然通常等价,但一旦有第二个合法编码形式就会验签失败,
/// 而这在跨语言实现里是真实存在的坑(见 `parse_x25519_der` 的严格前缀检查)。
pub fn verify_kx_message(
  kx : KxMessage,
  peer_public_key_pem : String,
) -> Bytes raise HandshakeError {
  let der = kx_unb64(kx.x25519, "x25519")
  let sig = kx_unb64(kx.sig, "sig")
  let _ = parse_public_key_pem(peer_public_key_pem) catch {
    e => raise Malformed(e.to_text())
  }
  if sig.length() != 64 {
    raise BadSignature
  }
  let ok = verify_challenge(peer_public_key_pem, der, sig) catch {
    e => raise Malformed(e.to_text())
  }
  if !ok {
    raise BadSignature
  }
  parse_x25519_der(der)
}

///|
/// 从 SPKI DER 取出 32 字节 X25519 公钥。
///
/// 只接受 44 字节且前缀完全匹配的形态。宽松解析(比如「取最后 32 字节」)
/// 会让畸形输入混进来,而这里的字节随后直接参与 DH —— 宁可直接拒绝。
pub fn parse_x25519_der(der : Bytes) -> Bytes raise HandshakeError {
  if der.length() != X25519_SPKI_DER_LEN || !der.has_prefix(x25519_spki_prefix) {
    raise Malformed("X25519 公钥 DER 形态不符")
  }
  der.exact_view(start=12, end=X25519_SPKI_DER_LEN).to_owned()
}

///|
/// X25519 标量乘(RFC 7748):`clamp(secret) * u`,原语来自 mooncry。
///
/// X25519 的全部用途都收在这一个原语里:推自家公钥(`u` = 基点 9)、算 ECDH
/// 共享密钥(`u` = 对端公钥)。**不做全零输出检查** —— 与 Rust 侧 x25519-dalek
/// 的 `diffie_hellman` 同口径,拒收小阶点是上层的事(当前两端的私钥都来自
/// 系统熵源、公钥都经 kx 验签,小阶点混不进来)。
pub fn x25519_scalarmult(
  secret : Bytes,
  u : Bytes,
) -> Bytes raise HandshakeError {
  if secret.length() != 32 {
    raise Malformed("X25519 私钥必须是 32 字节")
  }
  if u.length() != 32 {
    raise Malformed("X25519 输入必须是 32 字节")
  }
  match @lib.x25519_or(secret, u) {
    Ok(out) => out
    Err(_) => raise Malformed("X25519 点乘失败")
  }
}

///|
/// X25519 基点(u = 9,小端 32 字节):私钥乘它得自家公钥。
let x25519_base_point : Bytes = @hex.decode(
  "0900000000000000000000000000000000000000000000000000000000000000",
) catch {
  _ => panic()
}

///|
/// 生成一次性 X25519 密钥对:私钥 32 字节系统熵源,公钥 = 私钥 × 基点,
/// 再套上 SPKI 前缀成 44 字节 DER。
pub fn X25519KeyPair::generate() -> X25519KeyPair raise HandshakeError {
  let secret = c_random_bytes(32)
  if secret.length() != 32 {
    raise Malformed("系统熵源不可用,无法生成 X25519 密钥对")
  }
  let public = x25519_scalarmult(secret, x25519_base_point)
  { secret, public_der: x25519_spki_prefix + public, }
}

///|
/// ECDH 协商并派生会话密钥:`sha256(shared_secret)`。
pub fn derive_session_key(
  pair : X25519KeyPair,
  peer_public : Bytes,
) -> Bytes raise HandshakeError {
  sha256(x25519_scalarmult(pair.secret, peer_public))
}

///|
/// base64 解码(标准字母表;kx 里的两个字段都用它)。
fn kx_unb64(text : String, what : String) -> Bytes raise HandshakeError {
  @base64.decode(text) catch {
    _ => raise Malformed("字段 \{what} 不是合法 base64")
  }
}
