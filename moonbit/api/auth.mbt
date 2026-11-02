///|
/// 会话票据签发/校验(对齐 Rust `syncx-api/src/auth.rs` 与 Node `src/api/session.ts`,
/// 逐字节兼容):
///   - 会话 = `base64url(payload).base64url(HMAC-SHA256(key = HMAC(SESSION_CTX, base)))`;
///   - `SESSION_CTX = "syncx-session-v1"`,TTL 24 小时;
///   - 签名密钥的基:有账号 → 账号的 scrypt `hash`(改密码即让旧会话全失效);
///     无账号 → control.token 原文;
///   - payload JSON 键序固定 `via,sub,exp`(serde 按声明序输出,与 Node 手写序一致),
///     因此这里手工拼 JSON,不走 Map 序列化。

///|
/// 会话密钥派生上下文:改这个值等于让全部已签发会话失效。
const SESSION_CTX : String = "syncx-session-v1"

///|
/// 会话有效期:24 小时(毫秒)。
pub const SESSION_TTL_MS : Int64 = 24L * 60L * 60L * 1000L

///|
/// 会话 cookie 名,与 Rust/Node 的 `syncx_session` 逐字一致。
pub const SESSION_COOKIE : String = "syncx_session"

///|
/// scrypt 参数,与 Node `SCRYPT` 常量逐项一致(N=16384, r=8, p=1, keyLen=64)。
/// 两端共用同一份 `auth.json`,参数漂了就是「换后端后密码登录失败且无提示」。
const SCRYPT_LOG_N : Int32 = 14

///|
const SCRYPT_R : Int32 = 8

///|
const SCRYPT_P : Int32 = 1

///|
const SCRYPT_KEY_LEN : Int32 = 64

///|
/// 当前毫秒时间戳(与 Node `Date.now()` / Rust `now_ms` 同口径)。
pub fn now_ms() -> Int64 {
  @async.now()
}

///|
/// 会话载荷。`via`:`password` / `token`;`sub`:用户名或 "token";
/// `exp`:过期毫秒时间戳。
pub(all) struct SessionPayload {
  via : String
  sub : String
  exp : Int64
}

///|
/// `auth.json` 的落盘形态(只读用;设置/清除密码是后续里程碑)。
pub(all) struct AccountRecord {
  username : String
  algo : String
  /// hex
  salt : String
  /// hex,scrypt 派生结果
  hash : String
}

///|
/// 常量时间字符串比较:逐字节累积差异,长度不同直接 false。
pub fn safe_equal(a : String, b : String) -> Bool {
  let ab = @utf8.encode(a)
  let bb = @utf8.encode(b)
  if ab.length() != bb.length() {
    return false
  }
  let mut diff = 0
  for i in 0..<ab.length() {
    diff = diff | (ab[i].to_int() ^ bb[i].to_int())
  }
  diff == 0
}

// ---- base64url(RFC 4648 §5,无填充) --------------------------------------

///|
let b64url_alphabet : Array[Char] = [
  'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P',
  'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'a', 'b', 'c', 'd', 'e', 'f',
  'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v',
  'w', 'x', 'y', 'z', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '-', '_',
]

///|
fn b64url_encode(data : Bytes) -> String {
  let len = data.length()
  let buf = StringBuilder(size_hint=(len / 3 + 1) * 4)
  for i in 0..<(len / 3) {
    let b0 = data[i * 3].to_int()
    let b1 = data[i * 3 + 1].to_int()
    let b2 = data[i * 3 + 2].to_int()
    buf.write_char(b64url_alphabet[(b0 >> 2) & 0x3F])
    buf.write_char(b64url_alphabet[((b0 & 0x03) << 4) | (b1 >> 4)])
    buf.write_char(b64url_alphabet[((b1 & 0x0F) << 2) | (b2 >> 6)])
    buf.write_char(b64url_alphabet[b2 & 0x3F])
  }
  match len % 3 {
    1 => {
      let b0 = data[len - 1].to_int()
      buf.write_char(b64url_alphabet[(b0 >> 2) & 0x3F])
      buf.write_char(b64url_alphabet[(b0 & 0x03) << 4])
    }
    2 => {
      let b0 = data[len - 2].to_int()
      let b1 = data[len - 1].to_int()
      buf.write_char(b64url_alphabet[(b0 >> 2) & 0x3F])
      buf.write_char(b64url_alphabet[((b0 & 0x03) << 4) | (b1 >> 4)])
      buf.write_char(b64url_alphabet[(b1 & 0x0F) << 2])
    }
    _ => ()
  }
  buf.to_string()
}

