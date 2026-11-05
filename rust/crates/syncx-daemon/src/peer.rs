//! 一条对端连接上的会话层。对应 Node 侧 `src/peer.ts`。
//!
//! 这是「收到对端索引 → 规划 → 拉块/回推/删本地/立冲突」的全部逻辑。移植时有三处
//! 语义**必须逐字对齐**,否则症状都是「不崩、不报错、就是同步不动」:
//!
//!  1. **`full` 缺省按增量**(见 [`IndexMode`])。把增量当全量做并集规划,两端就会
//!     各自回推对方「没提到」的本地条目,形成回声死循环(2026-09-16 事故)。
//!  2. **delete 分支比较「哪一侧的墓碑更新」**,而不是「本地是不是墓碑」。两侧都是
//!     墓碑但版本不同时,按后者判断会永远回推自己那条旧墓碑,版本永不收敛,
//!     索引交换陷入 ~600 轮/秒的回声(2026-10-12 MoonUI 事故)。
//!  3. **增量轮次绝不清 pending / pending_blocks**。「消息里没提到」只说明这轮没提,
//!     不等于对端没有了 —— 清掉会把正在传的文件腰斩。
//!
//! 与 Node 的实现差异只有一处,是刻意的:Node 用 `setTimeout` 做块请求重试与租约
//! 过期,这里把截止时刻记在表里,由驱动循环周期性调 [`Peer::poll_timeouts`] 触发。
//! 好处是重试行为可以被测试用注入时钟逐帧驱动,不必真等 5 秒 / 30 秒。
//!
//! 共享状态(`local_index` / 认领台账)用 `Rc<RefCell<..>>`:同一共享目录上可能同时
//! 挂着多条连接,每条连接各有自己的 `Peer`,但它们必须看到同一份索引与同一本台账。
//! 单线程 actor 保证 `Rc` 安全(见 [`crate::actor`]),与 Node 单线程事件循环等价。

use std::cell::{Ref, RefCell, RefMut};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::rc::Rc;

use syncx_core::blockstore::{hash_block, BLOCK_SIZE, CDC_MAX_CHUNK};
use syncx_core::ignore::{is_hard_ignored, IgnoreRuleset};
use syncx_core::plan::{
    build_delta_plan, build_plan, compare_file_state, FileStateRelation, IndexEntry, PlanAction,
};
use syncx_core::version::merge_versions;
use syncx_net::wire::{WireBlockRequest, WireBlockResponse, WireEntry};

use crate::entry::StoredEntry;
use crate::executor::{
    file_mtime_ms, hash_file_views, resolve_share_path, slot_layout, LocalExecutor,
    MemoryReceiveHandle, ReceiveHandle,
};
use crate::fingerprint::index_fingerprint;
use crate::indexstore::IndexStore;
use crate::partial::now_ms;

/// 索引消息的两种语义。**缺省 = 增量**(见模块注释第 1 条)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum IndexMode {
    /// 本机索引的完整声明:接收方按并集规划。
    Full,
    /// 只包含本轮改动的那几条:接收方**只判消息里提到的路径**。
    #[default]
    Delta,
}

/* ==================== 协议常量(全部与 Node 同值) ==================== */

pub const BLOCK_REQUEST_TIMEOUT_MS: i64 = 5_000;
pub const MAX_BLOCK_RETRIES: u32 = 3;
/// 快速重试耗尽后的长间隔退避:继续重试而非立即丢弃条目。
pub const BLOCK_RETRY_LONG_MS: i64 = 30_000;
/// 块重试总上限(发送次数):3×5s + 20×30s ≈ 10 分钟。
///
/// 无限重试的代价是「对端文件已消失时进度条永久虚报」(2026-09-22 事故:对端编辑器
/// 的 tmp 中间文件进索引后随即被改名,块请求永远无人应答,UI 挂着「接收 1 · 0%」
/// 十几小时)。有界重试 + 下游自愈更划算。
pub const MAX_BLOCK_RETRIES_TOTAL: u32 = 23;
/// 「发送中」的租约时长:超过它没有新块请求,即认为这条文件已经传完。
///
/// 用租约而不是计数器,是因为计数器没有衰减路径 —— 只在下一次收到对端索引时才被
/// 重算,而建立连接互发全量之后对端可能很久不再发索引,于是卡片永远停在
/// 「传输中 · 发送 N」(2026-09-16 两端卡片转圈不止)。
pub const SERVE_LEASE_MS: i64 = 15_000;
/// 发送侧在途字节窗口。
pub const SEND_WINDOW_BYTES: usize = 64 * 1024 * 1024;
/// 延迟队列长度上限(条数)。请求由对端决定,不设限就是另一种内存耗尽。
pub const DEFERRED_MAX: usize = 4096;
pub const RATE_WINDOW_MS: i64 = 5_000;
pub const RATE_SPAN_FLOOR_MS: i64 = 1_000;
/// 接收认领保鲜期。须大于一条健康接收的最坏时长(约 105s 的块级放弃上限)。
pub const RECEIVE_CLAIM_TTL_MS: i64 = 5 * 60_000;
/// 初始索引交换的兜底等待:2 秒内没等到指纹应答就直接发全量。
pub const INITIAL_INDEX_FALLBACK_MS: i64 = 2_000;
/// 兜底全量重发的抑制窗口:同一 (目录, 对端) 在窗口内已发过「指纹相同」的
/// 全量时,重连后的兜底不再重发 —— 对端手里的快照已是当前索引,重发纯属浪费。
/// 旧版对端每次会话重建都触发兜底,链路抖动连续重建时形成风暴(2026-11-04
/// 实测:一次抖动 6 目录 × 双 transport 9 连发)。指纹变了照发。
pub const INITIAL_FALLBACK_SUPPRESS_MS: i64 = 60_000;

/// 冲突自动处理策略。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ConflictPolicy {
    /// 拉回远端 + 本地留冲突副本。
    #[default]
    KeepBoth,
    /// 无条件保本地(合并版本向量,不拉块)。
    LocalWins,
    /// 比较双方 mtime;判不了(任一侧缺 mtime 或打平)退回 KeepBoth。
    NewestWins,
}

/// 一条要发给对端的消息。由驱动层转成 wire 帧(文本或二进制信封)。
#[derive(Debug, Clone)]
pub enum Outbound {
    Entries {
        entries: Vec<WireEntry>,
        full: bool,
        relayed: bool,
    },
    BlockRequest(WireBlockRequest),
    BlockResponse(WireBlockResponse),
    IndexFingerprint(String),
    IndexAck,
    IndexRequest,
}

/// 同步进度(供 `/api/status` 与 WS 推送)。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Progress {
    pub pending: usize,
    pub sending: usize,
    pub receiving: usize,
    pub send_rate: u64,
    pub receive_rate: u64,
    pub files: Vec<TransferFile>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TransferFile {
    pub path: String,
    /// `"receive"` / `"send"`。
    pub direction: &'static str,
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub priority: bool,
}

