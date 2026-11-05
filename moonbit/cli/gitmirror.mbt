///|
/// git 镜像提交循环(cli 装配层)。对应 Node session-manager.ts 的
/// onGitCommitNotify / flushPendingGitNotify / relayGitCommitNotify 通道:
///   - 收到对端 GitCommitNotify 只入队不立即提交 —— 通知走控制面,内容走
///     数据面,块没拉齐就 git add 定格的是半套文件(闸门见 flush);
///   - flush 常驻轻量循环(~2s 一拍)逐槽结算:模式闸 / 重试上限闸 /
///     暂停闸 / 在途接收与来源会话闸(60s 封顶) / 退避闸 / 干净树跳过;
///   - 镜像提交成功:回填检测基线(死循环防护)+ 记入去重集合 + 「full」
///     模式向其余对端**原样中继**(链式拓扑 A—B—C 的末端因此也能提交;
///     回到内容已齐的设备时工作树干净 → 跳过分支,链路不成环);
///   - 发送侧可靠性台账(对齐 Node gitBroadcastPending / gitRelayPending +
///     GIT_NOTIFY_MAX_RESENDS):本地提交的广播与镜像成功后的中继都按目标
///     设备记账 —— 在线即发、离线不耗次数、重连补投、ack 销账、上限放弃;
///     待回执目标落在 config.json 的 gitBroadcastPending / gitRelayPending
///     (core 字段透传),重启/热重载后从盘上恢复(attempts 只在内存)。
///   - 结算内容对齐 + 漂移台账自愈(对齐 Node 1122fbc / Rust 8767648):
///     结算把 changedFiles 按「工作树内容 vs 本机索引」拆成对齐/未对齐,只有
///     落齐的文件进镜像提交(宁缺勿错,半途内容绝不定格);未对齐的记入
///     gitDeferredMirror 漂移台账(core 字段透传,与两份待投递台账同一套
///     「内存与配置同值」不变式),结算轮尾逐文件复查,内容到齐即补一笔收敛
///     提交 —— 这些文件从此不在任何通知的 changedFiles 里,不记台账就永久
///     挂起(2026-11-04 实测残留脏文件的事故形态)。台账为空零开销。
///   - 与 Node 的差异(有意收窄,后续包):基线不落盘(重启后首轮只记基线,
///     绝不重放历史);目录身份拦阻(gitBlockedByIdentity)、git 重写闸
///     (gitRewriteRunning)与「未推送清单 UI」不做 —— 自愈与结算的闸门口径
///     因此同为「模式 + 暂停」,身份/重写闸在 MoonBit 面上尚无对应物。

///|
/// 自动重试上限(Node GIT_AUTO_COMMIT_MAX_ATTEMPTS 同值):次数用尽后停止
/// 自动重试,通知槽保留 —— 手动重试与下一条通知都还要用它。
pub const GIT_AUTO_COMMIT_MAX_ATTEMPTS : Int32 = 5

///|
/// git 通知补投上限(Node GIT_NOTIFY_MAX_RESENDS 同值):同一目标发送满
/// 这个次数仍无回执就放弃并清账 —— 「本地写成功不等于送达」,但不回 ack 的
/// 对端(旧版本/离线僵尸会话)不能无限占用台账。
pub const GIT_NOTIFY_MAX_RESENDS : Int32 = 5

///|
/// 失败退避间隔 ms(Node GIT_AUTO_COMMIT_RETRY_MS 同值):扫描/结算节拍
/// 不退避就会对持久性失败(钩子、残留锁)每拍跑一遍 git、刷一屏 WARN。
pub const GIT_AUTO_COMMIT_RETRY_MS : Int64 = 60000L

///|
/// 「交换未落定 / 来源会话不在」类挡法的封顶 ms(Node INITIAL_CATCH_UP_MAX_MS
/// 与认领保鲜期 CLAIM_IDLE_MAX_MS 的收窄合并):这类挡法没有自愈时钟,不封顶
/// 可能无限期悬着;MoonBit 的在途接收计数也无新鲜度标记,统一 60s 强推 ——
/// 60 秒纹丝不动的在途块等同死认领,照旧提交并告警(保留活性优先于等待终局)。
pub const GIT_DRAIN_CAP_MS : Int64 = 60000L

///|
/// flush 轻量循环的节拍 ms:比扫描快,通知到齐后尽快结算。
pub const MIRROR_FLUSH_PERIOD_MS : Int32 = 2000

///|
/// 去重集合容量与淘汰数(Node processedRemoteCommits 同口径:>1000 时淘
/// 最旧的 500,保留最新的一半)。
pub const PROCESSED_REMOTE_CAP : Int32 = 1000

///|
pub const PROCESSED_REMOTE_EVICT : Int32 = 500

///|
/// 对端发送闭包登记表:deviceId → 投递闭包(server 侧按入站连接、client 侧
/// 按拨号连接各自注入)。镜像中继按它寻址;生命周期跟随会话(断开即摘除)。
pub struct PeerSenders {
  priv senders : Map[String, async (@net.WireMessage) -> Bool]
}

///|
pub fn PeerSenders::new() -> PeerSenders {
  { senders: Map([]), }
}

///|
pub fn PeerSenders::register(
  self : PeerSenders,
  device_id : String,
  send : async (@net.WireMessage) -> Bool,
) -> Unit {
  self.senders.set(device_id, send)
}

///|
/// 会话撤销(断开钩子;幂等)。
pub fn PeerSenders::unregister(self : PeerSenders, device_id : String) -> Unit {
  self.senders.remove(device_id)
}

///|
/// 当前在线设备清单(观测/测试用)。
pub fn PeerSenders::devices(self : PeerSenders) -> Array[String] {
  let out : Array[String] = []
  for device, _ in self.senders {
    out.push(device)
  }
  out
}

///|
/// 尽力而为投递:无会话或写失败一律 false(中继据此记离线名单)。
pub async fn PeerSenders::send_to(
  self : PeerSenders,
  device_id : String,
  message : @net.WireMessage,
) -> Bool {
  match self.senders.get(device_id) {
    Some(send) => {
      if !(send(message) catch { _ => false }) {
        return false
      }
      true
    }
    None => false
  }
}

///|
/// drain 闸的判定(纯函数,闸门矩阵可单测)。返回:
///   - flush_now:本轮是否放行(无挡因,或封顶 60s 到点强推);
///   - reasons:挡因拼接(日志用;空串 = 未挡);
///   - blocked_since:封顶记账起点(首次挡道起算,延续既有起点)。
pub(all) struct DrainGate {
  flush_now : Bool
  reasons : String
  blocked_since : Int64?
}

///|
/// 判定依据(照 Node flushPendingGitNotify 的三类挡因,收窄为两类):
///   - in_flight > 0:该目录仍有在途接收(各会话 pending 之和)——内容还没
///     拉齐,此刻提交定格的是半套文件;
///   - source_away:通知来源那一跳的会话已不在 —— 内容可能停在半途且没人
///     观察,等它重连续上。
pub fn drain_gate(
  in_flight : Int32,
  source_away : Bool,
  blocked_since : Int64?,
  now : Int64,
) -> DrainGate {
  let reasons : Array[String] = []
  if in_flight > 0 {
    reasons.push("waiting for \{in_flight} in-flight receive(s)")
  }
  if source_away {
    reasons.push("notify source is offline")
  }
  if reasons.is_empty() {
    return { flush_now: true, reasons: "", blocked_since: None, }
  }
  let since = match blocked_since {
    Some(s) => s
    None => now
  }
  {
    flush_now: now - since >= GIT_DRAIN_CAP_MS,
    reasons: reasons.join("; "),
    blocked_since: Some(since),
  }
}

///|
/// 单目录挂起的通知槽(单笔):新通知覆盖旧槽,失败计数与退避一起归零。
/// `via` 是送达这条通知的那一跳会话设备 id(中继场景下消息署名的来源设备
/// 未必与本机直连),drain 闸用它对账「承载它的会话是否还在」。
pub(all) struct PendingGitNotify {
  notify : @net.ControlMessage
  via : String?
  mut attempts : Int32
  mut retry_at : Int64?
  mut blocked_since : Int64?
  mut warned : Bool
  /// 最近一次自动提交失败的口径与时刻(「自动提交失败」弹窗展示用;
  /// 成功/覆盖即清 —— 仅内存,重启后从空白开始,与 attempts 同口径)。
  mut last_error : String?
  mut last_error_at : Int64?
}