///|
fn b64url_char_value(c : Int32) -> Int32 {
  if c >= 65 && c <= 90 {
    c - 65
  } else if c >= 97 && c <= 122 {
    c - 71
  } else if c >= 48 && c <= 57 {
    c + 4
  } else if c == 45 {
    62
  } else if c == 95 {
    63
  } else {
    -1
  }
}

///|
fn b64url_decode(encoded : String) -> Bytes? {
  let vals : Array[Int32] = []
  for c in encoded.iter() {
    let v = b64url_char_value(c.to_int())
    if v < 0 {
      return None
    }
    vals.push(v)
  }
  let n = vals.length()
  if n % 4 == 1 {
    return None
  }
  let out : Array[Byte] = []
  let full = n / 4
  for i in 0..<full {
    let v0 = vals[i * 4]
    let v1 = vals[i * 4 + 1]
    let v2 = vals[i * 4 + 2]
    let v3 = vals[i * 4 + 3]
    out.push(((v0 << 2) | (v1 >> 4)).to_byte())
    out.push((((v1 & 0x0F) << 4) | (v2 >> 2)).to_byte())
    out.push((((v2 & 0x03) << 6) | v3).to_byte())
  }
  match n % 4 {
    2 => {
      let v0 = vals[full * 4]
      let v1 = vals[full * 4 + 1]
      out.push(((v0 << 2) | (v1 >> 4)).to_byte())
    }
    3 => {
      let v0 = vals[full * 4]
      let v1 = vals[full * 4 + 1]
      let v2 = vals[full * 4 + 2]
      out.push(((v0 << 2) | (v1 >> 4)).to_byte())
      out.push((((v1 & 0x0F) << 4) | (v2 >> 2)).to_byte())
    }
    _ => ()
  }
  Some(Bytes::from_array(out))
}

///|
/// JSON 字符串字面量转义(与 serde_json / JSON.stringify 同口径:
/// `"`,`\` 与控制字符转义,其余原样)。
fn json_string_escape(s : String) -> String {
  let hex : Array[Char] = [
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f',
  ]
  let buf = StringBuilder(size_hint=s.char_length() + 2)
  for c in s.iter() {
    match c {
      '"' => buf.write_string("\\\"")
      '\\' => buf.write_string("\\\\")
      '\n' => buf.write_string("\\n")
      '\r' => buf.write_string("\\r")
      '\t' => buf.write_string("\\t")
      '\u{8}' => buf.write_string("\\b")
      '\u{c}' => buf.write_string("\\f")
      _ => {
        let code = c.to_int()
        if code < 0x20 {
          // 控制字符一律转成 \u00XX
          buf.write_string("\\u00")
          buf.write_char(hex[(code >> 4) & 0xF])
          buf.write_char(hex[code & 0xF])
        } else {
          buf.write_char(c)
        }
      }
    }
  }
  buf.to_string()
}

///|
/// payload 的 JSON 序列化。键序固定 `via,sub,exp` —— 这不是风格问题:
/// 签名覆盖的是字节串,键序漂了,与 Node/Rust 互认就断了。
fn session_payload_json(payload : SessionPayload) -> String {
  let via = json_string_escape(payload.via)
  let sub = json_string_escape(payload.sub)
  "{\"via\":\"\{via}\",\"sub\":\"\{sub}\",\"exp\":\{payload.exp}}"
}

///|
/// 由「密码哈希」或「control.token」派生会话签名密钥(hex)。
/// 与 Rust `auth::session_secret` 逐字节一致。
pub fn session_secret(base : String) -> String {
  @lib.bytes_to_hex(
    @lib.hmac_sha256(@utf8.encode(SESSION_CTX), @utf8.encode(base)),
  )
}

///|
/// 签发会话:`<base64url(payload)>.<base64url(HMAC)>`。
pub fn sign_session(payload : SessionPayload, secret : String) -> String {
  let body = b64url_encode(@utf8.encode(session_payload_json(payload)))
  let sig = b64url_encode(
    @lib.hmac_sha256(@utf8.encode(secret), @utf8.encode(body)),
  )
  "\{body}.\{sig}"
}

