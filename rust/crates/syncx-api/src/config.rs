//! `config.json` 的读写。与 Node 侧 `src/config.ts` **同一份落盘契约**。
//!
//! 两条硬约束(见 docs/adr/0025 第 6 节):
//!
//!  1. **未知键必须原样保留**。两个后端共用同一数据目录,另一端可能写过本端不认识的键;
//!     `读 → 改 → 整体回写` 的路径若不铺开原对象,第一次改配置就把它们抹掉了。
//!  2. **格式代数闸门**。`formatVersion` 高于本端上限时拒绝启动,不降级读取。
//!
//! 读盘刻意做成 **Value 优先**而不是直接 `serde_json::from_str::<Config>`:
//! Node 侧对手改坏的字段是「逐个清洗回默认」,而强类型反序列化遇到 `"maxSendKbps": "2048"`
//! 或 `"schedule": "09:00-18:00"` 会整份失败。整份失败 → 退回默认配置 → 用户所有目录、
//! 设备、分享链接凭空消失。所以这里先取 `Value`,再逐字段清洗,坏字段只影响它自己。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use syncx_core::schedule::{normalize_schedule, Schedule};
use syncx_core::FORMAT_VERSION;

/// 本端支持的落盘代数。真值在 `syncx_core`(那里有一条测试直接读 Node 源码核对),
/// 两处各写一份常量早晚会漂。
pub const SUPPORTED_FORMAT_VERSION: u64 = FORMAT_VERSION;

/// 文件系统监听兜底全扫的缺省间隔(秒)。watcher 正常工作时,定时全扫退居兜底角色,
/// 不需要 5 秒一轮;600 秒与 Node 侧约定同值。
pub const DEFAULT_FS_WATCH_FALLBACK_SCAN_SECS: u64 = 600;

