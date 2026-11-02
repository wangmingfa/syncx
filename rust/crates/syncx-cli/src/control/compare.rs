//! 对端数据面对话:索引快照、单文件读写、双栏对比。
//!
//! 这一层全部是**只读诊断 + 一次显式写入**(ADR-0013 的唯一例外),协议与 Node
//! `SessionManager` 的 `fetchPeerSnapshot` / `serveIndexSnapshot` / `readFilePair` /
//! `applyFileSync` 一一对应。三条不可动摇的口径:
//!
//!  * **闸门先于数据**。目录没把对端列进 `devices` 就一条索引、一个字节都不给;
//!    否则这条诊断通道就等于绕过共享关系的任意读取入口。
//!  * **端到端加密目录不对不可信对端开口**。明文路径清单与内容会直接违背
//!    「盲区只收密文」的承诺。
//!  * **写入采纳对端给定的版本**。自增本机计数器会把一次对齐判成「本机新编辑」,
//!    再推回去,一次点击变成两轮无意义传输。

use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

use base64::Engine as _;
use rand::RngCore;
use serde_json::{json, Value};
use tokio::sync::oneshot;

use syncx_api::config::SharedFolder;
use syncx_api::deps::OpError;
use syncx_core::blockstore::ViewHasher;
use syncx_core::file_kind::{compare_content_limit, image_mime_of};
use syncx_core::ignore::parse_conflict_copy_name;
use syncx_core::plan::IndexEntry;
use syncx_core::version::{increment_version, merge_versions, VersionVector};
use syncx_daemon::actor::Cmd;
use syncx_daemon::executor::{resolve_share_path, ExecutorError};
use syncx_daemon::StoredEntry;
use syncx_net::wire::ControlMessage;

use crate::diff::{
    check_diff_against_disk, content_digest, ruleset_from_lines, to_json_value, to_snapshot_entry,
    FolderDiff, FolderDiffInput, SnapshotEntry,
};
use crate::update;

use super::{PeerFile, PeerSnapshot, RuntimeOps};

/// 一片快照带多少条索引。
pub const SNAPSHOT_CHUNK_ENTRIES: usize = 2000;
/// 单次对比请求允许的最大文件字节(与 Node `FILE_COMPARE_MAX_BYTES` 同值)。
pub const FILE_COMPARE_MAX_BYTES: u64 = 2 * 1024 * 1024;

/* --------------------------- 等待中的请求台账 --------------------------- */

/// 一次快照请求的累积状态。分片到达时原地累积,集齐 `total` 片才放行等待方。
///
/// `reply` 取走即置 `None`:超时之后迟到的片还会进到这里,那时已经没有等待方,
/// 再 `send` 只会静默失败并留下一条永不清理的台账。
pub struct SnapshotWaiter {
    pub total: u64,
    pub chunks: BTreeMap<u64, Vec<SnapshotEntry>>,
    pub ignore_lines: Option<Vec<String>>,
    pub progress: Option<Value>,
    pub reply: Option<oneshot::Sender<Result<PeerSnapshot, String>>>,
}

/* ------------------------------- 对比 ------------------------------- */

/// 取对端某目录的索引快照。
///
/// 失败一律报错,不拿会话建立时那份内存镜像糊弄 —— 那份只在挂载时刻准确,
/// 对端之后改忽略规则或只发增量都会让它悄悄过期,而「给出过期结论」比「不给结论」更糟。
pub fn request_snapshot(
    ops: &RuntimeOps,
    device_id: &str,
    folder_id: &str,
) -> Result<PeerSnapshot, String> {
    if !ops.is_connected(device_id) {
        return Err("设备离线,无法对比".to_string());
    }
    let request_id = random_hex(8);
    let (tx, rx) = oneshot::channel::<Result<PeerSnapshot, String>>();
    if let Ok(mut map) = ops.pending_snapshots.lock() {
        map.insert(
            request_id.clone(),
            SnapshotWaiter {
                total: 0,
                chunks: BTreeMap::new(),
                ignore_lines: None,
                progress: None,
                reply: Some(tx),
            },
        );
    }
    let sent = ops.send_to(
        device_id,
        ControlMessage::FolderIndexRequest {
            request_id: request_id.clone(),
            from_device_id: ops.device_id.clone(),
            folder_id: folder_id.to_string(),
            version: Some(ops.version.clone()),
            hostname: own_hostname(),
            platform: Some(syncx_api::status::platform_name().to_string()),
        },
    );
    if !sent {
        forget(&ops.pending_snapshots, &request_id);
        return Err("发送对比请求失败(设备可能刚离线)".to_string());
    }
    wait(
        rx,
        super::SNAPSHOT_TIMEOUT_MS,
        "对端响应超时(20s):可能是旧版本,或对端目录过大",
    )
}

