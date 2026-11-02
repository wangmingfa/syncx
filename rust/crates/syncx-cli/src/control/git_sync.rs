//! Git 提交同步的出站侧:本机新提交广播、替别人中继、逐目标补投与回执结算。
//!
//! 对应 Node `src/session-manager.ts` 的 `checkGitCommits` / `broadcastGitCommit` /
//! `relayGitCommitNotify` / `retryGitCommitRelays` / `retryGitCommitBroadcasts` /
//! `onGitCommitAck`。口径必须逐条对齐,否则两端混跑时会出现「内容同步了、提交少一笔」。
//!
//! 三个刻意的取舍:
//!
//!  1. **本地写成功不等于送达。** 通知发出后目标一律留在台账里等回执,离线不消耗
//!     重发次数;写成功却总不回执的设备(旧版本对端不认识 `git-commit-notify`)到上限
//!     单独摘除,绝不无限重发。
//!  2. **基线照常推进,不冻住等全离线。** 送达保证交给回执台账;旧做法「冻基线等重试」
//!     只要有一个对端在线就会把基线推走,其余离线对端永久收不到(2026-09-28 实测)。
//!  3. **台账落盘。** daemon 重启后靠配置里的 `gitBroadcastPending` / `gitRelayPending`
//!     接着补投;重发计数只在内存,重启多给几次机会无害。

use std::path::Path;

use syncx_api::config::Config;

use super::{GitLedger, GitNotice, RuntimeOps};

/// 本地写成功后仍未回执的最大重发次数(与 Node `GIT_NOTIFY_MAX_RESENDS` 同值)。
pub const GIT_NOTIFY_MAX_RESENDS: u32 = 5;

/// 一次补投的结果。
struct PushOutcome {
    /// 仍需等回执的目标。
    pending: Vec<String>,
    /// 重发次数耗尽、放弃的目标。
    dropped: Vec<String>,
    /// 这一轮真的写进通道的目标。
    sent: Vec<String>,
}

/// 逐目标补投一份通知。
///
/// `send_to` 返回 `false` 就当作「够不着」:目标留着,不消耗重发次数 —— 它回来时
/// 补投,这正是「内容同步了、提交少一笔」的解药。
fn push_targets(
    ops: &RuntimeOps,
    notice: &GitNotice,
    folder_id: &str,
    targets: &[String],
    attempts: &mut std::collections::HashMap<String, u32>,
) -> PushOutcome {
    let mut pending = Vec::new();
    let mut dropped = Vec::new();
    let mut sent = Vec::new();
    for device_id in targets {
        if !ops.send_to(device_id, notice.to_message(folder_id)) {
            pending.push(device_id.clone());
            continue;
        }
        sent.push(device_id.clone());
        let tries = attempts.get(device_id).copied().unwrap_or(0) + 1;
        attempts.insert(device_id.clone(), tries);
        if tries >= GIT_NOTIFY_MAX_RESENDS {
            dropped.push(device_id.clone());
        } else {
            pending.push(device_id.clone());
        }
    }
    PushOutcome {
        pending,
        dropped,
        sent,
    }
}

/// 该目录此刻是否仍在发送(`send` / `full`)。
fn sends(mode: Option<&str>) -> bool {
    matches!(mode, Some("send") | Some("full"))
}

/// 目录身份指纹坏掉时跳过本轮:HEAD 读数来自「可能被换掉的盘」,
/// 拿去广播等于替错误内容背书。判据与 Node `gitBlockedByIdentity` 一致。
fn blocked_by_identity(folder: &syncx_api::config::SharedFolder) -> bool {
    matches!(
        syncx_api::mutate::folder_identity_verdict(folder),
        "missing" | "changed" | "remounted"
    )
}

/* ------------------------------ 本机新提交 ------------------------------ */