/// 一条共享目录配置。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SharedFolder {
    pub path: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub devices: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(rename = "maxBandwidthKbps", default, skip_serializing_if = "Option::is_none")]
    pub max_bandwidth_kbps: Option<u64>,
    #[serde(rename = "useGitignore", default, skip_serializing_if = "Option::is_none")]
    pub use_gitignore: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote: Option<bool>,
    #[serde(rename = "receiveOnly", default, skip_serializing_if = "Option::is_none")]
    pub receive_only: Option<bool>,
    #[serde(rename = "instanceId", default, skip_serializing_if = "Option::is_none")]
    pub instance_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paused: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule: Option<Schedule>,
    #[serde(rename = "gitSync", default, skip_serializing_if = "Option::is_none")]
    pub git_sync: Option<String>,
    /// 镜像自动提交时是否剔除提交信息里的 Co-Authored-By 行。缺省 `None` = 行为
    /// 不变(尾注原样保留);剔除只作用于本机落盘的镜像提交,转发给对端的
    /// 通知仍带着原始消息。
    #[serde(rename = "gitStripCoAuthored", default, skip_serializing_if = "Option::is_none")]
    pub git_strip_co_authored: Option<bool>,
    #[serde(rename = "conflictPolicy", default, skip_serializing_if = "Option::is_none")]
    pub conflict_policy: Option<String>,
    #[serde(rename = "onDemand", default, skip_serializing_if = "Option::is_none")]
    pub on_demand: Option<bool>,
    #[serde(rename = "onDemandDirs", default, skip_serializing_if = "Option::is_none")]
    pub on_demand_dirs: Option<Vec<String>>,
    #[serde(rename = "pausedFiles", default, skip_serializing_if = "Option::is_none")]
    pub paused_files: Option<Vec<String>>,
    /// 目录根身份指纹。**绝不能缺了就补**(2026-09-15 事故:补采集会把「盘未挂载」
    /// 当成「用户删光了」,成批广播删除)。这里只做透明往返,采集逻辑在 daemon 层。
    #[serde(rename = "folderIdentity", default, skip_serializing_if = "Option::is_none")]
    pub folder_identity: Option<Value>,
    #[serde(rename = "markerChecked", default, skip_serializing_if = "Option::is_none")]
    pub marker_checked: Option<bool>,
    #[serde(rename = "gitLastCommitHash", default, skip_serializing_if = "Option::is_none")]
    pub git_last_commit_hash: Option<String>,
    #[serde(rename = "gitRelayPending", default, skip_serializing_if = "Option::is_none")]
    pub git_relay_pending: Option<Value>,
    #[serde(rename = "gitBroadcastPending", default, skip_serializing_if = "Option::is_none")]
    pub git_broadcast_pending: Option<Value>,
    #[serde(rename = "e2eKey", default, skip_serializing_if = "Option::is_none")]
    pub e2e_key: Option<Value>,
    #[serde(rename = "e2eUntrusted", default, skip_serializing_if = "Option::is_none")]
    pub e2e_untrusted: Option<Vec<String>>,
    /// 只出站字段:出站载荷里用「已设置」替代密钥本体。落盘前清掉。
    #[serde(rename = "e2eKeySet", default, skip_serializing_if = "Option::is_none")]
    pub e2e_key_set: Option<bool>,
    /// 非持久化字段(每轮实时探测后补)。落盘前清掉。
    #[serde(rename = "gitRepo", default, skip_serializing_if = "Option::is_none")]
    pub git_repo: Option<bool>,

    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl SharedFolder {
    /// wire 标识:优先 `id`,缺省回退 `path`(与 Node `folderIdFor` 逐字一致)。
    pub fn folder_id(&self) -> String {
        self.id.clone().unwrap_or_else(|| self.path.clone())
    }

    /// 索引库/回收站/版本目录的命名键:优先 `instanceId`。
    ///
    /// 「索引寿命 = 目录实例寿命」是结构不变式:目录移除后重新添加必须打开一个全新空库,
    /// 否则旧墓碑会把对端文件成批删掉。
    pub fn index_key(&self) -> String {
        self.instance_id.clone().unwrap_or_else(|| self.folder_id())
    }

    pub fn is_receive_only(&self) -> bool {
        self.receive_only == Some(true)
    }

    pub fn is_paused(&self) -> bool {
        self.paused == Some(true)
    }

    pub fn use_gitignore_enabled(&self) -> bool {
        // 缺省 true = 遵循 .gitignore
        self.use_gitignore != Some(false)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DeviceConfig {
    pub id: String,
    /// 可选备注名,仅本机展示用。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PendingOffer {
    pub id: String,
    pub kind: String,
    #[serde(rename = "fromDeviceId")]
    pub from_device_id: String,
    #[serde(rename = "folderId", default, skip_serializing_if = "Option::is_none")]
    pub folder_id: Option<String>,
    #[serde(rename = "folderName", default, skip_serializing_if = "Option::is_none")]
    pub folder_name: Option<String>,
    #[serde(rename = "fromHostname", default, skip_serializing_if = "Option::is_none")]
    pub from_hostname: Option<String>,
    #[serde(rename = "fromIp", default, skip_serializing_if = "Option::is_none")]
    pub from_ip: Option<String>,
    #[serde(default = "default_offer_status")]
    pub status: String,
    #[serde(rename = "createdAt", default)]
    pub created_at: i64,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

fn default_offer_status() -> String {
    "pending".to_string()
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ShareRecord {
    pub id: String,
    #[serde(rename = "folderId")]
    pub folder_id: String,
    pub path: String,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "expiresAt")]
    pub expires_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub downloads: Option<u64>,
    #[serde(rename = "lastDownloadAt", default, skip_serializing_if = "Option::is_none")]
    pub last_download_at: Option<i64>,
}

/// 全局配置。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Config {
    #[serde(rename = "sharedFolders", default, skip_serializing_if = "Vec::is_empty")]
    pub shared_folders: Vec<SharedFolder>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub peers: Vec<String>,
    #[serde(rename = "knownDevices", default, skip_serializing_if = "Vec::is_empty")]
    pub known_devices: Vec<DeviceConfig>,
    #[serde(rename = "pendingOffers", default, skip_serializing_if = "Vec::is_empty")]
    pub pending_offers: Vec<PendingOffer>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paused: Option<bool>,
    #[serde(rename = "shareEnabled", default, skip_serializing_if = "Option::is_none")]
    pub share_enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shares: Option<Vec<ShareRecord>>,
    #[serde(rename = "maxSendKbps", default, skip_serializing_if = "Option::is_none")]
    pub max_send_kbps: Option<u64>,
    #[serde(rename = "versionsPerPath", default, skip_serializing_if = "Option::is_none")]
    pub versions_per_path: Option<u64>,
    #[serde(rename = "historyMaxEvents", default, skip_serializing_if = "Option::is_none")]
    pub history_max_events: Option<u64>,
    #[serde(rename = "webhookUrl", default, skip_serializing_if = "Option::is_none")]
    pub webhook_url: Option<String>,
    #[serde(rename = "webhookSecret", default, skip_serializing_if = "Option::is_none")]
    pub webhook_secret: Option<String>,
    #[serde(rename = "pauseOnMeteredNetwork", default, skip_serializing_if = "Option::is_none")]
    pub pause_on_metered_network: Option<bool>,
    #[serde(rename = "pauseOnLowBattery", default, skip_serializing_if = "Option::is_none")]
    pub pause_on_low_battery: Option<bool>,
    #[serde(rename = "batteryPauseThreshold", default, skip_serializing_if = "Option::is_none")]
    pub battery_pause_threshold: Option<u64>,
    #[serde(rename = "syncSchedule", default, skip_serializing_if = "Option::is_none")]
    pub sync_schedule: Option<Schedule>,
    #[serde(rename = "scheduleOverrideUntil", default, skip_serializing_if = "Option::is_none")]
    pub schedule_override_until: Option<i64>,
    #[serde(rename = "holidayAutoFetch", default, skip_serializing_if = "Option::is_none")]
    pub holiday_auto_fetch: Option<bool>,
    #[serde(rename = "holidaySourceUrl", default, skip_serializing_if = "Option::is_none")]
    pub holiday_source_url: Option<String>,
    /// 文件系统监听开关:缺省开,只有显式 `false` 才落盘为关。
    /// 字段先就绪,设置弹窗(web 侧)另行处理。
    #[serde(rename = "fsWatchEnabled", default, skip_serializing_if = "Option::is_none")]
    pub fs_watch_enabled: Option<bool>,
    /// watcher 健康时的定时兜底全扫间隔(秒);缺省 600。watcher 降级时退回原有
    /// 扫描间隔,不走这个值。
    #[serde(rename = "fsWatchFallbackScanSecs", default, skip_serializing_if = "Option::is_none")]
    pub fs_watch_fallback_scan_secs: Option<u64>,
    #[serde(rename = "calendarOverrides", default, skip_serializing_if = "Option::is_none")]
    pub calendar_overrides: Option<BTreeMap<String, String>>,
    #[serde(rename = "formatVersion")]
    pub format_version: u64,
    #[serde(rename = "generatedBy", default, skip_serializing_if = "Option::is_none")]
    pub generated_by: Option<String>,

    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Config {
    pub fn new() -> Self {
        Self {
            format_version: SUPPORTED_FORMAT_VERSION,
            ..Default::default()
        }
    }

    pub fn folder(&self, folder_id: &str) -> Option<&SharedFolder> {
        self.shared_folders.iter().find(|f| f.folder_id() == folder_id)
    }

    pub fn folder_mut(&mut self, folder_id: &str) -> Option<&mut SharedFolder> {
        self.shared_folders
            .iter_mut()
            .find(|f| f.folder_id() == folder_id)
    }

    /// 全局暂停的权威口径:`paused === true`(缺省/其它值都算未暂停)。
    pub fn is_paused(&self) -> bool {
        self.paused == Some(true)
    }

    pub fn share_enabled(&self) -> bool {
        self.share_enabled == Some(true)
    }

    pub fn versions_per_path(&self) -> u64 {
        self.versions_per_path.unwrap_or(10)
    }

    pub fn history_max_events(&self) -> u64 {
        self.history_max_events.unwrap_or(2000)
    }

    pub fn battery_pause_threshold(&self) -> u64 {
        self.battery_pause_threshold.unwrap_or(20)
    }

    /// 文件系统监听开关:缺省开,显式 `false` 才关(与 `holidayAutoFetch` 同口径)。
    pub fn fs_watch_enabled(&self) -> bool {
        self.fs_watch_enabled != Some(false)
    }

    /// watcher 健康时的定时兜底全扫间隔(秒)。
    pub fn fs_watch_fallback_scan_secs(&self) -> u64 {
        self.fs_watch_fallback_scan_secs
            .unwrap_or(DEFAULT_FS_WATCH_FALLBACK_SCAN_SECS)
    }
}

/// 数据目录由更新版本生成。CLI/启动路径捕获后打印指引并非零退出。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FormatVersionError {
    pub found: u64,
    pub supported: u64,
}

impl std::fmt::Display for FormatVersionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "数据目录由更新版本生成(formatVersion {}(本版本最高支持 {}))。\n请升级 syncx 后再运行;降级运行会损坏索引数据。",
            self.found, self.supported
        )
    }
}

