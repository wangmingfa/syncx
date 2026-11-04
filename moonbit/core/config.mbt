///|
/// `config.json` 的读写模型(与 Node `src/config.ts`、Rust `syncx-api/src/config.rs`
/// 同一份落盘契约)。两条硬约束:
///
///  1. **未知键必须原样保留**:另一端可能写过本端不认识的键;读 → 改 → 整体回写
///     若不铺开原对象,第一次改配置就把它们抹掉了。
///  2. **逐字段清洗**:强类型解析遇 `"maxSendKbps": "2048"` 会整份失败 → 退回默认
///     → 用户目录/设备凭空消失。这里先取 Json,再逐字段清洗,坏字段只影响它自己。
///
/// 本包无 I/O:只做 parse/serialize/闸门;文件访问(ConfigStore,含锁与原子写)
/// 在 daemon 层。

///|
/// 一条共享目录配置。`extra` 承载本端不认识的键(原样往返)。
pub(all) struct SharedFolder {
  path : String
  devices : Array[String]
  id : String?
  /// maxBandwidthKbps
  max_bandwidth_kbps : Int32?
  /// useGitignore;缺省 true = 遵循 .gitignore
  use_gitignore : Bool?
  remote : Bool?
  /// receiveOnly
  receive_only : Bool?
  /// instanceId;索引寿命 = 目录实例寿命,目录重加必须开全新空库
  instance_id : String?
  mut paused : Bool?
  /// 时段规则;core 层只透传不解释,判定在 daemon(与 Node/Rust 的 normalize
  /// 行为对齐的时机在 daemon 里程碑)
  schedule : Json?
  /// gitSync
  git_sync : String?
  /// conflictPolicy
  conflict_policy : String?
  /// gitStripCoAuthored:镜像提交时剔除 Co-Authored-By 尾注行(缺省 false = 行为不变)
  strip_co_authored : Bool?
  /// onDemand
  on_demand : Bool?
  /// onDemandDirs
  on_demand_dirs : Array[String]?
  /// pausedFiles
  paused_files : Array[String]?
  /// folderIdentity;目录根身份指纹,绝不能缺了就补(2026-09-15 事故)
  folder_identity : Json?
  /// markerChecked
  marker_checked : Bool?
  /// gitLastCommitHash
  git_last_commit_hash : String?
  /// gitRelayPending
  git_relay_pending : Json?
  /// gitBroadcastPending
  git_broadcast_pending : Json?
  /// e2eKey
  e2e_key : Json?
  /// e2eUntrusted
  e2e_untrusted : Array[String]?
  mut extra : Map[String, Json]
}

///|
pub fn SharedFolder::folder_id(self : SharedFolder) -> String {
  match self.id {
    Some(id) => id
    None => self.path
  }
}

///|
/// 索引库/回收站/版本目录的命名键:优先 `instanceId`。
pub fn SharedFolder::index_key(self : SharedFolder) -> String {
  match self.instance_id {
    Some(id) => id
    None => self.folder_id()
  }
}

///|
pub fn SharedFolder::is_receive_only(self : SharedFolder) -> Bool {
  self.receive_only == Some(true)
}

///|
pub fn SharedFolder::is_paused(self : SharedFolder) -> Bool {
  self.paused == Some(true)
}

///|
pub fn SharedFolder::use_gitignore_enabled(self : SharedFolder) -> Bool {
  self.use_gitignore != Some(false)
}

///|
/// 一台已知设备。`extra` 同上,原样往返。
pub(all) struct DeviceConfig {
  id : String
  name : String?
  mut extra : Map[String, Json]
}

///|
/// 一条待处理邀请。
pub(all) struct PendingOffer {
  id : String
  kind : String
  /// fromDeviceId
  from_device_id : String
  /// folderId
  folder_id : String?
  /// folderName
  folder_name : String?
  /// fromHostname
  from_hostname : String?
  /// fromIp
  from_ip : String?
  status : String
  /// createdAt
  created_at : Int32
  mut extra : Map[String, Json]
}

///|
/// 一条分享记录。
pub(all) struct ShareRecord {
  id : String
  /// folderId
  folder_id : String
  path : String
  /// createdAt
  created_at : Int32
  /// expiresAt
  expires_at : Int32
  downloads : Int32?
  /// lastDownloadAt
  last_download_at : Int32?
}

