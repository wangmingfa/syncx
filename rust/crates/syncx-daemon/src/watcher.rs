//! 文件系统监听驱动的扫描触发。
//!
//! 架构契约(与 Node 后端约定一致,判定引擎零改动):
//!
//!  - **事件只当触发器**。监听到什么不重要,拿到「该目录需要重扫」这个事实后,
//!    判定仍然走现有扫描管线([`crate::actor::Folder::scan`] → [`crate::scanner::scan_folder`]):
//!    对比索引、diff、墓碑全部复用。watcher 不产生任何索引/墓碑数据。
//!  - **聚合防抖**。窗口内同目录 N 个事件塌缩成一次「该目录重扫」;窗口由**第一个**
//!    事件开启、到点即关(不用滑动窗口——持续写入会让滑动窗口永远不开,等于失明)。
//!    自己写入产生的事件不过滤:聚合后照常重扫,扫描管线本身幂等。
//!  - **定时兜底全扫不受影响**。watcher 只是给扫描加了一条更快的通路;健康的 watcher
//!    把兜底全扫拉长到可配置的间隔(缺省 600 秒),任何目录降级则退回原有扫描间隔。
//!    间隔的切换由装配层决定(见 syncx-cli 的 `spawn_scan_loop`),本模块只报告健康度。
//!  - **失效自愈**。目录被删/重建会让 inotify 的按 inode 监听静默失效(FSEvents 按路径
//!    监听也会漏掉删除期间的窗口),巡检按「目录存在 + dev/ino 未变」把关:消失期间
//!    只关不建(不崩),恢复时关闭重建并**立即**触发该目录一轮扫描。
//!
//! 与扫描重入闸的关系:重扫请求走 `Cmd::ScanFolder` 进 actor 的串行命令队列,与定时
//! 全扫、网络帧互斥 —— 同一时刻至多一轮扫描,排队语义与现状一致。聚合层保证同一目录
//! 一个窗口至多一条请求,队列不会被事件风暴灌满。
//!
//! 选型:`notify`(跨平台 inotify/FSEvents/ReadDirectoryChangesW 由 crate 保证)+
//! `notify-debouncer-full`(带 FileIdMap,把重命名成对事件缝合、剔除重复 create;
//! 相比 mini 的时间窗合并,它的每路径去重让「只当触发器」的误报显著更少 —— 扫描管线
//! 本身不便宜,少一次是一次)。事件到目录级的塌缩由本模块的聚合层完成。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use notify::RecursiveMode;
use notify_debouncer_full::{
    new_debouncer, DebounceEventResult, Debouncer, RecommendedCache,
};

/// 目录级聚合窗口。契约建议 2 秒;窗口内后续事件只累加计数,不重排截止时刻。
pub const FS_WATCH_WINDOW: Duration = Duration::from_secs(2);

/// 失效巡检的间隔:目录被删/重建后,重建延迟由它决定。10 秒对「目录换了盘」足够快,
/// 而消失期间的扫描由兜底定时器(装配层在健康度翻红后退回原有间隔)继续覆盖。
pub const FS_WATCH_SWEEP: Duration = Duration::from_secs(10);

/// 聚合日志的信息级阈值:窗口内事件数不超过它就用 info 记「N events -> 1 rescan」,
/// 超过(风暴)降为 debug,防刷屏。
const AGGREGATE_LOG_INFO_THRESHOLD: usize = 100;

/// 底层 debouncer 的每路径去重窗口。目录级塌缩由聚合层负责,这里只负责把原始事件
/// 归一化(缝合重命名对、剔除重复 create),取聚合窗口的 1/4 即可。
fn debouncer_timeout(window: Duration) -> Duration {
    window
        .checked_div(4)
        .filter(|t| *t >= Duration::from_millis(100))
        .unwrap_or(Duration::from_millis(100))
}

/// 一个待监听的共享目录。资格(未暂停、身份校验通过)由装配层判定 —— 判据依赖
/// config 与身份指纹,不该沉到 daemon 里重复一份。
#[derive(Debug, Clone)]
pub struct WatchFolderSpec {
    pub id: String,
    pub root: PathBuf,
}

/// 一条聚合后的重扫请求。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RescanRequest {
    pub folder: String,
    /// 本窗口塌缩掉的事件数(日志用,不参与判定)。
    pub events: usize,
    /// 触发原因。
    pub reason: RescanReason,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RescanReason {
    /// 目录内发生了文件事件。
    Watch,
    /// watcher 重建(目录恢复/被换掉)后的立即补扫。
    Rebuild,
}

