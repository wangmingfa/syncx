//! Rust↔Rust 全量同步端到端。
//!
//! 这是 ADR-0025 清单第 4 项的验收条件:「Rust↔Rust 全量同步跑通」。
//!
//! 测试走的路径与生产**同一套**:规划(用 core 的 build_plan)→ 请求块 → 校验 → 落盘。
//! 不复制一份"测试专用同步逻辑",否则测过的不是产线代码。

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

use syncx_core::blockstore::{hash_block, split_ranges};
use syncx_core::plan::{build_plan, IndexEntry, PlanAction};
use syncx_net::blockio::{fixed_ranges, hash_file_blocks, read_block, verify_block, write_blocks};
use syncx_net::identity::DeviceIdentity;
use syncx_net::server::{start_peer_server, Frame, PeerConnection};
use syncx_net::wire::{
    encode_binary_frame, encode_index, WireBlockRequest, WireEntry, WireMessage,
};

/// 造一个有内容的目录。文件名与内容都有意包含非 ASCII,顺带验证路径编码。
fn seed_source_tree(root: &Path) {
    std::fs::create_dir_all(root.join("docs/中文目录")).unwrap();
    std::fs::write(root.join("readme.md"), b"hello syncx\n").unwrap();
    std::fs::write(root.join("docs/中文目录/说明.txt"), "内容\n".as_bytes()).unwrap();
    // 跨多个定长块的文件(2.5 MiB)
    let mut big = Vec::with_capacity(2_621_440);
    for i in 0..2_621_440usize {
        big.push((i % 251) as u8);
    }
    std::fs::write(root.join("big.bin"), &big).unwrap();
    // 空文件:零块条目,最容易在"跳过零块"的实现里被漏掉
    std::fs::write(root.join("empty.txt"), b"").unwrap();
}

/// 扫描一个目录,产出 `build_plan` 需要的索引(与 daemon 的扫描同语义)。
async fn scan(root: &Path) -> BTreeMap<String, IndexEntry> {
    let mut index = BTreeMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let mut reader = tokio::fs::read_dir(&dir).await.unwrap();
        while let Some(entry) = reader.next_entry().await.unwrap() {
            let path = entry.path();
            let meta = entry.metadata().await.unwrap();
            if meta.is_dir() {
                stack.push(path);
                continue;
            }
            let rel = format!("/{}", path.strip_prefix(root).unwrap().to_string_lossy());
            let hashes = hash_file_blocks(&path).await.unwrap();
            let mut version = BTreeMap::new();
            version.insert("source-device".to_string(), 1u64);
            index.insert(
                rel.clone(),
                IndexEntry {
                    path: rel,
                    version,
                    size: meta.len(),
                    deleted: false,
                    blocks: hashes,
                    cdh: None,
                    clens: None,
                },
            );
        }
    }
    index
}

