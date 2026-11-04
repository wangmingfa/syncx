///|
/// 会话 actor:把扫描、执行与各连接的会话层串成**单线程串行**的命令循环。
/// 对应 Rust `syncx-daemon/src/actor.rs`(+ `peer.rs` 的会话编排与 `driver.rs`
/// 的「收帧转命令」入口)。
///
/// 并发模型:Rust 用「一条 mpsc 命令通道 + actor 线程独占状态 + `Rc` 拦住
/// 跨线程共享」;MoonBit async 本身就是协作式单线程事件循环 —— 所有状态变更
/// (扫描、规划、块收发、落地)都经 `Cmd` 进入同一个任务串行执行,不存在两条
/// 命令交错改同一份索引的可能。对端 WS 传输层(`moonbit/net`)只搬帧:收到的
/// wire 消息转成 `Cmd::PeerMessage` 投递回来,出站帧写进各会话自己的出站队列
/// (对应 Rust 的 `sinks`)。
///
/// 只读快照:每处理完一条命令,把状态汇总**整体替换**进 `SnapshotCell`
/// (单线程内的原子引用替换,读侧永远看到完整的一份,不必持锁等待)。
///
/// 本里程碑的刻意裁剪(与 Rust 版的差异,均为 TODO):
///  - 断点续传中间态已移植(partial.mbt):块落 `<target>.syncx-tmp` + sidecar
///    位图,重连只请求缺的块;落地仍经 executor 现有「读回整份 → tmp → fsync →
///    rename」管线,大文件落地瞬间多一遍整读整写(Rust 是 tmp 直接 rename);
///  - 认领台账(同设备多连接去重)未移植:每目录每设备至多一条会话;
///  - 块重试 / 发送租约 / 限速窗口 / 延迟队列已移植(见 reliability.mbt);
///    放弃接收时保留断点续传中间态;尚未移植的是块重试的 30s 慢退避
///    (Rust 总计 23 次发送上限);
///  - 初始交换的 2s 兜底全量(`INITIAL_INDEX_FALLBACK_MS`)未接线:没有定时器
///    驱动,指纹无应答时靠对端主动发全量;
///  - 中转(ADR-0014)与磁盘空间守卫未移植;
///  - CDC 块的请求与供应未移植(只走定长块)。

///|
/// 索引消息的语义:全量(并集规划)或增量(只判消息里提到的路径)。
/// **缺省 = 增量**:把增量当全量做并集规划,两端会各自回推对方「没提到」的
/// 本地条目,形成回声死循环(见 `core/plan.mbt` 的 `build_delta_plan` 注释)。
pub(all) enum IndexMode {
  Full
  Delta
}

///|
/// 冲突自动处理策略(对齐 Rust `peer::ConflictPolicy`)。
pub(all) enum ConflictPolicy {
  /// 拉回远端 + 本地留冲突副本。
  KeepBoth
  /// 无条件保本地(合并版本向量,不拉块)。
  LocalWins
  /// 比较双方 mtime;判不了(任一侧缺 mtime 或打平)退回 KeepBoth。
  NewestWins
}

///|
/// 一条要发给对端的出站帧,由驱动层编码写进 socket(本模块只产生)。
/// 对应 Rust `peer::Outbound`。
pub(all) enum Outbound {
  /// 索引条目(full = 全量声明)。
  Entries(entries~ : Array[@net.WireEntry], full~ : Bool, relayed~ : Bool)
  /// 请求对端的一个块。
  BlockRequest(@net.WireBlockRequest)
  /// 回给对端的一个块(data 为 base64)。
  BlockResponse(@net.WireBlockResponse)
  /// 初始交换第一阶段:本机索引指纹。
  IndexFingerprint(String)
  /// 初始交换:确认两侧索引一致。
  IndexAck
  /// 初始交换:请求对端发全量索引。
  IndexRequest
}

///|
/// 一条命令。网络驱动与定时器都只能通过它改变状态(对应 Rust `actor::Cmd`,
/// 面上取本里程碑实际接线的子集):
///  - `ScanFolder` / `ApplyPlan` / `PeerMessage` / `Shutdown` 是任务书点名的四条;
///  - `PeerOpen` / `PeerClose` 对应连接挂载与拆除;
///  - `Snapshot` / `DrainEvents` 带一次性回执队列,把只读数据搬出 actor
///    (状态只在 actor 任务上,上层要读只能这样取)。
pub(all) enum Cmd {
  /// 扫描某个目录:对比索引、落地墓碑、外推本机改动。
  ScanFolder(String)
  /// 执行某目录各会话已排队的传输计划(块请求 / 落地 / 外推)。
  ApplyPlan(String)
  /// 一条新连接挂到某个目录:开始初始索引交换。
  PeerOpen(
    folder~ : String,
    remote_device_id~ : String,
    sink~ : @async.Queue[Outbound]
  )
  /// 收到一条对端 wire 消息(已按 folder 路由到该目录的会话)。
  PeerMessage(
    folder~ : String,
    remote_device_id~ : String,
    message~ : @net.WireMessage
  )
  /// 会话拆除。
  PeerClose(folder~ : String, remote_device_id~ : String)
  /// 生成只读快照并经回执队列送回。
  Snapshot(reply~ : @async.Queue[StatusSnapshot])
  /// 取走某目录各会话的运行期事件(同步记录)。
  DrainEvents(folder~ : String, reply~ : @async.Queue[Array[SyncEventRecord]])
  /// 周期泵:处理到期的块重试、租约衰减与限速重放。驱动层接 WS 后由
  /// 定时任务自动投递;测试可注入时钟快进(语义对齐 Rust `poll_timeouts`)。
  PollTimeouts(now~ : Int64)
  /// 驱动层回账:一帧块响应已写进 socket,释放发送窗口额度并重放延迟队列。
  /// 未接线前的额度兜底靠 `decay_serve_lease` 衰减,不会永久卡死。
  BlockSent(folder~ : String, remote_device_id~ : String, bytes~ : Int32)
  /// 退出循环。
  Shutdown
}