///|
/// 全局配置。`extra` 承载未知键。
pub(all) struct Config {
  /// sharedFolders
  mut shared_folders : Array[SharedFolder]
  mut peers : Array[String]
  /// knownDevices
  mut known_devices : Array[DeviceConfig]
  /// pendingOffers
  mut pending_offers : Array[PendingOffer]
  mut paused : Bool?
  /// shareEnabled
  mut share_enabled : Bool?
  mut shares : Array[ShareRecord]?
  /// maxSendKbps
  mut max_send_kbps : Int32?
  /// versionsPerPath
  mut versions_per_path : Int32?
  /// historyMaxEvents
  mut history_max_events : Int32?
  /// webhookUrl
  mut webhook_url : String?
  /// webhookSecret
  mut webhook_secret : String?
  /// pauseOnMeteredNetwork
  mut pause_on_metered_network : Bool?
  /// pauseOnLowBattery
  mut pause_on_low_battery : Bool?
  /// batteryPauseThreshold
  mut battery_pause_threshold : Int32?
  /// syncSchedule(透传,同 SharedFolder.schedule)
  mut sync_schedule : Json?
  /// scheduleOverrideUntil
  mut schedule_override_until : Int32?
  /// holidayAutoFetch
  mut holiday_auto_fetch : Bool?
  /// holidaySourceUrl
  mut holiday_source_url : String?
  /// calendarOverrides
  mut calendar_overrides : Map[String, String]?
  /// fsWatchEnabled:文件系统监听驱动的增量扫描(缺省开;显式 false 才关,
  /// 与 holidayAutoFetch 同口径 —— 布尔开关只落显式痕迹,不写 true)
  mut fs_watch_enabled : Bool?
  /// fsWatchFallbackScanSecs:watcher 正常时的兜底全扫间隔秒(缺省 600;
  /// watcher 创建失败/不可用时退回原扫描间隔,不走本值)
  mut fs_watch_fallback_scan_secs : Int32?
  /// formatVersion
  mut format_version : Int32
  /// generatedBy
  mut generated_by : String?
  mut extra : Map[String, Json]
}

///|
/// fsWatchFallbackScanSecs 的缺省值:watcher 正常工作时的兜底全扫间隔(秒)。
/// 三端契约同值(见 docs/adr/0026 集成层与 Node/Rust 侧同名设置)。
pub const FS_WATCH_FALLBACK_SCAN_SECS : Int32 = 600

///|
/// 全新配置(formatVersion 已盖当前代数戳)。
pub fn Config::new() -> Config {
  {
    shared_folders: [],
    peers: [],
    known_devices: [],
    pending_offers: [],
    paused: None,
    share_enabled: None,
    shares: None,
    max_send_kbps: None,
    versions_per_path: None,
    history_max_events: None,
    webhook_url: None,
    webhook_secret: None,
    pause_on_metered_network: None,
    pause_on_low_battery: None,
    battery_pause_threshold: None,
    sync_schedule: None,
    schedule_override_until: None,
    holiday_auto_fetch: None,
    holiday_source_url: None,
    calendar_overrides: None,
    fs_watch_enabled: None,
    fs_watch_fallback_scan_secs: None,
    format_version: FORMAT_VERSION,
    generated_by: None,
    extra: Map([]),
  }
}

///|
pub fn Config::is_paused(self : Config) -> Bool {
  self.paused == Some(true)
}

///|
pub fn Config::share_enabled(self : Config) -> Bool {
  self.share_enabled == Some(true)
}

///|
pub fn Config::versions_per_path(self : Config) -> Int32 {
  match self.versions_per_path {
    Some(n) => n
    None => 10
  }
}

///|
pub fn Config::history_max_events(self : Config) -> Int32 {
  match self.history_max_events {
    Some(n) => n
    None => 2000
  }
}

///|
pub fn Config::battery_pause_threshold(self : Config) -> Int32 {
  match self.battery_pause_threshold {
    Some(n) => n
    None => 20
  }
}

///|
/// 文件系统监听开关(缺省开;只有显式 false 才关)。
pub fn Config::fs_watch_enabled(self : Config) -> Bool {
  self.fs_watch_enabled != Some(false)
}