/// 起一个"真实对端":收到索引与块请求就按对端要求回块。
///
/// 回块路径特意走**二进制信封**(两端都宣告 binary1 时生产就是这么走的),
/// 这样二进制编解码也在端到端覆盖里。
async fn spawn_source_peer(
    root: Arc<std::path::PathBuf>,
    index: Arc<BTreeMap<String, IndexEntry>>,
) -> (u16, syncx_net::server::PeerServer) {
    let identity = Arc::new(DeviceIdentity::from_secret_bytes(&[31u8; 32]));
    let handler = Arc::new(
        move |mut connection: PeerConnection| -> futures_util::future::BoxFuture<'static, ()> {
            let root = Arc::clone(&root);
            let index = Arc::clone(&index);
            Box::pin(async move {
                // 先发全量索引(生产:会话建立后的第一件事)
                let wire_entries: Vec<WireEntry> = index
                    .values()
                    .map(|entry| WireEntry::from_entry(entry, 1_700_000_000))
                    .collect();
                let body = encode_index(&wire_entries);
                let header = serde_json::json!({ "folder": "/", "full": true });
                let frame = encode_binary_frame(
                    &connection.session_key,
                    syncx_net::wire::BinaryFrameKind::Index,
                    &header,
                    &body,
                )
                .unwrap();
                if connection.send_binary(frame).await.is_err() {
                    return;
                }

                // 供块:一直服务到对端断开
                while let Some(frame) = connection.recv().await {
                    let Frame::Text(text) = frame else { continue };
                    let Ok(message) =
                        syncx_net::wire::decrypt_message(&connection.session_key, &text)
                    else {
                        continue;
                    };
                    let WireMessage::BlockRequest { payload, .. } = message else {
                        continue;
                    };
                    let path = root.join(payload.path.trim_start_matches('/'));
                    let ranges =
                        fixed_ranges(std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0));
                    let Some(range) = ranges.get(payload.block_index as usize) else {
                        continue;
                    };
                    let Ok(bytes) = read_block(&path, range).await else {
                        continue;
                    };
                    // 对端声明的哈希是权威:不匹配就是索引过期,不发错的块
                    if !verify_block(&payload.hash, &bytes) {
                        continue;
                    }
                    let header = serde_json::json!({
                        "folder": "/",
                        "deviceId": payload.device_id,
                        "path": payload.path,
                        "blockIndex": payload.block_index,
                        "hash": payload.hash,
                        "cdc": false,
                    });
                    let frame = encode_binary_frame(
                        &connection.session_key,
                        syncx_net::wire::BinaryFrameKind::BlockResponse,
                        &header,
                        &bytes,
                    )
                    .unwrap();
                    if connection.send_binary(frame).await.is_err() {
                        return;
                    }
                }
            })
        },
    );
    let server = start_peer_server(identity, "127.0.0.1:0".parse().unwrap(), handler)
        .await
        .unwrap();
    (server.port, server)
}

