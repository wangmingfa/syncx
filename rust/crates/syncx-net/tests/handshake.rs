//! 握手与身份的对拍 + 端到端互通。
//!
//! 分两类断言,别混为一谈:
//!   - **fixture 对拍**:Device ID / PEM 形态必须与 Node 逐字节一致(否则同一台
//!     机器在两端是两个身份);
//!   - **Rust↔Rust 端到端**:两阶段握手 + 会话密钥 + 加密消息往返,证明协议自洽。

use std::sync::Arc;

use syncx_net::handshake::{
    build_kx_message, derive_session_key, verify_kx_message, X25519KeyPair, PEER_CAPS,
};
use syncx_net::identity::DeviceIdentity;
use syncx_net::server::{start_peer_server, PeerConnection};
use syncx_net::wire::{encrypt_message, WireMessage};

fn fixture() -> serde_json::Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/identity.json");
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| {
        panic!("读不到 fixture: {e};先跑 `node_modules/.bin/tsx rust/scripts/gen-identity-fixture.mjs`")
    });
    serde_json::from_str(&text).expect("fixture 应是合法 JSON")
}

#[test]
fn device_id_matches_node() {
    let data = fixture();
    let cases = data["cases"].as_array().expect("cases 应是数组");
    assert!(!cases.is_empty());

    for case in cases {
        let private_key_pem = case["privateKeyPem"].as_str().expect("privateKeyPem");
        let expected_id = case["deviceId"].as_str().expect("deviceId");
        let expected_public = case["publicKeyPem"].as_str().expect("publicKeyPem");

        let identity =
            DeviceIdentity::from_private_key_pem(private_key_pem).expect("种子私钥应能解析");

        assert_eq!(
            identity.public_key_pem, expected_public,
            "公钥 PEM 不一致 —— Device ID 是对这段文本做哈希的,形态差一个字节就换身份"
        );
        assert_eq!(
            identity.device_id,
            expected_id,
            "种子 {} 的 Device ID 不一致",
            case["seed"].as_str().unwrap_or("?")
        );
    }
}

/// 签名 → 验签 → 篡改必失败。中间人换掉 X25519 公钥时验签必须红。
#[test]
fn kx_signature_binds_x25519_key() {
    let alice = DeviceIdentity::from_secret_bytes(&[7u8; 32]);
    let pair = X25519KeyPair::generate();
    let kx = build_kx_message(&pair, &alice, Some(12345), PEER_CAPS).expect("签名应成功");

    assert_eq!(kx.listen_port, Some(12345));
    assert!(kx.supports_binary());

    let peer_key = verify_kx_message(&kx, &alice.public_key_pem).expect("验签应通过");
    // 协商出来的公钥必须就是发送方那一把
    assert_eq!(&pair.public_der[12..], &peer_key[..]);

    // 换掉 x25519 字段(等长,仅改一位)→ 验签必须失败
    let mut forged = kx.clone();
    let mut der_bytes =
        base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &kx.x25519).unwrap();
    der_bytes[12] ^= 0x01;
    forged.x25519 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &der_bytes);
    assert!(
        verify_kx_message(&forged, &alice.public_key_pem).is_err(),
        "篡改 X25519 公钥后验签必须失败 —— 否则握手不绑定身份"
    );
}

/// 两端各自算出的会话密钥必须相同(ECDH 的基本要求)。
#[test]
fn session_keys_agree() {
    let a = X25519KeyPair::generate();
    let b = X25519KeyPair::generate();
    let a_pub: [u8; 32] = a.public_der[12..].try_into().unwrap();
    let b_pub: [u8; 32] = b.public_der[12..].try_into().unwrap();

    assert_eq!(
        derive_session_key(&a, &b_pub),
        derive_session_key(&b, &a_pub)
    );
}

/// 端到端:真起一个对端服务端,连接、完成握手、双向加密收发。
#[tokio::test]
async fn peer_handshake_end_to_end() {
    let server_identity = Arc::new(DeviceIdentity::from_secret_bytes(&[11u8; 32]));
    let client_identity = DeviceIdentity::from_secret_bytes(&[22u8; 32]);
    let expected_client_id = client_identity.device_id.clone();
    let expected_server_id = server_identity.device_id.clone();

    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    let tx = Arc::new(tokio::sync::Mutex::new(Some(tx)));

    let handler_identity = Arc::clone(&server_identity);
    let handler = Arc::new(
        move |mut connection: PeerConnection| -> futures_util::future::BoxFuture<'static, ()> {
            let tx = Arc::clone(&tx);
            let _server_id = handler_identity.device_id.clone();
            Box::pin(async move {
                if let Some(sender) = tx.lock().await.take() {
                    let _ = sender.send(connection.device_id.clone());
                }
                // 回一条 hello,证明会话密钥两侧一致
                let hello = WireMessage::Control {
                    payload: syncx_net::wire::ControlMessage::Hello {
                        from_device_id: "server".to_string(),
                        version: "0.0.0-test".to_string(),
                        hostname: None,
                        platform: None,
                        runtime: None,
                    },
                };
                let _ = connection.send_message(&hello).await;
                // 等客户端断开
                while connection.recv().await.is_some() {}
            })
        },
    );

    let server = start_peer_server(
        Arc::clone(&server_identity),
        "127.0.0.1:0".parse().unwrap(),
        handler,
    )
    .await
    .expect("服务端应能绑定端口");

    let url = format!("ws://127.0.0.1:{}", server.port);
    let connected = syncx_net::connect_peer(&client_identity, &url, Some(1234))
        .await
        .expect("握手应成功");

    assert_eq!(
        connected.connection.device_id, expected_server_id,
        "客户端看到的对端 Device ID 不对"
    );
    assert!(
        connected.connection.supports_binary(),
        "两端都宣告 binary1,应协商成功"
    );
    assert_eq!(
        connected.connection.listen_port,
        Some(server.port),
        "服务端在 kx 里广播的监听端口应被客户端读到"
    );

    // 服务端看到的客户端 ID
    let seen_by_server = tokio::time::timeout(std::time::Duration::from_secs(5), rx)
        .await
        .expect("服务端应在超时前拿到连接")
        .expect("channel 不应被丢弃");
    assert_eq!(seen_by_server, expected_client_id);

    // 收服务端发的 hello —— 能解开就说明两侧会话密钥一致
    let mut connection = connected.connection;
    let frame = tokio::time::timeout(std::time::Duration::from_secs(5), connection.recv())
        .await
        .expect("应在超时前收到帧")
        .expect("连接不应提前关闭");
    let syncx_net::server::Frame::Text(text) = frame else {
        panic!("hello 应走文本信封");
    };
    let message = syncx_net::wire::decrypt_message(&connection.session_key, &text)
        .expect("应能用会话密钥解开");
    match message {
        WireMessage::Control {
            payload: syncx_net::wire::ControlMessage::Hello { version, .. },
        } => assert_eq!(version, "0.0.0-test"),
        other => panic!("期望 hello,实际 {other:?}"),
    }

    // 反向发一条:服务端那边 recv 循环会读到(读不到也会在连接关闭时退出)
    let ping = WireMessage::IndexRequest {
        folder: "/tmp/x".to_string(),
    };
    connection.send_message(&ping).await.expect("发送应成功");
    connection.close().await;
    server.close().await;
}

