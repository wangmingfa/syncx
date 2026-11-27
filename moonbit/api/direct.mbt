///|
using @mocket {trait Responder}

/// 设备间直发的 HTTP 面(ADR-0028):本机浏览器 → 本机 daemon → 已握手 P2P
/// 会话。语义与 Node `src/api/routes/direct.ts` 逐条对齐;差异(刻意):
///  - zip 打包与「另存到指定目录」(saveTo)未实现,对应入口回 503 ——
///    前端按 `status.direct.zip === true` 决定是否显示打包勾选,不会触发;
///  - 大文件不流式:MoonBit HTTP 层(mocket)整读请求体,上传体已在内存,
///    落盘是单次写出 —— 与自更新上传同款口径,上限同为 100MB;指纹由
///    daemon 一次算完(Node 是边收边算, LAN HTTP 下前端没有 crypto.subtle,
///    指纹本来就归 daemon 管)。

///|
/// 一次发送最多选 20 台:避免浏览器误点「全选」时把 daemon 打满。
const DIRECT_MAX_TARGETS : Int = 20

///|
/// 查询串里的重复键要全部收集(mocket 的 query() 会折叠重名,多设备投送
/// 靠重复的 deviceIds 参数,必须自己解析原始查询串)。
fn direct_query_values(query : String, key : String) -> Array[String] {
  let out : Array[String] = []
  for part in query.split("&") {
    let text = part.to_owned()
    let (k, v) = match text.find("=") {
      Some(idx) => (text[:idx].to_string(), text[idx + 1:].to_string())
      None => (text, "")
    }
    // 与 Node URLSearchParams 同口径:键值都做 URL 解码(文件名走查询串
    // 时是百分号编码)。键也解码,防误匹配。
    if v != "" && @mocket.url_decode(@utf8.encode(k)[:]) == key {
      out.push(@mocket.url_decode(@utf8.encode(v)[:]))
    }
  }
  out
}

///|
/// 目标设备去重:去空、按首现顺序保留。
fn dedup_targets(values : Array[String]) -> Array[String] {
  let ids : Array[String] = []
  let seen : Map[String, Bool] = Map([])
  for value in values {
    let id = value.trim().to_owned()
    if id == "" || seen.contains(id) {
      continue
    }
    seen.set(id, true)
    ids.push(id)
  }
  ids
}

///|
/// 兼容旧的单设备 deviceId 与新的多设备 deviceIds,去重并保持传入顺序。
fn parse_direct_targets(single : Array[String], many : Array[String]) -> Array[String] {
  let all : Array[String] = []
  for value in single {
    all.push(value)
  }
  for value in many {
    all.push(value)
  }
  dedup_targets(all)
}

///|
/// 逐台投送:某台离线/旧版本不影响其它设备,失败原因随结果返回给 UI。
async fn dispatch_direct(
  ids : Array[String],
  transport_of : (String) -> @direct.DirectTransport?,
  send : async (String, @direct.DirectTransport?) -> Result[@direct.DirectSendAck, String],
) -> Array[Json] {
  let results : Array[Json] = []
  for device_id in ids {
    let row : Map[String, Json] = Map([])
    row.set("deviceId", Json::string(device_id))
    let outcome : Result[@direct.DirectSendAck, String] = send(
      device_id,
      transport_of(device_id),
    ) catch {
      e => Err("\{e}")
    }
    match outcome {
      Ok(ack) => {
        row.set("id", Json::string(ack.id))
        if ack.queued {
          row.set("queued", Json::boolean(true))
        }
      }
      Err(message) => row.set("error", Json::string(message))
    }
    results.push(Json::object(row))
  }
  results
}

///|
/// 保留单设备响应里的 id,老前端拿到它就能继续工作。
fn send_direct_batch(
  ids : Array[String],
  results : Array[Json],
) -> &Responder {
  let map : Map[String, Json] = Map([])
  for row in results {
    match row {
      Object(fields) =>
        match fields.get("id") {
          Some(id) => {
            map.set("id", id)
            break
          }
          None => ()
        }
      _ => ()
    }
  }
  let id_arr : Array[Json] = []
  for id in ids {
    id_arr.push(Json::string(id))
  }
  map.set("ids", Json::array(id_arr))
  map.set("results", Json::array(results))
  @mocket.HttpResponse(@mocket.OK).json(Json::object(map))
}

