//! daemon 装配层:把 `syncx-api` 的路由、`syncx-daemon` 的 actor、`syncx-net` 的连接
//! 与 mDNS 拼成 Node 侧 `src/cli.ts` 的那条启动序列。
//!
//! 这一层是**唯一**知道「进程里同时存在哪些部件」的地方,因此也是唯一允许持有
//! 跨部件引用(actor 句柄、状态中枢、发现服务)的地方。判定逻辑一概不在这里:
//! 目录时段、状态载荷、控制面消息处理都调各自模块的公开函数,本文件只负责顺序、
//! 定时与开关。
//!
//! 三个顺序约束,写错就表现为难以定位的线上问题:
//!
//!  1. **先绑控制端口,再写 pid 文件**。pid 文件是「本机有后端在跑」的唯一凭据,
//!     先写后绑会让绑定失败留下一个指向死进程的 pid,下一次启动报 EADDRINUSE 而不是
//!     给出真实原因。
//!  2. **先起 peer server,再建 `RuntimeOps`**。`peer_port` 在 ops 里是只读字段,
//!     数据面端口又是内核分配的(`--port 0`),不先绑就没有值可填。
//!  3. **状态载荷的取值闭包晚绑定**。`StatusHub` 需要「算状态」的闭包,算状态又需要
//!     整个 `RuntimeOps`(而 ops 里要放 hub)。用 `OnceLock` 做一次晚绑定:闭包先拿到
//!     空槽,ops 建好后回填。hub 的定时器在第一个 tick 之前就开始跑,但脏位是空的,
//!     不会在空槽期真的序列化一份状态。

use std::collections::{BTreeMap, HashMap, HashSet};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::oneshot;

use syncx_api::calendar;
use syncx_api::mutate;
use syncx_api::config::{
    folder_index_path, folder_trash_path, folder_versions_path, Config, ConfigStore, SharedFolder,
};
use syncx_api::status::{
    build_status, CalendarStatus, DeviceStatus, DiscoveredDevice, FolderError, GlobalSettings,
    ScheduleBanner, ScheduleState, StatusExtras,
};
use syncx_api::ws::{StatusHub, Timings};
use syncx_core::ignore::IgnoreRuleset;
use syncx_core::schedule::{
    format_schedule_summary, next_schedule_change, within_schedule, CivilMoment,
};
use syncx_daemon::actor::{spawn_actor, ActorHandle, Cmd, FolderSpec, SessionActor};
use syncx_daemon::driver::{self, ControlHooks};
use syncx_daemon::peer::ConflictPolicy;
use syncx_daemon::watcher::{
    FsWatchHub, RescanRequest, WatchFolderSpec, WatchHealth, FS_WATCH_SWEEP, FS_WATCH_WINDOW,
};
use syncx_net::wire::ControlMessage;
use syncx_net::{connect_peer, start_discovery, start_peer_server, DeviceIdentity, Discovery};

use super::{compare, git_sync, offers, selfheal, RuntimeOps};
use crate::args;
use crate::terminal::TerminalHub;
use crate::update;

/// 数据面默认端口(与 Node `args.port ?? 22000` 同值)。
pub const DEFAULT_PEER_PORT: u16 = 22000;

/// 扫描间隔的默认值(可用 `SYNCX_SCAN_INTERVAL_MS` 覆盖)。
pub const DEFAULT_SCAN_INTERVAL_MS: u64 = 5_000;

/// mDNS 发现记录的保鲜期:超过这个时间没再听到广播就当它离线。
/// 与 Node `DISCOVERY_TTL_MS = 3 * 60_000` 同值。
pub const DISCOVERY_TTL_MS: i64 = 3 * 60_000;

/// 事件排空与超时巡检的节拍。比扫描快一个量级:块重试、收齐判定都挂在这条链上,
/// 拖到 5 秒会让一次块丢失的恢复看起来像「卡住了」。
const DRAIN_INTERVAL: Duration = Duration::from_millis(500);

/// 配置热重载的轮询间隔。配置文件用 mtime + 长度比对(共享目录才用 notify 监听)。
const CONFIG_POLL_INTERVAL: Duration = Duration::from_secs(1);

/// 出站拨号的调度节拍。
const DIAL_TICK: Duration = Duration::from_secs(1);

/// git 徽标计数的刷新间隔(每目录跑两次 `git rev-list`,不能进状态路径)。
const GIT_COUNT_INTERVAL: Duration = Duration::from_secs(30);

/* ============================ 运行期扩展状态 ============================ */

/// 一个 mDNS 发现到的对端(带本地收到时刻)。
#[derive(Debug, Clone)]
pub struct DiscoveredEntry {
    pub host: String,
    pub port: u16,
    pub address: Option<String>,
    pub last_seen: i64,
}

/// 不属于 `RuntimeOps`、但状态载荷与控制面都要读的运行期状态。
///
/// 单独拎出来是因为它们的写者不同(发现回调 / 重连退避 / git 巡检),
/// 塞进 ops 会让「谁能改它」变得模糊。
#[derive(Default)]
pub struct Extras {
    /// `deviceId → 最近一次 mDNS 广播`。
    pub discovered: Mutex<HashMap<String, DiscoveredEntry>>,
    /// 本机是否在网(无可用非回环接口 = 离线)。
    pub network_online: AtomicBool,
    /// 每目录工作区未提交变更数(目录卡徽标)。
    pub git_change_counts: Mutex<BTreeMap<String, usize>>,
    /// 每目录未推送提交数。
    pub git_unpushed_counts: Mutex<BTreeMap<String, usize>>,
}

impl Extras {
    fn new() -> Self {
        Self {
            discovered: Mutex::new(HashMap::new()),
            network_online: AtomicBool::new(true),
            git_change_counts: Mutex::new(BTreeMap::new()),
            git_unpushed_counts: Mutex::new(BTreeMap::new()),
        }
    }

    fn online(&self) -> bool {
        self.network_online.load(Ordering::Relaxed)
    }
}

/// 装配好的运行体。
pub struct Runtime {
    pub ops: Arc<RuntimeOps>,
    pub hub: StatusHub,
    pub extras: Arc<Extras>,
    /// 文件系统监听中枢:事件只当触发器,判定走现有扫描管线(见 `syncx_daemon::watcher`)。
    pub watch: FsWatchHub,
}

/// 启动参数。字段与 Node 的 `ParsedArgs` 一一对应,缺省值在 [`RunOptions::new`] 里补。
#[derive(Debug, Clone)]
pub struct RunOptions {
    pub config_path: PathBuf,
    pub config_dir: PathBuf,
    pub identity: Arc<DeviceIdentity>,
    pub token: String,
    pub device_id: String,
    pub version: String,
    pub dev_mode: bool,
    pub log_file: Option<PathBuf>,
    pub control_host: String,
    pub control_port: u16,
    /// `--port`;`None` = 用 [`DEFAULT_PEER_PORT`]。
    pub peer_port: Option<u16>,
}

impl RunOptions {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        config_path: impl Into<PathBuf>,
        identity: Arc<DeviceIdentity>,
        token: impl Into<String>,
        version: impl Into<String>,
        dev_mode: bool,
    ) -> Self {
        let config_path = config_path.into();
        let config_dir = config_path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        let device_id = identity.device_id.clone();
        Self {
            config_path,
            config_dir,
            identity,
            token: token.into(),
            device_id,
            version: version.into(),
            dev_mode,
            log_file: None,
            control_host: "127.0.0.1".to_string(),
            control_port: crate::daemon::DEFAULT_CONTROL_PORT,
            peer_port: None,
        }
    }
}

/* ============================ 目录规格 ============================ */

/// 配置里的冲突策略字符串 → 引擎枚举。未知值一律退回 `keep-both`:
/// 「看不懂的策略」绝不能变成「无条件覆盖本地文件」。
fn conflict_policy(raw: Option<&str>) -> ConflictPolicy {
    match raw {
        Some("local-wins") => ConflictPolicy::LocalWins,
        Some("newest-wins") => ConflictPolicy::NewestWins,
        _ => ConflictPolicy::KeepBoth,
    }
}

