///|
/// WS 状态推送(`/api/events`):把 daemon actor 的事件流透出给前端。
/// 路径与消息格式逐字对齐 Node `src/status-hub.ts` / Rust `ws.rs`:
///   - `{ "type": "status", "status": {…} }`:全量状态帧(连上立刻发一帧,
///     之后差异驱动 —— 序列化结果与上次相同就一帧不发);
///   - `{ "type": "syncEvent", "event": {…} }`:一条 actor 同步事件
///     (字段对齐前端 `web/types.ts` 的 `SyncEventItem`:folderId/path/
///     action/direction/ts,camelCase);
///   - `{ "type": "ping", "ts": <ms> }`:应用层保活。
///
/// **为什么不用 mocket 的 WS**:mocket 0.10.2 native 的 WS 出站走
/// `WebSocketOutboundQueue`,其排水泵经 `%async.run` 在已运行的事件循环里
/// 嵌套启动 —— 最小复现实测(见 api 包探针)客户端永远收不到服务端帧,
/// 与 `moonbit/net/server.mbt` 的结论一致。因此这里与 net 包同款:
/// `@http.Server` + `@websocket` 自管。HTTP 面不丢:mocket 的公开
/// `dispatch_http` 承接全部非升级请求,路由/中间件/静态资源行为不变。
///
/// 与 Node 的两点刻意差异(已在任务报告说明):
///   - Node 的鉴权在 upgrade 事件里完成;mocket 的 WS 处理器拿不到原始
///     请求,自管监听则天然拿得到 —— 语义保持「升级前校验 cookie,未通过
///     回裸 401 再断链」,实现路径不同,门的行为一致;
///   - 事件层是 250ms 轮询排水(`DrainEvents`)而不是变更点回调:
///     daemon 的 actor 没有暴露订阅回调,轮询是只读引用下的最小实现。

///|
/// WS 推送端点(与 Node `EVENTS_PATH`、Rust `EVENTS_PATH` 同一个字面量)。
pub const EVENTS_PATH : String = "/api/events"

///|
/// 推送泵周期:事件排水 + 状态差异重算的节拍(Node 的 flush 合并窗口 250ms 同款)。
const HUB_TICK_MS : Int32 = 250

///|
/// 应用层 ping 周期:低于多数中间代理 60s 的空闲阈值(Node 同款)。
const HUB_PING_MS : Int64 = 30_000L

///|
/// 一条同步事件帧:字段与前端 `SyncEventItem` 逐字对齐(camelCase)。
/// `ts` 是服务端排水时刻(毫秒);`deviceId` 事件记录里没有,缺省。
pub fn sync_event_frame(
  folder_id : String,
  event : @daemon.SyncEventRecord,
  ts : Int64,
) -> String {
  let ev : Map[String, Json] = Map([])
  ev.set("folderId", Json::string(folder_id))
  ev.set("path", Json::string(event.path))
  ev.set("action", Json::string(event.action))
  ev.set("direction", Json::string(event.direction))
  ev.set("ts", Json::number(ts.to_double()))
  let frame : Map[String, Json] = Map([])
  frame.set("type", Json::string("syncEvent"))
  frame.set("event", Json::object(ev))
  Json::object(frame).stringify()
}

///|
/// 一帧全量状态(Node status-hub 的 `{ type: 'status', status }` 同款)。
pub fn status_frame(status : Json) -> String {
  let frame : Map[String, Json] = Map([])
  frame.set("type", Json::string("status"))
  frame.set("status", status)
  Json::object(frame).stringify()
}

///|
/// 应用层 ping 帧(Node 同款 `{ type: 'ping', ts }`)。
pub fn ping_frame(ts : Int64) -> String {
  let frame : Map[String, Json] = Map([])
  frame.set("type", Json::string("ping"))
  frame.set("ts", Json::number(ts.to_double()))
  Json::object(frame).stringify()
}

///|
/// 状态推送中枢:持有全部订阅连接,后台泵任务做「排水 + 差异重算」。
/// 全部方法都在同一个事件循环任务上调用,无需加锁。
pub struct StatusHub {
  priv options : ApiOptions
  priv actor : @daemon.ActorHandle
  priv clients : Map[String, @async.Queue[String]]
  /// 上一次真正发出去的状态帧:与本轮相同即跳过(差异驱动)。
  priv mut last_sent : String
  priv mut next_id : Int32
  priv mut closed : Bool
}

