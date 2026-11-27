///|
// 帧信封测试。重点不是「能加能解」,而是与 Node/Rust 的**格式契约**:
//  - 文本信封是 `{"type":"enc","iv","tag","data"}` 且 base64 用标准字母表;
//  - 二进制信封的 34 字节开销与 iv|tag|version|kind|headerLen 布局;
//  - 坏帧一律丢弃(None / 抛错),绝不半信半疑地放行。
//
// 跨语言那一条在文件末尾:用 Node 生成的固定密钥/iv 密文常量,双向验证
// 「Node 能解 MoonBit 的、MoonBit 能解 Node 的」。常量由
// `moonbit/scripts/gen-envelope-fixture.mjs` 产出,改信封格式必须重跑。

///|
/// 对拍用的固定会话密钥(32 字节)。生产路径永远是握手产物,这里只是为了
/// 让密文可复现。
let fixture_key : Bytes = @hex.decode(
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
) catch {
  _ => panic()
}

///|
/// 对拍用的固定 iv(12 字节)。
let fixture_iv : Bytes = @hex.decode("a0a1a2a3a4a5a6a7a8a9aaab") catch {
  _ => panic()
}

///|
/// 第二个 iv,用来验证「换 iv 必变」。
let other_iv : Bytes = @hex.decode("b0b1b2b3b4b5b6b7b8b9babb") catch {
  _ => panic()
}

///|
fn envelope_is_none(frame : @net.BinaryFrame?) -> Bool {
  match frame {
    None => true
    Some(_) => false
  }
}

///|
/// 取 header 里的字符串字段(测试里用,避免依赖 Json 的 Eq 实现)。
fn header_str(frame : @net.BinaryFrame, key : String) -> String {
  match frame.header.get(key) {
    Some(String(value)) => value
    _ => ""
  }
}

///|
// 文本信封往返:ASCII、中文(UTF-8 多字节)、空串、接近上限的文本。
test "envelope: 文本信封往返" {
  for plaintext in ["", "hello", "中文消息,带标点。", "x".repeat(200000)] {
    let envelope = @net.encrypt_text_envelope(
      fixture_key,
      @utf8.encode(plaintext),
    ) catch {
      _ => panic()
    }
    // 形态:type 必须是 enc,四个字段都在
    assert_true(envelope.contains("\"type\":\"enc\""))
    assert_true(envelope.contains("\"iv\":"))
    assert_true(envelope.contains("\"tag\":"))
    assert_true(envelope.contains("\"data\":"))
    let plain = @net.decrypt_text_envelope(fixture_key, envelope) catch {
      _ => panic()
    }
    assert_true(plain == @utf8.encode(plaintext))
  }
}

///|
// 确定性:同 key + 同 iv + 同明文 → 逐字节相同的信封。
// 这条同时钉住了「不是每个字段都随 iv 变」—— 对拍要靠它。
test "envelope: 同 iv 的封包是确定性的" {
  let a = @net.seal_text_envelope(fixture_key, b"same", fixture_iv) catch {
    _ => panic()
  }
  let b = @net.seal_text_envelope(fixture_key, b"same", fixture_iv) catch {
    _ => panic()
  }
  assert_true(a == b)
  // 换 iv 必变(否则 GCM 的 nonce 复用会泄露明文异或)
  let c = @net.seal_text_envelope(fixture_key, b"same", other_iv) catch {
    _ => panic()
  }
  assert_true(a != c)
}

///|
// 篡改与错密钥都必须被认证标签挡住,不能"解出半截"。
test "envelope: 篡改与错密钥被拒" {
  let envelope = @net.seal_text_envelope(fixture_key, b"payload", fixture_iv) catch {
    _ => panic()
  }
  // 换密钥
  let wrong_key = @hex.decode(
    "ff0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  ) catch {
    _ => panic()
  }
  let wrong_key_rejected = try {
    let _ = @net.decrypt_text_envelope(wrong_key, envelope)
    false
  } catch {
    _ => true
  }
  assert_true(wrong_key_rejected)
  // 把 data 换成另一条密文(标签不动)→ 认证失败
  let other = @net.seal_text_envelope(
    fixture_key,
    b"other payload",
    fixture_iv,
  ) catch {
    _ => panic()
  }
  let parsed = @json.parse(envelope) catch { _ => panic() }
  let obj = match parsed {
    Object(o) => o
    _ => panic()
  }
  let other_parsed = @json.parse(other) catch { _ => panic() }
  let other_obj = match other_parsed {
    Object(o) => o
    _ => panic()
  }
  obj.set("data", other_obj.get("data").unwrap())
  let tampered_rejected = try {
    let _ = @net.decrypt_text_envelope(
      fixture_key,
      Json::object(obj).stringify(),
    )
    false
  } catch {
    _ => true
  }
  assert_true(tampered_rejected)
}

///|
// 形态错误:非 enc、缺字段、iv 长度不对 —— 都必须报 Malformed 而不是
// 解出垃圾(后者会让上层把它当正常消息处理)。
test "envelope: 形态错误被拒" {
  let cases : Array[String] = [
    "{}",
    "[]",
    "{\"type\":\"hello\"}",
    "{\"type\":\"enc\",\"iv\":\"AA==\",\"tag\":\"AA==\",\"data\":\"AA==\"}",
    "not json",
  ]
  for raw in cases {
    let rejected = try {
      let _ = @net.decrypt_text_envelope(fixture_key, raw)
      false
    } catch {
      _ => true
    }
    assert_true(rejected)
  }
}