impl std::error::Error for FormatVersionError {}

/// 闸门。缺失(本字段引入前的配置)按第 1 代处理 —— 那是合法值,不是脏数据。
pub fn assert_format_version(config: &Config) -> Result<(), FormatVersionError> {
    let found = if config.format_version == 0 {
        1
    } else {
        config.format_version
    };
    if found > SUPPORTED_FORMAT_VERSION {
        return Err(FormatVersionError {
            found,
            supported: SUPPORTED_FORMAT_VERSION,
        });
    }
    Ok(())
}

/// 配置读写:所有对 `config.json` 的访问都从这里走。
///
/// 不做内存缓存:配置会被 CLI 进程同时改,缓存会让「CLI 加了个目录、daemon 看不见」
/// 变成常态。代价是每次 API 调用读一次盘 —— 文件小,可接受。
#[derive(Debug, Clone)]
pub struct ConfigStore {
    path: PathBuf,
}

impl ConfigStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 数据目录 = 配置文件所在目录。
    pub fn config_dir(&self) -> PathBuf {
        self.path.parent().unwrap_or(Path::new(".")).to_path_buf()
    }

    pub fn load(&self) -> Config {
        let raw = match std::fs::read_to_string(&self.path) {
            Ok(raw) => raw,
            Err(_) => return Config::new(),
        };
        parse_config(&raw).unwrap_or_else(|error| {
            tracing::warn!(%error, path = %self.path.display(), "config.json 解析失败,按默认配置处理");
            Config::new()
        })
    }

    /// 原子写:先写临时文件再 rename,避免并发读者读到半截 JSON。
    pub fn save(&self, config: &Config) -> std::io::Result<()> {
        let mut stamped = config.clone();
        stamped.format_version = SUPPORTED_FORMAT_VERSION;
        stamped.generated_by = Some(syncx_core::version_string().to_string());
        // 落盘前清掉「只出站 / 非持久化」字段:它们由 buildStatus 每轮补,存进配置
        // 会让下一次读盘把它们当成用户设置的真值。
        for folder in &mut stamped.shared_folders {
            folder.e2e_key_set = None;
            folder.git_repo = None;
        }
        let body = serde_json::to_string_pretty(&stamped)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, body)?;
        std::fs::rename(&tmp, &self.path)
    }

    /// 「加载 → 修改 → 保存」为一个临界区。`mutator` 返回 `false` = 无改动、跳过落盘。
    pub fn mutate<F, E>(&self, mutator: F) -> Result<Config, E>
    where
        F: FnOnce(&mut Config) -> Result<bool, E>,
        E: From<std::io::Error>,
    {
        let _guard = self.lock().map_err(E::from)?;
        let mut config = self.load();
        if mutator(&mut config)? {
            self.save(&config).map_err(E::from)?;
        }
        Ok(config)
    }

    /// 跨进程配置锁。与 Node 侧同一套语义:排他创建锁文件,持有者崩溃遗留的陈旧锁
    /// (超过 30s)被回收。临界区只有「读盘 + 改 + 写盘」,争用罕见。
    fn lock(&self) -> Result<ConfigLock, std::io::Error> {
        let lock_path = self.path.with_extension("json.lock");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&lock_path)
            {
                Ok(_) => return Ok(ConfigLock { path: lock_path }),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    if let Ok(meta) = std::fs::metadata(&lock_path) {
                        if let Ok(modified) = meta.modified() {
                            if modified.elapsed().map(|d| d.as_secs() > 30).unwrap_or(false) {
                                let _ = std::fs::remove_file(&lock_path);
                                continue;
                            }
                        }
                    }
                    if std::time::Instant::now() > deadline {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::TimedOut,
                            format!("acquire config lock timeout: {}", self.path.display()),
                        ));
                    }
                    std::thread::sleep(std::time::Duration::from_millis(2));
                }
                Err(error) => return Err(error),
            }
        }
    }
}