///|
/// 兜底全扫间隔秒(watcher 正常时;缺省 600)。清洗(count_of min=1)已保证
/// 显式值 ≥ 1,这里不必再兜底。
pub fn Config::fs_watch_fallback_scan_secs(self : Config) -> Int32 {
  match self.fs_watch_fallback_scan_secs {
    Some(n) => n
    None => FS_WATCH_FALLBACK_SCAN_SECS
  }
}

// ---- 逐字段清洗辅助 ----------------------------------------------------

///|
fn take(obj : Map[String, Json], key : String) -> Json? {
  obj.remove_and_get(key)
}

///|
fn string_of(v : Json?) -> String? {
  match v {
    Some(String(s)) => if s != "" { Some(s) } else { None }
    _ => None
  }
}

///|
fn bool_of(v : Json?) -> Bool? {
  match v {
    Some(True) => Some(true)
    Some(False) => Some(false)
    _ => None
  }
}

///|
fn true_only(v : Json?) -> Bool? {
  match v {
    Some(True) => Some(true)
    _ => None
  }
}

///|
fn false_only(v : Json?) -> Bool? {
  match v {
    Some(False) => Some(false)
    _ => None
  }
}

///|
fn string_array_of(v : Json?) -> Array[String] {
  match v {
    Some(Array(items)) => {
      let out : Array[String] = []
      for item in items {
        match item {
          String(s) => out.push(s)
          _ => ()
        }
      }
      out
    }
    _ => []
  }
}

///|
/// 清洗一个「非负整数」配置值:非法(负数/非数)返回 None;0 保留(0 = 不限速)。
fn count_of(v : Json?, min : Int32) -> Int32? {
  match v {
    Some(Number(n, ..)) => {
      if n < 0.0 {
        return None
      }
      let i = n.floor().to_int()
      if i >= min {
        Some(i)
      } else {
        None
      }
    }
    _ => None
  }
}

///|
/// 百分比阈值:只认 1..=99 的整数。
fn percent_of(v : Json?) -> Int32? {
  match count_of(v, 1) {
    Some(n) => if n <= 99 { Some(n) } else { None }
    None => None
  }
}

///|
fn webhook_string_of(v : Json?, max_len : Int32) -> String? {
  match v {
    Some(String(s)) => {
      let trimmed = s.trim().to_owned()
      if trimmed != "" && trimmed.char_length() <= max_len {
        Some(trimmed)
      } else {
        None
      }
    }
    _ => None
  }
}

///|
fn int_of(v : Json?) -> Int32? {
  match v {
    Some(Number(n, ..)) => Some(n.to_int())
    _ => None
  }
}

// ---- 解析 --------------------------------------------------------------

///|
/// 解析 + 逐字段清洗。整体解析失败(非 JSON/非对象)按默认配置处理。
pub fn parse_config(raw : String) -> Config {
  let parsed = @json.parse(raw) catch { _ => return Config::new() }
  match parsed {
    Object(obj) => parse_config_object(obj)
    _ => Config::new()
  }
}

