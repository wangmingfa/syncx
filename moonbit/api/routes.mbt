///|
/// 路由面扩充(本里程碑的最小可用集,数据从 config.json 读写):
///   - GET  /api/folders :全部共享目录(字段名与 config.json 逐字一致);
///   - POST /api/folders :添加目录(201 + `{ok:true,created:bool}`,Node 同款);
///   - POST /api/pause   :全局暂停/恢复(一律落盘字面量,取消写 false 不删键);
///   - GET  /api/devices :已知设备(knownDevices 透出);
///   - POST /api/shutdown:优雅关闭(响应冲出后再走关闭链路)。
/// 错误文案与 Node/Rust 逐字复制 —— 它们是前端直接展示的字符串。
using @mocket {trait Responder}

///|
/// 丢弃请求体。只用于「不读 body 就短路」的路径(401/404/503):
/// mocket dispatch 的 MemoryReader 写协程要等 body 被消费才收尾,
/// 丢着不管会卡住事件循环;真实服务侧丢弃剩余 body 本就是标准行为。
async fn drain_body(event : @mocket.MocketEvent) -> Unit {
  let _ : Bytes = event.body() catch { _ => b"" }
}

///|
/// JSON 错误响应:`{"error": <message>}`(Node sendJson 同款)。
fn json_error(status : @mocket.StatusCode, message : String) -> &Responder {
  let map : Map[String, Json] = Map([])
  map.set("error", Json::string(message))
  @mocket.HttpResponse(status).json(Json::object(map))
}

///|
/// `{"ok": true}`(Node util::ok_true 同款)。
fn ok_true() -> Json {
  let map : Map[String, Json] = Map([])
  map.set("ok", Json::boolean(true))
  Json::object(map)
}

///|
/// 读请求体并按 JSON 解析;失败回 400 `{"error":"invalid json body"}`。
/// 空 body 按 `{}` 处理(与 Node `raw === '' ? {} : JSON.parse(raw)` 同口径)。
async fn parse_json_body(event : @mocket.MocketEvent) -> Json? noraise {
  let text : String = event.body() catch { _ => return None }
  if text.trim().to_owned() == "" {
    return Some(Json::object(Map([])))
  }
  let json = @json.parse(text) catch { _ => return None }
  Some(json)
}

///|
/// 取非空字符串字段(`typeof x !== 'string' || x === ''` 的反面)。
fn non_empty_string(obj : Map[String, Json], key : String) -> String? {
  match obj.get(key) {
    Some(String(s)) => if s != "" { Some(s) } else { None }
    _ => None
  }
}

