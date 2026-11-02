///|
/// 设备身份与 Device ID 派生。对应 Node `src/identity.ts` 与 Rust
/// `rust/crates/syncx-net/src/identity.rs`。本文件只做身份模型与格式:
///   - 不做文件 I/O(读写落盘 `device.key` 属于 daemon/cli 里程碑);
///   - Ed25519 / SHA-256 原语走三方库 `cc06b/mooncry`(纯 MoonBit 实现,
///     见文末「密码学原语」段);安全随机数经最小 C stub 取系统熵源。
///
/// **Device ID 的派生必须逐位一致**:它是设备在局域网里的唯一标识,两端算法
/// 不同就意味着同一台机器在 Node 与 Rust/MoonBit 下是两台设备,已有的配对/
/// 共享关系全部失效,而症状是「对方把我当成陌生设备」—— 不报错,只是要重新
/// 配对一次。
///
/// Node 侧算法:`sha256(Ed25519 公钥的 PEM 文本)` 取前 6 字节(48 位),
/// 再把 48 位按 **5 位一组从低位到高位** 映射到 base32 字母表,得到 10 个字符。
/// 注意这里哈希的是 **PEM 文本**而不是 DER:那是 Node 的历史选择,跨语言复刻时
/// 必须照抄 PEM 的具体字节(换行位置都影响结果,见 `pem_encode_public_key`)。

///|
/// base32 字母表:RFC 4648,无填充,大写(与 Node 侧 `BASE32` 常量一致)。
let base32_chars : Array[Char] = [
  'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P',
  'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', '2', '3', '4', '5', '6', '7',
]

///|
/// 身份层错误。
pub(all) suberror IdentityError {
  InvalidKey(String)
}

///|
pub fn IdentityError::to_text(self : IdentityError) -> String {
  match self {
    InvalidKey(reason) => "身份密钥非法:\{reason}"
  }
}

///|
/// 设备身份:Ed25519 密钥对 + 由公钥派生的 Device ID。
pub(all) struct DeviceIdentity {
  device_id : String
  /// PEM 形态的公钥(`-----BEGIN PUBLIC KEY-----` 包裹的 SPKI)。
  public_key_pem : String
  /// PEM 形态的私钥(PKCS#8)。落盘与内存里都只传 PEM 文本,不含裸字节。
  private_key_pem : String
} derive(Eq, Debug)

///|
pub extend DeviceIdentity with Eq::{equal, not_equal}

///|
pub extend DeviceIdentity with @moonbitlang/core/debug.Debug::{to_repr}

// ==================== SHA-256 ====================
//
// Device ID 的派生依赖 sha256。原语来自三方库 `cc06b/mooncry`(纯 MoonBit
// 实现),正确性由官方向量(FIPS 180-4)与 Node fixture 逐字节对拍双重保证
// (见 identity_test.mbt)。这里保留同名包装,维持包内既有引用点与公开接口
// (`sha256 : Bytes -> Bytes`)不变。

///|
/// SHA-256 摘要(32 字节),直接委托 mooncry。
pub fn sha256(data : Bytes) -> Bytes {
  @lib.sha256(data)
}

// ==================== 公钥 PEM ====================

///|
/// Ed25519 SubjectPublicKeyInfo 的 DER 前缀(12 字节,hex 书写便于与
/// RFC 5280 对照):
/// `SEQUENCE { SEQUENCE { OID 1.3.101.112 }, BIT STRING { 32 字节 } }`。
/// 末字节 0x70 是 Ed25519 的 OID 尾;X25519 才是 0x6e(见 handshake.mbt)。
let ed25519_spki_prefix : Bytes = @hex.decode("302a300506032b6570032100") catch {
  _ => panic()
}