/// 由配置算出 actor 需要的目录规格。
///
/// `baseline_pending` 只在索引库**文件不存在**时为真:首扫的存量文件不算「新增」,
/// 否则第一次启动会把整个目录当成新文件广播给对端。
pub fn folder_specs(ops: &RuntimeOps, config: &Config) -> Vec<FolderSpec> {
    config
        .shared_folders
        .iter()
        .map(|folder| {
            let index_path = folder_index_path(&ops.config_dir, folder);
            FolderSpec {
                id: folder.folder_id(),
                root: PathBuf::from(&folder.path),
                baseline_pending: !index_path.exists(),
                index_path,
                trash_dir: folder_trash_path(&ops.config_dir, folder),
                versions_dir: folder_versions_path(&ops.config_dir, folder),
                versions_per_path: Some(config.versions_per_path() as usize),
                rules: IgnoreRuleset::from_lines(&ops.ignore_lines(folder)),
                receive_only: folder.is_receive_only(),
                conflict_policy: conflict_policy(folder.conflict_policy.as_deref()),
                paused: folder.is_paused(),
                paused_files: folder.paused_files.clone().unwrap_or_default(),
            }
        })
        .collect()
}

/// 配置变了:重建目录列表并立刻扫一轮。
///
/// 「热重载是常态」——改一条忽略规则就会触发。`SessionActor::reload` 按 id 对齐、
/// 保留已有连接槽位,所以这里不必关心「哪些目录没变」。
pub fn reload_actor(ops: &RuntimeOps) {
    let config = ops.store.load();
    let specs = folder_specs(ops, &config);
    if !ops.actor.send(Cmd::Reload { specs }) {
        tracing::warn!("actor 已退出,配置热重载未生效");
        return;
    }
    ops.actor.send(Cmd::Scan);
    tracing::info!("配置已重载:{} 个共享目录", config.shared_folders.len());
}

/* ============================ 时段判定 ============================ */

/// 当前本地民用时刻。`CivilMoment` 不带时区,这里负责把系统时区解释进去。
fn now_moment() -> CivilMoment {
    use chrono::{Datelike, Local, Timelike};
    let now = Local::now();
    CivilMoment::at(now.year(), now.month(), now.day(), now.hour(), now.minute())
}

/// 民用时刻 → 本地时区的毫秒时间戳。
///
/// DST 切换那一小时里的时刻可能不存在,`earliest()` 取最近的可表示时刻 —— 边界
/// 唤醒早一点比晚一点安全(晚一小时意味着「该同步的时间段整段没同步」)。
fn moment_to_ms(moment: &CivilMoment) -> i64 {
    use chrono::{Local, TimeZone};
    Local
        .with_ymd_and_hms(
            moment.year,
            moment.month,
            moment.day,
            moment.minutes / 60,
            moment.minutes % 60,
            0,
        )
        .earliest()
        .map(|time| time.timestamp_millis())
        .unwrap_or(0)
}

/// 工作日判定表:年份 → (月, 日) → 是否工作日。
///
/// 数据来源三层,优先级从高到低:手动覆盖 (`calendarOverrides`) → 节假日缓存
/// (`holidays-<year>.json`) → 周一至周五。Rust 侧不做节假日网络拉取,缓存缺失时
/// 退化为星期几判定 —— 与 Node 在没有 `HolidayStore` 时的行为一致。
fn workday_map(
    config: &Config,
    config_dir: &Path,
    years: &[i32],
) -> BTreeMap<(i32, u32, u32), bool> {
    fn parse(key: &str) -> Option<(i32, u32, u32)> {
        let mut parts = key.split('-');
        let year = parts.next()?.parse().ok()?;
        let month = parts.next()?.parse().ok()?;
        let day = parts.next()?.parse().ok()?;
        if parts.next().is_some() {
            return None;
        }
        Some((year, month, day))
    }

    let mut out = BTreeMap::new();
    for year in years {
        if let Some(days) =
            calendar::year_days(config_dir, *year).and_then(|value| value.as_object().cloned())
        {
            for (key, value) in days {
                let Some(date) = parse(&key) else { continue };
                match value.as_str() {
                    Some(calendar::DAY_TYPE_WORKDAY) => {
                        out.insert(date, true);
                    }
                    Some(calendar::DAY_TYPE_HOLIDAY) => {
                        out.insert(date, false);
                    }
                    _ => {}
                }
            }
        }
    }
    if let Some(overrides) = &config.calendar_overrides {
        for (key, value) in overrides {
            let Some(date) = parse(key) else { continue };
            match value.as_str() {
                calendar::DAY_TYPE_WORKDAY => {
                    out.insert(date, true);
                }
                calendar::DAY_TYPE_HOLIDAY => {
                    out.insert(date, false);
                }
                // 空值/未知值 = 撤销覆盖:删掉缓存里的结论,回落到星期几判定
                _ => {
                    out.remove(&date);
                }
            }
        }
    }
    out
}

/// 单个目录此刻的时段结论。
#[derive(Debug, Clone, Default)]
pub struct Verdict {
    pub inside: bool,
    pub overridden: bool,
    pub blocked_by: Option<&'static str>,
    pub next_change_at: Option<i64>,
}

fn override_active(config: &Config, now_ms: i64) -> bool {
    config
        .schedule_override_until
        .is_some_and(|until| until > now_ms)
}

/// 与 Node `scheduleVerdictFor` 逐条对齐:全局与目录时段取交集,任一在窗口外即不活动。
pub fn schedule_verdict(
    config: &Config,
    folder_schedule: Option<&syncx_core::schedule::Schedule>,
    workdays: &BTreeMap<(i32, u32, u32), bool>,
    now_ms: i64,
) -> Verdict {
    if override_active(config, now_ms) {
        return Verdict {
            inside: true,
            overridden: true,
            ..Default::default()
        };
    }
    let moment = now_moment();
    // `IsWorkday` 是 `&dyn Fn(..) + 'static`,闭包不能借用 `workdays`;
    // 一年份的覆盖表很小(最多 366 项),直接复制一份进闭包。
    let workdays = workdays.clone();
    let is_workday = move |year: i32, month: u32, day: u32| -> bool {
        match workdays.get(&(year, month, day)) {
            Some(value) => *value,
            None => {
                let weekday = CivilMoment::new(year, month, day, 0).day_of_week();
                (1..=5).contains(&weekday)
            }
        }
    };
    let global_next = next_schedule_change(config.sync_schedule.as_ref(), &moment, &is_workday)
        .map(|next| moment_to_ms(&next));
    let folder_next =
        next_schedule_change(folder_schedule, &moment, &is_workday).map(|next| moment_to_ms(&next));

    if !within_schedule(config.sync_schedule.as_ref(), &moment, &is_workday) {
        return Verdict {
            inside: false,
            next_change_at: global_next.or(folder_next),
            blocked_by: Some("global"),
            overridden: false,
        };
    }
    if !within_schedule(folder_schedule, &moment, &is_workday) {
        return Verdict {
            inside: false,
            next_change_at: folder_next.or(global_next),
            blocked_by: Some("folder"),
            overridden: false,
        };
    }
    Verdict {
        inside: true,
        next_change_at: match (global_next, folder_next) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (Some(a), None) => Some(a),
            (None, Some(b)) => Some(b),
            (None, None) => None,
        },
        ..Default::default()
    }
}

/// 每目录此刻的时段结论(状态载荷的 `scheduleStates`)。
fn schedule_states(
    config: &Config,
    workdays: &BTreeMap<(i32, u32, u32), bool>,
    now_ms: i64,
) -> BTreeMap<String, ScheduleState> {
    let mut out = BTreeMap::new();
    for folder in &config.shared_folders {
        let verdict = schedule_verdict(config, folder.schedule.as_ref(), workdays, now_ms);
        out.insert(
            folder.folder_id(),
            ScheduleState {
                inside: verdict.inside,
                overridden: verdict.overridden.then_some(true),
                blocked_by: verdict.blocked_by.map(str::to_string),
                next_change_at: verdict.next_change_at,
                summary: Some(format_schedule_summary(folder.schedule.as_ref())),
            },
        );
    }
    out
}

/// 顶部横幅:只在「没有任何目录在同步、且原因确实是时段」时出现。
///
/// 手动暂停与电源守卫各有自己的提示,不记进时段的账 —— 否则用户自己按了暂停,
/// 横幅会说成「因为时段所以不同步」,归错因。
fn schedule_banner(
    config: &Config,
    workdays: &BTreeMap<(i32, u32, u32), bool>,
    now_ms: i64,
    power_guard: Option<&str>,
) -> ScheduleBanner {
    let total = config.shared_folders.len();
    let mut blocked = 0usize;
    let mut next: Option<i64> = None;
    let mut any_active = false;
    for folder in &config.shared_folders {
        if config.is_paused() || power_guard.is_some() || folder.is_paused() {
            continue;
        }
        let verdict = schedule_verdict(config, folder.schedule.as_ref(), workdays, now_ms);
        if verdict.inside {
            any_active = true;
            continue;
        }
        blocked += 1;
        if let Some(at) = verdict.next_change_at {
            next = Some(next.map_or(at, |current| current.min(at)));
        }
    }
    let override_until = if override_active(config, now_ms) {
        config.schedule_override_until
    } else {
        None
    };
    ScheduleBanner {
        visible: override_until.is_some() || (blocked > 0 && !any_active),
        blocked_by_schedule: blocked,
        total,
        next_change_at: next,
        override_until,
    }
}