struct ConfigLock {
    path: PathBuf,
}

impl Drop for ConfigLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// 解析 + 逐字段清洗。未知键原样进 `extra`。
pub fn parse_config(raw: &str) -> Result<Config, serde_json::Error> {
    let value: Value = serde_json::from_str(raw)?;
    let Value::Object(mut object) = value else {
        return Ok(Config::new());
    };

    let mut config = Config::new();
    config.format_version = take(&mut object, "formatVersion")
        .into_u64_or(1);
    config.generated_by = string_of(object.remove("generatedBy"));
    config.shared_folders = array_of(object.remove("sharedFolders"))
        .into_iter()
        .filter_map(parse_shared_folder)
        .collect();
    config.peers = normalize_peer_list(&string_array(object.remove("peers")));
    config.known_devices = array_of(object.remove("knownDevices"))
        .into_iter()
        .filter_map(parse_device)
        .collect();
    config.pending_offers = array_of(object.remove("pendingOffers"))
        .into_iter()
        .filter_map(parse_offer)
        .collect();
    // 布尔开关一律只认 `true`(缺省/false 都不落),与 Node `=== true ? true : undefined` 同口径
    config.paused = true_only(object.remove("paused"));
    config.share_enabled = true_only(object.remove("shareEnabled"));
    config.pause_on_metered_network = true_only(object.remove("pauseOnMeteredNetwork"));
    config.pause_on_low_battery = true_only(object.remove("pauseOnLowBattery"));
    // 自动拉取默认开:只有显式 false 才关
    config.holiday_auto_fetch = false_only(object.remove("holidayAutoFetch"));
    config.fs_watch_enabled = false_only(object.remove("fsWatchEnabled"));
    config.fs_watch_fallback_scan_secs = count_of(object.remove("fsWatchFallbackScanSecs"), 10);
    config.shares = sanitize_shares(object.remove("shares"));
    config.max_send_kbps = count_of(object.remove("maxSendKbps"), 0);
    config.versions_per_path = count_of(object.remove("versionsPerPath"), 1);
    config.history_max_events = count_of(object.remove("historyMaxEvents"), 1);
    config.webhook_url = webhook_string(object.remove("webhookUrl"), 500);
    config.webhook_secret = webhook_string(object.remove("webhookSecret"), 200);
    config.battery_pause_threshold = percent_of(object.remove("batteryPauseThreshold"));
    config.sync_schedule = object
        .remove("syncSchedule")
        .and_then(|v| normalize_schedule(&v));
    config.schedule_override_until = object
        .remove("scheduleOverrideUntil")
        .and_then(|v| v.as_i64())
        .filter(|n| *n > 0);
    config.holiday_source_url = match object.remove("holidaySourceUrl") {
        Some(Value::String(s)) if s.contains("{year}") && s.chars().count() <= 300 => {
            Some(s.trim().to_string()).filter(|t| !t.is_empty())
        }
        _ => None,
    };
    config.calendar_overrides = sanitize_calendar_overrides(object.remove("calendarOverrides"));

    config.extra = object;
    Ok(config)
}