///|
/// 一次同步变更(供上层写历史;对应 Rust `peer::SyncEvent` 的简化面)。
pub(all) struct SyncEventRecord {
  path : String
  /// `"remote"` / `"local"`
  direction : String
  /// `"add"` / `"update"` / `"delete"` / `"conflict"`。
  /// 传输可靠性另有两种(action 仍走 `remote` 方向):
  /// `"block_retry"` = 块请求超时重发;`"block_giveup"` = 重试耗尽放弃接收。
  action : String
}

///|
/// 单个共享目录的只读状态快照。
pub(all) struct FolderStatus {
  id : String
  path : String
  paused : Bool
  receive_only : Bool
  /// 已建立的会话数。
  peers : Int32
  entries : Int64
  tombstones : Int64
  /// 盘上残留的冲突副本数(目录卡徽标)。
  conflicts : Int32
}

///|
/// 全局只读状态快照(对应 Rust `StatusSnapshot`)。
pub(all) struct StatusSnapshot {
  folders : Array[FolderStatus]
  total_entries : Int64
  total_tombstones : Int64
}

///|
/// 由配置折算出的目录构造参数(纯数据;对应 Rust `actor::FolderSpec`)。
/// `index_path` 由装配层按 `<configDir>/index-<hash>.db` 算好 —— 与
/// Node/Rust 共用同一个数据目录,拼错一个字符就是「换后端之后索引全空、
/// 对端文件成批删除」。
pub(all) struct FolderSpec {
  id : String
  root : String
  index_path : String
  trash_dir : String
  versions_dir : String?
  versions_per_path : Int32?
  rules : @core.IgnoreRuleset
  receive_only : Bool
  conflict_policy : ConflictPolicy
  paused : Bool
  paused_files : Array[String]
  /// 基线扫描未跑完:首扫的存量文件不算「新增」。
  baseline_pending : Bool
  /// 目录级发送带宽上限(KB/s;core Config 的 `maxBandwidthKbps`,
  /// 0 / None = 不限)。只作用于出站块响应(供块是唯一的大流量出口)。
  max_bandwidth_kbps : Int32?
}

///|
/// 快照单元:单线程事件循环内做整体替换,读侧无需锁。
pub struct SnapshotCell {
  mut value : StatusSnapshot
}

///|
/// 读当前快照(永远是一份完整的状态,不会看到半更新)。
pub fn SnapshotCell::snapshot(self : SnapshotCell) -> StatusSnapshot {
  self.value
}

// ==================== 内部状态 ====================

///|
/// 一条在途接收(以相对路径为键)。
priv struct PendingReceive {
  /// 冲突分支:远端内容落地,本地内容保留为 `.sync-conflict-` 副本。
  is_conflict : Bool
  /// 对端目标条目(携带规划定下的最终版本向量)。
  entry : Entry
  /// 冲突分支的本地条目快照(规划时留影)。
  local_entry : Entry?
  /// 磁盘中间态句柄:块到一块落一块,断线重连后从位图续传(见 partial.mbt)。
  store : PartialStore
}

///|
/// 一条对端连接上的会话层(对应 Rust `peer::Peer` 的简化面)。
priv struct PeerSession {
  remote_device_id : String
  /// 出站通道:驱动/测试在这里等自己的帧。
  sink : @async.Queue[Outbound]
  /// 收到、待 ApplyPlan 规划执行的对端索引。
  mut pending_index : Array[@net.WireEntry]?
  /// 待规划批次是否按全量解释(缺省按增量,见文件头)。
  mut pending_full : Bool
  mut pending_relayed : Bool
  /// 在途接收:相对路径 → 状态。
  pending : Map[String, PendingReceive]
  /// 在途块请求的重试台账(块级独立计数;见 reliability.mbt)。
  block_retries : Map[String, PendingBlock]
  /// 发送窗口已占额度(wire 字节估算;`BlockSent` 回账释放)。
  mut inflight_bytes : Int64
  /// 最近一次占额时刻(租约衰减用)。
  mut last_serve_ms : Int64
  /// 延迟队列:窗口满 / 令牌不够的块请求,由 PollTimeouts 重放。
  mut deferred : Array[@net.WireBlockRequest]
  /// 延迟队列去重键(与 deferred 同进同出)。
  deferred_keys : Map[String, Unit]
  /// 运行期事件(上层经 DrainEvents 取走)。
  events : Array[SyncEventRecord]
}

///|
/// 单个共享目录的运行期状态。
priv struct Folder {
  id : String
  root : String
  index : IndexStore
  executor : LocalExecutor
  /// 本机内存索引(与索引库同步维护;扫描 / 落地 / 控制面三条写入路径都在
  /// actor 任务上,故无需锁)。
  local_index : Map[String, Entry]
  rules : @core.IgnoreRuleset
  receive_only : Bool
  conflict_policy : ConflictPolicy
  paused : Bool
  paused_files : Array[String]
  mut conflict_count : Int32
  /// remote_device_id → 会话(认领台账未移植:同设备至多一条连接,TODO)。
  peers : Map[String, PeerSession]
  /// 目录级限速令牌桶(maxBandwidthKbps;None = 不限,对齐 Node)。
  limiter : RateLimiter?
}

///|
/// 会话状态机本体。所有方法都在同一个任务上调用(单线程事件循环保证)。
pub struct SessionActor {
  priv rx : @async.Queue[Cmd]
  priv device_id : String
  priv folders : Array[Folder]
  priv cell : SnapshotCell
}

///|
/// 命令发送端(队列是引用:多处持有同一入口,对应 Rust 可克隆的 `ActorHandle`)。
pub struct ActorHandle {
  priv tx : @async.Queue[Cmd]
  priv cell : SnapshotCell
}

///|
/// 投递一条命令。返回 false = actor 已退出(队列已关)。
pub fn ActorHandle::send(self : ActorHandle, cmd : Cmd) -> Bool {
  self.tx.try_put(cmd) catch {
    _ => false
  }
}

///|
/// 读最近一次命令处理后的快照(不与 actor 往返;要确保此前的命令都已处理完,
/// 用 `sync_snapshot`)。
pub fn ActorHandle::snapshot(self : ActorHandle) -> StatusSnapshot {
  self.cell.snapshot()
}

