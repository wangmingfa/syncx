///|
// 身份测试。golden 对拍数据抄自 rust/crates/syncx-net/fixtures/identity.json
// (由 Node 生成,见 rust/scripts/gen-identity-fixture.mjs):Device ID、PEM
// 形态、sha256 前 6 字节必须逐字节一致 —— 同一台机器在三端是同一个身份。

///|
// fixture 用例:(公钥 PEM, deviceId, sha256 前 6 字节 hex)。
// 硬编码而不是读文件:MoonBit 测试无文件 I/O,且 fixture 是只读 golden。
let identity_fixtures : Array[(String, String, String)] = [
  (
    "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAiojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w=\n-----END PUBLIC KEY-----\n",
    "B5JQBQKNFR", "3d4c030534b1",
  ),
  (
    "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAIVL40Zt5HSRFMkLhXy6rbLfP+ntqXtMAl5YOBpiB2xI=\n-----END PUBLIC KEY-----\n",
    "AT6TQ764DV", "13f4e1ff7075",
  ),
  (
    "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAIHoGeJKCHiXXcPH7oMR8Ef9LgT5UFi7Onrg54HYjGrY=\n-----END PUBLIC KEY-----\n",
    "FDUTCG7DRN", "a3a4c46f8e2d",
  ),
]

///|
// Device ID 与公钥 PEM 逐字节对齐 Node fixture(对应 Rust 侧
// `device_id_matches_node`):公钥 PEM 形态差一个字节就换身份。
test "identity: Device ID 与公钥 PEM 逐字节对齐 Node fixture" {
  for case in identity_fixtures {
    let (pem, device_id, prefix_hex) = case
    // sha256 前 6 字节先对拍:这 48 位是 Device ID 的全部熵,直接钉死哈希实现
    let hash = @net.sha256(@utf8.encode(pem))
    assert_eq(@hex.encode(hash.exact_view(start=0, end=6)), prefix_hex)
    // 再对拍 base32 映射与位序(低位字符在最后)
    assert_eq(@net.derive_device_id(pem), device_id)
  }
}

