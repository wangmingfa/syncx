//! 文件系统监听驱动的扫描触发。
//!
//! 架构契约(与 Node 后端约定一致,判定引擎零改动):
//!
//!  - **事件只当触发器**。拿到「该目录需要重扫」这个事实后,判定仍然走现有扫描管线
//!    ([`crate::actor::Folder::scan`] → [`crate::scanner::scan_folder`]):对比索引、
//!    diff、墓碑全部复用。watcher 不产生任何索引/墓碑数据。
//!  - **忽略范围的事件在聚合之前就丢弃**(2026-10 实测事故的根治,对齐 Node
//!    7419b03):生产 daemon 曾因 WebStorm 后台 git 集成每 ~2s 刷新 `.git/index`,
//!    macOS 递归监听把 `.git` 子树事件也报上来,而旧设计「回调不看参数、不过滤」
//!    让每次刷新都触发重扫 —— daemon 以 ~95% CPU 连续全量重扫数万轮。`.git` 对
//!    **同步语义**是硬忽略,监听层没有理由再看见它。过滤谓词由装配层注入(与扫描
//!    同源同判据:硬忽略闸门 + gitignore 语义一套真相),语义红线:过滤仅限忽略
//!    范围 —— 自己写入同步文件产生的事件照常触发;daemon 自己写 `.git` 的场景
//!    (git 镜像提交)同样被滤,**这正是目的**。无路径/归一失败的事件保留原
//!    「一比特」触发语义(宁可多扫不可漏扫)。
//!  - **聚合防抖**。窗口内同目录 N 个事件塌缩成一次「该目录重扫」;窗口由**第一个**
//!    事件开启、到点即关(不用滑动窗口——持续写入会让滑动窗口永远不开,等于失明)。
//!    自己写入产生的事件(忽略范围除外,见上)照常触发:聚合后重扫,扫描管线幂等。
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

/// 事件过滤谓词:入参是「相对监听根的 POSIX 路径」(hub 已归一化,见
/// [`normalize_watch_rel`]),返回 true = 丢弃该事件(不打脏位、不触发重扫)。
///
/// 由装配层用该目录的硬忽略 + 忽略规则生成,与扫描同源同判据(见 syncx-cli 的
/// `watch_specs`);对账(`FsWatchHub::sync`)每次换入最新谓词,规则热重载即时生效。
/// `None` = 不过滤,行为与无谓词时代完全一致(向后兼容)。
pub type EventFilter = Arc<dyn Fn(&str) -> bool + Send + Sync>;

/// 把底层事件路径归一化成「相对监听根的 POSIX 路径」;归一不出来返回 `None`
/// (调用方按无路径语义处理:保留触发,不过滤 —— 宁可多扫不可漏扫)。
///
/// 对齐 Node 7419b03 的 `normalizeWatchFilename`。防御背景:事件路径形态跨平台
/// 不一 —— macOS/Linux 递归监听给根相对或绝对 POSIX 路径,Windows 可能给反斜杠
/// 分隔甚至盘符绝对路径;直接拿原始串做规则匹配会漏判(漏判 = 事件照旧触发,
/// 退化回扫描风暴),所以先归一化再判:
///  - 反斜杠一律替换为 `/`;
///  - 非 UTF-8 路径(对应 Node 的 Buffer 形态)→ `None`;
///  - 绝对路径(POSIX `/` 开头或 Windows 盘符)尝试用监听根剥前缀,剥不上 → `None`;
///  - `./` 前缀剥掉;含 `..` 段的路径不可信 → `None`;空串 → `None`。
pub fn normalize_watch_rel(path: &Path, watch_root: Option<&Path>) -> Option<String> {
    let raw = path.to_str()?;
    let mut s = raw.replace('\\', "/");
    if s.is_empty() {
        return None;
    }
    let root: Option<String> = watch_root
        .and_then(|r| r.to_str())
        .map(|r| r.replace('\\', "/").trim_end_matches('/').to_string());
    let is_absolute = s.starts_with('/') || windows_drive_prefix(&s);
    if is_absolute {
        let root = root?;
        let prefix = format!("{root}/");
        s = s.strip_prefix(prefix.as_str())?.to_string();
    }
    while let Some(rest) = s.strip_prefix("./") {
        s = rest.to_string();
    }
    if s.is_empty() {
        return None;
    }
    if s.split('/').any(|segment| segment == "..") {
        return None;
    }
    Some(s)
}