fn take(object: &mut Map<String, Value>, key: &str) -> Value {
    object.remove(key).unwrap_or(Value::Null)
}

trait AsU64Or {
    fn into_u64_or(self, fallback: u64) -> u64;
}

impl AsU64Or for Value {
    fn into_u64_or(self, fallback: u64) -> u64 {
        match self {
            Value::Number(n) => n
                .as_u64()
                .or_else(|| n.as_f64().map(|f| f.floor() as u64))
                .unwrap_or(fallback),
            _ => fallback,
        }
    }
}

fn string_of(value: Option<Value>) -> Option<String> {
    match value {
        Some(Value::String(s)) if !s.is_empty() => Some(s),
        _ => None,
    }
}

fn string_array(value: Option<Value>) -> Vec<String> {
    match value {
        Some(Value::Array(items)) => items
            .into_iter()
            .filter_map(|v| match v {
                Value::String(s) => Some(s),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn array_of(value: Option<Value>) -> Vec<Value> {
    match value {
        Some(Value::Array(items)) => items,
        _ => Vec::new(),
    }
}

fn true_only(value: Option<Value>) -> Option<bool> {
    matches!(value, Some(Value::Bool(true))).then_some(true)
}

fn false_only(value: Option<Value>) -> Option<bool> {
    matches!(value, Some(Value::Bool(false))).then_some(false)
}

/// 清洗一个「非负整数」配置值:非法(负数/非数)返回 None;0 保留(0 = 不限速语义)。
fn count_of(value: Option<Value>, min: u64) -> Option<u64> {
    let n = match value {
        Some(Value::Number(n)) => n.as_f64()?,
        _ => return None,
    };
    if !n.is_finite() || n < 0.0 {
        return None;
    }
    let n = n.floor() as u64;
    (n >= min).then_some(n)
}

/// 百分比阈值:只认 1..=99 的整数。
fn percent_of(value: Option<Value>) -> Option<u64> {
    count_of(value, 1).filter(|n| *n <= 99)
}

fn webhook_string(value: Option<Value>, max_len: usize) -> Option<String> {
    match value {
        Some(Value::String(s)) => {
            let trimmed = s.trim();
            (!trimmed.is_empty() && trimmed.chars().count() <= max_len).then(|| trimmed.to_string())
        }
        _ => None,
    }
}

/// 清洗手动日历覆盖:只留合法日期与合法身份,条数截断到 400。
fn sanitize_calendar_overrides(value: Option<Value>) -> Option<BTreeMap<String, String>> {
    let Some(Value::Object(map)) = value else {
        return None;
    };
    let mut out = BTreeMap::new();
    for (key, value) in map {
        if out.len() >= 400 {
            break;
        }
        if !is_real_date_key(&key) {
            continue;
        }
        let Value::String(kind) = value else { continue };
        if kind != "workday" && kind != "holiday" {
            continue;
        }
        out.insert(key, kind);
    }
    (!out.is_empty()).then_some(out)
}

/// 清洗分享记录:字段完整、时间可解释的条目才留;超 500 条从尾部截断。
fn sanitize_shares(value: Option<Value>) -> Option<Vec<ShareRecord>> {
    let Value::Array(items) = value? else {
        return None;
    };
    let out: Vec<ShareRecord> = items
        .into_iter()
        .filter_map(|item| {
            let Value::Object(mut object) = item else {
                return None;
            };
            let id = non_empty_str(object.remove("id"))?;
            let folder_id = non_empty_str(object.remove("folderId"))?;
            let path = non_empty_str(object.remove("path"))?;
            let created_at = object.remove("createdAt")?.as_i64()?;
            let expires_at = object.remove("expiresAt")?.as_i64()?;
            if expires_at <= created_at {
                return None;
            }
            Some(ShareRecord {
                id,
                folder_id,
                path,
                created_at,
                expires_at,
                downloads: object.remove("downloads").and_then(|v| v.as_u64()),
                last_download_at: object.remove("lastDownloadAt").and_then(|v| v.as_i64()),
            })
        })
        .take(500)
        .collect();
    (!out.is_empty()).then_some(out)
}

fn non_empty_str(value: Option<Value>) -> Option<String> {
    match value {
        Some(Value::String(s)) if !s.is_empty() => Some(s),
        _ => None,
    }
}

/// 单条共享目录。`path` 缺失/非字符串整条丢弃 —— 没有 path 的目录无法参与同步,
/// 留着一个空壳只会让 UI 出现点不开的卡片。
fn parse_shared_folder(value: Value) -> Option<SharedFolder> {
    let Value::Object(mut object) = value else {
        return None;
    };
    let path = match object.remove("path") {
        Some(Value::String(s)) if !s.is_empty() => s,
        _ => return None,
    };
    let devices = string_array(object.remove("devices"));
    let schedule = object
        .remove("schedule")
        .and_then(|v| normalize_schedule(&v));
    let folder = SharedFolder {
        path,
        devices,
        id: non_empty_str(object.remove("id")),
        max_bandwidth_kbps: count_of(object.remove("maxBandwidthKbps"), 0),
        use_gitignore: bool_of(object.remove("useGitignore")),
        remote: bool_of(object.remove("remote")),
        receive_only: true_only(object.remove("receiveOnly")),
        instance_id: non_empty_str(object.remove("instanceId")),
        paused: bool_of(object.remove("paused")),
        schedule,
        git_sync: non_empty_str(object.remove("gitSync")),
        git_strip_co_authored: bool_of(object.remove("gitStripCoAuthored")),
        conflict_policy: non_empty_str(object.remove("conflictPolicy")),
        on_demand: bool_of(object.remove("onDemand")),
        on_demand_dirs: object.remove("onDemandDirs").map(string_array_value),
        paused_files: object.remove("pausedFiles").map(string_array_value),
        folder_identity: object.remove("folderIdentity"),
        marker_checked: bool_of(object.remove("markerChecked")),
        git_last_commit_hash: non_empty_str(object.remove("gitLastCommitHash")),
        git_relay_pending: object.remove("gitRelayPending"),
        git_broadcast_pending: object.remove("gitBroadcastPending"),
        e2e_key: object.remove("e2eKey"),
        e2e_untrusted: object.remove("e2eUntrusted").map(string_array_value),
        e2e_key_set: None,
        git_repo: None,
        extra: object,
    };
    Some(folder)
}

fn string_array_value(value: Value) -> Vec<String> {
    match value {
        Value::Array(items) => items
            .into_iter()
            .filter_map(|v| match v {
                Value::String(s) => Some(s),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn bool_of(value: Option<Value>) -> Option<bool> {
    match value {
        Some(Value::Bool(b)) => Some(b),
        _ => None,
    }
}

fn parse_device(value: Value) -> Option<DeviceConfig> {
    let Value::Object(mut object) = value else {
        return None;
    };
    let id = non_empty_str(object.remove("id"))?;
    let name = non_empty_str(object.remove("name"));
    Some(DeviceConfig {
        id,
        name,
        extra: object,
    })
}

fn parse_offer(value: Value) -> Option<PendingOffer> {
    let Value::Object(mut object) = value else {
        return None;
    };
    let id = non_empty_str(object.remove("id"))?;
    let kind = non_empty_str(object.remove("kind")).unwrap_or_else(|| "folder".to_string());
    let from_device_id = non_empty_str(object.remove("fromDeviceId")).unwrap_or_default();
    Some(PendingOffer {
        id,
        kind,
        from_device_id,
        folder_id: non_empty_str(object.remove("folderId")),
        folder_name: non_empty_str(object.remove("folderName")),
        from_hostname: non_empty_str(object.remove("fromHostname")),
        from_ip: non_empty_str(object.remove("fromIp")),
        status: non_empty_str(object.remove("status")).unwrap_or_else(default_offer_status),
        created_at: object.remove("createdAt").and_then(|v| v.as_i64()).unwrap_or(0),
        extra: object,
    })
}

/// `YYYY-MM-DD` 且是真实存在的日期。
fn is_real_date_key(key: &str) -> bool {
    let bytes = key.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return false;
    }
    let (Ok(year), Ok(month), Ok(day)) = (
        key[0..4].parse::<i32>(),
        key[5..7].parse::<u32>(),
        key[8..10].parse::<u32>(),
    ) else {
        return false;
    };
    if !(1970..=2100).contains(&year) || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return false;
    }
    day <= days_in_month(year, month)
}

fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 {
                29
            } else {
                28
            }
        }
        _ => 0,
    }
}

/// 规范化对端地址:剥离 IPv4-mapped IPv6 前缀、host 小写,IPv6 保留方括号。
///
/// 不归一的话同一对端会在 `peers` 里留下 `ws://[::ffff:10.0.0.2]:22000` 与
/// `ws://10.0.0.2:22000` 两条等价记录,互相连接时被当成两台设备。
pub fn normalize_peer_url(address: &str) -> String {
    let lower = address.to_ascii_lowercase();
    let Some(rest) = lower.strip_prefix("ws://") else {
        return address.to_string();
    };
    let (host_raw, port) = if let Some(stripped) = rest.strip_prefix('[') {
        let Some((host, tail)) = stripped.split_once(']') else {
            return address.to_string();
        };
        let Some(port) = tail.strip_prefix(':') else {
            return address.to_string();
        };
        (host.to_string(), port.to_string())
    } else {
        let Some((host, port)) = rest.rsplit_once(':') else {
            return address.to_string();
        };
        if host.contains(':') {
            return address.to_string();
        }
        (host.to_string(), port.to_string())
    };
    if port.is_empty() || !port.bytes().all(|b| b.is_ascii_digit()) {
        return address.to_string();
    }
    let host = host_raw.strip_prefix("::ffff:").unwrap_or(&host_raw).to_string();
    if host.contains(':') {
        format!("ws://[{host}]:{port}")
    } else {
        format!("ws://{host}:{port}")
    }
}

pub fn normalize_peer_list(peers: &[String]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for peer in peers {
        if peer.is_empty() {
            continue;
        }
        let normalized = normalize_peer_url(peer);
        if seen.insert(normalized.clone()) {
            out.push(normalized);
        }
    }
    out
}

/// 目录索引库路径:`<configDir>/index-<sha1(index_key) 前 16 位>.db`。
///
/// **必须与 Node 的 `folderIndexPath` 逐字一致**,否则换后端就等于换了一个空索引库,
/// 旧条目全被判成「本地新增/删除」并广播出去 —— 这正是 2026-09-15 事故的形态。
/// 用哈希而不是直接拼 id:单机目录的 `folderId` 缺省就是绝对路径,直接拼文件名会撞上
/// 分隔符与长度上限。
pub fn folder_index_path(config_dir: &Path, folder: &SharedFolder) -> PathBuf {
    config_dir.join(format!("index-{}.db", short_hash(&folder.index_key())))
}

/// 删除回收站目录:`<configDir>/trash/<hash>`。与索引库同 key、同哈希。
pub fn folder_trash_path(config_dir: &Path, folder: &SharedFolder) -> PathBuf {
    config_dir.join("trash").join(short_hash(&folder.index_key()))
}

/// 文件版本目录:`<configDir>/versions/<hash>`。
pub fn folder_versions_path(config_dir: &Path, folder: &SharedFolder) -> PathBuf {
    config_dir.join("versions").join(short_hash(&folder.index_key()))
}

/// sha1(key) 的十六进制前 16 位。
pub fn short_hash(key: &str) -> String {
    use sha1::{Digest, Sha1};
    let digest = Sha1::digest(key.as_bytes());
    hex::encode(digest)[..16].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "syncx-api-config-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn unknown_keys_survive_mutation() {
        let dir = temp_dir("unknown");
        let path = dir.join("config.json");
        std::fs::write(
            &path,
            r#"{"sharedFolders":[],"formatVersion":1,"futureKnob":{"nested":true}}"#,
        )
        .unwrap();
        let store = ConfigStore::new(&path);
        store
            .mutate(|config| {
                config.max_send_kbps = Some(2048);
                Ok::<_, std::io::Error>(true)
            })
            .unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("futureKnob"), "未知键必须原样保留:{raw}");
        assert!(raw.contains("\"nested\": true"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn one_bad_field_does_not_lose_the_rest() {
        // 一条坏字段不能拖垮整份配置 —— 这是 Node 侧 loadConfig 的核心行为
        let config = parse_config(
            r#"{"sharedFolders":[{"path":"/data/a","devices":["d1"]}],
                "formatVersion":1,"batteryPauseThreshold":"99","maxSendKbps":-5,
                "paused":"yes","webhookUrl":123}"#,
        )
        .unwrap();
        assert_eq!(config.shared_folders.len(), 1);
        assert_eq!(config.shared_folders[0].path, "/data/a");
        assert_eq!(config.battery_pause_threshold, None);
        assert_eq!(config.max_send_kbps, None);
        assert_eq!(config.paused, None);
        assert_eq!(config.webhook_url, None);
        // 坏字段仍然原样留在 extra 里(它们是从对象里被 take 走的,所以不在;
        // 但同步时不能因此丢失 —— 这里断言的是「不消失成整份默认」)
        assert_eq!(config.format_version, 1);
    }

    #[test]
    fn legacy_schedule_string_migrates_to_rules() {
        let config = parse_config(
            r#"{"formatVersion":1,"syncSchedule":"09:00-18:00",
                "sharedFolders":[{"path":"/a","devices":[],"schedule":"22:00-06:00"}]}"#,
        )
        .unwrap();
        let global = config.sync_schedule.expect("旧字符串形态应迁移成规则");
        assert_eq!(global.len(), 1);
        let folder = &config.shared_folders[0];
        assert!(folder.schedule.is_some());
    }

    #[test]
    fn fs_watch_fields_default_on_with_configurable_fallback() {
        // 缺省:监听开,兜底 600 秒
        let config = parse_config(r#"{"formatVersion":1}"#).unwrap();
        assert!(config.fs_watch_enabled());
        assert_eq!(config.fs_watch_fallback_scan_secs(), 600);

        // 显式 false 才关;兜底间隔接受配置值
        let config = parse_config(
            r#"{"formatVersion":1,"fsWatchEnabled":false,"fsWatchFallbackScanSecs":300}"#,
        )
        .unwrap();
        assert!(!config.fs_watch_enabled());
        assert_eq!(config.fs_watch_fallback_scan_secs(), 300);

        // 低于下限(10s)的间隔按缺省处理:高频兜底全扫失去「兜底」本意
        let config =
            parse_config(r#"{"formatVersion":1,"fsWatchFallbackScanSecs":3}"#).unwrap();
        assert_eq!(config.fs_watch_fallback_scan_secs, None);
        assert_eq!(config.fs_watch_fallback_scan_secs(), 600);
    }

    #[test]
    fn format_version_gate_rejects_newer() {
        let mut config = Config::new();
        config.format_version = SUPPORTED_FORMAT_VERSION + 1;
        assert!(assert_format_version(&config).is_err());
        config.format_version = 0; // 缺失按第 1 代
        assert!(assert_format_version(&config).is_ok());
    }

    #[test]
    fn peer_url_normalization() {
        assert_eq!(
            normalize_peer_url("ws://[::ffff:10.0.0.2]:22000"),
            "ws://10.0.0.2:22000"
        );
        assert_eq!(normalize_peer_url("ws://Host:1"), "ws://host:1");
        assert_eq!(normalize_peer_url("ws://[fe80::1]:2"), "ws://[fe80::1]:2");
        // 重复等价条目应合并
        let merged = normalize_peer_list(&[
            "ws://[::ffff:10.0.0.2]:22000".to_string(),
            "ws://10.0.0.2:22000".to_string(),
        ]);
        assert_eq!(merged, vec!["ws://10.0.0.2:22000".to_string()]);
    }

    #[test]
    fn folder_id_falls_back_to_path() {
        let folder = SharedFolder {
            path: "/data/a".to_string(),
            ..Default::default()
        };
        assert_eq!(folder.folder_id(), "/data/a");
        let folder = SharedFolder {
            id: Some("share".to_string()),
            instance_id: Some("inst".to_string()),
            ..Default::default()
        };
        assert_eq!(folder.folder_id(), "share");
        assert_eq!(folder.index_key(), "inst");
    }

    #[test]
    fn git_strip_co_authored_round_trip() {
        // 新字段按 camelCase 序列化,true/false 都能读回来
        let config = parse_config(
            r#"{"formatVersion":1,"sharedFolders":[
                {"path":"/a","gitStripCoAuthored":true},
                {"path":"/b","gitStripCoAuthored":false}]}"#,
        )
        .unwrap();
        assert_eq!(config.shared_folders[0].git_strip_co_authored, Some(true));
        assert_eq!(config.shared_folders[1].git_strip_co_authored, Some(false));
        let raw = serde_json::to_string(&config).unwrap();
        assert!(raw.contains("\"gitStripCoAuthored\":true"), "{raw}");
        assert!(raw.contains("\"gitStripCoAuthored\":false"), "{raw}");

        // 旧 JSON 没有该字段:读成 None,回写时也不出现这个键(缺省 = 行为不变)
        let config = parse_config(
            r#"{"formatVersion":1,"sharedFolders":[{"path":"/a","devices":["d1"]}]}"#,
        )
        .unwrap();
        let folder = &config.shared_folders[0];
        assert_eq!(folder.git_strip_co_authored, None);
        assert!(!serde_json::to_string(&config)
            .unwrap()
            .contains("gitStripCoAuthored"));
    }

    #[test]
    fn git_strip_co_authored_unknown_folder_keys_survive() {
        // 新旧两端共用 config.json:开启新开关回写时,本端不认识的旧键必须原样保留
        let config = parse_config(
            r#"{"formatVersion":1,"sharedFolders":[
                {"path":"/a","gitStripCoAuthored":true,"futureFolderKnob":{"x":1}}]}"#,
        )
        .unwrap();
        assert_eq!(config.shared_folders[0].git_strip_co_authored, Some(true));
        let raw = serde_json::to_string(&config).unwrap();
        assert!(raw.contains("futureFolderKnob"), "{raw}");
        assert!(raw.contains("\"gitStripCoAuthored\":true"), "{raw}");
    }
}
