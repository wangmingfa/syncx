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
///   - 与 Node 的差异(有意收窄,后续包):基线不落盘(重启后首轮只记基线,
///     绝不重放历史);目录身份拦阻(gitBlockedByIdentity)与「未推送清单
///     UI」不做。

///|
/// 自动重试上限(Node GIT_AUTO_COMMIT_MAX_ATTEMPTS 同值):次数用尽后停止
/// 自动重试,通知槽保留 —— 手动重试与下一条通知都还要用它。
pub const GIT_AUTO_COMMIT_MAX_ATTEMPTS : Int = 5

///|
/// git 通知补投上限(Node GIT_NOTIFY_MAX_RESENDS 同值):同一目标发送满
/// 这个次数仍无回执就放弃并清账 —— 「本地写成功不等于送达」,但不回 ack 的
/// 对端(旧版本/离线僵尸会话)不能无限占用台账。
pub const GIT_NOTIFY_MAX_RESENDS : Int = 5

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
pub const MIRROR_FLUSH_PERIOD_MS : Int = 2000

///|
/// 去重集合容量与淘汰数(Node processedRemoteCommits 同口径:>1000 时淘
/// 最旧的 500,保留最新的一半)。
pub const PROCESSED_REMOTE_CAP : Int = 1000

///|
pub const PROCESSED_REMOTE_EVICT : Int = 500

///|
/// 对端发送闭包登记表:deviceId → 投递闭包(server 侧按入站连接、client 侧
/// 按拨号连接各自注入)。镜像中继按它寻址;生命周期跟随会话(断开即摘除)。
pub struct PeerSenders {
  priv senders : Map[String, async (@net.WireMessage) -> Bool]
}

///|
pub fn PeerSenders::new() -> PeerSenders {
  { senders: Map([]) }
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
  in_flight : Int,
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
    return { flush_now: true, reasons: "", blocked_since: None }
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
  mut attempts : Int
  mut retry_at : Int64?
  mut blocked_since : Int64?
  mut warned : Bool
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
  mut attempts : Map[String, Int]
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
pub fn GitMirror::slot_attempts(self : GitMirror, folder_id : String) -> Int {
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
) -> Int? {
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
/// 观测:去重集合大小(测试用)。
pub fn GitMirror::processed_size(self : GitMirror) -> Int {
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
      ) => (from_device_id, commit_hash, commit_message, changed_files, commit_subjects)
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
    let gate = drain_gate(self.in_flight_of(folder_id), self.source_away(slot.via), slot.blocked_since, now)
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
      Some(retry_at) => if now < retry_at {
        continue
      }
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
    slot.attempts = slot.attempts + 1
    @log.info(
      "auto-committing: {Folder} (from {Device}) \"{Subject}\" — {Files}",
      [
        Json::string(folder_id),
        Json::string(from_id),
        Json::string(first_line(message)),
        Json::string(@daemon.git_files_desc(changed)),
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
    // 「回声吞掉用户并发改动」事故;契约见 Node 55b1c35)
    let result = @daemon.auto_commit(
      folder.path,
      mirror_message,
      changed_files=changed,
    )
    if result.success {
      @log.info("auto-commit success: {Folder} -> {Hash8}", [
        Json::string(folder_id),
        Json::string(match result.hash {
          Some(h) => hash8(h)
          None => "?"
        }),
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
    } else {
      let error = match result.error {
        Some(e) => e
        None => "git auto-commit failed"
      }
      @log.warn(
        "auto-commit failed (attempt {N}/{Max}): {Folder}: {Error}",
        [
          Json::number(slot.attempts.to_double()),
          Json::number(GIT_AUTO_COMMIT_MAX_ATTEMPTS.to_double()),
          Json::string(folder_id),
          Json::string(error),
        ],
      )
      if slot.attempts >= GIT_AUTO_COMMIT_MAX_ATTEMPTS {
        // 停止自动重试但**保留通知**:工作树依旧是脏的、这一笔仍未提交;
        // 下一条通知照旧覆盖并重置计数
        slot.retry_at = None
        @log.warn(
          "auto-commit giving up after {Max} attempts: {Folder}; notify kept for manual retry or the next commit notification",
          [Json::number(GIT_AUTO_COMMIT_MAX_ATTEMPTS.to_double()), Json::string(folder_id)],
        )
      } else {
        slot.retry_at = Some(now + GIT_AUTO_COMMIT_RETRY_MS)
      }
    }
  }
}

///|
/// 该目录的在途接收总数(actor 快照里各会话 pending 之和;无该目录 = 0)。
fn GitMirror::in_flight_of(self : GitMirror, folder_id : String) -> Int {
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
  let outcome : PushOutcome = { sent: [], offline: [], dropped: [] }
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
            Json::string(hash8(match ledger.notify {
              GitCommitNotify(commit_hash~, ..) => commit_hash
              _ => ""
            })),
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
fn GitMirror::any_dropped(
  self : GitMirror,
  ledger : GitCommitLedger,
) -> Bool {
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
    if self.clear_ack_target(self.broadcast_ledger, sender, folder_id, commit_hash) {
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
/// gitRelayPending 两位 → 原子写回。targets 为空(或台账已不在内存)= 记录
/// 位清空;attempts 不落盘(仅内存,重启重新计数)。已知取舍:与 API 写
/// 路由的整文件保存之间存在丢更新小竞态 —— 单线程 async 的交错只发生在
/// await 点之间,窗口极小,且台账记录本身幂等可重建(Node 整文件回写同源)。
async fn GitMirror::persist_ledgers(self : GitMirror, folder_id : String) -> Unit {
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
  let mut found = false
  for i, folder in config.shared_folders {
    if folder.folder_id() == folder_id {
      found = true
      config.shared_folders[i] = {
        ..folder,
        git_broadcast_pending: broadcast_json,
        git_relay_pending: relay_json,
      }
    }
  }
  if !found {
    // 目录已不在配置:没有记录位可写(内存侧的作废由 retry_ledgers 收口)
    return
  }
  save_config_atomic(self.config_file, config) catch {
    e => {
      @log.warn("git ledger persist failed: {Detail}", [
        Json::string(CliError::to_text(e)),
      ])
    }
  }
}

///|
/// 台账恢复(重启 / 配置热重载时调用):盘上 gitBroadcastPending /
/// gitRelayPending → 内存台账。内存已有的目录跳过(以内存为准);attempts
/// 不恢复(重新计数);坏记录警告跳过不掀桌。对应 Node readGitPending 在
/// 目录构建与热重载两处恢复的语义。
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
                [
                  Json::string(id),
                  Json::string(ledger.targets.join(", ")),
                ],
              )
            }
            None => {
              @log.warn("git broadcast ledger record malformed, ignored: {Folder}", [
                Json::string(id),
              ])
            }
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
              @log.info(
                "git relay ledger restored: {Folder} -> {Targets}",
                [Json::string(id), Json::string(ledger.targets.join(", "))],
              )
            }
            None => {
              @log.warn("git relay ledger record malformed, ignored: {Folder}", [
                Json::string(id),
              ])
            }
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
  let (from_id, folder_id, hash, message, changed, diff_stat, subjects, parent) =
    match ledger.notify {
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
          from_device_id,
          folder_id,
          commit_hash,
          commit_message,
          changed_files,
          diff_stat,
          commit_subjects,
          parent_hash,
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
  Some({ notify, targets, attempts: Map([]), broadcast })
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
/// 提交消息首行(日志展示用;多行消息保真入库,日志只露主题行)。
fn first_line(message : String) -> String {
  match message.split("\n").next() {
    Some(v) => v.to_owned()
    None => message
  }
}
