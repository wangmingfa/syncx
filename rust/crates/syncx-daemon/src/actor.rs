//! 会话状态机:把扫描、执行、各连接的会话层串成**单线程串行**的一个 loop。
//!
//! Node 侧这一层的并发保证来自「单线程事件循环 + 每个 await 之间不让出决策权」。
//! Rust 侧用两种东西共同复刻它:
//!
//!  1. **一条串行命令通道**:所有状态变更经 `Cmd` 进入同一处理函数,不存在两条
//!     命令交错改同一份索引的可能。
//!  2. **`Rc` 而不是 `Arc`**:索引与认领台账刻意不实现 `Send`,于是「跨线程共享
//!     它们」在类型层面就是不可能的 —— 编译器替我们守住这条不变量。
//!
//! 对外只暴露两样东西:命令(`Cmd`)与只读快照(`StatusSnapshot`)。快照用
//! `Arc<Mutex<..>>` 原子替换,读状态的一方(HTTP 接口、状态推送)不必持锁等待,
//! 也不会看到半更新的状态。
//!
//! 网络驱动**不在**本模块:连接上的收发由 `syncx-net` 的 async task 负责,收进来的
//! 帧转成 [`Cmd::PeerIndex`] 等命令投递回来。这样「谁碰状态」只有一条路。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::{mpsc, Arc, Mutex};

use syncx_core::ignore::IgnoreRuleset;
use syncx_core::plan::IndexEntry;
use syncx_net::wire::{WireBlockRequest, WireBlockResponse, WireEntry};

use crate::entry::StoredEntry;
use crate::executor::LocalExecutor;
use crate::indexstore::{IndexCounts, IndexStore, StoreError};
use crate::peer::{
    ConflictPolicy, IndexMode, Outbound, Peer, PeerDeps, Progress, SharedIndex, SharedLedger,
};
use crate::scanner::{scan_folder, ScanDiff};

/// 单个共享目录的运行期状态。
pub struct Folder {
    pub id: String,
    /// 磁盘上的绝对根。
    pub root: PathBuf,
    pub index: Rc<IndexStore>,
    pub executor: Rc<LocalExecutor>,
    pub local_index: SharedIndex,
    pub ledger: SharedLedger,
    pub rules: IgnoreRuleset,
    pub receive_only: bool,
    pub conflict_policy: ConflictPolicy,
    /// 暂停(目录级):数据面整体停摆,控制面照常。
    pub paused: bool,
    /// 暂停的单个文件(相对路径)。
    pub paused_files: Vec<String>,
    /// 基线扫描未跑完:首扫的存量文件不算「新增」,不写历史。
    pub baseline_pending: bool,
    /// 盘上残留的冲突副本数(目录卡徽标)。
    pub conflict_count: usize,
    /// 磁盘守卫拦下的原因(空 = 未拦截)。
    pub disk_blocked: Option<String>,
    /// 已建立的连接。每条连接有自己的会话层实例,共享 `local_index` 与 `ledger`。
    /// 槽位与 `sinks` 一一对应;连接拆除后槽位置 `None`(索引不变,避免错位串线)。
    pub peers: Vec<Option<Peer>>,
    /// 每条连接的出站通道。驱动层在这里等自己的帧。
    ///
    /// 用 tokio 的无界通道而不是 `std::sync::mpsc`:驱动层是 async 任务,`recv()`
    /// 直接就是 future;发送端是无界的 `send`,在 actor 线程(非 async)上也不会阻塞。
    pub sinks: Vec<Option<tokio::sync::mpsc::UnboundedSender<Outbound>>>,
    /// 兜底全量抑制台账(remote_device_id → (时刻, 指纹)):跨 attach 保留,
    /// 会话重建不清;所有连接共享,见 `SharedFullIndexSent` 与
    /// `INITIAL_FALLBACK_SUPPRESS_MS`。
    pub full_index_sent: crate::peer::SharedFullIndexSent,
}

impl Folder {
    /// 一条连接的会话层。`device_id`/`remote_device_id` 在该连接上固定不变。
    pub fn open_peer(
        &mut self,
        device_id: String,
        remote_device_id: String,
        sink: tokio::sync::mpsc::UnboundedSender<Outbound>,
    ) -> usize {
        let peer = Peer::new(PeerDeps {
            local_index: Rc::clone(&self.local_index),
            ledger: Rc::clone(&self.ledger),
            index: Rc::clone(&self.index),
            executor: Some(Rc::clone(&self.executor)),
            device_id,
            remote_device_id,
            root: self.root.clone(),
            rules: self.rules.clone(),
            receive_only: self.receive_only,
            conflict_policy: self.conflict_policy,
            now: Rc::new(crate::peer::wall_clock),
            on_demand: None,
            is_paused: {
                let paused = self.paused_files.clone();
                Some(Rc::new(move |path: &str| paused.iter().any(|p| p == path)))
            },
            check_disk_space: None,
            full_index_sent: Rc::clone(&self.full_index_sent),
        });
        // 复用已拆除的槽位,避免长跑进程里槽位无限增长
        if let Some(slot) = self.peers.iter().position(|p| p.is_none()) {
            self.peers[slot] = Some(peer);
            self.sinks[slot] = Some(sink);
            return slot;
        }
        self.peers.push(Some(peer));
        self.sinks.push(Some(sink));
        self.peers.len() - 1
    }

    /// 拆除一条连接:作废在途接收、释放认领、丢弃出站通道。
    pub fn close_peer(&mut self, slot: usize) {
        if let Some(Some(peer)) = self.peers.get_mut(slot) {
            peer.dispose();
            peer.release_claims();
        }
        if let Some(entry) = self.peers.get_mut(slot) {
            *entry = None;
        }
        if let Some(sink) = self.sinks.get_mut(slot) {
            *sink = None;
        }
    }