///|
/// 发送侧待回执台账(单目录单笔,广播/中继两条槽各一;对应 Node
/// GitCommitLedger):通知原样保存 + 仍未回执的目标设备 + 每目标尝试计数
/// (仅内存,不落盘 —— 重启后重新计数,与 Node 同口径)。`broadcast` 区分
/// 记账来源:true = 本地提交的广播槽,false = 镜像成功后的中继槽。
pub(all) struct GitCommitLedger {
  notify : @net.ControlMessage
  /// 仍未销账的目标设备(拿到 ack 即摘;全部摘除即清账)。
  mut targets : Array[String]
  /// deviceId → 已发送次数(含首次投递;达到 GIT_NOTIFY_MAX_RESENDS 放弃)。
  mut attempts : Map[String, Int32]
  broadcast : Bool
}

///|
/// 一次按目标清单投递的结果(日志与落盘判断用):sent = 在线且写成功,
/// offline = 无会话或写失败(离线不耗次数,继续挂账),dropped = 达到重发
/// 上限被放弃(不再挂账)。
pub(all) struct PushOutcome {
  sent : Array[String]
  offline : Array[String]
  dropped : Array[String]
}

///|
/// 镜像提交结算时「内容尚未落齐」文件的漂移台账(**仅本机使用,不进 wire、
/// 不跨设备对齐**;与 Node `GitDeferredMirrorRecord` / Rust `GitDeferredMirror`
/// 同一份落盘契约,字段名不得改)。
///
/// 镜像提交按范围收敛只 stage 通知宣称的文件,而其中内容尚未与本机索引对齐的
/// 部分不能一并定格(宁缺勿错,见 daemon 的 work_tree_content_aligned);它们
/// 记入本台账,由结算轮尾的自愈(heal_deferred)在内容到齐后补一笔收敛提交。
/// 落盘同 gitRelayPending / gitBroadcastPending 的「内存与配置同值」口径:
/// daemon 重启后台账还在,漂移文件不会因为重启而永远没人提交。
pub(all) struct GitDeferredMirror {
  /// 来源通知的提交哈希(供收敛提交信息与日志)。
  hash : String
  /// 来源通知的原始提交消息(供收敛提交信息与日志)。
  message : String
  /// 尚未对齐、等待内容到齐后补提交的相对路径('/' 分隔,与索引同形)。
  files : Array[String]
}

///|
/// git 镜像循环主体:配置供应者(每次 flush 现读 —— 配置热重载下模式/
/// 共享名单/剔除开关即插即拔)+ 会话注册表(drain 闸对账)+ 发送闭包表
/// (中继)+ actor 句柄(基线回填与在途接收读数)+ 去重集合。
pub struct GitMirror {
  priv config_of : () -> @core.Config
  /// 配置文件路径(台账持久化:load → 改目录的 pending 位 → 原子写回)。
  priv config_file : String
  priv registry : PeerSessionRegistry
  priv senders : PeerSenders
  priv handle : @daemon.ActorHandle
  /// 已处理过的远端提交哈希(Node processedRemoteCommits):入队时登记,
  /// 结算前同一通知重达只算一次;镜像成功的新哈希也记入(回声兜底)。
  priv processed : Map[String, Bool]
  /// folder_id → 挂起通知槽(单笔)。
  priv slots : Map[String, PendingGitNotify]
  /// folder_id → 广播台账(本地提交;本地检测回调经 entry 装配注入)。
  priv broadcast_ledger : Map[String, GitCommitLedger]
  /// folder_id → 中继台账(镜像成功后向其余对端转发)。
  priv relay_ledger : Map[String, GitCommitLedger]
  /// folder_id → 漂移台账(结算后「内容尚未落齐」的欠账;每拍结算轮尾自愈)。
  priv deferred : Map[String, GitDeferredMirror]
  /// 已收未销的投递回执:handle_peer_message 是同步回调,而销账要异步落盘
  /// —— 先入此队列,flush 每拍开头统一结算(单线程 async 下无锁)。
  priv mut acks : Array[(String, String, String)]
}

///|
pub fn GitMirror::new(
  config_of~ : () -> @core.Config,
  config_file~ : String,
  registry~ : PeerSessionRegistry,
  senders~ : PeerSenders,
  handle~ : @daemon.ActorHandle,
) -> GitMirror {
  {
    config_of,
    config_file,
    registry,
    senders,
    handle,
    processed: Map([]),
    slots: Map([]),
    broadcast_ledger: Map([]),
    relay_ledger: Map([]),
    deferred: Map([]),
    acks: [],
  }
}

///|
/// 观测:某目录是否挂着待结算通知(测试用)。
pub fn GitMirror::has_slot(self : GitMirror, folder_id : String) -> Bool {
  self.slots.contains(folder_id)
}

///|
/// 观测:挂起通知槽的已尝试次数(无槽 = -1;测试用)。
pub fn GitMirror::slot_attempts(self : GitMirror, folder_id : String) -> Int32 {
  match self.slots.get(folder_id) {
    Some(s) => s.attempts
    None => -1
  }
}

///|
/// 观测:台账仍未销账的目标清单(None = 无台账;测试/观测用)。返回的是
/// 内部数组的引用,只读勿改。
pub fn GitMirror::ledger_targets(
  self : GitMirror,
  folder_id : String,
  broadcast~ : Bool = true,
) -> Array[String]? {
  let ledger = self.ledger_of(folder_id, broadcast~)
  match ledger {
    Some(l) => Some(l.targets)
    None => None
  }
}

///|
/// 观测:某目标已发送次数(无台账或无记录 = None;测试用)。
pub fn GitMirror::ledger_attempt_of(
  self : GitMirror,
  folder_id : String,
  device : String,
  broadcast~ : Bool = true,
) -> Int32? {
  match self.ledger_of(folder_id, broadcast~) {
    Some(l) => l.attempts.get(device)
    None => None
  }
}

///|
/// 按槽别取台账(broadcast=true 广播槽 / false 中继槽)。
fn GitMirror::ledger_of(
  self : GitMirror,
  folder_id : String,
  broadcast~ : Bool,
) -> GitCommitLedger? {
  if broadcast {
    self.broadcast_ledger.get(folder_id)
  } else {
    self.relay_ledger.get(folder_id)
  }
}

///|
/// 按槽别摘台账引用(返回内存 Map 本体,调用方读写)。
fn GitMirror::ledger_map_of(
  self : GitMirror,
  broadcast : Bool,
) -> Map[String, GitCommitLedger] {
  if broadcast {
    self.broadcast_ledger
  } else {
    self.relay_ledger
  }
}

///|
/// 观测:某目录的漂移台账(None = 无欠账;测试/观测用)。返回内存引用,
/// 只读勿改。
pub fn GitMirror::deferred_of(
  self : GitMirror,
  folder_id : String,
) -> GitDeferredMirror? {
  self.deferred.get(folder_id)
}

///|
/// 观测:去重集合大小(测试用)。
pub fn GitMirror::processed_size(self : GitMirror) -> Int32 {
  self.processed.length()
}

///|
/// 去重登记:>1000 淘最旧的 500(Map 保序,插入序即最旧序;Node 同口径)。
fn GitMirror::processed_add(self : GitMirror, hash : String) -> Unit {
  self.processed.set(hash, true)
  if self.processed.length() > PROCESSED_REMOTE_CAP {
    let stale : Array[String] = []
    for h, _ in self.processed {
      if stale.length() >= PROCESSED_REMOTE_EVICT {
        break
      }
      stale.push(h)
    }
    for h in stale {
      self.processed.remove(h)
    }
  }
}

///|
/// 按目录 id 查配置里的共享目录(现值直读:设备增删/模式改动即刻生效)。
fn GitMirror::folder_of(
  self : GitMirror,
  folder_id : String,
) -> @core.SharedFolder? {
  for folder in (self.config_of)().shared_folders {
    if folder.folder_id() == folder_id {
      return Some(folder)
    }
  }
  None
}

