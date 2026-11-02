///|
// 密码学原语测试(对应 Rust `rust/crates/syncx-net/tests/handshake.rs` 里
// 此前无法移植的部分):RFC 8032 / RFC 7748 官方向量对拍、kx 签名绑定、
// 会话密钥协商、两阶段握手端到端。
//
// 向量一律硬编码:官方向量是只读 golden,对拍不过就是实现错了,没有误报余地。

///|
// RFC 8032 §7.1 Ed25519 官方测试向量:(种子, 公钥, 消息, 签名)。
// TEST 1(空消息)/ TEST 2(1 字节)/ TEST 3(2 字节)/ TEST 1024(1023 字节,
// 覆盖 SHA-512 多块路径)。
test "crypto: RFC 8032 Ed25519 官方向量" {
  // TEST 1
  let seed1 = @hex.decode(
    "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
  ) catch {
    _ => panic()
  }
  let id1 = @net.DeviceIdentity::from_secret_bytes(seed1) catch { _ => panic() }
  assert_eq(
    @hex.encode(
      @net.parse_public_key_pem(id1.public_key_pem) catch {
        _ => panic()
      },
    ),
    "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
  )
  let msg1 = b""
  let sig1 = @net.sign_challenge(id1, msg1) catch { _ => panic() }
  assert_eq(
    @hex.encode(sig1),
    "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
  )
  assert_true(
    @net.verify_challenge(id1.public_key_pem, msg1, sig1) catch {
      _ => panic()
    },
  )

  // TEST 2
  let id2 = @net.DeviceIdentity::from_secret_bytes(
    @hex.decode(
      "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
    ) catch {
      _ => panic()
    },
  ) catch {
    _ => panic()
  }
  let msg2 = b"\x72"
  let sig2 = @net.sign_challenge(id2, msg2) catch { _ => panic() }
  assert_eq(
    @hex.encode(
      @net.parse_public_key_pem(id2.public_key_pem) catch {
        _ => panic()
      },
    ),
    "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
  )
  assert_eq(
    @hex.encode(sig2),
    "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00",
  )
  assert_true(
    @net.verify_challenge(id2.public_key_pem, msg2, sig2) catch {
      _ => panic()
    },
  )

  // TEST 3
  let id3 = @net.DeviceIdentity::from_secret_bytes(
    @hex.decode(
      "c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7",
    ) catch {
      _ => panic()
    },
  ) catch {
    _ => panic()
  }
  let msg3 = b"\xaf\x82"
  let sig3 = @net.sign_challenge(id3, msg3) catch { _ => panic() }
  assert_eq(
    @hex.encode(
      @net.parse_public_key_pem(id3.public_key_pem) catch {
        _ => panic()
      },
    ),
    "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025",
  )
  assert_eq(
    @hex.encode(sig3),
    "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a",
  )
  assert_true(
    @net.verify_challenge(id3.public_key_pem, msg3, sig3) catch {
      _ => panic()
    },
  )

  // TEST 1024:1023 字节消息,长消息路径(签名对拍 + 篡改必失败)
  let id4 = @net.DeviceIdentity::from_secret_bytes(
    @hex.decode(
      "f5e5767cf153319517630f226876b86c8160cc583bc013744c6bf255f5cc0ee5",
    ) catch {
      _ => panic()
    },
  ) catch {
    _ => panic()
  }
  let msg4 = @hex.decode(
    "08b8b2b733424243760fe426a4b54908632110a66c2f6591eabd3345e3e4eb98fa6e264bf09efe12ee50f8f54e9f77b1e355f6c50544e23fb1433ddf73be84d879de7c0046dc4996d9e773f4bc9efe5738829adb26c81b37c93a1b270b20329d658675fc6ea534e0810a4432826bf58c941efb65d57a338bbd2e26640f89ffbc1a858efcb8550ee3a5e1998bd177e93a7363c344fe6b199ee5d02e82d522c4feba15452f80288a821a579116ec6dad2b3b310da903401aa62100ab5d1a36553e06203b33890cc9b832f79ef80560ccb9a39ce767967ed628c6ad573cb116dbefefd75499da96bd68a8a97b928a8bbc103b6621fcde2beca1231d206be6cd9ec7aff6f6c94fcd7204ed3455c68c83f4a41da4af2b74ef5c53f1d8ac70bdcb7ed185ce81bd84359d44254d95629e9855a94a7c1958d1f8ada5d0532ed8a5aa3fb2d17ba70eb6248e594e1a2297acbbb39d502f1a8c6eb6f1ce22b3de1a1f40cc24554119a831a9aad6079cad88425de6bde1a9187ebb6092cf67bf2b13fd65f27088d78b7e883c8759d2c4f5c65adb7553878ad575f9fad878e80a0c9ba63bcbcc2732e69485bbc9c90bfbd62481d9089beccf80cfe2df16a2cf65bd92dd597b0707e0917af48bbb75fed413d238f5555a7a569d80c3414a8d0859dc65a46128bab27af87a71314f318c782b23ebfe808b82b0ce26401d2e22f04d83d1255dc51addd3b75a2b1ae0784504df543af8969be3ea7082ff7fc9888c144da2af58429ec96031dbcad3dad9af0dcbaaaf268cb8fcffead94f3c7ca495e056a9b47acdb751fb73e666c6c655ade8297297d07ad1ba5e43f1bca32301651339e22904cc8c42f58c30c04aafdb038dda0847dd988dcda6f3bfd15c4b4c4525004aa06eeff8ca61783aacec57fb3d1f92b0fe2fd1a85f6724517b65e614ad6808d6f6ee34dff7310fdc82aebfd904b01e1dc54b2927094b2db68d6f903b68401adebf5a7e08d78ff4ef5d63653a65040cf9bfd4aca7984a74d37145986780fc0b16ac451649de6188a7dbdf191f64b5fc5e2ab47b57f7f7276cd419c17a3ca8e1b939ae49e488acba6b965610b5480109c8b17b80e1b7b750dfc7598d5d5011fd2dcc5600a32ef5b52a1ecc820e308aa342721aac0943bf6686b64b2579376504ccc493d97e6aed3fb0f9cd71a43dd497f01f17c0e2cb3797aa2a2f256656168e6c496afc5fb93246f6b1116398a346f1a641f3b041e989f7914f90cc2c7fff357876e506b50d334ba77c225bc307ba537152f3f1610e4eafe595f6d9d90d11faa933a15ef1369546868a7f3a45a96768d40fd9d03412c091c6315cf4fde7cb68606937380db2eaaa707b4c4185c32eddcdd306705e4dc1ffc872eeee475a64dfac86aba41c0618983f8741c5ef68d3a101e8a3b8cac60c905c15fc910840b94c00a0b9d0",
  ) catch {
    _ => panic()
  }
  assert_eq(msg4.length(), 1023)
  let sig4 = @net.sign_challenge(id4, msg4) catch { _ => panic() }
  assert_eq(
    @hex.encode(sig4),
    "0aab4c900501b3e24d7cdf4663326a3a87df5e4843b2cbdb67cbf6e460fec350aa5371b1508f9f4528ecea23c436d94b5e8fcd4f681e30a6ac00a9704a188a03",
  )
  assert_true(
    @net.verify_challenge(id4.public_key_pem, msg4, sig4) catch {
      _ => panic()
    },
  )
  // 任意篡改消息(末字节翻转)验签必须失败
  let tampered_msg = msg4.to_array()
  let last = tampered_msg.length() - 1
  tampered_msg[last] = (tampered_msg[last].to_int() ^ 1).to_byte()
  assert_true(
    (!@net.verify_challenge(
      id4.public_key_pem,
      Bytes::from_array(tampered_msg),
      sig4,
    )) catch {
      _ => panic()
    },
  )
}

