///|
/// 对端 WebSocket 传输层(服务端)。对应 Node `src/net/server.ts` 与 Rust
/// `rust/crates/syncx-net/src/server.rs`。
///
/// **为什么不用 mocket**:mocket 0.10.2 native 的 WS 出站走
/// `WebSocketOutboundQueue`,其排水泵经 `%async.run` 在已运行的事件循环里
/// 嵌套启动 —— 实测(最小复现)该路径既可能死锁也不投递,客户端永远收不
/// 到服务端帧。moonbitlang/async 自带的 `@websocket`(from_http_server)
/// 方向正常,所以这里直接用 `@http.Server` + `@websocket` 自管读循环与
/// 出站队列;api 包的 HTTP 面继续用 mocket,互不影响。
///
/// 三条行为契约不变(对齐 Rust/Node):
///   - 单条消息上限 64MB(`wire.MAX_MESSAGE_BYTES`),超限整条丢弃;
///   - 握手超时 10s:超时后忽略该连接的一切消息(懒检查,见 `ConnStage::Dead`);
///   - 并发入站上限 64:超出后新连接直接关闭。
///
/// 与 Rust 版的分工差异:Rust 的 `PeerConnection` 把流交给调用方独占,读
/// 循环由调用方写;这里读循环在 `PeerServer::listen` 里,上层(daemon)拿到
/// 的是「已注册的 deviceId」与按 deviceId 收发的回调 API。
///
/// 明文模式(`PeerHandshakeMode::Plain`)是给回环测试与本地联调的:跳过两
/// 阶段握手,对端以第一条 Control(Hello) 自报 deviceId。生产路径必须
/// Secure —— 明文等于把数据面裸奔上网。

///|
/// peer 数据面端点路径。Node/Rust 的 peer 服务端是裸 WS(任意路径可达);
/// 这里显式接两条:约定的 `/peer`,加上根路径 `/`(旧对端连
/// `ws://host:port` 不带路径,根路径必须也能握手)。
pub const PEER_WS_PATH : String = "/peer"

///|
/// 握手超时(毫秒):连接建立后未完成握手则忽略其消息,防半开连接堆积。
pub const PEER_HANDSHAKE_TIMEOUT_MS : Int64 = 10_000L

///|
/// 并发入站对端连接上限,防单点耗尽资源。
pub const MAX_PEER_CONNECTIONS : Int32 = 64

///|
/// 传输层错误。客户端侧用于上报调用方;服务端侧的错误经 `on_error` 回调
/// 以文本形式上报,连接不因单条畸形消息被掀翻。
pub(all) suberror PeerError {
  Transport(String)
  Handshake(String)
  Closed
  TooLarge(String)
  NotConnected(String)
}

///|
pub fn PeerError::to_text(self : PeerError) -> String {
  match self {
    Transport(reason) => "传输失败:\{reason}"
    Handshake(reason) => "握手失败:\{reason}"
    Closed => "连接已关闭"
    TooLarge(reason) => "消息超限:\{reason}"
    NotConnected(device) => "设备 \{device} 未连接"
  }
}

///|
/// 数据面收发的原始帧(对齐 Rust 的 `Frame`):文本 = 文本信封 JSON,
/// 二进制 = 二进制信封(编解码是后续里程碑,这里只搬字节)。
pub(all) enum PeerFrame {
  Text(String)
  Binary(Bytes)
}

///|
/// peer 数据面握手模式。
pub(all) enum PeerHandshakeMode {
  /// 两阶段握手(对齐 Node/Rust):对端先亮 Ed25519 公钥,再发签名 kx,
  /// 双方派生会话密钥(流程见 handshake.mbt)。
  Secure(DeviceIdentity)
  /// 明文模式:跳过两阶段握手,对端以第一条 Control(Hello) 自报 deviceId。
  Plain
}