/// 收到一片快照:累积,集齐 `total` 片才放行等待方。
///
/// 畸形声明(序号越界、片数超限、片间不一致)一律忽略并靠超时兜底 ——
/// 为一条坏消息中断整个等待,或按它声明的总量撑爆内存,都比慢一点更糟。
pub fn on_snapshot_chunk(
    ops: &RuntimeOps,
    message: ControlMessage,
) -> Option<(String, Value, Option<Vec<String>>)> {
    let ControlMessage::FolderIndexSnapshot {
        request_id,
        folder_id,
        seq,
        total,
        entries,
        error,
        ignore_lines,
        progress,
        ..
    } = message
    else {
        return None;
    };
    let mut map = ops.pending_snapshots.lock().ok()?;

    if let Some(error) = error {
        if let Some(mut waiter) = map.remove(&request_id) {
            if let Some(reply) = waiter.reply.take() {
                let _ = reply.send(Err(error));
            }
        }
        return None;
    }

    let sane = total >= 1
        && total as usize <= super::MAX_SNAPSHOT_CHUNKS
        && seq < total
        && map
            .get(&request_id)
            .is_some_and(|waiter| waiter.total == 0 || waiter.total == total);
    if !sane {
        return None;
    }

    let waiter = map.get_mut(&request_id)?;
    if waiter.total == 0 {
        waiter.total = total;
    }
    if let Some(lines) = ignore_lines {
        waiter.ignore_lines = Some(lines);
    }
    if progress.is_some() {
        waiter.progress = progress;
    }
    if let Some(entries) = entries {
        let Ok(raw) = base64::engine::general_purpose::STANDARD.decode(entries.as_bytes()) else {
            return None;
        };
        let Ok(chunk) = serde_json::from_slice::<Vec<SnapshotEntry>>(&raw) else {
            return None;
        };
        waiter.chunks.insert(seq, chunk);
    }
    if (waiter.chunks.len() as u64) < waiter.total {
        return None;
    }

    let waiter = map.remove(&request_id)?;
    let mut all = Vec::new();
    for seq in 0..waiter.total {
        if let Some(chunk) = waiter.chunks.get(&seq) {
            all.extend(chunk.iter().cloned());
        }
    }
    let snapshot = PeerSnapshot {
        entries: all,
        ignore_lines: waiter.ignore_lines,
        progress: waiter.progress,
        at: syncx_api::auth::now_ms(),
    };
    if let Some(reply) = waiter.reply {
        let _ = reply.send(Ok(snapshot.clone()));
    }
    Some((folder_id, json!({ "at": snapshot.at }), None))
}

/// 对端请求本机某目录的索引快照:按片回传。
pub fn serve_index_snapshot(ops: &RuntimeOps, device_id: &str, folder_id: &str, request_id: &str) {
    let deny = |ops: &RuntimeOps, error: &str| {
        let _ = ops.send_to(
            device_id,
            ControlMessage::FolderIndexSnapshot {
                request_id: request_id.to_string(),
                from_device_id: ops.device_id.clone(),
                folder_id: folder_id.to_string(),
                seq: 0,
                total: 1,
                entries: None,
                error: Some(error.to_string()),
                ignore_lines: None,
                progress: None,
                version: Some(ops.version.clone()),
                hostname: own_hostname(),
                platform: Some(syncx_api::status::platform_name().to_string()),
            },
        );
    };
    let config = ops.store.load();
    let Some(folder) = config.folder(folder_id).cloned() else {
        deny(ops, "该目录未共享给请求方");
        tracing::info!("index snapshot denied: folder {folder_id} is not shared with {device_id}");
        return;
    };
    if !folder.devices.iter().any(|id| id == device_id) {
        deny(ops, "该目录未共享给请求方");
        tracing::info!("index snapshot denied: folder {folder_id} is not shared with {device_id}");
        return;
    }
    if e2e_untrusted(&folder, device_id) {
        deny(ops, "该目录已启用端到端加密,不可信设备不提供索引快照");
        tracing::info!("index snapshot denied (e2e untrusted): folder {folder_id} → {device_id}");
        return;
    }
    let Some(entries) = ops.index_snapshot(folder_id) else {
        deny(ops, "该目录未在同步中");
        return;
    };
    let snapshot: Vec<SnapshotEntry> = entries
        .iter()
        .map(|entry| to_snapshot_entry(&entry.core(), entry.mtime))
        .collect();
    let total = snapshot.len().div_ceil(SNAPSHOT_CHUNK_ENTRIES).max(1);
    let progress = folder_progress(ops, folder_id);
    let ignore_lines = ops.ignore_lines(&folder);

    for seq in 0..total {
        let from = seq * SNAPSHOT_CHUNK_ENTRIES;
        let to = (from + SNAPSHOT_CHUNK_ENTRIES).min(snapshot.len());
        let chunk = &snapshot[from.min(snapshot.len())..to];
        let encoded = serde_json::to_vec(chunk).unwrap_or_else(|_| b"[]".to_vec());
        let _ = ops.send_to(
            device_id,
            ControlMessage::FolderIndexSnapshot {
                request_id: request_id.to_string(),
                from_device_id: ops.device_id.clone(),
                folder_id: folder_id.to_string(),
                seq: seq as u64,
                total: total as u64,
                entries: Some(base64::engine::general_purpose::STANDARD.encode(encoded)),
                error: None,
                // 忽略规则每片都带:体量远小于条目本身,换来「不必假设首片必达」
                ignore_lines: Some(ignore_lines.clone()),
                progress: progress.clone(),
                version: Some(ops.version.clone()),
                hostname: own_hostname(),
                platform: Some(syncx_api::status::platform_name().to_string()),
            },
        );
    }
    tracing::info!(
        "index snapshot served to {device_id} for {folder_id}: {} entries in {total} chunk(s)",
        snapshot.len()
    );
}