///|
/// 装配一个推送中枢(actor 缺失时上层不装 `/api/events`,与 Node
/// 「statusHub 未传则对握手一律拒绝」同款)。
pub fn new_status_hub(
  options : ApiOptions,
  actor : @daemon.ActorHandle,
) -> StatusHub {
  {
    options,
    actor,
    clients: Map([]),
    last_sent: "",
    next_id: 0,
    closed: false,
  }
}

///|
/// 接管一条已通过认证的连接:立即回一帧全量(界面连上就能画),
/// 并校准差异基线。返回 (连接 id, 出站帧队列)。
pub fn StatusHub::attach(self : StatusHub) -> (String, @async.Queue[String]) {
  self.next_id += 1
  let cid = "ws-\{self.next_id}"
  let outbound : @async.Queue[String] = @async.Queue(kind=Unbounded)
  self.clients.set(cid, outbound)
  let frame = status_frame(status_json(self.options))
  self.last_sent = frame
  let _ : Bool = outbound.try_put(frame) catch { _ => false }
  (cid, outbound)
}

///|
/// 摘除一条连接(读循环收尾时调用)。
pub fn StatusHub::detach(self : StatusHub, cid : String) -> Unit {
  ignore(self.clients.remove(cid))
}

///|
/// 当前订阅连接数(测试与诊断用)。
pub fn StatusHub::client_count(self : StatusHub) -> Int32 {
  self.clients.length()
}

///|
/// 关闭中枢:叫停泵任务,清空全部出站队列(连接由各自读循环收尾)。
pub fn StatusHub::close(self : StatusHub) -> Unit {
  self.closed = true
  for _, queue in self.clients {
    queue.close(clear=true)
  }
  self.clients.clear()
}

///|
/// 广播一条帧(全部订阅连接;发送失败只丢这一条,不掀翻通道)。
fn StatusHub::broadcast(self : StatusHub, frame : String) -> Unit {
  for _, queue in self.clients {
    let _ : Bool = queue.try_put(frame) catch { _ => false }
  }
}

///|
/// 事件层:把各目录会话的运行期事件排水出来,逐条推给订阅者。
/// 排水 = 与 actor 的一次往返:回执到达即说明该命令已处理完。
async fn StatusHub::drain_events(self : StatusHub) -> Unit {
  // 只排水有订阅者的目录:快照自带目录清单,不必另行查配置
  for folder in self.actor.snapshot().folders {
    let reply : @async.Queue[Array[@daemon.SyncEventRecord]] = @async.Queue(
      kind=Unbounded,
    )
    if !self.actor.send(@daemon.Cmd::DrainEvents(folder=folder.id, reply~)) {
      continue // actor 已退出:目录清单里的这个目录也不再存在
    }
    let events = reply.get()
    if events.length() == 0 {
      continue
    }
    let ts = now_ms()
    for event in events {
      self.broadcast(sync_event_frame(folder.id, event, ts))
    }
  }
}

///|
/// 状态层:重算一次全量状态,有变化才广播(差异驱动)。
/// 基线是「上次真正发出去的帧字节」,不是对象 —— 键序/数值格式化差异
/// 恰恰是客户端看到的差异(Rust ws.rs 同款口径)。
fn StatusHub::flush_status(self : StatusHub) -> Unit {
  if self.clients.length() == 0 {
    return
  }
  let frame = status_frame(status_json(self.options))
  if frame == self.last_sent {
    return
  }
  self.last_sent = frame
  self.broadcast(frame)
}

///|
/// 后台泵:有订阅者时每个节拍「排水事件 + 差异重算状态」,空闲只打点。
/// 不做「事件层 + 5s 兜底」两层 —— 这里的节拍本身就是兜底重算,
/// 事件排水只是顺带把细粒度记录推出去。
pub async fn StatusHub::run(self : StatusHub) -> Unit {
  let mut ticks : Int64 = 0
  let ping_every = HUB_PING_MS / HUB_TICK_MS.to_int64()
  for ;; {
    if self.closed {
      return
    }
    if self.client_count() == 0 {
      @async.sleep(HUB_TICK_MS)
      continue
    }
    self.drain_events()
    self.flush_status()
    ticks += 1
    if ticks % ping_every == 0 {
      self.broadcast(ping_frame(now_ms()))
    }
    @async.sleep(HUB_TICK_MS)
  }
}