///|
/// 处理对端发来的 git 提交通知:**只入队,不立即提交**(闸门见 flush)。
/// 同步函数:只做配置闸与去重,不碰 git(仓库探测挪到 flush,这样入站
/// 回调保持同步、通知到了先记账)。
pub fn GitMirror::on_notify(
  self : GitMirror,
  notify : @net.ControlMessage,
  via : String?,
) -> Unit {
  let (from_id, folder_id, hash, message) = match notify {
    GitCommitNotify(
      from_device_id~,
      folder_id~,
      commit_hash~,
      commit_message~,
      ..
    ) => (from_device_id, folder_id, commit_hash, commit_message)
    _ => return
  }
  let folder = match self.folder_of(folder_id) {
    Some(f) => f
    None => {
      @log.debug("git-commit-notify for unknown folder {Folder}, ignored", [
        Json::string(folder_id),
      ])
      return
    }
  }
  // 模式闸:只接收 receive / full(Node 同口径;off/send 只出不进,静默丢弃)
  let plan = @daemon.git_sync_plan(@daemon.git_sync_mode_of(folder.git_sync))
  if !plan.auto_commit_remote {
    return
  }
  // 去重:登记在入队时 —— 结算前同一通知重达(重连补发 / 中继多跳)不应排队两次
  if self.processed.contains(hash) {
    return
  }
  self.processed_add(hash)
  // 单槽覆盖:新消息顶掉旧槽,上一笔的失败次数与退避一起归零,新消息立刻试一次
  self.slots.set(folder_id, {
    notify,
    via,
    attempts: 0,
    retry_at: None,
    blocked_since: None,
    warned: false,
    last_error: None,
    last_error_at: None,
  })
  @log.info(
    "git-commit-notify queued: {Folder} (from {Device}) \"{Subject}\"",
    [
      Json::string(folder_id),
      Json::string(from_id),
      Json::string(first_line(message)),
    ],
  )
}

///|
/// 收到投递回执(mirror 不在场的降级路径;正常路径走 GitMirror::on_git_ack
/// 入台账队列销账)。
pub fn log_git_commit_ack(
  sender : String,
  folder_id : String,
  commit_hash : String,
) -> Unit {
  @log.info("git commit acked by {Device}: {Folder} {Hash8}", [
    Json::string(sender),
    Json::string(folder_id),
    Json::string(hash8(commit_hash)),
  ])
}