/// 节假日缓存的状态(`calendarStatus`)。与 `GET /api/calendar` 同源。
fn calendar_status(
    config_dir: &Path,
    config: &Config,
    last_error: Option<String>,
) -> CalendarStatus {
    let year = now_moment().year;
    CalendarStatus {
        year,
        fetched: calendar::fetched(config_dir, year),
        fetched_at: None,
        override_count: config
            .calendar_overrides
            .as_ref()
            .map(|map| map.len())
            .unwrap_or(0),
        last_error,
    }
}

/* ============================ 状态载荷 ============================ */

/// `1.2.3` 这样的真实版本。`dev` / 空 / 非数字开头都不算 —— 跨形态不做自更新。
fn is_real_version(version: &str) -> bool {
    let mut parts = version.split('.');
    let Some(first) = parts.next() else {
        return false;
    };
    !first.is_empty()
        && first.chars().all(|c| c.is_ascii_digit())
        && parts.clone().count() >= 1
        && parts.all(|part| {
            let head: String = part.chars().take_while(|c| c.is_ascii_digit()).collect();
            !head.is_empty()
        })
}

/// 算一份完整的状态载荷。HTTP `/api/status`、WS 推送、`/metrics` 三处共用这一个入口,
/// 口径不可能漂。
pub fn get_status(runtime_ops: &RuntimeOps, extras: &Extras) -> Value {
    let config = runtime_ops.store.load();
    let snapshot = runtime_ops.actor.snapshot();
    let now_ms = crate::invite::now_ms();

    // deviceId → 它被指派到的目录 id 列表
    let mut folder_devices: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for folder in &config.shared_folders {
        let folder_id = folder.folder_id();
        for device_id in &folder.devices {
            folder_devices
                .entry(device_id.clone())
                .or_default()
                .push(folder_id.clone());
        }
    }
    let mut device_ids: Vec<String> = config
        .known_devices
        .iter()
        .map(|device| device.id.clone())
        .collect();
    for device_id in folder_devices.keys() {
        if !device_ids.contains(device_id) {
            device_ids.push(device_id.clone());
        }
    }

    let mut devices = Vec::with_capacity(device_ids.len());
    for device_id in &device_ids {
        let info = runtime_ops.peer_info_of(device_id);
        let can_upgrade = is_real_version(&runtime_ops.version)
            && info.version.as_deref().is_some_and(is_real_version)
            && update::compare_versions(
                &runtime_ops.version,
                info.version.as_deref().unwrap_or_default(),
            ) < 0;
        devices.push(DeviceStatus {
            device_id: device_id.clone(),
            online: runtime_ops.is_connected(device_id),
            url: runtime_ops.peer_url_of(device_id),
            hostname: info.hostname,
            platform: info.platform,
            runtime: info.runtime,
            folders: folder_devices.get(device_id).cloned().unwrap_or_default(),
            remote_folders: runtime_ops
                .remote_folders
                .lock()
                .ok()
                .and_then(|map| map.get(device_id).cloned()),
            remote_pending_folders: runtime_ops
                .remote_pending
                .lock()
                .ok()
                .and_then(|map| map.get(device_id).cloned()),
            version: info.version,
            can_upgrade: Some(can_upgrade),
        });
    }

    // 目录级错误:引擎只报「盘上写不进去」这一类,如实转成目录卡上的提示
    let folder_errors: Vec<FolderError> = snapshot
        .folders
        .iter()
        .filter_map(|folder| {
            folder.disk_blocked.as_ref().map(|message| FolderError {
                folder: folder.id.clone(),
                message: message.clone(),
                ts: now_ms,
                kind: Some("disk-blocked".to_string()),
            })
        })
        .collect();

    let conflict_counts: BTreeMap<String, usize> = snapshot
        .folders
        .iter()
        .filter(|folder| folder.conflicts > 0)
        .map(|folder| (folder.id.clone(), folder.conflicts))
        .collect();

    let year = now_moment().year;
    let workdays = workday_map(&config, &runtime_ops.config_dir, &[year, year + 1]);
    let power_guard: Option<String> = None;

    let status_extras = StatusExtras {
        conflict_counts: (!conflict_counts.is_empty()).then_some(conflict_counts),
        git_change_counts: extras.git_change_counts.lock().ok().map(|map| map.clone()),
        git_unpushed_counts: extras
            .git_unpushed_counts
            .lock()
            .ok()
            .map(|map| map.clone()),
        traffic: runtime_ops.traffic(),
        hostname: hostname::get()
            .ok()
            .and_then(|name| name.into_string().ok()),
        local_addresses: Some(syncx_api::status::lan_addresses()),
        config_dir: Some(runtime_ops.config_dir.display().to_string()),
        settings: Some(GlobalSettings::from_config(&config)),
        discovered: Some(discovered_list(&config, extras, now_ms)),
        power_guard,
        network_online: Some(extras.online()),
        schedule_states: Some(schedule_states(&config, &workdays, now_ms)),
        schedule_banner: Some(schedule_banner(&config, &workdays, now_ms, None)),
        calendar_status: Some(calendar_status(&runtime_ops.config_dir, &config, None)),
    };

    let payload = build_status(
        &config,
        Some(&snapshot),
        &runtime_ops.device_id,
        &runtime_ops.version,
        devices,
        folder_errors,
        status_extras,
    );
    serde_json::to_value(&payload).unwrap_or(Value::Null)
}

/// 附近发现的设备:过 TTL 先剪掉,已经配对上的从列表摘除(升格成设备卡)。
fn discovered_list(config: &Config, extras: &Extras, now_ms: i64) -> Vec<DiscoveredDevice> {
    let Ok(mut map) = extras.discovered.lock() else {
        return Vec::new();
    };
    map.retain(|_, entry| now_ms - entry.last_seen <= DISCOVERY_TTL_MS);
    map.iter()
        .filter(|(device_id, _)| !super::is_peer_allowed(config, device_id))
        .map(|(device_id, entry)| DiscoveredDevice {
            device_id: device_id.clone(),
            host: entry.host.clone(),
            port: entry.port,
            address: entry.address.clone(),
            last_seen: entry.last_seen,
        })
        .collect()
}

/* ============================ 运行体构造 ============================ */

/// 建 `RuntimeOps` + `StatusHub`。**必须在 tokio 运行时内调用**(hub 内部 `spawn`)。
///
/// `actor` 由调用方给:数据面服务端要在 ops 之前起(见模块注释第 2 条),
/// 而服务端的 handler 又要用 ops,所以 actor 先于两者独立创建。
pub fn build_runtime(
    options: &RunOptions,
    actor: ActorHandle,
    peer_port: Option<u16>,
    started_at: Instant,
    shutdown_tx: UnboundedSender<()>,
    dial_tx: UnboundedSender<super::DialRequest>,
) -> Runtime {
    let extras = Arc::new(Extras::new());
    let store = ConfigStore::new(&options.config_path);

    // 状态闭包先拿到空槽,ops 建好后回填。`StatusHub` 的定时器在第一个 tick 之前
    // 不会真的序列化,空槽期不会产出假状态。
    let cell: Arc<OnceLock<Arc<RuntimeOps>>> = Arc::new(OnceLock::new());
    let hub = StatusHub::new(
        {
            let cell = Arc::clone(&cell);
            let extras = Arc::clone(&extras);
            move || match cell.get() {
                Some(ops) => get_status(ops, &extras),
                None => Value::Null,
            }
        },
        Timings::default(),
    );

    let ops = Arc::new(RuntimeOps {
        identity: Arc::clone(&options.identity),
        store,
        config_path: options.config_path.clone(),
        config_dir: options.config_dir.clone(),
        device_id: options.device_id.clone(),
        version: options.version.clone(),
        dev_mode: options.dev_mode,
        peer_port,
        actor,
        hub: Some(hub.clone()),
        terminal: TerminalHub::new(),
        started_at,
        sessions: Mutex::new(HashMap::new()),
        peer_info: Mutex::new(HashMap::new()),
        peer_urls: Mutex::new(HashMap::new()),
        remote_folders: Mutex::new(HashMap::new()),
        remote_pending: Mutex::new(HashMap::new()),
        pending_snapshots: Mutex::new(HashMap::new()),
        pending_files: Mutex::new(HashMap::new()),
        pending_writes: Mutex::new(HashMap::new()),
        pending_binaries: Mutex::new(HashMap::new()),
        shutdown_tx,
        dial_tx,
        git_push_running: AtomicBool::new(false),
        git_rewrite_running: AtomicBool::new(false),
        git_state: Mutex::new(super::GitState::default()),
    });
    let _ = cell.set(Arc::clone(&ops));

    // 文件系统监听:重扫请求接到 actor 的单目录扫描;目录清单按当前配置对齐一次,
    // 之后由配置热重载(sync_fs_watcher)跟进。hub 的重建/降级由它自己的巡检负责。
    let (rescan_tx, rescan_rx) = tokio::sync::mpsc::unbounded_channel();
    let watch = FsWatchHub::spawn(FS_WATCH_WINDOW, FS_WATCH_SWEEP, rescan_tx);
    spawn_rescan_forwarder(Arc::clone(&ops), rescan_rx);
    sync_fs_watcher(&ops, &watch);

    Runtime {
        ops,
        hub,
        extras,
        watch,
    }
}