///|
// RFC 7748 §5.2 / §6.1 X25519 官方向量:裸 scalarmult 对拍,再覆盖迭代
// 测试(1 次与 1000 次,捕捉「单次对、链上错」的实现缺陷)。
test "crypto: RFC 7748 X25519 官方向量" {
  let scalar = fn(hex : String) -> Bytes {
    @hex.decode(hex) catch {
      _ => panic()
    }
  }
  // §5.2 两组
  assert_eq(
    @hex.encode(
      @net.x25519_scalarmult(
        scalar(
          "a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4",
        ),
        scalar(
          "e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c",
        ),
      ) catch {
        _ => panic()
      },
    ),
    "c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552",
  )
  assert_eq(
    @hex.encode(
      @net.x25519_scalarmult(
        scalar(
          "4b66e9d4d1b4673c5ad22691957d6af5c11b6421e0ea01d42ca4169e7918ba0d",
        ),
        scalar(
          "e5210f12786811d3f4b7959d0538ae2c31dbe7106fc03c3efc4cd549c715a493",
        ),
      ) catch {
        _ => panic()
      },
    ),
    "95cbde9476e8907d7aade45cb4b873f88b595a68799fa152e6f8f7647aac7957",
  )
  // §6.1 DH:私钥 × 基点 = 公钥,再互乘出共享密钥
  let alice_sk = scalar(
    "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a",
  )
  let bob_sk = scalar(
    "5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb",
  )
  let base = scalar(
    "0900000000000000000000000000000000000000000000000000000000000000",
  )
  let alice_pk = @net.x25519_scalarmult(alice_sk, base) catch { _ => panic() }
  let bob_pk = @net.x25519_scalarmult(bob_sk, base) catch { _ => panic() }
  assert_eq(
    @hex.encode(alice_pk),
    "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a",
  )
  assert_eq(
    @hex.encode(bob_pk),
    "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f",
  )
  let shared_ab = @net.x25519_scalarmult(alice_sk, bob_pk) catch {
    _ => panic()
  }
  let shared_ba = @net.x25519_scalarmult(bob_sk, alice_pk) catch {
    _ => panic()
  }
  assert_eq(
    @hex.encode(shared_ab),
    "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742",
  )
  assert_eq(shared_ab, shared_ba)
  // 迭代测试:初始 k = u = 9…0,每轮 k' = X25519(k, u),u' = 旧 k
  let mut k = base
  let mut u = base
  for i in 0..<1000 {
    let next = @net.x25519_scalarmult(k, u) catch { _ => panic() }
    u = k
    k = next
    if i == 0 {
      assert_eq(
        @hex.encode(k),
        "422c8e7a6227d7bca1350b3e2bb7279f7897b87bb6854b783c60e80311ae3079",
      )
    }
  }
  assert_eq(
    @hex.encode(k),
    "684cf59ba83309552800ef566f2f4d3c1c3887c49360e3875f2eb94d99532c51",
  )
  // 私钥长度错 → 显式抛错而不是悄悄算错
  let raised = try {
    let _ = @net.x25519_scalarmult(b"\x01", u)
    false
  } catch {
    _ => true
  }
  assert_true(raised)
}