    /// 取走各连接的运行期事件,并带回「(来源设备, 落地条目)」列表供中转。
    fn drain_events(&mut self, drain: &mut FolderDrain) -> Vec<(String, Vec<WireEntry>)> {
        let mut batches = Vec::new();
        for peer in self.peers.iter_mut().flatten() {
            drain.events.append(&mut peer.drain_events());
            drain.hard_ignored.append(&mut peer.drain_hard_ignored());
            drain.stall_dropped.append(&mut peer.drain_stall_dropped());
            if drain.initial_outcome.is_none() {
                drain.initial_outcome = peer.take_initial_outcome();
            }
            let entries = peer.drain_relay();
            if !entries.is_empty() {
                batches.push((peer.remote_device_id().to_string(), entries));
            }
        }
        batches
    }

    /// 中转(ADR-0014):把各来源的落地条目分发给同目录的其余连接。
    ///
    /// 按设备去重:同一设备可能挂着两条连接,每台至多发一份,来源设备的其余连接
    /// 也不收 —— 它刚发过,再收只会诱发对端重复落地。回声的第二道闸在接收端:
    /// 来源端对「自己刚发来的版本」判 equal 直接空操作;两道闸叠加,版本向量一旦
    /// 全网一致,所有比较都变 equal,消息图自然静止。
    fn relay_to_siblings(&mut self, batches: Vec<(String, Vec<WireEntry>)>) {
        for (source_device, entries) in batches {
            let mut covered = std::collections::HashSet::from([source_device]);
            for peer in self.peers.iter_mut().flatten() {
                let device = peer.remote_device_id().to_string();
                if covered.contains(&device) {
                    continue;
                }
                covered.insert(device);
                peer.relay_entries(&entries);
            }
        }
    }

    fn peer(&mut self, slot: usize) -> Option<&mut Peer> {
        self.peers.get_mut(slot).and_then(|p| p.as_mut())
    }

    /// 把本目录各连接的待发帧推给各自的驱动层。
    pub fn flush_outbound(&mut self) {
        for (slot, peer) in self.peers.iter_mut().enumerate() {
            let Some(peer) = peer.as_mut() else { continue };
            let frames = peer.drain_outbound();
            if frames.is_empty() {
                continue;
            }
            let Some(sink) = self.sinks.get(slot).and_then(|s| s.as_ref()) else {
                continue;
            };
            for frame in frames {
                // 驱动层已退出 = 连接已死,剩余帧直接丢弃(release 时自会收敛)
                if sink.send(frame).is_err() {
                    break;
                }
            }
        }
    }

    /// 重新加载忽略规则并按当前配置刷新每条连接的判定函数。
    ///
    /// 连接建立后再改 `.syncxignore` 也即时生效 —— 快照一份就要等重连,那正是
    /// ADR-0012 里「改了规则不生效,文件还是被覆盖」的形态。
    pub fn refresh_rules(&mut self, lines: &[String]) {
        self.rules = IgnoreRuleset::from_lines(lines);
        for peer in self.peers.iter_mut().flatten() {
            peer.set_rules(self.rules.clone());
        }
    }

    /// 扫一轮:对比索引,产出改动/墓碑并落到索引里。
    pub fn scan(
        &mut self,
        device_id: &str,
        nested_roots: &[PathBuf],
    ) -> Result<ScanDiff, StoreError> {
        if self.paused {
            return Ok(ScanDiff::default());
        }
        let diff = scan_folder(
            &self.root,
            &self.index,
            &self.rules,
            device_id,
            nested_roots,
        )?;
        self.conflict_count = diff.conflict_count;

        for tomb in &diff.tombstones {
            if self.paused_files.iter().any(|p| p == &tomb.path) {
                continue; // 冻结路径连本地删除也不外推
            }
            let _ = self.executor.apply_delete(&self.index, &tomb.path, tomb);
            self.local_index
                .borrow_mut()
                .insert(tomb.path.clone(), tomb.clone());
        }

        let mut sends: Vec<StoredEntry> = diff
            .tombstones
            .iter()
            .filter(|t| !self.paused_files.iter().any(|p| p == &t.path))
            .cloned()
            .collect();

        for path in &diff.changed {
            if self.paused_files.iter().any(|p| p == path) {
                continue; // 本机改动不外推
            }
            match self.executor.apply_send(&self.index, path, device_id) {
                Ok(updated) => {
                    self.local_index
                        .borrow_mut()
                        .insert(path.clone(), updated.clone());
                    sends.push(updated);
                }
                // 文件在扫描后被删除/改名:下一轮扫描按墓碑处理
                Err(_) => continue,
            }
        }

        if !sends.is_empty() && !self.receive_only {
            self.broadcast(&sends);
        }
        self.baseline_pending = false;
        Ok(diff)
    }

    /// 本机改动外推到所有连接。
    fn broadcast(&mut self, entries: &[StoredEntry]) {
        let wire: Vec<WireEntry> = entries
            .iter()
            .map(|e| WireEntry::from_entry(&e.core(), e.mtime.unwrap_or(0)))
            .collect();
        for peer in self.peers.iter_mut().flatten() {
            peer.send_delta(wire.clone());
        }
    }

    /// 当前在途接收/发送的合计进度(各连接求和)。
    pub fn progress(&mut self) -> Progress {
        let mut total = Progress::default();
        for peer in self.peers.iter_mut().flatten() {
            let one = peer.progress();
            total.pending += one.pending;
            total.sending += one.sending;
            total.receiving += one.receiving;
            total.send_rate += one.send_rate;
            total.receive_rate += one.receive_rate;
            total.files.extend(one.files);
        }
        total
    }