/// watcher 健康度:装配层的扫描循环据此在「兜底全扫间隔」与「原有扫描间隔」之间切换。
///
/// 口径:**每个待监听目录都有活着的 watcher** 才算健康;没有任何待监听目录也是健康
/// (vacuous truth)—— 此时该不该定时兜底由装配层按配置开关另行判定。
#[derive(Default)]
pub struct WatchHealth {
    healthy: AtomicBool,
}

impl WatchHealth {
    pub fn healthy(&self) -> bool {
        self.healthy.load(Ordering::Relaxed)
    }
}

/// 事件处理器投进聚合层的原始批次。`events` 为 0 表示这是一条错误批次(不计入聚合)。
struct RawBatch {
    folder: String,
    events: usize,
    error: bool,
}

enum HubCmd {
    Sync(Vec<WatchFolderSpec>),
}

/// 一个目录的监听状态。
struct FolderState {
    id: String,
    root: PathBuf,
    /// 建监听时采到的 (dev, ino)。非 unix 拿不到,巡检退化为存在性检查。
    stam: Option<(u64, u64)>,
    watcher: Option<Debouncer<notify::RecommendedWatcher, RecommendedCache>>,
    /// 曾创建失败:健康度因此翻红,恢复成功才复位。
    degraded: bool,
    /// 降级 warn 只发一次,直到成功为止(不刷屏)。
    degrade_warned: bool,
    /// 打开中的聚合窗口。
    window: Option<WindowState>,
}

struct WindowState {
    events: usize,
    closes_at: Instant,
}

impl FolderState {
    fn new(spec: WatchFolderSpec) -> Self {
        Self {
            id: spec.id,
            root: spec.root,
            stam: None,
            watcher: None,
            degraded: false,
            degrade_warned: false,
            window: None,
        }
    }
}

/// unix 下的目录身份 (dev, ino)。目录被删重建会拿到新值 —— 与 `folderIdentity`
/// 同一判据,这里是纯 std 实现(daemon 不依赖 syncx-api)。
#[cfg(unix)]
fn folder_stam(root: &Path) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let meta = std::fs::metadata(root).ok()?;
    meta.is_dir().then(|| (meta.dev(), meta.ino()))
}

#[cfg(not(unix))]
fn folder_stam(_root: &Path) -> Option<(u64, u64)> {
    None
}

/// 尝试为一个目录建立监听。成功则替换 `state.watcher` 并返回 Ok。
fn try_watch(state: &mut FolderState, window: Duration, raw_tx: &tokio::sync::mpsc::UnboundedSender<RawBatch>) -> Result<(), notify::Error> {
    let timeout = debouncer_timeout(window);
    let folder = state.id.clone();
    let tx = raw_tx.clone();
    let handler = move |result: DebounceEventResult| match result {
        Ok(events) => {
            // 闭包必须是 FnMut(debouncer 会反复调用它),捕获的 folder 只能克隆后投递
            let _ = tx.send(RawBatch { folder: folder.clone(), events: events.len(), error: false });
        }
        Err(errors) => {
            for error in errors {
                tracing::debug!(folder = %folder, %error, "watcher 底层报错(多为目录删除的已知形态)");
            }
            let _ = tx.send(RawBatch { folder: folder.clone(), events: 0, error: true });
        }
    };
    let mut debouncer = new_debouncer(timeout, None, handler)?;
    // 递归监听整棵共享树;忽略规则/临时件/嵌套根的剔除都由扫描管线负责。
    debouncer.watch(&state.root, RecursiveMode::Recursive)?;
    state.stam = folder_stam(&state.root);
    state.watcher = Some(debouncer);
    Ok(())
}