///|
/// 与 actor 往返一次取快照:回执到达即说明此前的命令都已处理完,
/// 快照反映的是**全部**已投递命令的结果。
pub async fn ActorHandle::sync_snapshot(self : ActorHandle) -> StatusSnapshot {
  let reply : @async.Queue[StatusSnapshot] = @async.Queue(kind=Unbounded)
  if !self.send(Snapshot(reply~)) {
    return self.cell.snapshot()
  }
  reply.get()
}

///|
/// 按配置构造 actor(打开索引库并载入内存索引;失败如实上抛)。
pub fn new_session_actor(
  device_id : String,
  specs : Array[FolderSpec],
) -> SessionActor raise IndexStoreError {
  let folders : Array[Folder] = []
  for spec in specs {
    let index = IndexStore::open(spec.index_path)
    let local_index : Map[String, Entry] = Map([])
    for entry in index.list_entries() {
      local_index.set(entry.path, entry)
    }
    folders.push({
      id: spec.id,
      root: spec.root,
      index,
      executor: make_executor(spec),
      local_index,
      rules: spec.rules,
      receive_only: spec.receive_only,
      conflict_policy: spec.conflict_policy,
      paused: spec.paused,
      paused_files: spec.paused_files,
      conflict_count: 0,
      peers: Map([]),
      limiter: make_rate_limiter(spec.max_bandwidth_kbps),
    })
  }
  let actor : SessionActor = {
    rx: @async.Queue(kind=Unbounded),
    device_id,
    folders,
    cell: { value: { folders: [], total_entries: 0L, total_tombstones: 0L, }, },
  }
  actor.publish()
  actor
}

///|
/// 取命令发送端(可先投递后运行:队列无界缓冲)。
pub fn SessionActor::handle(self : SessionActor) -> ActorHandle {
  { tx: self.rx, cell: self.cell, }
}

///|
/// 把 actor 挂进任务组并返回发送端(对应 Rust `actor::spawn_actor`)。
/// 循环直到收到 `Shutdown`(或队列被关闭)才返回;调用方要保证任务组
/// 生命周期内一定投递 `Shutdown`,否则收尾时会一直等它。
pub fn start_session_actor(
  group : @async.TaskGroup[Unit],
  device_id : String,
  specs : Array[FolderSpec],
) -> ActorHandle raise IndexStoreError {
  let actor = new_session_actor(device_id, specs)
  let handle = actor.handle()
  group.spawn_bg(allow_failure=true) <| () => { actor.run() }
  // 周期泵:驱动重试到期 / 租约衰减 / 限速重放。actor 退出关队列后停止。
  let poll_tx = actor.rx
  group.spawn_bg(allow_failure=true) <| () => {
    let mut running = true
    while running {
      @async.sleep(POLL_TICK_MS)
      let ok : Bool = poll_tx.try_put(PollTimeouts(now=now_ms())) catch {
        _ => false
      }
      if !ok {
        running = false
      }
    }
  }
  handle
}

///|
/// 驱动循环:取一条命令、串行处理、发布快照。
pub async fn SessionActor::run(self : SessionActor) -> Unit {
  let mut running = true
  while running {
    let incoming : Cmd? = Some(self.rx.get()) catch {
      _ => None // 队列关闭:所有句柄已丢弃,退出
    }
    let cmd = match incoming {
      Some(c) => c
      None => break
    }
    // 单条命令失败只记日志,不掀翻整个 actor(与 Rust 侧 warn + 继续同口径)
    running = self.dispatch(cmd) catch {
      e => {
        @log.error("会话命令处理失败 {Detail}", [Json::string(@debug.to_string(e))])
        true
      }
    }
    self.publish()
  }
  // 通知所有发送端:actor 已退出(此后 send 返回 false)
  self.rx.close(clear=true)
}

///|
/// 处理一条命令。返回 false 表示该退出循环。
async fn SessionActor::dispatch(self : SessionActor, cmd : Cmd) -> Bool {
  match cmd {
    Shutdown => return false
    ScanFolder(id) => self.do_scan(id)
    ApplyPlan(id) => self.do_apply_plan(id)
    PeerOpen(folder~, remote_device_id~, sink~) =>
      self.do_peer_open(folder, remote_device_id, sink)
    PeerMessage(folder~, remote_device_id~, message~) =>
      self.do_peer_message(folder, remote_device_id, message)
    PeerClose(folder~, remote_device_id~) =>
      self.do_peer_close(folder, remote_device_id)
    Snapshot(reply~) => {
      let _ : Bool = reply.try_put(self.cell.snapshot()) catch { _ => false }
    }
    DrainEvents(folder~, reply~) => self.do_drain_events(folder, reply)
    PollTimeouts(now~) => self.do_poll_timeouts(now)
    BlockSent(folder~, remote_device_id~, bytes~) =>
      self.do_block_sent(folder, remote_device_id, bytes)
  }
  true
}

///|
/// 可选参数不能整包透传 `Option`,按组合拆成四路(参数不多,穷举最直白)。
fn make_executor(spec : FolderSpec) -> LocalExecutor {
  match (spec.versions_dir, spec.versions_per_path) {
    (Some(dir), Some(n)) =>
      LocalExecutor::new(
        spec.root,
        spec.trash_dir,
        versions_dir=dir,
        versions_per_path=n,
      )
    (Some(dir), None) =>
      LocalExecutor::new(spec.root, spec.trash_dir, versions_dir=dir)
    (None, Some(n)) =>
      LocalExecutor::new(spec.root, spec.trash_dir, versions_per_path=n)
    (None, None) => LocalExecutor::new(spec.root, spec.trash_dir)
  }
}

// ==================== 目录定位 ====================

///|
fn SessionActor::folder_by_id(self : SessionActor, id : String) -> Folder? {
  for folder in self.folders {
    if folder.id == id {
      return Some(folder)
    }
  }
  None
}

// ==================== 扫描 ====================