    pub fn counts(&self) -> Result<IndexCounts, StoreError> {
        self.index.count_entries()
    }

    /// 从索引库重新装入内存索引(启动时一次)。
    pub fn load_index(&self) -> Result<(), StoreError> {
        let entries = self.index.list_entries()?;
        let mut index = self.local_index.borrow_mut();
        index.clear();
        for entry in entries {
            index.insert(entry.path.clone(), entry);
        }
        Ok(())
    }
}

/// 一条命令。网络驱动与定时器都只能通过它改变状态。
pub enum Cmd {
    /// 扫描某个目录(定时器驱动)。
    Scan,
    /// 只扫一个目录(watcher 事件触发;定时兜底全扫仍走 [`Cmd::Scan`])。
    ///
    /// 判定与 [`Cmd::Scan`] 完全同管线,只是范围收窄到该目录。目录不存在时为空操作:
    /// watcher 的请求与 actor 的状态之间没有事务,目录可能在请求排队期间被移除。
    ScanFolder { folder: String },
    /// 对端索引到达。
    PeerIndex {
        folder: String,
        peer: usize,
        entries: Vec<WireEntry>,
        mode: IndexMode,
        relayed: bool,
    },
    /// 对端块请求到达。
    PeerBlockRequest {
        folder: String,
        peer: usize,
        request: WireBlockRequest,
    },
    /// 对端块响应到达。
    PeerBlockResponse {
        folder: String,
        peer: usize,
        response: WireBlockResponse,
    },
    /// 一条新连接接入某个目录。
    ///
    /// 槽位必须由 actor 线程分配(它拥有 `peers` 表),而驱动层拿到槽位才能投递后续
    /// 命令,所以这里带一个一次性回执通道。`spawn_actor` 的线程内构造保证了
    /// `Peer`(含 `Rc`)从不在别的线程上被碰。
    PeerAttach {
        folder: String,
        remote_device_id: String,
        sink: tokio::sync::mpsc::UnboundedSender<Outbound>,
        reply: tokio::sync::oneshot::Sender<Option<usize>>,
    },
    /// 会话建立:开始初始索引交换。
    PeerOpen { folder: String, peer: usize },
    /// 对端索引指纹到达(初始交换第一阶段)。
    PeerIndexFingerprint {
        folder: String,
        peer: usize,
        fingerprint: String,
    },
    /// 对端确认两侧索引一致。
    PeerIndexAck { folder: String, peer: usize },
    /// 对端请求本机全量索引。
    PeerIndexRequest { folder: String, peer: usize },
    /// 驱动层已把一条出站块响应真正写进 socket:释放发送窗口并重放延迟队列。
    ///
    /// 必须带字节数与目标连接:窗口是**每条连接**独立的账,漏扣会让该连接的窗口
    /// 永久关闭(症状是「同步卡住但没有任何错误」,比当初的 OOM 更难查)。
    Flushed {
        folder: String,
        peer: usize,
        bytes: usize,
    },
    /// 会话拆除:释放认领、作废在途接收。
    PeerClose { folder: String, peer: usize },
    /// 用户点名优先同步某文件。
    Prioritize { folder: String, path: String },
    /// 按需同步:把占位条目拉回来。
    Materialize { folder: String, path: String },
    /// 刷新忽略规则。
    ReloadIgnore { folder: String, lines: Vec<String> },
    /// 处理到期的重试与租约。
    Poll,
    /// 取走各目录各连接的运行期事件(同步记录、中转落地、丢弃计数)。
    ///
    /// 会话层把这些暂存在 `Peer` 里,装配层要写进 `HistoryStore`、要算冲突计数、
    /// 要把落地条目继续中转出去 —— 但 `SessionActor.folders` 与 `Peer` 都是私有且
    /// `!Send` 的,只能在 actor 线程上取。所以这里用一条带一次性回执的命令把它们
    /// 整体搬出来,而不是给会话层开一堆只读访问器(那样反而会让「谁是唯一写入者」
    /// 变模糊)。
    Drain {
        reply: tokio::sync::oneshot::Sender<Vec<FolderDrain>>,
    },
    /// 取某目录的全部索引条目(含墓碑)。目录不存在回 `None`。
    ///
    /// 控制面 `folder-index-request` 要按对端请求回快照;索引在 actor 线程上,
    /// 只能这样搬出来。
    IndexSnapshot {
        folder: String,
        reply: tokio::sync::oneshot::Sender<Option<Vec<StoredEntry>>>,
    },
    /// 查某目录的一条索引。目录/条目不存在回 `None`。
    EntryLookup {
        folder: String,
        path: String,
        reply: tokio::sync::oneshot::Sender<Option<StoredEntry>>,
    },
    /// 控制面在目录内落了一个文件:把新条目写进索引库与内存索引。
    ///
    /// 与 `Folder::scan` / `Peer::on_peer_index` 并列,是**第三种**写入路径
    /// (人工「同步这一处」)。它必须走 actor:索引库只有 actor 线程持有,
    /// 旁路直接写库会让内存索引与库不一致,下一轮扫描把同一条改动重发一遍。
    StoreEntry { folder: String, entry: StoredEntry },
    /// 控制面按「本机此刻的配置」重建目录列表。
    ///
    /// 配置热重载 / 接受邀请 / 忽略规则变更都会改变目录集合、根路径、忽略规则与
    /// 暂停状态。`Folder` 含 `Rc`,只能在 actor 线程构造,所以这里递的是纯数据
    /// ([`FolderSpec`])。
    Reload { specs: Vec<FolderSpec> },
    /// 退出。
    Shutdown,
}