/// 一次同步变更(由上层写入历史库)。
#[derive(Debug, Clone, PartialEq)]
pub struct SyncEvent {
    pub path: String,
    /// `"remote"` / `"local"`。
    pub direction: &'static str,
    pub action: SyncAction,
    pub device_id: String,
    pub duration_ms: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncAction {
    Add,
    Update,
    Delete,
    Conflict,
}

/// 接收认领台账里的一条记录(同一共享目录的所有 peer 共享)。
#[derive(Debug, Clone)]
pub struct ReceiveClaim {
    pub claim_id: u64,
    pub key: String,
    pub ts: i64,
}

/// 一个按相对路径判定的谓词。
pub type PathPredicate = Rc<dyn Fn(&str) -> bool>;
/// 磁盘空间守卫。
pub type SpaceCheck = Rc<dyn Fn(u64) -> bool>;
/// 本机索引(多连接共享)。
pub type SharedIndex = Rc<RefCell<BTreeMap<String, StoredEntry>>>;
/// 认领台账(多连接共享)。
pub type SharedLedger = Rc<RefCell<HashMap<String, ReceiveClaim>>>;
/// 兜底抑制台账:remote_device_id → (最近全量发出时刻, 发出时的本机指纹)。
/// 挂在目录状态上跨 attach 保留,同一目录的所有连接共享一份。
pub type SharedFullIndexSent = Rc<RefCell<HashMap<String, (i64, String)>>>;

fn next_claim_id() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

struct PendingEntry {
    kind: PendingKind,
    entry: IndexEntry,
    local: Option<StoredEntry>,
    handle: Box<dyn ReceiveHandle>,
    cdc: bool,
    started_at: i64,
}

#[derive(PartialEq, Eq, Clone, Copy)]
enum PendingKind {
    Receive,
    Conflict,
}

/// 一个在途块请求的重试状态。
struct PendingBlock {
    /// 下一次重试的时刻。
    deadline: i64,
    retries: u32,
    path: String,
    cdc: bool,
}

/// 会话层依赖。运行期可变的部分(忽略规则、冲突策略)用「取函数」而不是快照,
/// 理由同 Node:它们是运行期改的,快照一份就要等重连才生效。
pub struct PeerDeps {
    pub local_index: SharedIndex,
    pub ledger: SharedLedger,
    pub index: Rc<IndexStore>,
    pub executor: Option<Rc<LocalExecutor>>,
    /// 本机设备 ID。
    pub device_id: String,
    /// 对端设备 ID(冲突副本命名用)。
    pub remote_device_id: String,
    /// 共享目录绝对根(供块请求的路径越界校验)。
    pub root: PathBuf,
    /// 本目录当前生效的忽略规则。
    pub rules: IgnoreRuleset,
    /// 只拉不推。
    pub receive_only: bool,
    /// 冲突自动策略。
    pub conflict_policy: ConflictPolicy,
    /// 时钟(毫秒)。测试注入固定时钟来驱动重试与租约。
    pub now: Rc<dyn Fn() -> i64>,
    /// 按需同步判定(给定相对路径)。
    pub on_demand: Option<PathPredicate>,
    /// 单文件暂停判定。
    pub is_paused: Option<PathPredicate>,
    /// 磁盘空间守卫:入向体积不足时返回 false。
    pub check_disk_space: Option<SpaceCheck>,
    /// 兜底抑制台账(多连接共享,见 `SharedFullIndexSent`)。测试注入空台账。
    pub full_index_sent: SharedFullIndexSent,
}

/// 一条对端连接上的会话状态机。
pub struct Peer {
    deps: PeerDeps,
    /// 本管线在认领台账里的身份。
    claim_id: u64,
    claims: HashSet<String>,
    pending: HashMap<String, PendingEntry>,
    pending_blocks: HashMap<String, PendingBlock>,
    /// 待发送队列(驱动层排空)。
    outbound: Vec<Outbound>,
    /// 已交给 socket、尚未确认写完的在途字节(发送窗口用)。
    inflight_bytes: usize,
    priorities: HashSet<String>,
    serving: HashMap<String, i64>,
    serving_bytes: HashMap<String, (u64, u64)>,
    served_blocks: HashMap<String, HashSet<u64>>,
    rate_samples: Vec<(i64, u64, u64)>,
    deferred: Vec<WireBlockRequest>,
    deferred_keys: HashSet<String>,
    /// 磁盘守卫积压:被拦下的那轮索引,空间恢复后原样重放。
    disk_blocked: Option<(Vec<StoredEntry>, IndexMode, bool)>,
    /// 初始索引交换的兜底截止时刻。
    initial_fallback_deadline: Option<i64>,
    initial_settled: bool,
    initial_disposed: bool,
    attached_at: i64,
    inbound_settled: bool,
    events: Vec<SyncEvent>,
    /// 本轮待中转的条目(仅增量接收落地时收集,见 [`Self::note_relay`])。
    relay_out: Vec<WireEntry>,
    /// 当前索引批次是否参与中转:full 交换已收敛整网,转发只会制造重复帧;
    /// 只收模式的契约是「不向外推任何索引帧」,中转也是外推。
    relay_batch: bool,
    hard_ignored_dropped: Vec<String>,
    stall_dropped: Vec<(String, usize)>,
    initial_outcome: Option<&'static str>,
}

impl Peer {
    pub fn new(deps: PeerDeps) -> Self {
        let attached_at = (deps.now)();
        Self {
            deps,
            claim_id: next_claim_id(),
            claims: HashSet::new(),
            pending: HashMap::new(),
            pending_blocks: HashMap::new(),
            outbound: Vec::new(),
            inflight_bytes: 0,
            priorities: HashSet::new(),
            serving: HashMap::new(),
            serving_bytes: HashMap::new(),
            served_blocks: HashMap::new(),
            rate_samples: Vec::new(),
            deferred: Vec::new(),
            deferred_keys: HashSet::new(),
            disk_blocked: None,
            initial_fallback_deadline: None,
            initial_settled: false,
            initial_disposed: false,
            attached_at,
            inbound_settled: false,
            events: Vec::new(),
            relay_out: Vec::new(),
            relay_batch: false,
            hard_ignored_dropped: Vec::new(),
            stall_dropped: Vec::new(),
            initial_outcome: None,
        }
    }

    /* ---------------- 驱动层接口 ---------------- */

    /// 取走本轮要发的消息(驱动层负责真正写进 socket)。
    pub fn drain_outbound(&mut self) -> Vec<Outbound> {
        std::mem::take(&mut self.outbound)
    }

    /// 驱动层写完一条块响应后回报字节数,释放发送窗口。
    pub fn note_flushed(&mut self, bytes: usize) {
        self.inflight_bytes = self.inflight_bytes.saturating_sub(bytes);
    }

    /// 当前在途字节(观测用)。
    pub fn inflight_bytes(&self) -> usize {
        self.inflight_bytes
    }

    pub fn drain_events(&mut self) -> Vec<SyncEvent> {
        std::mem::take(&mut self.events)
    }

    /// 取走本轮待中转的条目(由 actor 层分发给同目录的其余连接)。
    pub fn drain_relay(&mut self) -> Vec<WireEntry> {
        std::mem::take(&mut self.relay_out)
    }

    /// 对端设备 ID(中转按设备去重用:同一设备可能挂着两条连接)。
    pub fn remote_device_id(&self) -> &str {
        &self.deps.remote_device_id
    }

    /// 把别处落地的条目转发给这条连接(ADR-0014 中转)。
    ///
    /// 只发增量并打 `relayed` 标记:接收端据此把「并发版本」判为陈旧同步副本
    /// 直接覆盖,而不是保留冲突副本(见 on_peer_index 的 conflict 分支)。
    pub fn relay_entries(&mut self, entries: &[WireEntry]) {
        if entries.is_empty() {
            return;
        }
        self.outbound.push(Outbound::Entries {
            entries: entries.to_vec(),
            full: false,
            relayed: true,
        });
    }

    /// 记一条「本轮落地」:增量轮次才进中转集合,`mtime` 沿用对端带来的原值
    /// (newest-wins 依赖它跨机比较,本机落地时间不能顶替)。
    fn note_relay(&mut self, entry: &IndexEntry, mtime: f64) {
        if self.relay_batch {
            self.relay_out
                .push(WireEntry::from_entry_raw_mtime(entry, mtime));
        }
    }

    pub fn drain_hard_ignored(&mut self) -> Vec<String> {
        std::mem::take(&mut self.hard_ignored_dropped)
    }

    pub fn drain_stall_dropped(&mut self) -> Vec<(String, usize)> {
        std::mem::take(&mut self.stall_dropped)
    }

    pub fn take_initial_outcome(&mut self) -> Option<&'static str> {
        self.initial_outcome.take()
    }

    fn now(&self) -> i64 {
        (self.deps.now)()
    }

    /// 运行期换掉忽略规则(`.syncxignore` 改动即时生效,不必重连)。
    pub fn set_rules(&mut self, rules: IgnoreRuleset) {
        self.deps.rules = rules;
    }

    /// 本机改动外推:一条增量索引消息。
    pub fn send_delta(&mut self, entries: Vec<WireEntry>) {
        if self.deps.receive_only || entries.is_empty() {
            return;
        }
        let entries: Vec<WireEntry> = entries
            .into_iter()
            .filter(|e| !is_hard_ignored(&e.path))
            .collect();
        if entries.is_empty() {
            return;
        }
        self.outbound.push(Outbound::Entries {
            entries,
            full: false,
            relayed: false,
        });
    }

    /// 本机设备 ID(上层构造 `item-fork` 之类消息时要用)。
    pub fn device_id(&self) -> &str {
        &self.deps.device_id
    }