///|
// 二进制信封往返:三种 kind、空 body、中文 header、256KB 分片。
test "envelope: 二进制帧往返" {
  let header : Map[String, Json] = Map([])
  header.set("folder", Json::string("/tmp/共享 目录"))
  header.set("full", Json::boolean(true))
  header.set("blockIndex", Json::number(7.0))
  let cases : Array[(Int, Bytes)] = [
    (1, b"block-bytes"),
    (2, b""),
    (3, Bytes::make(256 * 1024, b'\x5a')),
  ]
  for pair in cases {
    let kind = pair.0
    let body = pair.1
    let frame = @net.encode_binary_frame(fixture_key, kind, header, body) catch {
      _ => panic()
    }
    // 固定开销 + 至少 6 字节明文前缀
    assert_true(frame.length() >= @net.BINARY_FRAME_OVERHEAD)
    let decoded = match @net.decode_binary_frame(fixture_key, frame) {
      Some(frame) => frame
      None => panic()
    }
    assert_eq(decoded.kind, kind)
    assert_true(decoded.body == body)
    assert_eq(header_str(decoded, "folder"), "/tmp/共享 目录")
  }
}

///|
// 坏帧一律 None:短帧、错密钥、翻转字节。
test "envelope: 坏二进制帧被丢弃" {
  let frame = @net.encode_binary_frame(
    fixture_key,
    1,
    Map([]),
    b"body",
  ) catch {
    _ => panic()
  }
  // 比固定开销还短
  assert_true(envelope_is_none(@net.decode_binary_frame(fixture_key, b"short")))
  // 错密钥
  let wrong_key = @hex.decode(
    "ff0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  ) catch {
    _ => panic()
  }
  assert_true(envelope_is_none(@net.decode_binary_frame(wrong_key, frame)))
  // 翻转一个密文字节
  let tampered = frame.to_array()
  let last = tampered.length() - 1
  tampered[last] = (tampered[last].to_int() ^ 1).to_byte()
  assert_true(
    envelope_is_none(
      @net.decode_binary_frame(fixture_key, Bytes::from_array(tampered)),
    ),
  )
}

///|
// 通过认证但版本/kind 非法的帧也必须被拒:加密只保证"没被改过",
// 不保证"内容合规"。这里用同 key/iv 手工造一帧版本号 9 的密文。
test "envelope: 通过认证但版本/kind 非法的帧被拒" {
  let prefix : FixedArray[Byte] = FixedArray::make(6, b'\x00')
  prefix[0] = 9
  prefix[1] = 1
  prefix[2] = 0
  prefix[3] = 0
  prefix[4] = 0
  prefix[5] = 2
  let plain = prefix.unsafe_reinterpret_as_bytes() + b"{}"
  let box = @lib.aes_gcm_encrypt(plain, fixture_key, fixture_iv, b"")
  let frame = fixture_iv + box.tag + box.ct
  assert_true(envelope_is_none(@net.decode_binary_frame(fixture_key, frame)))
  // kind 越界(4)同样拒
  let prefix2 : FixedArray[Byte] = FixedArray::make(6, b'\x00')
  prefix2[0] = 1
  prefix2[1] = 4
  prefix2[5] = 2
  let plain2 = prefix2.unsafe_reinterpret_as_bytes() + b"{}"
  let box2 = @lib.aes_gcm_encrypt(plain2, fixture_key, fixture_iv, b"")
  let frame2 = fixture_iv + box2.tag + box2.ct
  assert_true(envelope_is_none(@net.decode_binary_frame(fixture_key, frame2)))
}

///|
// 与 Node 逐字节对拍(文本信封)。fixture 由
// `moonbit/scripts/gen-envelope-fixture.mjs` 用固定 key/iv 生成。
//
// 两条断言缺一不可:
//   - 能解开:证明字段名、base64 字母表、iv/tag/data 的位置都对;
//   - 重封回同样字节:证明反向也成立(Node 必然能解 MoonBit 的产物),
//     同时把「键序」「可选字段的有无」这些解不出来的差异也钉住。
test "envelope: 与 Node 对拍(文本信封)" {
  let key = @hex.decode(@net.envelope_fixture_key_hex()) catch { _ => panic() }
  let iv = @hex.decode(@net.envelope_fixture_iv_hex()) catch { _ => panic() }
  let expected = @hex.decode(@net.envelope_fixture_text_plain_hex()) catch {
    _ => panic()
  }
  let plain = @net.decrypt_text_envelope(key, @net.envelope_fixture_text_envelope()) catch {
    _ => panic()
  }
  assert_true(plain == expected)
  let resealed = @net.seal_text_envelope(key, plain, iv) catch { _ => panic() }
  assert_true(resealed == @net.envelope_fixture_text_envelope())
}

///|
// 与 Node 逐字节对拍(二进制帧)。字段顺序由 header 的 JSON 文本决定,
// 这里把 Node 那份头 JSON 原样解析再回填,所以顺序也一路传下来。
test "envelope: 与 Node 对拍(二进制帧)" {
  let key = @hex.decode(@net.envelope_fixture_key_hex()) catch { _ => panic() }
  let iv = @hex.decode(@net.envelope_fixture_iv_hex()) catch { _ => panic() }
  let frame = @hex.decode(@net.envelope_fixture_binary_hex()) catch { _ => panic() }
  let decoded = match @net.decode_binary_frame(key, frame) {
    Some(f) => f
    None => panic()
  }
  assert_eq(decoded.kind, @net.envelope_fixture_binary_kind())
  let body = @hex.decode(@net.envelope_fixture_binary_body_hex()) catch { _ => panic() }
  assert_true(decoded.body == body)
  let parsed = @json.parse(@net.envelope_fixture_binary_header_json()) catch {
    _ => panic()
  }
  let header = match parsed {
    Object(o) => o
    _ => panic()
  }
  let resealed = @net.seal_binary_frame(key, decoded.kind, header, body, iv) catch {
    _ => panic()
  }
  assert_true(resealed == frame)
}