/// 建 actor。目录规格随后由 [`reload_actor`] 送进去 —— 这样「加目录」只有一条路径。
pub fn build_actor(device_id: &str) -> ActorHandle {
    let device_id = device_id.to_string();
    spawn_actor(move |snapshot| SessionActor::new(device_id.clone(), snapshot))
}

/* ============================ 控制面 ============================ */

/// 连接生命周期的三个钩子。`open` 注册出站通道并发首帧,`message` 镜像 Node
/// `onControl` 的全部分支,`close` 把会话从台账里摘掉。
pub fn control_hooks(runtime: &Arc<Runtime>) -> ControlHooks {
    let opened = Arc::clone(runtime);
    let messaged = Arc::clone(runtime);
    let closed = Arc::clone(runtime);
    ControlHooks {
        open: Arc::new(move |link| on_open(&opened, link)),
        message: Arc::new(move |link, message| on_control(&messaged, link, message)),
        close: Arc::new(move |device_id| on_close(&closed, device_id)),
    }
}

/// 会话挂上、收发循环开始之前:登记通道,发 hello,推目录清单与共享意图。
fn on_open(runtime: &Runtime, link: driver::ControlLink) {
    let ops = &runtime.ops;
    ops.register_session(super::ControlLink {
        device_id: link.device_id.clone(),
        outbound: link.outbound.clone(),
    });
    let (version, hostname, platform) = ops.self_info();
    let _ = ops.send_to(
        &link.device_id,
        ControlMessage::Hello {
            from_device_id: ops.device_id.clone(),
            version,
            hostname,
            platform,
            runtime: Some(super::RUNTIME.to_string()),
        },
    );
    ops.push_folder_sync_list(&link.device_id);
    ops.push_shares_to(&link.device_id);
    ops.notify_hub();
    tracing::info!("会话已建立:{}", link.device_id);
}

/// 会话结束:摘台账,清对端宣告的目录清单,推一次状态(设备卡要变灰)。
fn on_close(runtime: &Runtime, device_id: &str) {
    let ops = &runtime.ops;
    ops.drop_session(device_id);
    if let Ok(mut map) = ops.remote_folders.lock() {
        map.remove(device_id);
    }
    if let Ok(mut map) = ops.remote_pending.lock() {
        map.remove(device_id);
    }
    ops.notify_hub();
    tracing::info!("会话已断开:{device_id}");
}

/// 一条控制消息。`hop` 是**这一跳**的对端 —— 与消息体里的 `fromDeviceId` 不一定相同
/// (中继出去的 git 通知仍署最初那台提交设备)。
pub fn on_control(runtime: &Runtime, link: driver::ControlLink, message: ControlMessage) {
    let ops = &runtime.ops;
    match message {
        ControlMessage::Hello {
            from_device_id,
            version,
            hostname,
            platform,
            runtime,
        } => {
            if super::should_log_version_change(
                ops,
                &from_device_id,
                Some(&version),
                hostname.as_deref(),
                platform.as_deref(),
                runtime.as_deref(),
            ) {
                tracing::info!("对端版本:{from_device_id} → {version}");
            }
        }
        ControlMessage::PairingRequest {
            offer_id,
            from_device_id,
            version,
            hostname,
            platform,
            runtime,
        } => {
            super::should_log_version_change(
                ops,
                &from_device_id,
                version.as_deref(),
                hostname.as_deref(),
                platform.as_deref(),
                runtime.as_deref(),
            );
            offers::receive_offer(
                &ops.store,
                &offer_id,
                "pairing",
                &from_device_id,
                None,
                None,
                hostname.as_deref(),
                None,
            );
            // 投递回执:无论新建/去重/互信跳过,处理到即回
            let (self_version, self_hostname, self_platform) = ops.self_info();
            let _ = ops.send_to(
                &from_device_id,
                ControlMessage::OfferReceipt {
                    offer_id,
                    from_device_id: ops.device_id.clone(),
                    version: Some(self_version),
                    hostname: self_hostname,
                    platform: self_platform,
                    runtime: Some(super::RUNTIME.to_string()),
                },
            );
            tracing::info!("收到配对请求:{from_device_id}");
        }
        ControlMessage::FolderInvitation {
            offer_id,
            from_device_id,
            folder_id,
            folder_name,
            version,
            hostname,
            platform,
            runtime,
        } => {
            super::should_log_version_change(
                ops,
                &from_device_id,
                version.as_deref(),
                hostname.as_deref(),
                platform.as_deref(),
                runtime.as_deref(),
            );
            let created = offers::receive_offer(
                &ops.store,
                &offer_id,
                "folder",
                &from_device_id,
                Some(&folder_id),
                Some(&folder_name),
                hostname.as_deref(),
                None,
            );
            let (self_version, self_hostname, self_platform) = ops.self_info();
            let _ = ops.send_to(
                &from_device_id,
                ControlMessage::OfferReceipt {
                    offer_id,
                    from_device_id: ops.device_id.clone(),
                    version: Some(self_version),
                    hostname: self_hostname,
                    platform: self_platform,
                    runtime: Some(super::RUNTIME.to_string()),
                },
            );
            // 新落成一个待确认项后立刻反推目录清单(带 pendingFolderIds),
            // 让对端设备标签马上从「已停止共享」切到「待对方确认」
            if created.is_some() {
                ops.push_folder_sync_list(&from_device_id);
            }
            tracing::info!("收到目录邀请:{from_device_id} / {folder_id}");
        }
        ControlMessage::OfferReceipt {
            offer_id,
            from_device_id,
            ..
        } => {
            // Rust 侧没有「至少一次」重发台账:邀请只随会话建立发一次,回执仅作观测。
            tracing::debug!("投递回执:{from_device_id} / {offer_id}");
        }
        ControlMessage::PairingAck {
            offer_id,
            from_device_id,
            accepted,
            ..
        } => {
            tracing::info!(
                "配对{}:{from_device_id} / {offer_id}",
                if accepted { "已接受" } else { "已拒绝" }
            );
        }
        ControlMessage::FolderInvitationAck {
            offer_id,
            from_device_id,
            accepted,
            ..
        } => {
            tracing::info!(
                "目录邀请{}:{from_device_id} / {offer_id}",
                if accepted { "已接受" } else { "已拒绝" }
            );
            // 对端接受 = 双方的 devices 里都有对方:重载目录让数据面槽位补上
            if accepted {
                ops.promote_session(&from_device_id);
            }
        }
        ControlMessage::FolderSyncList {
            from_device_id,
            folder_ids,
            pending_folder_ids,
            version,
            hostname,
            platform,
            runtime,
        } => {
            super::should_log_version_change(
                ops,
                &from_device_id,
                version.as_deref(),
                hostname.as_deref(),
                platform.as_deref(),
                runtime.as_deref(),
            );
            if let Ok(mut map) = ops.remote_folders.lock() {
                map.insert(from_device_id.clone(), folder_ids.clone());
            }
            if let Ok(mut map) = ops.remote_pending.lock() {
                map.insert(
                    from_device_id.clone(),
                    pending_folder_ids.clone().unwrap_or_default(),
                );
            }
            // 对方不再列出的 pending 目录邀请 = 已被撤销,卡片留着就是永远点不动
            let removed = offers::prune_revoked(&ops.store, &from_device_id, &folder_ids);
            if removed > 0 {
                ops.notify_hub();
            }
        }
        ControlMessage::SelfBinaryRequest {
            request_id,
            from_device_id,
            ..
        } => {
            compare::answer_self_binary_request(ops, &from_device_id, &request_id);
        }
        ControlMessage::SelfBinaryResponse { .. } => {
            compare::on_self_binary_response(ops, message);
        }
        ControlMessage::FolderIndexRequest {
            request_id,
            from_device_id,
            folder_id,
            ..
        } => {
            compare::serve_index_snapshot(ops, &from_device_id, &folder_id, &request_id);
        }
        ControlMessage::FolderIndexSnapshot { .. } => {
            compare::on_snapshot_chunk(ops, message);
        }
        ControlMessage::FileContentRequest {
            request_id,
            from_device_id,
            folder_id,
            path,
            ..
        } => {
            compare::serve_peer_file(ops, &from_device_id, &folder_id, &path, &request_id);
        }
        ControlMessage::FileContentResponse { .. } => {
            compare::on_peer_file_response(ops, message);
        }
        ControlMessage::FileContentWrite { .. } => {
            compare::apply_peer_file_write(ops, message);
        }
        ControlMessage::FileContentWriteResult { .. } => {
            compare::on_peer_file_write_result(ops, message);
        }
        ControlMessage::GitCommitNotify {
            from_device_id,
            commit_hash,
            folder_id,
            commit_message,
            changed_files,
            diff_stat,
            commit_subjects,
            parent_hash,
            ..
        } => {
            // 回执立刻回给**这一跳**:中继出去的通知 fromDeviceId 仍是最初那台提交设备,
            // 按它寻址会把回执发到一台本机根本没有会话的设备上
            let (version, hostname, platform) = ops.self_info();
            let _ = ops.send_to(
                &link.device_id,
                ControlMessage::GitCommitAck {
                    from_device_id: ops.device_id.clone(),
                    folder_id: folder_id.clone(),
                    commit_hash: commit_hash.clone(),
                    version: Some(version),
                    hostname,
                    platform,
                    runtime: Some(super::RUNTIME.to_string()),
                },
            );
            // 记住这一跳(而非消息里署名的提交设备):中继时不回给来源端,
            // 链式拓扑 A—B—C 才不会被一轮回弹打成环。
            ops.note_git_notice(
                &folder_id,
                super::GitNotice {
                    from_device_id,
                    commit_hash,
                    commit_message,
                    changed_files,
                    diff_stat,
                    commit_subjects,
                    parent_hash,
                    via_device_id: Some(link.device_id.clone()),
                },
            );
        }
        ControlMessage::GitCommitAck {
            commit_hash,
            folder_id,
            from_device_id,
            ..
        } => {
            tracing::debug!("git 提交通知已送达:{from_device_id} / {folder_id} / {commit_hash}");
            git_sync::on_git_commit_ack(ops, &folder_id, &commit_hash, &from_device_id);
        }
    }
    ops.notify_hub();
}