/// 检测各目录 HEAD 变化并广播给其余共享设备。
///
/// 由 [`RuntimeOps::flush_git_notices`] 在结算之后调用;节流到与 Node 一致的 5s
/// (它挂在 500ms 的排空节拍上,而 `git rev-parse` / `git log` 要起子进程)。
pub fn check_local_commits(ops: &RuntimeOps, config: &Config, now: i64) {
    {
        let mut state = match ops.git_state.lock() {
            Ok(state) => state,
            Err(_) => return,
        };
        if now - state.checked_at < super::git::GIT_COMMIT_CHECK_INTERVAL_MS {
            return;
        }
        state.checked_at = now;
    }
    if config.is_paused() {
        return;
    }
    for folder in &config.shared_folders {
        let folder_id = folder.folder_id();
        if folder.is_paused() || blocked_by_identity(folder) {
            continue;
        }
        let mode = folder.git_sync.as_deref();
        if !sends(mode) {
            continue;
        }
        let root = Path::new(&folder.path);
        if !crate::git::is_git_repo(root) {
            // 不是仓库:清掉陈旧基线,免得日后重建仓库时拿旧哈希去比对
            ops.set_git_baseline(&folder_id, None);
            continue;
        }
        let Some(current_hash) = crate::git::get_last_commit_hash(root) else {
            continue;
        };
        let Some(baseline) = ops.git_baseline(&folder_id) else {
            // 无基线(首次启用 / 重启后配置里没有):只记录基线,不广播。
            // 这是「绝不重放历史提交」的兜底 —— 首次启用就把整段历史推出去才是真灾难。
            ops.set_git_baseline(&folder_id, Some(current_hash));
            continue;
        };
        if current_hash == baseline {
            continue;
        }
        if let Some(info) = crate::git::get_commit_info(root, &baseline, &current_hash) {
            broadcast(ops, folder, &folder_id, &info);
        }
        // 基线照常在检测当轮推进:送达保证已经交给回执台账。
        ops.set_git_baseline(&folder_id, Some(current_hash));
    }
}

/// 向目录的每一台对端广播一笔本机提交,并把名单原样记入待回执台账。
fn broadcast(
    ops: &RuntimeOps,
    folder: &syncx_api::config::SharedFolder,
    folder_id: &str,
    info: &crate::git::CommitInfo,
) {
    let notice = GitNotice {
        from_device_id: ops.device_id.clone(),
        commit_hash: info.hash.clone(),
        commit_message: info.full_message.clone(),
        changed_files: info.changed_files.clone(),
        diff_stat: info.diff_stat.clone(),
        commit_subjects: Some(info.commit_subjects.clone()),
        parent_hash: info.parent_hash.clone(),
        via_device_id: None,
    };
    let targets = folder.devices.clone();
    let mut attempts = std::collections::HashMap::new();
    let outcome = if targets.is_empty() {
        PushOutcome {
            pending: Vec::new(),
            dropped: Vec::new(),
            sent: Vec::new(),
        }
    } else {
        push_targets(ops, &notice, folder_id, &targets, &mut attempts)
    };
    let ledger = if outcome.pending.is_empty() {
        None
    } else {
        Some(GitLedger {
            notice: notice.clone(),
            targets: outcome.pending.clone(),
            attempts,
        })
    };
    ops.set_git_ledger(folder_id, "broadcast", ledger);
    let hash8: String = info.hash.chars().take(8).collect();
    tracing::info!(
        "git commit broadcast: {folder_id} {hash8} \"{}\" ({} 个文件)",
        info.message,
        info.changed_files.len()
    );
    if !outcome.pending.is_empty() {
        tracing::info!(
            "git commit awaiting ack: {folder_id} {hash8} ({})",
            outcome.pending.join(", ")
        );
    }
    if !outcome.dropped.is_empty() {
        tracing::warn!(
            "git commit broadcast abandoned: {folder_id} {hash8} (no ack from {} after {GIT_NOTIFY_MAX_RESENDS} resend(s); peer may run an old version without git-commit-ack)",
            outcome.dropped.join(", ")
        );
    }
}

/* ------------------------------ 中继 ------------------------------ */

