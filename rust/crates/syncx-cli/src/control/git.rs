//! Git 域的装配实现。
//!
//! 十个方法全部是「按目录跑 git」的薄包装,真正的判定在 [`crate::git`]。
//! 这里只负责三件事:
//!
//!  * **不是仓库就回 `Null`**。路由据此给出 `{gitRepo:false}`,前端隐藏入口 ——
//!    回一个空对象会让前端把「不是仓库」画成「仓库但干净」。
//!  * **目录不在配置里就报错**。`共享目录不存在(可能刚被移除)` 与 Node 同文案,
//!    它在热重载与请求之间的窗口里是真实会发生的情况。
//!  * **推送重入闸**。前端按目录顺序循环调用,两次点击同时到达时后到者必须被挡住,
//!    否则两条 `git push` 会互相抢 index.lock。

use std::path::Path;
use std::sync::atomic::Ordering;

use serde_json::{json, Value};

use syncx_api::deps::OpError;

use crate::git as gitcmd;
use crate::update;

use super::RuntimeOps;

/// 自动提交失败后的最大尝试次数(与 Node `GIT_AUTO_COMMIT_MAX_ATTEMPTS` 同值)。
pub const GIT_AUTO_COMMIT_MAX_ATTEMPTS: u32 = 5;
/// 两次自动提交尝试之间的退避(60s)。
pub const GIT_AUTO_COMMIT_RETRY_MS: i64 = 60_000;
/// 本地新提交检测的最小间隔。Node 把它挂在 5 秒的扫描节拍上;本模块的入口是
/// 500ms 的排空节拍,因此自带一份同值节流,免得每 500ms 起一次 `git rev-parse`。
pub const GIT_COMMIT_CHECK_INTERVAL_MS: i64 = 5_000;

/// 从配置里取目录根。目录不存在一律报同一句话。
fn folder_root(ops: &RuntimeOps, folder_id: &str) -> Result<std::path::PathBuf, OpError> {
    ops.store
        .load()
        .folder(folder_id)
        .map(|folder| std::path::PathBuf::from(&folder.path))
        .ok_or_else(|| OpError::Failed("共享目录不存在(可能刚被移除)".to_string()))
}

/// 工作区的未提交变更。`Null` = 不是 git 仓库。
pub fn changes(ops: &RuntimeOps, folder_id: &str) -> Result<Value, OpError> {
    let root = folder_root(ops, folder_id)?;
    match gitcmd::get_uncommitted_changes(&root) {
        None => Ok(Value::Null),
        Some((entries, truncated)) => Ok(json!({
            "entries": entries.iter().map(|entry| entry.to_json()).collect::<Vec<_>>(),
            "truncated": truncated,
        })),
    }
}

/// 工作区某文件「改动前 → 现在」。读失败如实带上原因,不谎报缺失。
pub fn diff(ops: &RuntimeOps, folder_id: &str, rel_path: &str) -> Result<Value, OpError> {
    let root = folder_root(ops, folder_id)?;
    // `git show` 不经 resolve_share_path,这里必须自己把好这道门
    assert_safe_rel_path(rel_path)?;
    let head = match gitcmd::read_file_at_head(&root, rel_path) {
        crate::git::HeadRead::Absent => json!({ "exists": false }),
        crate::git::HeadRead::Error(error) => json!({ "exists": false, "error": error }),
        crate::git::HeadRead::Bytes(bytes) => side_from_bytes(rel_path, &bytes),
    };
    let folder = ops
        .store
        .load()
        .folder(folder_id)
        .cloned()
        .ok_or_else(|| OpError::Failed("共享目录不存在(可能刚被移除)".to_string()))?;
    Ok(json!({
        "path": rel_path,
        "head": head,
        "worktree": super::compare::read_local_file_for_compare(&folder, rel_path, false),
    }))
}

/// 最近提交历史。`Null` = 不是 git 仓库。
pub fn log(ops: &RuntimeOps, folder_id: &str) -> Result<Value, OpError> {
    let root = folder_root(ops, folder_id)?;
    match gitcmd::list_recent_commits(&root, gitcmd::GIT_LOG_LIMIT).map_err(OpError::Failed)? {
        None => Ok(Value::Null),
        Some(commits) => Ok(Value::Array(
            commits.iter().map(|commit| commit.to_json()).collect(),
        )),
    }
}