/// 分类差异。`with_local` 为真时连本机条目清单一起给出(双栏对比要用)。
pub fn diff_folder(
    ops: &RuntimeOps,
    folder_id: &str,
    device_id: &str,
    with_local: bool,
) -> Result<Value, OpError> {
    // 两种入口共用同一句(Node 也是同一句);保留 `with_local` 之外的差异只在载荷形状
    let fail = "该目录未与这台设备共享,无法对比";
    let config = ops.store.load();
    let folder = config
        .folder(folder_id)
        .cloned()
        .ok_or_else(|| OpError::Failed("共享目录不存在(可能刚被移除)".to_string()))?;
    if !folder.devices.iter().any(|id| id == device_id) {
        return Err(OpError::Failed(fail.to_string()));
    }
    let snapshot = request_snapshot(ops, device_id, folder_id).map_err(OpError::Failed)?;

    let stored = ops
        .index_snapshot(folder_id)
        .ok_or_else(|| OpError::Failed("共享目录不存在(可能刚被移除)".to_string()))?;
    let local: BTreeMap<String, IndexEntry> = stored
        .iter()
        .map(|entry| (entry.path.clone(), entry.core()))
        .collect();

    let local_rules = ruleset_from_lines(&ops.ignore_lines(&folder));
    let remote_rules = snapshot
        .ignore_lines
        .as_ref()
        .map(|lines| ruleset_from_lines(lines));

    let mut diff: FolderDiff = crate::diff::build_folder_diff(FolderDiffInput {
        local: &local,
        remote: &snapshot.entries,
        local_rules: &local_rules,
        remote_rules: remote_rules.as_ref(),
    });
    check_diff_against_disk(Path::new(&folder.path), &mut diff.items);

    let info = ops.peer_info_of(device_id);
    let mut out = serde_json::Map::new();
    out.insert("folderId".into(), json!(folder_id));
    out.insert("folderPath".into(), json!(folder.path));
    out.insert("deviceId".into(), json!(device_id));
    if let Some(version) = info.version {
        out.insert("deviceVersion".into(), json!(version));
    }
    if let Some(hostname) = info.hostname {
        out.insert("deviceHostname".into(), json!(hostname));
    }
    if let Some(url) = ops.peer_url_of(device_id) {
        out.insert("deviceUrl".into(), json!(url));
    }
    out.insert("localHostname".into(), json!(own_hostname()));
    out.insert(
        "localAddresses".into(),
        json!(syncx_api::status::lan_addresses()),
    );
    out.insert("remoteAt".into(), json!(snapshot.at));
    out.insert("diff".into(), to_json_value(&diff));
    if let Some(progress) = folder_progress(ops, folder_id) {
        out.insert("localProgress".into(), progress);
    }
    if let Some(progress) = snapshot.progress.clone() {
        out.insert("remoteProgress".into(), progress);
    }
    if with_local {
        let local_entries: Vec<SnapshotEntry> = stored
            .iter()
            .map(|entry| to_snapshot_entry(&entry.core(), entry.mtime))
            .collect();
        out.insert(
            "local".into(),
            serde_json::to_value(&local_entries).unwrap_or(Value::Null),
        );
        out.insert(
            "remote".into(),
            serde_json::to_value(&snapshot.entries).unwrap_or(Value::Null),
        );
    }
    Ok(Value::Object(out))
}

/// 本机某目录此刻的传输进度。全为 0 时返回 `None` ——
/// 那不是「此刻在传输」,带上会让前端凭空多一句提示。
pub fn folder_progress(ops: &RuntimeOps, folder_id: &str) -> Option<Value> {
    let snapshot = ops.actor.snapshot();
    let status = snapshot.folders.iter().find(|f| f.id == folder_id)?;
    let progress = &status.progress;
    if progress.pending + progress.sending + progress.receiving == 0 && progress.files.is_empty() {
        return None;
    }
    let mut out = serde_json::Map::new();
    out.insert("pending".into(), json!(progress.pending));
    out.insert("sending".into(), json!(progress.sending));
    out.insert("receiving".into(), json!(progress.receiving));
    if !progress.files.is_empty() {
        let files: Vec<Value> = progress
            .files
            .iter()
            .map(|file| {
                let mut one = serde_json::Map::new();
                one.insert("path".into(), json!(file.path));
                one.insert("direction".into(), json!(file.direction));
                one.insert("bytesDone".into(), json!(file.bytes_done));
                one.insert("bytesTotal".into(), json!(file.bytes_total));
                if file.priority {
                    one.insert("priority".into(), json!(true));
                }
                Value::Object(one)
            })
            .collect();
        out.insert("files".into(), Value::Array(files));
    }
    Some(Value::Object(out))
}

/* --------------------------- 单文件读写 --------------------------- */