/* ============================ 数据面服务端 ============================ */

/// 一台对端此刻应该挂哪些目录:配置里把对方列进 `devices` 的那些。
fn folders_for(ops: &RuntimeOps, remote_device_id: &str) -> Vec<String> {
    ops.store
        .load()
        .shared_folders
        .iter()
        .filter(|folder| folder.devices.iter().any(|id| id == remote_device_id))
        .map(SharedFolder::folder_id)
        .collect()
}

/* ============================ 占位:后续分块追加 ============================ */

/* ============================ 后台循环 ============================ */

/// 扫描节拍。可用 `SYNCX_SCAN_INTERVAL_MS` 覆盖(与 Node 同名变量)。
fn scan_interval() -> Duration {
    std::env::var("SYNCX_SCAN_INTERVAL_MS")
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .filter(|ms| *ms > 0)
        .map(Duration::from_millis)
        .unwrap_or(Duration::from_millis(DEFAULT_SCAN_INTERVAL_MS))
}

/// 同步事件的动作名。历史库与前端筛选都认这四个词。
fn action_name(action: syncx_daemon::peer::SyncAction) -> &'static str {
    use syncx_daemon::peer::SyncAction;
    match action {
        SyncAction::Add => "add",
        SyncAction::Update => "update",
        SyncAction::Delete => "delete",
        SyncAction::Conflict => "conflict",
    }
}

/* ============================ 文件系统监听 ============================ */

/// 待监听目录清单:未暂停且身份校验通过的共享目录才有 watcher。
///
/// 资格判据与 git 自动提交的身份闸(control/mod.rs)同一口径:身份结论为
/// `missing` / `changed` / `remounted` 的目录不监听 —— 根目录读不到或已被换掉,
/// 监听没有意义;恢复后的重建由巡检完成。`unknown`(存量未采集)与
/// `remounted-known` 放行,扫描管线的结构守卫照常兜底。目录级暂停已足够:
/// 全局暂停时既有扫描管线照常运行(watcher 只是触发器,语义不需要额外收窄)。
fn watch_specs(config: &Config) -> Vec<WatchFolderSpec> {
    if !config.fs_watch_enabled() {
        return Vec::new();
    }
    config
        .shared_folders
        .iter()
        .filter(|folder| {
            !folder.is_paused()
                && !matches!(
                    mutate::folder_identity_verdict(folder),
                    "missing" | "changed" | "remounted"
                )
        })
        .map(|folder| WatchFolderSpec {
            id: folder.folder_id(),
            root: PathBuf::from(&folder.path),
        })
        .collect()
}

/// 把当前配置里的待监听目录交给监听中枢。配置热重载与启动装配各调一次。
fn sync_fs_watcher(ops: &RuntimeOps, watch: &FsWatchHub) {
    watch.sync(watch_specs(&ops.store.load()));
}

/// watcher 触发的重扫请求 → actor 单目录扫描。聚合层已保证同一目录一个窗口至多
/// 一条请求;actor 退出(发送失败)即停。
fn spawn_rescan_forwarder(
    ops: Arc<RuntimeOps>,
    mut rescan_rx: tokio::sync::mpsc::UnboundedReceiver<RescanRequest>,
) {
    tokio::spawn(async move {
        while let Some(request) = rescan_rx.recv().await {
            if !ops
                .actor
                .send(Cmd::ScanFolder { folder: request.folder })
            {
                break;
            }
        }
        tracing::debug!("重扫转发循环退出");
    });
}

/// watcher 健康时的兜底全扫间隔。
///
/// `SYNCX_SCAN_INTERVAL_MS` 设置时钳住它:该变量的语义是「至少这么频繁地扫」,
/// 不能因为 watcher 健康就把测试/开发钩子放大到 600 秒。
fn fallback_interval(fallback_secs: u64) -> Duration {
    let env_ms = std::env::var("SYNCX_SCAN_INTERVAL_MS")
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .filter(|ms| *ms > 0);
    clamp_fallback(fallback_secs, env_ms)
}

/// 纯决策(环境读取在外面,测试不碰进程级环境变量):钩子只做下限钳制。
fn clamp_fallback(fallback_secs: u64, env_ms: Option<u64>) -> Duration {
    let configured = Duration::from_secs(fallback_secs.max(1));
    match env_ms {
        Some(ms) => configured.min(Duration::from_millis(ms)),
        None => configured,
    }
}

/// 扫描循环的节拍决策。
///
/// - 配置关闭监听 → 纯定时:退回原有扫描间隔(`scan_interval`)。
/// - watcher 全部健康 → 兜底全扫间隔(`fsWatchFallbackScanSecs`,缺省 600 秒)。
/// - 任一目录降级 → 退回原有扫描间隔(warn 由 watcher 模块发,每目录一次)。
fn scan_tick_secs(fallback_secs: u64, watch_enabled: bool, watch_healthy: bool) -> Duration {
    if watch_enabled && watch_healthy {
        fallback_interval(fallback_secs)
    } else {
        scan_interval()
    }
}