///|
/// 校验会话。签名不符 / 载荷损坏 / 已过期一律返回 None。
pub fn verify_session(value : String, secret : String) -> SessionPayload? {
  let (body, sig) = match value.split_once(".") {
    Some(pair) => pair
    None => return None
  }
  if body == "" || sig == "" {
    return None
  }
  let body = body.to_owned()
  let expected = b64url_encode(
    @lib.hmac_sha256(@utf8.encode(secret), @utf8.encode(body)),
  )
  if !safe_equal(sig.to_owned(), expected) {
    return None
  }
  let bytes = match b64url_decode(body) {
    Some(b) => b
    None => return None
  }
  // 注意:Bytes::to_string 不做 UTF-8 解码,这里必须走 utf8.decode
  let text = @utf8.decode(bytes.exact_view()) catch { _ => return None }
  let parsed = @json.parse(text) catch { _ => return None }
  match parsed {
    Object(obj) => {
      let via = match obj.get("via") {
        Some(String(s)) => s
        _ => return None
      }
      let sub = match obj.get("sub") {
        Some(String(s)) => s
        _ => return None
      }
      let exp = match obj.get("exp") {
        Some(Number(n, ..)) => n.to_int64()
        _ => return None
      }
      if exp <= now_ms() {
        return None
      }
      Some({ via, sub, exp, })
    }
    _ => None
  }
}

// ---- auth.json 读取 ------------------------------------------------------

///|
/// 读取账号记录。文件不存在或损坏返回 None(一份坏 auth.json 不该让
/// daemon 起不来,令牌通道仍然可用)。
pub async fn load_account(file : String) -> AccountRecord? {
  let raw = @fs.read_file(file).text() catch { _ => return None }
  let parsed = @json.parse(raw) catch { _ => return None }
  match parsed {
    Object(obj) => {
      let username = match obj.get("username") {
        Some(String(s)) => s
        _ => return None
      }
      let algo = match obj.get("algo") {
        Some(String(s)) => s
        _ => return None
      }
      let salt = match obj.get("salt") {
        Some(String(s)) => s
        _ => return None
      }
      let hash = match obj.get("hash") {
        Some(String(s)) => s
        _ => return None
      }
      if algo != "scrypt" || salt == "" || hash == "" {
        return None
      }
      Some({ username, algo, salt, hash, })
    }
    _ => None
  }
}

///|
/// scrypt 派生(N=16384, r=8, p=1, keyLen=64),与 Node `crypto.scryptSync`
/// 同参数 —— 两端共用同一份 auth.json 的前提。
pub fn derive_password_hash(password : String, salt : Bytes) -> Bytes {
  @lib.scrypt(
    @utf8.encode(password),
    salt,
    1 << SCRYPT_LOG_N,
    SCRYPT_R,
    SCRYPT_P,
    SCRYPT_KEY_LEN,
  )
}

///|
/// 校验密码。账号记录缺失/参数非法恒为 false。
pub fn verify_password(
  record : AccountRecord,
  username : String,
  password : String,
) -> Bool {
  // 用户名也走常量时间比较,避免用响应耗时枚举用户名
  if !safe_equal(username, record.username) {
    return false
  }
  let salt = match @lib.hex_to_bytes_or(record.salt) {
    Ok(s) => s
    Err(_) => return false
  }
  let derived = derive_password_hash(password, salt)
  safe_equal(@lib.bytes_to_hex(derived), record.hash)
}

// ---- 会话签发/校验的门面 --------------------------------------------------

///|
/// 会话签名密钥的基:有账号用密码哈希(改密码即失效全部旧会话),
/// 无账号用 control.token(cookie 里不是 token 原文)。
pub async fn session_base(
  control_token : String,
  auth_file : String?,
) -> String {
  match auth_file {
    Some(file) =>
      match load_account(file) {
        Some(account) => account.hash
        None => control_token
      }
    None => control_token
  }
}

///|
/// 下发会话 cookie 值(对当前签名基签发)。
pub async fn session_cookie_value(
  payload : SessionPayload,
  control_token : String,
  auth_file : String?,
) -> String {
  let base = session_base(control_token, auth_file)
  sign_session(payload, session_secret(base))
}

///|
/// 组装 `Set-Cookie` 值。属性与 Node/Rust 逐字一致。
pub fn cookie_header(
  name : String,
  value : String,
  max_age_secs : Int64,
) -> String {
  "\{name}=\{value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=\{max_age_secs}"
}

///|
/// 清除 cookie(`Max-Age=0`)。
pub fn clear_cookie_header(name : String) -> String {
  "\{name}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
}