/// 两侧内容对比。`device_id` 为空串时走「冲突副本 vs 原文件」分支 ——
/// 与 Node 用空设备标出「两侧都在本机」是同一约定。
pub fn read_file_pair(
    ops: &RuntimeOps,
    folder_id: &str,
    device_id: &str,
    path: &str,
) -> Result<Value, OpError> {
    let config = ops.store.load();
    let folder = config
        .folder(folder_id)
        .cloned()
        .ok_or_else(|| OpError::Failed("共享目录不存在(可能刚被移除)".to_string()))?;

    if device_id.is_empty() {
        let cut = path.rfind('/').map(|i| i + 1).unwrap_or(0);
        let (original, origin) = parse_conflict_copy_name(&path[cut..])
            .ok_or_else(|| OpError::Failed("不是冲突副本命名".to_string()))?;
        let original_rel = format!("{}{}", &path[..cut], original);
        return Ok(json!({
            "folderId": folder_id,
            "folderPath": folder.path,
            "deviceId": origin,
            "path": original_rel,
            "local": read_local_file_for_compare(&folder, &original_rel, false),
            // 只有副本那一侧豁免硬忽略:副本命名本身是硬忽略对象,
            // 而这条链路正是硬忽略闸门自己豁免的冲突处理路径。
            "remote": read_local_file_for_compare(&folder, path, true),
        }));
    }

    if !folder.devices.iter().any(|id| id == device_id) {
        return Err(OpError::Failed(
            "该目录未与这台设备共享,无法对比".to_string(),
        ));
    }
    let local = read_local_file_for_compare(&folder, path, false);
    let remote = match request_peer_file(ops, device_id, folder_id, path) {
        Ok(file) => {
            let mut side = describe_bytes(path, &file.data);
            side["exists"] = json!(true);
            side["size"] = json!(file.size);
            if let Some(version) = &file.version {
                side["version"] = serde_json::to_value(version).unwrap_or(Value::Null);
            }
            side
        }
        // 对端离线 / 文件不存在 / 过大:都要如实交给弹窗,由它决定怎么提示
        Err(error) => json!({ "exists": false, "error": error }),
    };
    Ok(json!({
        "folderId": folder_id,
        "folderPath": folder.path,
        "deviceId": device_id,
        "path": path,
        "local": local,
        "remote": remote,
    }))
}

/// 把一侧内容对齐到另一侧。
///
/// 版本怎么给是这里唯一的难点:内容完全一致 → 两侧都置 merge,立刻收敛;
/// 只应用了部分差异 → 目标侧在 merge 后自增**目标设备**的计数器,当作一次真实编辑,
/// 由正常同步传播收敛。绝不能把两侧置成相等,那正是最强的异常信号
/// 「版本相同但内容不同」,差异会永远沉下去。
pub fn apply_file_sync(
    ops: &RuntimeOps,
    folder_id: &str,
    device_id: &str,
    path: &str,
    direction: &str,
    content: Option<String>,
) -> Result<(), OpError> {
    let t0 = syncx_api::auth::now_ms();
    if direction != "pull" && direction != "push" {
        return Err(OpError::Failed(
            "direction must be 'pull' or 'push'".to_string(),
        ));
    }
    let config = ops.store.load();
    let folder = config
        .folder(folder_id)
        .cloned()
        .ok_or_else(|| OpError::Failed("共享目录不存在(可能刚被移除)".to_string()))?;
    if !folder.devices.iter().any(|id| id == device_id) {
        return Err(OpError::Failed(
            "该目录未与这台设备共享,无法同步".to_string(),
        ));
    }
    let local_entry = ops.entry_lookup(folder_id, path);
    let local_bytes = try_read_local_bytes(&folder, path);

    // 即便内容由前端给定,也要读一次对端:版本向量必须来自对端索引,不能用前端传的
    let mut remote_data: Option<Vec<u8>> = None;
    let mut remote_version: VersionVector = VersionVector::new();
    match request_peer_file(ops, device_id, folder_id, path) {
        Ok(file) => {
            remote_data = Some(file.data);
            remote_version = file.version.unwrap_or_default().into_iter().collect();
        }
        Err(error) => {
            if direction == "pull" {
                return Err(OpError::Failed(format!("读取对端文件失败:{error}")));
            }
        }
    }
    let merged = merge_versions(
        &local_entry
            .as_ref()
            .map(|entry| entry.version.clone())
            .unwrap_or_default(),
        &remote_version,
    );

    if direction == "pull" {
        let target = match content {
            Some(text) => text.into_bytes(),
            None => remote_data
                .clone()
                .ok_or_else(|| OpError::Failed("对端文件内容不可用,无法拉取".to_string()))?,
        };
        let identical = remote_data.as_deref() == Some(target.as_slice());
        let version = if identical {
            merged
        } else {
            increment_version(&merged, &ops.device_id)
        };
        write_local_file(ops, &folder, path, &target, &version)
            .map_err(|error| OpError::Failed(error.to_string()))?;
        ops.record_event(
            folder_id,
            path,
            "update",
            "remote",
            Some(device_id),
            Some(syncx_api::auth::now_ms() - t0),
        );
    } else {
        let target = match content {
            Some(text) => text.into_bytes(),
            None => local_bytes
                .as_ref()
                .ok_or_else(|| OpError::Failed("本机文件不存在或过大,无法推送".to_string()))?
                .clone(),
        };
        let identical = local_bytes.as_deref() == Some(target.as_slice());
        let remote_target = if identical {
            merged.clone()
        } else {
            increment_version(&merged, device_id)
        };
        let wire_version: Vec<(String, u64)> =
            remote_target.iter().map(|(k, v)| (k.clone(), *v)).collect();
        write_peer_file(ops, device_id, folder_id, path, &target, wire_version)
            .map_err(|error| OpError::Failed(format!("推送失败:{error}")))?;
        // 本机内容没动,但版本要跟到 merge:否则本机仍以旧版本自居,下一轮会把
        // 同一份内容当作「本机较新」再推一次
        if let Some(mut entry) = local_entry {
            entry.version = merged;
            let _ = ops.actor.send(Cmd::StoreEntry {
                folder: folder_id.to_string(),
                entry,
            });
        }
        ops.record_event(
            folder_id,
            path,
            "update",
            "local",
            Some(device_id),
            Some(syncx_api::auth::now_ms() - t0),
        );
    }
    ops.notify_hub();
    Ok(())
}