///|
/// 路由注册用的小包装:mocket 的 handler 签名要求直接返回响应体,而
/// 分发器语义上可能「未命中」(理论不可达 —— 注册的模式已锁定前缀)。
async fn dispatch_direct_routes(
  options : ApiOptions,
  event : @mocket.MocketEvent,
) -> &Responder {
  let outcome = try_direct_routes(options, event) catch {
    _ => Some(json_error(event, @mocket.InternalServerError, "直发请求处理失败"))
  }
  match outcome {
    Some(response) => response
    None => json_error(event, @mocket.NotFound, "not found")
  }
}

///|
/// 直发域分发器:各 /api/direct 路由都指向它,由它按 url 再细分。
/// 未命中返回 None 交还主分发(理论不可达 —— 路由模式已经锁定了前缀)。
pub async fn try_direct_routes(
  options : ApiOptions,
  event : @mocket.MocketEvent,
) -> &Responder? {
  let path = event.req.url
  if !path.has_prefix("/api/direct") {
    return None
  }
  let direct = match options.direct {
    Some(direct) => direct
    None => {
      return Some(
        json_error(event, @mocket.ServiceUnavailable, "当前后端不支持设备间直发"),
      )
    }
  }
  let transport_of = device_id => {
    match options.direct_transport {
      Some(f) => f(device_id)
      None => None
    }
  }
  // GET /api/direct/inbox : 元数据快照(正文不进状态,按需另取)
  if path == "/api/direct/inbox" {
    return Some(@mocket.HttpResponse(@mocket.OK).json(direct.snapshot_json()))
  }
  // GET /api/direct/inbox/:id/content : 文本/文件正文(下载用)
  let inbox_prefix = "/api/direct/inbox/"
  if path.has_prefix(inbox_prefix) && path.has_suffix("/content") {
    let middle = path[inbox_prefix.length():path.length() - "/content".length()].to_string()
    if middle == "" || middle.contains("/") || middle.contains("?") {
      return Some(json_error(event, @mocket.NotFound, "收件箱条目不存在"))
    }
    match direct.content(middle) {
      Some((item, data)) => {
        let mut name : String? = None
        match item {
          TextItem(_) => ()
          FileItem(f) => name = Some(f.name)
        }
        let response = @mocket.HttpResponse(@mocket.OK).body(data)
        match name {
          Some(file_name) => {
            response.headers.set("Content-Type", "application/octet-stream")
            response.headers.set(
              "Content-Disposition",
              "attachment; filename*=UTF-8''\{encode_attachment_name(file_name)}",
            )
          }
          None => response.headers.set("Content-Type", "text/plain; charset=utf-8")
        }
        response.headers.set("Cache-Control", "no-store")
        return Some(response)
      }
      None => {
        return Some(json_error(event, @mocket.NotFound, "收件箱条目不存在"))
      }
    }
  }
  // DELETE /api/direct/inbox/:id
  if path.has_prefix(inbox_prefix) {
    let id = path[inbox_prefix.length():].to_string()
    if id != "" && !id.contains("/") && !id.contains("?") {
      let ok = direct.remove(id)
      if ok {
        let response = @mocket.HttpResponse(@mocket.OK).json(ok_true())
        return Some(response)
      }
      return Some(json_error(event, @mocket.NotFound, "收件箱条目不存在"))
    }
    return Some(json_error(event, @mocket.NotFound, "收件箱条目不存在"))
  }
  // POST /api/direct/reply : 接收方确认/拒绝待确认文件(id 单条 / batchId 整组)
  if path == "/api/direct/reply" {
    return Some(handle_direct_reply(event, direct, transport_of))
  }
  // POST /api/direct/cancel : 取消一条仍在排队的投送(设备离线时才有)
  if path == "/api/direct/cancel" {
    return Some(handle_direct_cancel(event, direct))
  }
  // POST /api/direct/text : 发送一段文本(支持 deviceIds 多设备)
  if path == "/api/direct/text" {
    return Some(handle_direct_text(event, direct, transport_of))
  }
  // POST /api/direct/file?deviceIds=&name=&size=&batch= : 暂存 + 发起多设备文件直发
  if path == "/api/direct/file" {
    return Some(handle_direct_file(event, direct, transport_of))
  }
  // POST /api/direct/zip : 打包投送(MoonBit 未实现,按能力声明 zip:false 回 503)
  if path == "/api/direct/zip" {
    return Some(
      json_error(event, @mocket.ServiceUnavailable, "当前后端不支持打包投送"),
    )
  }
  None
}