///|
/// 把 32 字节 Ed25519 公钥编成 PEM(SPKI)。
///
/// 必须与 Node `createPublicKey(...).export({type:'spki', format:'pem'})`
/// 的字节完全一致 —— Device ID 是对这段文本做哈希的:
///   - DER 头固定为 Ed25519 的 SPKI 前缀(12 字节);
///   - base64 每 64 字符换行(Ed25519 公钥 DER 共 44 字节 → 60 字符,
///     恒为单行,循环保留是为了与 Node 的通用实现同形);
///   - 结尾 `-----END PUBLIC KEY-----\n` 带一个换行。
pub fn pem_encode_public_key(
  raw_public_key : Bytes,
) -> String raise IdentityError {
  if raw_public_key.length() != 32 {
    raise InvalidKey(
      "Ed25519 公钥必须是 32 字节,实际 \{raw_public_key.length()}",
    )
  }
  let b64 = @base64.encode(ed25519_spki_prefix + raw_public_key)
  let mut out = "-----BEGIN PUBLIC KEY-----\n"
  let total = b64.length()
  let mut i = 0
  while i < total {
    let end = if i + 64 < total { i + 64 } else { total }
    out = out + b64[i:end].to_owned() + "\n"
    i = end
  }
  out + "-----END PUBLIC KEY-----\n"
}

///|
/// 从 PEM 解出 32 字节 Ed25519 公钥。
///
/// 三步都不能省:剥头尾标记 → base64 解码 → 验 SPKI 形态。PEM 解出来的是
/// 带 `SEQUENCE { OID, BIT STRING }` 外壳的 DER,直接当 32 字节公钥用会
/// 少剥一层壳,看起来像密钥坏了,实际是解析不完整。
pub fn parse_public_key_pem(
  public_key_pem : String,
) -> Bytes raise IdentityError {
  let head = "-----BEGIN PUBLIC KEY-----"
  let tail = "-----END PUBLIC KEY-----"
  let text = public_key_pem.trim().to_owned()
  if !text.has_prefix(head) || !text.has_suffix(tail) {
    raise InvalidKey("PEM 标签不是公钥(缺 BEGIN/END PUBLIC KEY 标记)")
  }
  if text.length() < head.length() + tail.length() {
    raise InvalidKey("公钥 PEM 长度非法")
  }
  let body = text[head.length():text.length() - tail.length()]
  let der = @base64.decode(body, ignore_whitespace=true) catch {
    _ => raise InvalidKey("公钥 PEM 的 base64 非法")
  }
  if der.length() != 44 || !der.has_prefix(ed25519_spki_prefix) {
    raise InvalidKey("公钥 DER 不是 Ed25519 SPKI 形态")
  }
  der.exact_view(start=12, end=44).to_owned()
}

// ==================== Device ID ====================

///|
/// 由公钥 PEM 派生 10 字符 Device ID。
///
/// 算法:`sha256(pem)` 前 6 字节 → 48 位整数 → **从低位起**每 5 位取一个
/// base32 字符。Node 的实现是 `out = BASE32[Number(value & 31n)] + out`
/// (注意是前插),前插 + 低位先取 = 结果里**最高位字符在最前**。复刻时要
/// 保持这个顺序,否则得到的是同一组字符的倒序 —— 看起来「很像」,但互不认账。
pub fn derive_device_id(public_key_pem : String) -> String {
  let hash = sha256(@utf8.encode(public_key_pem))
  let mut value : UInt64 = 0UL
  for i in 0..<6 {
    value = (value << 8) | hash.at(i).to_uint().to_uint64()
  }
  let chars : Array[Char] = Array::make(10, 'A')
  for idx in 0..<10 {
    // 低位先取,但放在结果的**最后** —— 等价于 Node 的前插
    chars[9 - idx] = base32_chars[(value & 31UL).to_int()]
    value = value >> 5
  }
  let mut out = ""
  for c in chars {
    out = out + c.to_string()
  }
  out
}

// ==================== 身份文件(device.key) ====================

