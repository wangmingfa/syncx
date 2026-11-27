///|
/// 帧信封:AES-256-GCM 的两条线上形态。对应 Node `src/net/wire.ts` 的
/// `encryptMessage` / `decryptMessage` 与 `encodeBinaryFrame` / `decodeBinaryFrame`,
/// Rust `rust/crates/syncx-net/src/wire.rs` 的同名函数。
///
/// **为什么必须有这一层**:握手完成后(Node/Rust 都是)每一帧都加密,包括
/// hello、目录索引、块响应、直发控制消息。这是无条件行为 —— 没有「明文回退」
/// 分支。此前 `net/server.mbt` 与 `net/client.mbt` 收发都是明文 JSON,与
/// Node/Rust 连 hello 都握不上(它们收到明文会当成解密失败静默丢弃)。
///
/// 两条线格式:
///  - **文本信封**(控制面与小消息):`{"type":"enc","iv":b64,"tag":b64,"data":b64}`,
///    `data` 是整条 wire JSON 的密文。base64 用标准字母表(与 Node
///    `Buffer#toString('base64')` 同形)。
///  - **二进制信封**(块响应 / 索引 / 直发分片):
///    `iv(12) | tag(16) | [版本 1B][kind 1B][头长 u32 BE][头 JSON][body]`。
///    整段明文(前缀+头+体)一次加密,帧本身走 ws 二进制帧。
///
/// **解密失败的策略与 Node 一致**:丢弃该帧、不断链。对端不可信,坏帧不该
/// 掀翻整条连接(否则一个字节的噪声就能让同步断掉)。
///
/// 目前只有文本信封接进了收发路径;二进制信封的编解码已就绪,但**上层数据面
/// 还没改成用它**,所以 `peer_caps()` 暂不宣告 `binary1` —— 能力标签必须先
/// 有实现,否则对端会把索引/块响应改成二进制帧发过来,这边只会丢弃。

///|
/// AES-GCM 的 nonce 长度(位):96 位是 GCM 的标准形态,Node `randomBytes(12)`
/// 与 Rust `random_iv()` 用的都是它。
pub const ENVELOPE_IV_LEN : Int = 12

///|
/// GCM 认证标签长度:16 字节(128 位)。短 tag 会让伪造门槛呈指数下降,
/// 这里不接受可配置。
pub const ENVELOPE_TAG_LEN : Int = 16

///|
/// 二进制信封版本。对端版本不符时整帧丢弃(宽进严出),与 Node/Rust 同口径。
pub const BINARY_FRAME_VERSION : Int = 1

///|
/// `iv(12) + tag(16) + [版本 1B][kind 1B][头长 u32 BE]` = 34 字节固定开销。
/// 解码时先按它卡长度:比它还短的帧连密文都没有,不必进解密。
pub const BINARY_FRAME_OVERHEAD : Int = ENVELOPE_IV_LEN + ENVELOPE_TAG_LEN + 6

///|
/// 头部 JSON 上限:元数据远小于此,超限即视为坏帧 —— 不让一个畸形长度字段
/// 支配内存分配(与 Node `BINARY_HEADER_MAX`、Rust `BINARY_HEADER_MAX` 一致)。
pub const BINARY_HEADER_MAX : Int = 1024 * 1024

///|
/// 信封层错误。**解密失败只报一个笼统的原因此处不细分**:认证失败既可能是
/// 篡改、也可能是密钥不符或噪声,对上层而言处理方式完全相同(丢弃该帧)。
pub(all) suberror EnvelopeError {
  /// 形态不符(JSON 非对象、字段缺失、iv/tag 长度不对、版本不认识)。
  Malformed(String)
  /// 认证失败(密钥不符或密文被改动)。
  DecryptFailed
}

///|
pub fn EnvelopeError::to_text(self : EnvelopeError) -> String {
  match self {
    Malformed(reason) => "信封形态不符:\{reason}"
    DecryptFailed => "信封解密失败(密钥不符或内容被改动)"
  }
}

///|
/// 会话密钥必须是 32 字节(AES-256)。长度不对时直接拒绝 —— 悄悄补零或截断
/// 会让两端派生出不同密钥,症状是「每次握手成功但一收数据就静默丢帧」。
fn require_key(key : Bytes) -> Unit raise EnvelopeError {
  if key.length() != 32 {
    raise Malformed("会话密钥必须是 32 字节,实际 \{key.length()}")
  }
}

