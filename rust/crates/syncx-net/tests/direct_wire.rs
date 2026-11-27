//! 直发(ADR-0028)的线上格式契约。
//!
//! 这些断言钉的是**字节级的跨语言约定**:Node 侧 `src/net/wire.ts` 里的 union 与
//! 这里的手写 enum 必须逐字段对齐。名字拼错不会有编译错误,只会让对端把消息当成
//! 未知 kind 静默丢掉(症状是「发出去了,但对方永远不确认」),所以逐条钉死。

use syncx_net::wire::{
    decode_binary_frame, encode_binary_frame, encrypt_message, BinaryFrameKind, ControlMessage,
    WireMessage, DIRECT_CHUNK_BYTES,
};

fn control(payload: ControlMessage) -> WireMessage {
    WireMessage::Control { payload }
}

fn json_of(payload: ControlMessage) -> String {
    serde_json::to_string(&control(payload)).unwrap()
}

#[test]
fn text_message_shape_matches_node() {
    let json = json_of(ControlMessage::DirectText {
        id: "dt-1".to_string(),
        from_device_id: String::new(),
        text: "你好".to_string(),
        created_at: 1_700_000_000_000,
        version: None,
        hostname: None,
        platform: None,
        runtime: None,
    });
    // `kind` 由 rename_all = kebab-case 生成,不能手写成 directText
    assert_eq!(
        json,
        r#"{"type":"control","payload":{"kind":"direct-text","id":"dt-1","fromDeviceId":"","text":"你好","createdAt":1700000000000}}"#
    );

    // 反向:Node 发来的一模一样(且不带可选字段)必须能解出来
    let raw = r#"{"type":"control","payload":{"kind":"direct-text","id":"dt-2","fromDeviceId":"","text":"hi","createdAt":5}}"#;
    let message: WireMessage = serde_json::from_str(raw).unwrap();
    match message {
        WireMessage::Control {
            payload: ControlMessage::DirectText { id, text, .. },
        } => {
            assert_eq!(id, "dt-2");
            assert_eq!(text, "hi");
        }
        other => panic!("解成了 {other:?}"),
    }
}

#[test]
fn file_offer_shape_matches_node() {
    let sha = "a".repeat(64);
    let json = json_of(ControlMessage::DirectFileOffer {
        id: "df-1".to_string(),
        from_device_id: String::new(),
        name: "报告.pdf".to_string(),
        size: 4096,
        sha256: sha.clone(),
        created_at: 7,
        batch_id: Some("db-1".to_string()),
        version: None,
        hostname: None,
        platform: None,
        runtime: None,
    });
    assert_eq!(
        json,
        format!(
            r#"{{"type":"control","payload":{{"kind":"direct-file-offer","id":"df-1","fromDeviceId":"","name":"报告.pdf","size":4096,"sha256":"{sha}","createdAt":7,"batchId":"db-1"}}}}"#
        )
    );

    // 没有 batchId 时不能出现空串或 null:旧对端按「缺失」判断是否成组
    let single = json_of(ControlMessage::DirectFileOffer {
        id: "df-2".to_string(),
        from_device_id: String::new(),
        name: "a".to_string(),
        size: 1,
        sha256: sha,
        created_at: 1,
        batch_id: None,
        version: None,
        hostname: None,
        platform: None,
        runtime: None,
    });
    assert!(!single.contains("batchId"), "{single}");
}

