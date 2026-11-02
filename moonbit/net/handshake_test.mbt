///|
// 握手层测试。Rust 侧 `rust/crates/syncx-net/tests/handshake.rs` 里依赖
// Ed25519/X25519 的部分(签名绑定、会话密钥协商、端到端)在 MoonBit 侧
// 原语接入前无法对拍,这里只移植消息层:kx 形态、能力标签、DER 严格校验。

///|
// kx 编解码往返 + 线上字段名:可缺省字段(listenPort/caps)缺省时整个键
// 不出现 —— 旧对端按 undefined 分支处理,发 null 会让它走进非预期分支。
test "handshake: kx 往返与字段形态" {
  let kx : @net.KxMessage = {
    kind: "kx",
    x25519: "MCowBQYDK2VwAyEAiojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w=",
    sig: "AAECAwQFBgcICQ",
    listen_port: Some(12345),
    caps: Some(["binary1"]),
  }
  let text = @net.encode_kx_message(kx)
  assert_true(text.contains("\"type\":\"kx\""))
  assert_true(text.contains("\"listenPort\":12345"))
  assert_true(text.contains("\"caps\":[\"binary1\"]"))
  assert_eq(@net.decode_kx_message(text), kx)
  // 缺省字段不上线(与旧版对端同形)
  let old : @net.KxMessage = {
    kind: "kx",
    x25519: "MCowBQYDK2VwAyEAiojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w=",
    sig: "AAECAwQFBgcICQ",
    listen_port: None,
    caps: None,
  }
  let old_text = @net.encode_kx_message(old)
  assert_true(!old_text.contains("listenPort"))
  assert_true(!old_text.contains("caps"))
  assert_eq(@net.decode_kx_message(old_text), old)
}

///|
// 畸形 kx 拒收:非法 JSON、缺字段、listenPort 超出 u16 口径。
test "handshake: 畸形 kx 拒收" {
  let raised = try {
    let _ = @net.decode_kx_message("{ not json")
    false
  } catch {
    _ => true
  }
  assert_true(raised)
  let raised2 = try {
    // 缺 x25519/sig
    let _ = @net.decode_kx_message("{\"type\":\"kx\"}")
    false
  } catch {
    _ => true
  }
  assert_true(raised2)
  let raised3 = try {
    // listenPort 超 u16 界:serde 口径是拒收而不是截断
    let _ = @net.decode_kx_message(
      "{\"type\":\"kx\",\"x25519\":\"AA==\",\"sig\":\"AA==\",\"listenPort\":70000}",
    )
    false
  } catch {
    _ => true
  }
  assert_true(raised3)
}

///|
// 能力标签:只有显式宣告 binary1 才算支持二进制信封;缺省/其他标签都不算。
test "handshake: 能力标签判定" {
  assert_true(
    (
      {
        kind: "kx",
        x25519: "AA==",
        sig: "AA==",
        listen_port: None,
        caps: Some(["binary1"]),
      } : @net.KxMessage).supports_binary(),
  )
  assert_true(
    !(
      {
        kind: "kx",
        x25519: "AA==",
        sig: "AA==",
        listen_port: None,
        caps: Some(["other-cap"]),
      } : @net.KxMessage).supports_binary(),
  )
  assert_true(
    !(
      {
        kind: "kx",
        x25519: "AA==",
        sig: "AA==",
        listen_port: None,
        caps: None,
      } : @net.KxMessage).supports_binary(),
  )
  assert_true(@net.peer_caps().contains(@net.CAP_BINARY1))
}

///|
// X25519 SPKI DER 严格校验:44 字节 + 前缀完全匹配,其余一律拒收。
// 这里的字节随后直接参与 DH,宽松解析等于让畸形输入混进密钥协商。
test "handshake: parse_x25519_der 严格校验" {
  let key = Bytes::make(32, (0x41).to_byte())
  let der = @hex.decode("302a300506032b656e032100") + key
  assert_eq(@net.parse_x25519_der(der), key)
  // 长度不符
  let raised = try {
    let _ = @net.parse_x25519_der(key)
    false
  } catch {
    _ => true
  }
  assert_true(raised)
  // 前缀是 Ed25519 的(末字节 0x70)必须拒收 —— 跨曲线公钥混入比畸形更危险
  let wrong_curve = @hex.decode("302a300506032b6570032100") + key
  let raised2 = try {
    let _ = @net.parse_x25519_der(wrong_curve)
    false
  } catch {
    _ => true
  }
  assert_true(raised2)
}

///|
// verify_kx 的消息层校验:非法 base64 → Malformed;签名长度不是 64 字节 →
// BadSignature。签名内容校验依赖 Ed25519,接入前是 TODO 占位(见
// identity.mbt),不在这里测。
test "handshake: verify_kx 消息层校验" {
  let peer_pem = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAiojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w=\n-----END PUBLIC KEY-----\n"
  // x25519 字段不是合法 base64 → Malformed
  let bad_b64 : @net.KxMessage = {
    kind: "kx",
    x25519: "!!!not-base64!!!",
    sig: "AA==",
    listen_port: None,
    caps: None,
  }
  let malformed = try {
    let _ = @net.verify_kx_message(bad_b64, peer_pem)
    false
  } catch {
    @net.Malformed(_) => true
    _ => false
  }
  assert_true(malformed)
  // 签名解出来不是 64 字节 → BadSignature(Rust 侧同口径,发生在验签之前)
  let bad_sig : @net.KxMessage = {
    kind: "kx",
    x25519: "MCowBQYDK2VwAyEAiojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w=",
    sig: "AA==",
    listen_port: None,
    caps: None,
  }
  let bad_signature = try {
    let _ = @net.verify_kx_message(bad_sig, peer_pem)
    false
  } catch {
    @net.BadSignature => true
    _ => false
  }
  assert_true(bad_signature)
  // 对端公钥不是合法 PEM → Malformed
  let bad_peer = try {
    let _ = @net.verify_kx_message(bad_sig, "not a pem")
    false
  } catch {
    @net.Malformed(_) => true
    _ => false
  }
  assert_true(bad_peer)
}