    fn idx(&self) -> Ref<'_, BTreeMap<String, StoredEntry>> {
        self.deps.local_index.borrow()
    }

    fn idx_mut(&self) -> RefMut<'_, BTreeMap<String, StoredEntry>> {
        self.deps.local_index.borrow_mut()
    }

    /* ---------------- 索引 ---------------- */

    /// 收到对端索引。**这是整个会话层的主入口**。
    pub fn on_peer_index(&mut self, entries: Vec<WireEntry>, mode: IndexMode, relayed: bool) {
        let full = mode == IndexMode::Full;
        // 中转闸门(ADR-0014):full 交换后整网已收敛,再转发只会制造重复帧;
        // 只收设备不外推任何索引帧 —— 中转也是外推。
        self.relay_batch = !full && !self.deps.receive_only;

        // 全量轮次可以丢弃上一轮的在途块重试(条目集合已被完整声明);
        // 增量轮次绝不能做 —— 消息里没提到 ≠ 对端没有了。
        if full {
            self.pending_blocks.clear();
        }

        // 入向闸门一:硬忽略(见 ADR 0008)。对端版本旧、或对端在 `.syncxignore` 里
        // 写了 `!.git`,都会把 `.git` 条目推过来。不拦的话活条目会被写进本机 `.git`,
        // 墓碑会让本机真实的 `.git` 文件被移进回收站(2026-09-15 事故即此路径)。
        //
        // 入向闸门二:本机忽略规则(见 ADR 0012),活条目与墓碑**一律**丢弃。
        // 被忽略的路径本机不再扫描,它的本地改动没有任何索引保护;而对端索引里往往
        // 仍留着这条,会话建立互发全量时会被判成「对端有、本机没有」= 拉回来覆盖落盘,
        // 而冷启动保护对被忽略路径是刻意跳过的(2026-09-16 实测被覆盖)。
        let mut remote: BTreeMap<String, IndexEntry> = BTreeMap::new();
        // 对端 mtime 单独留一份:`IndexEntry` 刻意不含它(不参与版本关系),
        // 但 `newest-wins` 冲突策略要比它。截断前的原值也留一份:中转必须把
        // 对端带来的 mtime **原样**转发出去(newest-wins 跨机比较依赖它),
        // 不能用截断值顶替 —— 否则同一份内容绕了一跳后 mtime 凭空变小。
        let mut remote_mtimes: HashMap<String, i64> = HashMap::new();
        let mut remote_wire_mtimes: HashMap<String, f64> = HashMap::new();
        for wire in entries {
            if is_hard_ignored(&wire.path) {
                self.hard_ignored_dropped.push(wire.path);
                continue;
            }
            if self.deps.rules.is_ignored(&wire.path, false) {
                continue;
            }
            let mtime = syncx_net::wire::mtime_ms(wire.mtime);
            if mtime > 0 {
                remote_mtimes.insert(wire.path.clone(), mtime);
                remote_wire_mtimes.insert(wire.path.clone(), wire.mtime);
            }
            remote.insert(wire.path.clone(), wire.to_entry());
        }

        let local_plan: BTreeMap<String, IndexEntry> = {
            let index = self.idx();
            index
                .iter()
                .map(|(path, entry)| (path.clone(), entry.core()))
                .collect()
        };
        let actions = if full {
            build_plan(&local_plan, &remote)
        } else {
            build_delta_plan(&local_plan, &remote)
        };

        // 磁盘空间守卫:预估本轮入向体积(扣除将被覆盖的本地文件释放的空间,再扣掉
        // 已在磁盘中间态里的字节),不足就整轮跳过 receive/conflict —— 宁可推迟,
        // 也不要写到一半失败。删除照常应用(它是释放空间的方向),send 照常外推。
        let mut disk_skips_receive = false;
        if let Some(check) = self.deps.check_disk_space.clone() {
            let mut needed = 0u64;
            for action in &actions {
                let incoming = match action {
                    PlanAction::Receive { entry, .. } => Some(entry),
                    PlanAction::Conflict { remote, .. } => Some(remote),
                    _ => None,
                };
                let Some(incoming) = incoming else { continue };
                if matches!(action, PlanAction::Receive { .. })
                    && !incoming.blocks.is_empty()
                    && self.on_demand_enabled(&incoming.path)
                {
                    continue; // 按需同步下 receive 变成占位,不占盘
                }
                let (current_size, is_live) = {
                    let index = self.idx();
                    match index.get(&incoming.path) {
                        Some(e) => (e.size, !e.deleted),
                        None => (0, false),
                    }
                };
                let already = self.partial_bytes(incoming);
                let release = if is_live { current_size } else { 0 };
                needed += incoming
                    .size
                    .saturating_sub(release)
                    .saturating_sub(already);
            }
            if needed > 0 && !check(needed) {
                disk_skips_receive = true;
                self.disk_blocked = Some((self.snapshot_entries(), mode, relayed));
            } else {
                self.disk_blocked = None;
            }
        }

        let mut sends: Vec<StoredEntry> = Vec::new();
        let mut live_pending: HashSet<String> = HashSet::new();

        for action in actions {
            let path = action.path().to_string();
            if self.is_paused(&path) {
                continue;
            }
            if disk_skips_receive
                && matches!(
                    action,
                    PlanAction::Receive { .. } | PlanAction::Conflict { .. }
                )
            {
                continue;
            }
            match action {
                PlanAction::Send { entry, .. } => {
                    if !self.deps.receive_only {
                        let local = { self.idx().get(&path).cloned() };
                        sends.push(local.unwrap_or_else(|| StoredEntry::new(entry, None, false)));
                    }
                }
                PlanAction::Delete { .. } => {
                    // 判定「哪一侧的墓碑更新」,而不是「本地是不是墓碑」(模块注释第 2 条)。
                    let local_entry = { self.idx().get(&path).map(|e| e.core()) };
                    let remote_entry = remote.get(&path);
                    match compare_file_state(local_entry.as_ref(), remote_entry) {
                        FileStateRelation::LocalNewer => {
                            // 本地墓碑较新:仅当对端是活条目(或缺条目)时外推。
                            // 两侧都是墓碑时不推 —— 旧版对端收到较新墓碑会回推它自己的
                            // 旧墓碑,两端各推各的,版本永不收敛(2026-10-12)。
                            let remote_is_tombstone =
                                remote_entry.map(|e| e.deleted).unwrap_or(false);
                            if !self.deps.receive_only && !remote_is_tombstone {
                                let local = { self.idx().get(&path).cloned() };
                                if let Some(local) = local {
                                    sends.push(local);
                                }
                            }
                        }
                        FileStateRelation::RemoteNewer => {
                            if let Some(remote_entry) = remote_entry {
                                let stored = StoredEntry::new(remote_entry.clone(), None, false);
                                self.apply_delete(&path, remote_entry);
                                self.idx_mut().insert(path.clone(), stored);
                                // 该路径已在对端消失:中止在途接收,避免迟到块把它复活
                                self.abort_pending(&path);
                                self.events.push(SyncEvent {
                                    path: path.clone(),
                                    direction: "remote",
                                    action: SyncAction::Delete,
                                    device_id: self.deps.remote_device_id.clone(),
                                    duration_ms: None,
                                });
                                // 应用对端墓碑也要纳入中转(ADR-0014):否则 hub 应用删除后,
                                // 兄弟端在增量通道上永远学不到这条墓碑。
                                self.note_relay(
                                    remote_entry,
                                    remote_wire_mtimes.get(&path).copied().unwrap_or(0.0),
                                );
                            }
                        }
                        _ => {}
                    }
                }
                PlanAction::Receive { .. } => {
                    let Some(remote_entry) = remote.get(&path).cloned() else {
                        continue;
                    };
                    if !self.try_claim(&remote_entry) {
                        continue; // 同一设备的另一条连接已在接收这一版本
                    }
                    // 按需同步:非空文件先只记占位(块哈希齐备、盘上无实体)。空文件
                    // 无盘可省,照常即时落地 —— 否则「新建空文件」永远不出现。
                    if self.on_demand_enabled(&path) && !remote_entry.blocks.is_empty() {
                        let is_new = { !self.idx().contains_key(&path) };
                        let placeholder = StoredEntry::new(remote_entry, None, true);
                        if let Some(executor) = self.deps.executor.clone() {
                            let _ =
                                executor.apply_placeholder(&self.deps.index, &placeholder.core());
                        }
                        self.idx_mut().insert(path.clone(), placeholder);
                        self.events.push(SyncEvent {
                            path: path.clone(),
                            direction: "remote",
                            action: if is_new {
                                SyncAction::Add
                            } else {
                                SyncAction::Update
                            },
                            device_id: self.deps.remote_device_id.clone(),
                            duration_ms: None,
                        });
                        self.release_claim(&path);
                        continue;
                    }
                    if !self.open_pending(PendingKind::Receive, remote_entry.clone(), None) {
                        continue;
                    }
                    live_pending.insert(path.clone());
                    self.note_relay(
                        &remote_entry,
                        remote_wire_mtimes.get(&path).copied().unwrap_or(0.0),
                    );
                    self.request_missing_blocks(&path);
                    self.complete_if_ready(&path);
                }
                PlanAction::Conflict {
                    remote: remote_entry,
                    ..
                } => {
                    if !self.try_claim(&remote_entry) {
                        continue;
                    }
                    // 本端是否真的改过:版本向量里带本机 deviceId 计数 > 0 才算。
                    // 否则只是「之前从别处同步来的陈旧副本」,与中转来的并发版本不构成真冲突。
                    let genuine_local_edit = {
                        let index = self.idx();
                        index
                            .get(&path)
                            .map(|e| e.version.get(&self.deps.device_id).copied().unwrap_or(0) > 0)
                            .unwrap_or(false)
                    };
                    if self.deps.receive_only || (relayed && !genuine_local_edit) {
                        if self.open_pending(PendingKind::Receive, remote_entry.clone(), None) {
                            live_pending.insert(path.clone());
                            self.note_relay(
                                &remote_entry,
                                remote_wire_mtimes.get(&path).copied().unwrap_or(0.0),
                            );
                            self.request_missing_blocks(&path);
                            self.complete_if_ready(&path);
                        }
                        continue;
                    }
                    // 字节级一致的「并发」不构成真冲突:两台机器各有一份同一目录时
                    // 首连会互判 concurrent,定长块哈希列表相等 ⟺ 字节完全一致。
                    let byte_identical = {
                        let index = self.idx();
                        match index.get(&path) {
                            Some(local) => {
                                !local.deleted
                                    && !local.placeholder
                                    && !remote_entry.deleted
                                    && local.blocks.len() == remote_entry.blocks.len()
                                    && local
                                        .blocks
                                        .iter()
                                        .zip(remote_entry.blocks.iter())
                                        .all(|(a, b)| a == b)
                            }
                            None => false,
                        }
                    };
                    if byte_identical {
                        let keep = self.apply_keep_local(&path, &remote_entry);
                        if let Some(keep) = keep {
                            self.idx_mut().insert(path.clone(), keep);
                        }
                        self.events.push(SyncEvent {
                            path: path.clone(),
                            direction: "local",
                            action: SyncAction::Conflict,
                            device_id: self.deps.remote_device_id.clone(),
                            duration_ms: None,
                        });
                        self.release_claim(&path);
                        continue;
                    }
                    // 冲突自动策略:只介入「真正的双活内容并发」,任一侧是墓碑时不判胜负
                    // (双方删除有专门的墓碑合并)。
                    let mut handled = false;
                    if self.deps.conflict_policy != ConflictPolicy::KeepBoth
                        && !remote_entry.deleted
                    {
                        let local_entry = { self.idx().get(&path).cloned() };
                        if let Some(local_entry) = local_entry {
                            if !local_entry.deleted {
                                // 判胜负:local-wins 无条件保本地;newest-wins 比对双方 mtime ——
                                // 任一侧缺 mtime 或打平都判不了,保持 None 退回 keep-both。
                                let remote_wins = match self.deps.conflict_policy {
                                    ConflictPolicy::LocalWins => Some(false),
                                    ConflictPolicy::NewestWins => {
                                        match (local_entry.mtime, remote_mtimes.get(&path).copied())
                                        {
                                            (Some(l), Some(r)) if r > l => Some(true),
                                            (Some(l), Some(r)) if l > r => Some(false),
                                            _ => None,
                                        }
                                    }
                                    ConflictPolicy::KeepBoth => None,
                                };
                                match remote_wins {
                                    Some(true) => {
                                        if self.open_pending(
                                            PendingKind::Receive,
                                            remote_entry.clone(),
                                            None,
                                        ) {
                                            live_pending.insert(path.clone());
                                            self.note_relay(
                                                &remote_entry,
                                                remote_wire_mtimes
                                                    .get(&path)
                                                    .copied()
                                                    .unwrap_or(0.0),
                                            );
                                            self.request_missing_blocks(&path);
                                            self.complete_if_ready(&path);
                                        }
                                        handled = true;
                                    }
                                    Some(false) => {
                                        let keep = self.apply_keep_local(&path, &remote_entry);
                                        if let Some(keep) = keep {
                                            self.idx_mut().insert(path.clone(), keep.clone());
                                            sends.push(keep);
                                        }
                                        self.events.push(SyncEvent {
                                            path: path.clone(),
                                            direction: "local",
                                            action: SyncAction::Conflict,
                                            device_id: self.deps.remote_device_id.clone(),
                                            duration_ms: None,
                                        });
                                        self.release_claim(&path);
                                        handled = true;
                                    }
                                    None => {}
                                }
                            }
                        }
                    }
                    if handled {
                        continue;
                    }
                    let local_entry = { self.idx().get(&path).cloned() };
                    match local_entry {
                        Some(local_entry) => {
                            if self.open_pending(
                                PendingKind::Conflict,
                                remote_entry.clone(),
                                Some(local_entry),
                            ) {
                                live_pending.insert(path.clone());
                                self.note_relay(
                                    &remote_entry,
                                    remote_wire_mtimes.get(&path).copied().unwrap_or(0.0),
                                );
                                self.request_missing_blocks(&path);
                                self.complete_if_ready(&path);
                            }
                        }
                        None => {
                            // 认领了却没动手(本地条目缺失):交还认领不留悬仓
                            self.release_claim(&path);
                        }
                    }
                }
            }
        }

        // 清理上一轮遗留、本轮**全量**索引已不再引用的陈旧 pending:对端删除/改名后
        // 它们会永久滞留(进度虚报),迟到的块响应还可能把刚删的文件复活。
        // 增量轮次绝不做(模块注释第 3 条)。
        if full {
            let stale: Vec<String> = self
                .pending
                .keys()
                .filter(|p| !live_pending.contains(*p))
                .cloned()
                .collect();
            for path in stale {
                if let Some(mut item) = self.pending.remove(&path) {
                    // 中间态只关句柄、不删文件:同设备的另一条连接可能正在写同一个 tmp
                    item.handle.abort(true);
                }
                self.release_claim(&path);
            }
        }

        // 出向硬闸门:任何来源的硬忽略条目都不上线。
        let outbound: Vec<WireEntry> = sends
            .iter()
            .filter(|e| !is_hard_ignored(&e.path))
            .map(|e| WireEntry::from_entry(&e.core(), e.mtime.unwrap_or(0)))
            .collect();
        if !outbound.is_empty() {
            // 规划出来的回推永远是「针对某几条路径的应答」,即增量
            self.outbound.push(Outbound::Entries {
                entries: outbound,
                full: false,
                relayed: false,
            });
        }

        self.inbound_settled = true;
    }

    /* ---------------- 供块 ---------------- */

    /// 收到块请求:校验 → (窗口允许才)读盘 → 上线。
    pub fn on_block_request(&mut self, request: WireBlockRequest) {
        // 越界/非整数索引直接拒绝,避免对本地文件做无谓的整文件读取
        if request.block_index > usize::MAX as u64 {
            return;
        }
        // 读取侧路径防护(与写入侧同款):拒绝 `../` 与经符号链接逃逸共享目录的路径,
        // 防止恶意对端经块请求读取目录外文件。
        if resolve_share_path(&self.deps.root, &request.path, false).is_err() {
            return;
        }
        // 在途窗口必须挡在读盘**之前** —— 读出来再挂起等于什么都没省。
        if !self.has_send_room(self.expected_wire_bytes(&request)) {
            self.defer_request(request);
            return;
        }
        self.serve_block(request);
    }

    fn serve_block(&mut self, request: WireBlockRequest) {
        let entry = { self.idx().get(&request.path).cloned() };
        let Some(entry) = entry else {
            return; // 本地没有这条:对端会超时重试,下轮索引自然收敛
        };
        if entry.deleted {
            return;
        }

        let (data, layout_hash) = if request.cdc == Some(true) {
            // CDC 口径:按本机条目 clens 前缀和定位偏移,只供那一块。
            // 本机没有 CDC 视图(旧数据/版本错位)时静默忽略 —— 对端走超时重试,
            // 错位有界(本机扫描重算后下轮宣告就带上 cdh)。
            let (Some(cdh), Some(clens)) = (entry.cdh.as_ref(), entry.clens.as_ref()) else {
                return;
            };
            let slot = request.block_index as usize;
            if slot >= cdh.len() || clens.len() != cdh.len() {
                return;
            }
            let offset: u64 = clens.iter().take(slot).sum();
            let Ok(bytes) = read_at(&self.deps.root, &request.path, offset, clens[slot]) else {
                return;
            };
            (bytes, cdh[slot].clone())
        } else {
            let slot = request.block_index as usize;
            let offset = slot as u64 * BLOCK_SIZE as u64;
            if offset >= entry.size && entry.size > 0 {
                return;
            }
            let length = entry.size.saturating_sub(offset).min(BLOCK_SIZE as u64);
            let Ok(bytes) = read_at(&self.deps.root, &request.path, offset, length) else {
                return;
            };
            (bytes, entry.blocks.get(slot).cloned().unwrap_or_default())
        };
        if layout_hash.is_empty() {
            return; // 本机索引里没有这个槽位的哈希:不能声称供得出内容
        }

        // 块确实发出去了 → 该路径进入「发送中」,并按最后一个块续期租约
        let now = self.now();
        self.serving.insert(request.path.clone(), now);
        let total = entry.size;
        if self
            .served_blocks
            .entry(request.path.clone())
            .or_default()
            .insert(request.block_index)
        {
            let rec = self
                .serving_bytes
                .entry(request.path.clone())
                .or_insert((0, total));
            rec.0 += data.len() as u64;
            rec.1 = total;
        }
        self.record_bytes(data.len() as u64, 0);

        let wire = WireBlockResponse {
            device_id: self.deps.device_id.clone(),
            path: request.path,
            block_index: request.block_index,
            hash: layout_hash,
            data: base64(&data),
            cdc: request.cdc.filter(|v| *v),
        };
        self.inflight_bytes += wire.data.len() + 512;
        self.outbound.push(Outbound::BlockResponse(wire));
    }

    /* ---------------- 收块 ---------------- */

    /// 收到块响应。校验顺序与 Node 一致:口径以 pending 为准,响应里的 cdc 只作线索。
    pub fn on_block_response(&mut self, response: WireBlockResponse) {
        let (hashes, cdc) = {
            let Some(item) = self.pending.get(&response.path) else {
                return;
            };
            let hashes = if item.cdc {
                item.entry.cdh.clone().unwrap_or_default()
            } else {
                item.entry.blocks.clone()
            };
            (hashes, item.cdc)
        };
        let slot = response.block_index as usize;
        // 边界校验:非法/越界索引会写进句柄算出的偏移之外,污染 tmp 的字节布局
        if slot >= hashes.len() {
            return;
        }
        // 块内容必须与本次请求期望的哈希一致(防对端回填自洽但错误的块)
        if response.hash != hashes[slot] {
            return;
        }
        let Ok(data) = unb64(&response.data) else {
            return;
        };
        // 大小上限:超大响应直接丢弃,避免哈希前先撑爆内存
        let limit = if cdc { CDC_MAX_CHUNK } else { BLOCK_SIZE };
        if data.len() > limit {
            return;
        }
        if hash_block(&data) != response.hash {
            return;
        }
        // 重复响应不重复计数,避免虚增提前落地不完整文件
        if self
            .pending
            .get(&response.path)
            .map(|item| item.handle.has(slot))
            .unwrap_or(true)
        {
            return;
        }
        if let Some(item) = self.pending.get_mut(&response.path) {
            // 到达即落盘:句柄写进 tmp 的最终偏移,内存里不攒任何块
            let _ = item.handle.append(slot, &data);
        }
        self.record_bytes(0, data.len() as u64);
        // 块在到达 = 这条认领还活着:保鲜期随进度滚动
        if let Some(claim) = self.deps.ledger.borrow_mut().get_mut(&response.path) {
            if claim.claim_id == self.claim_id {
                claim.ts = self.now();
            }
        }
        self.pending_blocks
            .remove(&block_key(&response.path, response.block_index, cdc));
        self.complete_if_ready(&response.path);
    }

    /* ---------------- 收齐判定与落地 ---------------- */

    fn complete_if_ready(&mut self, path: &str) {
        {
            let Some(item) = self.pending.get(path) else {
                return;
            };
            if item.handle.count() != slot_count(item) {
                return;
            }
        }

        let Some(mut item) = self.pending.remove(path) else {
            return;
        };
        self.priorities.remove(path);

        let result = match item.kind {
            PendingKind::Conflict => {
                // 落地时重新读取本地最新条目:冲突规划到块收齐之间,本地可能已被新一轮
                // 扫描更新,用规划时捕获的旧版本合并会回退版本向量。
                let current_local =
                    { self.idx().get(path).cloned() }.or_else(|| item.local.clone());
                match (self.deps.executor.clone(), current_local) {
                    (Some(executor), Some(current_local)) => {
                        match executor.apply_conflict(
                            &self.deps.index,
                            path,
                            &current_local,
                            &item.entry,
                            item.handle.as_mut(),
                            &self.deps.remote_device_id,
                        ) {
                            Ok(landed) => {
                                self.idx_mut().insert(path.to_string(), landed);
                                self.events.push(SyncEvent {
                                    path: path.to_string(),
                                    direction: "remote",
                                    action: SyncAction::Conflict,
                                    device_id: self.deps.remote_device_id.clone(),
                                    duration_ms: Some(self.now() - item.started_at),
                                });
                                Ok(())
                            }
                            Err(error) => Err(error),
                        }
                    }
                    _ => Ok(()),
                }
            }
            PendingKind::Receive => {
                let is_new = { !self.idx().contains_key(path) };
                // 冷启动保护:本机盘上已有同名文件、但本机索引尚未记录时,先保留为
                // `.sync-conflict-` 副本,避免被对端版本静默覆盖。
                // 忽略规则命中的文件不保护(旧行为即会接收覆盖,避免把被忽略文件反向同步出去)。
                let mut preserved = false;
                if is_new
                    && !self.deps.remote_device_id.is_empty()
                    && !self.deps.rules.is_ignored(path, false)
                {
                    if let Some(executor) = self.deps.executor.clone() {
                        preserved = executor
                            .preserve_local_as_conflict(path, &self.deps.remote_device_id)
                            .unwrap_or(false);
                    }
                }
                let result = match self.deps.executor.clone() {
                    Some(executor) => executor.finalize_receive(
                        &self.deps.index,
                        &item.entry,
                        item.handle.as_mut(),
                    ),
                    None => item.handle.finalize().map(|_| ()),
                };
                match result {
                    Ok(()) => {
                        let mut stored = StoredEntry::new(item.entry.clone(), None, false);
                        stored.mtime = file_mtime_ms(&self.deps.root.join(&item.entry.path));
                        self.idx_mut().insert(path.to_string(), stored);
                        self.events.push(SyncEvent {
                            path: path.to_string(),
                            direction: "remote",
                            action: if preserved {
                                SyncAction::Conflict
                            } else if is_new {
                                SyncAction::Add
                            } else {
                                SyncAction::Update
                            },
                            device_id: self.deps.remote_device_id.clone(),
                            duration_ms: Some(self.now() - item.started_at),
                        });
                        Ok(())
                    }
                    Err(error) => Err(error),
                }
            }
        };

        // 句柄统一在此收口:落地成功时它是空操作(句柄已关、中间态已清);抛错时它关掉
        // 写句柄并把已收的字节留在盘上(keep_partial)—— 半途而废的接收下一轮接着写。
        // 不关句柄的代价是 Windows 上 tmp 一直被攥着:rename 不了、删不掉。
        item.handle.abort(true);
        // 接收有了确定结局:交还认领,让同一设备的另一条连接在后续轮次仍能接手。
        self.release_claim(path);
        // 落地失败的块不会重来:本轮认领已作废,下一轮索引交换会重新规划。
        // 只记日志 —— 在这里重试会把「磁盘已满 / 权限不足」变成忙等。
        if let Err(error) = result {
            tracing::warn!(path, %error, "接收落地失败,已保留中间态等待下一轮");
        }
    }

    /* ---------------- 重试与超时 ---------------- */

    /// 由驱动循环周期性调用:处理到期的块重试、初始交换兜底与租约过期。
    pub fn poll_timeouts(&mut self, now: i64) {
        if let Some(deadline) = self.initial_fallback_deadline {
            if now >= deadline {
                self.initial_fallback_deadline = None;
                if !self.initial_settled {
                    self.initial_settled = true;
                    let fingerprint = self.fingerprint();
                    if self.fallback_suppressed(now, &fingerprint) {
                        // 窗口内已向同一对端发过同指纹全量:重发是一模一样的
                        // 字节,链路抖动风暴里白白付流量(见 INITIAL_FALLBACK_SUPPRESS_MS)
                        self.initial_outcome = Some("fallback-suppressed");
                    } else {
                        self.initial_outcome = Some("fallback");
                        self.send_full_snapshot();
                    }
                }
            }
        }

        let due: Vec<String> = self
            .pending_blocks
            .iter()
            .filter(|(_, b)| now >= b.deadline)
            .map(|(key, _)| key.clone())
            .collect();
        for key in due {
            let Some(block) = self.pending_blocks.remove(&key) else {
                continue;
            };
            // 重试计数已在 send_block_request 里累进;超上限就放弃整条路径
            if block.retries >= MAX_BLOCK_RETRIES_TOTAL {
                self.drop_if_unservable(&block.path);
                continue;
            }
            let hash = match block_hash(self, &key) {
                Some(hash) => hash,
                None => {
                    // 条目已不在(本轮全量清理过):这条重试链一并无意义
                    self.drop_if_unservable(&block.path);
                    continue;
                }
            };
            self.send_block_request(&block.path, block_slot(&key), &hash, block.cdc);
        }

        // 发送租约过期:清掉「发送中」计数(它没有别的衰减路径)
        let stale: Vec<String> = self
            .serving
            .iter()
            .filter(|(_, ts)| now - **ts > SERVE_LEASE_MS)
            .map(|(path, _)| path.clone())
            .collect();
        for path in stale {
            self.serving.remove(&path);
            self.serving_bytes.remove(&path);
            self.served_blocks.remove(&path);
        }

        self.prune_rate_samples(now);
    }

    /// 下一个到期时刻(驱动循环据此决定睡多久;`None` = 没有待办)。
    pub fn next_deadline(&self) -> Option<i64> {
        let blocks = self.pending_blocks.values().map(|b| b.deadline).min();
        match (blocks, self.initial_fallback_deadline) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        }
    }

    fn send_block_request(&mut self, path: &str, block_index: u64, hash: &str, cdc: bool) {
        let key = block_key(path, block_index, cdc);
        let retries = self
            .pending_blocks
            .get(&key)
            .map(|b| b.retries)
            .unwrap_or(0);
        if retries >= MAX_BLOCK_RETRIES_TOTAL {
            self.pending_blocks.remove(&key);
            self.drop_if_unservable(path);
            return;
        }
        self.outbound.push(Outbound::BlockRequest(WireBlockRequest {
            device_id: self.deps.device_id.clone(),
            path: path.to_string(),
            block_index,
            hash: hash.to_string(),
            priority: self.priorities.contains(path).then_some(true),
            cdc: cdc.then_some(true),
        }));
        let next_retries = retries + 1;
        // 快速重试(5s×3)覆盖瞬时故障,之后退避到 30s 给对端较长故障留恢复窗口。
        let delay = if next_retries > MAX_BLOCK_RETRIES {
            BLOCK_RETRY_LONG_MS
        } else {
            BLOCK_REQUEST_TIMEOUT_MS
        };
        self.pending_blocks.insert(
            key,
            PendingBlock {
                deadline: self.now() + delay,
                retries: next_retries,
                path: path.to_string(),
                cdc,
            },
        );
    }

    /// 某路径最后一个在途块请求被放弃时:整条放弃接收。
    ///
    /// 放弃是安全的,自愈路径有三:①对端扫描器发现文件消失后推墓碑;②对端文件回来后
    /// 推新版本增量,重新规划;③任何重连都会互发全量索引。反之留着只会让「接收中」
    /// 永久虚报。
    ///
    /// 中间态这里**保留**(keep_partial):放弃的成因里有一大类是「对端这会儿供不出」
    /// (文件被占用、链路抖动、对端重启),而不是「这份内容不存在」。
    fn drop_if_unservable(&mut self, path: &str) {
        if self.pending_blocks.values().any(|b| b.path == path) {
            return; // 还有别的块在途
        }
        let Some(mut item) = self.pending.remove(path) else {
            return;
        };
        let missing = slot_count(&item).saturating_sub(item.handle.count());
        item.handle.abort(true);
        self.priorities.remove(path);
        self.release_claim(path);
        self.stall_dropped.push((path.to_string(), missing));
    }

    /* ---------------- 请求缺失块 ---------------- */

    fn request_missing_blocks(&mut self, path: &str) {
        let (cdc, hashes, local_blocks, local_cdc) = {
            let Some(item) = self.pending.get(path) else {
                return;
            };
            let cdc = item.cdc;
            let hashes = if cdc {
                item.entry.cdh.clone().unwrap_or_default()
            } else {
                item.entry.blocks.clone()
            };
            let index = self.idx();
            let local = index.get(path);
            let local_blocks = local
                .filter(|e| !e.deleted)
                .map(|e| e.blocks.clone())
                .unwrap_or_default();
            let local_cdc = local
                .filter(|e| !e.deleted && !e.placeholder && e.has_cdc_view())
                .map(|e| {
                    (
                        e.cdh.clone().unwrap_or_default(),
                        e.clens.clone().unwrap_or_default(),
                    )
                });
            (cdc, hashes, local_blocks, local_cdc)
        };

        if cdc {
            if !self.pending.contains_key(path) {
                return;
            }
            // 本地 CDC 视图:哈希 → (偏移, 长度)。同哈希多块取最先出现的一处。
            // 块边界由内容决定,插入/删除让整体错位后,块自身的哈希依然与本地文件里
            // 同一段字节吻合 —— 这正是定长下标匹配做不到的差集。
            let mut local_hits: HashMap<String, (u64, u64)> = HashMap::new();
            if let Some((lh, ll)) = local_cdc {
                let mut offset = 0u64;
                for (hash, len) in lh.iter().zip(ll.iter()) {
                    local_hits.entry(hash.clone()).or_insert((offset, *len));
                    offset += *len;
                }
            }
            for (slot, hash) in hashes.iter().enumerate() {
                let already = self
                    .pending
                    .get(path)
                    .map(|i| i.handle.has(slot))
                    .unwrap_or(true);
                if !already {
                    if let Some((offset, length)) = local_hits.get(hash).copied() {
                        if let Ok(bytes) = read_at(&self.deps.root, path, offset, length) {
                            if hash_block(&bytes) == *hash {
                                if let Some(item) = self.pending.get_mut(path) {
                                    let _ = item.handle.append(slot, &bytes);
                                }
                            }
                        }
                    }
                }
                let still_missing = self
                    .pending
                    .get(path)
                    .map(|i| !i.handle.has(slot))
                    .unwrap_or(false);
                if still_missing {
                    self.send_block_request(path, slot as u64, hash, true);
                }
            }
            return;
        }

        for (slot, hash) in hashes.iter().enumerate() {
            let already = self
                .pending
                .get(path)
                .map(|i| i.handle.has(slot))
                .unwrap_or(true);
            if already {
                continue; // 已预填或已收到
            }
            if local_blocks.get(slot) == Some(hash) {
                // 本地同位置的块哈希相同 → 直接从本地读,**免网络重传**
                let offset = slot as u64 * BLOCK_SIZE as u64;
                let length = {
                    let index = self.idx();
                    index
                        .get(path)
                        .map(|e| e.size.saturating_sub(offset).min(BLOCK_SIZE as u64))
                        .unwrap_or(0)
                };
                if let Ok(bytes) = read_at(&self.deps.root, path, offset, length) {
                    if hash_block(&bytes) == *hash {
                        if let Some(item) = self.pending.get_mut(path) {
                            let _ = item.handle.append(slot, &bytes);
                        }
                        continue;
                    }
                }
                // 哈希校验不过就不信本地块(文件可能在扫描与规划之间被改写)
            }
            self.send_block_request(path, slot as u64, hash, false);
        }
    }

    /* ---------------- 初始索引交换 ---------------- */

    /// 会话建立时的初始索引交换:先发指纹,一致就省掉全量互换。
    /// 三条路(跳过 / 请求全量 / 兜底全量)都与旧的「无条件发全量」收敛等价。
    pub fn begin_initial_exchange(&mut self) {
        if self.initial_disposed {
            return;
        }
        let fingerprint = self.fingerprint();
        self.outbound.push(Outbound::IndexFingerprint(fingerprint));
        self.initial_fallback_deadline = Some(self.now() + INITIAL_INDEX_FALLBACK_MS);
    }

    pub fn on_index_fingerprint(&mut self, fingerprint: &str) {
        self.settle_initial();
        if self.fingerprint() == fingerprint {
            // 索引相同 ⇒ 入向定义上为空,入向腿一并落定
            self.inbound_settled = true;
            self.outbound.push(Outbound::IndexAck);
        } else {
            self.outbound.push(Outbound::IndexRequest);
        }
    }

    pub fn on_index_ack(&mut self) {
        self.settle_initial();
        // 对端确认「你的指纹 = 我的索引」:它不会再发全量,本机这份也省掉
        self.inbound_settled = true;
        self.initial_outcome = Some("skipped");
    }

    pub fn on_index_request(&mut self) {
        self.settle_initial();
        self.initial_outcome = Some("request-served");
        // 对端主动索要 = 正面证据,永远照发;但入账台账,后续窗口内的兜底
        // 重发才有抑制依据(对端手里的快照已覆盖当前指纹)。
        self.record_full_index_sent();
        self.send_full_snapshot();
    }

    fn settle_initial(&mut self) {
        self.initial_fallback_deadline = None;
        self.initial_settled = true;
    }

    /// 台账入账(不抑制):记下「已向该对端发过当前指纹的全量」。
    fn record_full_index_sent(&mut self) {
        let fingerprint = self.fingerprint();
        self.deps
            .full_index_sent
            .borrow_mut()
            .insert(self.deps.remote_device_id.clone(), (self.now(), fingerprint));
    }

    /// 兜底全量是否被抑制:窗口内已向该对端发过「指纹相同」的全量 → 抑制
    /// (不发,台账保持锚在实际发出时刻);指纹变化或窗口外 → 放行并重记
    /// 台账(对齐 MoonBit `initial_fallback_suppressed` / Node `gateFullIndexResend`)。
    fn fallback_suppressed(&self, now: i64, fingerprint: &str) -> bool {
        let mut sent = self.deps.full_index_sent.borrow_mut();
        match sent.get(self.deps.remote_device_id.as_str()) {
            Some((at, prev_fp)) if now - *at < INITIAL_FALLBACK_SUPPRESS_MS && prev_fp == fingerprint => true,
            _ => {
                sent.insert(
                    self.deps.remote_device_id.clone(),
                    (now, fingerprint.to_string()),
                );
                false
            }
        }
    }

    fn send_full_snapshot(&mut self) {
        if self.initial_disposed {
            return;
        }
        let entries: Vec<WireEntry> = {
            let index = self.idx();
            index
                .values()
                .filter(|e| e.is_announceable())
                .map(|e| WireEntry::from_entry(&e.core(), e.mtime.unwrap_or(0)))
                .collect()
        };
        self.outbound.push(Outbound::Entries {
            entries,
            full: true,
            relayed: false,
        });
    }

    /// 本机索引指纹(口径见 [`crate::fingerprint`])。
    pub fn fingerprint(&self) -> String {
        let entries: Vec<StoredEntry> = self.idx().values().cloned().collect();
        index_fingerprint(&entries)
    }

    /// 入向追平是否仍未落定:落定后「台账为空」才真正等于「没有在途接收」。
    pub fn initial_catch_up_blocked_since(&self) -> Option<i64> {
        if self.inbound_settled {
            None
        } else {
            Some(self.attached_at)
        }
    }

    /* ---------------- 主动动作 ---------------- */

    /// 磁盘守卫放行后重放被拦下的那轮索引。
    pub fn retry_disk_blocked(&mut self) {
        let Some((entries, mode, relayed)) = self.disk_blocked.take() else {
            return;
        };
        let wire: Vec<WireEntry> = entries
            .iter()
            .map(|e| WireEntry::from_entry(&e.core(), e.mtime.unwrap_or(0)))
            .collect();
        self.on_peer_index(wire, mode, relayed);
    }

    /// 「优先同步」:用户点名某在传文件插队。
    pub fn mark_priority(&mut self, path: &str) {
        let hashes = {
            let Some(item) = self.pending.get(path) else {
                return; // 不在接收中:无队可插
            };
            if item.cdc {
                item.entry.cdh.clone().unwrap_or_default()
            } else {
                item.entry.blocks.clone()
            }
        };
        self.priorities.insert(path.to_string());
        let cdc = self.pending.get(path).map(|i| i.cdc).unwrap_or(false);
        // 为全部未收齐的块**重发**带标记的请求:发送端据此插队。重复响应在接收闸门
        // 处去重,安全;request_block 自身会顶掉旧的重试链,不会重复叠加。
        for (slot, hash) in hashes.iter().enumerate() {
            let missing = self
                .pending
                .get(path)
                .map(|i| !i.handle.has(slot))
                .unwrap_or(false);
            if missing {
                self.send_block_request(path, slot as u64, hash, cdc);
            }
        }
    }

    /// 按需同步:把占位条目真正拉回来落盘。复用既有块管线,零新协议帧。
    pub fn materialize(&mut self, path: &str) -> bool {
        let entry = { self.idx().get(path).map(|e| e.core()) };
        let Some(entry) = entry else {
            return false;
        };
        let placeholder = { self.idx().get(path).map(|e| e.placeholder).unwrap_or(false) };
        if entry.deleted || !placeholder {
            return false; // 非占位(已是实体)/ 墓碑都无需拉块
        }
        if self.pending.contains_key(path) {
            return true; // 已在拉取中:幂等
        }
        if !self.try_claim(&entry) {
            return true; // 他人在拉:幂等返回
        }
        // 口径必为定长:占位态盘上无实体,无差集可言
        if self.open_pending(PendingKind::Receive, entry, None) {
            self.request_missing_blocks(path);
        }
        true
    }

    /// 作废本 peer 的初始交换兜底(连接拆除时调用)。
    pub fn dispose(&mut self) {
        self.initial_disposed = true;
        self.settle_initial();
    }

    /// 释放本管线的**全部**认领,并作废在途接收(句柄收口、pending 清空)。
    /// 连接拆除时必须调用:死管线不落地也不重试,留着认领会把一次普通断开演变成
    /// 分钟级的收敛延迟。
    pub fn release_claims(&mut self) {
        for item in self.pending.values_mut() {
            item.handle.abort(true);
        }
        self.pending.clear();
        self.pending_blocks.clear();
        self.priorities.clear();
        self.serving.clear();
        self.serving_bytes.clear();
        self.served_blocks.clear();
        let paths: Vec<String> = self.claims.drain().collect();
        let mut ledger = self.deps.ledger.borrow_mut();
        for path in paths {
            if ledger.get(&path).map(|c| c.claim_id) == Some(self.claim_id) {
                ledger.remove(&path);
            }
        }
    }

    /* ---------------- 进度 ---------------- */

    pub fn progress(&mut self) -> Progress {
        let now = self.now();
        let mut files = Vec::new();
        let mut receiving = 0usize;
        for (path, item) in &self.pending {
            if item.kind != PendingKind::Receive {
                continue;
            }
            receiving += 1;
            files.push(TransferFile {
                path: path.clone(),
                direction: "receive",
                bytes_done: item.handle.bytes() as u64,
                bytes_total: item.entry.size,
                priority: self.priorities.contains(path),
            });
        }
        let mut sending = 0usize;
        for (path, ts) in &self.serving {
            if now - *ts > SERVE_LEASE_MS {
                continue;
            }
            sending += 1;
            if let Some((done, total)) = self.serving_bytes.get(path) {
                files.push(TransferFile {
                    path: path.clone(),
                    direction: "send",
                    bytes_done: *done,
                    bytes_total: *total,
                    priority: false,
                });
            }
        }
        self.prune_rate_samples(now);
        Progress {
            pending: self.pending.len(),
            sending,
            receiving,
            send_rate: self.bytes_per_second(now, true),
            receive_rate: self.bytes_per_second(now, false),
            files,
        }
    }

    fn record_bytes(&mut self, sent: u64, recv: u64) {
        let now = self.now();
        self.rate_samples.push((now, sent, recv));
        self.prune_rate_samples(now);
    }

    fn prune_rate_samples(&mut self, now: i64) {
        let cutoff = now - RATE_WINDOW_MS;
        self.rate_samples.retain(|(t, _, _)| *t > cutoff);
    }

    fn bytes_per_second(&self, now: i64, sent: bool) -> u64 {
        if self.rate_samples.is_empty() {
            return 0;
        }
        let sum: u64 = self
            .rate_samples
            .iter()
            .map(|(_, s, r)| if sent { *s } else { *r })
            .sum();
        let span = (now - self.rate_samples[0].0).max(RATE_SPAN_FLOOR_MS);
        sum * 1000 / span as u64
    }

    /* ---------------- 内部工具 ---------------- */

    fn snapshot_entries(&self) -> Vec<StoredEntry> {
        self.idx().values().cloned().collect()
    }

    fn on_demand_enabled(&self, path: &str) -> bool {
        self.deps
            .on_demand
            .as_ref()
            .map(|f| f(path))
            .unwrap_or(false)
    }

    fn is_paused(&self, path: &str) -> bool {
        self.deps
            .is_paused
            .as_ref()
            .map(|f| f(path))
            .unwrap_or(false)
    }

    fn apply_delete(&mut self, path: &str, tombstone: &IndexEntry) {
        let Some(executor) = self.deps.executor.clone() else {
            return;
        };
        let stored = StoredEntry::new(tombstone.clone(), None, false);
        let _ = executor.apply_delete(&self.deps.index, path, &stored);
    }

    fn apply_keep_local(&mut self, path: &str, remote: &IndexEntry) -> Option<StoredEntry> {
        let local = { self.idx().get(path).cloned() }?;
        match self.deps.executor.clone() {
            Some(executor) => executor
                .apply_conflict_keep_local(&self.deps.index, &local, remote)
                .ok(),
            None => Some(StoredEntry {
                version: merge_versions(&local.version, &remote.version),
                ..local
            }),
        }
    }

    /// 本轮接收是否按 CDC 口径规划。判据全在「本端能不能差集」:对端条目带 cdh/clens
    /// 而本机对应条目也有 CDC 视图(实体文件在盘上)才启用 —— 能算出差集才有收益。
    /// 占位条目按定长口径:materialize 本就要拉全部内容,无差集可言。
    fn plan_cdc(&self, remote: &IndexEntry) -> bool {
        if !remote.has_cdc_view() {
            return false;
        }
        let index = self.idx();
        match index.get(&remote.path) {
            Some(local) => !local.deleted && !local.placeholder && local.has_cdc_view(),
            None => false,
        }
    }

    /// 开启一条在途接收。返回 `false` = 路径被拒(硬忽略 / 越界),已就地交还认领。
    fn open_pending(
        &mut self,
        kind: PendingKind,
        remote: IndexEntry,
        local: Option<StoredEntry>,
    ) -> bool {
        let cdc = self.plan_cdc(&remote);
        // 句柄创建即路径校验:执行器的硬忽略/越界闸门在这里是最后一道。
        // 不安全就整条不接收 —— 本轮该路径不产生任何磁盘动作。
        let handle: Box<dyn ReceiveHandle> = match self.deps.executor.clone() {
            Some(executor) => match executor.begin_receive(&remote, cdc) {
                Ok(handle) => Box::new(handle),
                Err(_) => {
                    // 路径被拒:认领当场交还,否则台账要空挂到保鲜期过
                    self.release_claim(&remote.path);
                    return false;
                }
            },
            None => Box::new(MemoryReceiveHandle::new(&remote, cdc)),
        };
        let started_at = self.now();
        self.pending.insert(
            remote.path.clone(),
            PendingEntry {
                kind,
                entry: remote,
                local,
                handle,
                cdc,
                started_at,
            },
        );
        true
    }

    fn try_claim(&mut self, entry: &IndexEntry) -> bool {
        let now = self.now();
        let key = version_key(entry);
        {
            let mut ledger = self.deps.ledger.borrow_mut();
            if let Some(holder) = ledger.get(&entry.path) {
                if holder.claim_id != self.claim_id
                    && holder.key == key
                    && now - holder.ts < RECEIVE_CLAIM_TTL_MS
                {
                    return false; // 另一条管线正在收同一版本
                }
            }
            ledger.insert(
                entry.path.clone(),
                ReceiveClaim {
                    claim_id: self.claim_id,
                    key,
                    ts: now,
                },
            );
        }
        self.claims.insert(entry.path.clone());
        true
    }

    fn release_claim(&mut self, path: &str) {
        if !self.claims.remove(path) {
            return;
        }
        let mut ledger = self.deps.ledger.borrow_mut();
        if ledger.get(path).map(|c| c.claim_id) == Some(self.claim_id) {
            ledger.remove(path);
        }
    }

    fn abort_pending(&mut self, path: &str) {
        if let Some(mut item) = self.pending.remove(path) {
            item.handle.abort(false);
        }
        self.priorities.remove(path);
        self.release_claim(path);
        self.pending_blocks.retain(|_, b| b.path != path);
    }

    fn partial_bytes(&self, entry: &IndexEntry) -> u64 {
        let Some(executor) = self.deps.executor.clone() else {
            return 0;
        };
        executor.partial_bytes(entry, self.plan_cdc(entry))
    }

    fn expected_wire_bytes(&self, request: &WireBlockRequest) -> usize {
        let mut plain = if request.cdc == Some(true) {
            CDC_MAX_CHUNK
        } else {
            BLOCK_SIZE
        };
        let index = self.idx();
        if let Some(entry) = index.get(&request.path) {
            if !entry.deleted {
                if request.cdc == Some(true) {
                    if let Some(clens) = entry.clens.as_ref() {
                        if let Some(len) = clens.get(request.block_index as usize) {
                            plain = *len as usize;
                        }
                    }
                } else {
                    let remain = entry
                        .size
                        .saturating_sub(request.block_index * BLOCK_SIZE as u64);
                    if remain > 0 && remain < BLOCK_SIZE as u64 {
                        plain = remain as usize;
                    }
                }
            }
        }
        // 保守按文本信封估(两层 base64 ≈ 1.78 倍)。二进制信封会低估一部分,
        // 但窗口的语义是「别攒到内存爆掉」,保守方向的误差只让窗口更早关上。
        plain + 16 + (plain * 7 / 9) + 512
    }

    fn has_send_room(&self, wire_bytes: usize) -> bool {
        // 单块就超过整个窗口时窗口没有意义:放行它,否则它会永远卡在队首,
        // 让整条延迟队列停摆 —— 那比当初的 OOM 更难查。
        self.inflight_bytes + wire_bytes < SEND_WINDOW_BYTES
    }

    fn defer_request(&mut self, request: WireBlockRequest) {
        if self.deferred.len() >= DEFERRED_MAX {
            return; // 满则装作没听见,对端的重试会再来
        }
        let key = block_key(
            &request.path,
            request.block_index,
            request.cdc == Some(true),
        );
        if !self.deferred_keys.insert(key) {
            return;
        }
        if request.priority == Some(true) {
            self.deferred.insert(0, request);
        } else {
            self.deferred.push(request);
        }
    }

    /// 驱动层在 socket 写完一批帧后调用:按顺序重放延迟队列。
    pub fn pump_deferred(&mut self) {
        if self.deferred.is_empty() {
            return;
        }
        let queued = std::mem::take(&mut self.deferred);
        self.deferred_keys.clear();
        for request in queued {
            if self.has_send_room(self.expected_wire_bytes(&request)) {
                self.serve_block(request);
            } else {
                self.defer_request(request);
            }
        }
    }

    /// 当前延迟队列长度(观测用)。
    pub fn deferred_len(&self) -> usize {
        self.deferred.len()
    }
}