/// Windows 盘符绝对路径前缀(`C:/...`;盘符大小写不限)。
fn windows_drive_prefix(s: &str) -> bool {
    let bytes = s.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && bytes[2] == b'/'
}

/// 一个待监听的共享目录。资格(未暂停、身份校验通过)由装配层判定 —— 判据依赖
/// config 与身份指纹,不该沉到 daemon 里重复一份。
#[derive(Clone)]
pub struct WatchFolderSpec {
    pub id: String,
    pub root: PathBuf,
    /// 事件过滤谓词(可选):见 [`EventFilter`]。每次对账都会换入最新值 ——
    /// 规则修改即刻生效,无事件空窗、无重建风暴。
    pub filter: Option<EventFilter>,
}

impl std::fmt::Debug for WatchFolderSpec {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WatchFolderSpec")
            .field("id", &self.id)
            .field("root", &self.root)
            .field("filter", &self.filter.is_some())
            .finish()
    }
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

/// 事件处理器投进聚合层的原始批次。`events` 为空表示这是一条错误批次(不计入聚合)。
/// 过滤不在事件回调里做:谓词表随对账热替换,归一化与判定统一放在聚合层入口
/// (对齐 Node 把过滤挂在 `onFsEvent`,而非 watcher 回调内联)。
struct RawBatch {
    folder: String,
    /// 每条底层事件携带的路径(`notify::Event::paths`;内层空 = 无路径事件)。
    events: Vec<Vec<PathBuf>>,
    error: bool,
}

enum HubCmd {
    Sync(Vec<WatchFolderSpec>),
}

/// 一个目录的监听状态。
struct FolderState {
    id: String,
    root: PathBuf,
    /// 当前生效的事件过滤谓词。事件按 id 现查此值(`accumulate` 时),对账换入
    /// 最新闭包即热替换 —— 与 Node 的 filters 表同义。error 重建沿用本字段,
    /// 谓词不因重建空窗而丢失。
    filter: Option<EventFilter>,
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
    /// 本窗口被谓词丢弃的忽略事件数(聚合进日志,绝不逐事件打日志)。
    dropped: usize,
    closes_at: Instant,
}