///|
/// 是不是 WebSocket 升级请求(对齐 RFC 6455 握手头)。
fn is_ws_upgrade(request : @http.Request) -> Bool {
  let conn_ok = match request.headers.get("connection") {
    Some(value) => value.to_lower().contains("upgrade")
    None => false
  }
  let upgrade_ok = match request.headers.get("upgrade") {
    Some(value) => value.to_lower() == "websocket"
    None => false
  }
  conn_ok && upgrade_ok
}

///|
/// 请求方法名(mocket native 侧同一张映射)。
fn http_method_name(meth : @http.RequestMethod) -> String {
  match meth {
    Get => "GET"
    Head => "HEAD"
    Post => "POST"
    Put => "PUT"
    Delete => "DELETE"
    Connect => "CONNECT"
    Options => "OPTIONS"
    Trace => "TRACE"
    Patch => "PATCH"
  }
}

///|
/// 是否携带请求体(mocket dispatch 的同一判据)。
fn request_has_body(http_method : String, headers : @http.Headers) -> Bool {
  match http_method {
    "POST" | "PUT" | "PATCH" => true
    _ =>
      headers.get("transfer-encoding") is Some(_) ||
      (match headers.get("content-length") {
        Some(value) => value.trim() != "0"
        None => false
      })
  }
}

///|
/// 每次写后都 flush 的响应写出器:mocket 的 SSE 语义(SSE/增量响应不滞留
/// 在连接缓冲里)在自管监听下保持等价。
priv struct FlushingWriter {
  conn : @http.ServerConnection
}

///|
async fn FlushingWriter::write_and_flush(
  self : FlushingWriter,
  data : &@io.Data,
) -> Unit {
  self.conn.write(data)
  self.conn.flush()
}

///|
async fn FlushingWriter::write_chunk_and_flush(
  self : FlushingWriter,
  bytes : Bytes,
  offset~ : Int32,
  len~ : Int32,
) -> Int32 {
  let written = self.conn.write_once(bytes, offset~, len~)
  self.conn.flush()
  written
}

///|
async fn FlushingWriter::write_reader_and_flush(
  self : FlushingWriter,
  reader : &@io.Reader,
) -> Unit {
  self.conn.write_reader(reader)
  self.conn.flush()
}

///|
impl @io.Writer for FlushingWriter with fn write(self, data) {
  self.write_and_flush(data)
}

///|
impl @io.Writer for FlushingWriter with fn write_once(
  self,
  bytes,
  offset~,
  len~,
) -> Int32 {
  self.write_chunk_and_flush(bytes, offset~, len~)
}

///|
impl @io.Writer for FlushingWriter with fn write_reader(self, reader) {
  self.write_reader_and_flush(reader)
}

///|
/// 把 mocket 分发结果写回连接(复刻 mocket native 的 send_native_response)。
async fn write_mocket_response(
  request : @http.Request,
  conn : @http.ServerConnection,
  response : @mocket.HttpResponse,
) -> Unit {
  let headers : Map[@http.CaseInsensitiveString, String] = Map([])
  for key, value in response.headers {
    headers.set(key, value.to_owned())
  }
  conn.send_response(
    response.status_code.to_int(),
    "OK",
    extra_headers=headers,
    cookies=response.cookies,
  )
  if request.meth != Head {
    match response.body {
      Some(body) => body.output(FlushingWriter::{ conn, })
      None => ()
    }
  }
  conn.end_response()
}