/// 扫描循环:定期让 actor 扫盘。**必须**由装配层驱动 —— actor 自己不排定时器,
/// 它只响应命令,这样「扫描」与「收帧」在同一个线程上串行,不会出现边扫边改索引。
///
/// 间隔不再固定:每轮按「监听开关 + watcher 健康度」重算(见 [`scan_tick_secs`]),
/// 所以用 sleep 循环而不是 `tokio::time::interval`。配置每次现读 —— 间隔是全局
/// 设置,热重载后下一轮就该生效,不该等重启。
fn spawn_scan_loop(ops: Arc<RuntimeOps>, health: Arc<WatchHealth>) {
    tokio::spawn(async move {
        // 启动时已扫过一轮(reload_actor 里的 Cmd::Scan),这里直接进入等待
        loop {
            let config = ops.store.load();
            let interval = scan_tick_secs(
                config.fs_watch_fallback_scan_secs(),
                config.fs_watch_enabled(),
                health.healthy(),
            );
            tokio::time::sleep(interval).await;
            if !ops.actor.send(Cmd::Scan) {
                break;
            }
        }
        tracing::debug!("扫描循环退出");
    });
}

/// 排空循环:取走运行期事件 → 写历史 → 结算 git 通知 → 超时巡检。
///
/// 三个动作共用同一个节拍是刻意的:它们都要「在上一轮之后、下一轮之前」看到状态,
/// 分开排定时器会让一次块超时的判定与一次提交的落账互相错位。
fn spawn_drain_loop(ops: Arc<RuntimeOps>) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(DRAIN_INTERVAL);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        tick.tick().await;
        loop {
            tick.tick().await;
            ops.actor.send(Cmd::Poll);
            let (tx, rx) = oneshot::channel();
            if !ops.actor.send(Cmd::Drain { reply: tx }) {
                break;
            }
            let Ok(drains) = rx.await else { continue };
            for drain in drains {
                for event in &drain.events {
                    ops.record_event(
                        &drain.folder,
                        &event.path,
                        action_name(event.action),
                        event.direction,
                        Some(&event.device_id),
                        event.duration_ms,
                    );
                }
                if !drain.hard_ignored.is_empty() {
                    tracing::debug!(
                        folder = %drain.folder,
                        count = drain.hard_ignored.len(),
                        "对端路径命中硬忽略,已丢弃"
                    );
                }
                for (path, missing) in &drain.stall_dropped {
                    tracing::warn!(folder = %drain.folder, %path, missing, "长时间未取到块,本轮放弃");
                }
                if let Some(outcome) = drain.initial_outcome {
                    tracing::info!(folder = %drain.folder, outcome, "首轮索引交换结束");
                }
            }
            ops.flush_git_notices();
        }
        tracing::debug!("排空循环退出");
    });
}

/// git 徽标计数。`git status` / `rev-list` 要起子进程,绝不能进状态推送路径,
/// 所以由这个小循环每 30 秒算一次,状态闭包只读缓存。
fn spawn_git_counts_loop(ops: Arc<RuntimeOps>, extras: Arc<Extras>) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(GIT_COUNT_INTERVAL);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            let folders = ops.store.load().shared_folders.clone();
            let mut changes = BTreeMap::new();
            let mut unpushed = BTreeMap::new();
            for folder in folders {
                let root = PathBuf::from(&folder.path);
                let folder_id = folder.folder_id();
                if let Some((entries, _truncated)) = crate::git::get_uncommitted_changes(&root) {
                    if !entries.is_empty() {
                        changes.insert(folder_id.clone(), entries.len());
                    }
                }
                if let Some(total) = crate::git::count_unpushed_commits(&root) {
                    if total > 0 {
                        unpushed.insert(folder_id, total as usize);
                    }
                }
            }
            let dirty = {
                let stored_changes = extras
                    .git_change_counts
                    .lock()
                    .map(|mut map| {
                        let changed = *map != changes;
                        *map = changes;
                        changed
                    })
                    .unwrap_or(false);
                let stored_unpushed = extras
                    .git_unpushed_counts
                    .lock()
                    .map(|mut map| {
                        let changed = *map != unpushed;
                        *map = unpushed;
                        changed
                    })
                    .unwrap_or(false);
                stored_changes || stored_unpushed
            };
            if dirty {
                ops.notify_hub();
            }
        }
    });
}

/// 配置热重载:轮询 `config.json` 的 mtime + 长度。
///
/// `notify` 依赖如今有(共享目录的监听在用),但配置文件仍轮询:热重载需要的是
/// 「变了就重读」这一件事,mtime + 长度比对零歧义,1 秒粒度对「改设置后多久生效」
/// 完全够用;而代价是一秒一次 `metadata` 系统调用 —— 比常驻监听回调再串一次
/// 读盘便宜得多。
fn spawn_config_watch(runtime: Arc<Runtime>) {
    tokio::spawn(async move {
        fn stamp(path: &Path) -> Option<(std::time::SystemTime, u64)> {
            let meta = std::fs::metadata(path).ok()?;
            Some((meta.modified().ok()?, meta.len()))
        }
        let mut last = stamp(&runtime.ops.config_path);
        let mut tick = tokio::time::interval(CONFIG_POLL_INTERVAL);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            let current = stamp(&runtime.ops.config_path);
            if current == last {
                continue;
            }
            last = current;
            // 落盘可能还写到一半(rename 前),等一个节拍再读;这里只做「变了就重载」
            reload_actor(&runtime.ops);
            // 目录集合/暂停/身份资格变了,watcher 清单跟进(fsWatch 开关也在这里生效)
            sync_fs_watcher(&runtime.ops, &runtime.watch);
            runtime.ops.notify_hub();
        }
    });
}

/* ============================ 出站拨号 ============================ */

/// 本机的数据面地址集合,用于挡住「拨自己」。
///
/// 拨自己不会报错:握手会成功,然后本机与自己互相同步,表现为索引在两个方向
/// 反复覆盖。Node 用同一判据(`isSelfPeerUrl`)挡它,这里逐条对齐。
fn self_urls(peer_port: Option<u16>) -> Vec<String> {
    let Some(port) = peer_port else {
        return Vec::new();
    };
    let mut urls = Vec::new();
    for address in syncx_api::status::lan_addresses() {
        urls.push(format!("ws://{address}:{port}"));
    }
    urls
}

/// 从 `ws://host:port` 里取出 `host:port`,与自拨地址同形比较。
fn normalize_url(url: &str) -> Option<String> {
    let rest = url.strip_prefix("ws://")?;
    let rest = rest.split('/').next()?;
    Some(rest.to_string())
}

fn is_self_peer(url: &str, self_urls: &[String]) -> bool {
    let Some(target) = normalize_url(url) else {
        return false;
    };
    self_urls
        .iter()
        .filter_map(|candidate| normalize_url(candidate))
        .any(|candidate| candidate == target)
}

/// 拨号循环:维护 `config.peers` 里每条地址的连接,断了按指数退避重连。
///
/// **一条地址一个任务**。这样「连接活着」这件事由任务的存活直接表达,不需要另立
/// 一张「已连 / 未连」的台账去和真实连接对账 —— 那种台账一旦漏更新,表现就是
/// 「设备卡显示在线但内容不动」。
fn spawn_dial_loop(
    runtime: Arc<Runtime>,
    mut dial_rx: tokio::sync::mpsc::UnboundedReceiver<super::DialRequest>,
) {
    tokio::spawn(async move { dial_loop(runtime, &mut dial_rx).await });
}

async fn dial_loop(
    runtime: Arc<Runtime>,
    dial_rx: &mut tokio::sync::mpsc::UnboundedReceiver<super::DialRequest>,
) {
    let ops = Arc::clone(&runtime.ops);
    let self_urls = self_urls(ops.peer_port);

    // 一地址一任务:用一张 ledger 记住「这条地址已经有任务了」,避免重复拨号
    let started: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));

    let start_one = {
        let runtime = Arc::clone(&runtime);
        let started = Arc::clone(&started);
        let self_urls = self_urls.clone();
        move |url: String| {
            if is_self_peer(&url, &self_urls) {
                tracing::info!("跳过自指地址:{url}");
                return;
            }
            let Ok(mut guard) = started.lock() else {
                return;
            };
            if !guard.insert(url.clone()) {
                return;
            }
            drop(guard);
            spawn_outbound(&runtime, url, Arc::clone(&started));
        }
    };

    // 启动时先拨一轮配置里已有的地址
    for url in runtime.ops.store.load().peers.clone() {
        start_one(url);
    }

    loop {
        tokio::select! {
            request = dial_rx.recv() => {
                let Some(request) = request else { break };
                // `reconnect` 给的是设备 id:优先用学到的地址,再退回复读配置里的全部地址
                match ops.peer_url_of(&request.device_id) {
                    Some(url) => {
                        if let Ok(mut guard) = started.lock() {
                            guard.remove(&url);
                        }
                        start_one(url);
                    }
                    None => {
                        for url in ops.store.load().peers.clone() {
                            start_one(url);
                        }
                    }
                }
            }
            _ = tokio::time::sleep(DIAL_TICK) => {
                // 配置里新加的地址(热重载/`addDevice`)在这里补拨
                for url in ops.store.load().peers.clone() {
                    start_one(url);
                }
            }
        }
    }
}