///|
/// 扫一轮:对比索引,产出改动/墓碑并落地;本机改动外推到所有连接。
/// 对应 Rust `Folder::scan` + `SessionActor::scan_all`(嵌套共享根换算)。
/// 日志:开始 Debug / 完成 Information(带改动条数与耗时);异常走 dispatch
/// 层统一记 Error。
async fn SessionActor::do_scan(self : SessionActor, id : String) -> Unit {
  let folder = match self.folder_by_id(id) {
    Some(f) => f
    None => return
  }
  if folder.paused {
    return // 暂停(目录级):数据面整体停摆
  }
  // 嵌套共享根 = 其余目录的归一化绝对根(交由那些共享自己管理)
  let nested : Array[String] = []
  for other in self.folders {
    if other.id != folder.id {
      nested.push(normalize_path(other.root))
    }
  }
  @log.debug("扫描开始 {Folder}", [Json::string(id)])
  let started = now_ms()
  let diff = scan_folder(
    folder.root,
    folder.index,
    folder.rules,
    self.device_id,
    nested,
  )
  @log.info(
    "扫描完成 {Folder}:改动 {Changed} 条,墓碑 {Tombs} 条,耗时 {Ms}ms",
    [
      Json::string(id),
      Json::number(diff.changed.length().to_double()),
      Json::number(diff.tombstones.length().to_double()),
      Json::number((now_ms() - started).to_double()),
    ],
  )
  folder.conflict_count = diff.conflict_count
  // 墓碑:本地已删除 → 移回收站 + 写索引与内存索引(冻结路径跳过)
  for tomb in diff.tombstones {
    if is_paused_path(folder, tomb.path) {
      continue
    }
    folder.executor.apply_delete(folder.index, tomb.path, tomb) catch {
      e =>
        @log.error("墓碑落地失败 {Path}: {Detail}", [
          Json::string(tomb.path), Json::string(@debug.to_string(e)),
        ])
    }
    folder.local_index.set(tomb.path, tomb)
  }
  // 改动:重算条目并外推(文件在扫描后消失:下一轮按墓碑处理)
  let sends : Array[Entry] = []
  for path in diff.changed {
    if is_paused_path(folder, path) {
      continue // 冻结路径连本机改动也不外推
    }
    let updated : Entry? = Some(
      folder.executor.apply_send(folder.index, path, self.device_id),
    ) catch {
      _ => None
    }
    match updated {
      Some(entry) => {
        folder.local_index.set(path, entry)
        sends.push(entry)
      }
      None => ()
    }
  }
  // 外推:过滤硬忽略(接收端还有第二道闸,这里过掉的是「不该离开本机」的)
  if sends.length() > 0 && !folder.receive_only {
    let wire : Array[@net.WireEntry] = []
    for entry in sends {
      if !@core.is_hard_ignored(entry.path) {
        wire.push(wire_of(entry))
      }
    }
    if wire.length() > 0 {
      for _, session in folder.peers {
        push_outbound(session, Entries(entries=wire, full=false, relayed=false))
      }
    }
  }
}

// ==================== 会话挂载 / 拆除 ====================

///|
/// 挂一条连接:建会话并发本机索引指纹(初始交换第一步)。
/// 同设备重连:新会话顶掉旧会话(旧出站队列由创建方负责关闭)。
fn SessionActor::do_peer_open(
  self : SessionActor,
  folder_id : String,
  device : String,
  sink : @async.Queue[Outbound],
) -> Unit {
  let folder = match self.folder_by_id(folder_id) {
    Some(f) => f
    None => return
  }
  let session : PeerSession = {
    remote_device_id: device,
    sink,
    pending_index: None,
    pending_full: false,
    pending_relayed: false,
    pending: Map([]),
    block_retries: Map([]),
    inflight_bytes: 0L,
    last_serve_ms: 0L,
    deferred: [],
    deferred_keys: Map([]),
    events: [],
  }
  folder.peers.set(device, session)
  let fingerprint = index_fingerprint(local_entries(folder))
  push_outbound(session, IndexFingerprint(fingerprint))
}

///|
fn SessionActor::do_peer_close(
  self : SessionActor,
  folder_id : String,
  device : String,
) -> Unit {
  match self.folder_by_id(folder_id) {
    Some(folder) => {
      let _ = folder.peers.remove(device)
    }
    None => ()
  }
}

///|
fn SessionActor::do_drain_events(
  self : SessionActor,
  folder_id : String,
  reply : @async.Queue[Array[SyncEventRecord]],
) -> Unit {
  let out : Array[SyncEventRecord] = []
  match self.folder_by_id(folder_id) {
    Some(folder) =>
      for _, session in folder.peers {
        for event in session.events {
          out.push(event)
        }
        session.events.clear()
      }
    None => ()
  }
  let _ : Bool = reply.try_put(out) catch { _ => false }
}

///|
/// 周期泵(对齐 Rust `Peer::poll_timeouts` 的块重试与租约部分):
/// 到期块重发 / 放弃、租约衰减、限速延迟队列重放。
async fn SessionActor::do_poll_timeouts(
  self : SessionActor,
  now : Int64,
) -> Unit {
  for folder in self.folders {
    for _, session in folder.peers {
      poll_block_retries(session, now)
      decay_serve_lease(session, now)
      self.pump_deferred(folder, session)
    }
  }
}

///|
/// 驱动层回账:一帧块响应已写出,释放窗口额度并重放延迟队列
/// (对齐 Rust 驱动层写完帧后调 `pump_deferred` 的口径)。
async fn SessionActor::do_block_sent(
  self : SessionActor,
  folder_id : String,
  device : String,
  bytes : Int32,
) -> Unit {
  let folder = match self.folder_by_id(folder_id) {
    Some(f) => f
    None => return
  }
  match folder.peers.get(device) {
    Some(session) => {
      release_send_window(session, bytes)
      self.pump_deferred(folder, session)
    }
    None => ()
  }
}

///|
/// 重放延迟队列:有额度就发,没额度就重新排队(对齐 Rust `pump_deferred`)。
async fn SessionActor::pump_deferred(
  self : SessionActor,
  folder : Folder,
  session : PeerSession,
) -> Unit {
  if session.deferred.length() == 0 {
    return
  }
  let queued = session.deferred
  session.deferred = []
  session.deferred_keys.clear()
  for request in queued {
    self.serve_block(folder, session, request)
  }
}

// ==================== 入站消息 ====================