///|
/// 结算全部挂起通知(flush 轻量循环每拍调用;对应 Node flushPendingGitNotify,
/// 逐槽闸门顺序与其一一对应)。目录条目在结算过程中可能被移除,先取键快照。
pub async fn GitMirror::flush(self : GitMirror) -> Unit {
  // 1) 回执销账先于补投:刚到的 ack 先摘目标,避免同一拍里对已送达设备
  //    再补投一遍(竞态无害但白费流量)。
  self.drain_acks()
  // 2) 发送侧台账补投(广播/中继):在线才发、离线不耗次数、上限放弃。
  self.retry_ledgers()
  // 3) 既有挂起通知槽结算(接收侧;闸门顺序见下)。
  let ids : Array[String] = []
  for id, _ in self.slots {
    ids.push(id)
  }
  for folder_id in ids {
    let slot = match self.slots.get(folder_id) {
      Some(s) => s
      None => continue
    }
    let (from_id, hash, message, changed, subjects) = match slot.notify {
      GitCommitNotify(
        from_device_id~,
        commit_hash~,
        commit_message~,
        changed_files~,
        commit_subjects~,
        ..
      ) =>
        (
          from_device_id, commit_hash, commit_message, changed_files, commit_subjects,
        )
      // 槽里只可能存 GitCommitNotify(on_notify 已闸),到达即弃
      _ => {
        let _ = self.slots.remove(folder_id)
        continue
      }
    }
    // 目录闸:配置里已删的目录,槽一并作废
    let folder = match self.folder_of(folder_id) {
      Some(f) => f
      None => {
        let _ = self.slots.remove(folder_id)
        continue
      }
    }
    let mode = @daemon.git_sync_mode_of(folder.git_sync)
    let plan = @daemon.git_sync_plan(mode)
    // 模式闸:off / send 只出不进 —— 通知已处理(去重集合已登记),结算即弃
    if !plan.auto_commit_remote {
      let _ = self.slots.remove(folder_id)
      continue
    }
    // 自动重试已放弃:通知还挂着,但不再由循环反复尝试 —— 留给用户手动重试,
    // 或下一条通知覆盖槽位时把计数归零(on_notify 已归零)
    if slot.attempts >= GIT_AUTO_COMMIT_MAX_ATTEMPTS {
      continue
    }
    // 暂停闸是结算的中场休息、不是挡法本身:挂起计时清零,恢复后重新起算 ——
    // 否则一次隔夜的暂停就能把 60s 封顶用光,解停后内容没续上就被强提交
    if folder.is_paused() {
      slot.warned = false
      slot.blocked_since = None
      continue
    }
    // 目录身份拦阻(gitBlockedByIdentity):TODO(cli)待接,MoonBit 暂无
    // folderIdentity 判定面。
    // 在途接收与来源会话闸:内容没拉齐不提交;60s 封顶强推(死传输自愈兜底)
    let now = @daemon.now_ms()
    let gate = drain_gate(
      self.in_flight_of(folder_id),
      self.source_away(slot.via),
      slot.blocked_since,
      now,
    )
    if !gate.flush_now {
      slot.blocked_since = gate.blocked_since
      if !slot.warned {
        slot.warned = true
        @log.info("git auto-commit deferred: {Folder} ({Reasons})", [
          Json::string(folder_id),
          Json::string(gate.reasons),
        ])
      }
      continue
    }
    if gate.reasons != "" {
      // 到点强制放行:交换/来源不像认领那样有自愈时钟,封顶到了就照旧提交并告警
      @log.warn(
        "git auto-commit flushing while catch-up unresolved: {Folder} ({Reasons}) (partial content may be committed)",
        [Json::string(folder_id), Json::string(gate.reasons)],
      )
    }
    // 上一轮尝试失败后的退避期:通知留在队列里,到点再试(循环节拍不退避就会
    // 对持久性失败每拍跑一遍 git、刷一屏 WARN)
    match slot.retry_at {
      Some(retry_at) => if now < retry_at { continue }
      None => ()
    }
    slot.warned = false
    slot.blocked_since = None
    // 非仓库:通知没法落地,弃槽(Node 在入队时闸,这里等效 —— 弃槽即不再重试)
    if !@daemon.is_git_repo(folder.path) {
      let _ = self.slots.remove(folder_id)
      @log.info("git-commit-notify ignored: {Folder} is not a git repo", [
        Json::string(folder_id),
      ])
      continue
    }
    // 工作树干净(内容早已落地并随上一笔结算提交过,或对端提交无净变更)时跳过
    // 提交,但仍把基线推到当前 HEAD:不提交就没有新哈希,基线不推进下一轮又会
    // 被「新提交检测」当成有一笔要广播的提交,白耗一次重试(死循环防护的另一半)
    if !@daemon.has_uncommitted_changes(folder.path) {
      @log.info(
        "git auto-commit skipped (nothing to commit): {Folder} (from {Device}) \"{Subject}\"",
        [
          Json::string(folder_id),
          Json::string(from_id),
          Json::string(first_line(message)),
        ],
      )
      let _ = self.slots.remove(folder_id)
      let head = @daemon.get_last_commit_hash(folder.path)
      match head {
        Some(h) => {
          let _ = self.handle.send(
            @daemon.Cmd::GitBaseline(folder=folder_id, hash=h),
          )
        }
        None => ()
      }
      continue
    }
    // ── 机制一:结算前逐文件内容对齐(宁缺勿错,对齐 Node 1122fbc)──
    // 台账排空只证明「没有在途接收」,不证明「内容已经落齐」:对端镜像提交把
    // 半途内容定格(消息对、内容错)的事故里,认领早已释放、结算闸门一路放行
    // (60s 强推),差的就是这一道内容比对。把 changedFiles 拆成两份:工作树
    // 内容与本机索引逐块一致的(或索引墓碑 + 盘上已删的)才进本次镜像提交;
    // 未对齐的不提交,记入漂移台账(gitDeferredMirror),由结算轮尾的自愈
    // (heal_deferred)在内容到齐后补提交 —— 这些文件从此不在任何通知的
    // changedFiles 里,不记台账就永久挂起。旧版对端的通知没有文件清单
    // (changedFiles 为空),无从逐文件判定,保持既有全量兜底不变。
    let mut stage_files = changed
    let deferred_files : Array[String] = []
    if changed.length() > 0 {
      let entries = self.handle.entry_lookup(folder_id, changed)
      let by_path : Map[String, @daemon.Entry] = Map([])
      for entry in entries {
        by_path.set(entry.path, entry)
      }
      let aligned : Array[String] = []
      for rel in changed {
        if @daemon.work_tree_content_aligned(folder.path, rel, by_path.get(rel)) {
          aligned.push(rel)
        } else {
          deferred_files.push(rel)
        }
      }
      stage_files = aligned
      if stage_files.is_empty() {
        // 全都不对齐:一笔也不提交 —— 半途内容绝不能被定格;但通知照常结算 +
        // 基线推进(沿用「干净工作树跳过提交但推进基线」的口径,通知本身不能
        // 卡住),剩余文件交给漂移台账的自愈。
        @log.warn(
          "git auto-commit settled without commit (no changed file content aligned with the local index): {Folder} (from {Device}) \"{Subject}\" — {N} 个文件进漂移台账: {Files}{Tail}",
          [
            Json::string(folder_id),
            Json::string(from_id),
            Json::string(first_line(message)),
            Json::number(deferred_files.length().to_double()),
            Json::string(preview_of(deferred_files)),
            Json::string(if deferred_files.length() > 10 { " …" } else { "" }),
          ],
        )
        self.record_deferred(folder_id, hash, message, deferred_files)
        let _ = self.slots.remove(folder_id)
        match @daemon.get_last_commit_hash(folder.path) {
          Some(h) => {
            let _ = self.handle.send(
              @daemon.Cmd::GitBaseline(folder=folder_id, hash=h),
            )
          }
          None => ()
        }
        continue
      }
      if deferred_files.length() > 0 {
        @log.info(
          "git mirror commit narrowed to content-aligned files: {Folder} — committing {M}, deferring {N} to the drift ledger ({Files}{Tail})",
          [
            Json::string(folder_id),
            Json::number(stage_files.length().to_double()),
            Json::number(deferred_files.length().to_double()),
            Json::string(preview_of(deferred_files)),
            Json::string(if deferred_files.length() > 10 { " …" } else { "" }),
          ],
        )
      }
    }
    slot.attempts = slot.attempts + 1
    @log.info(
      "auto-committing: {Folder} (from {Device}) \"{Subject}\" — {Files}",
      [
        Json::string(folder_id),
        Json::string(from_id),
        Json::string(first_line(message)),
        Json::string(@daemon.git_files_desc(stage_files)),
      ],
    )
    // 目录级开关 gitStripCoAuthored:开启时在组装出的最终消息上剔除
    // Co-Authored-By 尾注(缺省关闭 = 行为不变)。中继给其余对端的仍是
    // 原始通知,只有本机落库的这笔镜像提交信息被剔除。
    let mirror_message = @daemon.compose_mirror_commit_message(
      message,
      subjects.unwrap_or([]),
      strip=folder.strip_co_authored.unwrap_or(false),
    )
    // 范围收敛:只 stage 通知宣称的文件 —— 工作树里用户并发的未提交改动
    // 不属于这笔镜像提交,绝不能被 add -A 顺手打包(根治 2026-11-04 的
    // 「回声吞掉用户并发改动」事故;契约见 Node 55b1c35);机制一再此之上
    // 再按内容对齐收窄(见上),内容未落齐的文件绝不定格进提交
    let result = @daemon.auto_commit(
      folder.path,
      mirror_message,
      changed_files=stage_files,
    )
    if result.success {
      @log.info("auto-commit success: {Folder} -> {Hash8}", [
        Json::string(folder_id),
        Json::string(
          match result.hash {
            Some(h) => hash8(h)
            None => "?"
          },
        ),
      ])
      let _ = self.slots.remove(folder_id)
      // 基线推进 + 去重登记:防止扫描循环把这笔镜像提交误判为「本地新提交」
      // 再广播回去(死循环防护;cmd 由 actor 按序处理,异步但必达)
      match result.hash {
        Some(head) => {
          let _ = self.handle.send(
            @daemon.Cmd::GitBaseline(folder=folder_id, hash=head),
          )
          self.processed_add(head)
        }
        None => ()
      }
      // 镜像提交真的落成才中继:一笔提交每经一台真正落了提交的设备才多走一跳,
      // 链路因此不成环;'receive' 只进不出,不中继
      self.relay(plan, folder, from_id, slot.notify, hash)
      // 未对齐的文件进漂移台账(提交失败则不动台账:通知还挂着,下轮结算会
      // 重新判定)
      if deferred_files.length() > 0 {
        self.record_deferred(folder_id, hash, message, deferred_files)
      }
      // 本笔镜像提交已把「此前欠着、这次对齐了」的文件一并提交:从台账摘除,
      // 否则自愈会对着 HEAD 里已有的内容再补一笔空收敛提交。stage_files 为空
      // 只发生在「旧对端无清单走全量兜底」,无从对应台账文件,不摘。
      if stage_files.length() > 0 {
        match self.deferred.get(folder_id) {
          Some(ledger) => {
            let remaining : Array[String] = []
            for rel in ledger.files {
              if !stage_files.contains(rel) {
                remaining.push(rel)
              }
            }
            if remaining.length() != ledger.files.length() {
              match remaining.is_empty() {
                true => self.set_deferred(folder_id, None)
                false =>
                  self.set_deferred(
                    folder_id,
                    Some({
                      hash: ledger.hash,
                      message: ledger.message,
                      files: remaining,
                    }),
                  )
              }
            }
          }
          None => ()
        }
      }
    } else {
      let error = match result.error {
        Some(e) => e
        None => "git auto-commit failed"
      }
      @log.warn("auto-commit failed (attempt {N}/{Max}): {Folder}: {Error}", [
        Json::number(slot.attempts.to_double()),
        Json::number(GIT_AUTO_COMMIT_MAX_ATTEMPTS.to_double()),
        Json::string(folder_id),
        Json::string(error),
      ])
      slot.last_error = Some(error)
      slot.last_error_at = Some(now)
      if slot.attempts >= GIT_AUTO_COMMIT_MAX_ATTEMPTS {
        // 停止自动重试但**保留通知**:工作树依旧是脏的、这一笔仍未提交;
        // 下一条通知照旧覆盖并重置计数
        slot.retry_at = None
        @log.warn(
          "auto-commit giving up after {Max} attempts: {Folder}; notify kept for manual retry or the next commit notification",
          [
            Json::number(GIT_AUTO_COMMIT_MAX_ATTEMPTS.to_double()),
            Json::string(folder_id),
          ],
        )
      } else {
        slot.retry_at = Some(now + GIT_AUTO_COMMIT_RETRY_MS)
      }
    }
  }
  // 结算轮尾的漂移台账自愈(机制二):刻意放在结算**之后**(对齐 Node
  // 「checkGitCommits 开头、flushPendingGitNotify 之后、新提交检测之前」的
  // 次序)—— 先结算后自愈,自愈补的收敛提交再交给 actor 心跳的新提交检测
  // 正常广播,次序倒了就会把半途内容当「落齐」回弹。
  self.heal_deferred()
}

// ==================== 漂移台账(结算对齐的另一半:自愈) ====================

///|
/// 更新某目录的漂移台账并落盘(None = 台账已收敛清空)。与 relay/broadcast
/// 台账同一套「内存与配置同值」不变式:内存只由这里写入,盘上记录随每次
/// persist_ledgers 同值落盘,重启后由 adopt_pending 还原。
async fn GitMirror::set_deferred(
  self : GitMirror,
  folder_id : String,
  ledger : GitDeferredMirror?,
) -> Unit {
  match ledger {
    Some(l) => self.deferred.set(folder_id, l)
    None => {
      let _ = self.deferred.remove(folder_id)
    }
  }
  self.persist_ledgers(folder_id)
}

///|
/// 把结算时未对齐的文件并入该目录的漂移台账。多笔通知的欠账合并去重
/// (files 取并集,旧账在前),hash/message 取最新一笔 —— 台账只描述
/// 「这些内容还没提交」,收敛提交的信息引用最新的来源即可(对应 Node
/// recordGitDeferredMirror / Rust record_git_deferred_mirror)。
async fn GitMirror::record_deferred(
  self : GitMirror,
  folder_id : String,
  hash : String,
  message : String,
  files : Array[String],
) -> Unit {
  let merged : Array[String] = match self.deferred.get(folder_id) {
    Some(prev) => {
      let acc : Array[String] = []
      for rel in prev.files {
        if !acc.contains(rel) {
          acc.push(rel)
        }
      }
      for rel in files {
        if !acc.contains(rel) {
          acc.push(rel)
        }
      }
      acc
    }
    None => {
      let acc : Array[String] = []
      for rel in files {
        if !acc.contains(rel) {
          acc.push(rel)
        }
      }
      acc
    }
  }
  self.set_deferred(folder_id, Some({ hash, message, files: merged, }))
}