#[test]
fn reply_omits_offset_unless_resuming() {
    let fresh = json_of(ControlMessage::DirectReply {
        id: "df-1".to_string(),
        from_device_id: String::new(),
        accept: true,
        reason: None,
        offset: None,
        version: None,
        hostname: None,
        platform: None,
        runtime: None,
    });
    assert!(!fresh.contains("offset"), "新投送不能出现 offset:{fresh}");
    assert!(fresh.contains(r#""accept":true"#));

    let resume = json_of(ControlMessage::DirectReply {
        id: "df-1".to_string(),
        from_device_id: String::new(),
        accept: true,
        reason: None,
        offset: Some(DIRECT_CHUNK_BYTES as u64),
        version: None,
        hostname: None,
        platform: None,
        runtime: None,
    });
    assert!(
        resume.contains(r#""offset":262144"#),
        "offset 是字节数,不是片号:{resume}"
    );
}

#[test]
fn ack_cancel_result_shapes() {
    let ack = json_of(ControlMessage::DirectAck {
        id: "df-1".to_string(),
        from_device_id: String::new(),
        seq: 3,
        version: None,
        hostname: None,
        platform: None,
        runtime: None,
    });
    assert_eq!(
        ack,
        r#"{"type":"control","payload":{"kind":"direct-ack","id":"df-1","fromDeviceId":"","seq":3}}"#
    );

    let cancel = json_of(ControlMessage::DirectCancel {
        id: "df-1".to_string(),
        from_device_id: String::new(),
        reason: "会话已断开".to_string(),
        version: None,
        hostname: None,
        platform: None,
        runtime: None,
    });
    assert_eq!(
        cancel,
        r#"{"type":"control","payload":{"kind":"direct-cancel","id":"df-1","fromDeviceId":"","reason":"会话已断开"}}"#
    );

    let result = json_of(ControlMessage::DirectResult {
        id: "dt-1".to_string(),
        from_device_id: String::new(),
        ok: false,
        error: Some("校验失败".to_string()),
        version: None,
        hostname: None,
        platform: None,
        runtime: None,
    });
    assert_eq!(
        result,
        r#"{"type":"control","payload":{"kind":"direct-result","id":"dt-1","fromDeviceId":"","ok":false,"error":"校验失败"}}"#
    );
}

#[test]
fn unknown_kind_is_ignored_not_fatal() {
    // Node 控制面「不认识的 kind 直接跳过」。这里必须等价:整帧解不出来会让
    // decrypt_message 丢弃整条消息,连日志都只是一行 debug,排查时无从下手。
    let raw = r#"{"type":"control","payload":{"kind":"future-thing","id":"x","whatever":1}}"#;
    let message: WireMessage = serde_json::from_str(raw).expect("未知 kind 不该让整帧失败");
    assert_eq!(
        message,
        WireMessage::Control {
            payload: ControlMessage::Unknown
        }
    );

    // 已知 kind 但字段坏了仍然要报错:那是真的格式不匹配,静默吞掉会掩盖 bug
    let broken = r#"{"type":"control","payload":{"kind":"direct-text","id":"x"}}"#;
    assert!(serde_json::from_str::<WireMessage>(broken).is_err());
}

#[test]
fn direct_chunk_frame_roundtrips() {
    let key = [3u8; 32];
    let header = serde_json::json!({ "id": "df-1", "seq": 7 });
    let body = vec![0xABu8; 1000];
    let frame =
        encode_binary_frame(&key, BinaryFrameKind::DirectFileChunk, &header, &body).unwrap();

    let decoded = decode_binary_frame(&key, &frame).expect("应能解回");
    assert_eq!(decoded.kind, BinaryFrameKind::DirectFileChunk);
    assert_eq!(decoded.header["id"], serde_json::json!("df-1"));
    assert_eq!(decoded.header["seq"], serde_json::json!(7));
    assert!(decoded.body == body);

    // 帧里没有 folder:直发不属于任何共享目录,读循环必须先按 kind 认它,
    // 否则会掉进「目录不存在」的静默丢弃。
    assert!(decoded.header.get("folder").is_none());
    assert_eq!(BinaryFrameKind::DirectFileChunk as u8, 3);
}

/// Node 现场生成的线上字节(`rust/scripts/gen-direct-wire-fixture.mjs`)。
///
/// 上面那些断言里的 JSON 是手写的,能证明「字段名对」,但证明不了**键序**与
/// **可选字段的有无**是否与 Node 一致 —— 那两件事只有让对方的 `JSON.stringify`
/// 说了算才作数。这份 fixture 就是 Node 真正写上线的那串字节。
fn fixture() -> serde_json::Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/direct-wire.json");
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| {
        panic!(
            "读不到 fixture: {e};先跑 \
             `node_modules/.bin/tsx rust/scripts/gen-direct-wire-fixture.mjs`"
        )
    });
    serde_json::from_str(&text).expect("fixture 应是合法 JSON")
}

fn kind_of(payload: &ControlMessage) -> &'static str {
    match payload {
        ControlMessage::DirectText { .. } => "direct-text",
        ControlMessage::DirectFileOffer { .. } => "direct-file-offer",
        ControlMessage::DirectReply { .. } => "direct-reply",
        ControlMessage::DirectAck { .. } => "direct-ack",
        ControlMessage::DirectCancel { .. } => "direct-cancel",
        ControlMessage::DirectResult { .. } => "direct-result",
        _ => "other",
    }
}