///|
fn parse_config_object(obj : Map[String, Json]) -> Config {
  let config = Config::new()
  config.format_version = match take(obj, "formatVersion") {
    Some(Number(n, ..)) => n.to_int()
    _ => 1
  }
  config.generated_by = string_of(take(obj, "generatedBy"))
  config.shared_folders = match take(obj, "sharedFolders") {
    Some(Array(items)) => {
      let out : Array[SharedFolder] = []
      for item in items {
        match parse_shared_folder(item) {
          Some(f) => out.push(f)
          None => ()
        }
      }
      out
    }
    _ => []
  }
  config.peers = normalize_peer_list(string_array_of(take(obj, "peers")))
  config.known_devices = match take(obj, "knownDevices") {
    Some(Array(items)) => {
      let out : Array[DeviceConfig] = []
      for item in items {
        match parse_device(item) {
          Some(d) => out.push(d)
          None => ()
        }
      }
      out
    }
    _ => []
  }
  config.pending_offers = match take(obj, "pendingOffers") {
    Some(Array(items)) => {
      let out : Array[PendingOffer] = []
      for item in items {
        match parse_offer(item) {
          Some(o) => out.push(o)
          None => ()
        }
      }
      out
    }
    _ => []
  }
  // 布尔开关一律只认 `true`(缺省/false 都不落),与 Node `=== true` 同口径
  config.paused = true_only(take(obj, "paused"))
  config.share_enabled = true_only(take(obj, "shareEnabled"))
  config.pause_on_metered_network = true_only(
    take(obj, "pauseOnMeteredNetwork"),
  )
  config.pause_on_low_battery = true_only(take(obj, "pauseOnLowBattery"))
  // 自动拉取默认开:只有显式 false 才关
  config.holiday_auto_fetch = false_only(take(obj, "holidayAutoFetch"))
  // 文件系统监听同口径:缺省开,只有显式 false 才关;兜底秒数只认 ≥ 1 的整数
  config.fs_watch_enabled = false_only(take(obj, "fsWatchEnabled"))
  config.fs_watch_fallback_scan_secs = count_of(
    take(obj, "fsWatchFallbackScanSecs"),
    1,
  )
  config.shares = sanitize_shares(take(obj, "shares"))
  config.max_send_kbps = count_of(take(obj, "maxSendKbps"), 0)
  config.versions_per_path = count_of(take(obj, "versionsPerPath"), 1)
  config.history_max_events = count_of(take(obj, "historyMaxEvents"), 1)
  config.webhook_url = webhook_string_of(take(obj, "webhookUrl"), 500)
  config.webhook_secret = webhook_string_of(take(obj, "webhookSecret"), 200)
  config.battery_pause_threshold = percent_of(
    take(obj, "batteryPauseThreshold"),
  )
  config.sync_schedule = take(obj, "syncSchedule")
  config.schedule_override_until = match
    int_of(take(obj, "scheduleOverrideUntil")) {
    Some(n) => if n > 0 { Some(n) } else { None }
    None => None
  }
  config.holiday_source_url = match take(obj, "holidaySourceUrl") {
    Some(String(s)) =>
      if s.contains("{year}") && s.char_length() <= 300 {
        let trimmed = s.trim().to_owned()
        if trimmed != "" {
          Some(trimmed)
        } else {
          None
        }
      } else {
        None
      }
    _ => None
  }
  config.calendar_overrides = sanitize_calendar_overrides(
    take(obj, "calendarOverrides"),
  )
  config.extra = obj
  config
}

///|
/// 单条共享目录。`path` 缺失/非字符串整条丢弃 —— 没有 path 的目录无法参与同步。
fn parse_shared_folder(value : Json) -> SharedFolder? {
  match value {
    Object(obj) => {
      let path = match take(obj, "path") {
        Some(String(s)) => if s != "" { s } else { return None }
        _ => return None
      }
      Some({
        path,
        devices: string_array_of(take(obj, "devices")),
        id: string_of(take(obj, "id")),
        max_bandwidth_kbps: count_of(take(obj, "maxBandwidthKbps"), 0),
        use_gitignore: bool_of(take(obj, "useGitignore")),
        remote: bool_of(take(obj, "remote")),
        receive_only: true_only(take(obj, "receiveOnly")),
        instance_id: string_of(take(obj, "instanceId")),
        paused: bool_of(take(obj, "paused")),
        schedule: take(obj, "schedule"),
        git_sync: string_of(take(obj, "gitSync")),
        conflict_policy: string_of(take(obj, "conflictPolicy")),
        strip_co_authored: bool_of(take(obj, "gitStripCoAuthored")),
        on_demand: bool_of(take(obj, "onDemand")),
        on_demand_dirs: match take(obj, "onDemandDirs") {
          Some(v) => Some(string_array_of(Some(v)))
          None => None
        },
        paused_files: match take(obj, "pausedFiles") {
          Some(v) => Some(string_array_of(Some(v)))
          None => None
        },
        folder_identity: take(obj, "folderIdentity"),
        marker_checked: bool_of(take(obj, "markerChecked")),
        git_last_commit_hash: string_of(take(obj, "gitLastCommitHash")),
        git_relay_pending: take(obj, "gitRelayPending"),
        git_broadcast_pending: take(obj, "gitBroadcastPending"),
        e2e_key: take(obj, "e2eKey"),
        e2e_untrusted: match take(obj, "e2eUntrusted") {
          Some(v) => Some(string_array_of(Some(v)))
          None => None
        },
        extra: obj,
      })
    }
    _ => None
  }
}