///|
/// 漂移台账自愈:结算后经数据面落齐/回落的内容,补一笔收敛提交(机制二)。
///
/// 镜像提交按内容对齐收窄后,未对齐的文件进了台账 —— 而它们从此不在任何通知的
/// changedFiles 里(范围收敛拒绝扫荡),没人再提交就永久脏着。这里在每轮结算
/// 轮尾逐文件复查「工作树内容 vs 本机索引」:已对齐的收集起来,非空则
/// auto_commit 一笔**本地新提交**(消息 `chore: 收敛镜像提交后到达的内容
/// (<hash8> <原消息首行>)`),成功后从台账摘除;失败只告警记日志,台账保留
/// 下轮再试 —— 不设上限次数,内容不到齐就一直脏着,反正对齐判据保证了提交
/// 内容不会错。中途叠加的暂停/模式闸与结算闸门同口径:中场休息,不自愈;
/// receive-only 目录同样自愈(只要求模式不是 off)。
///
/// 收敛提交不在这里推基线:actor 心跳(GIT_CHECK_TICKS)的新提交检测会把它
/// 当作新 HEAD 正常广播给对端 —— 对端工作树内容一致 → 对端结算走「nothing to
/// commit」跳过并推进基线,可接受(内容早已一致,只欠一笔提交记录)。链路
/// 因此不成环。台账为空时零开销(不读盘不比文件)。
async fn GitMirror::heal_deferred(self : GitMirror) -> Unit {
  if self.deferred.length() == 0 {
    return
  }
  // 键快照:自愈过程中台账可能增删(收敛摘除 / 合并)
  let ids : Array[String] = []
  for id, _ in self.deferred {
    ids.push(id)
  }
  for folder_id in ids {
    let ledger = match self.deferred.get(folder_id) {
      Some(l) => l
      None => continue
    }
    let folder = match self.folder_of(folder_id) {
      Some(f) => f
      None => {
        // 目录已被移除:欠账随目录走,不替死人收敛
        self.set_deferred(folder_id, None)
        continue
      }
    }
    // 关了 git 同步不再动它的仓库(有改档入口的后端会在改档时清台账,这里
    // 兜手改配置的底);receive-only 也自愈
    let mode = @daemon.git_sync_mode_of(folder.git_sync)
    if !mode.sends() && !mode.receives() {
      continue
    }
    // 暂停闸:中场休息(与结算同口径)
    if folder.is_paused() {
      continue
    }
    if !@daemon.is_git_repo(folder.path) {
      continue
    }
    // 逐文件复查「工作树内容 vs 本机索引」:已对齐的收集起来
    let entries = self.handle.entry_lookup(folder_id, ledger.files)
    let by_path : Map[String, @daemon.Entry] = Map([])
    for entry in entries {
      by_path.set(entry.path, entry)
    }
    let aligned : Array[String] = []
    for rel in ledger.files {
      if @daemon.work_tree_content_aligned(folder.path, rel, by_path.get(rel)) {
        aligned.push(rel)
      }
    }
    if aligned.length() == 0 {
      continue // 内容还没到齐:下轮再试(不设上限)
    }
    let heal_message = "chore: 收敛镜像提交后到达的内容 (\{hash8(ledger.hash)} \{@daemon.truncate_git_subject(first_line(ledger.message))})"
    let result = @daemon.auto_commit(
      folder.path,
      heal_message,
      changed_files=aligned,
    )
    if result.success {
      let remaining : Array[String] = []
      for rel in ledger.files {
        if !aligned.contains(rel) {
          remaining.push(rel)
        }
      }
      match remaining.is_empty() {
        true => self.set_deferred(folder_id, None)
        false =>
          self.set_deferred(
            folder_id,
            Some({
              hash: ledger.hash,
              message: ledger.message,
              files: remaining,
            }),
          )
      }
      @log.info(
        "git drift healed: {Folder} -> {Hash8} ({N} 个文件: {Files}{Tail})",
        [
          Json::string(folder_id),
          Json::string(
            match result.hash {
              Some(h) => hash8(h)
              None => "?"
            },
          ),
          Json::number(aligned.length().to_double()),
          Json::string(preview_of(aligned)),
          Json::string(if aligned.length() > 10 { " …" } else { "" }),
        ],
      )
    } else {
      let error = match result.error {
        Some(e) => e
        None => "git auto-commit failed"
      }
      @log.warn("git drift heal commit failed: {Folder}: {Error}", [
        Json::string(folder_id),
        Json::string(error),
      ])
    }
  }
}

///|
/// 该目录的在途接收总数(actor 快照里各会话 pending 之和;无该目录 = 0)。
fn GitMirror::in_flight_of(self : GitMirror, folder_id : String) -> Int32 {
  let snapshot = self.handle.snapshot()
  for status in snapshot.folders {
    if status.id == folder_id {
      return status.in_flight_receives
    }
  }
  0
}

///|
/// 通知来源那一跳的会话是否已不在(中继场景下署名来源未必与本机直连)。
fn GitMirror::source_away(self : GitMirror, via : String?) -> Bool {
  match via {
    Some(device) =>
      match self.registry.lookup(device) {
        Some(_) => false
        None => true
      }
    None => false
  }
}

///|
/// 把一笔远端提交通知**原样**中继给本机该目录的其余对端(不含通知来源)。
/// 不改写消息任何字段:fromDeviceId 仍是最初那台提交设备,commitHash 仍是
/// 它的哈希,中继设备自己的镜像哈希从头到尾不出门。中继走台账:目标记账
/// 后补投/销账/放弃与广播槽同一套(push_targets);对端已从来源直收过同一
/// 笔通知时靠 processedRemoteCommits 去重 + 干净树跳过兜底。
async fn GitMirror::relay(
  self : GitMirror,
  plan : @daemon.GitSyncPlan,
  folder : @core.SharedFolder,
  from_id : String,
  notify : @net.ControlMessage,
  hash : String,
) -> Unit {
  if !plan.relay {
    // 'receive' 只进不出:这种模式的设备不向对端发任何 git 提交消息
    return
  }
  // 目标 = 共享设备 − 通知来源(不回投来源;全部离线也记账,重连补投)
  let targets : Array[String] = []
  for device in folder.devices {
    if device != from_id {
      targets.push(device)
    }
  }
  if targets.is_empty() {
    return
  }
  let folder_id = folder.folder_id()
  let ledger : GitCommitLedger = {
    notify,
    targets,
    attempts: Map([]),
    broadcast: false,
  }
  self.relay_ledger.set(folder_id, ledger)
  let outcome = self.push_targets(folder_id, ledger)
  let h = hash8(hash)
  if outcome.sent.length() > 0 {
    @log.info("git commit relayed: {Folder} {Hash8} -> {Targets}", [
      Json::string(folder_id),
      Json::string(h),
      Json::string(outcome.sent.join(", ")),
    ])
  }
  if outcome.offline.length() > 0 {
    @log.info(
      "git commit relay deferred: {Folder} {Hash8} (offline: {Targets})",
      [
        Json::string(folder_id),
        Json::string(h),
        Json::string(outcome.offline.join(", ")),
      ],
    )
  }
  // 全部目标当场放弃(上限清零的极端:targets 只有一个且已满 5 次)或仍有
  // 挂账,都按现状落盘;挂账非空则保留台账等补投
  if ledger.targets.is_empty() {
    let _ = self.relay_ledger.remove(folder_id)
  }
  self.persist_ledgers(folder_id)
}

// ==================== 发送侧可靠性台账(补投/销账/恢复) ====================