/// 把一笔对端提交通知**原样**中继给本机该目录的其余对端(不含通知来源)。
///
/// 只在镜像提交真的成功之后调用 —— 这正是链路不成环的原因:一笔提交每经一台真正
/// 落了提交的设备才多走一跳;回到提交者自己(或任何内容已齐的设备)时工作树必然干净,
/// 走跳过分支不再提交,也就不会再转发。
pub fn relay_notice(ops: &RuntimeOps, folder_id: &str, notice: &GitNotice) {
    let config = ops.store.load();
    let Some(folder) = config.folder(folder_id).cloned() else {
        return;
    };
    // `receive` 只进不出:这种模式的设备不向对端发任何 git 提交消息,中继也不破例
    if folder.git_sync.as_deref() != Some("full") {
        return;
    }
    let targets: Vec<String> = folder
        .devices
        .iter()
        .filter(|device| {
            **device != notice.from_device_id
                && Some(device.as_str()) != notice.via_device_id.as_deref()
        })
        .cloned()
        .collect();
    if targets.is_empty() {
        ops.set_git_ledger(folder_id, "relay", None);
        return;
    }
    let mut attempts = std::collections::HashMap::new();
    let outcome = push_targets(ops, notice, folder_id, &targets, &mut attempts);
    let ledger = if outcome.pending.is_empty() {
        None
    } else {
        Some(GitLedger {
            notice: notice.clone(),
            targets: outcome.pending.clone(),
            attempts,
        })
    };
    ops.set_git_ledger(folder_id, "relay", ledger);
    let hash8: String = notice.commit_hash.chars().take(8).collect();
    if !outcome.sent.is_empty() {
        tracing::info!(
            "git commit relayed: {folder_id} {hash8} -> {} (awaiting ack)",
            outcome.sent.join(", ")
        );
    }
    let offline: Vec<&String> = targets
        .iter()
        .filter(|device| !outcome.sent.contains(device))
        .collect();
    if !offline.is_empty() {
        let list: Vec<&str> = offline.iter().map(|d| d.as_str()).collect();
        tracing::info!(
            "git commit relay deferred: {folder_id} {hash8} (offline: {}, retry next scan)",
            list.join(", ")
        );
    }
    if !outcome.dropped.is_empty() {
        tracing::warn!(
            "git commit relay abandoned: {folder_id} {hash8} (no ack from {} after {GIT_NOTIFY_MAX_RESENDS} resend(s); peer may run an old version without git-commit-ack)",
            outcome.dropped.join(", ")
        );
    }
}

/* ------------------------------ 补投 ------------------------------ */

/// 补投上一轮没拿到回执的中继(对端当时离线、握手未完,或写了却没真正送到),
/// 含 daemon 重启前留在配置里的那笔。
pub fn retry_relays(ops: &RuntimeOps, config: &Config) {
    if config.is_paused() {
        return;
    }
    let pending: Vec<(String, GitLedger)> = match ops.git_state.lock() {
        Ok(state) => state
            .relay
            .iter()
            .map(|(id, ledger)| (id.clone(), ledger.clone()))
            .collect(),
        Err(_) => return,
    };
    for (folder_id, ledger) in pending {
        let Some(folder) = config.folder(&folder_id).cloned() else {
            ops.set_git_ledger(&folder_id, "relay", None);
            continue;
        };
        // 模式被改成 receive/off,或这些目标已不再共享该目录:台账作废,绝不越权外发
        let live: Vec<String> = ledger
            .targets
            .iter()
            .filter(|device| {
                folder.devices.contains(device) && **device != ledger.notice.from_device_id
            })
            .cloned()
            .collect();
        if folder.git_sync.as_deref() != Some("full") || live.is_empty() {
            ops.set_git_ledger(&folder_id, "relay", None);
            let hash8: String = ledger.notice.commit_hash.chars().take(8).collect();
            tracing::info!("git commit relay dropped: {folder_id} {hash8}");
            continue;
        }
        if folder.is_paused() {
            continue;
        }
        let mut attempts = ledger.attempts.clone();
        let outcome = push_targets(ops, &ledger.notice, &folder_id, &live, &mut attempts);
        if outcome.sent.is_empty() {
            // 一台都够不着:静等下一轮,不刷屏(台账已落盘,重启也丢不掉)
            continue;
        }
        ops.set_git_ledger(
            &folder_id,
            "relay",
            if outcome.pending.is_empty() {
                None
            } else {
                Some(GitLedger {
                    notice: ledger.notice.clone(),
                    targets: outcome.pending.clone(),
                    attempts,
                })
            },
        );
        let hash8: String = ledger.notice.commit_hash.chars().take(8).collect();
        if !outcome.dropped.is_empty() {
            tracing::warn!(
                "git commit relay abandoned: {folder_id} {hash8} (no ack from {} after {GIT_NOTIFY_MAX_RESENDS} resend(s))",
                outcome.dropped.join(", ")
            );
        }
        tracing::info!(
            "git commit relay resent: {folder_id} {hash8} ({})",
            if outcome.pending.is_empty() {
                "no target left".to_string()
            } else {
                format!("awaiting ack: {}", outcome.pending.join(", "))
            }
        );
    }
}