///|
/// 服务端事件回调。回调在连接的读循环里同步执行(单线程事件循环),
/// 不做长阻塞;上层要异步处理时自行入队。
pub(all) struct PeerServerHandlers {
  /// 连接注册完成(Secure = kx 验签通过;Plain = 收到 Hello)。
  on_connect : (String) -> Unit
  /// 入站文本消息(已解码为 wire 消息)。畸形消息不会走到这里,只会进
  /// `on_error` 并被整条丢弃。
  on_message : (String, WireMessage) -> Unit
  /// 入站二进制帧(透传字节;二进制信封语义是后续里程碑)。
  on_binary : (String, Bytes) -> Unit
  /// 已注册连接断开。同一连接在注册前的断开不上报(上层不认识它)。
  on_disconnect : (String) -> Unit
  /// 错误(畸形消息 / 握手失败 / 超限),只用于日志。
  on_error : (String) -> Unit
}

///|
/// 单条连接的阶段机。
priv enum ConnStage {
  /// Secure:等对端公钥。
  AwaitPeerKey
  /// Secure:等对端 kx。
  AwaitKx
  /// Plain:等对端 Hello 自报 deviceId。
  AwaitHello
  /// 已注册,进入数据面。
  Registered
  /// 失败/超时/超限:后续消息一律忽略,连接由对端或 read 循环收尾。
  Dead
}

///|
/// 出站队列的帧种类。
priv enum OutFrame {
  TextFrame(String)
  BinaryFrame(Bytes)
}

///|
/// 单条连接的服务端侧状态。
struct ConnState {
  /// connection_id(注册表反引用)。
  cid : String
  /// 服务端侧的 WebSocket 连接(读循环与出站泵共用)。
  ws : @websocket.Conn
  /// 出站队列:回调(同步)只入队,真正的写由出站泵任务完成。
  outbound : @async.Queue[OutFrame]
  mut stage : ConnStage
  /// 握手期限(毫秒,懒检查 —— 读循环每次收帧时看一眼)。
  deadline : Int64
  /// 对端公钥 PEM(Secure 第一阶段收下,供 kx 验签)。
  mut peer_pem : String
  mut device_id : String?
  /// 对端在 kx 里广播的监听端口(旧版对端 None)。
  mut listen_port : Int32?
  /// 对端能力标签(None = 旧版对端,数据面走文本信封)。
  mut caps : Array[String]?
  /// 会话密钥(Secure 协商产物;明文模式恒 None)。
  mut session_key : Bytes?
}

///|
/// 运行中的对端服务端。`listen` 常驻,由调用方挂进 TaskGroup;
/// `close` 只断已建连接(listener 随进程结束)。
pub struct PeerServer {
  bound : Int32
  identity : DeviceIdentity?
  handlers : PeerServerHandlers
  server : @http.Server
  /// connection_id → 连接状态(含握手中与已 Dead 的,断开时移除)。
  conns : Map[String, ConnState]
  /// deviceId → connection_id(注册表本体)。
  registry : Map[String, String]
  max_connections : Int32
  handshake_timeout_ms : Int64
  mut next_conn_id : Int32
}

///|
/// 实际监听端口(port=0 时由内核分配)。
pub fn PeerServer::bound_port(self : PeerServer) -> Int32 {
  self.bound
}

///|
/// 当前并发连接数(含握手中,不含已断开)。
pub fn PeerServer::connection_count(self : PeerServer) -> Int32 {
  self.conns.length()
}

///|
/// 已注册的 deviceId 列表。
pub fn PeerServer::connected_devices(self : PeerServer) -> Array[String] {
  self.registry.keys().collect()
}

///|
/// 已注册连接的握手产物(对齐 Rust `PeerConnection` 的可读字段)。
/// `session_key`/`caps`/`listen_port` 供 daemon 决定数据面编码与反向重连。
pub(all) struct PeerConnectionInfo {
  device_id : String
  /// 对端在 kx 里广播的监听端口(旧版对端 None)。
  listen_port : Int32?
  /// 对端能力标签(None = 旧版对端,数据面走文本信封)。
  caps : Array[String]?
  /// 会话密钥(Secure 协商产物;明文模式恒 None)。
  session_key : Bytes?
}