/// 向对端索取某文件内容。
pub fn request_peer_file(
    ops: &RuntimeOps,
    device_id: &str,
    folder_id: &str,
    path: &str,
) -> Result<PeerFile, String> {
    if !ops.is_connected(device_id) {
        return Err("设备离线,无法对比".to_string());
    }
    let request_id = random_hex(8);
    let (tx, rx) = oneshot::channel::<Result<PeerFile, String>>();
    if let Ok(mut map) = ops.pending_files.lock() {
        map.insert(request_id.clone(), tx);
    }
    let sent = ops.send_to(
        device_id,
        ControlMessage::FileContentRequest {
            request_id: request_id.clone(),
            from_device_id: ops.device_id.clone(),
            folder_id: folder_id.to_string(),
            path: path.to_string(),
            version: Some(ops.version.clone()),
            hostname: own_hostname(),
            platform: Some(syncx_api::status::platform_name().to_string()),
        },
    );
    if !sent {
        forget(&ops.pending_files, &request_id);
        return Err("发送文件请求失败(设备可能刚离线)".to_string());
    }
    wait(
        rx,
        super::FILE_REQUEST_TIMEOUT_MS,
        "对端响应超时(20s):文件可能并未返回",
    )
}

/// 收到对端回传的文件内容。
pub fn on_peer_file_response(ops: &RuntimeOps, message: ControlMessage) {
    let ControlMessage::FileContentResponse {
        request_id,
        data,
        size,
        entry_version,
        error,
        ..
    } = message
    else {
        return;
    };
    let reply = ops
        .pending_files
        .lock()
        .ok()
        .and_then(|mut map| map.remove(&request_id));
    let Some(reply) = reply else {
        return; // 超时之后迟到的响应:直接丢弃
    };
    match (error, data) {
        (None, Some(data)) => {
            let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data.as_bytes())
            else {
                let _ = reply.send(Err("对端返回的内容不是合法 base64".to_string()));
                return;
            };
            let _ = reply.send(Ok(PeerFile {
                size: size.unwrap_or(bytes.len() as u64),
                data: bytes,
                version: entry_version,
            }));
        }
        (error, _) => {
            let _ = reply.send(Err(
                error.unwrap_or_else(|| "对端未提供文件内容".to_string())
            ));
        }
    }
}

/// 收到写入结果。
pub fn on_peer_file_write_result(ops: &RuntimeOps, message: ControlMessage) {
    let ControlMessage::FileContentWriteResult {
        request_id,
        ok,
        error,
        ..
    } = message
    else {
        return;
    };
    let reply = ops
        .pending_writes
        .lock()
        .ok()
        .and_then(|mut map| map.remove(&request_id));
    if let Some(reply) = reply {
        let _ = reply.send(if ok {
            Ok(())
        } else {
            Err(error.unwrap_or_else(|| "对端写入失败".to_string()))
        });
    }
}

/// 让对端按给定内容落盘并采纳给定版本。
pub fn write_peer_file(
    ops: &RuntimeOps,
    device_id: &str,
    folder_id: &str,
    path: &str,
    data: &[u8],
    version: Vec<(String, u64)>,
) -> Result<(), String> {
    if !ops.is_connected(device_id) {
        return Err("设备离线,无法写入对端文件".to_string());
    }
    let request_id = random_hex(8);
    let (tx, rx) = oneshot::channel::<Result<(), String>>();
    if let Ok(mut map) = ops.pending_writes.lock() {
        map.insert(request_id.clone(), tx);
    }
    let sent = ops.send_to(
        device_id,
        ControlMessage::FileContentWrite {
            request_id: request_id.clone(),
            from_device_id: ops.device_id.clone(),
            folder_id: folder_id.to_string(),
            path: path.to_string(),
            data: base64::engine::general_purpose::STANDARD.encode(data),
            entry_version: version,
            version: Some(ops.version.clone()),
            hostname: own_hostname(),
            platform: Some(syncx_api::status::platform_name().to_string()),
        },
    );
    if !sent {
        forget(&ops.pending_writes, &request_id);
        return Err("发送写入请求失败(设备可能刚离线)".to_string());
    }
    wait(
        rx,
        super::FILE_REQUEST_TIMEOUT_MS,
        "对端响应超时(20s):文件可能并未写入",
    )
}