impl FolderState {
    fn new(spec: WatchFolderSpec) -> Self {
        Self {
            id: spec.id,
            root: spec.root,
            filter: spec.filter,
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
            // 闭包必须是 FnMut(debouncer 会反复调用它),捕获的 folder 只能克隆后投递。
            // 这里只搬运路径,不做过滤 —— 谓词随对账热替换,判定在聚合层入口(见 accumulate)。
            let events: Vec<Vec<PathBuf>> =
                events.iter().map(|event| event.paths.clone()).collect();
            let _ = tx.send(RawBatch { folder: folder.clone(), events, error: false });
        }
        Err(errors) => {
            for error in errors {
                tracing::debug!(folder = %folder, %error, "watcher 底层报错(多为目录删除的已知形态)");
            }
            let _ = tx.send(RawBatch { folder: folder.clone(), events: Vec::new(), error: true });
        }
    };
    let mut debouncer = new_debouncer(timeout, None, handler)?;
    // 递归监听整棵共享树(不做子树裁剪);忽略范围的事件由聚合层按谓词滤掉,
    // 临时件/嵌套根的剔除仍由扫描管线负责。
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
        // 同 id 同根:现有 watcher 继续用(含打开中的聚合窗口,一并保留);
        // 但谓词要换成最新 —— 装配层每轮对账都用最新规则重建闭包,这里换入即热替换,
        // 规则热重载即时生效,**不需要重建 watcher**(重建徒留事件空窗 + 多余补扫,
        // 对齐 Node syncFolders 对 filters 表的换入语义)。
        if let Some(state) = states.get_mut(&spec.id) {
            if state.root == spec.root {
                state.filter = spec.filter.clone();
                continue;
            }
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
        // Some(原因) = 需要(重)建监听并立即补扫。目录消失与「身份已变(原位重建)」
        // 都把旧监听关掉 —— 按 inode 的监听已死,统一走同一条重建路径。
        let rebuild: Option<&'static str> = match (watched, current) {
            // 活着且身份未变:健康,无事可做
            (true, Some(stam)) if state.stam == Some(stam) => None,
            // 身份变了(目录被删后原位重建)
            (true, Some(_)) => {
                state.watcher = None;
                state.stam = None;
                Some("身份已变,重建")
            }
            // 目录消失:只关不建,期间不崩;恢复交给下一轮巡检
            (true, None) => {
                tracing::debug!(folder = %state.id, "共享目录消失,关闭 watcher 等待重建");
                state.watcher = None;
                state.stam = None;
                None
            }
            // 曾失效、目录回来了
            (false, Some(_)) => Some("恢复,"),
            // 仍不存在:等
            (false, None) => None,
        };
        let Some(why) = rebuild else { continue };
        match try_watch(state, window, raw_tx) {
            Ok(()) => {
                tracing::info!(folder = %state.id, "共享目录{why}watcher 重建,立即触发一轮扫描");
                state.degraded = false;
                state.degrade_warned = false;
            }
            Err(error) => {
                // 降级 warn 只发一次,直到成功为止(不刷屏)
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
}

/// 聚合层:把窗口内到达的批次累加进各自目录的窗口。
///
/// **过滤挂点在聚合之前**(对齐 Node 7419b03):路径能归一化且命中该目录谓词 →
/// 丢弃,不打脏位;归一失败/无谓词/未命中 → 保留原「一比特」触发语义。
fn accumulate(states: &mut HashMap<String, FolderState>, batch: RawBatch, window: Duration) {
    if batch.error || batch.events.is_empty() {
        return;
    }
    let Some(state) = states.get_mut(&batch.folder) else {
        return; // 已被移除的目录:丢弃残余事件
    };
    let (kept, dropped) = filter_batch(&state.root, state.filter.as_ref(), &batch.events);
    apply_to_window(&mut state.window, kept, dropped, window);
}

/// 逐条过滤一个批次的路径,返回 (保留的事件数, 丢弃的路径数)。
///
/// 计数口径:保留数按「底层事件」计 —— 一条事件只要还有任一路径存活(或本就
/// 无路径)就保留,与过滤前的 `events.len()` 同口径;丢弃数按「路径」计,每条
/// 被滤掉的路径对应一次文件系统变更,与 Node 的逐 filename 计数同义。
///
/// 判定细则(与 Node `onFsEvent` 逐条对齐):
///  - 无路径事件(底层 rename 形态等)→ 保留触发;
///  - 归一失败([`normalize_watch_rel`] 返回 `None`)→ 当无路径处理,保留触发;
///  - 归一成功且谓词存在且命中 → 丢弃;
///  - 无谓词 → 全部保留(向后兼容:与无谓词时代的「直接 markDirty」完全一致)。
fn filter_batch(
    root: &Path,
    filter: Option<&EventFilter>,
    events: &[Vec<PathBuf>],
) -> (usize, usize) {
    let mut kept = 0usize;
    let mut dropped = 0usize;
    // 真实根的惰性缓存:仅在「按传入根剥前缀失败」的路径出现时才算一次
    let mut canonical_root: Option<PathBuf> = None;
    for paths in events {
        if paths.is_empty() {
            kept += 1;
            continue;
        }
        let mut any_kept = false;
        for path in paths {
            match event_rel_path(path, root, &mut canonical_root) {
                None => any_kept = true,
                Some(rel) if filter.is_some_and(|f| f(&rel)) => dropped += 1,
                Some(_) => any_kept = true,
            }
        }
        if any_kept {
            kept += 1;
        }
    }
    (kept, dropped)
}

/// 事件路径 → 相对监听根的 POSIX 路径([`normalize_watch_rel`] 的平台适配层)。
///
/// 先按传入的根剥前缀;失败且路径是绝对路径时,再用 `canonicalize` 后的真实根剥
/// 一次 —— macOS FSEvents 会把路径规约成真实路径(`/var/...` 经符号链接实际在
/// `/private/var/...`),监听根经由符号链接传入时(临时目录、挂载点都是常态)按
/// 原样剥必然失败。两次都剥不上 → `None`,调用方按无路径放行。
fn event_rel_path(path: &Path, root: &Path, canonical_root: &mut Option<PathBuf>) -> Option<String> {
    if let Some(rel) = normalize_watch_rel(path, Some(root)) {
        return Some(rel);
    }
    if path.is_absolute() {
        if canonical_root.is_none() {
            *canonical_root = std::fs::canonicalize(root).ok();
        }
        if let Some(real) = canonical_root.as_deref() {
            if let Some(rel) = normalize_watch_rel(path, Some(real)) {
                return Some(rel);
            }
        }
    }
    None
}

/// 把一条批次的 (保留, 丢弃) 计数累进打开中的窗口;没有窗口则新开一个。
///
/// 纯丢弃(kept = 0)也要开窗:窗口结算时给一条聚合 debug(风暴被压制的观测
/// 证据),否则事件全被丢弃时连窗口都没有,丢弃计数永远无处汇报 —— 对齐 Node
/// 把 `ensureWindow` 从 `markDirty` 拆出来的动机。
fn apply_to_window(
    window: &mut Option<WindowState>,
    kept: usize,
    dropped: usize,
    window_dur: Duration,
) {
    if kept == 0 && dropped == 0 {
        return;
    }
    match window {
        Some(open) => {
            open.events = open.events.saturating_add(kept);
            open.dropped = open.dropped.saturating_add(dropped);
        }
        None => {
            // 第一个事件开窗;后续事件只累加,不推迟截止(滑动窗口会在持续写入下永不闭合)
            *window = Some(WindowState {
                events: kept,
                dropped,
                closes_at: Instant::now() + window_dur,
            });
        }
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
        if open.events > 0 {
            // 阈值内 info(值得关注的正常量级),风暴降 debug 防刷屏;
            // dropped 计数附加在聚合行上(不逐事件打日志)
            let dropped_note = if open.dropped > 0 {
                format!(", dropped {} ignored", open.dropped)
            } else {
                String::new()
            };
            if open.events <= AGGREGATE_LOG_INFO_THRESHOLD {
                tracing::info!(folder = %state.id, events = open.events, dropped = open.dropped, "folder {}: {} events -> 1 rescan{}", state.id, open.events, dropped_note);
            } else {
                tracing::debug!(folder = %state.id, events = open.events, dropped = open.dropped, "folder {}: {} events -> 1 rescan{}", state.id, open.events, dropped_note);
            }
            let _ = rescan_tx.send(RescanRequest {
                folder: state.id.clone(),
                events: open.events,
                reason: RescanReason::Watch,
            });
        } else if open.dropped > 0 {
            // 本窗口全是被忽略的事件:没有可重扫的目录,但丢弃计数要给一条聚合 debug
            // (排查「风暴是否还在」的依据:这行持续滚动 = 事件源仍在刷,只是不再触发扫描)
            tracing::debug!(folder = %state.id, dropped = open.dropped, "folder {}: dropped {} ignored fs event(s) in window, nothing to rescan", state.id, open.dropped);
        }
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

/* ============================ 单元测试:归一化与过滤 ============================ */

// 行为级测试(真实文件事件)在 `tests/watcher.rs`;这里盖住纯函数分支:归一化的
// 防御形态、过滤计数口径、纯丢弃窗口的「只记日志不重扫」。

#[cfg(test)]
mod tests {
    use super::*;
    use syncx_core::ignore::IgnoreRuleset;

    /// 与装配层(syncx-cli watch_specs)同一套构造:硬忽略闸门 + 规则集,isDir 恒 false。
    fn predicate(lines: &[&str]) -> EventFilter {
        let rules = IgnoreRuleset::from_lines(
            &lines.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
        );
        Arc::new(move |rel: &str| {
            syncx_core::ignore::is_hard_ignored(rel) || rules.is_ignored(rel, false)
        })
    }

    fn batch(events: &[&[&str]]) -> Vec<Vec<PathBuf>> {
        events
            .iter()
            .map(|paths| paths.iter().map(PathBuf::from).collect())
            .collect()
    }

    fn normalize(path: &str, root: &str) -> Option<String> {
        normalize_watch_rel(Path::new(path), Some(Path::new(root)))
    }

    #[test]
    fn normalize_strips_root_prefix_and_dots() {
        assert_eq!(normalize("src/a.txt", "/tmp/x"), Some("src/a.txt".into()));
        assert_eq!(normalize("./src/a.txt", "/tmp/x"), Some("src/a.txt".into()));
        // 与 Node 逐字同语义:`./` 前缀只剥到不再以 `./` 开头为止(`.//./b` 剥一次得
        // `/./b`),怪形态原样交给谓词 —— 不命中即放行,保守正确
        assert_eq!(normalize(".//./b", "/tmp/x"), Some("/./b".into()));
        assert_eq!(normalize("/tmp/x/src/a.txt", "/tmp/x"), Some("src/a.txt".into()));
        // 反斜杠统一成 '/'
        assert_eq!(normalize("src\\a.txt", "/tmp/x"), Some("src/a.txt".into()));
        assert_eq!(normalize("/tmp/x\\src/a.txt", "/tmp/x"), Some("src/a.txt".into()));
        // 根尾斜杠不影响剥前缀
        assert_eq!(normalize("/tmp/x/a", "/tmp/x/"), Some("a".into()));
    }

    #[test]
    fn normalize_returns_none_for_untrustworthy_forms() {
        // 归一失败 → 调用方按无路径放行(宁可多扫不可漏扫)
        assert_eq!(normalize("", "/tmp/x"), None);
        assert_eq!(normalize("./", "/tmp/x"), None);
        // 单个 `.`:Node 语义原样返回(谓词不命中 → 放行),不算归一失败
        assert_eq!(normalize(".", "/tmp/x"), Some(".".into()));
        assert_eq!(normalize("../a", "/tmp/x"), None);
        assert_eq!(normalize("src/../x", "/tmp/x"), None);
        assert_eq!(normalize("/etc/passwd", "/tmp/x"), None);
        assert_eq!(normalize("C:/Windows/x", "/tmp/x"), None);
        // 事件就是监听根自身:剥不上前缀 → 放行
        assert_eq!(normalize("/tmp/x", "/tmp/x"), None);
        // 绝对路径 + 无监听根可剥 → 归一失败,放行(Node:root undefined → null)
        assert_eq!(normalize_watch_rel(Path::new("/tmp/x/a"), None), None);
        // 非 UTF-8 路径(对应 Node 的 Buffer 形态)→ 放行
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStrExt;
            let weird = Path::new(std::ffi::OsStr::from_bytes(b"/tmp/x/bad\xff"));
            assert_eq!(normalize_watch_rel(weird, Some(Path::new("/tmp/x"))), None);
        }
    }

    #[test]
    fn filter_batch_drops_hard_ignored_and_rule_hits() {
        let root = Path::new("/tmp/x");
        // 硬忽略不靠规则行:.git 子树一律丢弃
        let pred = predicate(&[]);
        let (kept, dropped) = filter_batch(
            root,
            Some(&pred),
            &batch(&[&[".git/index"], &["src/a.txt"], &[".git"], &["SRC/.git/config"]]),
        );
        assert_eq!((kept, dropped), (1, 3), "src/a.txt 触发,其余被硬忽略滤掉");

        // 目录规则按文件语义最保守:node_modules/x 丢弃(前缀回溯),孤立 node_modules 放行
        let pred = predicate(&["node_modules/"]);
        let (kept, dropped) = filter_batch(
            root,
            Some(&pred),
            &batch(&[&["node_modules/x"], &["node_modules"], &["a.txt"]]),
        );
        assert_eq!((kept, dropped), (2, 1), "node_modules 孤立事件放行,子树事件丢弃");

        // 负向规则放回:!logs/ 之后 logs/a.txt 不再丢弃
        let pred = predicate(&["logs/", "!logs/"]);
        let (kept, _) = filter_batch(root, Some(&pred), &batch(&[&["logs/a.txt"]]));
        assert_eq!(kept, 1);

        // 无谓词 = 全部保留(向后兼容)
        let (kept, dropped) = filter_batch(
            root,
            None,
            &batch(&[&[".git/index"], &["node_modules/x"], &[]]),
        );
        assert_eq!((kept, dropped), (3, 0));

        // 归一失败的事件当无路径放行,绝不因为「认不出」而丢触发
        // (此处谓词是 logs 规则集,不命中 node_modules/x —— 三条全保留)
        let (kept, dropped) = filter_batch(
            root,
            Some(&pred),
            &batch(&[&["../escape"], &["/etc/passwd"], &["node_modules/x"]]),
        );
        assert_eq!((kept, dropped), (3, 0));

        // 无路径事件保留「一比特」语义
        let (kept, dropped) = filter_batch(root, Some(&pred), &batch(&[&[]]));
        assert_eq!((kept, dropped), (1, 0));
    }

    #[test]
    fn pure_drop_window_opens_but_never_rescans() {
        let mut states: HashMap<String, FolderState> = HashMap::new();
        states.insert(
            "f1".to_string(),
            FolderState::new(WatchFolderSpec {
                id: "f1".to_string(),
                root: PathBuf::from("/tmp/x"),
                filter: Some(predicate(&[])),
            }),
        );
        // 一批全被忽略的事件:窗口照开(events=0),但不产生重扫请求
        accumulate(
            &mut states,
            RawBatch {
                folder: "f1".to_string(),
                events: batch(&[&[".git/index"], &[".git/HEAD"]]),
                error: false,
            },
            Duration::from_millis(50),
        );
        let state = states.get("f1").unwrap();
        let open = state.window.as_ref().expect("纯丢弃也要开窗(观测点)");
        assert_eq!(open.events, 0);
        assert_eq!(open.dropped, 2);

        // 窗口到期:只发丢弃聚合的日志语境,不发重扫请求
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        close_windows(&mut states, Instant::now() + Duration::from_secs(1), &tx);
        assert!(
            states.get("f1").unwrap().window.is_none(),
            "窗口已结算"
        );
        assert!(
            rx.try_recv().is_err(),
            "纯丢弃窗口绝不能触发重扫"
        );

        // 混合窗口:保留 + 丢弃都计数
        accumulate(
            &mut states,
            RawBatch {
                folder: "f1".to_string(),
                events: batch(&[&[".git/index"], &["src/a.txt"]]),
                error: false,
            },
            Duration::from_millis(50),
        );
        let open = states["f1"].window.as_ref().unwrap();
        assert_eq!(open.events, 1);
        assert_eq!(open.dropped, 1);
        close_windows(&mut states, Instant::now() + Duration::from_secs(1), &tx);
        let request = rx.try_recv().expect("保留事件应触发重扫");
        assert_eq!(request.events, 1, "重扫计数只含保留事件");
        assert!(matches!(request.reason, RescanReason::Watch));
    }

    #[test]
    fn reconcile_swaps_predicate_without_touching_window() {
        let mut states: HashMap<String, FolderState> = HashMap::new();
        states.insert(
            "f1".to_string(),
            FolderState::new(WatchFolderSpec {
                id: "f1".to_string(),
                root: PathBuf::from("/tmp/x"),
                filter: Some(predicate(&[])),
            }),
        );
        states.get_mut("f1").unwrap().window = Some(WindowState {
            events: 3,
            dropped: 1,
            closes_at: Instant::now() + Duration::from_secs(60),
        });

        // 对账换入新谓词(规则热重载):watcher 与打开中的窗口都不动
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        reconcile(
            &mut states,
            vec![WatchFolderSpec {
                id: "f1".to_string(),
                root: PathBuf::from("/tmp/x"),
                filter: Some(predicate(&["node_modules/"])),
            }],
            Duration::from_millis(50),
            &tx,
        );
        let state = states.get("f1").unwrap();
        assert!(state.window.is_some(), "打开中的窗口在对账时保留");
        let pred = state.filter.as_ref().expect("谓词仍存在");
        assert!(pred(".git/index"), "硬忽略仍生效");
        assert!(!pred("src/a.txt"), "同步文件放行");
        assert!(pred("node_modules/x"), "新规则已生效");

        // 根变了 = 换目录:旧状态连同谓词一起丢弃重建
        reconcile(
            &mut states,
            vec![WatchFolderSpec {
                id: "f1".to_string(),
                root: PathBuf::from("/tmp/y"),
                filter: None,
            }],
            Duration::from_millis(50),
            &tx,
        );
        let state = states.get("f1").unwrap();
        assert_eq!(state.root, PathBuf::from("/tmp/y"));
        assert!(state.filter.is_none(), "新目录从装配层拿谓词,不带旧值");
        assert!(state.window.is_none(), "换目录不留旧窗口");
    }
}