///|
/// 处理一条对端 wire 消息。索引先暂存(等 `ApplyPlan` 规划执行);
/// 指纹 / 回执 / 块请求 / 块响应即时处理(协议控制流不等批量)。
async fn SessionActor::do_peer_message(
  self : SessionActor,
  folder_id : String,
  device : String,
  message : @net.WireMessage,
) -> Unit {
  let folder = match self.folder_by_id(folder_id) {
    Some(f) => f
    None => return
  }
  let session = match folder.peers.get(device) {
    Some(s) => s
    None => return // 未知会话:连接尚未挂载或已拆除,整条丢弃
  }
  match message {
    Index(payload~, full~, relayed~, ..) =>
      // 索引体:base64 → JSON → 条目。线上数据不可信,畸形整条丢弃。
      match decode_index_payload(payload) {
        Some(entries) => {
          // 增量轮次绝不清在途接收(「消息里没提到」≠「对端没有了」);
          // 全量轮次丢弃上一轮的在途块重试(条目集合已被完整声明,对齐
          // Rust `pending_blocks.clear()`),重规划后 open_receive 重新登记。
          if full == Some(true) {
            session.block_retries.clear()
          }
          session.pending_index = Some(entries)
          session.pending_full = full == Some(true)
          session.pending_relayed = relayed == Some(true)
        }
        None => ()
      }
    IndexFingerprint(fingerprint~, ..) => {
      // 指纹一致 → 互免全量;不一致 → 请求对端全量(两侧对称,各自都会
      // 发起,于是两侧都拿到对方的全量)。TODO:2s 无应答的兜底全量。
      let mine = index_fingerprint(local_entries(folder))
      if fingerprint == mine {
        push_outbound(session, IndexAck)
      } else {
        push_outbound(session, IndexRequest)
      }
    }
    IndexAck(..) => ()
    IndexRequest(..) => send_full_snapshot(folder, session)
    BlockRequest(payload~, ..) => self.serve_block(folder, session, payload)
    BlockResponse(payload~, ..) => on_block_response(folder, session, payload)
    Control(..) => () // 控制面不进会话层(由上层全局路由)
  }
}

///|
/// base64 索引载荷 → 条目;任何一环失败都返回 None(丢弃整条消息)。
fn decode_index_payload(payload : String) -> Array[@net.WireEntry]? {
  try {
    let body = @utf8.decode_lossy(@base64.decode(payload))
    Some(@net.decode_index(body))
  } catch {
    _ => None
  }
}

///|
/// 发本机全量索引(对应 Rust `send_full_snapshot`)。占位条目不上线
/// (与 encodeIndex / 指纹同一口径,否则「指纹相等但全量不同」)。
fn send_full_snapshot(folder : Folder, session : PeerSession) -> Unit {
  let wire : Array[@net.WireEntry] = []
  for _, entry in folder.local_index {
    if !entry.placeholder {
      wire.push(wire_of(entry))
    }
  }
  push_outbound(session, Entries(entries=wire, full=true, relayed=false))
}

// ==================== 规划与执行 ====================

///|
/// 执行某目录各会话已收下的索引:过滤 → 规划 → 逐动作执行。
async fn SessionActor::do_apply_plan(self : SessionActor, id : String) -> Unit {
  let folder = match self.folder_by_id(id) {
    Some(f) => f
    None => return
  }
  for _, session in folder.peers {
    let entries = match session.pending_index {
      Some(items) => items
      None => continue // 没有待规划的索引,跳过这条会话
    }
    session.pending_index = None
    self.execute_plan(
      folder,
      session,
      entries,
      session.pending_full,
      session.pending_relayed,
    )
  }
}

///|
/// 一次索引批次的规划与执行。对应 Rust `Peer::on_peer_index` 的主循环;
/// delete 分支比较「哪一侧的墓碑更新」而不是「本地是不是墓碑」—— 两侧都是
/// 墓碑但版本不同时按后者判断会永远回推旧墓碑,版本永不收敛。
async fn SessionActor::execute_plan(
  self : SessionActor,
  folder : Folder,
  session : PeerSession,
  wire_entries : Array[@net.WireEntry],
  full : Bool,
  relayed : Bool,
) -> Unit {
  // 入向闸门:硬忽略(ADR-0008)+ 本机忽略规则(ADR-0012,活条目与
  // 墓碑一律丢弃 —— 被忽略路径的本地改动没有索引保护,收下会被覆盖)。
  let remote : Map[String, Entry] = Map([])
  let remote_core : Map[String, @core.IndexEntry] = Map([])
  for wire in wire_entries {
    if @core.is_hard_ignored(wire.path) ||
      folder.rules.is_ignored(wire.path, false) {
      continue
    }
    let entry = entry_of_wire(wire)
    remote.set(wire.path, entry)
    remote_core.set(wire.path, core_of(entry))
  }
  // 本地规划视图
  let local_core : Map[String, @core.IndexEntry] = Map([])
  for _, entry in folder.local_index {
    local_core.set(entry.path, core_of(entry))
  }
  let actions = if full {
    @core.build_plan(local_core, remote_core)
  } else {
    @core.build_delta_plan(local_core, remote_core)
  }
  let sends : Array[@net.WireEntry] = []
  for action in actions {
    let path = action.path()
    if is_paused_path(folder, path) {
      continue // 冻结路径:既不接收也不外推
    }
    match action {
      Send(..) =>
        // Send 携带的是本地条目(规划判本地较新)
        if !folder.receive_only {
          match folder.local_index.get(path) {
            Some(local_entry) => sends.push(wire_of(local_entry))
            None => () // 规划后本地条目消失:下一轮扫描处理
          }
        }
      Delete(..) => {
        let remote_entry = remote_core.get(path)
        match @core.compare_file_state(local_core.get(path), remote_entry) {
          LocalNewer => {
            let remote_is_tombstone = match remote_entry {
              Some(r) => r.deleted
              None => false
            }
            // 两侧都是墓碑时不推:旧版对端收到较新墓碑会回推它的旧墓碑,
            // 两端各推各的,版本永不收敛(2026-10-12 事故)。
            if !folder.receive_only && !remote_is_tombstone {
              match folder.local_index.get(path) {
                Some(local_entry) => sends.push(wire_of(local_entry))
                None => ()
              }
            }
          }
          RemoteNewer =>
            match remote.get(path) {
              Some(tomb) => {
                folder.executor.apply_delete(folder.index, path, tomb) catch {
                  e =>
                    println(
                      "应用对端删除失败(\{path}): \{@debug.to_string(e)}",
                    )
                }
                folder.local_index.set(path, tomb)
                // 该路径已在对端消失:中止在途接收(连带块重试台账),
                // 避免迟到块 / 重发把它复活。中间态作废:内容永远没人来续了
                match session.pending.remove_and_get(path) {
                  Some(p) => p.store.abort(keep_partial=false)
                  None => ()
                }
                purge_block_retries(session, path)
                session.events.push({
                  path,
                  direction: "remote",
                  action: "delete",
                })
              }
              None => ()
            }
          _ => ()
        }
      }
      Receive(..) =>
        match remote.get(path) {
          Some(remote_entry) =>
            self.open_receive(folder, session, path, remote_entry, None, false)
          None => ()
        }
      Conflict(..) =>
        match remote.get(path) {
          Some(remote_entry) =>
            self.resolve_conflict(
              folder, session, path, remote_entry, relayed, sends,
            )
          None => ()
        }
    }
  }
  // 外推(send_delta):过滤硬忽略,一条增量索引消息
  if sends.length() > 0 && !folder.receive_only {
    let wire : Array[@net.WireEntry] = []
    for entry in sends {
      if !@core.is_hard_ignored(entry.path) {
        wire.push(entry)
      }
    }
    if wire.length() > 0 {
      push_outbound(session, Entries(entries=wire, full=false, relayed=false))
    }
  }
}

