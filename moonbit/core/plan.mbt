///|
/// 索引条目与传输规划(对应 Node `src/index.ts` 的 `compareFileState` 与
/// `src/plan.ts` 的 `planPath` / `buildPlan` / `buildDeltaPlan`)。

///|
/// 索引条目。字段与 Node 侧 `IndexEntry` 对齐,但只保留**纯逻辑需要**的部分:
/// `mtime` / `placeholder` 只影响落盘与宣告过滤,不参与关系判定,故留在 daemon 层。
pub(all) struct IndexEntry {
  path : String
  version : VersionVector
  size : Int64
  deleted : Bool
  blocks : Array[String]
  /// CDC 视图(可选,纯附加)。判定口径必须与 Node 一致:
  /// `cdh` 与 `clens` 等长且非空才算有视图。
  cdh : Array[String]?
  clens : Array[Int64]?
}

///|
/// 该条目是否有可用的 CDC 视图。
///
/// 与 Node 侧 `rowToEntry` / `decodeIndex` 的口径一致:**等长且非空**。
/// 只判 `is_some()` 会把「一端为空数组」的坏数据当成有视图,而那种条目
/// 会让规划按 CDC 口径去取块,块永远对不上。
pub fn IndexEntry::has_cdc_view(self : IndexEntry) -> Bool {
  match (self.cdh, self.clens) {
    (Some(h), Some(l)) => h.length() > 0 && h.length() == l.length()
    _ => false
  }
}

///|
/// 单路径的状态关系,逐字对应 Node 侧 `FileStateRelation`。
#derive(Eq)
pub(all) enum FileStateRelation {
  Equal
  LocalNewer
  RemoteNewer
  Conflict
}

///|
pub extend FileStateRelation with Eq::{equal, not_equal}

///|
/// 比较同一路径在本机与对端索引中的状态。
///
/// `None` 表示该侧没有这个条目 —— 与 Node 的 `undefined` 同一语义:
/// 缺席不是「空版本」,而是「一方完全没有」,一律判为另一方更新。
pub fn compare_file_state(
  local_entry : IndexEntry?,
  remote_entry : IndexEntry?,
) -> FileStateRelation {
  match (local_entry, remote_entry) {
    (None, None) => Equal
    (None, Some(_)) => RemoteNewer
    (Some(_), None) => LocalNewer
    (Some(l), Some(r)) =>
      match compare_versions(l.version, r.version) {
        Equal => Equal
        ANewer => LocalNewer
        BNewer => RemoteNewer
        Concurrent => Conflict
      }
  }
}

///|
/// 单路径的收敛动作。判别口径与 Node 侧 `PlanAction` 的 `kind` 字段一致:
/// send/receive 带 `entry`,delete 不带,conflict 带两侧条目。
pub(all) enum PlanAction {
  Send(path~ : String, entry~ : IndexEntry)
  Receive(path~ : String, entry~ : IndexEntry)
  Delete(path~ : String)
  Conflict(
    path~ : String,
    local_entry~ : IndexEntry,
    remote_entry~ : IndexEntry
  )
}

///|
pub fn PlanAction::path(self : PlanAction) -> String {
  match self {
    Send(path=p, ..) => p
    Receive(path=p, ..) => p
    Delete(path=p) => p
    Conflict(path=p, ..) => p
  }
}

///|
pub fn PlanAction::kind(self : PlanAction) -> String {
  match self {
    Send(_) => "send"
    Receive(_) => "receive"
    Delete(_) => "delete"
    Conflict(_) => "conflict"
  }
}

///|
/// 单路径规划:双方一致时返回 `None`(无动作)。
///
/// 注意「更新的一方是墓碑」→ 删本地,不是把删除当内容传 —— 删除没有内容可传。
pub fn plan_path(
  path : String,
  local_entry : IndexEntry?,
  remote_entry : IndexEntry?,
) -> PlanAction? {
  match compare_file_state(local_entry, remote_entry) {
    Equal => None
    LocalNewer => {
      let entry = match local_entry {
        Some(e) => e
        None => return None // LocalNewer 必有本地条目
      }
      if entry.deleted {
        Some(Delete(path~))
      } else {
        Some(Send(path~, entry~))
      }
    }
    RemoteNewer => {
      let entry = match remote_entry {
        Some(e) => e
        None => return None // RemoteNewer 必有对端条目
      }
      if entry.deleted {
        Some(Delete(path~))
      } else {
        Some(Receive(path~, entry~))
      }
    }
    Conflict => {
      let l = match local_entry {
        Some(e) => e
        None => return None
      }
      let r = match remote_entry {
        Some(e) => e
        None => return None
      }
      Some(Conflict(path~, local_entry=l, remote_entry=r))
    }
  }
}

///|
/// **全量**索引规划:取双方并集。
///
/// 并集语义只对全量索引成立 —— 对端这条消息声明了它索引的全部内容,
/// 因此「本机有、消息里没有」确实意味着对端缺失,应当回推。
pub fn build_plan(
  local_index : Map[String, IndexEntry],
  remote_index : Map[String, IndexEntry],
) -> Array[PlanAction] {
  let paths : Array[String] = []
  for p, _ in local_index {
    paths.push(p)
  }
  for p, _ in remote_index {
    if !local_index.contains(p) {
      paths.push(p)
    }
  }
  paths.sort()
  let actions : Array[PlanAction] = []
  for path in paths {
    match plan_path(path, local_index.get(path), remote_index.get(path)) {
      Some(action) => actions.push(action)
      None => ()
    }
  }
  actions
}

///|
/// **增量**索引规划:只对消息里明确提到的路径判定。
///
/// 绝不能沿用 `build_plan` 的并集语义。增量消息只包含「本轮改动的那几条」,
/// 「本机有、消息里没有」只说明对端这轮没提它,绝不等于对端缺失。若按并集回推,
/// 两端就会交替把「对方没提到的本地条目」互推:19 条改动 → 对端回推 246 条 →
/// 本机再回推 19 条 …… 无限循环(2026-09-16 两端卡片空转、CPU 半核的事故形态),
/// 且因为每轮条目版本其实相等,全程静默:不落盘、不记历史、不打日志。
pub fn build_delta_plan(
  local_index : Map[String, IndexEntry],
  remote_index : Map[String, IndexEntry],
) -> Array[PlanAction] {
  let paths : Array[String] = []
  for p, _ in remote_index {
    paths.push(p)
  }
  paths.sort()
  let actions : Array[PlanAction] = []
  for path in paths {
    match plan_path(path, local_index.get(path), remote_index.get(path)) {
      Some(action) => actions.push(action)
      None => ()
    }
  }
  actions
}