///|
fn parse_device(value : Json) -> DeviceConfig? {
  match value {
    Object(obj) => {
      let id = match string_of(take(obj, "id")) {
        Some(id) => id
        None => return None
      }
      Some({ id, name: string_of(take(obj, "name")), extra: obj, })
    }
    _ => None
  }
}

///|
fn parse_offer(value : Json) -> PendingOffer? {
  match value {
    Object(obj) => {
      let id = match string_of(take(obj, "id")) {
        Some(id) => id
        None => return None
      }
      let kind = match string_of(take(obj, "kind")) {
        Some(k) => k
        None => "folder"
      }
      let from_device_id = match string_of(take(obj, "fromDeviceId")) {
        Some(s) => s
        None => ""
      }
      Some({
        id,
        kind,
        from_device_id,
        folder_id: string_of(take(obj, "folderId")),
        folder_name: string_of(take(obj, "folderName")),
        from_hostname: string_of(take(obj, "fromHostname")),
        from_ip: string_of(take(obj, "fromIp")),
        status: match string_of(take(obj, "status")) {
          Some(s) => s
          None => "pending"
        },
        created_at: match int_of(take(obj, "createdAt")) {
          Some(n) => n
          None => 0
        },
        extra: obj,
      })
    }
    _ => None
  }
}

///|
/// 清洗分享记录:字段完整、时间可解释的条目才留;超 500 条截断。
fn sanitize_shares(v : Json?) -> Array[ShareRecord]? {
  match v {
    Some(Array(items)) => {
      let out : Array[ShareRecord] = []
      for item in items {
        if out.length() >= 500 {
          break
        }
        match parse_share_record(item) {
          Some(r) => out.push(r)
          None => ()
        }
      }
      if out.length() > 0 {
        Some(out)
      } else {
        None
      }
    }
    _ => None
  }
}

///|
fn parse_share_record(value : Json) -> ShareRecord? {
  match value {
    Object(obj) => {
      let id = match string_of(take(obj, "id")) {
        Some(s) => s
        None => return None
      }
      let folder_id = match string_of(take(obj, "folderId")) {
        Some(s) => s
        None => return None
      }
      let path = match string_of(take(obj, "path")) {
        Some(s) => s
        None => return None
      }
      let created_at = match int_of(take(obj, "createdAt")) {
        Some(n) => n
        None => return None
      }
      let expires_at = match int_of(take(obj, "expiresAt")) {
        Some(n) => n
        None => return None
      }
      if expires_at <= created_at {
        return None
      }
      Some({
        id,
        folder_id,
        path,
        created_at,
        expires_at,
        downloads: match take(obj, "downloads") {
          Some(Number(n, ..)) => Some(n.to_int())
          _ => None
        },
        last_download_at: int_of(take(obj, "lastDownloadAt")),
      })
    }
    _ => None
  }
}

///|
/// 清洗手动日历覆盖:只留合法日期与合法身份,条数截断到 400。
fn sanitize_calendar_overrides(v : Json?) -> Map[String, String]? {
  match v {
    Some(Object(map)) => {
      let out : Map[String, String] = Map([])
      for key, value in map {
        if out.length() >= 400 {
          break
        }
        match value {
          String(kind) =>
            if is_real_date_key(key) && (kind == "workday" || kind == "holiday") {
              out.set(key, kind)
            }
          _ => ()
        }
      }
      if out.length() > 0 {
        Some(out)
      } else {
        None
      }
    }
    _ => None
  }
}

///|
/// `YYYY-MM-DD` 且是真实存在的日期(1970..=2100)。
fn is_real_date_key(key : String) -> Bool {
  if key.char_length() != 10 {
    return false
  }
  let chars = key.to_array()
  if chars[4] != '-' || chars[7] != '-' {
    return false
  }
  match
    (
      digits_to_int(key[0:4].to_owned()),
      digits_to_int(key[5:7].to_owned()),
      digits_to_int(key[8:10].to_owned()),
    ) {
    (Some(y), Some(m), Some(d)) =>
      y >= 1970 &&
      y <= 2100 &&
      m >= 1 &&
      m <= 12 &&
      d >= 1 &&
      d <= days_in_month(y, m)
    _ => false
  }
}