///|
/// 解析 JSON 体并取对象(两条 POST 校验路由共用)。
async fn direct_json_object(
  event : @mocket.MocketEvent,
) -> Map[String, Json]? {
  let body = match parse_json_body(event) {
    Some(body) => body
    None => return None
  }
  match body {
    Object(obj) => Some(obj)
    _ => None
  }
}

///|
/// POST /api/direct/reply。
async fn handle_direct_reply(
  event : @mocket.MocketEvent,
  direct : @direct.DirectService,
  transport_of : (String) -> @direct.DirectTransport?,
) -> &Responder {
  let parsed = direct_json_object(event) catch { _ => None }
  let obj = match parsed {
    Some(obj) => obj
    None => {
      return json_error(event, @mocket.BadRequest, "invalid json body")
    }
  }
  let accept = match obj.get("accept") {
    Some(True) => true
    Some(False) => false
    _ => {
      return json_error(
        event,
        @mocket.BadRequest,
        "需要 id 或 batchId（二者取其一）以及 accept",
      )
    }
  }
  let id = match obj.get("id") {
    Some(String(raw)) => raw.trim().to_owned()
    _ => ""
  }
  let batch_id = match obj.get("batchId") {
    Some(String(raw)) => raw.trim().to_owned()
    _ => ""
  }
  // 二者取其一:id 是单条,batchId 是整组。同时给会让「到底处理了几条」变得含混。
  if (id == "" && batch_id == "") || (id != "" && batch_id != "") {
    return json_error(
      event,
      @mocket.BadRequest,
      "需要 id 或 batchId（二者取其一）以及 accept",
    )
  }
  // 「另存到指定目录」未实现:显式拒绝(与 Node 未注入 directSavePath 同文案口径;
  // 普通「接收」落 daemon 收件箱,不需要提权)。
  if obj.get("saveTo") is Some(_) {
    if !accept {
      return json_error(event, @mocket.BadRequest, "只有接收文件时才能指定保存目录")
    }
    return json_error(event, @mocket.ServiceUnavailable, "当前后端不支持另存到指定目录")
  }
  // 接收动作的回执通道按「这条提议的来源设备」寻址。body 里的 from 优先
  // (快照里给过前端);拿不到就按单条/批次台账里的来源(与 replyBatch 同口径)。
  let from = match obj.get("from") {
    Some(String(raw)) => raw.trim().to_owned()
    _ => ""
  }
  let from = if from != "" {
    from
  } else {
    match pending_from_of(direct, id, batch_id) {
      Some(from) => from
      None => {
        return json_error(event, @mocket.NotFound, "待确认项不存在或已处理")
      }
    }
  }
  let tx = match transport_of(from) {
    Some(tx) => tx
    None => {
      return json_error(event, @mocket.ServiceUnavailable, "该设备的会话已断开,无法回执")
    }
  }
  let reason = match obj.get("reason") {
    Some(String(raw)) => Some(raw)
    _ => None
  }
  if batch_id != "" {
    let count = direct.reply_batch(batch_id, accept, tx, reason~)
    if count > 0 {
      let map : Map[String, Json] = Map([])
      map.set("ok", Json::boolean(true))
      map.set("count", Json::number(count.to_double()))
      return @mocket.HttpResponse(@mocket.OK).json(Json::object(map))
    }
    return json_error(event, @mocket.NotFound, "该组待确认文件不存在或已处理")
  }
  let ok = direct.reply(id, accept, tx, reason~)
  if ok {
    let map : Map[String, Json] = Map([])
    map.set("ok", Json::boolean(true))
    map.set("count", Json::number(1.0))
    return @mocket.HttpResponse(@mocket.OK).json(Json::object(map))
  }
  json_error(event, @mocket.NotFound, "待确认项不存在或已处理")
}

