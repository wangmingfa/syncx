///|
/// 上传安装包换入:POST /api/self-update/upload[/inspect](ADR-0026 延伸)。
///
/// 请求体是安装包的原始字节(application/octet-stream,不走 multipart,
/// 与 Node/Rust 同口径)。本文件只做路由与响应面;识别与换入的实现经
/// `ApiOptions.upload_inspect` / `upload_swap` 回调由 cli 装配层注入 ——
/// api 包不依赖 cli(依赖方向是 cli → api),包识别/看门狗代码都在 cli 侧
/// (cli/upload.mbt、cli/update.mbt)。
///
/// 响应面与 Node `src/api/routes/system.ts` 逐字对齐:
///   - dev 运行态:400 + `{ok:false, error}`,最后一道防线(前端入口已拦);
///   - 装配层未注入回调:503 + `{error:"upload update not available"}`;
///   - 识别/换入失败:400 + `{ok:false, error}`(文案由 cli 侧给出)。
/// 成功的 inspect 额外带 `backend` / `target` 字段(后端包),
/// 供前端在确认前展示「将换入哪个后端、哪个版本、哪个目标平台」。

///|
/// dev 运行态拒绝文案(与 Node 逐字一致)。
pub const DEV_UPDATE_REJECT : String = "开发模式下不支持升级功能（运行态为 dev，无单文件运行时可替换）"

///|
/// 一次上传预检的结论(纯数据,api 包不关心包是怎么解出来的)。
pub(all) struct InspectedPackage {
  /// `node | rust | moonbit`(npm tgz / syncx-rs 包 / syncx-mbt 包)。
  backend : String
  /// 包内版本号(semver,已校验格式)。
  version : String
  /// 后端包的目标三元组(如 aarch64-apple-darwin);npm 包为 None。
  target : String?
  /// npm 包的包名;后端包为 None。
  name : String?
}

///|
/// 上传预检回调:原始包字节 → 包信息。实现见 cli/upload.mbt。
pub type UploadInspectFn = async (Bytes) -> Result[InspectedPackage, String]

///|
/// 上传换入回调:原始包字节 → 将要换入的版本号。实现见 cli/upload.mbt;
/// 成功即已写好看门狗作业,旧进程由看门狗在宽限期后请退(见 update.mbt)。
pub type UploadSwapFn = async (Bytes) -> Result[String, String]

///|
/// POST /api/self-update/upload/inspect:只读预检。不派发看门狗、不动任何
/// 运行期状态,供前端在用户确认前展示版本对比(包内版本是权威值 ——
/// 上传来源没有「宣告版本」,只能由包自己说了算)。
pub async fn handle_upload_inspect(
  options : ApiOptions,
  event : @mocket.MocketEvent,
) -> &Responder {
  if options.dev_mode {
    return update_reject_dev(event)
  }
  let inspect = match options.upload_inspect {
    Some(inspect) => inspect
    None => {
      drain_body(event)
      return json_error(
        @mocket.ServiceUnavailable,
        "upload update not available",
      )
    }
  }
  // 请求体即包的原始字节;读不出来按坏请求处理
  let bytes : Bytes = event.body() catch {
    _ => return update_error_response("读取上传内容失败")
  }
  let info = inspect(bytes) catch {
    e => return update_error_response("安装包预检失败:\{e}")
  }
  match info {
    Ok(info) => {
      let map : Map[String, Json] = Map([])
      map.set("ok", Json::boolean(true))
      map.set("backend", Json::string(info.backend))
      map.set("version", Json::string(info.version))
      map.set("current", Json::string(@core.VERSION))
      match info.target {
        Some(target) => map.set("target", Json::string(target))
        None => ()
      }
      match info.name {
        Some(name) => map.set("name", Json::string(name))
        None => ()
      }
      @mocket.HttpResponse(@mocket.OK).json(Json::object(map)).to_responder()
    }
    Err(message) => update_error_response(message)
  }
}

///|
/// POST /api/self-update/upload:真换入。成功响应 `{ok:true,version,
/// restarting:true}` 后**不**主动关闭 —— 优雅退出由 detached 看门狗在
/// 宽限期后向本进程发 SIGTERM 兜底(见 cli/update.mbt 的 kill_parent_ms):
/// MoonBit 异步层没有可脱离请求生命周期的后台任务,看门狗是唯一能保证
/// 「响应已冲出内核缓冲,旧进程才退出」的执行体。
pub async fn handle_upload_swap(
  options : ApiOptions,
  event : @mocket.MocketEvent,
) -> &Responder {
  if options.dev_mode {
    return update_reject_dev(event)
  }
  let swap = match options.upload_swap {
    Some(swap) => swap
    None => {
      drain_body(event)
      return json_error(
        @mocket.ServiceUnavailable,
        "upload update not available",
      )
    }
  }
  let bytes : Bytes = event.body() catch {
    _ => return update_error_response("读取上传内容失败")
  }
  let result = swap(bytes) catch {
    e => return update_error_response("安装包换入失败:\{e}")
  }
  match result {
    Ok(version) => {
      let map : Map[String, Json] = Map([])
      map.set("ok", Json::boolean(true))
      map.set("version", Json::string(version))
      map.set("restarting", Json::boolean(true))
      @mocket.HttpResponse(@mocket.OK).json(Json::object(map)).to_responder()
    }
    Err(message) => update_error_response(message)
  }
}

///|
/// dev 运行态拒绝(Node 同款 400 响应体)。
async fn update_reject_dev(event : @mocket.MocketEvent) -> &Responder {
  drain_body(event)
  update_error_response(DEV_UPDATE_REJECT)
}

///|
/// 自更新面统一错误响应:400 + `{ok:false, error}`(Node sendJson 同款)。
fn update_error_response(message : String) -> &Responder {
  let map : Map[String, Json] = Map([])
  map.set("ok", Json::boolean(false))
  map.set("error", Json::string(message))
  @mocket.HttpResponse(@mocket.BadRequest).json(Json::object(map))
}