/// 由配置折算出的目录构造参数(纯数据,可跨线程)。
///
/// 路径一律由装配层按 `<configDir>/index-<hash>.db` 算好 —— 与 Node 共用同一个
/// 数据目录,拼错一个字符就是「换后端之后索引全空、对端文件成批删除」。
pub struct FolderSpec {
    pub id: String,
    pub root: PathBuf,
    pub index_path: PathBuf,
    pub trash_dir: PathBuf,
    pub versions_dir: PathBuf,
    pub versions_per_path: Option<usize>,
    pub rules: IgnoreRuleset,
    pub receive_only: bool,
    pub conflict_policy: ConflictPolicy,
    pub paused: bool,
    pub paused_files: Vec<String>,
    /// 基线未跑完:首扫的存量文件不算「新增」。
    pub baseline_pending: bool,
}

/// 一个目录这一轮被取走的事件。
#[derive(Debug, Default)]
pub struct FolderDrain {
    pub folder: String,
    pub events: Vec<crate::peer::SyncEvent>,
    /// 因硬忽略被丢弃的对端路径。
    pub hard_ignored: Vec<String>,
    /// 因长时间拿不到块而放弃的路径与缺失块数。
    pub stall_dropped: Vec<(String, usize)>,
    /// 初始索引交换的结论(`fallback` / `fallback-suppressed` / `skipped` /
    /// `request-served`)。只报一次。
    pub initial_outcome: Option<&'static str>,
}

/// 只读状态快照。上层(HTTP / 状态推送)读它,不必与 actor 抢锁。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct StatusSnapshot {
    pub folders: Vec<FolderStatus>,
    pub total_entries: u64,
    pub total_tombstones: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FolderStatus {
    pub id: String,
    pub path: String,
    pub paused: bool,
    pub receive_only: bool,
    pub peers: usize,
    pub entries: u64,
    pub tombstones: u64,
    pub conflicts: usize,
    pub disk_blocked: Option<String>,
    pub progress: Progress,
}

/// 会话状态机本体。所有方法都在**同一线程**上调用;`Rc` 字段天然拦住跨线程使用。
pub struct SessionActor {
    device_id: String,
    folders: Vec<Folder>,
    snapshot: Arc<Mutex<StatusSnapshot>>,
}

impl SessionActor {
    pub fn new(device_id: impl Into<String>, snapshot: Arc<Mutex<StatusSnapshot>>) -> Self {
        Self {
            device_id: device_id.into(),
            folders: Vec::new(),
            snapshot,
        }
    }

    /// 快照句柄(可跨线程克隆读取)。
    pub fn snapshot(&self) -> Arc<Mutex<StatusSnapshot>> {
        Arc::clone(&self.snapshot)
    }

    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    pub fn add_folder(&mut self, folder: Folder) -> Result<(), StoreError> {
        folder.load_index()?;
        self.folders.push(folder);
        Ok(())
    }

    pub fn folder_mut(&mut self, id: &str) -> Option<&mut Folder> {
        self.folders.iter_mut().find(|f| f.id == id)
    }

    pub fn folder(&self, id: &str) -> Option<&Folder> {
        self.folders.iter().find(|f| f.id == id)
    }

    /// 处理一条命令。返回 `false` 表示该退出循环。
    pub fn handle(&mut self, cmd: Cmd) -> bool {
        match cmd {
            Cmd::Shutdown => return false,
            Cmd::Scan => self.scan_subset(None),
            Cmd::ScanFolder { folder } => self.scan_subset(Some(&folder)),
            Cmd::Poll => self.poll_all(),
            Cmd::PeerIndex {
                folder,
                peer,
                entries,
                mode,
                relayed,
            } => {
                self.with_peer(&folder, peer, |p| p.on_peer_index(entries, mode, relayed));
            }
            Cmd::PeerBlockRequest {
                folder,
                peer,
                request,
            } => {
                self.with_peer(&folder, peer, |p| p.on_block_request(request));
            }
            Cmd::PeerBlockResponse {
                folder,
                peer,
                response,
            } => {
                self.with_peer(&folder, peer, |p| p.on_block_response(response));
            }
            Cmd::PeerAttach {
                folder,
                remote_device_id,
                sink,
                reply,
            } => {
                // 本机设备 ID 归 actor 所有:连接方不必再传一次(传错会让冲突副本
                // 落到错误的名字上,而这里根本没有第二个来源)
                let device_id = self.device_id.clone();
                let slot = self
                    .folder_mut(&folder)
                    .map(|state| state.open_peer(device_id, remote_device_id, sink));
                // 回执失败 = 驱动层已经走了,槽位稍后会被 PeerClose 收掉;
                // 这里不主动回收,免得与「同一槽位刚被另一条连接接手」竞态。
                let _ = reply.send(slot);
            }
            Cmd::PeerOpen { folder, peer } => {
                self.with_peer(&folder, peer, |p| p.begin_initial_exchange());
            }
            Cmd::PeerIndexFingerprint {
                folder,
                peer,
                fingerprint,
            } => {
                self.with_peer(&folder, peer, |p| p.on_index_fingerprint(&fingerprint));
            }
            Cmd::PeerIndexAck { folder, peer } => {
                self.with_peer(&folder, peer, |p| p.on_index_ack());
            }
            Cmd::PeerIndexRequest { folder, peer } => {
                self.with_peer(&folder, peer, |p| p.on_index_request());
            }
            Cmd::Flushed {
                folder,
                peer,
                bytes,
            } => {
                if let Some(state) = self.folder_mut(&folder) {
                    if let Some(p) = state.peer(peer) {
                        p.note_flushed(bytes);
                        p.pump_deferred();
                    }
                }
            }
            Cmd::PeerClose { folder, peer } => {
                if let Some(state) = self.folder_mut(&folder) {
                    state.close_peer(peer);
                }
            }
            Cmd::Prioritize { folder, path } => {
                if let Some(f) = self.folder_mut(&folder) {
                    for peer in f.peers.iter_mut().flatten() {
                        peer.mark_priority(&path);
                    }
                }
            }
            Cmd::Materialize { folder, path } => {
                if let Some(f) = self.folder_mut(&folder) {
                    for peer in f.peers.iter_mut().flatten() {
                        peer.materialize(&path);
                    }
                }
            }
            Cmd::ReloadIgnore { folder, lines } => {
                if let Some(f) = self.folder_mut(&folder) {
                    f.refresh_rules(&lines);
                }
            }
            Cmd::Drain { reply } => {
                let _ = reply.send(self.drain_all());
            }
            Cmd::IndexSnapshot { folder, reply } => {
                let entries = self
                    .folder(&folder)
                    .map(|f| f.index.list_entries())
                    .transpose()
                    .ok()
                    .flatten();
                let _ = reply.send(entries);
            }
            Cmd::EntryLookup {
                folder,
                path,
                reply,
            } => {
                let entry = self
                    .folder(&folder)
                    .and_then(|f| f.index.get_entry(&path).ok().flatten());
                let _ = reply.send(entry);
            }
            Cmd::StoreEntry { folder, entry } => {
                if let Some(f) = self.folder_mut(&folder) {
                    // 先写库再改内存索引:反过来时若写库失败,内存里就多了一条库里
                    // 没有的条目 —— 重启后它消失,表现为「文件在盘上但不同步」。
                    if f.index.save_entry(&entry).is_ok() {
                        f.local_index.borrow_mut().insert(entry.path.clone(), entry);
                    }
                }
            }
            Cmd::Reload { specs } => self.reload(specs),
        }
        self.flush_outbound();
        self.publish();
        true
    }