///|
// sha256 官方测试向量(FIPS 180-4):空串、单块、"abc"、56 字节(双块)、
// 200 字节(4 块)。Device ID 只用前 6 字节,但完整摘要对拍才能证明
// 填充与多块路径没写错。
test "identity: sha256 官方向量" {
  let cases : Array[(String, String)] = [
    ("", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
    ("abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"),
    (
      "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq", "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    ),
    (
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "c2a908d98f5df987ade41b5fce213067efbcc21ef2240212a41e54b5e7c28ae5",
    ),
  ]
  for case in cases {
    let (input, expected) = case
    assert_eq(
      @hex.encode(@net.sha256(@utf8.encode(input)).clamped_view()),
      expected,
    )
  }
}

///|
// 公钥 PEM 编码/解析往返:编码结果必须与 fixture 的 PEM 逐字符相等
// (含换行),解析必须还原出同样的 32 字节公钥。
test "identity: 公钥 PEM 编解码往返" {
  for case in identity_fixtures {
    let (pem, _, _) = case
    let raw = @net.parse_public_key_pem(pem)
    assert_eq(raw.length(), 32)
    assert_eq(@net.pem_encode_public_key(raw), pem)
    // 私钥 PEM 只透传文本;公钥 PEM 必须能解析出原始 32 字节
    assert_eq(@net.parse_public_key_pem(@net.pem_encode_public_key(raw)), raw)
  }
}

///|
// 畸形公钥必须拒收:非 PEM 文本、公钥长度不是 32 字节。
test "identity: 畸形公钥拒收" {
  let bad_pem = "not a pem"
  let raised = try {
    let _ = @net.parse_public_key_pem(bad_pem)
    false
  } catch {
    _ => true
  }
  assert_true(raised)
  let raised2 = try {
    let _ = @net.pem_encode_public_key(@utf8.encode("x"))
    false
  } catch {
    _ => true
  }
  assert_true(raised2)
}

///|
// 身份文件(device.key)JSON 形态与 Node 一致:字段名
// deviceId/publicKey/privateKey,未知字段忽略,deviceId 与公钥派生值
// 不一致必须拒收。
test "identity: 身份 JSON 往返与 deviceId 一致性闸门" {
  let (pem, device_id, _) = identity_fixtures[0]
  let private_pem = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB\n-----END PRIVATE KEY-----\n"
  let identity : @net.DeviceIdentity = {
    device_id,
    public_key_pem: pem,
    private_key_pem: private_pem,
  }
  let text = @net.DeviceIdentity::to_json(identity).stringify()
  assert_true(text.contains("\"deviceId\":\"B5JQBQKNFR\""))
  assert_true(text.contains("\"publicKey\""))
  assert_true(text.contains("\"privateKey\""))
  let back = @net.DeviceIdentity::from_json(
    @json.parse(text) catch {
      _ => panic()
    },
  )
  assert_eq(back, identity)
  // 公私钥组装路径:Device ID 由公钥重新派生,不信传入值
  let assembled = @net.DeviceIdentity::from_key_pems(pem, private_pem)
  assert_eq(assembled, identity)
  // deviceId 被改坏的文件必须拒收
  let tampered : @net.DeviceIdentity = {
    device_id: "AAAAAAAAAA",
    public_key_pem: pem,
    private_key_pem: private_pem,
  }
  let raised = try {
    let _ = @net.DeviceIdentity::from_json(
      @net.DeviceIdentity::to_json(tampered),
    )
    false
  } catch {
    _ => true
  }
  assert_true(raised)
  // 缺字段必须拒收
  let raised2 = try {
    let _ = @net.DeviceIdentity::from_json(
      @json.parse("{\"deviceId\":\"X\"}") catch {
        _ => panic()
      },
    )
    false
  } catch {
    _ => true
  }
  assert_true(raised2)
}

///|
// Ed25519 原语(经三方库 mooncry):种子 → 身份是纯函数,
// 公钥/私钥 PEM 与 Node fixture 逐字节对拍;签名/验签闭环且确定性;
// 畸形私钥必须拒收(悄悄接受会让上层拿着错误密钥去签名)。
test "identity: Ed25519 原语与 Node fixture 对拍" {
  // 种子 0x01×32:公钥 PEM、Device ID、私钥 PEM(PKCS#8)三样都必须与
  // Node 生成的 fixture 一致 —— 私钥 PEM 也对拍,防止落盘格式漂移。
  let id = @net.DeviceIdentity::from_secret_bytes(
    Bytes::make(32, (0x01).to_byte()),
  ) catch {
    _ => panic()
  }
  assert_eq(id.device_id, identity_fixtures[0].1)
  assert_eq(id.public_key_pem, identity_fixtures[0].0)
  assert_eq(
    id.private_key_pem,
    "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB\n-----END PRIVATE KEY-----\n",
  )
  // 同一种子恢复两次,身份完全相同(纯函数);另取种子就换一个人
  let id_again = @net.DeviceIdentity::from_secret_bytes(
    Bytes::make(32, (0x01).to_byte()),
  ) catch {
    _ => panic()
  }
  assert_eq(id_again, id)
  let other = @net.DeviceIdentity::from_secret_bytes(
    Bytes::make(32, (0x02).to_byte()),
  ) catch {
    _ => panic()
  }
  assert_true(other.device_id != id.device_id)

  // 签名/验签闭环:确定性(同挑战再签一次逐字节一致)、篡改必失败
  let challenge = @utf8.encode("challenge")
  let sig = @net.sign_challenge(id, challenge) catch { _ => panic() }
  assert_eq(sig.length(), 64)
  let sig_again = @net.sign_challenge(id, challenge) catch { _ => panic() }
  assert_eq(sig_again, sig)
  assert_true(
    @net.verify_challenge(id.public_key_pem, challenge, sig) catch {
      _ => panic()
    },
  )
  let tampered = sig.to_array()
  tampered[0] = (tampered[0].to_int() ^ 1).to_byte()
  assert_true(
    (!@net.verify_challenge(
      id.public_key_pem,
      challenge,
      Bytes::from_array(tampered),
    )) catch {
      _ => panic()
    },
  )

  // 畸形私钥必须显式抛错,而不是悄悄返回错误结果
  let bad : @net.DeviceIdentity = {
    device_id: "B5JQBQKNFR",
    public_key_pem: identity_fixtures[0].0,
    private_key_pem: "pk",
  }
  let raised = try {
    let _ = @net.sign_challenge(bad, challenge)
    false
  } catch {
    _ => true
  }
  assert_true(raised)
  // 签名长度不是 64 字节直接判非法,不进验签原语
  let short_sig_ok = @net.verify_challenge(
    identity_fixtures[0].0,
    challenge,
    Bytes::make(63, (0x00).to_byte()),
  ) catch {
    _ => panic()
  }
  assert_true(!short_sig_ok)

  // 随机生成:可用且不重复
  let a = @net.DeviceIdentity::generate() catch { _ => panic() }
  let b = @net.DeviceIdentity::generate() catch { _ => panic() }
  assert_true(a.device_id != b.device_id)
  let sig_a = @net.sign_challenge(a, challenge) catch { _ => panic() }
  assert_true(
    @net.verify_challenge(a.public_key_pem, challenge, sig_a) catch {
      _ => panic()
    },
  )
  // 公钥验证只认签名者:拿 b 的公钥验 a 的签名必须失败
  assert_true(
    (!@net.verify_challenge(b.public_key_pem, challenge, sig_a)) catch {
      _ => panic()
    },
  )
}