///|
/// 本地提交的广播入口(actor 检测回调经 entry 装配注入):按该目录共享设备
/// 全量记账后投递 —— 在线即发、离线挂账等补投;对应 Node broadcastGitCommit。
/// 模式闸与本机共享目录现读:目录删除 / 不启用发送(gitSync off / receive)
/// 的提交不广播。
pub async fn GitMirror::on_local_git_notify(
  self : GitMirror,
  notify : @net.ControlMessage,
) -> Unit {
  let (folder_id, hash, message, changed) = match notify {
    GitCommitNotify(
      folder_id~,
      commit_hash~,
      commit_message~,
      changed_files~,
      ..
    ) => (folder_id, commit_hash, commit_message, changed_files)
    _ => return
  }
  let folder = match self.folder_of(folder_id) {
    Some(f) => f
    None => {
      @log.debug("git commit broadcast for unknown folder {Folder}, ignored", [
        Json::string(folder_id),
      ])
      return
    }
  }
  let plan = @daemon.git_sync_plan(@daemon.git_sync_mode_of(folder.git_sync))
  if !plan.watch_local {
    // off / receive 只进不出:不广播
    return
  }
  // 目标 = 该目录共享的全部设备(含当前离线的 —— 离线不耗次数,重连补投)
  let targets : Array[String] = []
  for device in folder.devices {
    targets.push(device)
  }
  let ledger : GitCommitLedger = {
    notify,
    targets,
    attempts: Map([]),
    broadcast: true,
  }
  self.broadcast_ledger.set(folder_id, ledger)
  let outcome = self.push_targets(folder_id, ledger)
  let h = hash8(hash)
  if outcome.sent.length() > 0 {
    @log.info(
      "git commit broadcast delivered: {Folder} {Hash8} \"{Subject}\" ({Files}) -> {Targets}",
      [
        Json::string(folder_id),
        Json::string(h),
        Json::string(first_line(message)),
        Json::string(@daemon.git_files_desc(changed)),
        Json::string(outcome.sent.join(", ")),
      ],
    )
  }
  if outcome.offline.length() > 0 {
    @log.info(
      "git commit broadcast pending (offline: {Targets}): {Folder} {Hash8}",
      [
        Json::string(outcome.offline.join(", ")),
        Json::string(folder_id),
        Json::string(h),
      ],
    )
  }
  // 目标全空(目录无共享设备)或全部当场放弃:不留台账,记录位清空
  if ledger.targets.is_empty() {
    let _ = self.broadcast_ledger.remove(folder_id)
  }
  self.persist_ledgers(folder_id)
}

///|
/// 按台账的目标清单逐台投递(对应 Node pushGitNotifyTargets):在线且写成功
/// → 计一次尝试并继续挂账等回执,达到上限即放弃;离线或写失败 → 挂账不动
/// (离线不耗次数)。返回投递结果;调用方按 targets 空否决定清账落盘。
async fn GitMirror::push_targets(
  self : GitMirror,
  folder_id : String,
  ledger : GitCommitLedger,
) -> PushOutcome {
  let wire : @net.WireMessage = @net.WireMessage::Control(payload=ledger.notify)
  let outcome : PushOutcome = { sent: [], offline: [], dropped: [], }
  let pending : Array[String] = []
  for device in ledger.targets {
    if self.senders.send_to(device, wire) {
      let tries = match ledger.attempts.get(device) {
        Some(v) => v
        None => 0
      }
      let tries = tries + 1
      ledger.attempts.set(device, tries)
      if tries >= GIT_NOTIFY_MAX_RESENDS {
        outcome.dropped.push(device)
        @log.warn(
          "git commit notify abandoned after {Max} attempts: {Folder} {Hash8} -> {Device} (peer may not send acks)",
          [
            Json::number(GIT_NOTIFY_MAX_RESENDS.to_double()),
            Json::string(folder_id),
            Json::string(
              hash8(
                match ledger.notify {
                  GitCommitNotify(commit_hash~, ..) => commit_hash
                  _ => ""
                },
              ),
            ),
            Json::string(device),
          ],
        )
      } else {
        outcome.sent.push(device)
        pending.push(device)
      }
    } else {
      // 离线:不耗次数,目标保留在账上,重连后由 retry_ledgers 补投
      outcome.offline.push(device)
      pending.push(device)
    }
  }
  ledger.targets = pending
  outcome
}

///|
/// 台账补投(每拍 flush 开头跑;对应 Node retryGitCommitBroadcasts /
/// retryGitCommitRelay 的合并版):逐槽对账 —— 目录删除/模式关断则整账作废,
/// 共享名单收敛掉被移出的目标,暂停期间缓发(不耗次数),在线目标重发直至
/// 销账或放弃。遍历用键快照,结算中可能增删。
async fn GitMirror::retry_ledgers(self : GitMirror) -> Unit {
  let keys : Array[(String, Bool)] = []
  for id, _ in self.broadcast_ledger {
    keys.push((id, true))
  }
  for id, _ in self.relay_ledger {
    keys.push((id, false))
  }
  for (folder_id, is_broadcast) in keys {
    let ledger = match self.ledger_of(folder_id, broadcast=is_broadcast) {
      Some(l) => l
      None => continue
    }
    let folder = match self.folder_of(folder_id) {
      Some(f) => f
      None => {
        // 目录已从配置移除:没有共享名单可言,台账作废
        let _ = self.ledger_map_of(is_broadcast).remove(folder_id)
        self.persist_ledgers(folder_id)
        continue
      }
    }
    let plan = @daemon.git_sync_plan(@daemon.git_sync_mode_of(folder.git_sync))
    // 模式闸:广播槽要 sends(本地提交外发),中继槽要 relay;模式关断即作废
    // (热重载把 gitSync 改小后,存量台账不该再补投)
    let needed = if is_broadcast { plan.watch_local } else { plan.relay }
    if !needed {
      let _ = self.ledger_map_of(is_broadcast).remove(folder_id)
      self.persist_ledgers(folder_id)
      continue
    }
    // 目标收敛:只剩仍在共享名单里的设备(被移出共享的目标不再补投)
    let mut shrunk = false
    let live : Array[String] = []
    for device in ledger.targets {
      if folder.devices.contains(device) {
        live.push(device)
      } else {
        shrunk = true
      }
    }
    if live.length() != ledger.targets.length() {
      ledger.targets = live
    }
    if ledger.targets.is_empty() {
      // 目标全被移出共享:清账落盘(WRN 不发 —— 名单变化是配置行为,不是故障)
      let _ = self.ledger_map_of(is_broadcast).remove(folder_id)
      self.persist_ledgers(folder_id)
      continue
    }
    if shrunk {
      self.persist_ledgers(folder_id)
    }
    // 暂停闸是中场休息:目录(或全局)暂停期间缓发,次数不涨
    if folder.is_paused() {
      continue
    }
    let _ = self.push_targets(folder_id, ledger)
    if ledger.targets.is_empty() {
      // 全部目标达到上限放弃:清账(WRN 已在 push_targets 逐台发出)
      let _ = self.ledger_map_of(is_broadcast).remove(folder_id)
      self.persist_ledgers(folder_id)
    } else if self.any_dropped(ledger) {
      self.persist_ledgers(folder_id)
    }
  }
}

///|
/// 台账里是否存在已达上限的目标(决定是否需要把「少了目标」的现状落盘)。
/// 判据与 push_targets 一致:attempts 记满即已放弃(目标已不在 targets)。
fn GitMirror::any_dropped(self : GitMirror, ledger : GitCommitLedger) -> Bool {
  let _ = self
  for _, tries in ledger.attempts {
    if tries >= GIT_NOTIFY_MAX_RESENDS {
      return true
    }
  }
  false
}

///|
/// 收到投递回执的入队口(handle_peer_message 同步回调调用):日志立即记,
/// 台账摘除与落盘交给 flush 每拍的 drain_acks(销账需要异步写配置文件)。
pub fn GitMirror::on_git_ack(
  self : GitMirror,
  sender : String,
  folder_id : String,
  commit_hash : String,
) -> Unit {
  @log.info("git commit acked by {Device}: {Folder} {Hash8}", [
    Json::string(sender),
    Json::string(folder_id),
    Json::string(hash8(commit_hash)),
  ])
  self.acks.push((sender, folder_id, commit_hash))
}

///|
/// 结算回执队列:广播槽优先、中继槽次之(同一笔通知只挂其中一条槽)。
/// 按 (folderId, commitHash) 匹配台账,命中即从 targets 摘除该设备;摘空
/// 即清账落盘。Node onGitCommitAck 同口径。
async fn GitMirror::drain_acks(self : GitMirror) -> Unit {
  let batch = self.acks
  self.acks = []
  for (sender, folder_id, commit_hash) in batch {
    if self.clear_ack_target(
        self.broadcast_ledger,
        sender,
        folder_id,
        commit_hash,
      ) {
      continue
    }
    if self.clear_ack_target(self.relay_ledger, sender, folder_id, commit_hash) {
      continue
    }
    // 无台账可销:重复回执或来源已放弃/作废,debug 记录即可
    @log.debug(
      "git commit ack without pending ledger: {Folder} {Hash8} from {Device}",
      [
        Json::string(folder_id),
        Json::string(hash8(commit_hash)),
        Json::string(sender),
      ],
    )
  }
}

