///|
/// syncx MoonBit 后端的 HTTP API 层(ADR-0026 清单第 6 项)。
///
/// 路由语义与 Rust `crates/syncx-api/src/routes/`、Node `src/api/` 逐条对齐:
///   - `/health`:免认证探活,只报存活,不暴露版本/设备 ID;
///   - `/api/status`:登录门之后,本里程碑只回最小字段,缺省字段不上线;
///   - 登录/登出 + 会话票据(HMAC 签名 cookie,详见 auth.mbt);
///   - 目录/设备/暂停/关闭:数据从 config.json 读写,daemon 深度集成见 TODO;
///   - `/`:dist/web 静态资源(目录不存在时退占位页)。
/// 分发顺序即安全边界:免认证探活/登录在前,`/api` 子树统一过认证门。

///|
/// API 装配选项。
pub(all) struct ApiOptions {
  /// 本机 Device ID(由 net 包身份派生,daemon/cli 里程碑接通落盘读回)。
  device_id : String
  /// control.token 原文:令牌登录的根基,也是无账号时的会话签名基。
  control_token : String
  /// `auth.json` 路径(启用账号密码登录;None = 仅令牌登录)。
  auth_file : String?
  /// `config.json` 路径。
  config_file : String
  /// 会话 actor 句柄(None = 未接 daemon,控制面只回最小字段,无 WS 推送)。
  actor : @daemon.ActorHandle?
  /// dist/web 目录(None = 占位页);`ApiOptions::new` 默认取 SYNCX_WEB_DIST。
  web_dist : String?
  /// 优雅关闭回调(None = POST /api/shutdown 回 503)。
  on_shutdown : (() -> Unit)?
  /// dev 运行态:`/api/self-update*` 一律拒绝(Node 侧的最后一道防线)。
  dev_mode : Bool
  /// 上传包预检回调(None = POST /api/self-update/upload/inspect 回 503)。
  upload_inspect : UploadInspectFn?
  /// 上传包换入回调(None = POST /api/self-update/upload 回 503)。
  upload_swap : UploadSwapFn?
  /// `/api/status.settings` 全局设置段(装配层启动时从 config.json 折算注入;
  /// None = 不上线该段)。配置热重载:每次配置落盘后由装配层回调重建快照。
  mut settings : Json?
  /// peer 数据面监听端口(`/api/status.peerPort`,顶栏本机信息浮层用;
  /// cli 装配时从启动参数注入,缺省 22000;None = 未注入,不上线该字段)。
  peer_port : Int32?
  /// `/api/status.devices` 的设备清单快照(前端设备列表与「已配对设备」徽标
  /// 的数据源)。装配层启动时从 config.knownDevices 折算注入;设备增删路由
  /// 成功后重建快照 —— 对应 Node 的「内存态 + statusHub.notify」语义,不做
  /// 每请求读配置(status 是高频端点)。其他进程改配置(两后端切换场景)
  /// 重启后可见。
  mut device_infos : Array[Json]
  /// `/api/status.devices` 动态提供器(None = 走静态快照 device_infos):
  /// 装配层把「静态快照 + 活跃会话元数据」的合并视图折算成设备数组返回。
  /// 会话是动态的,静态字段不够用 —— 用 provider 回调在 status 时拉当前值
  /// (单线程 async,无锁)。会话注册表在 cli 装配层,api 只见闭包不见类型;
  /// 装配层先构造 ApiOptions 再回填本字段(mut,打破闭包自引用)。
  mut device_status : (() -> Array[Json])?
  /// `/api/status.syncProgress` 动态提供器(None = 空数组,保持现行为):
  /// 会话在途状态(供块租约 / 在途接收 / 速率窗口)只在 actor 任务上,而
  /// status_json 是同步函数 —— 装配层用后台任务周期性经 Cmd 拉快照写同步
  /// 镜像,本回调读镜像折算(形态见 sync_progress_json;单线程 async,无锁)。
  mut sync_progress : (() -> Array[@daemon.SyncProgress])?
  /// `/api/status.traffic` 动态提供器(None = 零值缺省):传输字节账本在
  /// actor 任务上,同经 cli 侧镜像读出(形态见 traffic_json)。
  mut traffic : (() -> @daemon.TrafficStats)?
  /// 「自动提交失败」弹窗的镜像侧数据源(cli 装配注入;None = 未接镜像,
  /// status 回缺省形状、retry 回 503)。形态对齐 Node getGitAutoCommitStatus
  /// 的台账部分(lock 由 api 层现查合并;maxAttempts 由提供器带上)。
  mut git_commit_status : ((String) -> Json?)?
  /// 手动重试自动提交的镜像入口(None = 未接镜像,回 503;形状照
  /// Node retryGitAutoCommit:{ ok, hash?, error?, attempts })。
  mut git_commit_retry : (async (String) -> Json)?
  /// 配置变更回调(None = 未接 daemon,落盘即止):任何写路由成功落盘后
  /// 触发一次,装配层借此重读配置并热重载 daemon 派生状态(目录集重建 /
  /// 设备清单快照 / fs-watch 对账 / 出站拨号对账)。回调在单线程事件循环里
  /// 执行,必须轻(读配置 + 发命令,不做 git/网络动作)。
  mut on_config_changed : ConfigChangedFn?
}