///|
/// 待确认项的来源设备:单条按 id 查,成组按 batchId 查(快照里的 from 就是它)。
fn pending_from_of(direct : @direct.DirectService, id : String, batch_id : String) -> String? {
  direct.pending_from(id, batch_id)
}

///|
/// POST /api/direct/cancel。
async fn handle_direct_cancel(
  event : @mocket.MocketEvent,
  direct : @direct.DirectService,
) -> &Responder {
  let parsed = direct_json_object(event) catch { _ => None }
  let obj = match parsed {
    Some(obj) => obj
    None => {
      return json_error(event, @mocket.BadRequest, "invalid json body")
    }
  }
  let id = match obj.get("id") {
    Some(String(raw)) => raw
    _ => {
      return json_error(event, @mocket.BadRequest, "缺少投送 id")
    }
  }
  let ok = direct.cancel_queued(id)
  if ok {
    return @mocket.HttpResponse(@mocket.OK).json(ok_true())
  }
  json_error(
    event,
    @mocket.NotFound,
    "该投送不在排队中(可能已发出或已结束)",
  )
}

///|
/// POST /api/direct/text。
async fn handle_direct_text(
  event : @mocket.MocketEvent,
  direct : @direct.DirectService,
  transport_of : (String) -> @direct.DirectTransport?,
) -> &Responder {
  let parsed = direct_json_object(event) catch { _ => None }
  let obj = match parsed {
    Some(obj) => obj
    None => {
      return json_error(event, @mocket.BadRequest, "invalid json body")
    }
  }
  let query = event.req.query
  let text = match obj.get("text") {
    Some(String(raw)) => raw
    _ => ""
  }
  // 正文走 JSON 体,deviceId/deviceIds 兼容两种位置(body 与查询串) ——
  // 前端 useDirect 发的是 body;查询串解析留给 curl 调试。合并后去重保序。
  let body_single : Array[String] = []
  match obj.get("deviceId") {
    Some(String(raw)) =>
      if raw.trim() != "" {
        body_single.push(raw.trim().to_owned())
      }
    _ => ()
  }
  let body_many : Array[String] = []
  match obj.get("deviceIds") {
    Some(Array(values)) =>
      for value in values {
        match value {
          String(raw) =>
            if raw.trim() != "" {
              body_many.push(raw.trim().to_owned())
            }
          _ => ()
        }
      }
    _ => ()
  }
  let combined : Array[String] = []
  for value in direct_query_values(query, "deviceId") {
    combined.push(value)
  }
  for value in body_single {
    combined.push(value)
  }
  for value in direct_query_values(query, "deviceIds") {
    combined.push(value)
  }
  for value in body_many {
    combined.push(value)
  }
  let ids = dedup_targets(combined)
  if text == "" || ids.length() == 0 || ids.length() > DIRECT_MAX_TARGETS {
    return json_error(
      event,
      @mocket.BadRequest,
      "需要 1 ~ 20 台目标设备和文本内容",
    )
  }
  let results = dispatch_direct(ids, transport_of, (device_id, tx) => {
    match direct.send_text(device_id, text, tx) {
      Ok(ack) => Ok(ack)
      Err(message) => Err(message)
    }
  })
  send_direct_batch(ids, results)
}