    fn with_peer(&mut self, folder: &str, peer: usize, f: impl FnOnce(&mut Peer)) {
        if let Some(state) = self.folder_mut(folder) {
            if let Some(p) = state.peer(peer) {
                f(p);
            }
        }
    }

    /// 扫一轮。`only` 为 `Some` 时只扫指定目录(watcher 触发的单目录重扫)。
    ///
    /// 重入闸与现状一致:所有命令在本线程串行处理,同一时刻至多一轮扫描;排队的
    /// 重扫请求在前一轮结束后依次执行,不做合并 —— 聚合层(watcher 模块)已把同一
    /// 目录的请求压到每窗口一条,这里的队列不会堆积。嵌套共享根仍由全部目录的绝对
    /// 根换算而来,与全扫同一口径。
    fn scan_subset(&mut self, only: Option<&str>) {
        let roots: Vec<PathBuf> = self
            .folders
            .iter()
            .map(|f| crate::scanner::normalize_path(&f.root))
            .collect();
        let device_id = self.device_id.clone();
        for index in 0..self.folders.len() {
            if let Some(only) = only {
                if self.folders[index].id != only {
                    continue;
                }
            }
            let mine = roots[index].clone();
            let nested: Vec<PathBuf> = roots.iter().filter(|r| **r != mine).cloned().collect();
            let folder = &mut self.folders[index];
            if let Err(error) = folder.scan(&device_id, &nested) {
                tracing::warn!(folder = %folder.id, %error, "扫描失败");
            }
        }
    }

    /// 取走全部目录的全部运行期事件(见 [`Cmd::Drain`]),并把落地条目中转给兄弟连接。
    fn drain_all(&mut self) -> Vec<FolderDrain> {
        let mut out = Vec::with_capacity(self.folders.len());
        for folder in &mut self.folders {
            let mut drain = FolderDrain {
                folder: folder.id.clone(),
                ..Default::default()
            };
            let batches = folder.drain_events(&mut drain);
            folder.relay_to_siblings(batches);
            out.push(drain);
        }
        out
    }

    /// 按新配置重建目录列表:保留仍存在目录的**连接槽位与索引**,只替换构造参数。
    ///
    /// 不能整体重建 —— 热重载是常态(改忽略规则就会触发),重建会把所有已建立的
    /// 连接槽位置空,对端那边看到的是一次无端的断线重连风暴。所以按 id 对齐:
    /// 老的留、新的加、消失的拆。
    fn reload(&mut self, specs: Vec<FolderSpec>) {
        let keep: Vec<String> = specs.iter().map(|s| s.id.clone()).collect();
        // 移除:先拆连接(释放认领),再丢弃整份状态
        let mut index = 0usize;
        while index < self.folders.len() {
            if keep.contains(&self.folders[index].id) {
                index += 1;
                continue;
            }
            let mut gone = self.folders.remove(index);
            for slot in 0..gone.peers.len() {
                gone.close_peer(slot);
            }
        }

        for spec in specs {
            if let Some(existing) = self.folders.iter_mut().find(|f| f.id == spec.id) {
                // 根路径变了等于换了一个目录:索引寿命 = 目录实例寿命,重开库。
                if crate::scanner::normalize_path(&existing.root)
                    != crate::scanner::normalize_path(&spec.root)
                {
                    existing.root = spec.root;
                    if let Ok(store) = IndexStore::open(&spec.index_path) {
                        existing.index = Rc::new(store);
                        let _ = existing.load_index();
                        existing.baseline_pending = existing
                            .local_index
                            .borrow()
                            .values()
                            .all(|entry| entry.deleted);
                    }
                }
                existing.rules = spec.rules;
                existing.receive_only = spec.receive_only;
                existing.conflict_policy = spec.conflict_policy;
                existing.paused = spec.paused;
                existing.paused_files = spec.paused_files;
                continue;
            }

            // 新目录:索引库不存在就是空的 → 基线未跑完
            let index = match IndexStore::open(&spec.index_path) {
                Ok(store) => Rc::new(store),
                Err(error) => {
                    tracing::warn!(folder = %spec.id, %error, "索引库打开失败,跳过该目录");
                    continue;
                }
            };
            let executor = Rc::new(LocalExecutor::new(
                spec.root.clone(),
                spec.trash_dir,
                Some(spec.versions_dir),
                spec.versions_per_path,
            ));
            let folder = Folder {
                id: spec.id,
                root: spec.root,
                index,
                executor,
                local_index: Rc::new(std::cell::RefCell::new(std::collections::BTreeMap::new())),
                ledger: Rc::new(std::cell::RefCell::new(HashMap::new())),
                rules: spec.rules,
                receive_only: spec.receive_only,
                conflict_policy: spec.conflict_policy,
                paused: spec.paused,
                paused_files: spec.paused_files,
                baseline_pending: spec.baseline_pending,
                conflict_count: 0,
                disk_blocked: None,
                peers: Vec::new(),
                sinks: Vec::new(),
                full_index_sent: Rc::new(std::cell::RefCell::new(HashMap::new())),
            };
            if let Err(error) = self.add_folder(folder) {
                tracing::warn!(%error, "目录索引加载失败");
            }
        }
    }