///|
/// 配置变更回调的形态:重读配置 + 派发重建命令(fs 读是 async,回调整体
/// async;不做 git / 网络动作)。
pub type ConfigChangedFn = async () -> Unit

///|
/// 通知装配层「配置已落盘」:写路由在 save_config 成功后调用;未接回调
/// (api 单测 / 未装配 daemon)时为无操作。
pub async fn notify_config_changed(options : ApiOptions) -> Unit {
  match options.on_config_changed {
    Some(notify) => notify()
    None => ()
  }
}

///|
/// 装配选项构造。缺省:
///   - config_file:`~/.syncx/config.json`;
///   - web_dist:环境变量 `SYNCX_WEB_DIST`(未设置 = None,退占位页)。
pub fn ApiOptions::new(
  device_id~ : String,
  control_token~ : String = "",
  auth_file~ : String? = None,
  config_file~ : String? = None,
  actor~ : @daemon.ActorHandle? = None,
  web_dist~ : String? = None,
  on_shutdown~ : (() -> Unit)? = None,
  dev_mode~ : Bool = false,
  upload_inspect~ : UploadInspectFn? = None,
  upload_swap~ : UploadSwapFn? = None,
  settings~ : Json? = None,
  peer_port~ : Int32? = None,
  device_infos~ : Array[Json] = [],
  on_config_changed~ : ConfigChangedFn? = None,
) -> ApiOptions {
  let web_dist = match web_dist {
    Some(dist) => Some(dist)
    None => @env.get_env_var("SYNCX_WEB_DIST")
  }
  {
    device_id,
    control_token,
    auth_file,
    config_file: config_file.unwrap_or(default_config_path()),
    actor,
    web_dist,
    on_shutdown,
    dev_mode,
    upload_inspect,
    upload_swap,
    settings,
    peer_port,
    device_infos,
    device_status: None,
    sync_progress: None,
    traffic: None,
    git_commit_status: None,
    git_commit_retry: None,
    on_config_changed,
  }
}

///|
/// `/health` 探活载荷:只报存活。谁都能访问,不放任何身份信息。
pub fn health_json() -> Json {
  let map : Map[String, Json] = Map([])
  map.set("ok", Json::boolean(true))
  Json::object(map)
}

///|
/// `/api/status` 载荷(ADR-0025 第 3 节;与 WS 推送的状态帧同源):
///   - `runtime`:`node | rust | moonbit`,前端据此切换文案,不分支界面;
///   - `updateSource`:`github`(MoonBit 形态只走 GitHub Releases);
///   - 接了 actor 时叠加目录/统计域(folders/entries/tombstones/
///     conflictCounts,camelCase 对齐前端 `StatusData`);未接则缺省不上线,
///     其余字段(platform/devices/...)仍是后续里程碑。

///|
/// 编译目标 OS(见 platform.c;与 cli 的 syncx_os_name 是两套取值口径)。
extern "C" fn c_status_platform() -> String = "syncx_status_platform"

///|
/// 本机主机名(gethostname;失败/空 = 空串,见 platform.c 注释)。
extern "C" fn c_status_hostname() -> String = "syncx_status_hostname"

///|
/// 局域网 IPv4 列表(JSON 数组字符串,如 ["192.168.1.5"];取不到 = "[]")。
extern "C" fn c_status_lan_addresses() -> String = "syncx_status_lan_addresses"