///|
/// 用给定 iv 封一条文本信封(确定性 —— 对拍测试靠它钉格式;生产路径用下面的
/// `encrypt_text_envelope` 取随机 iv)。
///
/// 输出字段顺序与 Node `JSON.stringify({type,iv,tag,data})` 一致,但**顺序不参与
/// 兼容性**:对端按字段名取值,不按位置解析。
pub fn seal_text_envelope(
  key : Bytes,
  plaintext : Bytes,
  iv : Bytes,
) -> String raise EnvelopeError {
  require_key(key)
  if iv.length() != ENVELOPE_IV_LEN {
    raise Malformed("iv 必须是 \{ENVELOPE_IV_LEN} 字节")
  }
  let box = @lib.aes_gcm_encrypt(plaintext, key, iv, b"")
  let envelope : Map[String, Json] = Map([])
  set_str(envelope, "type", "enc")
  set_str(envelope, "iv", @base64.encode(iv))
  set_str(envelope, "tag", @base64.encode(box.tag))
  set_str(envelope, "data", @base64.encode(box.ct))
  Json::object(envelope).stringify()
}

///|
/// 封一条文本信封,iv 取 12 字节系统熵源。熵源不可用时拒绝发送而不是退回
/// 固定 iv —— GCM 下 iv 复用等于把明文异或泄露出去。
pub fn encrypt_text_envelope(
  key : Bytes,
  plaintext : Bytes,
) -> String raise EnvelopeError {
  require_key(key)
  let iv = c_random_bytes(ENVELOPE_IV_LEN)
  if iv.length() != ENVELOPE_IV_LEN {
    raise Malformed("系统熵源不可用,无法生成 iv")
  }
  seal_text_envelope(key, plaintext, iv)
}

///|
/// 解一条文本信封,返回明文(调用方再自行 `decode_wire_message`)。
///
/// `type` 不是 `enc` 时抛 `Malformed` —— 与 Node `decryptMessage` 的显式检查
/// 一致。这样把「对端还在发明文」与「密钥不符」区分得开:前者是版本问题,
/// 后者是协商问题。
pub fn decrypt_text_envelope(key : Bytes, raw : String) -> Bytes raise EnvelopeError {
  require_key(key)
  let json = @json.parse(raw) catch {
    _ => raise Malformed("信封不是合法 JSON")
  }
  let envelope = match json {
    Object(obj) => obj
    _ => raise Malformed("信封应为 JSON 对象")
  }
  match envelope.get("type") {
    Some(String(kind)) =>
      if kind != "enc" {
        raise Malformed("期望加密信封,收到 type=\{kind}")
      }
    Some(_) => raise Malformed("字段 type 应为字符串")
    None => raise Malformed("缺少字段 type")
  }
  let iv = envelope_field(envelope, "iv")
  let tag = envelope_field(envelope, "tag")
  let data = envelope_field(envelope, "data")
  if iv.length() != ENVELOPE_IV_LEN {
    raise Malformed("iv 长度不是 \{ENVELOPE_IV_LEN}")
  }
  if tag.length() != ENVELOPE_TAG_LEN {
    raise Malformed("tag 长度不是 \{ENVELOPE_TAG_LEN}")
  }
  match @lib.aes_gcm_decrypt(data, key, iv, b"", tag) {
    Ok(plain) => plain
    Err(_) => raise DecryptFailed
  }
}

///|
/// 取一个 base64 字段(标准字母表)。字段缺失/非字符串/不是合法 base64 一律
/// 报形态错误 —— 线上数据不可信。
fn envelope_field(
  envelope : Map[String, Json],
  key : String,
) -> Bytes raise EnvelopeError {
  let text = match envelope.get(key) {
    Some(String(value)) => value
    Some(_) => raise Malformed("字段 \{key} 应为字符串")
    None => raise Malformed("缺少字段 \{key}")
  }
  @base64.decode(text) catch {
    _ => raise Malformed("字段 \{key} 不是合法 base64")
  }
}

///|
/// 解出来的二进制帧。
pub(all) struct BinaryFrame {
  /// 帧种类:1 = 块响应、2 = 索引、3 = 直发文件分片。
  kind : Int
  /// 元数据(块响应的 path/hash…、索引的 folder/full/relayed、分片的 id/seq)。
  header : Map[String, Json]
  /// 裸字节体:块内容或索引 JSON。
  body : Bytes
}

///|
/// 把 6 字节前缀拼出来:`[版本][kind][头长 u32 BE]`。
///
/// 用 `FixedArray[Byte]` 逐字节写再转 `Bytes` —— `Bytes` 本身没有可变索引
/// 赋值(它是不可变视图),这条路径在 net 包里已有多处先例。
fn binary_prefix(kind : Int, header_len : Int) -> Bytes {
  let prefix : FixedArray[Byte] = FixedArray::make(6, b'\x00')
  prefix[0] = BINARY_FRAME_VERSION.to_byte()
  prefix[1] = kind.to_byte()
  prefix[2] = (header_len >> 24).to_byte()
  prefix[3] = (header_len >> 16).to_byte()
  prefix[4] = (header_len >> 8).to_byte()
  prefix[5] = header_len.to_byte()
  prefix.unsafe_reinterpret_as_bytes()
}