///|
/// 纯十进制字串 → Int;含非数字返回 None。
fn digits_to_int(s : String) -> Int32? {
  let mut n = 0
  for c in s {
    if c < '0' || c > '9' {
      return None
    }
    n = n * 10 + (c.to_int() - '0'.to_int())
  }
  Some(n)
}

///|
fn days_in_month(year : Int32, month : Int32) -> Int32 {
  match month {
    1 | 3 | 5 | 7 | 8 | 10 | 12 => 31
    4 | 6 | 9 | 11 => 30
    2 =>
      if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 {
        29
      } else {
        28
      }
    _ => 0
  }
}

// ---- 序列化 ------------------------------------------------------------

///|
fn set_bool(map : Map[String, Json], key : String, v : Bool?) -> Unit {
  match v {
    Some(b) => map.set(key, Json::boolean(b))
    None => ()
  }
}

///|
fn set_string(map : Map[String, Json], key : String, v : String?) -> Unit {
  match v {
    Some(s) => map.set(key, Json::string(s))
    None => ()
  }
}

///|
fn set_int(map : Map[String, Json], key : String, v : Int32?) -> Unit {
  match v {
    Some(n) => map.set(key, Json::number(n.to_double()))
    None => ()
  }
}

///|
fn set_string_array(
  map : Map[String, Json],
  key : String,
  v : Array[String]?,
) -> Unit {
  match v {
    Some(items) => {
      let arr : Array[Json] = []
      for item in items {
        arr.push(Json::string(item))
      }
      map.set(key, Json::array(arr))
    }
    None => ()
  }
}

///|
fn set_json(map : Map[String, Json], key : String, v : Json?) -> Unit {
  match v {
    Some(j) => map.set(key, j)
    None => ()
  }
}

///|
/// 把已知字段铺回 `extra` 之上,得到完整 JSON 对象(未知键原样保留)。
pub fn SharedFolder::to_json(self : SharedFolder) -> Json {
  let map : Map[String, Json] = Map([])
  for key, value in self.extra {
    map.set(key, value)
  }
  map.set("path", Json::string(self.path))
  if self.devices.length() > 0 {
    set_string_array(map, "devices", Some(self.devices))
  }
  set_string(map, "id", self.id)
  set_int(map, "maxBandwidthKbps", self.max_bandwidth_kbps)
  set_bool(map, "useGitignore", self.use_gitignore)
  set_bool(map, "remote", self.remote)
  set_bool(map, "receiveOnly", self.receive_only)
  set_string(map, "instanceId", self.instance_id)
  set_bool(map, "paused", self.paused)
  set_json(map, "schedule", self.schedule)
  set_string(map, "gitSync", self.git_sync)
  set_string(map, "conflictPolicy", self.conflict_policy)
  set_bool(map, "gitStripCoAuthored", self.strip_co_authored)
  set_bool(map, "onDemand", self.on_demand)
  set_string_array(map, "onDemandDirs", self.on_demand_dirs)
  set_string_array(map, "pausedFiles", self.paused_files)
  set_json(map, "folderIdentity", self.folder_identity)
  set_bool(map, "markerChecked", self.marker_checked)
  set_string(map, "gitLastCommitHash", self.git_last_commit_hash)
  set_json(map, "gitRelayPending", self.git_relay_pending)
  set_json(map, "gitBroadcastPending", self.git_broadcast_pending)
  set_json(map, "e2eKey", self.e2e_key)
  set_string_array(map, "e2eUntrusted", self.e2e_untrusted)
  // e2eKeySet / gitRepo 是「只出站 / 非持久化」字段,落盘前清掉
  Json::object(map)
}

