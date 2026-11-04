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
///   - 与 Node 的差异(有意收窄,后续包):中继/广播不带待回执台账重发
///     (投递一次,离线对端等下一条通知或人工干预);基线不落盘(重启后
///     首轮只记基线,绝不重放历史);目录身份拦阻(gitBlockedByIdentity)
///     与「未推送清单 UI」不做。

///|
/// 自动重试上限(Node GIT_AUTO_COMMIT_MAX_ATTEMPTS 同值):次数用尽后停止
/// 自动重试,通知槽保留 —— 手动重试与下一条通知都还要用它。
pub const GIT_AUTO_COMMIT_MAX_ATTEMPTS : Int = 5

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
/// git 镜像循环主体:配置(现值直读)+ 会话注册表(drain 闸对账)+
/// 发送闭包表(中继)+ actor 句柄(基线回填与在途接收读数)+ 去重集合。
pub struct GitMirror {
  priv config : @core.Config
  priv registry : PeerSessionRegistry
  priv senders : PeerSenders
  priv handle : @daemon.ActorHandle
  /// 已处理过的远端提交哈希(Node processedRemoteCommits):入队时登记,
  /// 结算前同一通知重达只算一次;镜像成功的新哈希也记入(回声兜底)。
  priv processed : Map[String, Bool]
  /// folder_id → 挂起通知槽(单笔)。
  priv slots : Map[String, PendingGitNotify]
}

///|
pub fn GitMirror::new(
  config : @core.Config,
  registry : PeerSessionRegistry,
  senders : PeerSenders,
  handle : @daemon.ActorHandle,
) -> GitMirror {
  { config, registry, senders, handle, processed: Map([]), slots: Map([]) }
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
  for folder in self.config.shared_folders {
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
/// 收到投递回执:通知已到达并被对端**处理**。MoonBit 侧发送不带台账重发,
/// 这里只销账记日志(与 Node onGitCommitAck 的台账摘除相比少了重发账本,
/// 故为自由函数而非 GitMirror 方法)。
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
/// 它的哈希,中继设备自己的镜像哈希从头到尾不出门。MoonBit 不带台账重发:
/// 离线对端记一条 deferred 日志,等下一条通知或人工干预。
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
  let wire : @net.WireMessage = @net.WireMessage::Control(payload=notify)
  let sent : Array[String] = []
  let offline : Array[String] = []
  for device in folder.devices {
    if device == from_id {
      continue
    }
    if self.senders.send_to(device, wire) {
      sent.push(device)
    } else {
      offline.push(device)
    }
  }
  let h = hash8(hash)
  if sent.length() > 0 {
    @log.info("git commit relayed: {Folder} {Hash8} -> {Targets}", [
      Json::string(folder.folder_id()),
      Json::string(h),
      Json::string(sent.join(", ")),
    ])
  }
  if offline.length() > 0 {
    @log.info(
      "git commit relay deferred: {Folder} {Hash8} (offline: {Targets})",
      [
        Json::string(folder.folder_id()),
        Json::string(h),
        Json::string(offline.join(", ")),
      ],
    )
  }
}

///|
/// flush 常驻轻量循环:每 MIRROR_FLUSH_PERIOD_MS 结算一轮挂起通知。
pub async fn mirror_flush_loop(mirror : GitMirror) -> Unit {
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