/// 某笔提交动了哪些文件。`Null` = 不是 git 仓库。
pub fn commit_files(ops: &RuntimeOps, folder_id: &str, hash: &str) -> Result<Value, OpError> {
    let root = folder_root(ops, folder_id)?;
    if !gitcmd::is_commit_hash(hash) {
        return Err(OpError::Failed("非法的提交哈希".to_string()));
    }
    if !gitcmd::is_git_repo(&root) {
        return Ok(Value::Null);
    }
    let files = gitcmd::list_commit_files(&root, hash).map_err(commit_lookup_error)?;
    Ok(Value::Array(
        files.iter().map(|file| file.to_json()).collect(),
    ))
}

/// 某笔提交里某文件的「上一版 → 该提交」。左侧取首父提交,根提交没有父 → 缺失。
pub fn commit_diff(
    ops: &RuntimeOps,
    folder_id: &str,
    hash: &str,
    rel_path: &str,
    orig_path: Option<&str>,
) -> Result<Value, OpError> {
    let root = folder_root(ops, folder_id)?;
    if !gitcmd::is_commit_hash(hash) {
        return Err(OpError::Failed("非法的提交哈希".to_string()));
    }
    if !gitcmd::is_git_repo(&root) {
        return Err(OpError::Failed("该目录不是 git 仓库".to_string()));
    }
    assert_safe_rel_path(rel_path)?;
    if let Some(orig) = orig_path {
        assert_safe_rel_path(orig)?;
    }
    let parents = gitcmd::get_commit_parents(&root, hash).map_err(commit_lookup_error)?;
    // 改名文件传 origPath:父提交里是旧路径,直读新路径会谎报「上一版没有」
    let left_path = orig_path.unwrap_or(rel_path);
    let parent = match parents.first() {
        None => json!({ "exists": false }),
        Some(parent) => match gitcmd::read_file_at(&root, parent, left_path) {
            crate::git::HeadRead::Absent => json!({ "exists": false }),
            crate::git::HeadRead::Error(error) => json!({ "exists": false, "error": error }),
            crate::git::HeadRead::Bytes(bytes) => side_from_bytes(left_path, &bytes),
        },
    };
    let commit = match gitcmd::read_file_at(&root, hash, rel_path) {
        crate::git::HeadRead::Absent => json!({ "exists": false }),
        crate::git::HeadRead::Error(error) => json!({ "exists": false, "error": error }),
        crate::git::HeadRead::Bytes(bytes) => side_from_bytes(rel_path, &bytes),
    };
    Ok(json!({ "path": rel_path, "parent": parent, "commit": commit }))
}

/// 尚未推送到上游的提交。只列**此刻确实有未推送提交**的目录。
pub fn unpushed(ops: &RuntimeOps, folder_id: Option<&str>) -> Result<Value, OpError> {
    let config = ops.store.load();
    let folders: Vec<syncx_api::config::SharedFolder> = match folder_id {
        Some(id) => {
            let folder = config
                .folder(id)
                .cloned()
                .ok_or_else(|| OpError::Failed("共享目录不存在(可能刚被移除)".to_string()))?;
            vec![folder]
        }
        None => config.shared_folders.clone(),
    };
    let mut out = Vec::new();
    for folder in folders {
        let root = Path::new(&folder.path);
        let Some(total) = gitcmd::count_unpushed_commits(root) else {
            continue;
        };
        if total == 0 {
            continue;
        }
        // 列表读取失败理论上与 count 同生共死,留个兜底:total 准确、列表空
        let commits =
            gitcmd::list_unpushed_commits(root, gitcmd::GIT_UNPUSHED_LIMIT).unwrap_or_default();
        out.push(json!({
            "folderId": folder.folder_id(),
            "path": folder.path,
            "total": total,
            "commits": commits.iter().map(|commit| commit.to_json()).collect::<Vec<_>>(),
            "truncated": total as usize > gitcmd::GIT_UNPUSHED_LIMIT,
        }));
    }
    Ok(Value::Array(out))
}

