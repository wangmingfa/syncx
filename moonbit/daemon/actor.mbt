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
///  - 初始交换的 2s 兜底全量已接线:指纹发出时挂死线,2s 无应答由周期泵
///    补发全量(见 INITIAL_INDEX_FALLBACK_MS / poll_initial_fallback);
///  - 中转(ADR-0014)与磁盘空间守卫未移植;
///  - CDC 块的请求与供应已移植:接收侧按 plan_cdc 规划口径并做本地预填差集
///    (对齐 Node requestMissingChunks),供应侧按本机 clens 前缀和供块。

///|
/// git 提交检测心跳的周期(周期泵节拍数):POLL_TICK_MS = 500ms × 10 = 5s,
/// 对齐 Node checkGitCommits 所在的 5s 扫描节拍。纯 git 命令产生的提交只动
/// .git(文件监听按硬忽略排除),检测时效靠这条心跳兜住;扫描轮尾的检测
/// (文件变更驱动)照旧并行存在,两路共用同一个观察器基线。
const GIT_CHECK_TICKS : Int32 = 10

///|
/// git 徽标刷新的节拍数(周期泵 500ms 一拍 × 60 = 30s):与 Node refreshGitBadges /
/// Rust spawn_git_counts_loop(GIT_COUNT_INTERVAL=30s)同节奏。
const GIT_BADGE_TICKS : Int32 = 60

///|
/// 时段状态巡检的节拍数(周期泵 500ms 一拍 × 120 = 60s):对齐 Node
/// checkScheduleTransitions 的 60s 巡检 —— 边界到点后最多 60s 内翻转生效;
/// 精确唤醒不再单独挂(远端 Linux 实测 spawn 定时器不可靠,60s 兜底已足,
/// 见 Node armScheduleWake 的注释)。
const SCHEDULE_TICKS : Int32 = 120

///|
/// 初始交换兜底全量的时限:指纹发出去 2s 内没有任何应答(指纹/ack/请求)
/// 就不再干等,主动补发本机全量(对齐 Rust `INITIAL_INDEX_FALLBACK_MS`)。
const INITIAL_INDEX_FALLBACK_MS : Int64 = 2000L

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
  /// git 提交同步:本机检测到新提交,通知对端镜像提交。载荷恒为
  /// ControlMessage::GitCommitNotify 变体(驱动层包成 Control 帧外发)。
  GitCommitNotify(@net.ControlMessage)
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
  /// git 提交同步:镜像提交成功(或工作树干净跳过)后由装配层回填该目录的
  /// 提交检测基线 —— 防止扫描轮把镜像提交误判为「本地新提交」再广播回去
  /// (死循环防护;对应 Node setGitBaseline 在会话层持有基线的口径)。
  GitBaseline(folder~ : String, hash~ : String)
  /// 配置热重载:装配层重读 config.json 后把新目录参数集投进来,actor 对账
  /// 重建目录态(见 do_reconfigure)。
  Reconfigure(specs~ : Array[FolderSpec])
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
  /// 按路径清单取某目录的本机索引条目(cli 镜像结算的内容对齐与漂移自愈
  /// 的准入判据数据源;索引无该路径的文件不回 —— 缺位即「索引无条目 →
  /// 未对齐」,含墓碑/占位在内的真实条目原样带回)。
  EntryLookup(
    folder~ : String,
    paths~ : Array[String],
    reply~ : @async.Queue[Array[Entry]]
  )
  /// 取走某目录各会话的运行期事件(同步记录)。
  DrainEvents(folder~ : String, reply~ : @async.Queue[Array[SyncEventRecord]])
  /// 周期泵:处理到期的块重试、租约衰减与限速重放。驱动层接 WS 后由
  /// 定时任务自动投递;测试可注入时钟快进(语义对齐 Rust `poll_timeouts`)。
  PollTimeouts(now~ : Int64)
  /// 同步时段上下文:全局规则 + 临时放行到期时刻(epoch ms,None = 无)。
  /// 装配层在启动与每次配置热重载后投递;override 路由设置/取消放行时也投,
  /// actor 即时重算横幅并在需要时补扫(对应 Node 的 applyPausedState +
  /// runScan 链路)。
  ApplySchedule(sync_schedule~ : @core.Schedule?, override_until~ : Int64?)
  /// git-unpushed 弹窗现查后回写的徽标缓存(与 Node listUnpushedByFolder
  /// 「现查同时把扫描缓存对齐到现查值」同款):弹窗所列与徽标当场一致,
  /// 不必等下一轮 30s 徽标循环。
  GitUnpushedObserved(folder~ : String, total~ : Int32)
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
  /// 目录卡「改动 N」徽标(独立循环每 30s 现查;见 refresh_git_badges)。
  git_changes : Int32
  /// 目录卡「未推送 N」徽标。
  git_unpushed : Int32
  /// 各会话在途接收的总条数(镜像提交的 drain 闸判据;Node receiveLedger
  /// 的等价物 —— 块未拉齐时通知先挂着,不把半套文件定格成提交)。
  in_flight_receives : Int32
}

///|
/// 单目录此刻的时段结论(对应 Node `ScheduleState`;JSON 折算在 api 包)。
pub(all) struct ScheduleStateRow {
  id : String
  inside : Bool
  /// 放行中:此刻无视全部时段约束。
  overridden : Bool
  /// "global" / "folder";None = 没被挡。
  blocked_by : String?
  /// 下一次可能翻转的时刻(epoch ms);None = 无约束。
  next_change_at : Int64?
  /// 规则的界面摘要(「工作日 09:00–23:00」),后端算好下发。
  summary : String
}

///|
/// 顶部横幅状态(对应 Node `ScheduleBanner`):是否该提示「当前不在同步
/// 时段内」+ 什么时候自动恢复。
pub(all) struct ScheduleBannerRow {
  visible : Bool
  /// 因时段而被挡住的目录数。
  blocked_by_schedule : Int32
  /// 目录总数。
  total : Int32
  next_change_at : Int64?
  override_until : Int64?
}