///|
/// 由公私钥 PEM 组装身份(落盘 `device.key` 读回后的组装路径)。
/// 公钥先验形态并派生 Device ID;私钥只透传文本(解析推迟到签名时)。
pub fn DeviceIdentity::from_key_pems(
  public_key_pem : String,
  private_key_pem : String,
) -> DeviceIdentity raise IdentityError {
  let _ = parse_public_key_pem(public_key_pem)
  {
    device_id: derive_device_id(public_key_pem),
    public_key_pem,
    private_key_pem,
  }
}

///|
/// 身份文件(`device.key`)的 JSON 形态,字段名与 Node 逐字一致:
/// `deviceId` / `publicKey` / `privateKey`。Node 侧是
/// `JSON.stringify(identity, null, 2)`,键序与本函数一致(消费方只
/// JSON.parse,不依赖键序)。
pub fn DeviceIdentity::to_json(self : DeviceIdentity) -> Json {
  let map : Map[String, Json] = Map([])
  map.set("deviceId", Json::string(self.device_id))
  map.set("publicKey", Json::string(self.public_key_pem))
  map.set("privateKey", Json::string(self.private_key_pem))
  Json::object(map)
}

///|
/// 从身份文件 JSON 恢复身份。deviceId 必须与公钥重新派生的值一致 ——
/// 不一致说明文件被改坏或两端换了算法,静默接受会让本机以陌生身份行走。
pub fn DeviceIdentity::from_json(
  value : Json,
) -> DeviceIdentity raise IdentityError {
  let obj = match value {
    Object(obj) => obj
    _ => raise InvalidKey("身份文件应为 JSON 对象")
  }
  let device_id = identity_req_str(obj, "deviceId")
  let public_key_pem = identity_req_str(obj, "publicKey")
  let private_key_pem = identity_req_str(obj, "privateKey")
  let derived = derive_device_id(public_key_pem)
  if derived != device_id {
    raise InvalidKey(
      "deviceId(\{device_id})与公钥派生值(\{derived})不一致",
    )
  }
  let _ = parse_public_key_pem(public_key_pem)
  { device_id, public_key_pem, private_key_pem, }
}

///|
/// 身份文件里的必填字符串字段。
fn identity_req_str(
  map : Map[String, Json],
  key : String,
) -> String raise IdentityError {
  match map.get(key) {
    Some(String(s)) => s
    Some(_) => raise InvalidKey("字段 \{key} 应为字符串")
    None => raise InvalidKey("身份文件缺少字段 \{key}")
  }
}

// ==================== 密码学原语(mooncry) ====================
//
// 密码学原语来自三方库 `cc06b/mooncry`(纯 MoonBit 实现,mooncakes.io):
//   - Ed25519:公钥推导 / 签名 / 验签,以 32 字节种子为输入,与 Node
//     (`crypto.generateKeyPair('ed25519')` 的 PKCS#8 种子)和 Rust
//     (`ed25519-dalek` 的 SigningKey)语义一致,跨端互认;
//   - SHA-256:见上文包装函数。
// mooncry 不含安全随机数,系统熵源经最小 C stub 接入(见 crypto.h):
// 失败统一表现为 0 长度 Bytes,这里换算成 InvalidKey。

///|
extern "C" fn c_random_bytes(len : Int32) -> Bytes = "syncx_random_bytes"

///|
/// Ed25519 私钥 PKCS#8 DER 前缀(16 字节):
/// `SEQUENCE { INTEGER 0, SEQUENCE { OID 1.3.101.112 }, OCTET STRING(种子) }`。
/// 32 字节种子套上它就是 48 字节 DER —— 与 Node/Rust 的 PKCS#8 导出逐字节一致。
let pkcs8_prefix : Bytes = @hex.decode("302e020100300506032b657004220420") catch {
  _ => panic()
}