#[tokio::test]
async fn rust_to_rust_full_sync() {
    let base = std::env::temp_dir().join(format!("syncx-rs-sync-{}", std::process::id()));
    let source = base.join("source");
    let target = base.join("target");
    let _ = std::fs::remove_dir_all(&base);
    seed_source_tree(&source);

    let source_index = Arc::new(scan(&source).await);
    assert_eq!(
        source_index.len(),
        4,
        "应有 4 个文件(readme/说明/big/empty)"
    );

    let (port, server) =
        spawn_source_peer(Arc::new(source.clone()), Arc::clone(&source_index)).await;

    // ---- 客户端:连接、收索引、规划、拉块、落盘 ----
    let identity = DeviceIdentity::from_secret_bytes(&[32u8; 32]);
    let mut connection =
        syncx_net::connect_peer(&identity, &format!("ws://127.0.0.1:{port}"), None)
            .await
            .expect("握手应成功")
            .connection;

    // 收索引(二进制帧)
    let frame = tokio::time::timeout(std::time::Duration::from_secs(5), connection.recv())
        .await
        .expect("应收索引")
        .expect("连接不应关闭");
    let Frame::Binary(bytes) = frame else {
        panic!("索引应走二进制信封");
    };
    let decoded =
        syncx_net::wire::decode_binary_frame(&connection.session_key, &bytes).expect("帧应能解");
    assert_eq!(decoded.kind, syncx_net::wire::BinaryFrameKind::Index);
    assert_eq!(decoded.header["full"], serde_json::json!(true));

    let remote_entries = syncx_net::wire::decode_index(&decoded.body).unwrap();
    let remote_index: BTreeMap<String, IndexEntry> = remote_entries
        .iter()
        .map(|e| (e.path.clone(), e.to_entry()))
        .collect();

    // 本地是空目录
    let local_index: BTreeMap<String, IndexEntry> = BTreeMap::new();
    let actions = build_plan(&local_index, &remote_index);
    let to_receive: Vec<&IndexEntry> = actions
        .iter()
        .filter_map(|action| match action {
            PlanAction::Receive { entry, .. } => Some(entry),
            _ => None,
        })
        .collect();
    assert_eq!(to_receive.len(), 4, "4 个文件都应被规划为接收:{actions:?}");

    let mut total_bytes = 0u64;
    for entry in to_receive {
        let ranges = fixed_ranges(entry.size);
        if ranges.is_empty() {
            // 空文件:零块也要落盘 —— 漏了会变成"永远同步不动的空文件"
            write_blocks(&target.join(entry.path.trim_start_matches('/')), &[])
                .await
                .unwrap();
            continue;
        }

        let mut blocks = Vec::new();
        for (idx, _range) in ranges.iter().enumerate() {
            connection
                .send_message(&WireMessage::BlockRequest {
                    folder: "/".to_string(),
                    payload: WireBlockRequest {
                        device_id: identity.device_id.clone(),
                        path: entry.path.clone(),
                        block_index: idx as u64,
                        hash: entry.blocks[idx].clone(),
                        priority: None,
                        cdc: None,
                    },
                })
                .await
                .unwrap();

            let frame = loop {
                let frame =
                    tokio::time::timeout(std::time::Duration::from_secs(10), connection.recv())
                        .await
                        .expect("应收块")
                        .expect("连接不应关闭");
                if matches!(frame, Frame::Binary(_)) {
                    break frame;
                }
            };
            let Frame::Binary(bytes) = frame else {
                unreachable!()
            };
            let block = syncx_net::wire::decode_binary_frame(&connection.session_key, &bytes)
                .expect("块帧应能解");
            assert_eq!(block.kind, syncx_net::wire::BinaryFrameKind::BlockResponse);
            assert_eq!(block.header["path"], serde_json::json!(entry.path));
            assert!(
                verify_block(&entry.blocks[idx], &block.body),
                "块哈希不符:{} 第 {idx} 块",
                entry.path
            );
            total_bytes += block.body.len() as u64;
            blocks.push((fixed_ranges(entry.size)[idx].offset, block.body));
        }

        // 写成 write_blocks 需要的形态
        let ranges = fixed_ranges(entry.size);
        let pairs: Vec<_> = blocks
            .into_iter()
            .zip(ranges)
            .map(|((_, bytes), range)| (range, bytes))
            .collect();
        let written = write_blocks(&target.join(entry.path.trim_start_matches('/')), &pairs)
            .await
            .unwrap();
        assert_eq!(written, entry.size);
    }

    // ---- 验收:目标目录与源目录逐字节一致 ----
    let expected_total: u64 = source_index.values().map(|e| e.size).sum();
    assert_eq!(total_bytes, expected_total, "拉的字节数应等于源目录总量");

    for (rel, entry) in source_index.iter() {
        let dst = target.join(rel.trim_start_matches('/'));
        let actual = std::fs::read(&dst).unwrap_or_else(|e| panic!("缺文件 {rel}: {e}"));
        assert_eq!(actual.len() as u64, entry.size, "{rel} 长度不符");
        let expected = std::fs::read(source.join(rel.trim_start_matches('/'))).unwrap();
        assert_eq!(actual, expected, "{rel} 内容不符");
    }

    // 临时文件不该留下
    fn find_part(dir: &Path) -> Vec<std::path::PathBuf> {
        let mut found = Vec::new();
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    found.extend(find_part(&path));
                } else if path.to_string_lossy().contains(".syncx-part") {
                    found.push(path);
                }
            }
        }
        found
    }
    assert!(find_part(&target).is_empty(), "不应留下临时文件");

    connection.close().await;
    server.close().await;
    let _ = std::fs::remove_dir_all(&base);
}

/// 定长分块与哈希的边界:空文件零块,1 字节一块,恰好 1 MiB 仍是一块。
#[tokio::test]
async fn block_ranges_edge_cases() {
    let dir = std::env::temp_dir().join(format!("syncx-rs-blocks-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    let empty = dir.join("empty");
    std::fs::write(&empty, b"").unwrap();
    assert!(hash_file_blocks(&empty).await.unwrap().is_empty());

    let one = dir.join("one");
    std::fs::write(&one, b"x").unwrap();
    assert_eq!(
        hash_file_blocks(&one).await.unwrap(),
        vec![hash_block(b"x")]
    );

    let exact = dir.join("exact");
    let payload = vec![7u8; 1024 * 1024];
    std::fs::write(&exact, &payload).unwrap();
    assert_eq!(split_ranges(payload.len()).len(), 1, "恰好 1 MiB 应是一块");
    let hashes = hash_file_blocks(&exact).await.unwrap();
    assert_eq!(hashes, vec![hash_block(&payload)]);

    let _ = std::fs::remove_dir_all(&dir);
}