/* ==================== 自由函数 ==================== */

fn slot_count(item: &PendingEntry) -> usize {
    if item.cdc {
        item.entry.cdh.as_ref().map(|h| h.len()).unwrap_or(0)
    } else {
        item.entry.blocks.len()
    }
}

fn block_key(path: &str, block_index: u64, cdc: bool) -> String {
    format!("{}|{path}|{block_index}", if cdc { 'c' } else { 'b' })
}

fn block_slot(key: &str) -> u64 {
    key.rsplit('|')
        .next()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0)
}

/// 重试时要重发的那条哈希:从 pending 条目的对应槽位取。
/// `None` = 条目已不在(或槽位越界),这条重试链自愈路径是下一轮索引重新规划。
fn block_hash(peer: &Peer, key: &str) -> Option<String> {
    let block = peer.pending_blocks.get(key)?;
    let slot = block_slot(key) as usize;
    let item = peer.pending.get(&block.path)?;
    let hashes = if item.cdc {
        item.entry.cdh.as_ref()?
    } else {
        &item.entry.blocks
    };
    hashes.get(slot).cloned()
}

/// 条目的版本指纹:尺寸 + 全部块哈希(CDC 视图一并计入)的摘要。
///
/// 只用于台账里「是否同一版本」的相等比较 —— 同一设备经两条连接发来的同一份宣告,
/// 结构相等,指纹必相等;任何真实改动(尺寸/块/边界变)指纹即变。
fn version_key(entry: &IndexEntry) -> String {
    if entry.deleted {
        return "tombstone".to_string();
    }
    let material = format!(
        "{}|{}|{}",
        entry.size,
        entry.blocks.join(","),
        entry.cdh.as_ref().map(|h| h.join(",")).unwrap_or_default()
    );
    hash_block(material.as_bytes())
}