/// 一条地址的重连任务:连上就把连接跑到断开,再按退避重排。
fn spawn_outbound(runtime: &Arc<Runtime>, url: String, ledger: Arc<Mutex<HashSet<String>>>) {
    let runtime = Arc::clone(runtime);
    tokio::spawn(async move {
        let ops = &runtime.ops;
        let mut attempts: u32 = 0;
        loop {
            let online = runtime.extras.online();
            let delay = args::offline_aware_reconnect_delay(
                if attempts == 0 {
                    0
                } else {
                    args::reconnect_delay_ms(attempts)
                },
                online,
            );
            if delay > 0 {
                tokio::time::sleep(Duration::from_millis(delay)).await;
            }
            match connect_peer(&ops.identity, &url, ops.peer_port).await {
                Ok(connected) => {
                    attempts = 0;
                    let remote = connected.connection.device_id.clone();
                    ops.record_peer_url(&remote, &url);
                    tracing::info!("已连接对端:{remote}({url})");
                    let folders = folders_for(ops, &remote);
                    let hooks = control_hooks(&runtime);
                    driver::serve_session_with_control(
                        connected.connection,
                        ops.actor.clone(),
                        folders,
                        Some(hooks),
                    )
                    .await;
                    tracing::info!("对端连接结束:{remote}({url})");
                }
                Err(error) => {
                    attempts = attempts.saturating_add(1);
                    tracing::warn!("连接失败({url},第 {attempts} 次):{error}");
                }
            }
            // 任务一直活着(地址还在配置里),只是重排;配置删掉该地址后这里仍然存在,
            // 代价是一个空转的 30 秒循环 —— 与 Node 的 reconnect timer 同量级。
            if let Ok(guard) = ledger.lock() {
                if !guard.contains(&url) {
                    break;
                }
            }
        }
    });
}

/* ============================ 发现 ============================ */

/// 起 mDNS 发现。回调里只**记录**发现结果,真正的拨号交给拨号循环:
/// 发现回调在 mdns-sd 的线程上跑,不能在里面 await。
fn start_discovery_service(runtime: &Arc<Runtime>, port: u16) -> Option<Discovery> {
    let extras = Arc::clone(&runtime.extras);
    let ops_for_hub = Arc::clone(&runtime.ops);
    let device_id = runtime.ops.device_id.clone();
    let seen = Arc::new(AtomicBool::new(false));
    match start_discovery(&device_id, port, move |peer| {
        let now = crate::invite::now_ms();
        let mut newly = false;
        if let Ok(mut map) = extras.discovered.lock() {
            let entry = map.entry(peer.device_id.clone()).or_insert_with(|| {
                newly = true;
                DiscoveredEntry {
                    host: peer.host.clone(),
                    port: peer.port,
                    address: peer.address.clone(),
                    last_seen: now,
                }
            });
            // 地址缺省时保留上一次的:同一台设备两种广播(TXT/A)可能只有一份带源 IP
            if peer.address.is_some() {
                entry.address = peer.address.clone();
            }
            entry.host = peer.host.clone();
            entry.port = peer.port;
            entry.last_seen = now;
        }
        if newly && !seen.swap(true, Ordering::Relaxed) {
            // 首次发现只推一次状态:设备卡要立刻出现,但不必每 30 秒刷一遍
            ops_for_hub.notify_hub();
        }
    }) {
        Ok(discovery) => Some(discovery),
        Err(error) => {
            tracing::warn!("mDNS 发现不可用:{error}");
            None
        }
    }
}

/// 在网巡检:mDNS 广播与重连退避都读这里的状态。
///
/// 只持 `Weak`:这个任务在进程整个生命周期里跑,持 `Arc` 会让收尾路径上的
/// `Arc::try_unwrap` 永远失败,发现服务就再也没机会注销(对端要等 TTL 才认为本机下线)。
fn spawn_network_probe(extras: Arc<Extras>, discovery: Option<std::sync::Weak<Discovery>>) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(30));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            let online = !syncx_api::status::lan_addresses().is_empty();
            let was = extras.network_online.swap(online, Ordering::Relaxed);
            if was == online {
                continue;
            }
            tracing::info!("网络状态:{}", if online { "在线" } else { "离线" });
            if let Some(discovery) = discovery.as_ref().and_then(std::sync::Weak::upgrade) {
                discovery.set_online(online);
                if online {
                    // 网络恢复:立刻补一轮广播 + 查询,不等下一个 30 秒节拍
                    discovery.kick();
                }
            }
        }
    });
}

/* ============================ 启动 ============================ */

