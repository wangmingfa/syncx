//! `/api/status` 的载荷组装,也是 WS 状态推送的唯一数据源。
//!
//! 键名与结构逐条对齐 Node 的 `buildStatus`(`src/status.ts`)—— 前端是同一份
//! `dist/web/client.js`,少一个键就是界面上一块内容空白,而且不报错。
//!
//! 两条安全口径在这里落实,值得单独记住:
//!
//!  * **端到端密钥本体永不出 daemon**。有 `e2eKey` 的目录只外发 `e2eKeySet: true`;
//!    载荷会被推到浏览器、也会被 `fleet` 转发到别的机器,密钥本体出去等于泄密。
//!  * **`gitRepo` 每轮实时探测**,不落盘:它与「目录此刻是不是 git 仓库」有关,
//!    与上次保存时是不是无关。前端据此对「非 git 仓库 + 开了提交同步」给出警告。

use std::path::Path;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::Value;
use syncx_core::schedule::{format_schedule_summary, Schedule};
use syncx_daemon::actor::StatusSnapshot;

use crate::config::Config;

/// 局域网内 mDNS 发现、但尚未配对的设备。
#[derive(Debug, Clone, Serialize)]
pub struct DiscoveredDevice {
    #[serde(rename = "deviceId")]
    pub device_id: String,
    pub host: String,
    pub port: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
    #[serde(rename = "lastSeen")]
    pub last_seen: i64,
}

/// 一个已配置对端的当前状态。
#[derive(Debug, Clone, Serialize)]
pub struct DeviceStatus {
    #[serde(rename = "deviceId")]
    pub device_id: String,
    pub online: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hostname: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,
    /// 对端后端形态(`node` / `rust` / `moonbit`);`None` = 旧版本对端未宣告,
    /// 前端不展示后端标识(而不是猜成某一种)。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    /// 本机配置里该设备被指派到的目录 id 列表。
    pub folders: Vec<String>,
    #[serde(rename = "remoteFolders", skip_serializing_if = "Option::is_none")]
    pub remote_folders: Option<Vec<String>>,
    #[serde(rename = "remotePendingFolders", skip_serializing_if = "Option::is_none")]
    pub remote_pending_folders: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(rename = "canUpgrade", skip_serializing_if = "Option::is_none")]
    pub can_upgrade: Option<bool>,
}

/// 单个文件的传输进度。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TransferFile {
    pub path: String,
    /// `"send"` / `"receive"`
    pub direction: String,
    #[serde(rename = "bytesDone")]
    pub bytes_done: u64,
    #[serde(rename = "bytesTotal")]
    pub bytes_total: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SyncProgress {
    pub folder: String,
    pub pending: usize,
    pub sending: usize,
    pub receiving: usize,
    /// 瞬时速率(字节/秒)。窗口内没有字节流量时**不写**该键 —— 空闲快照保持最小,
    /// 差异驱动的推送也就不会凭空多推帧。
    #[serde(rename = "sendRate", skip_serializing_if = "Option::is_none")]
    pub send_rate: Option<u64>,
    #[serde(rename = "receiveRate", skip_serializing_if = "Option::is_none")]
    pub receive_rate: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files: Option<Vec<TransferFile>>,
}