///|
/// 解析 C 侧返回的局域网地址 JSON 数组字符串。C 侧已按「IPv4 + 非回环 +
/// 非链路本地」过滤(Node getLanAddresses 同口径),这里只负责拆包:
/// 非字符串元素与畸形输入一律忽略,解析失败视作取不到(空列表 → 不上线)。
/// pub 仅为让 *_test 包(独立编译)可对解析口径做单测。
pub fn parse_lan_addresses(text : String) -> Array[String] {
  let parsed : Json? = Some(@json.parse(text)) catch { _ => None }
  let addresses : Array[String] = []
  match parsed {
    Some(Array(items)) =>
      for item in items {
        if item is String(addr) {
          addresses.push(addr)
        }
      }
    _ => ()
  }
  addresses
}

///|
/// 本机局域网 IPv4 列表(C FFI getifaddrs → JSON 解析的对外包装)。cli 启动
/// 横幅的地址列表与 /api/status.localAddresses 共用同一取数口径,勿复制 C 侧。
pub fn lan_addresses() -> Array[String] {
  parse_lan_addresses(c_status_lan_addresses())
}

///|
/// 本机主机名(gethostname;失败/空 = None)。hello 宣告与 /api/status
/// 共用同一取数口径。
pub fn local_hostname() -> String? {
  let hostname = c_status_hostname()
  if hostname == "" {
    None
  } else {
    Some(hostname)
  }
}

///|
/// 编译目标 OS(process.platform 口径)。hello 宣告与 /api/status 共用。
pub fn platform_name() -> String {
  c_status_platform()
}

///|
/// `/api/status.settings` 全局设置段(设置弹窗读取;键名与 config.json 顶层
/// 字段逐字一致,camelCase 对齐 Node 的 GlobalSettingsStatus)。本里程碑只
/// 透出 fsWatch 两键,其余全局设置随各自里程碑补齐;字段缺省不上线与既有
/// 「缺字段 = 旧后端」口径一致。
pub fn settings_json(config : @core.Config) -> Json {
  let map : Map[String, Json] = Map([])
  map.set("fsWatchEnabled", Json::boolean(config.fs_watch_enabled()))
  map.set(
    "fsWatchFallbackScanSecs",
    Json::number(config.fs_watch_fallback_scan_secs().to_double()),
  )
  Json::object(map)
}

///|
/// 设备清单快照构建:config.knownDevices → 前端 DeviceInfo。
/// - online 恒 false:MoonBit 尚无 peer 会话层,设备可达性未知(离线展示);
///   会话层落地后由 actor 快照覆盖在线态。
/// - folders = 该设备被指派到的目录 id 列表(设备卡「共享 N 个目录」),
///   从各共享目录的 devices 清单反查。
pub fn device_infos_json(config : @core.Config) -> Array[Json] {
  let items : Array[Json] = []
  for device in config.known_devices {
    let item : Map[String, Json] = Map([])
    item.set("deviceId", Json::string(device.id))
    item.set("online", Json::boolean(false))
    let assigned : Array[Json] = []
    for folder in config.shared_folders {
      for d in folder.devices {
        if d == device.id {
          assigned.push(Json::string(folder.folder_id()))
        }
      }
    }
    item.set("folders", Json::array(assigned))
    items.push(Json::object(item))
  }
  items
}