/// 对端要求本机按给定内容落盘并采纳给定版本。
pub fn apply_peer_file_write(ops: &RuntimeOps, message: ControlMessage) {
    let ControlMessage::FileContentWrite {
        request_id,
        from_device_id,
        folder_id,
        path,
        data,
        entry_version,
        ..
    } = message
    else {
        return;
    };
    let reply = |ops: &RuntimeOps, ok: bool, error: Option<String>| {
        let _ = ops.send_to(
            &from_device_id,
            ControlMessage::FileContentWriteResult {
                request_id: request_id.clone(),
                from_device_id: ops.device_id.clone(),
                folder_id: folder_id.clone(),
                path: path.clone(),
                ok,
                error,
                version: Some(ops.version.clone()),
                hostname: own_hostname(),
                platform: Some(syncx_api::status::platform_name().to_string()),
            },
        );
    };

    let config = ops.store.load();
    let Some(folder) = config
        .folder(&folder_id)
        .filter(|f| f.devices.iter().any(|id| id == &from_device_id))
        .cloned()
    else {
        reply(ops, false, Some("该目录未共享给请求方".to_string()));
        return;
    };
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data.as_bytes()) else {
        reply(ops, false, Some("内容不是合法 base64".to_string()));
        return;
    };
    if bytes.len() as u64 > FILE_COMPARE_MAX_BYTES {
        reply(ops, false, Some("内容超过体积上限".to_string()));
        return;
    }
    let version: VersionVector = entry_version.into_iter().collect();
    match write_local_file(ops, &folder, &path, &bytes, &version) {
        Ok(()) => {
            reply(ops, true, None);
            tracing::info!(
                "compare sync: wrote {folder_id}/{path} ({}B) requested by {from_device_id}",
                bytes.len()
            );
            ops.notify_hub();
        }
        Err(error) => reply(ops, false, Some(error.to_string())),
    }
}

/// 对端索取文件内容:回一份只读内容。
///
/// 与索引快照共用同一道共享关系闸门,并且**只认索引里登记在册的活条目** ——
/// 索引之外的文件(被忽略规则排除、或刚被删除)不该经这条通道被读走,
/// 它反映的是「参与同步的内容」,不是磁盘全貌。
pub fn serve_peer_file(
    ops: &RuntimeOps,
    device_id: &str,
    folder_id: &str,
    path: &str,
    request_id: &str,
) {
    let reply = |data: Option<String>,
                 size: Option<u64>,
                 entry_version: Option<Vec<(String, u64)>>,
                 error: Option<String>| {
        let _ = ops.send_to(
            device_id,
            ControlMessage::FileContentResponse {
                request_id: request_id.to_string(),
                from_device_id: ops.device_id.clone(),
                folder_id: folder_id.to_string(),
                path: path.to_string(),
                data,
                size,
                entry_version,
                error,
                version: Some(ops.version.clone()),
                hostname: own_hostname(),
                platform: Some(syncx_api::status::platform_name().to_string()),
            },
        );
    };

    let config = ops.store.load();
    let Some(folder) = config
        .folder(folder_id)
        .filter(|f| f.devices.iter().any(|id| id == device_id))
        .cloned()
    else {
        reply(None, None, None, Some("该目录未共享给请求方".to_string()));
        return;
    };
    if e2e_untrusted(&folder, device_id) {
        reply(
            None,
            None,
            None,
            Some("该目录已启用端到端加密,不可信设备不提供文件内容".to_string()),
        );
        return;
    }
    let Some(entry) = ops.entry_lookup(folder_id, path) else {
        reply(None, None, None, Some("该文件不存在(或已删除)".to_string()));
        return;
    };
    if entry.deleted {
        reply(None, None, None, Some("该文件不存在(或已删除)".to_string()));
        return;
    }
    let abs = match resolve_share_path(Path::new(&folder.path), path, false) {
        Ok(abs) => abs,
        Err(error) => {
            reply(None, None, None, Some(error.to_string()));
            return;
        }
    };
    let Ok(meta) = std::fs::metadata(&abs) else {
        reply(None, None, None, Some("该文件不存在(或已删除)".to_string()));
        return;
    };
    if !meta.is_file() {
        reply(None, None, None, Some("该路径不是文件".to_string()));
        return;
    }
    let limit = compare_content_limit(path);
    if meta.len() > limit {
        reply(
            None,
            None,
            None,
            Some(format!(
                "文件过大({}KB,上限 {}KB),不支持内容对比",
                meta.len().div_ceil(1024),
                limit / 1024
            )),
        );
        return;
    }
    match std::fs::read(&abs) {
        Ok(bytes) => {
            let version: Vec<(String, u64)> =
                entry.version.iter().map(|(k, v)| (k.clone(), *v)).collect();
            reply(
                Some(base64::engine::general_purpose::STANDARD.encode(&bytes)),
                Some(bytes.len() as u64),
                Some(version),
                None,
            );
        }
        Err(error) => reply(None, None, None, Some(error.to_string())),
    }
}

/// 原子写文件并以**给定版本**登记索引。版本由调用方给:这是「按指定内容对齐」,
/// 不是本机新编辑 —— 自增会让这次写入被判成新编辑再推回去。
pub fn write_local_file(
    ops: &RuntimeOps,
    folder: &SharedFolder,
    path: &str,
    data: &[u8],
    version: &VersionVector,
) -> Result<(), ExecutorError> {
    let abs = resolve_share_path(Path::new(&folder.path), path, false)?;
    if let Some(parent) = abs.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // 临时名带时间戳,不复用 `<abs>.syncx-tmp`:那个名字现在是**断点续传的在途文件**,
    // 一次强制写入把它截断就等于删掉对端正在收的内容。后缀保持 .syncx-tmp,
    // 扫描器照旧跳过它,崩溃残留也归进同一条 TTL 回收。
    let stamp = base36(syncx_api::auth::now_ms());
    let tmp = abs.with_file_name(format!(
        "{}.{stamp}.syncx-tmp",
        abs.file_name().and_then(|n| n.to_str()).unwrap_or("file")
    ));
    std::fs::write(&tmp, data)?;
    std::fs::rename(&tmp, &abs)?;

    let mut hasher = ViewHasher::new();
    hasher.push(data);
    let views = hasher.finish();
    let mtime = std::fs::metadata(&abs)
        .ok()
        .and_then(|meta| meta.modified().ok())
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64);
    let entry = StoredEntry::new(
        IndexEntry {
            path: path.to_string(),
            version: version.clone(),
            size: data.len() as u64,
            deleted: false,
            blocks: views.blocks,
            cdh: (!views.cdh.is_empty()).then_some(views.cdh),
            clens: (!views.clens.is_empty()).then_some(views.clens),
        },
        mtime,
        false,
    );
    let _ = ops.actor.send(Cmd::StoreEntry {
        folder: folder.folder_id(),
        entry,
    });
    Ok(())
}