/// 启动整个 daemon:数据面服务端 → 运行体 → 控制端口 → pid → 后台循环。
///
/// 返回的 future 在收到 `shutdown` 信号(HTTP `/api/shutdown`、SIGINT/SIGTERM)后
/// 收尾并返回。**顺序不能改**,理由见模块注释。
pub async fn run(options: RunOptions) -> Result<(), String> {
    let started_at = Instant::now();
    let (shutdown_tx, mut shutdown_rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let (dial_tx, dial_rx) = tokio::sync::mpsc::unbounded_channel::<super::DialRequest>();

    // 1) 数据面服务端。绑定失败不是致命错误:控制 API 仍可用来配对/看状态,
    //    只是本机不能被对端反向连接。Node 侧同样是「起不来就记一行继续」。
    let actor = build_actor(&options.device_id);
    let mut peer_server = None;
    let mut peer_port = None;
    {
        let boot_actor = actor.clone();
        let boot_device_id = options.device_id.clone();
        let boot_runtime: Arc<OnceLock<Arc<Runtime>>> = Arc::new(OnceLock::new());
        let handler: syncx_net::server::PeerHandler = {
            let cell = Arc::clone(&boot_runtime);
            Arc::new(move |connection| {
                let cell = Arc::clone(&cell);
                let actor = boot_actor.clone();
                let _ = &boot_device_id;
                Box::pin(async move {
                    let Some(runtime) = cell.get().cloned() else {
                        tracing::warn!("运行体尚未就绪,拒绝这条对端连接");
                        return;
                    };
                    let remote = connection.device_id.clone();
                    let folders = folders_for(&runtime.ops, &remote);
                    tracing::info!("对端连入:{remote}({} 个共享目录)", folders.len());
                    let hooks = control_hooks(&runtime);
                    driver::serve_session_with_control(connection, actor, folders, Some(hooks))
                        .await;
                })
            })
        };
        let bind = format!("0.0.0.0:{}", options.peer_port.unwrap_or(DEFAULT_PEER_PORT));
        match bind.parse::<std::net::SocketAddr>() {
            Ok(addr) => match start_peer_server(Arc::clone(&options.identity), addr, handler).await
            {
                Ok(server) => {
                    peer_port = Some(server.port);
                    tracing::info!("数据面监听:{}", server.port);
                    peer_server = Some(server);
                }
                Err(error) => tracing::warn!("数据面端口 {addr} 绑定失败:{error}"),
            },
            Err(error) => tracing::warn!("数据面地址非法 {bind}:{error}"),
        }

        // 2) 运行体。hub 的定时器在这里起,闭包晚绑定到 ops。
        let runtime = Arc::new(build_runtime(
            &options,
            actor.clone(),
            peer_port,
            started_at,
            shutdown_tx.clone(),
            dial_tx.clone(),
        ));
        let _ = boot_runtime.set(Arc::clone(&runtime));

        // 3) 按配置建目录。`Reload` 是唯一入口:「加目录」不必另写一条路径。
        //    前置一步启动自愈:孤儿索引回收必须发生在任何索引句柄被打开之前
        //    (Windows 下删占用中的文件会 EBUSY),身份收养也要先于 reload,
        //    否则本轮启动仍按「未采集」处理、退化成结构守卫。
        selfheal::run(&runtime.ops.store, &runtime.ops.config_dir);
        reload_actor(&runtime.ops);

        // 4) 控制端口。先绑后写 pid:绑定失败不能留下一个指向死进程的 pid。
        let state = api_state(&runtime, &options);
        let addr: SocketAddr =
            match format!("{}:{}", options.control_host, options.control_port).parse() {
                Ok(addr) => addr,
                Err(error) => {
                    return Err(format!(
                        "控制地址非法:{}:{}({error})",
                        options.control_host, options.control_port
                    ))
                }
            };
        let listener = match tokio::net::TcpListener::bind(addr).await {
            Ok(listener) => listener,
            Err(error) => {
                let kind = crate::daemon::classify_bind_error(&error);
                let holder = crate::daemon::describe_pid_holder(&options.config_dir);
                for line in crate::daemon::bind_failure_lines(
                    kind,
                    &options.control_host,
                    options.control_port,
                    holder.as_deref(),
                    "syncx-rs",
                    &format!("({:?}) {}", error.kind(), error),
                ) {
                    tracing::error!("{line}");
                }
                return Err(format!(
                    "控制端口绑定失败:{}:{}",
                    options.control_host, options.control_port
                ));
            }
        };

        // 5) pid 记录。`backend: "rust"` 让另一个后端认出「这个数据目录被谁占着」。
        let record = crate::daemon::PidRecord {
            pid: Some(std::process::id()),
            control_port: Some(options.control_port),
            backend: Some(crate::daemon::BACKEND.to_string()),
            version: Some(options.version.clone()),
        };
        if let Err(error) = crate::daemon::write_pid_record(&options.config_dir, &record) {
            tracing::warn!("pid 文件写入失败:{}", error);
        }

        // 6) 后台循环。先把重启前没送达的两份台账还原进内存,再让排空节拍接手补投:
        //    否则上一轮进程里已广播未回执的提交会彻底丢失(对端再也收不到那一笔)。
        runtime.ops.restore_git_ledgers(&runtime.ops.store.load());
        spawn_scan_loop(Arc::clone(&runtime.ops), runtime.watch.health());
        spawn_drain_loop(Arc::clone(&runtime.ops));
        spawn_git_counts_loop(Arc::clone(&runtime.ops), Arc::clone(&runtime.extras));
        spawn_config_watch(Arc::clone(&runtime));
        spawn_dial_loop(Arc::clone(&runtime), dial_rx);
        let discovery = peer_server
            .as_ref()
            .and_then(|server| start_discovery_service(&runtime, server.port))
            .map(Arc::new);
        spawn_network_probe(
            Arc::clone(&runtime.extras),
            discovery.as_ref().map(Arc::downgrade),
        );
        runtime.ops.notify_hub();

        // 升级健康标记(ADR-0025 第 3 节):看门狗在等这个信号。控制端口已绑定、
        // 目录已挂载、后台节拍已全部启动,此刻的进程就是「新版本活下来了」的铁证;
        // 超时未写,看门狗会把 .old 换回来并拉回旧进程。标记内容是 pid,便于排障。
        if let Ok(marker) = std::env::var(crate::update::UPDATE_MARKER_ENV) {
            let _ = std::fs::write(&marker, std::process::id().to_string());
        }

        let control_url = crate::daemon::control_base_url(options.control_port);
        tracing::info!("控制界面:{control_url}");
        if runtime.ops.store.load().shared_folders.is_empty() {
            tracing::info!("尚未配置共享目录,可用 Web 界面添加");
        }

        // 7) 起服务并等退出信号
        let serve = axum::serve(
            listener,
            syncx_api::router(state).into_make_service_with_connect_info::<SocketAddr>(),
        );
        let server_task = tokio::spawn(async move { serve.await });

        tokio::select! {
            _ = shutdown_rx.recv() => tracing::info!("收到退出信号"),
            _ = tokio::signal::ctrl_c() => tracing::info!("收到 SIGINT"),
            result = server_task => {
                if let Ok(Err(error)) = result {
                    tracing::error!("控制服务异常退出:{error}");
                }
            }
        }

        // 8) 收尾。顺序与 Node 的 shutdown 链一致:先停产生方(循环),再关通道与文件。
        runtime.hub.close();
        runtime.ops.terminal.close();
        if let Some(discovery) = discovery {
            match Arc::try_unwrap(discovery) {
                Ok(discovery) => discovery.close().await,
                // 巡检任务还没放掉 Weak:不阻塞退出,注销失败的下场只是对端多等 TTL
                Err(_) => tracing::debug!("发现服务仍被引用,跳过注销"),
            }
        }
        runtime.ops.actor.send(Cmd::Shutdown);
        if let Some(server) = peer_server.take() {
            server.close().await;
        }
        crate::daemon::remove_pid_file(&options.config_dir);
        tracing::info!("已退出");
    }
    Ok(())
}

/// 组装 `syncx-api` 的依赖。
fn api_state(runtime: &Arc<Runtime>, options: &RunOptions) -> Arc<syncx_api::deps::AppState> {
    let mut deps = syncx_api::deps::ControlDeps::new(options.token.clone(), &options.config_path);
    deps.config_dir = Some(options.config_dir.display().to_string());
    deps.auth_file = Some(options.config_dir.join("auth.json"));
    deps.device_id = options.device_id.clone();
    deps.version = options.version.clone();
    deps.dev_mode = options.dev_mode;
    deps.log_file = options.log_file.clone();
    deps.started_at = runtime.ops.started_at;
    deps.hub = Some(runtime.hub.clone());
    deps.ops = Some(Arc::clone(&runtime.ops) as Arc<dyn syncx_api::deps::ControlOps>);
    {
        let ops = Arc::clone(&runtime.ops);
        let extras = Arc::clone(&runtime.extras);
        deps.status = Arc::new(move || get_status(&ops, &extras));
    }
    deps.traffic = {
        let ops = Arc::clone(&runtime.ops);
        Some(Arc::new(move || ops.traffic().unwrap_or_default())
            as Arc<
                dyn Fn() -> syncx_api::status::TrafficStats + Send + Sync,
            >)
    };
    Arc::new(syncx_api::deps::AppState::new(deps))
}

#[cfg(test)]
mod tests {
    //! 文件系统监听的装配决策:节拍选择、环境变量钳制、目录资格。

    use super::*;

    #[test]
    fn scan_tick_selects_interval_by_watch_state() {
        // 关闭监听 → 纯定时:退回原有扫描间隔
        assert_eq!(scan_tick_secs(600, false, true), scan_interval());
        // 开着但降级 → 同样退回
        assert_eq!(scan_tick_secs(600, true, false), scan_interval());
        // 开着且健康 → 兜底全扫间隔
        assert_eq!(scan_tick_secs(600, true, true), Duration::from_secs(600));
        // 非法配置(0 秒)夹到 1 秒,不产生忙转
        assert_eq!(scan_tick_secs(0, true, true), Duration::from_secs(1));
    }

    #[test]
    fn fallback_interval_respects_env_hook() {
        // SYNCX_SCAN_INTERVAL_MS 的语义是「至少这么频繁地扫」:健康 watcher 不能把它放大。
        // 只测纯决策函数 —— 进程级环境变量在并行测试里是共享状态,不能碰。
        assert_eq!(clamp_fallback(600, Some(150)), Duration::from_millis(150));
        assert_eq!(clamp_fallback(600, Some(999_999)), Duration::from_secs(600));
        assert_eq!(clamp_fallback(600, None), Duration::from_secs(600));
        assert_eq!(clamp_fallback(0, None), Duration::from_secs(1));
    }

    /// 一个测试结束才删除的临时共享目录(身份判定要对真实路径做 stat)。
    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new(tag: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "syncx-watch-specs-{}-{tag}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn watch_specs_filters_paused_and_bad_identity() {
        let root = TempRoot::new("filter");
        let config = Config {
            shared_folders: vec![
                // 存量未采集身份(unknown)→ 放行;结构守卫由扫描管线兜底
                SharedFolder {
                    path: root.0.display().to_string(),
                    ..Default::default()
                },
                // 暂停 → 不监听
                SharedFolder {
                    path: root.0.display().to_string(),
                    paused: Some(true),
                    ..Default::default()
                },
                // 根目录读不到(missing)→ 不监听,恢复后由巡检重建
                SharedFolder {
                    path: root.0.join("不存在").display().to_string(),
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        let specs = watch_specs(&config);
        assert_eq!(specs.len(), 1, "只放行「未暂停且身份可用」的目录");
        assert_eq!(specs[0].root, root.0);

        // 关掉开关 → 空表(hub 清空全部监听,扫描循环按纯定时走)
        let disabled = Config {
            fs_watch_enabled: Some(false),
            shared_folders: config.shared_folders.clone(),
            ..Default::default()
        };
        assert!(watch_specs(&disabled).is_empty());
    }
}