///|
pub fn status_json(options : ApiOptions) -> Json {
  let map : Map[String, Json] = Map([])
  map.set("deviceId", Json::string(options.device_id))
  map.set("version", Json::string(@core.VERSION))
  map.set("runtime", Json::string("moonbit"))
  map.set("updateSource", Json::string("github"))
  // 前端 StatusData 的必填字段先给缺省值,接了 actor 再覆盖
  // (缺字段会让前端 status.offers.filter 直接抛错,见 useNotifications)
  map.set("entries", Json::number(0))
  map.set("tombstones", Json::number(0))
  map.set("folders", Json::array([]))
  // 设备清单:动态提供器(静态快照 + 活跃会话元数据的合并视图)优先;
  // 缺省走装配层/设备增删路由维护的静态快照(见 ApiOptions.device_infos
  // 注释),空数组 = 未注入(测试/最小装配),前端「还没有设备」兜底
  let devices = match options.device_status {
    Some(provider) => provider()
    None => options.device_infos
  }
  map.set("devices", Json::array(devices))
  // 同步进度:动态提供器(cli 装配的镜像回调,见 ApiOptions.sync_progress
  // 注释);缺省空数组保持现行为(前端「同步中无待处理任务」兜底)。
  // offers 保持占位空数组:邀请控制面未接,根因不在本包(勿动)。
  let progress_rows : Array[Json] = match options.sync_progress {
    Some(provider) => sync_progress_json(provider())
    None => []
  }
  map.set("syncProgress", Json::array(progress_rows))
  map.set("offers", Json::array([]))
  // 传输统计(流量面板):动态提供器,缺省零值 —— 账本未接线(最小装配 /
  // 单测)= 没有可报的传输量,字段仍上线,形态恒完整
  let traffic_stats : @daemon.TrafficStats = match options.traffic {
    Some(provider) => provider()
    None => { sent: 0L, received: 0L, samples: [], }
  }
  map.set("traffic", traffic_json(traffic_stats))
  // 编译目标 OS,口径对齐 Node 的 process.platform(前端 osIconKind 只认 darwin/win32/linux)
  map.set("platform", Json::string(c_status_platform()))
  // 本机主机名(顶栏本机信息浮层):C FFI gethostname;取不到(失败/空串)
  // = 旧后端口径,不上线该字段
  let hostname = c_status_hostname()
  if hostname != "" {
    map.set("hostname", Json::string(hostname))
  }
  // 局域网 IPv4 列表(顶栏本机信息浮层):C 侧 getifaddrs 遍历后以 JSON
  // 数组字符串交回,一条都取不到则不上线
  let addresses = parse_lan_addresses(c_status_lan_addresses())
  if addresses.length() > 0 {
    let items : Array[Json] = []
    for addr in addresses {
      items.push(Json::string(addr))
    }
    map.set("localAddresses", Json::array(items))
  }
  // peer 数据面监听端口(启动参数注入;未注入 = 不上线,与「缺字段 = 旧后端」口径一致)
  match options.peer_port {
    Some(port) => map.set("peerPort", Json::number(port.to_double()))
    None => ()
  }
  // 全局设置当前值(装配层注入;未注入 = 旧装配形态,整段不上线)
  match options.settings {
    Some(settings) => map.set("settings", settings)
    None => ()
  }
  match options.actor {
    Some(actor) => {
      let snapshot = actor.snapshot()
      map.set("entries", Json::number(snapshot.total_entries.to_double()))
      map.set("tombstones", Json::number(snapshot.total_tombstones.to_double()))
      let folders : Array[Json] = []
      let conflicts : Map[String, Json] = Map([])
      for folder in snapshot.folders {
        let item : Map[String, Json] = Map([])
        item.set("id", Json::string(folder.id))
        item.set("path", Json::string(folder.path))
        item.set("paused", Json::boolean(folder.paused))
        item.set("receiveOnly", Json::boolean(folder.receive_only))
        item.set("peers", Json::number(folder.peers.to_double()))
        item.set("entries", Json::number(folder.entries.to_double()))
        item.set("tombstones", Json::number(folder.tombstones.to_double()))
        // 前端 FolderInfo.devices 是必填数组(目录卡 folderActions 直接 .length),
        // 对端清单尚未接入 actor 统计,先缺省空数组
        item.set("devices", Json::array([]))
        folders.push(Json::object(item))
        // 目录卡冲突徽标(键 = 目录 id,对齐前端 conflictCounts)
        conflicts.set(folder.id, Json::number(folder.conflicts.to_double()))
      }
      map.set("folders", Json::array(folders))
      map.set("conflictCounts", Json::object(conflicts))
      // 目录卡 git 徽标(键 = 目录 id,只上非零项,对齐前端 gitChangeCounts/
      // gitUnpushedCounts;daemon 侧独立循环每 30s 现查,与扫描/暂停/时段解耦)
      let git_changes : Map[String, Json] = Map([])
      let git_unpushed : Map[String, Json] = Map([])
      for folder in snapshot.folders {
        if folder.git_changes > 0 {
          git_changes.set(
            folder.id,
            Json::number(folder.git_changes.to_double()),
          )
        }
        if folder.git_unpushed > 0 {
          git_unpushed.set(
            folder.id,
            Json::number(folder.git_unpushed.to_double()),
          )
        }
      }
      map.set("gitChangeCounts", Json::object(git_changes))
      map.set("gitUnpushedCounts", Json::object(git_unpushed))
      // 同步时段:目录结论(键 = 目录 id)+ 顶部横幅。判定在 actor 现算
      // (Snapshot 时刷新),前端只渲染 —— 不再各留一份判定实现。
      let schedule_states : Map[String, Json] = Map([])
      for row in snapshot.schedule_states {
        let item : Map[String, Json] = Map([])
        item.set("inside", Json::boolean(row.inside))
        if row.overridden {
          item.set("overridden", Json::boolean(true))
        }
        match row.blocked_by {
          Some(b) => item.set("blockedBy", Json::string(b))
          None => ()
        }
        match row.next_change_at {
          Some(at) => item.set("nextChangeAt", Json::number(at.to_double()))
          None => ()
        }
        item.set("summary", Json::string(row.summary))
        schedule_states.set(row.id, Json::object(item))
      }
      map.set("scheduleStates", Json::object(schedule_states))
      match snapshot.schedule_banner {
        Some(banner) => {
          let item : Map[String, Json] = Map([])
          item.set("visible", Json::boolean(banner.visible))
          item.set(
            "blockedBySchedule",
            Json::number(banner.blocked_by_schedule.to_double()),
          )
          item.set("total", Json::number(banner.total.to_double()))
          match banner.next_change_at {
            Some(at) => item.set("nextChangeAt", Json::number(at.to_double()))
            None => ()
          }
          match banner.override_until {
            Some(until) =>
              item.set("overrideUntil", Json::number(until.to_double()))
            None => ()
          }
          map.set("scheduleBanner", Json::object(item))
        }
        None => ()
      }
    }
    None => ()
  }
  Json::object(map)
}