///|
/// 冲突分支(对应 Rust `Peer::on_peer_index` 的 conflict 分):
///  - receive-only / 中转来的陈旧副本 → 按接收处理(不构成真冲突);
///  - 字节级一致的「并发」→ 保本地合并版本,不拉块;
///  - 策略(local-wins / newest-wins)判得出胜负 → 按胜负;
///  - KeepBoth(或判不出)→ 拉回远端内容,本地保留为 `.sync-conflict-` 副本。
async fn SessionActor::resolve_conflict(
  self : SessionActor,
  folder : Folder,
  session : PeerSession,
  path : String,
  remote_entry : Entry,
  relayed : Bool,
  sends : Array[@net.WireEntry],
) -> Unit {
  // 本端是否真的改过:版本向量里带本机计数 > 0 才算;否则只是从别处
  // 同步来的陈旧副本,与中转来的并发版本不构成真冲突。
  let genuine_local_edit = match folder.local_index.get(path) {
    Some(l) =>
      match l.version.get(self.device_id) {
        Some(count) => count > 0L
        None => false
      }
    None => false
  }
  if folder.receive_only || (relayed && !genuine_local_edit) {
    self.open_receive(folder, session, path, remote_entry, None, false)
    return
  }
  let local_stored = folder.local_index.get(path)
  // 字节级一致:定长块哈希列表相等 ⟺ 字节完全一致(两台机器各有一份
  // 同一目录时首连互判 concurrent,其实内容相同)。
  let byte_identical = match local_stored {
    Some(l) =>
      !l.deleted &&
      !l.placeholder &&
      !remote_entry.deleted &&
      l.blocks.length() == remote_entry.blocks.length() &&
      blocks_equal(l.blocks, remote_entry.blocks)
    None => false
  }
  if byte_identical {
    match local_stored {
      Some(l) => {
        let keep = folder.executor.apply_conflict_keep_local(
          folder.index,
          l,
          remote_entry,
        )
        folder.local_index.set(path, keep)
        session.events.push({ path, direction: "local", action: "conflict", })
      }
      None => ()
    }
    return
  }
  // 策略判定:只介入「真正的双活内容并发」,任一侧是墓碑不判胜负。
  // (墓碑并发交由 complete_receive 的 apply_conflict 双删分支合并。)
  let mut handled = false
  if !(folder.conflict_policy is KeepBoth) && !remote_entry.deleted {
    match local_stored {
      Some(l) =>
        if !l.deleted {
          let remote_wins : Bool? = match folder.conflict_policy {
            LocalWins => Some(false)
            NewestWins =>
              match (l.mtime, remote_entry.mtime) {
                (Some(lt), Some(rt)) =>
                  if rt > lt {
                    Some(true)
                  } else if lt > rt {
                    Some(false)
                  } else {
                    None
                  }
                _ => None
              }
            KeepBoth => None
          }
          match remote_wins {
            Some(true) => {
              self.open_receive(
                folder,
                session,
                path,
                remote_entry,
                None,
                false,
              )
              handled = true
            }
            Some(false) => {
              let keep = folder.executor.apply_conflict_keep_local(
                folder.index,
                l,
                remote_entry,
              )
              folder.local_index.set(path, keep)
              sends.push(wire_of(keep))
              session.events.push({
                path,
                direction: "local",
                action: "conflict",
              })
              handled = true
            }
            None => ()
          }
        }
      None => ()
    }
  }
  // KeepBoth(或策略判不出胜负):拉回远端内容,本地留冲突副本
  if !handled {
    self.open_receive(folder, session, path, remote_entry, local_stored, true)
  }
}

///|
fn blocks_equal(a : Array[String], b : Array[String]) -> Bool {
  if a.length() != b.length() {
    return false
  }
  for i in 0..<a.length() {
    if a[i] != b[i] {
      return false
    }
  }
  true
}

///|
/// 开(或续)一条在途接收:块落进磁盘中间态,只对缺的块发请求
/// (空文件无块可请求,直接落地)。
/// 认领台账未移植:每目录每设备至多一条会话,不存在同设备去重(TODO)。
async fn SessionActor::open_receive(
  self : SessionActor,
  folder : Folder,
  session : PeerSession,
  path : String,
  remote_entry : Entry,
  local_entry : Entry?,
  is_conflict : Bool,
) -> Unit {
  // 同路径旧接收(重规划 / 重连):先把未交代的块交代干净(保留中间态),
  // 再开新句柄 —— 否则旧句柄未 commit 的块进度会被新位图覆盖丢失。
  match session.pending.get(path) {
    Some(old) => old.store.abort(keep_partial=true)
    None => ()
  }
  // 开(或续)磁盘中间态:开不了(路径越界 / 盘满)按本次收不了处理,
  // 下一轮规划会重试。重连续传:manifest 指纹匹配时只请求缺的块。
  let store = PartialStore::begin(folder.executor.root, remote_entry, false) catch {
    e => {
      println("开启接收中间态失败(\{path}): \{@debug.to_string(e)}")
      return
    }
  }
  let pending : PendingReceive = {
    is_conflict,
    entry: remote_entry,
    local_entry,
    store,
  }
  if remote_entry.blocks.length() == 0 {
    // 空文件:无块可请求,立即落地(否则「新建空文件」永远不出现)
    complete_receive(folder, session, path, pending)
    return
  }
  session.pending.set(path, pending)
  let now = now_ms()
  for i in store.missing_slots() {
    let request : @net.WireBlockRequest = {
      device_id: self.device_id,
      path,
      block_index: i.to_int64(),
      hash: remote_entry.blocks[i],
      priority: None,
      cdc: None, // CDC 分块请求未移植(TODO)
    }
    push_outbound(session, BlockRequest(request))
    // 登记重试台账:超时未响应由 PollTimeouts 驱动重发(见 reliability.mbt)
    track_block_request(session, request, now)
  }
}