/// 定位读并循环读满。
///
/// **必须循环**:单次定位读的短读是 POSIX 允许的正常返回,不循环就会拿半截字节去
/// 验哈希 —— 那是一条**每次都对不上**的假 drift / 假清位。
fn read_at(root: &Path, rel: &str, offset: u64, length: u64) -> std::io::Result<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    let abs = resolve_share_path(root, rel, false)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e.to_string()))?;
    let mut file = std::fs::File::open(abs)?;
    file.seek(SeekFrom::Start(offset))?;
    let mut buf = vec![0u8; length as usize];
    let mut got = 0usize;
    while got < buf.len() {
        let n = file.read(&mut buf[got..])?;
        if n == 0 {
            break;
        }
        got += n;
    }
    buf.truncate(got);
    Ok(buf)
}

fn base64(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn unb64(text: &str) -> Result<Vec<u8>, ()> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(text)
        .map_err(|_| ())
}

/// 槽位布局的长度表(供测试与外部调用方复用同一口径)。
pub fn entry_slot_lengths(entry: &IndexEntry, cdc: bool) -> Vec<u64> {
    slot_layout(entry, cdc)
        .map(|layout| layout.lengths)
        .unwrap_or_default()
}

/// 读某文件某槽位的明文(供预填 / 供块复核;不经网络)。
pub fn read_slot(
    root: &Path,
    entry: &IndexEntry,
    cdc: bool,
    slot: usize,
) -> std::io::Result<Vec<u8>> {
    let lengths = entry_slot_lengths(entry, cdc);
    let offset: u64 = lengths.iter().take(slot).sum();
    let length = lengths.get(slot).copied().unwrap_or(0);
    read_at(root, &entry.path, offset, length)
}

/// 计算一份文件的完整视图(定长块 + CDC 块),供外部调用方复用。
pub fn file_views(path: &Path) -> std::io::Result<syncx_core::blockstore::FileViews> {
    hash_file_views(path)
}

/// 默认时钟:与 Node 的 `Date.now()` 同口径的墙钟毫秒。
pub fn wall_clock() -> i64 {
    now_ms()
}