///|
/// POST /api/direct/file:请求体 = 文件原始字节;查询串带 name/size 与
/// deviceId(s);batch 把同一次多文件投送的提议串成组。
async fn handle_direct_file(
  event : @mocket.MocketEvent,
  direct : @direct.DirectService,
  transport_of : (String) -> @direct.DirectTransport?,
) -> &Responder {
  let query = event.req.query
  let ids = parse_direct_targets(
    direct_query_values(query, "deviceId"),
    direct_query_values(query, "deviceIds"),
  )
  let name = match direct_query_values(query, "name").get(0) {
    Some(name) => name
    None => ""
  }
  let size : Int64 = match direct_query_values(query, "size").get(0) {
    Some(raw) => {
      let parsed = @string.parse_int64(raw) catch { _ => -1L }
      parsed
    }
    None => -1L
  }
  let batch = match direct_query_values(query, "batch").get(0) {
    Some(batch) => batch
    None => ""
  }
  // 打包模式未实现:诚实回 503,与能力声明(zip:false)一致
  if direct_query_values(query, "zip").length() > 0 {
    return json_error(event, @mocket.ServiceUnavailable, "当前后端不支持打包投送")
  }
  if name == "" || size <= 0L || size > @direct.DIRECT_MAX_FILE_BYTES {
    return json_error(
      event,
      @mocket.BadRequest,
      "文件参数不正确（名字、大小必填，单文件不超过 100MB）",
    )
  }
  if ids.length() == 0 || ids.length() > DIRECT_MAX_TARGETS {
    return json_error(
      event,
      @mocket.BadRequest,
      "需要 1 ~ 20 台目标设备及合法的文件参数",
    )
  }
  if batch != "" && !@direct.is_safe_id(batch) {
    return json_error(event, @mocket.BadRequest, "批次号格式不正确")
  }
  let bytes : Bytes = event.body() catch { _ => b"" }
  if bytes.length() == 0 || bytes.length().to_int64() != size {
    return json_error(event, @mocket.BadRequest, "uploaded file does not match declared size")
  }
  let sha256 = @lib.bytes_to_hex(@lib.sha256(bytes))
  // 暂存:落在收件箱的 .tmp(不属于任何共享目录,永不进索引);熵源不可用
  // 回 500 口径(理论上不可达 —— 随机数挂了整个 daemon 都不正常)。
  let staging = match direct.new_staging_path() {
    Some(path) => path
    None => {
      return json_error(event, @mocket.InternalServerError, "无法生成本地暂存路径")
    }
  }
  @fs.write_file(staging, bytes) catch {
    e => return json_error(event, @mocket.BadRequest, "暂存文件写入失败:\{e}")
  }
  let batch_opt = if batch != "" { Some(batch) } else { None }
  let results = dispatch_direct(ids, transport_of, (device_id, tx) => {
    match direct.send_file(device_id, name, staging, size, sha256, tx, batch_id=batch_opt) {
      Ok(ack) => Ok(ack)
      Err(message) => Err(message)
    }
  })
  // 一笔都没发出去时没有服务接管暂存文件,这里自己清理;
  // 否则由 direct 服务按引用计数在最后一笔结束时删。
  let mut started = false
  for row in results {
    match row {
      Object(fields) =>
        if fields.get("id") is Some(_) {
          started = true
        }
      _ => ()
    }
  }
  if !started {
    @fs.remove(staging) catch { _ => () }
  }
  send_direct_batch(ids, results)
}

///|
/// 附件名编码:RFC 5987 的 filename*。按 UTF-8 字节流做百分号转义 ——
/// 非安全字符(含中文/emoji 的每个字节)逐字节转义,ASCII 安全字符原样。
fn encode_attachment_name(name : String) -> String {
  let sb = StringBuilder()
  for byte in name.to_bytes() {
    let code = byte.to_int()
    let unreserved = (code >= 'a' && code <= 'z') ||
      (code >= 'A' && code <= 'Z') ||
      (code >= '0' && code <= '9') ||
      code == '.' ||
      code == '-' ||
      code == '_' ||
      code == '~' ||
      code == '(' ||
      code == ')' ||
      code == '\''
    if unreserved {
      // code 已确认是 ASCII 安全字符,to_char 必成功;失败兜底 '_'
      match code.to_char() {
        Some(ch) => sb.write_char(ch)
        None => sb.write_char('_')
      }
    } else {
      sb.write_string(percent_byte(code))
    }
  }
  sb.to_string()
}

///|
fn percent_byte(value : Int) -> String {
  let digits = "0123456789ABCDEF"
  let hi = match digits.get_char((value >> 4) & 0xF) {
    Some(ch) => ch
    None => 'F'
  }
  let lo = match digits.get_char(value & 0xF) {
    Some(ch) => ch
    None => 'F'
  }
  "%\{hi}\{lo}"
}