///|
/// 收到块响应:以 pending 为准校验(哈希对不上整块丢弃 —— 防对端回填
/// 自洽但错误的块),收齐即落地。
async fn on_block_response(
  folder : Folder,
  session : PeerSession,
  response : @net.WireBlockResponse,
) -> Unit {
  let pending = match session.pending.get(response.path) {
    Some(p) => p
    None => return
  }
  let index = response.block_index
  if index < 0L || index >= pending.entry.blocks.length().to_int64() {
    return // 越界索引会污染拼装布局
  }
  let slot = index.to_int()
  let expected = pending.entry.blocks[slot]
  if response.hash != expected {
    return
  }
  let decoded : Bytes? = Some(@base64.decode(response.data)) catch { _ => None }
  let data = match decoded {
    Some(d) => d
    None => return
  }
  if @core.hash_block(data) != expected {
    return
  }
  // 重复响应不重复落盘(append 幂等);store 落盘前再验一次哈希与长度
  pending.store.append(slot, data) catch {
    e => {
      println(
        "块落盘失败(\{response.path}#\{slot}): \{@debug.to_string(e)}",
      )
      return
    }
  }
  // 该块有了着落:重试台账出队
  untrack_block_response(session, response.path, index)
  if pending.store.is_full() {
    complete_receive(folder, session, response.path, pending)
  }
}

///|
/// 收齐落地:从磁盘中间态读回整份内容,按冲突 / 普通接收走 executor 现有的
/// tmp → fsync → 验块 → rename 管线,再回读索引库同步内存索引。
/// 落地失败也从 pending 摘除,但**中间态保留**(下次 open_receive 从位图续传,
/// 或由扫描器按 TTL 回收)—— 半途而废的接收下一轮接着写。
async fn complete_receive(
  folder : Folder,
  session : PeerSession,
  path : String,
  pending : PendingReceive,
) -> Unit {
  let is_new = !folder.local_index.contains(path)
  let content = pending.store.read_content() catch {
    e => {
      println("读取接收中间态失败(\{path}): \{@debug.to_string(e)}")
      let _ = session.pending.remove(path)
      purge_block_retries(session, path)
      return
    }
  }
  // 冲突分支:本地条目还在且是活条目才走 apply_conflict(本地内容保留为
  // 副本);双方都已删除 / 本地已消失则退回普通落地。
  let conflict_local : Entry? = if pending.is_conflict {
    match pending.local_entry {
      Some(l) => if l.deleted { None } else { Some(l) }
      None => None
    }
  } else {
    None
  }
  try {
    match conflict_local {
      Some(local_entry) => {
        let _ = folder.executor.apply_conflict(
          folder.index,
          path,
          local_entry,
          pending.entry,
          content,
          session.remote_device_id,
        )
      }
      None =>
        if pending.entry.deleted {
          // 防御:墓碑不落盘(规划不会把墓碑送进 Receive,见 plan_path)
          folder.index.save_entry(pending.entry)
        } else {
          folder.executor.apply_file(folder.index, pending.entry, content)
        }
    }
    // 回读索引库:apply_file / apply_conflict 已把落地后的 mtime 写进条目
    match folder.index.get_entry(path) {
      Some(landed) => folder.local_index.set(path, landed)
      None => ()
    }
    let action = if is_new { "add" } else { "update" }
    session.events.push({ path, direction: "remote", action, })
    // 落地成功:tmp 已被 executor rename 带走,清掉 sidecar manifest
    remove_partial(pending.store.target_path())
  } catch {
    e => println("接收落地失败(\{path}): \{@debug.to_string(e)}")
  }
  let _ = session.pending.remove(path)
  purge_block_retries(session, path)
}

// ==================== 供块 ====================