///|
/// 查一个已注册连接;未注册返回 None(查表是只读操作,不抛错)。
pub fn PeerServer::connection(
  self : PeerServer,
  device_id : String,
) -> PeerConnectionInfo? {
  match self.registry.get(device_id) {
    Some(cid) =>
      match self.conns.get(cid) {
        Some(state) =>
          Some({
            device_id,
            listen_port: state.listen_port,
            caps: state.caps,
            session_key: state.session_key,
          })
        None => None
      }
    None => None
  }
}

///|
/// 服务端装配选项。
pub(all) struct PeerServerOptions {
  /// 监听地址的主机部分。
  bind_host : String
  /// 监听端口;0 = 内核挑随机端口(经 `bound_port()` 读回)。
  port : Int32
  /// 并发入站上限。
  max_connections : Int32
  /// 握手超时(毫秒)。
  handshake_timeout_ms : Int64
}

///|
pub fn PeerServerOptions::new(
  bind_host~ : String = "127.0.0.1",
  port~ : Int32 = 0,
  max_connections~ : Int32 = MAX_PEER_CONNECTIONS,
  handshake_timeout_ms~ : Int64 = PEER_HANDSHAKE_TIMEOUT_MS,
) -> PeerServerOptions {
  { bind_host, port, max_connections, handshake_timeout_ms, }
}

///|
/// 装配对端服务端:绑定端口、挂路由,不开始 accept。端口传 0 时由内核
/// 分配,`bound_port()` 立即可读(不再需要 api 包的探测-释放技巧)。
///
/// 装配完调用 `PeerServer::listen`(经 TaskGroup::spawn_bg 挂后台)。
pub async fn start_peer_server(
  mode : PeerHandshakeMode,
  handlers : PeerServerHandlers,
  options~ : PeerServerOptions = PeerServerOptions::new(),
) -> PeerServer raise PeerError {
  let addr = @socket.Addr::parse("\{options.bind_host}:\{options.port}") catch {
    e => raise PeerError::Transport("监听地址非法:\{e}")
  }
  let server = @http.Server(addr) catch {
    e => raise PeerError::Transport("监听失败:\{e}")
  }
  let identity = match mode {
    Secure(identity) => Some(identity)
    Plain => None
  }
  {
    bound: server.addr.port(),
    identity,
    handlers,
    server,
    conns: Map([]),
    registry: Map([]),
    max_connections: options.max_connections,
    handshake_timeout_ms: options.handshake_timeout_ms,
    next_conn_id: 0,
  }
}

