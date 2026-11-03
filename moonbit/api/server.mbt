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
  /// None = 不上线该段。MoonBit 尚无配置热重载,当前值为启动时快照)。
  settings : Json?
  /// peer 数据面监听端口(`/api/status.peerPort`,顶栏本机信息浮层用;
  /// cli 装配时从启动参数注入,缺省 22000;None = 未注入,不上线该字段)。
  peer_port : Int32?
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
  map.set("devices", Json::array([]))
  map.set("syncProgress", Json::array([]))
  map.set("offers", Json::array([]))
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
    }
    None => ()
  }
  Json::object(map)
}

///|
/// 站点图标(SVG 源码)。真值在 src/favicon.ts(Node 侧内联常量),
/// Rust 侧复制于 syncx-api/src/favicon.svg —— 三处逐字同源,改图标要一起动。
/// 内联常量而非读盘:单文件/独立部署形态下没有 web/ 目录可用。
const FAVICON_SVG : String =
  "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\">\n<rect width=\"32\" height=\"32\" rx=\"7\" fill=\"#0F6E56\"/>\n<g fill=\"none\" stroke=\"#FFFFFF\" stroke-width=\"2.4\" stroke-linecap=\"round\">\n<path d=\"M8.5 13H20\"/>\n<path d=\"M24 19H12\"/>\n</g>\n<path d=\"M20 10.5 24.5 13 20 15.5Z\" fill=\"#FFFFFF\"/>\n<path d=\"M12 16.5 7.5 19 12 21.5Z\" fill=\"#FFFFFF\"/>\n</svg>\n"

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
      return json_error(@mocket.NotFound, "未启用账号密码登录")
    }
  }
  let body = match parse_json_body(event) {
    Some(body) => body
    None => return json_error(@mocket.BadRequest, "invalid json body")
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
    _ => return json_error(@mocket.BadRequest, "invalid json body")
  }
  if username == "" || password == "" {
    return json_error(@mocket.BadRequest, "用户名和密码不能为空")
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
        json_error(@mocket.Unauthorized, "用户名或密码错误")
      }
    None => json_error(@mocket.Unauthorized, "用户名或密码错误")
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
  app.post("/api/folders/git-strip-co-authored", event => {
    handle_folder_git_strip_co_authored(options, event)
  })
  app.get("/api/devices", event => handle_list_devices(options, event))
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
  app.get("/favicon.svg", _event =>
    @mocket.HttpResponse(
      @mocket.OK,
      headers={
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, max-age=86400",
      },
      body=@mocket.text(FAVICON_SVG),
    ))
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