///|
/// 把 32 字节种子编成 PKCS#8 私钥 PEM(`PRIVATE KEY` 标签)。
///
/// 48 字节 DER 的 base64 恰为 64 字符,恒为单行;结尾 `-----END PRIVATE KEY-----`
/// 带一个换行,与 Rust `to_pkcs8_pem(LineEnding::LF)` 及 Node 的导出同形。
fn pkcs8_encode_private_key(seed : Bytes) -> String {
  "-----BEGIN PRIVATE KEY-----\n" +
  @base64.encode(pkcs8_prefix + seed) +
  "\n-----END PRIVATE KEY-----\n"
}

///|
/// 从 PKCS#8 私钥 PEM 解出 32 字节种子。
///
/// 只接受本协议自产的规范形态(48 字节 + 严格前缀),宽松解析会让畸形私钥
/// 混进签名路径。PKCS#8 理论上允许 v2 属性扩展,但对端(与本实现互认的
/// Node/Rust/MoonBit 三端)从来只发这种形态,别的形态一律拒收。
fn parse_private_key_pem(private_key_pem : String) -> Bytes raise IdentityError {
  let head = "-----BEGIN PRIVATE KEY-----"
  let tail = "-----END PRIVATE KEY-----"
  let text = private_key_pem.trim().to_owned()
  if !text.has_prefix(head) || !text.has_suffix(tail) {
    raise InvalidKey("PEM 标签不是私钥(缺 BEGIN/END PRIVATE KEY 标记)")
  }
  let body = text[head.length():text.length() - tail.length()]
  let der = @base64.decode(body, ignore_whitespace=true) catch {
    _ => raise InvalidKey("私钥 PEM 的 base64 非法")
  }
  if der.length() != 48 || !der.has_prefix(pkcs8_prefix) {
    raise InvalidKey("私钥 DER 不是 Ed25519 PKCS#8 形态")
  }
  der.exact_view(start=16, end=48).to_owned()
}

///|
/// 生成新身份:32 字节种子来自系统熵源,同一进程内两次生成必不相同。
pub fn DeviceIdentity::generate() -> DeviceIdentity raise IdentityError {
  let seed = c_random_bytes(32)
  if seed.length() != 32 {
    raise InvalidKey("系统熵源不可用,无法生成身份密钥")
  }
  DeviceIdentity::from_secret_bytes(seed)
}

///|
/// 由 32 字节种子恢复身份(同一份种子必须产出同一个 Device ID)。
pub fn DeviceIdentity::from_secret_bytes(
  secret : Bytes,
) -> DeviceIdentity raise IdentityError {
  if secret.length() != 32 {
    raise InvalidKey(
      "Ed25519 种子必须是 32 字节,实际 \{secret.length()}",
    )
  }
  let public = @lib.ed25519_public_key(secret)
  if public.length() != 32 {
    raise InvalidKey("Ed25519 公钥推导失败")
  }
  DeviceIdentity::from_key_pems(
    pem_encode_public_key(public),
    pkcs8_encode_private_key(secret),
  )
}

///|
/// 用设备私钥对挑战字节签名(配对验证用)。Ed25519 签名是确定性的:
/// 同一私钥对同一挑战恒出同一签名,可作跨实现对拍的 golden。
pub fn sign_challenge(
  identity : DeviceIdentity,
  challenge : Bytes,
) -> Bytes raise IdentityError {
  let seed = parse_private_key_pem(identity.private_key_pem)
  let sig = @lib.ed25519_sign(seed, challenge)
  if sig.length() != 64 {
    raise InvalidKey("Ed25519 签名失败")
  }
  sig
}

///|
/// 验证签名。签名长度不是 64 字节直接判非法,不进验签原语。
pub fn verify_challenge(
  public_key_pem : String,
  challenge : Bytes,
  signature : Bytes,
) -> Bool raise IdentityError {
  if signature.length() != 64 {
    return false
  }
  let public = parse_public_key_pem(public_key_pem)
  @lib.ed25519_verify(public, challenge, signature)
}