    fn poll_all(&mut self) {
        let now = crate::peer::wall_clock();
        for folder in &mut self.folders {
            for peer in folder.peers.iter_mut().flatten() {
                peer.poll_timeouts(now);
                peer.pump_deferred();
            }
        }
    }

    /// 把各目录各连接的待发帧推给各自的驱动层。
    pub fn flush_outbound(&mut self) {
        for folder in &mut self.folders {
            folder.flush_outbound();
        }
    }

    /// 重新生成只读快照并原子替换。读侧永远看到完整的一份。
    pub fn publish(&mut self) {
        let mut folders = Vec::with_capacity(self.folders.len());
        let mut total_entries = 0u64;
        let mut total_tombstones = 0u64;
        for folder in &mut self.folders {
            let counts = folder.counts().unwrap_or_default();
            total_entries += counts.entries;
            total_tombstones += counts.tombstones;
            folders.push(FolderStatus {
                id: folder.id.clone(),
                path: folder.root.display().to_string(),
                paused: folder.paused,
                receive_only: folder.receive_only,
                peers: folder.peers.iter().filter(|p| p.is_some()).count(),
                entries: counts.entries,
                tombstones: counts.tombstones,
                conflicts: folder.conflict_count,
                disk_blocked: folder.disk_blocked.clone(),
                progress: folder.progress(),
            });
        }
        let next = StatusSnapshot {
            folders,
            total_entries,
            total_tombstones,
        };
        if let Ok(mut slot) = self.snapshot.lock() {
            *slot = next;
        }
    }
}

/// 命令发送端(可跨线程克隆)。
#[derive(Clone)]
pub struct ActorHandle {
    tx: mpsc::Sender<Cmd>,
    snapshot: Arc<Mutex<StatusSnapshot>>,
}

impl ActorHandle {
    pub fn send(&self, cmd: Cmd) -> bool {
        self.tx.send(cmd).is_ok()
    }

    /// 请求 actor 为一个目录开一条连接槽位。
    ///
    /// 会话层状态(`Rc`)只能在 actor 线程创建,所以这里只递「构造参数」并等回执。
    /// 目录不存在返回 `None`(调用方应直接断开);actor 已退出也返回 `None`。
    pub async fn attach_peer(
        &self,
        folder: impl Into<String>,
        remote_device_id: impl Into<String>,
        sink: tokio::sync::mpsc::UnboundedSender<Outbound>,
    ) -> Option<usize> {
        let (reply, rx) = tokio::sync::oneshot::channel();
        let sent = self.send(Cmd::PeerAttach {
            folder: folder.into(),
            remote_device_id: remote_device_id.into(),
            sink,
            reply,
        });
        if !sent {
            return None;
        }
        rx.await.ok().flatten()
    }

    /// 目录 id → 槽位。连接建立时用来把 wire 里的 `folder` 字段映射到本地目录。
    pub fn has_folder(&self, folder: &str) -> bool {
        self.snapshot
            .lock()
            .map(|s| s.folders.iter().any(|f| f.id == folder))
            .unwrap_or(false)
    }

    pub fn snapshot(&self) -> StatusSnapshot {
        self.snapshot.lock().map(|s| s.clone()).unwrap_or_default()
    }
}

/// 在**专属线程**上跑一个 actor loop。
///
/// 用 `std::thread` 而不是 `tokio::spawn`:状态里有 `Rc`,`!Send`,放进 tokio 的
/// 工作线程池就直接编译不过 —— 这正是我们要的保证。所以这里收的是一个**构造函数**,
/// 状态在线程内部创建、也从不离开那个线程;线程外只拿得到 `Send` 的命令通道与快照。
///
/// 单线程 + 阻塞收命令就是 Node 侧「单线程事件循环」的等价物。
pub fn spawn_actor<F>(build: F) -> ActorHandle
where
    F: FnOnce(Arc<Mutex<StatusSnapshot>>) -> SessionActor + Send + 'static,
{
    let (tx, rx) = mpsc::channel::<Cmd>();
    let snapshot = Arc::new(Mutex::new(StatusSnapshot::default()));
    let thread_snapshot = Arc::clone(&snapshot);
    std::thread::Builder::new()
        .name("syncx-actor".to_string())
        .spawn(move || {
            let mut actor = build(thread_snapshot);
            actor.publish();
            while let Ok(cmd) = rx.recv() {
                if !actor.handle(cmd) {
                    break;
                }
            }
            // 退出前把手上的会话全部收口:句柄关闭、认领释放
            for folder in &mut actor.folders {
                for peer in folder.peers.iter_mut().flatten() {
                    peer.dispose();
                    peer.release_claims();
                }
            }
        })
        .expect("actor 线程应能创建");
    ActorHandle { tx, snapshot }
}

