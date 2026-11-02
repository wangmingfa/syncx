//! 索引条目与传输规划。对应 Node 侧 `src/index.ts` 的 `compareFileState`
//! 与 `src/plan.ts` 的 `planPath` / `buildPlan` / `buildDeltaPlan`。

use serde::{Deserialize, Serialize};

use crate::version::{compare_versions, VersionRelation, VersionVector};

/// 索引条目。字段与 Node 侧 `IndexEntry` 对齐,但只保留**纯逻辑需要**的部分:
/// `mtime` / `placeholder` 只影响落盘与宣告过滤,不参与关系判定,故留到 daemon 层。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IndexEntry {
    pub path: String,
    pub version: VersionVector,
    pub size: u64,
    pub deleted: bool,
    pub blocks: Vec<String>,
    /// CDC 视图(可选,纯附加)。判定口径必须与 Node 一致:
    /// `cdh` 与 `clens` 等长且非空才算有视图。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cdh: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clens: Option<Vec<u64>>,
}

impl IndexEntry {
    /// 该条目是否有可用的 CDC 视图。
    ///
    /// 与 Node 侧 `rowToEntry` / `decodeIndex` 的口径一致:**等长且非空**。
    /// 只判 `is_some()` 会把「一端为空数组」的坏数据当成有视图,而那种条目
    /// 会让规划按 CDC 口径去取块,块永远对不上。
    pub fn has_cdc_view(&self) -> bool {
        match (&self.cdh, &self.clens) {
            (Some(h), Some(l)) => !h.is_empty() && h.len() == l.len(),
            _ => false,
        }
    }
}

/// 单路径的状态关系,逐字对应 Node 侧 `FileStateRelation`。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileStateRelation {
    Equal,
    LocalNewer,
    RemoteNewer,
    Conflict,
}

/// 比较同一路径在本机与对端索引中的状态。
///
/// `None` 表示该侧没有这个条目 —— 与 Node 的 `undefined` 同一语义:
/// 缺席不是「空版本」,而是「一方完全没有」,一律判为另一方更新。
pub fn compare_file_state(
    local: Option<&IndexEntry>,
    remote: Option<&IndexEntry>,
) -> FileStateRelation {
    match (local, remote) {
        (None, None) => FileStateRelation::Equal,
        (None, Some(_)) => FileStateRelation::RemoteNewer,
        (Some(_), None) => FileStateRelation::LocalNewer,
        (Some(l), Some(r)) => match compare_versions(&l.version, &r.version) {
            VersionRelation::Equal => FileStateRelation::Equal,
            VersionRelation::ANewer => FileStateRelation::LocalNewer,
            VersionRelation::BNewer => FileStateRelation::RemoteNewer,
            VersionRelation::Concurrent => FileStateRelation::Conflict,
        },
    }
}

/// 单路径的收敛动作。序列化形态必须与 Node 侧 `PlanAction` 一致:folding
/// 判别字段是 `kind`,send/receive 带 `entry`,delete 不带,conflict 带 local+remote。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum PlanAction {
    Send {
        path: String,
        entry: IndexEntry,
    },
    Receive {
        path: String,
        entry: IndexEntry,
    },
    Delete {
        path: String,
    },
    Conflict {
        path: String,
        local: IndexEntry,
        remote: IndexEntry,
    },
}

impl PlanAction {
    pub fn path(&self) -> &str {
        match self {
            PlanAction::Send { path, .. }
            | PlanAction::Receive { path, .. }
            | PlanAction::Delete { path }
            | PlanAction::Conflict { path, .. } => path,
        }
    }
}

/// 单路径规划:双方一致时返回 `None`(无动作)。
///
/// 注意「更新的一方是墓碑」→ 删本地,不是把删除当内容传 —— 删除没有内容可传。
pub fn plan_path(
    path: &str,
    local: Option<&IndexEntry>,
    remote: Option<&IndexEntry>,
) -> Option<PlanAction> {
    match compare_file_state(local, remote) {
        FileStateRelation::Equal => None,
        FileStateRelation::LocalNewer => {
            let entry = local.expect("LocalNewer 必有本地条目");
            if entry.deleted {
                Some(PlanAction::Delete {
                    path: path.to_string(),
                })
            } else {
                Some(PlanAction::Send {
                    path: path.to_string(),
                    entry: entry.clone(),
                })
            }
        }
        FileStateRelation::RemoteNewer => {
            let entry = remote.expect("RemoteNewer 必有对端条目");
            if entry.deleted {
                Some(PlanAction::Delete {
                    path: path.to_string(),
                })
            } else {
                Some(PlanAction::Receive {
                    path: path.to_string(),
                    entry: entry.clone(),
                })
            }
        }
        FileStateRelation::Conflict => Some(PlanAction::Conflict {
            path: path.to_string(),
            local: local.expect("Conflict 必有本地条目").clone(),
            remote: remote.expect("Conflict 必有对端条目").clone(),
        }),
    }
}

/// **全量**索引规划:取双方并集。
///
/// 并集语义只对全量索引成立 —— 对端这条消息声明了它索引的全部内容,
/// 因此「本机有、消息里没有」确实意味着对端缺失,应当回推。
pub fn build_plan(
    local: &std::collections::BTreeMap<String, IndexEntry>,
    remote: &std::collections::BTreeMap<String, IndexEntry>,
) -> Vec<PlanAction> {
    let mut paths: Vec<&String> = local.keys().chain(remote.keys()).collect();
    paths.sort();
    paths.dedup();

    let mut actions = Vec::new();
    for path in paths {
        if let Some(action) = plan_path(path, local.get(path), remote.get(path)) {
            actions.push(action);
        }
    }
    actions
}

/// **增量**索引规划:只对消息里明确提到的路径判定。
///
/// 绝不能沿用 `build_plan` 的并集语义。增量消息只包含「本轮改动的那几条」,
/// 「本机有、消息里没有」只说明对端这轮没提它,绝不等于对端缺失。若按并集回推,
/// 两端就会交替把「对方没提到的本地条目」互推:19 条改动 → 对端回推 246 条 →
/// 本机再回推 19 条 …… 无限循环(2026-09-16 两端卡片空转、CPU 半核的事故形态),
/// 且因为每轮条目版本其实相等,全程静默:不落盘、不记历史、不打日志。
pub fn build_delta_plan(
    local: &std::collections::BTreeMap<String, IndexEntry>,
    remote: &std::collections::BTreeMap<String, IndexEntry>,
) -> Vec<PlanAction> {
    let mut paths: Vec<&String> = remote.keys().collect();
    paths.sort();

    let mut actions = Vec::new();
    for path in paths {
        if let Some(action) = plan_path(path, local.get(path), remote.get(path)) {
            actions.push(action);
        }
    }
    actions
}