/// 一侧文件的本机状态(对比弹窗的数据源)。
pub fn read_local_file_for_compare(
    folder: &SharedFolder,
    path: &str,
    allow_hard_ignored: bool,
) -> Value {
    let mut side = serde_json::Map::new();
    let abs = match resolve_share_path(Path::new(&folder.path), path, allow_hard_ignored) {
        Ok(abs) => abs,
        Err(error) => {
            side.insert("exists".into(), json!(false));
            side.insert("error".into(), json!(error.to_string()));
            return Value::Object(side);
        }
    };
    // 「没有这个文件」与「有,但读不到」是两回事:真缺失留空 error,
    // 闸门拒绝 / 越界 / IO 错误一律把原因带上,由弹窗如实说。
    let meta = match std::fs::metadata(&abs) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            side.insert("exists".into(), json!(false));
            return Value::Object(side);
        }
        Err(error) => {
            side.insert("exists".into(), json!(false));
            side.insert("error".into(), json!(error.to_string()));
            return Value::Object(side);
        }
    };
    if !meta.is_file() {
        side.insert("exists".into(), json!(false));
        return Value::Object(side);
    }
    side.insert("exists".into(), json!(true));
    side.insert("size".into(), json!(meta.len()));
    if meta.len() > compare_content_limit(path) {
        side.insert("tooLarge".into(), json!(true));
        return Value::Object(side);
    }
    match std::fs::read(&abs) {
        Ok(bytes) => {
            let described = describe_bytes(path, &bytes);
            if let Some(map) = described.as_object() {
                for (key, value) in map {
                    side.insert(key.clone(), value.clone());
                }
            }
            Value::Object(side)
        }
        Err(error) => {
            side.insert("error".into(), json!(error.to_string()));
            Value::Object(side)
        }
    }
}

/// 字节 → 一侧的内容状态。文本与图片**可以同时成立**(`.svg` 既是图片又是文本),
/// 前端在两种视图间切换;raster 图片只给 image(同时 binary 为真,那是事实)。
pub fn describe_bytes(path: &str, bytes: &[u8]) -> Value {
    let mut out = serde_json::Map::new();
    if let Some(mime) = image_mime_of(path) {
        if !bytes.is_empty() {
            out.insert(
                "image".into(),
                json!({
                    "mime": mime,
                    "data": base64::engine::general_purpose::STANDARD.encode(bytes),
                }),
            );
        }
    }
    match decode_text(bytes) {
        Some(text) => {
            out.insert("text".into(), json!(text));
        }
        None => {
            out.insert("binary".into(), json!(true));
        }
    }
    Value::Object(out)
}

/// 字节 → 文本;二进制返回 `None`。
///
/// 判据不只是「含 NUL」:UTF-16 / 部分单字节编码的文件不含 NUL 却也不是可读文本,
/// 故再补一道 UTF-8 往返校验(解码后重新编码必须与原文逐字节相同)。
pub fn decode_text(bytes: &[u8]) -> Option<String> {
    if bytes.is_empty() {
        return Some(String::new());
    }
    let window = &bytes[..bytes.len().min(8192)];
    if window.contains(&0) {
        return None;
    }
    let text = std::str::from_utf8(bytes).ok()?;
    (text.as_bytes() == bytes).then(|| text.to_string())
}

/// 本机文件字节;不存在 / 越界 / 非文件 / 超过(按类型的)上限时返回 `None`。
pub fn try_read_local_bytes(folder: &SharedFolder, path: &str) -> Option<Vec<u8>> {
    let abs = resolve_share_path(Path::new(&folder.path), path, false).ok()?;
    let meta = std::fs::metadata(&abs).ok()?;
    if !meta.is_file() || meta.len() > compare_content_limit(path) {
        return None;
    }
    std::fs::read(&abs).ok()
}

/// 该目录对该对端是否走端到端加密视图(口令已设 + 对端在不可信名单里)。
fn e2e_untrusted(folder: &SharedFolder, device_id: &str) -> bool {
    let Some(record) = folder.e2e_key.as_ref() else {
        return false;
    };
    let valid = record
        .get("key")
        .and_then(|value| value.as_str())
        .and_then(|key| {
            base64::engine::general_purpose::STANDARD
                .decode(key.as_bytes())
                .ok()
        })
        .is_some_and(|raw| raw.len() == 32);
    if !valid {
        return false;
    }
    folder
        .e2e_untrusted
        .as_ref()
        .is_some_and(|list| list.iter().any(|id| id == device_id))
}

/* ------------------------------ 工具 ------------------------------ */

fn own_hostname() -> Option<String> {
    std::env::var("COMPUTERNAME").ok().or_else(|| {
        hostname::get()
            .ok()
            .and_then(|name| name.into_string().ok())
    })
}

fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    hex::encode(buf)
}