/// 把索引条目转成 wire 形态(供上层构造初始索引)。
pub fn wire_entries(entries: &[StoredEntry]) -> Vec<WireEntry> {
    entries
        .iter()
        .map(|e| WireEntry::from_entry(&e.core(), e.mtime.unwrap_or(0)))
        .collect()
}

/// 由配置构造一个目录状态。`data_dir` 下按目录 id 分仓(索引库与回收站)。
pub fn build_folder(
    id: impl Into<String>,
    root: impl Into<PathBuf>,
    data_dir: &Path,
    rules: IgnoreRuleset,
) -> Result<Folder, StoreError> {
    let id = id.into();
    let root = root.into();
    let dir = data_dir.join("index").join(&id);
    std::fs::create_dir_all(&dir).map_err(|e| StoreError::Corrupt(e.to_string()))?;
    let index = Rc::new(IndexStore::open(&dir.join("index.db"))?);
    let executor = Rc::new(LocalExecutor::new(
        root.clone(),
        data_dir.join("trash").join(&id),
        Some(data_dir.join("versions").join(&id)),
        None,
    ));
    Ok(Folder {
        id,
        root,
        index,
        executor,
        local_index: Rc::new(std::cell::RefCell::new(std::collections::BTreeMap::new())),
        ledger: Rc::new(std::cell::RefCell::new(HashMap::new())),
        rules,
        receive_only: false,
        conflict_policy: ConflictPolicy::KeepBoth,
        paused: false,
        paused_files: Vec::new(),
        baseline_pending: false,
        conflict_count: 0,
        disk_blocked: None,
        peers: Vec::new(),
        sinks: Vec::new(),
        full_index_sent: Rc::new(std::cell::RefCell::new(HashMap::new())),
    })
}

/// 条目 → 相对路径的规范化(供上层比对用)。
pub fn entry_path(entry: &IndexEntry) -> &str {
    &entry.path
}

#[cfg(test)]
mod tests {
    //! 中转(ADR-0014)的行为测试:落地条目只发给同目录其余连接、按设备去重、
    //! 排除来源设备;full 交换与只收模式不中转。

    use super::*;