///|
/// syncProgress 聚合行 → 前端 SyncProgressItem(字段名与形态逐字对齐
/// web/types.ts,语义来源 Node src/status.ts 的 SyncProgress)。可选字段
/// 只在有值时上线:窗口内该方向无字节则速率字段省略,无传输则 files 整个
/// 省略 —— 空闲快照保持最小,差异驱动的 ws 推送不会多推帧。
pub fn sync_progress_json(items : Array[@daemon.SyncProgress]) -> Array[Json] {
  let rows : Array[Json] = []
  for item in items {
    let map : Map[String, Json] = Map([])
    map.set("folder", Json::string(item.folder))
    map.set("pending", Json::number(item.pending.to_double()))
    map.set("sending", Json::number(item.sending.to_double()))
    map.set("receiving", Json::number(item.receiving.to_double()))
    match item.send_rate {
      Some(rate) => map.set("sendRate", Json::number(rate))
      None => ()
    }
    match item.receive_rate {
      Some(rate) => map.set("receiveRate", Json::number(rate))
      None => ()
    }
    match item.files {
      Some(files) => {
        let entries : Array[Json] = []
        for f in files {
          let row : Map[String, Json] = Map([])
          row.set("path", Json::string(f.path))
          row.set("direction", Json::string(f.direction))
          row.set("bytesDone", Json::number(f.bytes_done.to_double()))
          row.set("bytesTotal", Json::number(f.bytes_total.to_double()))
          if f.priority {
            row.set("priority", Json::boolean(true))
          }
          entries.push(Json::object(row))
        }
        map.set("files", Json::array(entries))
      }
      None => ()
    }
    rows.push(Json::object(map))
  }
  rows
}

///|
/// 流量统计 → 前端 TrafficData(累计 + 已完成窗口的采样序列;samples 每条
/// 是窗口内增量,sent/received 为 daemon 启动以来的累计)。
pub fn traffic_json(stats : @daemon.TrafficStats) -> Json {
  let map : Map[String, Json] = Map([])
  map.set("sent", Json::number(stats.sent.to_double()))
  map.set("received", Json::number(stats.received.to_double()))
  let samples : Array[Json] = []
  for sample in stats.samples {
    let row : Map[String, Json] = Map([])
    row.set("at", Json::number(sample.at.to_double()))
    row.set("sent", Json::number(sample.sent.to_double()))
    row.set("received", Json::number(sample.received.to_double()))
    samples.push(Json::object(row))
  }
  map.set("samples", Json::array(samples))
  Json::object(map)
}