///|
/// 在指定槽里销一笔回执:目录 + 哈希都匹配且设备在 targets 上才摘。摘除
/// 后 targets 为空 → 移除台账;无论是否摘空,凡有变化都落盘。返回是否命中。
async fn GitMirror::clear_ack_target(
  self : GitMirror,
  map : Map[String, GitCommitLedger],
  sender : String,
  folder_id : String,
  commit_hash : String,
) -> Bool {
  match map.get(folder_id) {
    Some(ledger) => {
      let hash = match ledger.notify {
        GitCommitNotify(commit_hash~, ..) => commit_hash
        _ => return false
      }
      if hash != commit_hash {
        return false
      }
      let mut idx = -1
      for i, device in ledger.targets {
        if device == sender {
          idx = i
          break
        }
      }
      if idx < 0 {
        return false
      }
      // 摘目标(重建数组,避免依赖 Array::remove 的取值语义)
      let rest : Array[String] = []
      for i, device in ledger.targets {
        if i != idx {
          rest.push(device)
        }
      }
      ledger.targets = rest
      if ledger.targets.is_empty() {
        let _ = map.remove(folder_id)
      }
      self.persist_ledgers(folder_id)
      true
    }
    None => false
  }
}

///|
/// 台账落盘:现读盘上配置 → 只改该目录的 gitBroadcastPending /
/// gitRelayPending / gitDeferredMirror 三位 → 原子写回。targets/files 为空
/// (或台账已不在内存)= 记录位清空;attempts 不落盘(仅内存,重启重新
/// 计数)。已知取舍:与 API 写路由的整文件保存之间存在丢更新小竞态 ——
/// 单线程 async 的交错只发生在 await 点之间,窗口极小,且台账记录本身幂等
/// 可重建(Node 整文件回写同源)。
async fn GitMirror::persist_ledgers(
  self : GitMirror,
  folder_id : String,
) -> Unit {
  // 读路径不失败(坏文件按全新配置处理,api 包内部兜底),只有写可能失败
  let config = load_config_file(self.config_file)
  let broadcast_json = match self.broadcast_ledger.get(folder_id) {
    Some(l) => ledger_record_to_json(l)
    None => None
  }
  let relay_json = match self.relay_ledger.get(folder_id) {
    Some(l) => ledger_record_to_json(l)
    None => None
  }
  let deferred_json = match self.deferred.get(folder_id) {
    Some(l) => Some(deferred_record_to_json(l))
    None => None
  }
  let mut found = false
  for i, folder in config.shared_folders {
    if folder.folder_id() == folder_id {
      found = true
      config.shared_folders[i] = {
        ..folder,
        git_broadcast_pending: broadcast_json,
        git_relay_pending: relay_json,
        git_deferred_mirror: deferred_json,
      }
    }
  }
  if !found {
    // 目录已不在配置:没有记录位可写(内存侧的作废由 retry_ledgers 收口)
    return
  }
  save_config_atomic(self.config_file, config) catch {
    e =>
      @log.warn("git ledger persist failed: {Detail}", [
        Json::string(CliError::to_text(e)),
      ])
  }
}

///|
/// 台账恢复(重启 / 配置热重载时调用):盘上 gitBroadcastPending /
/// gitRelayPending / gitDeferredMirror → 内存台账。内存已有的目录跳过
/// (以内存为准);attempts 不恢复(重新计数);坏记录警告跳过不掀桌。
/// 对应 Node readGitPending / readGitDeferredMirror 在目录构建与热重载两处
/// 恢复的语义。
pub async fn GitMirror::adopt_pending(self : GitMirror) -> Unit {
  // 读路径不失败(坏文件按全新配置处理),恢复只读不写
  let config = load_config_file(self.config_file)
  for folder in config.shared_folders {
    let id = folder.folder_id()
    match folder.git_broadcast_pending {
      Some(json) =>
        if !self.broadcast_ledger.contains(id) {
          match ledger_record_from_json(json, id, true) {
            Some(ledger) => {
              self.broadcast_ledger.set(id, ledger)
              @log.info(
                "git broadcast ledger restored: {Folder} -> {Targets}",
                [Json::string(id), Json::string(ledger.targets.join(", "))],
              )
            }
            None =>
              @log.warn(
                "git broadcast ledger record malformed, ignored: {Folder}",
                [Json::string(id)],
              )
          }
        }
      None => ()
    }
    match folder.git_relay_pending {
      Some(json) =>
        if !self.relay_ledger.contains(id) {
          match ledger_record_from_json(json, id, false) {
            Some(ledger) => {
              self.relay_ledger.set(id, ledger)
              @log.info("git relay ledger restored: {Folder} -> {Targets}", [
                Json::string(id),
                Json::string(ledger.targets.join(", ")),
              ])
            }
            None =>
              @log.warn(
                "git relay ledger record malformed, ignored: {Folder}",
                [Json::string(id)],
              )
          }
        }
      None => ()
    }
    // 漂移台账恢复(重启后台账还在,自愈继续)。防御性读:字段不全或文件
    // 清单已空都视为无 —— 台账本来就是「等内容到齐」的暂记,残缺记录宁可
    // 不认,不能凭它对工作树乱下判断(配置可被手改)。
    match folder.git_deferred_mirror {
      Some(json) =>
        if !self.deferred.contains(id) {
          match deferred_record_from_json(json) {
            Some(ledger) => {
              self.deferred.set(id, ledger)
              @log.info("git deferred mirror restored: {Folder} -> {Files}", [
                Json::string(id),
                Json::string(ledger.files.join(", ")),
              ])
            }
            None =>
              @log.warn(
                "git deferred mirror record malformed, ignored: {Folder}",
                [Json::string(id)],
              )
          }
        }
      None => ()
    }
  }
}

///|
/// 台账记录 → Json(对应 Node toGitPendingRecord 的落盘形状:通知原样字段
/// + 顶层 targets 数组,camelCase 与 Node 同键 —— 同一份 config.json 跨后端
/// 互读)。targets 为空返回 None(记录位清空)。
fn ledger_record_to_json(ledger : GitCommitLedger) -> Json? {
  if ledger.targets.is_empty() {
    return None
  }
  let (from_id, folder_id, hash, message, changed, diff_stat, subjects, parent) = match
    ledger.notify {
    GitCommitNotify(
      from_device_id~,
      folder_id~,
      commit_hash~,
      commit_message~,
      changed_files~,
      diff_stat~,
      commit_subjects~,
      parent_hash~,
      ..
    ) =>
      (
        from_device_id, folder_id, commit_hash, commit_message, changed_files, diff_stat,
        commit_subjects, parent_hash,
      )
    _ => return None
  }
  let map : Map[String, Json] = Map([])
  map.set("fromDeviceId", Json::string(from_id))
  map.set("folderId", Json::string(folder_id))
  map.set("commitHash", Json::string(hash))
  map.set("commitMessage", Json::string(message))
  map.set("changedFiles", json_strings(changed))
  match diff_stat {
    Some(s) => map.set("diffStat", Json::string(s))
    None => ()
  }
  match subjects {
    Some(ss) => map.set("commitSubjects", json_strings(ss))
    None => ()
  }
  map.set("parentHash", Json::string(parent))
  map.set("targets", json_strings(ledger.targets))
  Some(Json::object(map))
}

///|
/// Json → 台账记录(ledger_record_to_json 的逆变换)。folderId 以槽键为准
/// (记录里冗余存了一份,以 Map 键为准可容忍目录改名后的旧记录);坏字段
/// 一律按缺失降级,调用方对 None 只警告不掀桌。
fn ledger_record_from_json(
  value : Json,
  folder_id : String,
  broadcast : Bool,
) -> GitCommitLedger? {
  let obj : Map[String, Json] = match value {
    Json::Object(map) => map
    _ => return None
  }
  let targets = json_array_of_strings(obj.get("targets"))
  if targets.is_empty() {
    return None
  }
  let notify = @net.ControlMessage::GitCommitNotify(
    from_device_id=json_req(obj, "fromDeviceId"),
    folder_id~,
    commit_hash=json_req(obj, "commitHash"),
    commit_message=json_req(obj, "commitMessage"),
    changed_files=json_array_of_strings(obj.get("changedFiles")),
    diff_stat=json_opt(obj, "diffStat"),
    commit_subjects=json_opt_array(obj, "commitSubjects"),
    parent_hash=json_req(obj, "parentHash"),
    version=None,
    hostname=None,
    platform=None,
    runtime=None,
  )
  Some({ notify, targets, attempts: Map([]), broadcast, })
}