///|
// 签名 → 验签 → 篡改必失败(移植 Rust `kx_signature_binds_x25519_key`)。
// 中间人换掉 X25519 公钥时验签必须红 —— 签名只盖 DER,身份就绑在 DER 上。
test "handshake: kx 签名绑定 X25519 公钥" {
  let alice = @net.DeviceIdentity::from_secret_bytes(
    Bytes::make(32, (0x07).to_byte()),
  ) catch {
    _ => panic()
  }
  let pair = @net.X25519KeyPair::generate() catch { _ => panic() }
  let kx = @net.build_kx_message(pair, alice, Some(12345), @net.peer_caps()) catch {
    _ => panic()
  }
  assert_eq(kx.kind, "kx")
  assert_eq(kx.listen_port, Some(12345))
  assert_true(kx.supports_binary())
  // 验签通过,且协商出来的公钥就是发送方那一把
  let peer_key = @net.verify_kx_message(kx, alice.public_key_pem) catch {
    _ => panic()
  }
  assert_eq(peer_key, pair.public_der.exact_view(start=12, end=44).to_owned())
  // 篡改 x25519 字段(等长,仅改一位)→ 验签必须失败
  let der = @base64.decode(kx.x25519) catch { _ => panic() }
  let tampered = der.to_array()
  tampered[12] = (tampered[12].to_int() ^ 1).to_byte()
  let forged : @net.KxMessage = {
    ..kx,
    x25519: @base64.encode(Bytes::from_array(tampered)),
  }
  let raised = try {
    let _ = @net.verify_kx_message(forged, alice.public_key_pem)
    false
  } catch {
    _ => true
  }
  assert_true(raised)
  // 拿别人的公钥去验 → 同样必须失败
  let bob = @net.DeviceIdentity::from_secret_bytes(
    Bytes::make(32, (0x08).to_byte()),
  ) catch {
    _ => panic()
  }
  let raised2 = try {
    let _ = @net.verify_kx_message(kx, bob.public_key_pem)
    false
  } catch {
    _ => true
  }
  assert_true(raised2)
}