///|
/// 对端要块:按本机索引定位条目,从盘上读出对应定长块回给对端。
/// 出口有两道闸门(见 reliability.mbt):发送窗口(读盘之前判 —— 读出来
/// 再挂起等于什么都没省)与限速令牌桶(读盘之后、上线之前按实际字节扣)。
/// 两道闸门拦下的请求都进延迟队列,由 `PollTimeouts` / `BlockSent` 重放。
/// 读不出来(文件已删 / 块越界 / 哈希不符)不回 —— 由对端的重试与放弃
/// 机制兜底。
async fn SessionActor::serve_block(
  self : SessionActor,
  folder : Folder,
  session : PeerSession,
  request : @net.WireBlockRequest,
) -> Unit {
  if request.cdc == Some(true) {
    return // CDC 块供应未移植(TODO)
  }
  if @core.is_hard_ignored(request.path) ||
    folder.rules.is_ignored(request.path, false) {
    return
  }
  let entry = match folder.local_index.get(request.path) {
    Some(e) => e
    None => return // 本机索引没有这条:不能声称供得出内容
  }
  if entry.deleted || entry.placeholder {
    return
  }
  let slot = request.block_index
  if slot < 0L || slot >= entry.blocks.length().to_int64() {
    return
  }
  let expected = entry.blocks[slot.to_int()]
  if request.hash != expected {
    return // 请求的哈希与本机索引对不上:版本已漂移,不发旧块
  }
  // 闸门一:发送窗口(按条目 size 估 wire 体积,不必读盘就能判)
  let remain = entry.size - slot * @core.BLOCK_SIZE.to_int64()
  let plain : Int32 = if remain > @core.BLOCK_SIZE.to_int64() {
    @core.BLOCK_SIZE
  } else if remain > 0L {
    remain.to_int()
  } else {
    0
  }
  if !has_send_room(session, wire_bytes_estimate(plain)) {
    defer_request(session, request)
    return
  }
  let resolved : String? = Some(folder.executor.resolve_path(request.path)) catch {
    _ => None // 路径越界 / 不安全:拒绝供块
  }
  let abs = match resolved {
    Some(a) => a
    None => return
  }
  match read_block_at(abs, slot) {
    Some(bytes) => {
      if @core.hash_block(bytes) != expected {
        return // 盘上内容与索引不符(本地改动未重扫):不发旧块
      }
      // 闸门二:目录级限速(扣的是实际字节;不够则延迟重放)
      match folder.limiter {
        Some(limiter) =>
          if !limiter.try_consume(bytes.length(), now_ms()) {
            defer_request(session, request)
            return
          }
        None => ()
      }
      let wire = wire_bytes_estimate(bytes.length())
      acquire_send_window(session, wire, now_ms())
      push_outbound(
        session,
        BlockResponse({
          device_id: self.device_id,
          path: request.path,
          block_index: slot,
          hash: expected,
          data: @base64.encode(bytes),
          cdc: None,
        }),
      )
      // 「发完释放」:帧已交给出站队列即视为发送完成,经 BlockSent 回账
      // 释放窗口额度(命令在当前命令处理完后立即被消化)。未来 WS 驱动层
      // 接线后应替换为「真正写完 socket 后回账」,那时的窗口才有网络
      // 背压语义;接线前额度由租约衰减兜底,不会永久关死。
      let acked : Bool = self.rx.try_put(
        BlockSent(
          folder=folder.id,
          remote_device_id=session.remote_device_id,
          bytes=wire,
        ),
      ) catch {
        _ => false
      }
      if !acked {
        // actor 自身已退出:额度无人消费,直接归还
        release_send_window(session, wire)
      }
    }
    None => ()
  }
}

///|
/// 顺序读出第 block_index 个定长块(`@fs` 无 seek:跳过前面的块)。
async fn read_block_at(abs : String, block_index : Int64) -> Bytes? {
  let file = @fs.open(abs, mode=ReadOnly) catch { _ => return None }
  defer file.close()
  let window : FixedArray[Byte] = FixedArray::make(@core.BLOCK_SIZE, b'\x00')
  let target = block_index.to_int()
  let mut current = 0
  let mut result : Bytes? = None
  let mut eof = false
  while !eof {
    // 必须循环读满:单次短读是 POSIX 允许的正常返回
    let mut filled = 0
    while filled < window.length() {
      let n = file.read(window, offset=filled, max_len=window.length() - filled) catch {
        _ => -1
      }
      if n <= 0 {
        eof = true
        break
      }
      filled += n
    }
    if filled == 0 {
      break // 目标块超出文件末尾
    }
    if current == target {
      result = Some(Bytes::from_array(window.exact_view(end=filled)))
      break
    }
    current += 1
  }
  result
}

// ==================== 快照 ====================

///|
/// 重新生成只读快照并整体替换。读侧永远看到完整的一份。
fn SessionActor::publish(self : SessionActor) -> Unit {
  let folders : Array[FolderStatus] = []
  let mut total_entries = 0L
  let mut total_tombstones = 0L
  for folder in self.folders {
    let counts : IndexCounts = folder.index.count_entries() catch {
      _ => { entries: 0L, tombstones: 0L, }
    }
    total_entries += counts.entries
    total_tombstones += counts.tombstones
    folders.push({
      id: folder.id,
      path: folder.root,
      paused: folder.paused,
      receive_only: folder.receive_only,
      peers: folder.peers.length(),
      entries: counts.entries,
      tombstones: counts.tombstones,
      conflicts: folder.conflict_count,
    })
  }
  self.cell.value = { folders, total_entries, total_tombstones, }
}

// ==================== 小工具 ====================

///|
/// 出站入队:队列已关 = 驱动层已退出,丢帧是预期行为。
fn push_outbound(session : PeerSession, frame : Outbound) -> Unit {
  let _ : Bool = session.sink.try_put(frame) catch { _ => false }
}

///|
/// 冻结路径判定(单文件暂停)。
fn is_paused_path(folder : Folder, path : String) -> Bool {
  for p in folder.paused_files {
    if p == path {
      return true
    }
  }
  false
}

///|
/// 本机内存索引的全部条目(含墓碑;指纹在函数内排除占位条目)。
fn local_entries(folder : Folder) -> Array[Entry] {
  let out : Array[Entry] = []
  for _, entry in folder.local_index {
    out.push(entry)
  }
  out
}

///|
/// daemon 条目 → wire 条目(mtime 原值上线;无则 0)。
fn wire_of(entry : Entry) -> @net.WireEntry {
  let version : Array[(String, Int64)] = []
  for key, value in entry.version {
    version.push((key, value))
  }
  {
    path: entry.path,
    version,
    size: entry.size,
    deleted: entry.deleted,
    blocks: entry.blocks,
    mtime: match entry.mtime {
      Some(t) => t.to_double()
      None => 0.0
    },
    cdh: entry.cdh,
    clens: entry.clens,
  }
}

///|
/// wire 条目 → daemon 条目(mtime 毫秒截断;占位恒 false)。
fn entry_of_wire(wire : @net.WireEntry) -> Entry {
  let (cdh, clens) = wire.cdc_view()
  let ms = @net.mtime_ms(wire.mtime)
  {
    path: wire.path,
    version: Map(wire.version),
    size: wire.size,
    deleted: wire.deleted,
    blocks: wire.blocks,
    cdh,
    clens,
    mtime: if ms > 0L {
      Some(ms)
    } else {
      None
    },
    placeholder: false,
  }
}

///|
/// daemon 条目 → core 规划条目(mtime / placeholder 不参与版本关系)。
fn core_of(entry : Entry) -> @core.IndexEntry {
  {
    path: entry.path,
    version: entry.version,
    size: entry.size,
    deleted: entry.deleted,
    blocks: entry.blocks,
    cdh: entry.cdh,
    clens: entry.clens,
  }
}