/// 推当前分支到它配置的上游(异步、不带 `-u`、不 fetch)。
///
/// 推完无论成败都重算未推送计数并推一次状态:徽标当场与盘上事实对齐(成功归零),
/// 不必等下一轮扫描 —— 但这一轮扫描不在这里跑,数字由下一次扫描刷新。
pub fn push(ops: &RuntimeOps, folder_id: &str) -> Result<Value, OpError> {
    if ops.git_push_running.swap(true, Ordering::SeqCst) {
        return Err(OpError::Failed("已有推送正在进行,请稍候".to_string()));
    }
    let result = (|| -> Result<Value, OpError> {
        let root = folder_root(ops, folder_id)?;
        if !gitcmd::is_git_repo(&root) {
            return Err(OpError::Failed("该目录不是 git 仓库".to_string()));
        }
        let outcome = update::bridge(async move { Ok(gitcmd::git_push_default(&root).await) })?;
        if outcome.ok {
            tracing::info!("git push ok: {folder_id}");
        } else {
            tracing::warn!(
                "git push failed: {folder_id}: {}",
                outcome.error.as_deref().unwrap_or("")
            );
        }
        ops.notify_hub();
        Ok(outcome.to_json())
    })();
    ops.git_push_running.store(false, Ordering::SeqCst);
    result
}

/// 「Git 自动提交失败」弹窗的数据源。
///
/// 锁是**现查**的(每次打开弹窗都要反映盘上事实),不使用错误文案里那一刻的路径快照;
/// 错误只认 `git-auto-commit` 这一类,别的目录错误不混进来。
pub fn auto_commit_status(ops: &RuntimeOps, folder_id: &str) -> Result<Value, OpError> {
    let root = folder_root(ops, folder_id)?;
    let state = ops.git_state.lock().ok().map(|state| {
        (
            state.pending.get(folder_id).cloned(),
            state.retry_at.get(folder_id).copied(),
            state.attempts.get(folder_id).copied().unwrap_or(0),
            state.error.get(folder_id).cloned(),
        )
    });
    let (pending, retry_at, attempts, failure) = state.unwrap_or((None, None, 0, None));
    let mut out = serde_json::Map::new();
    out.insert("pending".into(), json!(pending.is_some()));
    match &pending {
        Some(notice) => {
            out.insert(
                "commitMessage".into(),
                json!(notice.commit_message.lines().next().unwrap_or("")),
            );
            out.insert("changedFiles".into(), json!(notice.changed_files));
        }
        None => {
            out.insert("changedFiles".into(), json!([]));
        }
    }
    out.insert("attempts".into(), json!(attempts));
    out.insert("maxAttempts".into(), json!(GIT_AUTO_COMMIT_MAX_ATTEMPTS));
    if let Some(retry_at) = retry_at {
        out.insert("retryAt".into(), json!(retry_at));
    }
    // 已放弃 = 次数耗尽且没有排在后面的重试
    out.insert(
        "givenUp".into(),
        json!(attempts >= GIT_AUTO_COMMIT_MAX_ATTEMPTS && retry_at.is_none()),
    );
    if let Some(error) = failure {
        out.insert(
            "error".into(),
            json!({ "message": error.message, "ts": error.ts }),
        );
    }
    out.insert(
        "lock".into(),
        gitcmd::find_git_index_lock(&root)
            .map(|lock| lock.to_json())
            .unwrap_or(Value::Null),
    );
    Ok(Value::Object(out))
}

/// 删除残留的 `index.lock`。只删 git 指认的那一个,不接收调用方给的路径。
pub fn delete_index_lock(ops: &RuntimeOps, folder_id: &str) -> Result<Value, OpError> {
    let root = folder_root(ops, folder_id)?;
    let result = gitcmd::remove_git_index_lock(&root);
    if result.ok {
        tracing::info!(
            "git index.lock {}: {folder_id} ({})",
            if result.removed == Some(false) {
                "already gone"
            } else {
                "removed"
            },
            result.path.as_deref().unwrap_or("")
        );
    } else {
        tracing::warn!(
            "git index.lock removal failed: {folder_id}: {}",
            result.error.as_deref().unwrap_or("")
        );
    }
    ops.notify_hub();
    Ok(result.to_json())
}