///|
// 两端各自算出的会话密钥必须相同(移植 Rust `session_keys_agree`,
// ECDH 的基本要求)。
test "handshake: 会话密钥协商一致" {
  let a = @net.X25519KeyPair::generate() catch { _ => panic() }
  let b = @net.X25519KeyPair::generate() catch { _ => panic() }
  assert_eq(a.secret.length(), 32)
  assert_eq(a.public_der.length(), 44)
  assert_true(
    a.public_der.has_prefix(
      @hex.decode("302a300506032b656e032100") catch {
        _ => panic()
      },
    ),
  )
  // 一次性密钥对不重复
  assert_true(a.secret != b.secret)
  let a_pub = a.public_der.exact_view(start=12, end=44).to_owned()
  let b_pub = b.public_der.exact_view(start=12, end=44).to_owned()
  let key_a = @net.derive_session_key(a, b_pub) catch { _ => panic() }
  let key_b = @net.derive_session_key(b, a_pub) catch { _ => panic() }
  assert_eq(key_a, key_b)
  assert_eq(key_a.length(), 32)
  // 会话密钥 = sha256(共享密钥),不是裸 DH 输出
  assert_eq(
    key_a,
    @net.sha256(@net.x25519_scalarmult(a.secret, b_pub) catch { _ => panic() }),
  )
}

///|
// 两阶段握手端到端(进程内,协议层):对应 Rust `peer_handshake_end_to_end`。
// MoonBit 侧 socket 传输(mocket)是另一里程碑,这里只做协议闭环:双方
// 各自生成身份与一次性密钥、互发 kx(经线上 JSON 编码)、验签、派生会话
// 密钥 —— 能对上就证明协议自洽,加传输层不改变这些字节。
test "handshake: 两阶段握手端到端" {
  // 服务端/客户端各一份持久身份(种子与 Rust 端到端测试一致)
  let server = @net.DeviceIdentity::from_secret_bytes(
    Bytes::make(32, (0x0B).to_byte()),
  ) catch {
    _ => panic()
  }
  let client = @net.DeviceIdentity::from_secret_bytes(
    Bytes::make(32, (0x16).to_byte()),
  ) catch {
    _ => panic()
  }
  // 第一阶段:明文交换公钥 PEM 后,各自生成一次性 X25519 密钥并签 kx
  let server_pair = @net.X25519KeyPair::generate() catch { _ => panic() }
  let client_pair = @net.X25519KeyPair::generate() catch { _ => panic() }
  let server_kx = @net.build_kx_message(
    server_pair,
    server,
    None,
    @net.peer_caps(),
  ) catch {
    _ => panic()
  }
  let client_kx = @net.build_kx_message(
    client_pair,
    client,
    Some(1234),
    @net.peer_caps(),
  ) catch {
    _ => panic()
  }
  // 第二阶段:线上 JSON 往返,按「收到对端公钥 PEM」验签
  let wire_server = @net.encode_kx_message(server_kx)
  let wire_client = @net.encode_kx_message(client_kx)
  let got_server_kx = @net.decode_kx_message(wire_server) catch { _ => panic() }
  let got_client_kx = @net.decode_kx_message(wire_client) catch { _ => panic() }
  assert_true(got_server_kx.supports_binary())
  assert_eq(got_client_kx.listen_port, Some(1234))
  let server_peer_key = @net.verify_kx_message(
    got_client_kx,
    client.public_key_pem,
  ) catch {
    _ => panic()
  }
  let client_peer_key = @net.verify_kx_message(
    got_server_kx,
    server.public_key_pem,
  ) catch {
    _ => panic()
  }
  // 会话密钥两侧一致
  let server_session = @net.derive_session_key(server_pair, server_peer_key) catch {
    _ => panic()
  }
  let client_session = @net.derive_session_key(client_pair, client_peer_key) catch {
    _ => panic()
  }
  assert_eq(server_session, client_session)
  // 验签时用错对端(身份对调)必须失败 —— kx 绑定的是签名者身份
  let raised = try {
    let _ = @net.verify_kx_message(got_server_kx, client.public_key_pem)
    false
  } catch {
    _ => true
  }
  assert_true(raised)
}