///|
/// 全局只读状态快照(对应 Rust `StatusSnapshot`)。progress / traffic 是
/// status 数据面字段(syncProgress / traffic 的结构化形态,JSON 折算在 api
/// 包),随 publish 每条命令后刷新 —— 聚合只遍历会话内存表,空闲时近乎零开销。
pub(all) struct StatusSnapshot {
  folders : Array[FolderStatus]
  total_entries : Int64
  total_tombstones : Int64
  /// 各目录进行中的同步进度(每目录每会话一条,仅非零项;见 progress.mbt)。
  progress : Array[SyncProgress]
  /// 传输字节账本快照(累计 + 已完成窗口采样;见 traffic.mbt)。
  traffic : TrafficStats
  /// 各目录此刻的时段结论(时段子系统;见 refresh_schedule)。
  schedule_states : Array[ScheduleStateRow]
  /// 顶部横幅状态。
  schedule_banner : ScheduleBannerRow?
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
  /// gitSync 模式(装配层从 config 折算;检测/镜像/中继三闸由
  /// git_sync_plan 推导,见 git.mbt)。
  git_sync : GitSyncMode
  /// gitStripCoAuthored:镜像提交时剔除 Co-Authored-By 尾注行。
  git_strip_co_authored : Bool
  /// 同步时段规则(装配层经 core.normalize_schedule 折算;None = 不设限)。
  schedule : @core.Schedule?
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
  /// 初始交换兜底死线:PeerOpen 发指纹时挂上,收到任一应答(指纹/ack/请求)
  /// 即摘除;到期未结算则补发本机全量(见 INITIAL_INDEX_FALLBACK_MS)。
  mut initial_deadline : Int64?
  /// 初始交换已结算(应答到达或兜底已发),结算后兜底不再触发。
  mut initial_settled : Bool
  /// 供块租约台账(路径 → 租约):「发送中」显示与文件级发送进度的真相源
  /// (serve_block 落账,聚合时懒清理过期项;见 progress.mbt)。
  serving : Map[String, ServeLease]
  /// 速率采样环:每块「真正发出/真正收下」记一笔,读时按滚动窗口平均
  /// (本地预填不记;见 progress.mbt 的 record_rate)。
  rate_samples : Array[RatePoint]
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
  /// 运行期可变字段(mut):配置热重载按新 spec 就地更新 —— 索引库、内存
  /// 索引与会话态跨重载保留,只有这几项跟随配置走。
  mut receive_only : Bool
  mut conflict_policy : ConflictPolicy
  mut paused : Bool
  paused_files : Array[String]
  mut conflict_count : Int32
  /// 目录卡 git 徽标缓存(独立循环每 30s 现查;与扫描/暂停/时段解耦,见
  /// GIT_BADGE_TICKS 与 refresh_git_badges)。
  mut git_changes : Int32
  mut git_unpushed : Int32
  /// remote_device_id → 会话(认领台账未移植:同设备至多一条连接,TODO)。
  peers : Map[String, PeerSession]
  /// 目录级限速令牌桶(maxBandwidthKbps;None = 不限,对齐 Node)。
  mut limiter : RateLimiter?
  /// gitSync 模式(检测/镜像/中继三闸由 git_sync_plan 推导;见 git.mbt)。
  mut git_sync : GitSyncMode
  /// 本地提交检测观察器(基线结算在 watcher 内部;首轮只记基线)。
  git_watcher : GitWatcher
  /// 同步时段规则(None = 不设限;热重载就地更新,见 do_reconfigure)。
  mut schedule : @core.Schedule?
}