/// 手动重试自动提交:清零计数与退避后立刻结算一次。
///
/// 仍走完整闸门(在途接收 / 索引交换 / 暂停),不因为「用户点的」就跳过 ——
/// 半套文件被定格正是这些闸门要防的事;被挡时如实回报「仍被延后」。
pub fn retry_auto_commit(ops: &RuntimeOps, folder_id: &str) -> Result<Value, OpError> {
    let root = folder_root(ops, folder_id)?;
    {
        let Ok(mut state) = ops.git_state.lock() else {
            return Err(OpError::Failed("提交台账不可用".to_string()));
        };
        if !state.pending.contains_key(folder_id) {
            let attempts = state.attempts.get(folder_id).copied().unwrap_or(0);
            return Ok(json!({
                "ok": false,
                "error": "没有待提交的通知",
                "attempts": attempts,
            }));
        }
        state.attempts.remove(folder_id);
        state.retry_at.remove(folder_id);
    }
    let outcome = ops.settle_git_notice(folder_id, &root);
    let (attempts, failure) = ops
        .git_state
        .lock()
        .ok()
        .map(|state| {
            (
                state.attempts.get(folder_id).copied().unwrap_or(0),
                state.error.get(folder_id).map(|e| e.message.clone()),
            )
        })
        .unwrap_or((0, None));
    match outcome {
        Ok(Some(value)) => Ok(value),
        Ok(None) => Ok(json!({
            "ok": false,
            "error": failure.unwrap_or_else(||
                "提交被延后:仍在等待在途内容收齐或对端索引交换".to_string()),
            "attempts": attempts,
        })),
        Err(error) => Ok(json!({
            "ok": false,
            "error": error.to_string(),
            "attempts": attempts,
        })),
    }
}

/// 仓库相对路径的安全闸:拒绝空串、绝对路径、反斜杠与目录穿越。
///
/// 与 `resolve_share_path` 分开写:走 git 的 `git show <rev>:<path>` 不经那道闸,
/// 路径会直接进入 rev 表达式。
fn assert_safe_rel_path(rel_path: &str) -> Result<(), OpError> {
    let bad = rel_path.is_empty()
        || rel_path.starts_with('/')
        || rel_path.contains('\\')
        || rel_path.split('/').any(|part| part == "..");
    if bad {
        return Err(OpError::Failed("非法的文件路径".to_string()));
    }
    Ok(())
}

/// rev 读取的字节 → 单侧状态。四态口径与 `readLocalFileForCompare` 对齐。
fn side_from_bytes(rel_path: &str, bytes: &[u8]) -> Value {
    if bytes.len() as u64 > syncx_core::file_kind::compare_content_limit(rel_path) {
        return json!({ "exists": true, "size": bytes.len(), "tooLarge": true });
    }
    let mut side = serde_json::Map::new();
    side.insert("exists".into(), json!(true));
    side.insert("size".into(), json!(bytes.len()));
    if let Some(map) = super::compare::describe_bytes(rel_path, bytes).as_object() {
        for (key, value) in map {
            side.insert(key.clone(), value.clone());
        }
    }
    Value::Object(side)
}

/// 把「找不到对象」类失败翻译成弹窗能懂的口径:哈希曾被列出但此刻查不到,
/// 几乎总是历史被重写(rebase/amend)或提交被回收。其余失败原样上抛。
fn commit_lookup_error(error: String) -> OpError {
    let lower = error.to_ascii_lowercase();
    let rewritten = lower.contains("bad object")
        || lower.contains("unknown revision")
        || lower.contains("ambiguous argument")
        || lower.contains("invalid object name");
    if rewritten {
        OpError::Failed("提交不存在(可能已被重写或回收)".to_string())
    } else {
        OpError::Failed(error)
    }
}