///|
/// 取字符串数组字段(非字符串元素剔除,与 Node `.filter(typeof === 'string')` 同口径)。
fn string_array_of(obj : Map[String, Json], key : String) -> Array[String] {
  match obj.get(key) {
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
/// 一台已知设备的 JSON(铺在 extra 之上,未知键原样保留)。
fn device_to_json(device : @core.DeviceConfig) -> Json {
  let map : Map[String, Json] = Map([])
  for key, value in device.extra {
    map.set(key, value)
  }
  map.set("id", Json::string(device.id))
  match device.name {
    Some(name) => map.set("name", Json::string(name))
    None => ()
  }
  Json::object(map)
}

///|
/// 随机短 id(目录无显式 id 时兜底)。TODO(daemon):对齐 Rust short_id 长度。
fn short_id() -> String {
  let raw = match @env.rand(8) {
    Some(bytes) => bytes
    None => @utf8.encode(now_ms().to_string())
  }
  @lib.bytes_to_hex(raw)
}

///|
/// GET /api/folders:全部共享目录。
pub async fn handle_list_folders(
  options : ApiOptions,
  _event : @mocket.MocketEvent,
) -> &Responder {
  let config = load_config(options.config_file)
  let arr : Array[Json] = []
  for folder in config.shared_folders {
    arr.push(folder.to_json())
  }
  let map : Map[String, Json] = Map([])
  map.set("ok", Json::boolean(true))
  map.set("folders", Json::array(arr))
  @mocket.HttpResponse(@mocket.OK).json(Json::object(map))
}

///|
/// POST /api/folders:添加目录。
pub async fn handle_add_folder(
  options : ApiOptions,
  event : @mocket.MocketEvent,
) -> &Responder {
  let body = match parse_json_body(event) {
    Some(body) => body
    None => return json_error(@mocket.BadRequest, "invalid json body")
  }
  let obj = match body {
    Object(obj) => obj
    _ => return json_error(@mocket.BadRequest, "invalid json body")
  }
  let path = match non_empty_string(obj, "path") {
    Some(path) => path
    None => return json_error(@mocket.BadRequest, "path is required")
  }
  let devices = string_array_of(obj, "devices")
  let id = non_empty_string(obj, "id")
  let receive_only = obj.get("receiveOnly") is Some(True)
  let config = load_config(options.config_file)
  let created = match
    add_folder_to_config(config, path, devices, id, receive_only) {
    Ok(created) => created
    Err(message) => return json_error(@mocket.BadRequest, message)
  }
  if created {
    // 目录不存在时自动创建(与 Node addFolder 同款);失败按 Node 兜底文案回 400
    if !@fs.exists(path) {
      @fs.mkdir(path, recursive=true, allow_exist=true) catch {
        _ =>
          return json_error(
            @mocket.BadRequest,
            "创建目录失败(目录为空?路径正确?)",
          )
      }
    }
  }
  save_config(options.config_file, config) catch {
    _ => return json_error(@mocket.BadRequest, "invalid json body")
  }
  // TODO(daemon):目录登记后通知 daemon 重载配置并开新索引
  let map : Map[String, Json] = Map([])
  map.set("ok", Json::boolean(true))
  map.set("created", Json::boolean(created))
  @mocket.HttpResponse(@mocket.Created).json(Json::object(map))
}

///|
/// POST /api/pause:全局暂停/恢复。写的是配置(纯数据),一律落盘字面量,
/// 取消时写 false 而不是删键(与 Node setGlobalPaused 同款)。
pub async fn handle_pause(
  options : ApiOptions,
  event : @mocket.MocketEvent,
) -> &Responder {
  let body = match parse_json_body(event) {
    Some(body) => body
    None => return json_error(@mocket.BadRequest, "invalid json body")
  }
  let paused = match body {
    Object(obj) => obj.get("paused") is Some(True)
    _ => return json_error(@mocket.BadRequest, "invalid json body")
  }
  let config = load_config(options.config_file)
  config.paused = Some(paused)
  save_config(options.config_file, config) catch {
    _ => return json_error(@mocket.BadRequest, "invalid json body")
  }
  // TODO(daemon):落盘后通知装配层重载,让 daemon 立刻生效
  @mocket.HttpResponse(@mocket.OK).json(ok_true())
}

///|
/// GET /api/devices:已知设备列表。
pub async fn handle_list_devices(
  options : ApiOptions,
  _event : @mocket.MocketEvent,
) -> &Responder {
  let config = load_config(options.config_file)
  let arr : Array[Json] = []
  for device in config.known_devices {
    arr.push(device_to_json(device))
  }
  let map : Map[String, Json] = Map([])
  map.set("ok", Json::boolean(true))
  map.set("devices", Json::array(arr))
  @mocket.HttpResponse(@mocket.OK).json(Json::object(map))
}

///|
/// POST /api/shutdown:优雅关闭。先让响应冲出内核缓冲,再走关闭链路
/// (Node 同款 50ms 延迟);装配层未注入回调时回 503。
pub async fn handle_shutdown(
  options : ApiOptions,
  _event : @mocket.MocketEvent,
) -> &Responder {
  match options.on_shutdown {
    None => json_error(@mocket.ServiceUnavailable, "shutdown not available")
    Some(shutdown) => {
      // body 不参与本路由,显式丢弃(见 drain_body 注释)
      drain_body(_event)
      // TODO(cli):换成真正的后台任务派发,避免占住请求线程 50ms
      @async.sleep(50)
      shutdown()
      let map : Map[String, Json] = Map([])
      map.set("ok", Json::boolean(true))
      map.set("msg", Json::string("shutting down"))
      @mocket.HttpResponse(@mocket.OK).json(Json::object(map))
    }
  }
}