///|
/// 站点图标(SVG 源码)。真值在 src/favicon.ts(Node 侧内联常量),
/// Rust 侧复制于 syncx-api/src/favicon.svg —— 三处逐字同源,改图标要一起动。
/// 内联常量而非读盘:单文件/独立部署形态下没有 web/ 目录可用。
const FAVICON_SVG : String = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\">\n<rect width=\"32\" height=\"32\" rx=\"7\" fill=\"#0F6E56\"/>\n<g fill=\"none\" stroke=\"#FFFFFF\" stroke-width=\"2.4\" stroke-linecap=\"round\">\n<path d=\"M8.5 13H20\"/>\n<path d=\"M24 19H12\"/>\n</g>\n<path d=\"M20 10.5 24.5 13 20 15.5Z\" fill=\"#FFFFFF\"/>\n<path d=\"M12 16.5 7.5 19 12 21.5Z\" fill=\"#FFFFFF\"/>\n</svg>\n"

///|
/// 页面壳占位 HTML。dist/web 未配置/不存在时的兜底;
/// 路由面(`/`、`/login`、`/compare*` 等)与 Rust `is_shell_path` 一致。
pub fn index_html() -> String {
  let mut html = "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\" />"
  html = html +
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />"
  html = html + "<title>syncx</title></head><body>"
  html = html + "<h1>syncx (moonbit)</h1>"
  html = html +
    "<p>前端资源未配置(设置 SYNCX_WEB_DIST 指向 dist/web 目录)。</p>"
  html + "</body></html>"
}

///|
/// 凭据校验:cookie 里的值可以是 control.token 原文,也可以是签名会话
/// (对齐 Rust `SessionAuth::credential_ok`)。空串一律不通过。
pub async fn credential_ok(
  raw : String,
  control_token : String,
  auth_file : String?,
) -> Bool {
  if raw == "" {
    return false
  }
  if control_token != "" && safe_equal(raw, control_token) {
    return true
  }
  let secret = session_secret(session_base(control_token, auth_file))
  verify_session(raw, secret) is Some(_)
}

///|
/// 认证门中间件:挂在 `/api` 子树,校验 `syncx_session` 会话 cookie。
/// 未通过时回 401 + `{"error":"unauthorized"}`(Node 同款响应体)。
pub fn auth_middleware(options : ApiOptions) -> @mocket.Middleware {
  (event, next) => {
    // 免认证子集(对齐 Node/Rust 的门次序):登录/登出/登录页信息
    // 必须在门内放行,否则连登录都进不去。
    match event.req.url {
      "/api/auth" | "/api/login" | "/api/logout" => return next()
      _ => ()
    }
    let authenticated = match event.req.get_cookie(SESSION_COOKIE) {
      Some(cookie) =>
        credential_ok(cookie.value, options.control_token, options.auth_file)
      None => false
    }
    if authenticated {
      next()
    } else {
      // 未通过认证也要把 body 消费掉(MemoryReader 写协程等它收尾)
      drain_body(event)
      @mocket.HttpResponse(@mocket.Unauthorized).json({
        "error": "unauthorized",
      })
    }
  }
}

///|
/// GET /api/auth(公开):登录页据此决定渲染账号密码还是令牌表单。
pub async fn handle_auth_info(
  options : ApiOptions,
  _event : @mocket.MocketEvent,
) -> &Responder {
  let account = match options.auth_file {
    Some(file) => load_account(file)
    None => None
  }
  let map : Map[String, Json] = Map([])
  match account {
    Some(record) => {
      map.set("mode", Json::string("password"))
      map.set("username", Json::string(record.username))
    }
    None => map.set("mode", Json::string("token"))
  }
  if options.auth_file is None {
    map.set("passwordLogin", Json::boolean(false))
  }
  let config_dir = config_dir_of(options.config_file)
  if config_dir != "" {
    map.set("configDir", Json::string(config_dir))
  }
  @mocket.HttpResponse(@mocket.OK).json(Json::object(map))
}

///|
/// 取路径的目录部分(最后一个 `/` 之前;无 `/` 回空串)。
fn config_dir_of(path : String) -> String {
  match path.rev_find("/") {
    Some(i) => path[0:i].to_owned()
    None => ""
  }
}