/// 双向:Node 的字节 Rust 必须能解;解出来的再编码必须**逐字节**还原。
///
/// 还原不了一律说明有真问题 —— 键序不同(serde 按声明顺序、JSON.stringify 按插入
/// 顺序)、可选字段被写成 null、某个键少了 `rename`。这些都不会报错,只会让对端
/// 静默忽略,所以只断言「能解出来」是不够的。
#[test]
fn node_fixture_roundtrips_byte_identically() {
    let data = fixture();
    let cases = data["controls"].as_array().expect("controls 应是数组");
    assert!(cases.len() >= 6, "六条控制消息都要有样本");

    let mut seen: Vec<&'static str> = Vec::new();
    for case in cases {
        let name = case["name"].as_str().unwrap_or("?");
        let wire = case["wire"].as_str().expect("wire 应是字符串");
        let message: WireMessage = serde_json::from_str(wire)
            .unwrap_or_else(|e| panic!("{name}: Rust 解不开 Node 发的字节: {e}"));
        let back = serde_json::to_string(&message).expect("重新编码不应失败");
        assert_eq!(
            back, wire,
            "{name}: 重新编码与 Node 的字节不一致(键序 / 大小写 / 可选字段的有无)"
        );
        if let WireMessage::Control { payload } = &message {
            seen.push(kind_of(payload));
        }
    }
    for kind in [
        "direct-text",
        "direct-file-offer",
        "direct-reply",
        "direct-ack",
        "direct-cancel",
        "direct-result",
    ] {
        assert!(seen.contains(&kind), "fixture 里缺 {kind} 的样本");
    }
}

/// 同一份分片帧,两侧解出来必须是同一个 kind / 头 / 体。
///
/// 帧体带随机 iv,不可复现 —— 它是一次快照,由 Node 与 Rust 各自解码来互相校验
/// (Node 侧见 `test/direct-wire.test.ts`)。
#[test]
fn node_chunk_frame_decodes_same_header_and_body() {
    let data = fixture();
    let chunk = &data["chunk"];

    let key_hex = chunk["keyHex"].as_str().expect("keyHex");
    assert_eq!(key_hex.len(), 64, "密钥应是 32 字节的十六进制");
    let mut key = [0u8; 32];
    for (i, slot) in key.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&key_hex[i * 2..i * 2 + 2], 16).expect("keyHex 应是十六进制");
    }

    use base64::Engine;
    let frame = base64::engine::general_purpose::STANDARD
        .decode(chunk["frameBase64"].as_str().expect("frameBase64"))
        .expect("frameBase64 应是合法 base64");
    let body = base64::engine::general_purpose::STANDARD
        .decode(chunk["bodyBase64"].as_str().expect("bodyBase64"))
        .expect("bodyBase64 应是合法 base64");

    let decoded = decode_binary_frame(&key, &frame).expect("Node 的帧 Rust 必须能解");
    assert_eq!(decoded.kind, BinaryFrameKind::DirectFileChunk);
    assert_eq!(decoded.header["id"], chunk["header"]["id"]);
    assert_eq!(decoded.header["seq"], chunk["header"]["seq"]);
    assert!(decoded.body == body.as_slice(), "帧体必须逐字节一致");
    // 帧头里没有 folder:直发不属于任何共享目录
    assert!(decoded.header.get("folder").is_none());
}

#[test]
fn direct_messages_survive_encryption() {
    let key = [7u8; 32];
    let offer = control(ControlMessage::DirectFileOffer {
        id: "df-9".to_string(),
        from_device_id: "B".to_string(),
        name: "a.bin".to_string(),
        size: 1024,
        sha256: "b".repeat(64),
        created_at: 11,
        batch_id: None,
        version: Some("0.51.0".to_string()),
        hostname: Some("mac".to_string()),
        platform: Some("darwin".to_string()),
        runtime: Some("rust".to_string()),
    });
    let encrypted = encrypt_message(&key, &offer).unwrap();
    let decoded = syncx_net::wire::decrypt_message(&key, &encrypted).unwrap();
    assert_eq!(decoded, offer);
}