    struct TempDir(std::path::PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "syncx-actor-relay-{}-{}-{tag}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// 建一个挂了 A(来源)、B、B'、C 四条连接的目录;返回目录与各连接的接收端。
    /// `receive_only` 在 open_peer 之前生效:它是进 PeerDeps 的构造期快照。
    fn folder_with_peers(
        tag: &str,
        receive_only: bool,
    ) -> (
        TempDir,
        Folder,
        Vec<tokio::sync::mpsc::UnboundedReceiver<Outbound>>,
    ) {
        let dir = TempDir::new(tag);
        let root = dir.path().join("root");
        std::fs::create_dir_all(&root).unwrap();
        let mut folder =
            build_folder("f1", root, dir.path(), IgnoreRuleset::from_lines(&[])).unwrap();
        folder.receive_only = receive_only;
        let mut rxs = Vec::new();
        for remote in ["dev-a", "dev-b", "dev-b", "dev-c"] {
            let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
            folder.open_peer("local".to_string(), remote.to_string(), tx);
            rxs.push(rx);
        }
        (dir, folder, rxs)
    }

    fn empty_file_entry() -> WireEntry {
        WireEntry {
            path: "a.txt".to_string(),
            version: vec![("dev-a".to_string(), 1)],
            size: 0,
            deleted: false,
            blocks: Vec::new(),
            mtime: 1750000000123.456,
            cdh: None,
            clens: None,
        }
    }

    fn take_entries(
        rx: &mut tokio::sync::mpsc::UnboundedReceiver<Outbound>,
    ) -> Vec<(bool, bool, WireEntry)> {
        let mut out = Vec::new();
        while let Ok(frame) = rx.try_recv() {
            if let Outbound::Entries {
                entries,
                full,
                relayed,
            } = frame
            {
                out.push((full, relayed, entries[0].clone()));
            }
        }
        out
    }

    #[test]
    fn delta_landed_entries_relay_to_siblings_with_device_dedup() {
        let (_dir, mut folder, mut rxs) = folder_with_peers("delta", false);
        // A(槽 0)增量送达一条新文件 → 落地
        folder.peer(0).unwrap().on_peer_index(
            vec![empty_file_entry()],
            crate::peer::IndexMode::Delta,
            false,
        );
        let mut drain = FolderDrain::default();
        let batches = folder.drain_events(&mut drain);
        folder.relay_to_siblings(batches);
        folder.flush_outbound();

        // 来源端 A 不回弹;B 两条连接只收一份(去重);C 收到;全部是增量 + relayed
        assert!(take_entries(&mut rxs[0]).is_empty(), "来源端不得收到回弹");
        let b = take_entries(&mut rxs[1]);
        assert_eq!(b.len(), 1, "B 的第一条连接应恰好收到一份中转");
        assert!(!b[0].0, "中转必须是增量");
        assert!(b[0].1, "中转必须打 relayed 标记");
        assert_eq!(b[0].2.path, "a.txt");
        assert!(
            take_entries(&mut rxs[2]).is_empty(),
            "同一设备的第二条连接不得重复收"
        );
        let c = take_entries(&mut rxs[3]);
        assert_eq!(c.len(), 1, "C 应收到中转");
        // mtime 原样出线:newest-wins 靠它跨机比较,不能在枢纽被顶替
        assert_eq!(b[0].2.mtime, 1750000000123.456);
        assert_eq!(c[0].2.mtime, 1750000000123.456);
    }

    #[test]
    fn full_exchange_is_never_relayed() {
        let (_dir, mut folder, mut rxs) = folder_with_peers("full", false);
        folder.peer(0).unwrap().on_peer_index(
            vec![empty_file_entry()],
            crate::peer::IndexMode::Full,
            false,
        );
        let mut drain = FolderDrain::default();
        let batches = folder.drain_events(&mut drain);
        assert!(
            batches.is_empty(),
            "full 交换后整网已收敛,不得再进入中转集合"
        );
        folder.relay_to_siblings(batches);
        folder.flush_outbound();
        for rx in rxs.iter_mut() {
            assert!(take_entries(rx).is_empty());
        }
    }

    #[test]
    fn receive_only_folder_does_not_relay() {
        let (_dir, mut folder, mut rxs) = folder_with_peers("ro", true);
        folder.peer(0).unwrap().on_peer_index(
            vec![empty_file_entry()],
            crate::peer::IndexMode::Delta,
            false,
        );
        let mut drain = FolderDrain::default();
        let batches = folder.drain_events(&mut drain);
        assert!(batches.is_empty(), "只收模式的契约是不外推任何索引帧");
        folder.relay_to_siblings(batches);
        folder.flush_outbound();
        for rx in rxs.iter_mut() {
            assert!(take_entries(rx).is_empty());
        }
    }

    /// watcher 触发的单目录重扫:`Cmd::ScanFolder` 只落指定目录,不波及别的目录。
    /// 判定与全扫同管线(这里直接验证索引产出)。
    #[test]
    fn scan_folder_command_scans_only_that_folder() {
        let dir = TempDir::new("scan-one");
        let root_a = dir.path().join("a");
        let root_b = dir.path().join("b");
        std::fs::create_dir_all(&root_a).unwrap();
        std::fs::create_dir_all(&root_b).unwrap();
        let mut actor = SessionActor::new(
            "dev",
            Arc::new(Mutex::new(StatusSnapshot::default())),
        );
        actor
            .add_folder(
                build_folder("f-a", &root_a, dir.path(), IgnoreRuleset::from_lines(&[])).unwrap(),
            )
            .unwrap();
        actor
            .add_folder(
                build_folder("f-b", &root_b, dir.path(), IgnoreRuleset::from_lines(&[])).unwrap(),
            )
            .unwrap();
        let indexed = |actor: &SessionActor, id: &str| -> Vec<String> {
            actor
                .folder(id)
                .unwrap()
                .index
                .list_entries()
                .unwrap()
                .into_iter()
                .map(|entry| entry.path)
                .collect()
        };

        // 两个目录各落一个文件,但只点名扫 f-b
        std::fs::write(root_a.join("only-in-a.txt"), "x").unwrap();
        std::fs::write(root_b.join("only-in-b.txt"), "x").unwrap();
        assert!(actor.handle(Cmd::ScanFolder { folder: "f-b".to_string() }));
        assert!(
            indexed(&actor, "f-b").contains(&"only-in-b.txt".to_string()),
            "点名的目录应被扫描入索引"
        );
        assert!(
            indexed(&actor, "f-a").is_empty(),
            "单目录重扫不得波及其它目录"
        );

        // 再点名 f-a:它自己的文件入索引,f-b 不受影响
        assert!(actor.handle(Cmd::ScanFolder { folder: "f-a".to_string() }));
        assert!(indexed(&actor, "f-a").contains(&"only-in-a.txt".to_string()));
        assert_eq!(indexed(&actor, "f-b").len(), 1);

        // 点名不存在的目录:空操作,不崩
        assert!(actor.handle(Cmd::ScanFolder { folder: "gone".to_string() }));
    }

    /// 数一条接收端里的全量索引帧(不关心内容,空索引也算一份全量)。
    fn count_fulls(rx: &mut tokio::sync::mpsc::UnboundedReceiver<Outbound>) -> usize {
        let mut n = 0;
        while let Ok(frame) = rx.try_recv() {
            if matches!(
                frame,
                Outbound::Entries {
                    full: true,
                    relayed: false,
                    ..
                }
            ) {
                n += 1;
            }
        }
        n
    }

    #[test]
    fn initial_fallback_suppressed_on_reattach_within_window() {
        // 2026-11-04 风暴回归:旧版对端不认指纹,每次会话重建都触发兜底全量;
        // 窗口内 + 本机指纹未变时,重连后的兜底必须被抑制(对齐 MoonBit/Node)。
        let dir = TempDir::new("suppress");
        let root = dir.path().join("root");
        std::fs::create_dir_all(&root).unwrap();
        let mut folder =
            build_folder("f1", &root, dir.path(), IgnoreRuleset::from_lines(&[])).unwrap();
        let now = crate::peer::wall_clock();

        // 第一次 attach:台账为空,兜底照发全量
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        folder.open_peer("local".to_string(), "dev-b".to_string(), tx);
        folder.peer(0).unwrap().begin_initial_exchange();
        folder.peer(0).unwrap().poll_timeouts(now + 2_500);
        folder.flush_outbound();
        assert_eq!(count_fulls(&mut rx), 1);

        // 会话重建(同设备重开一条连接,旧连接 dispose):窗口内指纹未变 → 抑制
        folder.peer(0).unwrap().dispose();
        let (tx2, mut rx2) = tokio::sync::mpsc::unbounded_channel();
        folder.open_peer("local".to_string(), "dev-b".to_string(), tx2);
        folder.peer(1).unwrap().begin_initial_exchange();
        folder.peer(1).unwrap().poll_timeouts(now + 5_000);
        folder.flush_outbound();
        assert_eq!(count_fulls(&mut rx2), 0, "窗口内重连不得重发同指纹全量");
    }
}