///|
/// 读 4 字节大端无符号整数。调用前调用方已保证 `offset + 4 <= bytes.length()`。
fn read_u32_be(bytes : Bytes, offset : Int) -> Int {
  (bytes[offset].to_int() << 24)
  | (bytes[offset + 1].to_int() << 16)
  | (bytes[offset + 2].to_int() << 8)
  | bytes[offset + 3].to_int()
}

///|
/// 用给定 iv 封一帧二进制(确定性版本,供对拍与测试)。
///
/// `header` 先序列化成 JSON 再当明文的一部分 —— 与 Node 的
/// `JSON.stringify(header)` 同口径:头里只放元数据,二进制体走裸 body,
/// 免除块数据两层 base64 的开销。
pub fn seal_binary_frame(
  key : Bytes,
  kind : Int,
  header : Map[String, Json],
  body : Bytes,
  iv : Bytes,
) -> Bytes raise EnvelopeError {
  require_key(key)
  if iv.length() != ENVELOPE_IV_LEN {
    raise Malformed("iv 必须是 \{ENVELOPE_IV_LEN} 字节")
  }
  if kind < 1 || kind > 3 {
    raise Malformed("不认识的帧种类 \{kind}")
  }
  let header_bytes = @utf8.encode(Json::object(header).stringify())
  if header_bytes.length() > BINARY_HEADER_MAX {
    raise Malformed("头部 JSON 超出上限")
  }
  let plain = binary_prefix(kind, header_bytes.length()) + header_bytes + body
  let box = @lib.aes_gcm_encrypt(plain, key, iv, b"")
  iv + box.tag + box.ct
}

///|
/// 封一帧二进制,iv 取系统熵源。
pub fn encode_binary_frame(
  key : Bytes,
  kind : Int,
  header : Map[String, Json],
  body : Bytes,
) -> Bytes raise EnvelopeError {
  require_key(key)
  let iv = c_random_bytes(ENVELOPE_IV_LEN)
  if iv.length() != ENVELOPE_IV_LEN {
    raise Malformed("系统熵源不可用,无法生成 iv")
  }
  seal_binary_frame(key, kind, header, body, iv)
}

///|
/// 解一帧二进制。**任何**认证/长度/格式问题一律返回 None,与 Node
/// `decodeBinaryFrame` 返回 undefined 同口径:坏帧丢弃,不掀翻连接。
pub fn decode_binary_frame(
  key : Bytes,
  frame : Bytes,
) -> BinaryFrame? {
  if key.length() != 32 || frame.length() < BINARY_FRAME_OVERHEAD {
    return None
  }
  let iv = frame.exact_view(start=0, end=ENVELOPE_IV_LEN).to_owned()
  let tag = frame
    .exact_view(start=ENVELOPE_IV_LEN, end=ENVELOPE_IV_LEN + ENVELOPE_TAG_LEN)
    .to_owned()
  let cipher = frame
    .exact_view(start=ENVELOPE_IV_LEN + ENVELOPE_TAG_LEN, end=frame.length())
    .to_owned()
  let plain = match @lib.aes_gcm_decrypt(cipher, key, iv, b"", tag) {
    Ok(plain) => plain
    Err(_) => return None
  }
  if plain.length() < 6 || plain[0].to_int() != BINARY_FRAME_VERSION {
    return None
  }
  let kind = plain[1].to_int()
  if kind < 1 || kind > 3 {
    return None
  }
  let header_len = read_u32_be(plain, 2)
  if header_len == 0 || header_len > BINARY_HEADER_MAX {
    return None
  }
  if 6 + header_len > plain.length() {
    return None
  }
  let header_text = @utf8.decode_lossy(
    plain.exact_view(start=6, end=6 + header_len).to_owned(),
  )
  let parsed = @json.parse(header_text) catch {
    _ => return None
  }
  let header = match parsed {
    Object(obj) => obj
    // 头部不是 JSON 对象 = 坏帧。这里**不能**退回空 map:上层会按缺失字段
    // 推出默认值(比如块号 -1),比直接丢弃更难查。
    _ => return None
  }
  Some({
    kind,
    header,
    body: plain.exact_view(start=6 + header_len, end=plain.length()).to_owned(),
  })
}