fn forget<T>(map: &std::sync::Mutex<std::collections::HashMap<String, T>>, key: &str) {
    if let Ok(mut map) = map.lock() {
        map.remove(key);
    }
}

/// 等一条一次性响应。
///
/// 三态分开报:通道被对端主动回绝(`Ok(Err(msg))`)、发送方被丢弃(取消)、
/// 超时。合并成一句「失败」会让「对端明确说不行」和「对端根本没回」无从区分。
fn wait<T>(
    rx: oneshot::Receiver<Result<T, String>>,
    timeout_ms: u64,
    timeout_message: &str,
) -> Result<T, String> {
    let message = timeout_message.to_string();
    update::bridge(async move {
        match tokio::time::timeout(Duration::from_millis(timeout_ms), rx).await {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(error))) => Err(error),
            Ok(Err(_)) => Err("请求已被取消".to_string()),
            Err(_) => Err(message),
        }
    })
}

fn base36(value: i64) -> String {
    let mut n = value.max(0) as u64;
    if n == 0 {
        return "0".to_string();
    }
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    while n > 0 {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8_lossy(&out).to_string()
}

/// 供装配层把 `SelfBinaryResponse` 交回等待方。
pub fn on_self_binary_response(ops: &RuntimeOps, message: ControlMessage) {
    let ControlMessage::SelfBinaryResponse {
        request_id, data, ..
    } = message
    else {
        return;
    };
    let reply = ops
        .pending_binaries
        .lock()
        .ok()
        .and_then(|mut map| map.remove(&request_id));
    if let Some(reply) = reply {
        let payload = data.and_then(|text| {
            base64::engine::general_purpose::STANDARD
                .decode(text.as_bytes())
                .ok()
        });
        let _ = reply.send(payload);
    }
}

/// 向对端索取它自己的安装包。
///
/// **Rust 运行态不声明自安装包能力**(`update::pack_self()` 恒为 `None`),
/// 因此对端若是 Rust 后端会回一份无 data 的响应,这里如实报「对端未提供安装包」;
/// 若对端是 Node 后端,拿到的是 npm 包,交给 `install_tarball` 走 npm 覆盖。
pub fn request_self_binary(ops: &RuntimeOps, device_id: &str) -> Result<Vec<u8>, OpError> {
    if !ops.is_connected(device_id) {
        return Err(OpError::Failed("设备离线,无法获取安装包".to_string()));
    }
    let request_id = random_hex(8);
    let (tx, rx) = oneshot::channel::<Option<Vec<u8>>>();
    if let Ok(mut map) = ops.pending_binaries.lock() {
        map.insert(request_id.clone(), tx);
    }
    let sent = ops.send_to(
        device_id,
        ControlMessage::SelfBinaryRequest {
            request_id: request_id.clone(),
            from_device_id: ops.device_id.clone(),
            version: Some(ops.version.clone()),
            hostname: own_hostname(),
            platform: Some(syncx_api::status::platform_name().to_string()),
        },
    );
    if !sent {
        forget(&ops.pending_binaries, &request_id);
        return Err(OpError::Failed(
            "发送安装包请求失败(设备可能刚离线)".to_string(),
        ));
    }
    let payload = update::bridge(async move {
        match tokio::time::timeout(Duration::from_millis(120_000), rx).await {
            Ok(Ok(payload)) => Ok(payload),
            Ok(Err(_)) => Err("请求已被取消".to_string()),
            Err(_) => Err("对端响应超时(120s):安装包可能过大".to_string()),
        }
    })
    .map_err(OpError::Failed)?;
    payload.ok_or_else(|| {
        OpError::Failed("对端未提供安装包(对方是不提供自安装包的 Rust 运行态)".to_string())
    })
}

/// 本机不提供自安装包:按协议回一份「版本对得上但无内容」的响应。
///
/// 不谎报一个空包 —— 空 data 的语义就是「我没有」,调用方据此给出明确提示,
/// 而不是在换入阶段收到一个残缺 tgz。
pub fn answer_self_binary_request(ops: &RuntimeOps, device_id: &str, request_id: &str) {
    // `pack_self` 是本能力的唯一开关:Rust 后端恒为 `None`,即「我没有安装包」。
    // 真接上打包能力时只改那一处,这里自然跟着变。
    let packed = crate::update::pack_self();
    let sha256 = packed
        .as_ref()
        .map(|bytes| crate::update::sha256_hex(bytes))
        .unwrap_or_default();
    // wire 上走 base64(对端按同一编码解回字节),与 Node 侧一致
    let data = packed
        .map(|bytes| base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes));
    let _ = ops.send_to(
        device_id,
        ControlMessage::SelfBinaryResponse {
            request_id: request_id.to_string(),
            from_device_id: ops.device_id.clone(),
            version: ops.version.clone(),
            sha256,
            data,
            hostname: own_hostname(),
            platform: Some(syncx_api::status::platform_name().to_string()),
        },
    );
}

/// 供测试断言:摘要函数与 diff 模块共用同一实现,避免两处各算一遍。
#[allow(dead_code)]
pub fn digest_of(blocks: &[String]) -> String {
    content_digest(blocks)
}

/// 序列化封装,保证两端用同一个编码(对端反序列化依赖它)。
#[allow(dead_code)]
pub fn encode_snapshot(entries: &[SnapshotEntry]) -> Vec<u8> {
    serde_json::to_vec(entries).unwrap_or_default()
}