/// 补投本机出站广播里还没拿到回执的那笔提交(逐目标)。规则与中继补投同形:
/// 模式已不再发送、目标已不再共享该目录 → 台账作废;暂停期间按住不投(恢复即续);
/// 目标全部离线时静默等待,**不放弃** —— 这笔提交可能再也没有下一笔来带走它。
pub fn retry_broadcasts(ops: &RuntimeOps, config: &Config) {
    if config.is_paused() {
        return;
    }
    let pending: Vec<(String, GitLedger)> = match ops.git_state.lock() {
        Ok(state) => state
            .broadcast
            .iter()
            .map(|(id, ledger)| (id.clone(), ledger.clone()))
            .collect(),
        Err(_) => return,
    };
    for (folder_id, ledger) in pending {
        let Some(folder) = config.folder(&folder_id).cloned() else {
            ops.set_git_ledger(&folder_id, "broadcast", None);
            continue;
        };
        let live: Vec<String> = ledger
            .targets
            .iter()
            .filter(|device| folder.devices.contains(device))
            .cloned()
            .collect();
        if !sends(folder.git_sync.as_deref()) || live.is_empty() {
            ops.set_git_ledger(&folder_id, "broadcast", None);
            let hash8: String = ledger.notice.commit_hash.chars().take(8).collect();
            tracing::info!(
                "git commit broadcast dropped: {folder_id} {hash8} (gitSync no longer sends or no shared target left)"
            );
            continue;
        }
        if folder.is_paused() {
            continue;
        }
        let mut attempts = ledger.attempts.clone();
        let outcome = push_targets(ops, &ledger.notice, &folder_id, &live, &mut attempts);
        if outcome.sent.is_empty() {
            continue;
        }
        ops.set_git_ledger(
            &folder_id,
            "broadcast",
            if outcome.pending.is_empty() {
                None
            } else {
                Some(GitLedger {
                    notice: ledger.notice.clone(),
                    targets: outcome.pending.clone(),
                    attempts,
                })
            },
        );
        let hash8: String = ledger.notice.commit_hash.chars().take(8).collect();
        if !outcome.dropped.is_empty() {
            tracing::warn!(
                "git commit broadcast abandoned: {folder_id} {hash8} (no ack from {} after {GIT_NOTIFY_MAX_RESENDS} resend(s))",
                outcome.dropped.join(", ")
            );
        }
        tracing::info!(
            "git commit broadcast resent: {folder_id} {hash8} ({})",
            if outcome.pending.is_empty() {
                "no target left".to_string()
            } else {
                format!("awaiting ack: {}", outcome.pending.join(", "))
            }
        );
    }
}

/* ------------------------------ 回执 ------------------------------ */

/// 收到投递回执:从对应台账里摘掉这台设备。
///
/// 两个槽(出站广播 `broadcast`、替别人中继 `relay`)都按 `(folderId, commitHash)`
/// 认领台账,而同一目录的同一哈希只可能出自一处 —— 自己提交的不会出现在转发槽里。
/// 所以逐个槽匹配、命中即摘。哈希与台账不符 = 陈旧回执(新的一笔已覆盖旧的那笔),忽略。
pub fn on_git_commit_ack(
    ops: &RuntimeOps,
    folder_id: &str,
    commit_hash: &str,
    from_device_id: &str,
) {
    for slot in ["broadcast", "relay"] {
        let next = {
            let state = match ops.git_state.lock() {
                Ok(state) => state,
                Err(_) => return,
            };
            let table = if slot == "relay" {
                &state.relay
            } else {
                &state.broadcast
            };
            let Some(ledger) = table.get(folder_id) else {
                continue;
            };
            if ledger.notice.commit_hash != commit_hash {
                continue;
            }
            let targets: Vec<String> = ledger
                .targets
                .iter()
                .filter(|device| device.as_str() != from_device_id)
                .cloned()
                .collect();
            if targets.len() == ledger.targets.len() {
                // 这台设备不在该槽名单里
                continue;
            }
            if targets.is_empty() {
                None
            } else {
                Some(GitLedger {
                    notice: ledger.notice.clone(),
                    targets,
                    attempts: ledger.attempts.clone(),
                })
            }
        };
        ops.set_git_ledger(folder_id, slot, next.clone());
        let hash8: String = commit_hash.chars().take(8).collect();
        match next {
            Some(ledger) => tracing::info!(
                "git commit {slot} acked by {from_device_id}: {folder_id} {hash8} (awaiting ack: {})",
                ledger.targets.join(", ")
            ),
            None => tracing::info!(
                "git commit {slot} acked by {from_device_id}: {folder_id} {hash8}"
            ),
        }
    }
    ops.notify_hub();
}