///|
/// 漂移台账 → Json(落盘形状 { hash, message, files },camelCase 与 Node /
/// Rust 的 gitDeferredMirror 同键 —— 同一份 config.json 跨后端互读)。
fn deferred_record_to_json(ledger : GitDeferredMirror) -> Json {
  let map : Map[String, Json] = Map([])
  map.set("hash", Json::string(ledger.hash))
  map.set("message", Json::string(ledger.message))
  map.set("files", json_strings(ledger.files))
  Json::object(map)
}

///|
/// Json → 漂移台账(deferred_record_to_json 的逆变换)。防御性读:hash 为空 /
/// message 缺失 / files 已空一律视为无 —— 残缺记录宁可不认(与 Node
/// readGitDeferredMirror / Rust GitDeferredMirror::from_record 同口径)。
fn deferred_record_from_json(value : Json) -> GitDeferredMirror? {
  let obj : Map[String, Json] = match value {
    Json::Object(map) => map
    _ => return None
  }
  let hash = match obj.get("hash") {
    Some(Json::String(s)) => if s == "" { return None } else { s }
    _ => return None
  }
  let message = match obj.get("message") {
    Some(Json::String(s)) => s
    _ => return None
  }
  // 空串剔除(对齐 Node readGitDeferredMirror / Rust from_record 的过滤口径);
  // 剔完已空 = 记录残缺,宁可不认
  let files : Array[String] = []
  for rel in json_array_of_strings(obj.get("files")) {
    if rel != "" {
      files.push(rel)
    }
  }
  if files.is_empty() {
    return None
  }
  Some({ hash, message, files, })
}

///|
/// 字符串数组 → Json 数组(台账记录编码用)。
fn json_strings(items : Array[String]) -> Json {
  let arr : Array[Json] = []
  for item in items {
    arr.push(Json::string(item))
  }
  Json::array(arr)
}

///|
/// Map 里取必填字符串(缺/型不对 = 空串;台账字段全是自产,降级即可)。
fn json_req(obj : Map[String, Json], key : String) -> String {
  match obj.get(key) {
    Some(Json::String(s)) => s
    _ => ""
  }
}

///|
/// Map 里取可选字符串(缺 = None;非字符串值也按缺失降级)。
fn json_opt(obj : Map[String, Json], key : String) -> String? {
  match obj.get(key) {
    Some(Json::String(s)) => Some(s)
    _ => None
  }
}

///|
/// Map 里取可选字符串数组(缺 = None)。
fn json_opt_array(obj : Map[String, Json], key : String) -> Array[String]? {
  match obj.get(key) {
    Some(Json::Array(arr)) => {
      let out : Array[String] = []
      for item in arr {
        match item {
          Json::String(s) => out.push(s)
          _ => ()
        }
      }
      Some(out)
    }
    _ => None
  }
}

///|
/// Map 里取字符串数组(缺 = 空数组)。
fn json_array_of_strings(value : Json?) -> Array[String] {
  match value {
    Some(Json::Array(arr)) => {
      let out : Array[String] = []
      for item in arr {
        match item {
          Json::String(s) => out.push(s)
          _ => ()
        }
      }
      out
    }
    _ => []
  }
}

///|
/// flush 常驻轻量循环:先恢复盘上台账(重启恢复语义),之后每
/// MIRROR_FLUSH_PERIOD_MS 结算一轮(回执销账 → 台账补投 → 挂起通知槽)。
pub async fn mirror_flush_loop(mirror : GitMirror) -> Unit {
  mirror.adopt_pending()
  for ;; {
    @async.sleep(MIRROR_FLUSH_PERIOD_MS)
    mirror.flush()
  }
}

///|
/// 哈希展示短形(8 位,日志用;哈希是 hex ASCII,直接切片)。
fn hash8(hash : String) -> String {
  hash[0:8].to_owned()
}

///|
/// 长清单的日志预览:前 10 条逗号连接(尾部省略号由调用方按长度补)。
fn preview_of(files : Array[String]) -> String {
  let head : Array[String] = []
  for i in 0..<files.length() {
    if i >= 10 {
      break
    }
    head.push(files[i])
  }
  head.join(", ")
}

///|
/// 提交消息首行(日志展示用;多行消息保真入库,日志只露主题行)。
fn first_line(message : String) -> String {
  match message.split("\n").next() {
    Some(v) => v.to_owned()
    None => message
  }
}

// ==================== 「自动提交失败」弹窗(status / retry) ====================

///|
/// 「自动提交失败」弹窗的镜像侧数据(不含 lock —— lock 由 api 层现查合并;
/// 对齐 Node getGitAutoCommitStatus 的台账部分)。None = 没有挂起通知,
/// 调用方按「pending:false」折算。错误口径取最近一次自动提交失败(仅内存:
/// 重启后从空白开始,与 attempts 同口径)。
pub fn GitMirror::commit_status(self : GitMirror, folder_id : String) -> Json? {
  let slot = match self.slots.get(folder_id) {
    Some(s) => s
    None => return None
  }
  let (message, changed) = match slot.notify {
    GitCommitNotify(
      from_device_id=_,
      commit_hash=_,
      commit_message~,
      changed_files~,
      commit_subjects=_,
      ..
    ) => (commit_message, changed_files)
    _ => ("", [])
  }
  let subject = match message.split("\n").next() {
    Some(line) => line.to_owned()
    None => message
  }
  let given_up = slot.attempts >= GIT_AUTO_COMMIT_MAX_ATTEMPTS &&
    slot.retry_at is None
  let map : Map[String, Json] = Map([])
  map.set("pending", Json::boolean(true))
  map.set("commitMessage", Json::string(subject))
  let files : Array[Json] = []
  for f in changed {
    files.push(Json::string(f))
  }
  map.set("changedFiles", Json::array(files))
  map.set("attempts", Json::number(slot.attempts.to_double()))
  match slot.retry_at {
    Some(at) => map.set("retryAt", Json::number(at.to_double()))
    None => ()
  }
  map.set("givenUp", Json::boolean(given_up))
  match slot.last_error {
    Some(err) => {
      let em : Map[String, Json] = Map([])
      em.set("message", Json::string(err))
      em.set("ts", Json::number(slot.last_error_at.unwrap_or(0L).to_double()))
      map.set("error", Json::object(em))
    }
    None => ()
  }
  Some(Json::object(map))
}

///|
/// 手动重试自动提交(对齐 Node retryGitAutoCommit):仍走完整结算闸门,
/// 不因「用户点的」就跳过 —— 半套文件被定格正是这些闸门要防的事;被挡时
/// 如实回报「仍被延后」或最近一次失败原因。清零计数与退避后立即结算一轮:
/// 槽已清 = 提交成功(带新哈希);仍挂 = 被闸挡住或再次失败。
pub async fn GitMirror::retry_folder(
  self : GitMirror,
  folder_id : String,
) -> Json {
  match self.slots.get(folder_id) {
    None => {
      let map : Map[String, Json] = Map([])
      map.set("ok", Json::boolean(false))
      map.set("error", Json::string("没有待提交的通知"))
      map.set("attempts", Json::number(0))
      return Json::object(map)
    }
    Some(slot) => {
      slot.attempts = 0
      slot.retry_at = None
      slot.last_error = None
      slot.last_error_at = None
    }
  }
  self.flush()
  let map : Map[String, Json] = Map([])
  match self.slots.get(folder_id) {
    Some(slot) => {
      // 通知仍挂着:被闸挡住(最近失败原因已清 = 纯闸门延迟)或再次失败
      map.set("ok", Json::boolean(false))
      map.set(
        "error",
        Json::string(
          slot.last_error.unwrap_or(
            "提交被延后:仍在等待在途内容收齐或对端索引交换",
          ),
        ),
      )
      map.set("attempts", Json::number(slot.attempts.to_double()))
    }
    None => {
      // 结算完成:带最新 HEAD(干净树跳过提交时也推进基线,哈希可能不变)
      map.set("ok", Json::boolean(true))
      match self.folder_of(folder_id) {
        Some(folder) =>
          match @daemon.get_last_commit_hash(folder.path) {
            Some(head) => map.set("hash", Json::string(head))
            None => ()
          }
        None => ()
      }
    }
  }
  Json::object(map)
}