/// 某共享目录最近一次同步错误。
#[derive(Debug, Clone, Serialize)]
pub struct FolderError {
    pub folder: String,
    pub message: String,
    pub ts: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TrafficSample {
    pub at: i64,
    pub sent: u64,
    pub received: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct TrafficStats {
    pub sent: u64,
    pub received: u64,
    pub samples: Vec<TrafficSample>,
}

/// 全局同步设置当前值(设置弹窗展示用;与 config 顶层字段同形)。
#[derive(Debug, Clone, Default, Serialize)]
pub struct GlobalSettings {
    #[serde(rename = "maxSendKbps", skip_serializing_if = "Option::is_none")]
    pub max_send_kbps: Option<u64>,
    #[serde(rename = "versionsPerPath", skip_serializing_if = "Option::is_none")]
    pub versions_per_path: Option<u64>,
    #[serde(rename = "historyMaxEvents", skip_serializing_if = "Option::is_none")]
    pub history_max_events: Option<u64>,
    #[serde(rename = "webhookUrl", skip_serializing_if = "Option::is_none")]
    pub webhook_url: Option<String>,
    /// **不回传密钥本体**,只报「已设置」。
    #[serde(rename = "webhookSecretSet", skip_serializing_if = "Option::is_none")]
    pub webhook_secret_set: Option<bool>,
    #[serde(rename = "pauseOnMeteredNetwork", skip_serializing_if = "Option::is_none")]
    pub pause_on_metered_network: Option<bool>,
    #[serde(rename = "pauseOnLowBattery", skip_serializing_if = "Option::is_none")]
    pub pause_on_low_battery: Option<bool>,
    #[serde(rename = "batteryPauseThreshold", skip_serializing_if = "Option::is_none")]
    pub battery_pause_threshold: Option<u64>,
    #[serde(rename = "shareEnabled", skip_serializing_if = "Option::is_none")]
    pub share_enabled: Option<bool>,
    #[serde(rename = "syncSchedule", skip_serializing_if = "Option::is_none")]
    pub sync_schedule: Option<Schedule>,
    #[serde(rename = "scheduleOverrideUntil", skip_serializing_if = "Option::is_none")]
    pub schedule_override_until: Option<i64>,
    #[serde(rename = "holidayAutoFetch", skip_serializing_if = "Option::is_none")]
    pub holiday_auto_fetch: Option<bool>,
    #[serde(rename = "holidaySourceUrl", skip_serializing_if = "Option::is_none")]
    pub holiday_source_url: Option<String>,
}

impl GlobalSettings {
    pub fn from_config(config: &Config) -> Self {
        Self {
            max_send_kbps: config.max_send_kbps,
            versions_per_path: config.versions_per_path,
            history_max_events: config.history_max_events,
            webhook_url: config.webhook_url.clone(),
            // 只报「已设置」,不报值 —— 密钥本体没有任何理由离开本机
            webhook_secret_set: config.webhook_secret.as_ref().map(|_| true),
            pause_on_metered_network: config.pause_on_metered_network,
            pause_on_low_battery: config.pause_on_low_battery,
            battery_pause_threshold: config.battery_pause_threshold,
            share_enabled: config.share_enabled,
            sync_schedule: config.sync_schedule.clone(),
            schedule_override_until: config.schedule_override_until,
            holiday_auto_fetch: config.holiday_auto_fetch,
            holiday_source_url: config.holiday_source_url.clone(),
        }
    }
}

/// 单个目录此刻的时段结论。**后端算,前端只渲染** —— 两份判定实现必然漂。
#[derive(Debug, Clone, Serialize)]
pub struct ScheduleState {
    pub inside: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub overridden: Option<bool>,
    #[serde(rename = "blockedBy", skip_serializing_if = "Option::is_none")]
    pub blocked_by: Option<String>,
    #[serde(rename = "nextChangeAt", skip_serializing_if = "Option::is_none")]
    pub next_change_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

/// 顶部横幅:是否该提示「当前不在同步时段」。
#[derive(Debug, Clone, Serialize)]
pub struct ScheduleBanner {
    pub visible: bool,
    #[serde(rename = "blockedBySchedule")]
    pub blocked_by_schedule: usize,
    pub total: usize,
    #[serde(rename = "nextChangeAt", skip_serializing_if = "Option::is_none")]
    pub next_change_at: Option<i64>,
    #[serde(rename = "overrideUntil", skip_serializing_if = "Option::is_none")]
    pub override_until: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CalendarStatus {
    pub year: i32,
    pub fetched: bool,
    #[serde(rename = "fetchedAt", skip_serializing_if = "Option::is_none")]
    pub fetched_at: Option<i64>,
    #[serde(rename = "overrideCount")]
    pub override_count: usize,
    #[serde(rename = "lastError", skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

/// `buildStatus` 的扩展口径。新功能统计进这里,不再膨胀位置参数。
#[derive(Debug, Clone, Default)]
pub struct StatusExtras {
    pub conflict_counts: Option<std::collections::BTreeMap<String, usize>>,
    pub git_change_counts: Option<std::collections::BTreeMap<String, usize>>,
    pub git_unpushed_counts: Option<std::collections::BTreeMap<String, usize>>,
    pub traffic: Option<TrafficStats>,
    pub hostname: Option<String>,
    pub local_addresses: Option<Vec<String>>,
    pub config_dir: Option<String>,
    pub settings: Option<GlobalSettings>,
    pub discovered: Option<Vec<DiscoveredDevice>>,
    pub power_guard: Option<String>,
    pub network_online: Option<bool>,
    pub schedule_states: Option<std::collections::BTreeMap<String, ScheduleState>>,
    pub schedule_banner: Option<ScheduleBanner>,
    pub calendar_status: Option<CalendarStatus>,
}

/// `/api/status` 的完整载荷。字段顺序刻意与 Node 一致,便于肉眼 diff。
#[derive(Debug, Clone, Serialize)]
pub struct StatusPayload {
    #[serde(rename = "deviceId")]
    pub device_id: String,
    pub version: String,
    pub platform: String,
    /// 后端身份(ADR-0025 第 3 节):`node` / `rust`。前端据此切换文案与按钮,
    /// 不维护两套 UI。旧后端缺省 = node。
    #[serde(rename = "runtime", skip_serializing_if = "Option::is_none")]
    pub runtime: Option<&'static str>,
    /// 更新来源:`npm` / `github`。Rust 形态只走 GitHub Releases。
    #[serde(rename = "updateSource", skip_serializing_if = "Option::is_none")]
    pub update_source: Option<&'static str>,
    pub folders: Vec<Value>,
    pub paused: bool,
    pub entries: u64,
    pub tombstones: u64,
    pub devices: Vec<DeviceStatus>,
    #[serde(rename = "syncProgress")]
    pub sync_progress: Vec<SyncProgress>,
    pub offers: Vec<Value>,
    #[serde(rename = "folderErrors")]
    pub folder_errors: Vec<FolderError>,
    #[serde(rename = "updateAvailable", skip_serializing_if = "Option::is_none")]
    pub update_available: Option<Value>,
    #[serde(rename = "relayActivity", skip_serializing_if = "Option::is_none")]
    pub relay_activity: Option<Value>,
    #[serde(rename = "conflictCounts", skip_serializing_if = "Option::is_none")]
    pub conflict_counts: Option<std::collections::BTreeMap<String, usize>>,
    #[serde(rename = "gitChangeCounts", skip_serializing_if = "Option::is_none")]
    pub git_change_counts: Option<std::collections::BTreeMap<String, usize>>,
    #[serde(rename = "gitUnpushedCounts", skip_serializing_if = "Option::is_none")]
    pub git_unpushed_counts: Option<std::collections::BTreeMap<String, usize>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub traffic: Option<TrafficStats>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hostname: Option<String>,
    #[serde(rename = "localAddresses", skip_serializing_if = "Option::is_none")]
    pub local_addresses: Option<Vec<String>>,
    #[serde(rename = "configDir", skip_serializing_if = "Option::is_none")]
    pub config_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settings: Option<GlobalSettings>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub discovered: Option<Vec<DiscoveredDevice>>,
    /// `null` 与缺省在语义上不同:null = 未挂起(明确结论);缺省 = 旧后端没提供。
    #[serde(rename = "powerGuard")]
    pub power_guard: Option<String>,
    #[serde(rename = "networkOnline")]
    pub network_online: bool,
    #[serde(rename = "scheduleStates", skip_serializing_if = "Option::is_none")]
    pub schedule_states: Option<std::collections::BTreeMap<String, ScheduleState>>,
    #[serde(rename = "scheduleBanner", skip_serializing_if = "Option::is_none")]
    pub schedule_banner: Option<ScheduleBanner>,
    #[serde(rename = "calendarStatus", skip_serializing_if = "Option::is_none")]
    pub calendar_status: Option<CalendarStatus>,
}

/// 组装状态载荷。
///
/// `snapshot` 来自 daemon actor:它是唯一知道「此刻每条连接在传什么」的地方。
/// 传 `None` 表示没有活动 daemon(纯 API 进程),此时统计全为零而不是伪造数据。
pub fn build_status(
    config: &Config,
    snapshot: Option<&StatusSnapshot>,
    device_id: &str,
    self_version: &str,
    devices: Vec<DeviceStatus>,
    folder_errors: Vec<FolderError>,
    extras: StatusExtras,
) -> StatusPayload {
    let empty = StatusSnapshot::default();
    let snapshot = snapshot.unwrap_or(&empty);

    // 目录列表:抹掉 e2eKey 本体、补 e2eKeySet 与 gitRepo。
    let folders: Vec<Value> = config
        .shared_folders
        .iter()
        .map(|folder| {
            let mut value = serde_json::to_value(folder).unwrap_or(Value::Null);
            if let Value::Object(map) = &mut value {
                let has_key = map.remove("e2eKey").is_some();
                if has_key {
                    map.insert("e2eKeySet".to_string(), Value::Bool(true));
                }
                // 每轮实时探测:目录此刻是不是 git 仓库,与上次保存时无关
                map.insert(
                    "gitRepo".to_string(),
                    Value::Bool(is_git_repo(Path::new(&folder.path))),
                );
            }
            value
        })
        .collect();

    // 进度:带上 daemon 报告的每目录速率与文件明细
    let sync_progress: Vec<SyncProgress> = snapshot
        .folders
        .iter()
        .map(|folder| SyncProgress {
            folder: folder.id.clone(),
            pending: folder.progress.pending,
            sending: folder.progress.sending,
            receiving: folder.progress.receiving,
            send_rate: (folder.progress.send_rate > 0).then_some(folder.progress.send_rate),
            receive_rate: (folder.progress.receive_rate > 0).then_some(folder.progress.receive_rate),
            files: (!folder.progress.files.is_empty()).then(|| {
                folder
                    .progress
                    .files
                    .iter()
                    .map(|file| TransferFile {
                        path: file.path.clone(),
                        direction: file.direction.to_string(),
                        bytes_done: file.bytes_done,
                        bytes_total: file.bytes_total,
                        priority: file.priority.then_some(true),
                    })
                    .collect()
            }),
        })
        .collect();

    let offers: Vec<Value> = config
        .pending_offers
        .iter()
        .filter(|offer| offer.status != "accepted")
        .filter_map(|offer| serde_json::to_value(offer).ok())
        .collect();

    StatusPayload {
        device_id: device_id.to_string(),
        version: self_version.to_string(),
        platform: platform_name().to_string(),
        runtime: Some("rust"),
        update_source: Some("github"),
        folders,
        paused: config.is_paused(),
        entries: snapshot.total_entries,
        tombstones: snapshot.total_tombstones,
        devices,
        sync_progress,
        offers,
        folder_errors,
        update_available: None,
        relay_activity: None,
        conflict_counts: extras.conflict_counts,
        git_change_counts: extras.git_change_counts,
        git_unpushed_counts: extras.git_unpushed_counts,
        traffic: extras.traffic,
        hostname: extras
            .hostname
            .or_else(|| std::env::var("HOSTNAME").ok())
            .or_else(current_hostname),
        local_addresses: Some(extras.local_addresses.unwrap_or_else(lan_addresses)),
        config_dir: extras.config_dir,
        settings: extras.settings,
        discovered: extras.discovered,
        power_guard: extras.power_guard,
        network_online: extras.network_online.unwrap_or(true),
        schedule_states: extras.schedule_states,
        schedule_banner: extras.schedule_banner,
        calendar_status: extras.calendar_status,
    }
}

pub fn is_git_repo(path: &Path) -> bool {
    path.join(".git").exists()
}

pub fn platform_name() -> &'static str {
    std::env::consts::OS
}

fn current_hostname() -> Option<String> {
    // 不引入 hostname crate:环境变量已经覆盖绝大多数场景,取不到就不写该键,
    // 前端本来就把 hostname 当可选。
    std::env::var("COMPUTERNAME").ok()
}

/// 局域网 IPv4 地址(排除回环与链路本地)。多网卡则多条。
pub fn lan_addresses() -> Vec<String> {
    if_addrs::get_if_addrs()
        .map(|list| {
            list.into_iter()
                .filter(|iface| !iface.is_loopback())
                .filter_map(|iface| match iface.addr {
                    if_addrs::IfAddr::V4(v4) => Some(v4.ip.to_string()),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 状态快照的读取封装:HTTP 与 WS 共用同一份,避免两边各自解释。
#[derive(Clone)]
pub struct StatusSource {
    pub snapshot: Arc<Mutex<StatusSnapshot>>,
}

impl StatusSource {
    pub fn new(snapshot: Arc<Mutex<StatusSnapshot>>) -> Self {
        Self { snapshot }
    }

    pub fn read(&self) -> StatusSnapshot {
        self.snapshot
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }
}

impl std::fmt::Debug for StatusSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("StatusSource")
    }
}

/// 目录时段摘要文案(前端 tooltip 直接用)。
pub fn schedule_summary(schedule: Option<&Schedule>) -> String {
    format_schedule_summary(schedule)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{parse_config, SharedFolder};

    #[test]
    fn e2e_key_never_leaves_the_process() {
        let config = parse_config(
            r#"{"formatVersion":1,"sharedFolders":[
                 {"path":"/data/a","devices":[],"id":"a","e2eKey":{"kty":"oct","k":"c2VjcmV0"}}]}"#,
        )
        .unwrap();
        let payload = build_status(&config, None, "dev", "1.0.0", vec![], vec![], StatusExtras::default());
        let text = serde_json::to_string(&payload).unwrap();
        assert!(!text.contains("c2VjcmV0"), "e2e 密钥本体绝不出现在载荷里:{text}");
        assert!(!text.contains("e2eKey\""), "e2eKey 键本身也不写:{text}");
        assert!(text.contains("\"e2eKeySet\":true"));
    }

    #[test]
    fn git_repo_is_probed_per_call() {
        let dir = std::env::temp_dir().join(format!(
            "syncx-api-status-git-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let mut config = Config::new();
        config.shared_folders.push(SharedFolder {
            path: dir.to_string_lossy().to_string(),
            id: Some("f".to_string()),
            ..Default::default()
        });

        let payload = build_status(&config, None, "d", "1", vec![], vec![], StatusExtras::default());
        assert_eq!(payload.folders[0]["gitRepo"], Value::Bool(false));

        std::fs::create_dir_all(dir.join(".git")).unwrap();
        let payload = build_status(&config, None, "d", "1", vec![], vec![], StatusExtras::default());
        assert_eq!(payload.folders[0]["gitRepo"], Value::Bool(true), "必须实时探测,不能用缓存");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn idle_progress_omits_rates() {
        let mut snapshot = StatusSnapshot::default();
        snapshot.folders.push(syncx_daemon::actor::FolderStatus {
            id: "f".to_string(),
            path: "/x".to_string(),
            paused: false,
            receive_only: false,
            peers: 0,
            entries: 0,
            tombstones: 0,
            conflicts: 0,
            disk_blocked: None,
            progress: syncx_daemon::peer::Progress {
                pending: 0,
                sending: 0,
                receiving: 0,
                send_rate: 0,
                receive_rate: 0,
                files: Vec::new(),
            },
        });
        let payload = build_status(
            &Config::new(),
            Some(&snapshot),
            "d",
            "1",
            vec![],
            vec![],
            StatusExtras::default(),
        );
        let progress = &payload.sync_progress[0];
        assert_eq!(progress.send_rate, None, "空闲时不带速率键,快照保持最小");
        assert_eq!(progress.files, None);
    }

    #[test]
    fn accepted_offers_are_filtered() {
        let config = parse_config(
            r#"{"formatVersion":1,"pendingOffers":[
                 {"id":"a","kind":"folder","fromDeviceId":"d1","status":"pending"},
                 {"id":"b","kind":"folder","fromDeviceId":"d1","status":"accepted"}]}"#,
        )
        .unwrap();
        let payload = build_status(&config, None, "d", "1", vec![], vec![], StatusExtras::default());
        assert_eq!(payload.offers.len(), 1);
        assert_eq!(payload.offers[0]["id"], "a");
    }
}