///|
/// 非升级请求转交 mocket 分发(路由/中间件/静态资源行为与 `App::listen` 一致)。
async fn forward_http(
  app : @mocket.App,
  request : @http.Request,
  body_reader : &@io.Reader,
  conn : @http.ServerConnection,
) -> Unit {
  let headers : Map[@http.CaseInsensitiveString, StringView] = Map([])
  for key, value in request.headers {
    headers.set(key, value)
  }
  let http_method = http_method_name(request.meth)
  let body = if request_has_body(http_method, request.headers) {
    body_reader.read_all().binary()
  } else {
    b""
  }
  let response = @mocket.dispatch_http(
    app,
    http_method,
    request.path,
    headers,
    body,
  ) catch {
    err =>
      @mocket.HttpResponse(@mocket.InternalServerError).body(err.to_string())
  }
  write_mocket_response(request, conn, response)
}

///|
/// `/api/events` 连接处理:升级前鉴权(与 `/api` 路由同一套凭据),
/// 通过后交中枢接管;读循环只用来感知断开,客户端帧一律忽略。
async fn serve_events_connection(
  hub : StatusHub,
  request : @http.Request,
  conn : @http.ServerConnection,
) -> Unit {
  // 认证门:cookie 里的 syncx_session(与 auth_middleware 同一校验函数)。
  // 浏览器没法给 WebSocket 设请求头,凭据只能来自同源 cookie。
  let cookie_header = match request.headers.get("cookie") {
    Some(value) => value
    None => ""
  }
  let credential = match
    @mocket.parse_request_cookie(cookie_header).get(SESSION_COOKIE) {
    Some(cookie) => cookie.value
    None => ""
  }
  let authenticated = credential_ok(
    credential,
    hub.options.control_token,
    hub.options.auth_file,
  )
  if !authenticated {
    // 未通过:回裸 401 再断链 —— 客户端据此区分「没登录」与「网络不通」
    conn.send_response(401, "Unauthorized")
    conn.end_response()
    return
  }
  let ws = @websocket.from_http_server(request, conn) catch { _ => return }
  defer ws.close()
  let (cid, outbound) = hub.attach()
  @async.with_task_group() <| group => {
    // 出站泵:帧全部经队列串行写,避免交错帧
    group.spawn_bg(allow_failure=true) <| () => {
      let mut running = true
      while running {
        let frame : String? = Some(outbound.get()) catch { _ => None }
        match frame {
          Some(text) => ws.send_text(text) catch { _ => () }
          None => running = false
        }
      }
    }
    // 读循环:客户端帧(心跳等)一律忽略,只在断开/出错时收尾
    let mut alive = true
    while alive {
      let incoming : @websocket.Message? = Some(ws.recv()) catch { _ => None }
      if incoming is None {
        alive = false
      }
    }
    // 收尾:关出站队列叫停泵,摘注册表
    outbound.close(clear=true)
    hub.detach(cid)
  }
}

///|
/// 起服务。address 形如 `127.0.0.1:8384`。
///
/// 自管 `@http.Server` 而非 mocket `App::listen`:只有这样才能在升级前拿到
/// 原始请求做认证、并绕开 mocket native WS 出站的死锁(见文件头)。HTTP 面
/// 原样转发 mocket `dispatch_http`,路由语义不变。
pub async fn serve(options : ApiOptions, address : String) -> Unit {
  let app = build_app(options)
  @async.with_task_group() <| group => {
    // 状态推送中枢:装了 actor 才有 /api/events(否则该路径按未知 WS 路由 404)
    let hub : StatusHub? = match options.actor {
      Some(actor) => {
        let hub = new_status_hub(options, actor)
        group.spawn_bg(allow_failure=true) <| () => { hub.run() }
        Some(hub)
      }
      None => None
    }
    let addr = @socket.Addr::parse(address) catch {
      err => {
        println("api: 无效监听地址 \{address}: \{err}")
        return
      }
    }
    let server = @http.Server(addr, reuse_addr=true) catch {
      err => {
        println("api: 监听失败 \{address}: \{err}")
        return
      }
    }
    server.run_forever((request, body_reader, conn) => {
      if is_ws_upgrade(request) {
        match hub {
          Some(h) if request.path == EVENTS_PATH =>
            serve_events_connection(h, request, conn)
          _ => {
            // 未知 WS 路径:对齐 mocket 未知路由的 404 口径,放着不管会让
            // 连接永久挂起
            conn.send_response(404, "Not Found")
            conn.end_response()
          }
        }
      } else {
        forward_http(app, request, body_reader, conn)
      }
    })
  }
}