///|
/// 会话状态机本体。所有方法都在同一个任务上调用(单线程事件循环保证)。
pub struct SessionActor {
  priv rx : @async.Queue[Cmd]
  priv device_id : String
  priv mut folders : Array[Folder]
  priv cell : SnapshotCell
  /// git 提交检测心跳的节拍计数(见 GIT_CHECK_TICKS;周期泵每 500ms 一拍)。
  priv mut git_tick : Int32
  /// git 徽标刷新的节拍计数(见 GIT_BADGE_TICKS;周期泵每 500ms 一拍)。
  priv mut badge_tick : Int32
  /// 本地提交通知的出口(装配层注入):检测到新提交后由它投递。送达保证
  /// (按目标设备记台账、离线补投、ack 销账)在装配层镜像循环实现;daemon
  /// 单测不注入时为空操作。
  priv on_git_notify : async (@net.ControlMessage) -> Unit
  /// 全局传输字节账本(累计 + 采样环;重启清零):发送在 serve_block 落账、
  /// 接收在 on_block_response 落账,快照随 publish 刷新(见 traffic.mbt)。
  priv traffic : TrafficLedger
  /// ===== 同步时段子系统(对齐 Node scheduleVerdictFor 一族)=====
  /// 全局同步时段(config.syncSchedule 的折算结果;ApplySchedule 注入)。
  priv mut sync_schedule : @core.Schedule?
  /// 临时放行到期时刻(epoch ms;None = 无放行)。
  priv mut schedule_override_until : Int64?
  /// 时段状态签名(见 check_schedule_transitions;"" = 尚未登记基线)。
  priv mut schedule_signature : String
  /// 时段巡检节拍计数(见 SCHEDULE_TICKS;周期泵每 500ms 一拍)。
  priv mut schedule_tick : Int32
  /// 本机时区(懒加载一次;解析失败退 UTC,判定永不锁死)。
  priv mut local_zone : @time.Zone?
  /// 最近一次刷新的时段状态行与横幅(随 Snapshot/poll 刷新,publish 直读;
  /// 与 Node「判定只在后端做一份,前端只渲染」同口径)。
  priv mut schedule_rows : Array[ScheduleStateRow]
  priv mut schedule_banner : ScheduleBannerRow?
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
/// 与 actor 往返一次取某目录指定路径的本机索引条目(cli 镜像结算的内容
/// 对齐与漂移自愈的数据源;actor 已退出返回空表)。回执到达即此前的命令
/// (如 ScanFolder 落地)都已处理完,读数是确定性的。
pub async fn ActorHandle::entry_lookup(
  self : ActorHandle,
  folder : String,
  paths : Array[String],
) -> Array[Entry] {
  let reply : @async.Queue[Array[Entry]] = @async.Queue(kind=Unbounded)
  if !self.send(EntryLookup(folder~, paths~, reply~)) {
    return []
  }
  reply.get()
}

///|
/// 按一份目录参数构造运行期目录态:打开/复用索引库、载入内存索引、建执行器
/// 与限速器。启动(启动失败 = fatal)与热重载(单个目录失败 = 记日志跳过,
/// actor 存活)共用;索引库按 index_path 命名 —— 同一目录重载后原库原索引
/// 原样接上,不存在「重载清索引」的坑。
fn make_folder(spec : FolderSpec) -> Folder raise IndexStoreError {
  let index = IndexStore::open(spec.index_path)
  let local_index : Map[String, Entry] = Map([])
  for entry in index.list_entries() {
    local_index.set(entry.path, entry)
  }
  {
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
    git_changes: 0,
    git_unpushed: 0,
    peers: Map([]),
    limiter: make_rate_limiter(spec.max_bandwidth_kbps),
    git_sync: spec.git_sync,
    git_watcher: { root: spec.root, mode: spec.git_sync, last_hash: None, },
    schedule: spec.schedule,
  }
}

///|
/// 按配置构造 actor(打开索引库并载入内存索引;失败如实上抛)。
pub fn new_session_actor(
  device_id : String,
  specs : Array[FolderSpec],
  on_git_notify~ : async (@net.ControlMessage) -> Unit = _ => (),
) -> SessionActor raise IndexStoreError {
  let folders : Array[Folder] = []
  for spec in specs {
    folders.push(make_folder(spec))
  }
  let now = now_ms()
  let actor : SessionActor = {
    rx: @async.Queue(kind=Unbounded),
    device_id,
    folders,
    cell: {
      value: {
        folders: [],
        total_entries: 0L,
        total_tombstones: 0L,
        progress: [],
        traffic: TrafficLedger::new(now).snapshot(now),
        schedule_states: [],
        schedule_banner: None,
      },
    },
    git_tick: 0,
    badge_tick: 0,
    on_git_notify,
    traffic: TrafficLedger::new(now),
    sync_schedule: None,
    schedule_override_until: None,
    schedule_signature: "",
    schedule_tick: 0,
    local_zone: None,
    schedule_rows: [],
    schedule_banner: None,
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
  on_git_notify~ : async (@net.ControlMessage) -> Unit = _ => (),
) -> ActorHandle raise IndexStoreError {
  let actor = new_session_actor(device_id, specs, on_git_notify~)
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
        @log.error("会话命令处理失败 {Detail}", [
          Json::string(@debug.to_string(e)),
        ])
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
    GitBaseline(folder~, hash~) => self.do_git_baseline(folder, hash)
    Reconfigure(specs~) => self.do_reconfigure(specs)
    ApplyPlan(id) => self.do_apply_plan(id)
    PeerOpen(folder~, remote_device_id~, sink~) =>
      self.do_peer_open(folder, remote_device_id, sink)
    PeerMessage(folder~, remote_device_id~, message~) =>
      self.do_peer_message(folder, remote_device_id, message)
    PeerClose(folder~, remote_device_id~) =>
      self.do_peer_close(folder, remote_device_id)
    Snapshot(reply~) => {
      // 状态读取时现算时段结论:横幅/徽标的判定要贴近响应时刻(与 Node
      // scheduleStates(now) 同口径;纯内存计算,单次开销可忽略)
      self.refresh_schedule()
      self.publish()
      let _ : Bool = reply.try_put(self.cell.snapshot()) catch { _ => false }
    }
    EntryLookup(folder~, paths~, reply~) =>
      self.do_entry_lookup(folder, paths, reply)
    DrainEvents(folder~, reply~) => self.do_drain_events(folder, reply)
    PollTimeouts(now~) => self.do_poll_timeouts(now)
    ApplySchedule(sync_schedule~, override_until~) => {
      self.sync_schedule = sync_schedule
      self.schedule_override_until = override_until
      // 即时生效:重算状态 + 签名对比触发补扫(放行设置/取消、全局时段
      // 改动都在这条路上落到运行态)
      self.check_schedule_transitions()
    }
    GitUnpushedObserved(folder~, total~) =>
      for f in self.folders {
        if f.id == folder {
          f.git_unpushed = total
        }
      }
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
/// 层统一记 Error。`quiet~` 供 git 心跳的静默扫描抑制「扫描完成」INF
/// (每 5s 一条会刷屏),完成日志降为 Debug;其余行为完全一致。
async fn SessionActor::do_scan(
  self : SessionActor,
  id : String,
  quiet~ : Bool = false,
) -> Unit {
  let folder = match self.folder_by_id(id) {
    Some(f) => f
    None => return
  }
  if folder.paused {
    return // 暂停(目录级):数据面整体停摆
  }
  // 时段闸(全局 ∩ 目录的交集判定,临时放行期间一律窗口内):窗口外与暂停
  // 同款停摆 —— 扫描不跑,本机改动不被发现也就不会被广播;边界翻转由
  // check_schedule_transitions 补扫(对齐 Node folderPausedNow 的时段分支)
  if !self.schedule_verdict_now(folder).inside {
    return
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
  if quiet {
    @log.debug(
      "扫描完成 {Folder}:改动 {Changed} 条,墓碑 {Tombs} 条,耗时 {Ms}ms(git 心跳静默扫描)",
      [
        Json::string(id),
        Json::number(diff.changed.length().to_double()),
        Json::number(diff.tombstones.length().to_double()),
        Json::number((now_ms() - started).to_double()),
      ],
    )
  } else {
    @log.info(
      "扫描完成 {Folder}:改动 {Changed} 条,墓碑 {Tombs} 条,耗时 {Ms}ms",
      [
        Json::string(id),
        Json::number(diff.changed.length().to_double()),
        Json::number(diff.tombstones.length().to_double()),
        Json::number((now_ms() - started).to_double()),
      ],
    )
  }
  folder.conflict_count = diff.conflict_count
  // 墓碑:本地已删除 → 移回收站 + 写索引与内存索引(冻结路径跳过)
  for tomb in diff.tombstones {
    if is_paused_path(folder, tomb.path) {
      continue
    }
    folder.executor.apply_delete(folder.index, tomb.path, tomb) catch {
      e =>
        @log.error("墓碑落地失败 {Path}: {Detail}", [
          Json::string(tomb.path),
          Json::string(@debug.to_string(e)),
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
  // git 提交检测挂扫描轮尾(与 Node checkGitCommits 同构):只处理启用了
  // 发送的模式;基线结算在 GitWatcher 内部 —— 首轮只记基线绝不重放历史,
  // 检测当轮推进基线,送达保证交给上层(镜像端的工作树/对端回执)。
  self.check_folder_git_commits(folder)
}

///|
/// 单目录的本地提交检测 + 广播(与 Node broadcastGitCommit 同口径):观察器
/// 发现新提交就构造 GitCommitNotify 推给该目录全部在线会话;基线在检测当轮
/// 推进(watcher 内部),送达保证交给上层(镜像端的工作树/对端回执)。
/// 检测节拍有两路:扫描轮尾(文件变更驱动)+ 周期泵心跳(见
/// GIT_CHECK_TICKS,对齐 Node checkGitCommits 的 5s 扫描节拍)—— 纯 git
/// 命令产生的提交只动 .git(被监听排除),靠心跳兜住检测时效。
async fn SessionActor::check_folder_git_commits(
  self : SessionActor,
  folder : Folder,
) -> Unit {
  if !git_sync_plan(folder.git_sync).watch_local {
    return
  }
  let info = folder.git_watcher.check_new_commit()
  match info {
    Some(commit) => {
      let notify : @net.ControlMessage = @net.ControlMessage::GitCommitNotify(
        from_device_id=self.device_id,
        folder_id=folder.id,
        commit_hash=commit.hash,
        commit_message=commit.full_message,
        changed_files=commit.changed_files,
        diff_stat=commit.diff_stat,
        commit_subjects=Some(commit.commit_subjects),
        parent_hash=commit.parent_hash,
        version=None,
        hostname=None,
        platform=None,
        runtime=None,
      )
      // 投递走装配层注入的回调(默认空操作):cli 镜像循环按目标设备记台账
      // —— 在线即发、离线挂账重连补投、ack 销账、上限放弃(可靠性语义见
      // cli/gitmirror.mbt);不再直接推会话出站队列,投递只有台账一条路,
      // 避免在线/离线两套路径各投一遍。
      let emit = self.on_git_notify
      emit(notify)
      @log.info(
        "git commit broadcast: {Folder} {Hash8} \"{Subject}\" ({Files})",
        [
          Json::string(folder.id),
          Json::string(commit.hash[0:8].to_owned()),
          Json::string(commit.message),
          Json::string(git_files_desc(commit.changed_files)),
        ],
      )
    }
    None => ()
  }
}

// ==================== 会话挂载 / 拆除 ====================

///|
/// 回填 git 提交检测基线(镜像提交成功 / 干净树跳过后由装配层调用;
/// 死循环防护的一半 —— 另一半是装配层 processedRemoteCommits 去重)。
fn SessionActor::do_git_baseline(
  self : SessionActor,
  folder_id : String,
  hash : String,
) -> Unit {
  match self.folder_by_id(folder_id) {
    Some(folder) => folder.git_watcher.last_hash = Some(hash)
    None => ()
  }
}

///|
/// 按路径清单查本机索引条目(镜像结算的内容对齐与漂移自愈用;见
/// Cmd::EntryLookup)。一次往返整批取 —— 逐条查询会把一次 actor 往返放大成
/// 一次每文件。
fn SessionActor::do_entry_lookup(
  self : SessionActor,
  folder_id : String,
  paths : Array[String],
  reply : @async.Queue[Array[Entry]],
) -> Unit {
  let out : Array[Entry] = []
  match self.folder_by_id(folder_id) {
    Some(folder) =>
      for path in paths {
        match folder.local_index.get(path) {
          Some(entry) => out.push(entry)
          None => ()
        }
      }
    None => ()
  }
  let _ : Bool = reply.try_put(out) catch { _ => false }
}

///|
/// 配置热重载:按新目录参数集对账重建目录态。语义边界(对齐 Node 热重载
/// 能力范围,刻意收窄项见各行注释):
///   - 新增目录:开索引库(失败记日志跳过,actor 存活 —— 与启动期的 fatal
///     不同,热重载不能因一个坏目录掀桌)+ 首轮扫描;
///   - 移除目录:关全部会话出站队列(泵退出)、丢运行态;索引库文件留在盘上,
///     重新添加同一目录时原库原索引接上;
///   - 保留目录:索引库 / 内存索引 / 会话 / git 观察器基线全保留,仅就地更新
///     运行期字段(receive_only / conflict_policy / paused / 限速 / gitSync);
///   - 换根(改名 / 挪路径):等同删 + 建 —— 索引键按目录 id 不变,库接上,
///     会话拆除、观察器重建(基线重新起算,不重放历史);
///   - 会话拆除只关出站队列,传输层连接不动:装配层的会话面对账负责断开
///     不再共享任何目录的既有连接(见 cli reload 回调)。
async fn SessionActor::do_reconfigure(
  self : SessionActor,
  specs : Array[FolderSpec],
) -> Unit {
  let existing : Map[String, Folder] = Map([])
  for folder in self.folders {
    existing.set(folder.id, folder)
  }
  let rebuilt : Array[Folder] = []
  let fresh : Array[String] = []
  for spec in specs {
    match existing.get(spec.id) {
      Some(folder) =>
        if normalize_path(folder.root) == normalize_path(spec.root) {
          // 保留目录:就地更新运行期字段
          folder.receive_only = spec.receive_only
          folder.conflict_policy = spec.conflict_policy
          folder.paused = spec.paused
          folder.limiter = make_rate_limiter(spec.max_bandwidth_kbps)
          folder.git_sync = spec.git_sync
          folder.git_watcher.mode = spec.git_sync
          folder.schedule = spec.schedule
          rebuilt.push(folder)
        } else {
          // 换根:删 + 建
          for _, session in folder.peers {
            session.sink.close(clear=true)
          }
          let opened : Folder? = Some(make_folder(spec)) catch {
            e => {
              @log.error(
                "配置重载:目录 {Folder} 换根后索引库打开失败,跳过 ({Detail})",
                [
                  Json::string(spec.id),
                  Json::string(IndexStoreError::to_text(e)),
                ],
              )
              None
            }
          }
          match opened {
            Some(f) => {
              rebuilt.push(f)
              fresh.push(f.id)
            }
            None => ()
          }
        }
      None => {
        // 新增目录
        let opened : Folder? = Some(make_folder(spec)) catch {
          e => {
            @log.error(
              "配置重载:新目录 {Folder} 索引库打开失败,跳过 ({Detail})",
              [Json::string(spec.id), Json::string(IndexStoreError::to_text(e))],
            )
            None
          }
        }
        match opened {
          Some(f) => {
            rebuilt.push(f)
            fresh.push(f.id)
          }
          None => ()
        }
      }
    }
  }
  // 移除的目录:关会话出站队列(泵退出)、丢运行态
  let kept : Map[String, Bool] = Map([])
  for f in rebuilt {
    kept.set(f.id, true)
  }
  for folder in self.folders {
    if !kept.contains(folder.id) {
      for _, session in folder.peers {
        session.sink.close(clear=true)
      }
      @log.info(
        "配置重载:目录 {Folder} 已移除,运行态随之拆除",
        [Json::string(folder.id)],
      )
    }
  }
  self.folders = rebuilt
  self.publish()
  // 新目录首轮扫描(基线 / 索引入库;paused 目录 do_scan 自行退闸)
  for id in fresh {
    self.do_scan(id)
  }
}

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
    initial_deadline: None,
    initial_settled: false,
    serving: Map([]),
    rate_samples: [],
    events: [],
  }
  folder.peers.set(device, session)
  let fingerprint = index_fingerprint(local_entries(folder))
  push_outbound(session, IndexFingerprint(fingerprint))
  // 兜底死线与指纹同时挂:对端旧版不认指纹、或应答在路上丢失时,这条
  // 死线是初始交换从「永远干等」里出来的唯一出路(到期补发全量)。
  session.initial_deadline = Some(now_ms() + INITIAL_INDEX_FALLBACK_MS)
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
/// 到期块重发 / 放弃、租约衰减、限速延迟队列重放;每 GIT_CHECK_TICKS 拍
/// 对 gitSync 发送端目录跑一轮**静默扫描**:纯 git 命令产生的提交只动被
/// 监听排除的 .git,检测时效靠这条心跳兜住(节拍对齐 Node checkGitCommits
/// 的 5s 扫描周期)。关键在「先扫后检」的次序 —— 索引增量与提交通知进
/// 同一个会话出站队列,FIFO 保证对端先收到内容增量、再收到通知,接收侧
/// 的 drain 闸(in-flight)因此总有账可查,不会拿空账提前结算。
async fn SessionActor::do_poll_timeouts(
  self : SessionActor,
  now : Int64,
) -> Unit {
  for folder in self.folders {
    for _, session in folder.peers {
      poll_block_retries(session, now)
      decay_serve_lease(session, now)
      poll_initial_fallback(folder, session, now)
      self.pump_deferred(folder, session)
    }
  }
  self.git_tick = self.git_tick + 1
  if self.git_tick >= GIT_CHECK_TICKS {
    self.git_tick = 0
    for folder in self.folders {
      if git_sync_plan(folder.git_sync).watch_local {
        self.do_scan(folder.id, quiet=true)
      }
    }
  }
  // git 徽标独立刷新(与 Node refreshGitBadges / Rust spawn_git_counts_loop
  // 同构):与扫描、暂停、时段全部解耦 —— 收窄轮/暂停/窗口外都不再让徽标
  // 长期停在旧值(2026-11-05 远端实测徽标整排消失的根因)。
  self.badge_tick = self.badge_tick + 1
  if self.badge_tick >= GIT_BADGE_TICKS {
    self.badge_tick = 0
    self.refresh_git_badges()
  }
  // 时段巡检独立 60s 一拍(见 SCHEDULE_TICKS):边界到点后最多 60s 内翻转
  // 生效并补扫;判定纯内存,Snapshot 每次也会现算最新状态。
  self.schedule_tick = self.schedule_tick + 1
  if self.schedule_tick >= SCHEDULE_TICKS {
    self.schedule_tick = 0
    self.check_schedule_transitions()
  }
}

///|
/// 现查全部目录的 git 徽标(改动条数 / 未推送提交数):目录卡的事实陈述,
/// 连手动暂停/时段外的目录也照刷 —— 徽标说真话,同步归同步。git 失败
/// (None)按 0 处理,徽标不出现。
async fn SessionActor::refresh_git_badges(self : SessionActor) -> Unit {
  for folder in self.folders {
    folder.git_changes = match uncommitted_change_count(folder.root) {
      Some(n) => n
      None => 0
    }
    folder.git_unpushed = match count_unpushed_commits(folder.root) {
      Some(n) => n
      None => 0
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
/// 初始交换已结算:死线摘除,兜底不再触发(对齐 Rust `settle_initial`)。
fn settle_initial_exchange(session : PeerSession) -> Unit {
  session.initial_deadline = None
  session.initial_settled = true
}

///|
/// 初始交换兜底:指纹发出去 2s 仍未结算 → 主动补发本机全量(对齐 Rust
/// `poll_timeouts` 的兜底分支)。对端是旧版(不认指纹)或应答丢失时,这是
/// 从「永远干等」里出来的唯一出路;对端重复收到全量按并集规划,幂等。
fn poll_initial_fallback(
  folder : Folder,
  session : PeerSession,
  now : Int64,
) -> Unit {
  match session.initial_deadline {
    Some(deadline) =>
      if now >= deadline {
        session.initial_deadline = None
        if !session.initial_settled {
          session.initial_settled = true
          send_full_snapshot(folder, session)
        }
      }
    None => ()
  }
}

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
      // 任一初始交换应答都先结算兜底死线(对齐 Rust settle_initial):
      // 指纹一致 → 互免全量;不一致 → 请求对端全量(两侧对称,各自都会
      // 发起,于是两侧都拿到对方的全量)。
      settle_initial_exchange(session)
      let mine = index_fingerprint(local_entries(folder))
      if fingerprint == mine {
        push_outbound(session, IndexAck)
      } else {
        push_outbound(session, IndexRequest)
      }
    }
    IndexAck(..) => settle_initial_exchange(session)
    IndexRequest(..) => {
      settle_initial_exchange(session)
      send_full_snapshot(folder, session)
    }
    BlockRequest(payload~, ..) => self.serve_block(folder, session, payload)
    BlockResponse(payload~, ..) =>
      self.on_block_response(folder, session, payload)
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
/// daemon 条目是否带可用 CDC 视图:cdh 与 clens 等长且非空(与 Node
/// `cdcUsable` 及 wire 侧 `has_cdc_view` 同一判据;不满足时绝不半套上线)。
fn entry_has_cdc_view(entry : Entry) -> Bool {
  match (entry.cdh, entry.clens) {
    (Some(h), Some(l)) => h.length() > 0 && h.length() == l.length()
    _ => false
  }
}

///|
/// 本轮接收是否按 CDC 口径规划(对齐 Node `planCdc`)。判据全在「本端能不能
/// 差集」:对端条目带 cdh/clens,本机对应条目也存在、不是墓碑 / 占位、且同样
/// 带 CDC 视图(实体文件在盘上)才启用 —— 本机没有 CDC 视图就无差集可算,
/// 按定长口径。
/// 「对端供不出 CDC 块」不构成风险:对端能把 cdh 宣告出来,就必然能按自己
/// 算的 clens 供块(同一份内容的纯函数);真对不上(旧数据 / 竞态)接收端
/// 哈希闸门会拦下,走既有的有界重试 + 放弃 + 下轮收敛 —— 退化的是效率,
/// 不是正确性。
fn plan_cdc(remote_entry : Entry, local_entry : Entry?) -> Bool {
  if !entry_has_cdc_view(remote_entry) {
    return false
  }
  match local_entry {
    Some(l) => !l.deleted && !l.placeholder && entry_has_cdc_view(l)
    None => false
  }
}

///|
/// 开(或续)一条在途接收:块落进磁盘中间态,只对缺的块发请求
/// (空文件无块可请求,直接落地)。
/// 块口径在规划时刻定下(plan_cdc):CDC 与定长的槽位数、期望哈希、指纹
/// 全都不同,store 与后续校验统一按这次定下的口径走。
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
  // CDC 差集要用「本机此刻的条目」(对齐 Node localIndex.get(path)):
  // 调用方传入的 local_entry 只在冲突分支携带,普通 Receive 传 None,
  // 按内存索引现查 —— 否则普通接收永远无差集可算。
  let local_now : Entry? = match local_entry {
    Some(l) => Some(l)
    None => folder.local_index.get(path)
  }
  let cdc = plan_cdc(remote_entry, local_now)
  // 开(或续)磁盘中间态:开不了(路径越界 / 盘满)按本次收不了处理,
  // 下一轮规划会重试。重连续传:manifest 指纹匹配时只请求缺的块。
  let store = PartialStore::begin(folder.executor.root, remote_entry, cdc) catch {
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
  if cdc {
    // CDC 口径:先本地预填差集,只对真缺的槽位发块请求(这是 CDC 的核心收益)
    self.request_missing_chunks(folder, session, path, pending, local_now, now)
  } else {
    for i in store.missing_slots() {
      let request : @net.WireBlockRequest = {
        device_id: self.device_id,
        path,
        block_index: i.to_int64(),
        hash: remote_entry.blocks[i],
        priority: None,
        cdc: None,
      }
      push_outbound(session, BlockRequest(request))
      // 登记重试台账:超时未响应由 PollTimeouts 驱动重发(见 reliability.mbt)
      track_block_request(session, request, now)
    }
  }
}

///|
/// CDC 口径的缺失块请求(对齐 Node `requestMissingChunks`)。本地块按
/// 「哈希 → (偏移,长度)」的**集合成员**匹配:块边界由内容决定,插入 / 删除
/// 让整体错位后,块自身的哈希依然与本地文件里同一段字节吻合 —— 这正是定长
/// 下标匹配做不到的差集。偏移取本地 clens 前缀和;同哈希多块取最先出现的
/// 一处。读出的块仍逐块验哈希:本地文件可能在扫描与规划之间被改写,验不过
/// 就不信,自然回退网络请求。
async fn SessionActor::request_missing_chunks(
  self : SessionActor,
  folder : Folder,
  session : PeerSession,
  path : String,
  pending : PendingReceive,
  local_entry : Entry?,
  now : Int64,
) -> Unit {
  let cdh = match pending.entry.cdh {
    Some(h) => h
    None => return // store.begin 已按口径把关,这里防御兜底
  }
  // 本地 hash → (offset, length)(偏移是本地 clens 前缀和)
  let local_hits : Map[String, (Int64, Int64)] = Map([])
  match local_entry {
    Some(l) =>
      if !l.deleted && !l.placeholder && entry_has_cdc_view(l) {
        match (l.cdh, l.clens) {
          (Some(lh), Some(ll)) => {
            let mut lo = 0L
            for i in 0..<lh.length() {
              if !local_hits.contains(lh[i]) {
                local_hits.set(lh[i], (lo, ll[i]))
              }
              lo += ll[i]
            }
          }
          _ => ()
        }
      }
    None => ()
  }
  // 本地文件的绝对路径:解析不了(路径越界 / 不安全)就整体走网络
  let local_abs : String? = Some(folder.executor.resolve_path(path)) catch {
    _ => None
  }
  for i in pending.store.missing_slots() {
    if i >= cdh.length() {
      continue // 防御:store 布局与 cdh 不自洽时不发请求,交给下轮收敛
    }
    let hash = cdh[i]
    let mut filled = false
    if local_hits.contains(hash) {
      match local_abs {
        Some(abs) =>
          match local_hits.get(hash) {
            Some((offset, length)) => {
              let data = read_chunk_at(abs, offset, length.to_int())
              match data {
                Some(d) =>
                  // 本地命中也要验:盘上内容与本地索引可能已经不一致
                  if @core.hash_block(d) == hash {
                    let ok : Bool = try {
                      pending.store.append(i, d)
                      true
                    } catch {
                      _ => false // 落盘失败(盘满等):回退网络请求
                    }
                    filled = ok
                  }
                None => ()
              }
            }
            None => ()
          }
        None => ()
      }
    }
    if !filled {
      let request : @net.WireBlockRequest = {
        device_id: self.device_id,
        path,
        block_index: i.to_int64(),
        hash,
        priority: None,
        cdc: Some(true),
      }
      push_outbound(session, BlockRequest(request))
      track_block_request(session, request, now)
    }
  }
}

///|
/// 收到块响应:以 pending.store 为准校验(哈希对不上整块丢弃 —— 防对端
/// 回填自洽但错误的块),收齐即落地。槽位与期望哈希按 open_receive 规划
/// 定下的口径取(store.hashes:CDC 口径是 cdh,定长是 blocks),不看
/// entry.blocks —— 否则 CDC 响应会被定长布局整批拒掉。
/// 接收字节记账也在这里:块真的收下了才记(重复响应不记;本地预填不走
/// 这条路径,记的都是网络量),喂瞬时速率与全局流量账本。
async fn SessionActor::on_block_response(
  self : SessionActor,
  folder : Folder,
  session : PeerSession,
  response : @net.WireBlockResponse,
) -> Unit {
  let pending = match session.pending.get(response.path) {
    Some(p) => p
    None => return
  }
  let index = response.block_index
  if index < 0L || index >= pending.store.hashes.length().to_int64() {
    return // 越界索引会污染拼装布局
  }
  let slot = index.to_int()
  let expected = pending.store.hashes[slot]
  if response.hash != expected {
    return
  }
  let decoded : Bytes? = Some(@base64.decode(response.data)) catch { _ => None }
  let data = match decoded {
    Some(d) => d
    None => return
  }
  // 长度上限闸(对齐 Node:超大响应直接丢弃,避免哈希前先撑爆内存):
  // CDC 块 ≤ CDC_MAX_CHUNK,定长块 ≤ BLOCK_SIZE;精确长度由 append 复核
  let cap = if pending.store.cdc {
    @core.CDC_MAX_CHUNK
  } else {
    @core.BLOCK_SIZE
  }
  if data.length() > cap {
    return
  }
  if @core.hash_block(data) != expected {
    return
  }
  // 重复响应不重复落盘(append 幂等)、也不重复记账:槽位已有即视为重复
  // (对齐 Node 的 handle.has 早退闸);store 落盘前再验一次哈希与长度
  let fresh = !pending.store.has(slot)
  pending.store.append(slot, data) catch {
    e => {
      println(
        "块落盘失败(\{response.path}#\{slot}): \{@debug.to_string(e)}",
      )
      return
    }
  }
  // 该块有了着落:重试台账出队(口径与请求发出时一致,即 store 的规划口径)
  untrack_block_response(session, response.path, index, pending.store.cdc)
  // 该块真的收下了(重复响应已被上面挡掉):记一笔接收字节 —— 瞬时速率与
  // 全局流量账本共用这一笔(对齐 Node recordBytes(0, response.data.length))
  if fresh {
    let now = now_ms()
    record_rate(session, 0L, data.length().to_int64(), now)
    self.traffic.add_received(data.length().to_int64())
  }
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
/// 待供应块的定位结果:两种口径(定长 / CDC)统一成一份,serve_block 的
/// 闸门(发送窗口 / 路径越界 / 限速 / 发送记账)因此只有一份代码。
priv struct ServeSlot {
  /// 块下标(响应回填 block_index)。
  slot : Int32
  /// 本机索引里这块的哈希(响应回填它)。
  expected : String
  /// 块字节长度(发送窗口与限速按它算;CDC 口径 ≤ CDC_MAX_CHUNK)。
  length : Int32
  /// CDC 口径的块内偏移(本机 clens 前缀和;定长口径不用)。
  offset : Int64
  cdc : Bool
}

///|
/// 按请求定位本机待供应的块。定位不了一律返回 None(静默忽略),由对端的
/// 重试与放弃机制兜底:
///  - CDC 口径:按本机条目 clens 前缀和定位偏移,只供那一块。本机没有该路径
///    的 CDC 视图(旧数据 / 版本错位)时静默忽略 —— 错位是有界的(本机扫描
///    重算后下一轮宣告就带 cdh),且对端若真是旧版口径混发,接收端哈希闸门
///    自会拦下,不会落错内容。**不核对** request.hash:响应回填真实哈希,
///    对端认知错位时由接收端校验自然拦。
///  - 定长口径:槽位在 blocks 内,且请求哈希与本机索引一致(版本已漂移
///    不发旧块)。
fn locate_serve_slot(
  entry : Entry,
  request : @net.WireBlockRequest,
) -> ServeSlot? {
  let slot_i64 = request.block_index
  match request.cdc {
    Some(true) => {
      let cdh = match entry.cdh {
        Some(h) => h
        None => return None
      }
      let clens = match entry.clens {
        Some(l) => l
        None => return None
      }
      if cdh.length() == 0 || cdh.length() != clens.length() {
        return None
      }
      if slot_i64 < 0L || slot_i64 >= cdh.length().to_int64() {
        return None
      }
      let slot = slot_i64.to_int()
      let mut offset = 0L
      for i in 0..<slot {
        offset += clens[i]
      }
      let length = clens[slot]
      // 防御闸:本机扫描产出的 clens 恒在 [1, CDC_MAX_CHUNK] 内,越界说明
      // 数据被外部改过 —— 不供,接收端重试后走下轮收敛
      if length <= 0L || length > @core.CDC_MAX_CHUNK.to_int64() {
        return None
      }
      Some({
        slot,
        expected: cdh[slot],
        length: length.to_int(),
        offset,
        cdc: true,
      })
    }
    _ => {
      if slot_i64 < 0L || slot_i64 >= entry.blocks.length().to_int64() {
        return None
      }
      let slot = slot_i64.to_int()
      let expected = entry.blocks[slot]
      if request.hash != expected {
        return None // 请求的哈希与本机索引对不上:版本已漂移,不发旧块
      }
      let remain = entry.size - slot_i64 * @core.BLOCK_SIZE.to_int64()
      let length : Int32 = if remain > @core.BLOCK_SIZE.to_int64() {
        @core.BLOCK_SIZE
      } else if remain > 0L {
        remain.to_int()
      } else {
        0
      }
      Some({
        slot,
        expected,
        length,
        offset: slot_i64 * @core.BLOCK_SIZE.to_int64(),
        cdc: false,
      })
    }
  }
}

///|
/// 对端要块:按本机索引定位条目,从盘上读出对应块回给对端(定长按块下标,
/// CDC 按本机 clens 前缀和定位,见 locate_serve_slot)。
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
  let serve = match locate_serve_slot(entry, request) {
    Some(s) => s
    None => return
  }
  // 闸门一:发送窗口(按块长估 wire 体积,不必读盘就能判;CDC 传 clens[slot])
  if !has_send_room(session, wire_bytes_estimate(serve.length)) {
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
  let data : Bytes? = if serve.cdc {
    read_chunk_at(abs, serve.offset, serve.length)
  } else {
    read_block_at(abs, serve.slot.to_int64())
  }
  match data {
    Some(bytes) => {
      if @core.hash_block(bytes) != serve.expected {
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
      let now = now_ms()
      let wire = wire_bytes_estimate(bytes.length())
      acquire_send_window(session, wire, now)
      // 供块租约续期 + 文件级发送进度(按块去重,对端重试不重复计),随后发送
      // 字节落账:瞬时速率(每会话)与全局流量账本。帧已产出站队列即视为
      // 「真发出去了」—— 与 Node 在 handleBlockRequest 里 recordBytes 的位置
      // 同口径;延迟队列的重放也走这条路径,不重复不遗漏。
      mark_served(
        session,
        request.path,
        serve.slot.to_int64(),
        bytes.length().to_int64(),
        entry.size,
        now,
      )
      record_rate(session, bytes.length().to_int64(), 0L, now)
      self.traffic.add_sent(bytes.length().to_int64())
      push_outbound(
        session,
        BlockResponse({
          device_id: self.device_id,
          path: request.path,
          block_index: serve.slot.to_int64(),
          hash: serve.expected,
          data: @base64.encode(bytes),
          cdc: if serve.cdc {
            Some(true)
          } else {
            None
          },
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

///|
/// 定位读出 [offset, offset+length) 一段字节(CDC 供块与本地预填共用)。
/// 必须循环读满:单次定位读的短读是 POSIX 允许的正常返回;读不满 / 中途
/// EOF 返回 None —— 半截块的哈希必然对不上,不如直接回退网络请求。
async fn read_chunk_at(abs : String, offset : Int64, length : Int32) -> Bytes? {
  if length <= 0 {
    return None
  }
  let file = @fs.open(abs, mode=ReadOnly) catch { _ => return None }
  defer file.close()
  let buf : FixedArray[Byte] = FixedArray::make(length, b'\x00')
  let mut filled = 0
  while filled < length {
    let n = file.read_at(
      buf,
      position=offset + filled.to_int64(),
      offset=filled,
      len=length - filled,
    ) catch {
      _ => -1
    }
    if n <= 0 {
      return None
    }
    filled += n
  }
  Some(Bytes::from_array(buf.exact_view(end=filled)))
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
    // 在途接收总数:各会话认领台账的大小之和(镜像提交 drain 闸的判据)
    let mut in_flight = 0
    for _, session in folder.peers {
      in_flight += session.pending.length()
    }
    folders.push({
      id: folder.id,
      path: folder.root,
      paused: folder.paused,
      receive_only: folder.receive_only,
      peers: folder.peers.length(),
      entries: counts.entries,
      tombstones: counts.tombstones,
      conflicts: folder.conflict_count,
      git_changes: folder.git_changes,
      git_unpushed: folder.git_unpushed,
      in_flight_receives: in_flight,
    })
  }
  // syncProgress 聚合(status 数据面):每目录每会话一条、仅非零项(对齐
  // Node manager.getSyncProgress 的「仅非零项」过滤)。过期供块租约在聚合内
  // 懒清理;publish 随每条命令运行(周期泵 500ms 一拍),聚合只遍历会话的
  // pending/serving 两张内存表,空闲时近乎零开销。
  let now = now_ms()
  let progress : Array[SyncProgress] = []
  for folder in self.folders {
    for _, session in folder.peers {
      let item = aggregate_sync_progress(folder.id, session, now)
      if item.pending > 0 || item.sending > 0 || item.receiving > 0 {
        progress.push(item)
      }
    }
  }
  // 流量快照:顺手推进采样窗口 —— 跨过边界的已完成窗口闭合为样本(空闲窗口
  // 补零保持时间轴连续),未闭合的当前窗口不进 samples(见 traffic.mbt)
  self.cell.value = {
    folders,
    total_entries,
    total_tombstones,
    progress,
    traffic: self.traffic.snapshot(now),
    schedule_states: self.schedule_rows,
    schedule_banner: self.schedule_banner,
  }
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