///|
/// 常驻监听:accept → WS 升级 → 单连接会话(`serve_ws`)。
/// `run_forever` 每条连接一个任务,本函数不返回(端口绑定失败只打日志)。
pub async fn PeerServer::listen(self : PeerServer) -> Unit {
  self.server.run_forever() <| ((request, _body_reader, conn) => {
    let path = request.path
    if is_ws_upgrade(request) && (path == "/" || path == PEER_WS_PATH) {
      self.serve_ws(request, conn)
    } else {
      // 不是 peer 数据面的升级请求:对齐 mocket 未知路由的 404 口径
      conn..send_response(404, "Not Found")..write("not found").end_response()
    }
  })
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
/// 单条 WS 连接的会话:出站泵 + 读循环 + 注册表维护。
async fn PeerServer::serve_ws(
  self : PeerServer,
  request : @http.Request,
  conn : @http.ServerConnection,
) -> Unit {
  let ws = @websocket.from_http_server(request, conn) catch { _ => return }
  defer ws.close()
  // 并发上限:直接关新连接
  if self.conns.length() >= self.max_connections {
    (self.handlers.on_error)(
      "超出并发上限 \{self.max_connections},拒绝新连接",
    )
    return
  }
  self.next_conn_id += 1
  let cid = "peer-\{self.bound}-\{self.next_conn_id}"
  let stage = match self.identity {
    Some(_) => AwaitPeerKey
    None => AwaitHello
  }
  let state : ConnState = {
    cid,
    ws,
    outbound: @async.Queue(kind=Unbounded),
    stage,
    deadline: @async.now() + self.handshake_timeout_ms,
    peer_pem: "",
    device_id: None,
    listen_port: None,
    caps: None,
    session_key: None,
  }
  self.conns.set(cid, state)
  @async.with_task_group() <| group => {
    // 出站泵:回调只入队,写全部在这一个任务里(单写者,避免交错帧)
    group.spawn_bg(allow_failure=true) <| () => {
      let mut running = true
      while running {
        let frame : OutFrame? = Some(state.outbound.get()) catch { _ => None }
        match frame {
          Some(TextFrame(text)) => ws.send_text(text) catch { _ => () }
          Some(BinaryFrame(data)) => ws.send_binary(data) catch { _ => () }
          None => running = false
        }
      }
    }
    // 读循环:一切错误(含对端关闭)都走收尾
    let mut alive = true
    while alive {
      let incoming : @websocket.Message? = Some(ws.recv()) catch { _ => None }
      match incoming {
        None => alive = false
        Some(msg) => {
          let bytes : Bytes? = Some(read_message_capped(msg)) catch {
            _ => None
          }
          match bytes {
            None => alive = false
            Some(data) =>
              match msg.kind {
                Text => self.handle_text(cid, @utf8.decode_lossy(data))
                Binary => self.handle_binary(cid, data)
              }
          }
        }
      }
    }
    // 收尾:关出站队列叫停泵,摘注册表
    state.outbound.close(clear=true)
    self.conns.remove(cid)
    match state.device_id {
      Some(device_id) =>
        if self.registry.get(device_id) == Some(cid) {
          self.registry.remove(device_id)
          (self.handlers.on_disconnect)(device_id)
        }
      None => ()
    }
  }
}

///|
/// 入站文本:按连接阶段分流。
fn PeerServer::handle_text(
  self : PeerServer,
  cid : String,
  text : String,
) -> Unit {
  let state = match self.conns.get(cid) {
    Some(state) => state
    None => return
  }
  // 握手期限懒检查:超时只能忽略,不能断连(读循环还握着连接)
  if !(state.stage is Registered) && @async.now() > state.deadline {
    state.stage = Dead
    (self.handlers.on_error)("握手超时,忽略连接 \{cid} 的后续消息")
    return
  }
  match state.stage {
    AwaitPeerKey => self.stage_peer_key(state, text)
    AwaitKx => self.stage_kx(state, text)
    AwaitHello => self.stage_hello(state, text)
    Registered => {
      let message = decode_wire_message(text) catch {
        e => {
          // 线上数据不可信:丢整条,不掀翻连接
          (self.handlers.on_error)("丢弃畸形消息:\{e.to_text()}")
          return
        }
      }
      match state.device_id {
        Some(device_id) => (self.handlers.on_message)(device_id, message)
        None => ()
      }
    }
    Dead => ()
  }
}

///|
/// 入站二进制:握手阶段按文本宽进,数据面透传字节。
fn PeerServer::handle_binary(
  self : PeerServer,
  cid : String,
  data : Bytes,
) -> Unit {
  let state = match self.conns.get(cid) {
    Some(state) => state
    None => return
  }
  match state.stage {
    Registered =>
      match state.device_id {
        Some(device_id) => (self.handlers.on_binary)(device_id, data)
        None => ()
      }
    AwaitPeerKey | AwaitKx | AwaitHello =>
      self.handle_text(cid, @utf8.decode_lossy(data))
    Dead => ()
  }
}

///|
/// Secure 第一阶段:对端公钥 → 设备 ID,回本机公钥。
fn PeerServer::stage_peer_key(
  self : PeerServer,
  state : ConnState,
  text : String,
) -> Unit {
  let identity = match self.identity {
    Some(identity) => identity
    None => return
  }
  // 公钥形态必须先验:形态不合法的 PEM 派生不出可信的设备 ID
  let _ = parse_public_key_pem(text) catch {
    e => {
      state.stage = Dead
      (self.handlers.on_error)("对端公钥非法:\{e.to_text()}")
      return
    }
  }
  state.peer_pem = text
  state.device_id = Some(derive_device_id(text))
  enqueue_text(state, identity.public_key_pem)
  state.stage = AwaitKx
}

///|
/// Secure 第二阶段:验对端 kx,回本机签名 kx,派生会话密钥后注册。
fn PeerServer::stage_kx(
  self : PeerServer,
  state : ConnState,
  text : String,
) -> Unit {
  let identity = match self.identity {
    Some(identity) => identity
    None => return
  }
  let kx = decode_kx_message(text) catch {
    e => {
      state.stage = Dead
      (self.handlers.on_error)("对端 kx 非法:\{e.to_text()}")
      return
    }
  }
  let peer_public = verify_kx_message(kx, state.peer_pem) catch {
    e => {
      state.stage = Dead
      (self.handlers.on_error)("对端 kx 验签失败:\{e.to_text()}")
      return
    }
  }
  let pair = X25519KeyPair::generate() catch {
    e => {
      state.stage = Dead
      (self.handlers.on_error)("X25519 密钥生成失败:\{e.to_text()}")
      return
    }
  }
  let our_kx = build_kx_message(pair, identity, Some(self.bound), peer_caps()) catch {
    e => {
      state.stage = Dead
      (self.handlers.on_error)("构建 kx 失败:\{e.to_text()}")
      return
    }
  }
  enqueue_text(state, encode_kx_message(our_kx))
  let session_key = derive_session_key(pair, peer_public) catch {
    e => {
      state.stage = Dead
      (self.handlers.on_error)("会话密钥派生失败:\{e.to_text()}")
      return
    }
  }
  self.register(state, kx.listen_port, kx.caps, Some(session_key))
}

///|
/// Plain 模式:首条消息必须是 Hello,以它的 fromDeviceId 注册。
fn PeerServer::stage_hello(
  self : PeerServer,
  state : ConnState,
  text : String,
) -> Unit {
  let message = decode_wire_message(text) catch {
    e => {
      state.stage = Dead
      (self.handlers.on_error)("明文模式首条消息非法:\{e.to_text()}")
      return
    }
  }
  match message {
    Control(payload~) =>
      match payload {
        Hello(from_device_id~, ..) => {
          state.device_id = Some(from_device_id)
          self.register(state, None, None, None)
          (self.handlers.on_message)(from_device_id, message)
        }
        _ => {
          state.stage = Dead
          (self.handlers.on_error)(
            "明文模式首条消息必须是 hello,连接已忽略",
          )
        }
      }
    _ => {
      state.stage = Dead
      (self.handlers.on_error)(
        "明文模式首条消息必须是 hello,连接已忽略",
      )
    }
  }
}

///|
/// 注册连接(按 deviceId;同设备重连时新连接顶掉旧连接)。旧连接只标记
/// Dead 并关掉,不发 on_disconnect —— 对上层这是一次设备重连,不是离开。
fn PeerServer::register(
  self : PeerServer,
  state : ConnState,
  listen_port : Int32?,
  caps : Array[String]?,
  session_key : Bytes?,
) -> Unit {
  let device_id = match state.device_id {
    Some(id) => id
    None => return
  }
  match self.registry.get(device_id) {
    Some(old_cid) =>
      if old_cid != state.cid {
        match self.conns.get(old_cid) {
          Some(old) => {
            old.stage = Dead
            old.outbound.close(clear=true)
            old.ws.close()
          }
          None => ()
        }
        self.registry.remove(device_id)
      }
    None => ()
  }
  state.stage = Registered
  state.listen_port = listen_port
  state.caps = caps
  state.session_key = session_key
  self.registry.set(device_id, state.cid)
  (self.handlers.on_connect)(device_id)
}

///|
/// 出站入队(同步,供回调调用):真正的写由出站泵任务完成。
fn enqueue_text(state : ConnState, text : String) -> Unit {
  // 队列已关 = 连接正在收尾,丢帧是预期行为
  let _ : Bool = state.outbound.try_put(TextFrame(text)) catch { _ => false }
}

///|
/// 取已注册连接;未注册抛 NotConnected。
fn PeerServer::state_of(
  self : PeerServer,
  device_id : String,
) -> ConnState raise PeerError {
  match self.registry.get(device_id) {
    Some(cid) =>
      match self.conns.get(cid) {
        Some(state) => state
        None => raise PeerError::NotConnected(device_id)
      }
    None => raise PeerError::NotConnected(device_id)
  }
}

///|
/// 出站大小闸门(64MB,对齐 Rust 的 ws_config)。
fn check_frame_size(len : Int32, what : String) -> Unit raise PeerError {
  if len > MAX_MESSAGE_BYTES.to_int() {
    raise PeerError::TooLarge("\{what}超出 64MB 上限")
  }
}

///|
/// 发一条 wire 消息(文本信封)。
pub fn PeerServer::send_message(
  self : PeerServer,
  device_id : String,
  message : WireMessage,
) -> Unit raise PeerError {
  self.send_text(device_id, encode_wire_message(message))
}

///|
/// 发一条文本帧(已编码的文本信封)。
pub fn PeerServer::send_text(
  self : PeerServer,
  device_id : String,
  text : String,
) -> Unit raise PeerError {
  check_frame_size(@utf8.encode(text).length(), "出站文本帧")
  let state = self.state_of(device_id)
  if !(state.outbound.try_put(TextFrame(text)) catch { _ => false }) {
    raise PeerError::NotConnected(device_id)
  }
}

///|
/// 发一条二进制帧(二进制信封是后续里程碑,先具备搬运能力)。
pub fn PeerServer::send_binary(
  self : PeerServer,
  device_id : String,
  data : Bytes,
) -> Unit raise PeerError {
  check_frame_size(data.length(), "出站二进制帧")
  let state = self.state_of(device_id)
  if !(state.outbound.try_put(BinaryFrame(data)) catch { _ => false }) {
    raise PeerError::NotConnected(device_id)
  }
}

///|
/// 关闭所有已建连接(出站队列 + WS 连接),清空注册表。
/// **不**停止监听(`@http.Server::close` 之后 socket 不可复用,常驻监听
/// 的停止留给进程生命周期;要精细控制时不要复用本对象)。
pub fn PeerServer::close(self : PeerServer) -> Unit {
  for pair in self.conns {
    pair.1.outbound.close(clear=true)
    pair.1.ws.close()
  }
  self.conns.clear()
  self.registry.clear()
}

///|
/// 断开指定设备的连接(配置热重载:设备被移除或不再共享任何目录时,装配层
/// 主动掐线,避免僵尸会话继续收发)。口径与同设备重连顶替一致:置 Dead、
/// 关出站队列、关 WS;读循环因 WS 关闭而返回,断开钩子(on_disconnect)
/// 照常触发,装配层按既有路径清理会话态。幂等:未连接即无操作。
pub fn PeerServer::close_device(self : PeerServer, device_id : String) -> Unit {
  match self.registry.get(device_id) {
    Some(cid) =>
      match self.conns.get(cid) {
        Some(state) => {
          state.stage = Dead
          state.outbound.close(clear=true)
          state.ws.close()
        }
        None => ()
      }
    None => ()
  }
}