///|
/// POST /api/login:账号密码登录。成功下发签名会话 cookie;失败 401。
/// TODO(daemon):登录限速(Rust login.remaining 同款)是后续里程碑。
pub async fn handle_login(
  options : ApiOptions,
  event : @mocket.MocketEvent,
) -> &Responder {
  let file = match options.auth_file {
    Some(file) => file
    None => {
      drain_body(event)
      return json_error(event, @mocket.NotFound, "未启用账号密码登录")
    }
  }
  let body = match parse_json_body(event) {
    Some(body) => body
    None => return json_error(event, @mocket.BadRequest, "invalid json body")
  }
  let (username, password) = match body {
    Object(obj) => {
      let username = match obj.get("username") {
        Some(String(s)) => s
        _ => ""
      }
      let password = match obj.get("password") {
        Some(String(s)) => s
        _ => ""
      }
      (username, password)
    }
    _ => return json_error(event, @mocket.BadRequest, "invalid json body")
  }
  if username == "" || password == "" {
    return json_error(
      event,
      @mocket.BadRequest,
      "用户名和密码不能为空",
    )
  }
  match load_account(file) {
    Some(record) =>
      if verify_password(record, username, password) {
        let value = session_cookie_value(
          { via: "password", sub: username, exp: now_ms() + SESSION_TTL_MS, },
          options.control_token,
          options.auth_file,
        )
        let response = @mocket.HttpResponse(@mocket.OK).json(ok_true())
        response.headers.set(
          "Set-Cookie",
          cookie_header(SESSION_COOKIE, value, SESSION_TTL_MS / 1000L),
        )
        response.to_responder()
      } else {
        json_error(event, @mocket.Unauthorized, "用户名或密码错误")
      }
    None => json_error(event, @mocket.Unauthorized, "用户名或密码错误")
  }
}

///|
/// POST /api/logout:清 cookie(会话本身无状态,服务端不用记)。
pub fn handle_logout(
  _options : ApiOptions,
  _event : @mocket.MocketEvent,
) -> &Responder {
  let response = @mocket.HttpResponse(@mocket.OK).json(ok_true())
  response.headers.set("Set-Cookie", clear_cookie_header(SESSION_COOKIE))
  response.to_responder()
}

///|
/// POST /login(公开):令牌登录(恢复通道)。成功 302 回 `/` 并下发签名会话;
/// 失败回页面壳(不区分「token 错」与「页面不存在」,避免爆破侧信道)。
pub async fn handle_token_login(
  options : ApiOptions,
  event : @mocket.MocketEvent,
) -> &Responder {
  let text : String = event.body() catch { _ => "" }
  let params = @mocket.parse_form_data(@utf8.encode(text).exact_view())
  let token = params.get("token").unwrap_or("")
  let accepted = token != "" &&
    options.control_token != "" &&
    safe_equal(token, options.control_token)
  if accepted {
    let value = session_cookie_value(
      { via: "token", sub: "token", exp: now_ms() + SESSION_TTL_MS, },
      options.control_token,
      options.auth_file,
    )
    let response = @mocket.HttpResponse(@mocket.Found, body="")
    response.headers.set(
      "Set-Cookie",
      cookie_header(SESSION_COOKIE, value, SESSION_TTL_MS / 1000L),
    )
    response.headers.set("Location", "/")
    response.to_responder()
  } else {
    @mocket.html(index_html())
  }
}