/// 文本信封的线上字段名不能变形:`full` 缺省 = 增量,`entryVersion` 拼写固定。
#[test]
fn wire_json_shape_is_stable() {
    let incremental = WireMessage::Index {
        folder: "/x".to_string(),
        payload: "[]".to_string(),
        full: None,
        relayed: None,
    };
    let json = serde_json::to_string(&incremental).unwrap();
    assert!(
        !json.contains("\"full\""),
        "full 缺省时不能出现在线上 —— 发 null 会让旧对端走进非预期分支:{json}"
    );

    let full = WireMessage::Index {
        folder: "/x".to_string(),
        payload: "[]".to_string(),
        full: Some(true),
        relayed: None,
    };
    assert_eq!(
        serde_json::to_string(&full).unwrap(),
        r#"{"type":"index","folder":"/x","payload":"[]","full":true}"#
    );
    assert!(full.is_full_index());
    assert!(
        !incremental.is_full_index(),
        "缺省必须按增量解释 —— 当成全量会导致两端无限互推"
    );

    // entryVersion 拼写
    let write = WireMessage::Control {
        payload: syncx_net::wire::ControlMessage::FileContentWrite {
            request_id: "r".to_string(),
            from_device_id: "d".to_string(),
            folder_id: "f".to_string(),
            path: "/a".to_string(),
            data: "AA==".to_string(),
            entry_version: vec![("dev".to_string(), 3)],
            version: None,
            hostname: None,
            platform: None,
            runtime: None,
        },
    };
    let json = serde_json::to_string(&write).unwrap();
    assert!(
        json.contains("\"entryVersion\""),
        "字段名必须是 entryVersion:{json}"
    );
    assert!(
        json.contains(r#"[["dev",3]]"#),
        "版本向量线上是数组对,不是对象:{json}"
    );

    // 加密往返
    let key = [9u8; 32];
    let encrypted = encrypt_message(&key, &write).unwrap();
    assert!(encrypted.contains("\"type\":\"enc\""));
    assert_eq!(
        syncx_net::wire::decrypt_message(&key, &encrypted).unwrap(),
        write
    );
    assert!(
        syncx_net::wire::decrypt_message(&[8u8; 32], &encrypted).is_err(),
        "密钥不符必须解密失败"
    );
}

/// 索引编解码:mtime 在线,内核条目里没有;CDC 视图等长才保留。
#[test]
fn index_roundtrip_preserves_cdc_view() {
    use syncx_core::plan::IndexEntry;
    use syncx_net::wire::{decode_index, encode_index, WireEntry};

    let mut version = std::collections::BTreeMap::new();
    version.insert("devA".to_string(), 2u64);

    let with_cdc = IndexEntry {
        path: "/a".to_string(),
        version: version.clone(),
        size: 10,
        deleted: false,
        blocks: vec!["b1".to_string()],
        cdh: Some(vec!["h1".to_string()]),
        clens: Some(vec![10]),
    };
    let mismatched = IndexEntry {
        path: "/b".to_string(),
        version,
        size: 1,
        deleted: false,
        blocks: vec![],
        cdh: Some(vec!["h1".to_string(), "h2".to_string()]),
        clens: Some(vec![1]),
    };

    let wire = vec![
        WireEntry::from_entry(&with_cdc, 1700000000),
        WireEntry::from_entry(&mismatched, 1700000001),
    ];
    let body = encode_index(&wire);
    let decoded = decode_index(&body).expect("应能解码");

    assert_eq!(decoded[0].mtime, 1_700_000_000.0);
    let back = decoded[0].to_entry();
    assert_eq!(back, with_cdc, "CDC 视图等长应保留");

    let back = decoded[1].to_entry();
    assert_eq!(back.cdh, None, "cdh/clens 不等长必须退化掉");
    assert_eq!(back.clens, None);
}