/// 按最新配置对齐目录集合:留下的复用现有 watcher,新增的立即建,消失的拆。
fn reconcile(
    states: &mut HashMap<String, FolderState>,
    specs: Vec<WatchFolderSpec>,
    window: Duration,
    raw_tx: &tokio::sync::mpsc::UnboundedSender<RawBatch>,
) {
    // 配置里已移除/不再符合条件的目录稍后统一关闭;先记下要保留的 id 集合
    let keep: std::collections::HashSet<String> =
        specs.iter().map(|s| s.id.clone()).collect();
    for spec in specs {
        // 同 id 同根:现有 watcher 继续用(含打开中的聚合窗口,一并保留)
        if states
            .get(&spec.id)
            .map(|state| state.root == spec.root)
            .unwrap_or(false)
        {
            continue;
        }
        // 新目录,或根路径变了(等于换了一个目录):丢旧建新
        states.remove(&spec.id);
        let mut state = FolderState::new(spec);
        match try_watch(&mut state, window, raw_tx) {
            Ok(()) => tracing::info!(folder = %state.id, root = %state.root.display(), "watcher 已启动"),
            Err(error) => {
                state.degraded = true;
                state.degrade_warned = true;
                tracing::warn!(folder = %state.id, %error, "watcher 创建失败,该目录退回定时扫描");
            }
        }
        states.insert(state.id.clone(), state);
    }
    let removed: Vec<String> = states
        .keys()
        .filter(|id| !keep.contains(*id))
        .cloned()
        .collect();
    for id in removed {
        states.remove(&id);
        tracing::debug!(%id, "watcher 已关闭(目录移除、暂停或资格失效)");
    }
}

/// 失效巡检:目录消失只关不建,恢复时关闭重建并立即补扫。
fn sweep(
    states: &mut HashMap<String, FolderState>,
    window: Duration,
    raw_tx: &tokio::sync::mpsc::UnboundedSender<RawBatch>,
    rescan_tx: &tokio::sync::mpsc::UnboundedSender<RescanRequest>,
) {
    for state in states.values_mut() {
        // 先取「有没有 watcher」的快照,再在分支体内改状态 —— 直接拿
        // `&state.watcher` 当判据会让不可变借用贯穿整个 match,分支体没法赋值。
        let watched = state.watcher.is_some();
        let current = folder_stam(&state.root);
        match (watched, current) {
            // 活着且身份未变:健康,无事可做
            (true, Some(stam)) if state.stam == Some(stam) => {}
            // 身份变了(目录被删后原位重建):旧监听按 inode 已经死了,关闭重建
            (true, Some(_)) => {
                tracing::info!(folder = %state.id, "共享目录身份已变,重建 watcher 并立即触发一轮扫描");
                state.watcher = None;
                state.stam = None;
                if let Err(error) = try_watch(state, window, raw_tx) {
                    state.degraded = true;
                    tracing::warn!(folder = %state.id, %error, "watcher 重建失败,该目录退回定时扫描");
                }
                let _ = rescan_tx.send(RescanRequest {
                    folder: state.id.clone(),
                    events: 0,
                    reason: RescanReason::Rebuild,
                });
            }
            // 目录消失:只关不建,期间不崩;恢复交给下一轮巡检
            (true, None) => {
                tracing::debug!(folder = %state.id, "共享目录消失,关闭 watcher 等待重建");
                state.watcher = None;
                state.stam = None;
            }
            // 曾失效、目录回来了:重建 + 立即补扫
            (false, Some(_)) => {
                match try_watch(state, window, raw_tx) {
                    Ok(()) => {
                        tracing::info!(folder = %state.id, "共享目录恢复,watcher 重建,立即触发一轮扫描");
                        state.degraded = false;
                        state.degrade_warned = false;
                    }
                    Err(error) => {
                        if !state.degrade_warned {
                            tracing::warn!(folder = %state.id, %error, "watcher 创建失败,该目录退回定时扫描");
                            state.degrade_warned = true;
                        }
                        state.degraded = true;
                    }
                }
                // 只有真重建成功才补扫;失败的目录由兜底定时器覆盖
                if state.watcher.is_some() {
                    let _ = rescan_tx.send(RescanRequest {
                        folder: state.id.clone(),
                        events: 0,
                        reason: RescanReason::Rebuild,
                    });
                }
            }
            // 仍不存在:等
            (false, None) => {}
        }
    }
}

/// 聚合层:把窗口内到达的批次累加进各自目录的窗口。
fn accumulate(states: &mut HashMap<String, FolderState>, batch: RawBatch, window: Duration) {
    if batch.error || batch.events == 0 {
        return;
    }
    let Some(state) = states.get_mut(&batch.folder) else {
        return; // 已被移除的目录:丢弃残余事件
    };
    match &mut state.window {
        None => {
            // 第一个事件开窗;后续事件只累加,不推迟截止(滑动窗口会在持续写入下永不闭合)
            state.window = Some(WindowState {
                events: batch.events,
                closes_at: Instant::now() + window,
            });
        }
        Some(open) => open.events = open.events.saturating_add(batch.events),
    }
}