///|
/// 组装路由。分发顺序即安全边界(对齐 Rust routes/mod.rs 的门次序):
/// 免认证探活/登录/页面壳在前,`/api` 子树统一过认证门。
pub fn build_app(options : ApiOptions) -> @mocket.App {
  let app = @mocket.App()
  app.use_middleware(auth_middleware(options), base_path="/api")
  // 免认证面
  app.get("/health", _event => health_json())
  app.get("/api/auth", event => handle_auth_info(options, event))
  app.post("/api/login", event => handle_login(options, event))
  app.post("/api/logout", event => handle_logout(options, event))
  app.post("/login", event => handle_token_login(options, event))
  // 已认证面(过认证门)
  app.get("/api/status", _event => status_json(options))
  app.get("/api/folders", event => handle_list_folders(options, event))
  app.post("/api/folders", event => handle_add_folder(options, event))
  app.post("/api/pause", event => handle_pause(options, event))
  app.post("/api/folders/schedule", event => {
    handle_folder_schedule(options, event)
  })
  app.post("/api/schedule/override", event => {
    handle_schedule_override(options, event)
  })
  app.post("/api/folders/git-strip-co-authored", event => {
    handle_folder_git_strip_co_authored(options, event)
  })
  // Git 弹窗数据面(改动/对比/历史/提交文件/未推送/推送)
  app.get("/api/folders/git-changes", event => {
    handle_git_changes(options, event)
  })
  app.get("/api/folders/git-diff", event => handle_git_diff(options, event))
  app.get("/api/folders/git-log", event => handle_git_log(options, event))
  app.get("/api/folders/git-commit-files", event => {
    handle_git_commit_files(options, event)
  })
  app.get("/api/folders/git-commit-diff", event => {
    handle_git_commit_diff(options, event)
  })
  app.get("/api/folders/git-unpushed", event => {
    handle_git_unpushed(options, event)
  })
  app.post("/api/folders/git-push", event => handle_git_push(options, event))
  app.post("/api/folders/git-strip-coauthored-unpushed", event => {
    handle_git_strip_coauthored_unpushed(options, event)
  })
  app.get("/api/folders/git-commit-status", event => {
    handle_git_commit_status(options, event)
  })
  app.post("/api/folders/git-index-lock/delete", event => {
    handle_git_index_lock_delete(options, event)
  })
  app.post("/api/folders/git-commit-retry", event => {
    handle_git_commit_retry(options, event)
  })
  // 文件版本(时间机器)与回收站操作面:列表/恢复/删除/预览 + 列表/还原/
  // 清理(对齐 Node /api/folders/versions* 与 /api/trash*;详见 versions.mbt)
  app.get("/api/folders/versions", event => {
    handle_list_folder_versions(options, event)
  })
  app.post("/api/folders/versions/restore", event => {
    handle_restore_folder_version(options, event)
  })
  app.post("/api/folders/versions/delete", event => {
    handle_delete_folder_version(options, event)
  })
  app.get("/api/folders/versions/content", event => {
    handle_folder_version_content(options, event)
  })
  app.get("/api/trash", event => handle_list_folder_trash(options, event))
  app.post("/api/trash/restore", event => {
    handle_restore_folder_trash(options, event)
  })
  app.post("/api/trash/purge", event => {
    handle_purge_folder_trash(options, event)
  })
  // 空文件夹工具:盘点(只读)与删除(只 rmdir、绝不删文件;刻意不触发扫描、
  // 不碰索引 —— 目录不是同步实体,删空目录没有任何东西需要广播,见 emptydirs.mbt)
  app.get("/api/folders/empty-dirs", event => {
    handle_list_empty_dirs(options, event)
  })
  app.post("/api/folders/empty-dirs/delete", event => {
    handle_delete_empty_dirs(options, event)
  })
  app.get("/api/devices", event => handle_list_devices(options, event))
  // 设备增删(前端添加/移除设备;POST 走 body,DELETE 走 ?deviceId= 查询参数)
  app.post("/api/devices", event => handle_add_device(options, event))
  app.delete("/api/devices", event => handle_remove_device(options, event))
  app.post("/api/shutdown", event => handle_shutdown(options, event))
  // 上传安装包换入(预检只读;换入成功后旧进程由看门狗请退,见 upload.mbt)
  app.post("/api/self-update/upload/inspect", event => {
    handle_upload_inspect(options, event)
  })
  app.post("/api/self-update/upload", event => {
    handle_upload_swap(options, event)
  })
  // 站点图标:免认证公开资源(浏览器 tab logo)。/favicon.ico 显式 204,
  // 避免浏览器自动请求落到 404/401 分支误导排查(对齐 Node/Rust)
  app.get("/favicon.svg", _event => {
    @mocket.HttpResponse(
      @mocket.OK,
      headers={
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, max-age=86400",
      },
      body=@mocket.text(FAVICON_SVG),
    )
  })
  app.get("/favicon.ico", _event => @mocket.HttpResponse(@mocket.NoContent))
  // 静态资源 / 占位页(最后兜底)
  match options.web_dist {
    Some(dist) => mount_static(app, dist)
    None => ()
  }
  // 占位路由常驻:dist 未配置或缺 index.html 时的兜底
  app.get("/", _event => @mocket.html(index_html()))
  app
}

///|
// 起服务的 `serve` 在 ws.mbt:HTTP 面与 `/api/events` WS 推送共用一条
// 自管监听(原因见 ws.mbt 文件头)。