///|
pub fn Config::to_json(self : Config) -> Json {
  let map : Map[String, Json] = Map([])
  for key, value in self.extra {
    map.set(key, value)
  }
  if self.shared_folders.length() > 0 {
    let arr : Array[Json] = []
    for folder in self.shared_folders {
      arr.push(folder.to_json())
    }
    map.set("sharedFolders", Json::array(arr))
  }
  if self.peers.length() > 0 {
    set_string_array(map, "peers", Some(self.peers))
  }
  if self.known_devices.length() > 0 {
    let arr : Array[Json] = []
    for device in self.known_devices {
      let dm : Map[String, Json] = Map([])
      for key, value in device.extra {
        dm.set(key, value)
      }
      dm.set("id", Json::string(device.id))
      set_string(dm, "name", device.name)
      arr.push(Json::object(dm))
    }
    map.set("knownDevices", Json::array(arr))
  }
  if self.pending_offers.length() > 0 {
    let arr : Array[Json] = []
    for offer in self.pending_offers {
      let om : Map[String, Json] = Map([])
      for key, value in offer.extra {
        om.set(key, value)
      }
      om.set("id", Json::string(offer.id))
      om.set("kind", Json::string(offer.kind))
      om.set("fromDeviceId", Json::string(offer.from_device_id))
      set_string(om, "folderId", offer.folder_id)
      set_string(om, "folderName", offer.folder_name)
      set_string(om, "fromHostname", offer.from_hostname)
      set_string(om, "fromIp", offer.from_ip)
      om.set("status", Json::string(offer.status))
      if offer.created_at != 0 {
        om.set("createdAt", Json::number(offer.created_at.to_double()))
      }
      arr.push(Json::object(om))
    }
    map.set("pendingOffers", Json::array(arr))
  }
  set_bool(map, "paused", self.paused)
  set_bool(map, "shareEnabled", self.share_enabled)
  match self.shares {
    Some(records) => {
      let arr : Array[Json] = []
      for record in records {
        let rm : Map[String, Json] = Map([])
        rm.set("id", Json::string(record.id))
        rm.set("folderId", Json::string(record.folder_id))
        rm.set("path", Json::string(record.path))
        rm.set("createdAt", Json::number(record.created_at.to_double()))
        rm.set("expiresAt", Json::number(record.expires_at.to_double()))
        set_int(rm, "downloads", record.downloads)
        set_int(rm, "lastDownloadAt", record.last_download_at)
        arr.push(Json::object(rm))
      }
      map.set("shares", Json::array(arr))
    }
    None => ()
  }
  set_int(map, "maxSendKbps", self.max_send_kbps)
  set_int(map, "versionsPerPath", self.versions_per_path)
  set_int(map, "historyMaxEvents", self.history_max_events)
  set_string(map, "webhookUrl", self.webhook_url)
  set_string(map, "webhookSecret", self.webhook_secret)
  set_bool(map, "pauseOnMeteredNetwork", self.pause_on_metered_network)
  set_bool(map, "pauseOnLowBattery", self.pause_on_low_battery)
  set_int(map, "batteryPauseThreshold", self.battery_pause_threshold)
  set_json(map, "syncSchedule", self.sync_schedule)
  set_int(map, "scheduleOverrideUntil", self.schedule_override_until)
  set_bool(map, "holidayAutoFetch", self.holiday_auto_fetch)
  set_string(map, "holidaySourceUrl", self.holiday_source_url)
  set_bool(map, "fsWatchEnabled", self.fs_watch_enabled)
  set_int(map, "fsWatchFallbackScanSecs", self.fs_watch_fallback_scan_secs)
  match self.calendar_overrides {
    Some(overrides) => {
      let cm : Map[String, Json] = Map([])
      for key, value in overrides {
        cm.set(key, Json::string(value))
      }
      map.set("calendarOverrides", Json::object(cm))
    }
    None => ()
  }
  map.set("formatVersion", Json::number(self.format_version.to_double()))
  set_string(map, "generatedBy", self.generated_by)
  Json::object(map)
}

// ---- 对端地址规范化 ------------------------------------------------------