/// 关掉到期的窗口,每个目录塌缩成一条重扫请求。
fn close_windows(
    states: &mut HashMap<String, FolderState>,
    now: Instant,
    rescan_tx: &tokio::sync::mpsc::UnboundedSender<RescanRequest>,
) {
    for state in states.values_mut() {
        let due = state
            .window
            .as_ref()
            .is_some_and(|open| open.closes_at <= now);
        if !due {
            continue;
        }
        let open = state.window.take().expect("due 已确认窗口存在");
        // 阈值内 info(值得关注的正常量级),风暴降 debug 防刷屏
        if open.events <= AGGREGATE_LOG_INFO_THRESHOLD {
            tracing::info!(folder = %state.id, events = open.events, "folder {}: {} events -> 1 rescan", state.id, open.events);
        } else {
            tracing::debug!(folder = %state.id, events = open.events, "folder {}: {} events -> 1 rescan", state.id, open.events);
        }
        let _ = rescan_tx.send(RescanRequest {
            folder: state.id.clone(),
            events: open.events,
            reason: RescanReason::Watch,
        });
    }
}

fn publish_health(health: &WatchHealth, states: &HashMap<String, FolderState>) {
    let ok = states.values().all(|state| state.watcher.is_some());
    health.healthy.store(ok, Ordering::Relaxed);
}

/// 监听中枢。克隆即共享同一个后台任务(`sync` 只是投递对齐命令)。
#[derive(Clone)]
pub struct FsWatchHub {
    cmd_tx: tokio::sync::mpsc::UnboundedSender<HubCmd>,
    health: Arc<WatchHealth>,
}

impl FsWatchHub {
    /// 起后台任务。必须在 tokio 运行时内调用;`rescan_tx` 的接收端由装配层接到
    /// actor 的 `Cmd::ScanFolder`。
    pub fn spawn(
        window: Duration,
        sweep_interval: Duration,
        rescan_tx: tokio::sync::mpsc::UnboundedSender<RescanRequest>,
    ) -> Self {
        let health = Arc::new(WatchHealth::default());
        let (cmd_tx, cmd_rx) = tokio::sync::mpsc::unbounded_channel();
        let (raw_tx, mut raw_rx) = tokio::sync::mpsc::unbounded_channel::<RawBatch>();
        // hub 自己留一份 raw_tx:全部 watcher 被移除时通道不至于提前关闭
        let keep_alive = raw_tx.clone();
        let task_health = Arc::clone(&health);
        tokio::spawn(async move {
            let _keep_alive = keep_alive;
            let mut states: HashMap<String, FolderState> = HashMap::new();
            let mut next_sweep = Instant::now() + sweep_interval;
            let mut cmd_rx = cmd_rx;
            loop {
                // 最近的截止时刻:最早关闭的窗口,或下一轮巡检
                let mut deadline = next_sweep;
                for state in states.values() {
                    if let Some(open) = &state.window {
                        deadline = deadline.min(open.closes_at);
                    }
                }
                let sleep_until = tokio::time::Instant::from_std(deadline);
                tokio::select! {
                    cmd = cmd_rx.recv() => {
                        let Some(HubCmd::Sync(specs)) = cmd else {
                            // hub 已被丢弃:退出
                            break;
                        };
                        reconcile(&mut states, specs, window, &raw_tx);
                        publish_health(&task_health, &states);
                    }
                    batch = raw_rx.recv() => {
                        match batch {
                            Some(batch) => accumulate(&mut states, batch, window),
                            None => {
                                // 所有 watcher 的发送端都关了(理论上 hub 自留克隆防住)
                                break;
                            }
                        }
                    }
                    _ = tokio::time::sleep_until(sleep_until) => {
                        let now = Instant::now();
                        if now >= next_sweep {
                            sweep(&mut states, window, &raw_tx, &rescan_tx);
                            next_sweep = now + sweep_interval;
                        }
                        close_windows(&mut states, now, &rescan_tx);
                        publish_health(&task_health, &states);
                    }
                }
            }
            tracing::debug!("文件系统监听任务退出");
        });
        Self { cmd_tx, health }
    }

    /// 对齐待监听目录集合(配置热重载时调用;关掉开关就传空表)。
    pub fn sync(&self, specs: Vec<WatchFolderSpec>) {
        let _ = self.cmd_tx.send(HubCmd::Sync(specs));
    }

    /// 健康度句柄。
    pub fn health(&self) -> Arc<WatchHealth> {
        Arc::clone(&self.health)
    }
}