///|
/// 规范化对端地址:剥离 IPv4-mapped IPv6 前缀、host 小写。
/// 不归一的话同一对端会在 peers 里留下两条等价记录。
pub fn normalize_peer_url(address : String) -> String {
  let lower = address.to_lower()
  let rest = match lower.strip_prefix("ws://") {
    Some(r) => r.to_owned()
    None => return address
  }
  // [v6]:port
  if rest[0:1] == "[" {
    match rest.split_once("]:") {
      Some((host_raw, port)) => {
        let host = host_raw[1:host_raw.length()].to_owned()
        let stripped = strip_v4_mapped(host)
        let normalized_host = if stripped != host {
          stripped
        } else {
          "[\{host}]"
        }
        return "ws://\{normalized_host}:\{port}"
      }
      None => return address
    }
  }
  // host:port
  match rest.split_once(":") {
    Some((host, port)) => {
      let stripped = strip_v4_mapped(host.to_owned())
      "ws://\{stripped}:\{port}"
    }
    None => address
  }
}

///|
/// `::ffff:1.2.3.4` → `1.2.3.4`;其它原样返回。
fn strip_v4_mapped(host : String) -> String {
  if host.contains(":ffff:") {
    match host.split_once(":ffff:") {
      Some((_, v4)) => v4.to_owned()
      None => host
    }
  } else {
    host
  }
}

///|
/// 规范化 peers 列表:去空、归一、去重(保持首次出现顺序)。
pub fn normalize_peer_list(list : Array[String]) -> Array[String] {
  let seen : Map[String, Unit] = Map([])
  let out : Array[String] = []
  for item in list {
    let trimmed = item.trim().to_owned()
    if trimmed == "" {
      continue
    }
    let normalized = normalize_peer_url(trimmed)
    if !seen.contains(normalized) {
      seen.set(normalized, ())
      out.push(normalized)
    }
  }
  out
}

// ---- 已知设备与对端地址的增删(HTTP 设备路由共用;对齐 src/devices.ts) ----

///|
/// 添加一个已知设备 ID(对齐 Node addKnownDevice:已存在则幂等不重复)。
/// 返回 true = 本次新增,false = 已存在跳过。空 ID 由调用方(HTTP 层回
/// 400)拦截,这里不再校验。
pub fn Config::add_known_device(self : Config, device_id : String) -> Bool {
  for device in self.known_devices {
    if device.id == device_id {
      return false
    }
  }
  self.known_devices.push({ id: device_id, name: None, extra: Map([]), })
  true
}

///|
/// 移除已知设备(对齐 Node removeKnownDevice):从 knownDevices 摘除之外,
/// **同时**从每个 sharedFolders 的 devices 列表摘掉该设备 —— 目录指派是
/// 「哪些设备同步这个目录」的持久授权,漏摘会让被移除设备继续出现在
/// 目录设备列表里。设备本就不存在时静默返回(幂等)。
/// 返回 true = 有变更,false = 本就不存在且任何目录都没有该设备。
pub fn Config::remove_known_device(self : Config, device_id : String) -> Bool {
  let mut changed = false
  let kept : Array[DeviceConfig] = []
  for device in self.known_devices {
    if device.id == device_id {
      changed = true
    } else {
      kept.push(device)
    }
  }
  self.known_devices = kept
  // SharedFolder 字段不可变:整体拷贝替换(devices 字段换新数组)
  for i, folder in self.shared_folders {
    let devices : Array[String] = []
    let mut hit = false
    for id in folder.devices {
      if id == device_id {
        hit = true
      } else {
        devices.push(id)
      }
    }
    if hit {
      changed = true
      self.shared_folders[i] = { ..folder, devices, }
    }
  }
  changed
}

///|
/// 添加一个手动配置的对端地址(对齐 Node addPeer):仅接受 ws:// 开头
/// 的地址;入库前经 normalize_peer_url 规范化(::ffff: 剥离、host 小写,
/// 使 [::ffff:10.0.0.2]:22000 与 10.0.0.2:22000 视为同一条),已存在幂等。
/// 返回 true = 新增;false = 非法地址(不上线)或已存在(幂等)。
pub fn Config::add_peer(self : Config, address : String) -> Bool {
  // normalize_peer_url 对非 ws:// 前缀原样返回,ws:// 校验必须在这里显式做
  // (Node 同款 `/^ws:\/\//i`,大小写不敏感)
  if address.to_lower().strip_prefix("ws://") is None {
    return false
  }
  let normalized = normalize_peer_url(address)
  for peer in self.peers {
    if peer == normalized {
      return false
    }
  }
  self.peers.push(normalized)
  true
}
