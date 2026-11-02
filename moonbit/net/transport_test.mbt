///|
/// 传输层回环测试:本机起 PeerServer(随机端口)+ PeerClient,wire 消息
/// 往返、大 payload 分片/帧边界、握手失败路径。端口传 0 由内核分配。
///
/// Secure 模式走 handshake.mbt 的 Ed25519/X25519 原语,做端到端对拍:
/// 握手产物(设备 ID / 会话密钥 / caps / listenPort)两端一致。
///
/// 收尾约定:每个用例先 client.close() 再等服务端 on_disconnect —— 读循环
/// 只能由对端关闭触发退出,不等断开就结束 TaskGroup 会在 teardown 里取消
/// 还在读的协程,引发取消 panic。

///|
/// 测试用收集器:回调与测试主体都在同一事件循环上跑,直接读写即可。
struct Collector {
  connected : Array[String]
  disconnected : Array[String]
  errors : Array[String]
  messages : Array[(String, @net.WireMessage)]
  binaries : Array[(String, Bytes)]
}

///|
fn new_collector() -> Collector {
  { connected: [], disconnected: [], errors: [], messages: [], binaries: [], }
}

///|
/// 装一个「收到即回声」的服务端:Index 回 IndexAck,BlockResponse 原样
/// 回,二进制原样回。发送失败(对端恰好断开)按噪声丢弃。
fn echo_handlers(
  collector : Collector,
  server_box : Array[@net.PeerServer],
) -> @net.PeerServerHandlers {
  {
    on_connect: id => collector.connected.push(id),
    on_message: (id, message) => {
      collector.messages.push((id, message))
      if server_box.length() > 0 {
        match message {
          Index(folder~, ..) =>
            try {
              let _ = server_box[0].send_message(id, @net.IndexAck(folder~))
            } catch {
              _ => ()
            }
          BlockResponse(folder~, payload~) =>
            try {
              let _ = server_box[0].send_message(
                id,
                @net.BlockResponse(folder~, payload~),
              )
            } catch {
              _ => ()
            }
          _ => ()
        }
      }
    },
    on_binary: (id, data) => {
      collector.binaries.push((id, data))
      if server_box.length() > 0 {
        try {
          let _ = server_box[0].send_binary(id, data)
        } catch {
          _ => ()
        }
      }
    },
    on_disconnect: id => collector.disconnected.push(id),
    on_error: reason => collector.errors.push(reason),
  }
}

///|
/// 起服务(端口随机);监听由调用方挂进 TaskGroup(见各测试)。
async fn start_test_server(
  mode : @net.PeerHandshakeMode,
  handlers : @net.PeerServerHandlers,
  server_box : Array[@net.PeerServer],
) -> @net.PeerServer {
  let server = @net.start_peer_server(mode, handlers) catch { _ => panic() }
  server_box.push(server)
  server
}

///|
/// 连接(带重试):监听拉起与端口探测之间有窗口期。
async fn connect_with_retry(
  mode : @net.PeerHandshakeMode,
  url : String,
  listen_port~ : Int32? = None,
) -> @net.PeerClient {
  for _ in 0..<200 {
    let attempt = Some(@net.connect_peer(mode, url, listen_port~)) catch {
      _ => None
    }
    match attempt {
      Some(client) => return client
      None => @async.sleep(25)
    }
  }
  panic()
}

///|
/// 收一条 wire 消息,10s 超时:超时/连接出错返回 None,由调用方断言。
async fn recv_message_timeout(client : @net.PeerClient) -> @net.WireMessage? {
  let message = @async.with_timeout_opt(10_000, () => client.recv_message()) catch {
    _ => return None
  }
  match message {
    Some(m) => Some(m)
    None => None
  }
}

///|
/// 收一帧(文本/二进制),10s 超时。
async fn recv_frame_timeout(client : @net.PeerClient) -> @net.PeerFrame? {
  let frame = @async.with_timeout_opt(10_000, () => client.recv_frame()) catch {
    _ => return None
  }
  match frame {
    Some(f) => Some(f)
    None => None
  }
}

///|
/// 轮询等待(总量 ~5s)。
async fn wait_until(check : () -> Bool) -> Bool {
  for _ in 0..<100 {
    if check() {
      return true
    }
    @async.sleep(50)
  }
  false
}

///|
/// 收尾:关客户端并等服务端确认断开,再让 TaskGroup 退出。
async fn close_and_wait(
  client : @net.PeerClient,
  collector : Collector,
  device_id : String,
) -> Unit {
  client.close()
  assert_true(wait_until(() => collector.disconnected.contains(device_id)))
}

///|
/// 造一段有规律的测试字节(全 0/全 1 会被「恰好没写坏」掩盖)。
fn pattern_bytes(len : Int32) -> Bytes {
  let arr : Array[Byte] = []
  for i in 0..<len {
    arr.push((i % 251).to_byte())
  }
  Bytes::from_array(arr)
}

///|
async test "回环:Hello 注册 + wire 消息往返" {
  @async.with_task_group() <| group => {
    let collector = new_collector()
    let server_box : Array[@net.PeerServer] = []
    let server = start_test_server(
      @net.PeerHandshakeMode::Plain,
      echo_handlers(collector, server_box),
      server_box,
    )
    group.spawn_bg(no_wait=true) <| () => { server.listen() }
    let client = connect_with_retry(
      @net.PeerHandshakeMode::Plain,
      "ws://127.0.0.1:\{server.bound_port()}\{@net.PEER_WS_PATH}",
    )
    // Plain 模式:客户端先自报家门,服务端据此注册
    client.send_message(
      @net.Control(payload=@net.make_hello("TESTDEVICE01", None, None)),
    )
    client.send_message(
      @net.Index(folder="/data", payload="W10=", full=None, relayed=None),
    )
    // 出站方向:Index 触发服务端回 IndexAck
    let reply = recv_message_timeout(client) catch { _ => panic() }
    assert_true(reply is Some(@net.IndexAck(folder="/data")))
    // 注册与消息分发
    assert_true(wait_until(() => collector.messages.length() >= 2))
    assert_true(collector.connected.contains("TESTDEVICE01"))
    let first_is_hello = match collector.messages[0].1 {
      Control(payload~) =>
        match payload {
          Hello(from_device_id~, ..) => from_device_id == "TESTDEVICE01"
          _ => false
        }
      _ => false
    }
    assert_true(first_is_hello)
    assert_true(collector.messages[1].1 is Index(folder="/data", ..))
    // 注册表 API
    assert_eq(server.connection_count(), 1)
    assert_true(server.connected_devices().contains("TESTDEVICE01"))
    // 明文模式:握手产物里没有会话密钥
    let info = server.connection("TESTDEVICE01")
    assert_true(info is Some({ session_key: None, .. }))
    close_and_wait(client, collector, "TESTDEVICE01")
  }
}

///|
async test "回环:1MB 文本信封往返(WS 分片与帧边界)" {
  @async.with_task_group() <| group => {
    let collector = new_collector()
    let server_box : Array[@net.PeerServer] = []
    let _ = start_test_server(
      @net.PeerHandshakeMode::Plain,
      echo_handlers(collector, server_box),
      server_box,
    )
    let server = server_box[0]
    group.spawn_bg(no_wait=true) <| () => { server.listen() }
    let client = connect_with_retry(
      @net.PeerHandshakeMode::Plain,
      "ws://127.0.0.1:\{server.bound_port()}\{@net.PEER_WS_PATH}",
    )
    client.send_message(
      @net.Control(payload=@net.make_hello("BIGDEV", None, None)),
    )
    // 768KB 原始字节 → base64 恰好 1MB 文本载荷
    let data = @base64.encode(pattern_bytes(768 * 1024))
    assert_eq(data.length(), 1024 * 1024)
    let response : @net.WireBlockResponse = {
      device_id: "BIGDEV",
      path: "big.bin",
      block_index: 0L,
      hash: "cafe",
      data,
      cdc: None,
    }
    client.send_message(@net.BlockResponse(folder="f1", payload=response))
    // 服务端回声同一条:1MB 文本经 WS 分片(客户端每帧 4096)重组成整条
    let reply = recv_message_timeout(client) catch { _ => panic() }
    match reply {
      Some(@net.BlockResponse(folder~, payload~)) => {
        assert_eq(folder, "f1")
        assert_eq(payload, response)
      }
      _ => panic()
    }
    close_and_wait(client, collector, "BIGDEV")
  }
}

///|
async test "回环:1MB 二进制帧往返" {
  @async.with_task_group() <| group => {
    let collector = new_collector()
    let server_box : Array[@net.PeerServer] = []
    let _ = start_test_server(
      @net.PeerHandshakeMode::Plain,
      echo_handlers(collector, server_box),
      server_box,
    )
    let server = server_box[0]
    group.spawn_bg(no_wait=true) <| () => { server.listen() }
    let client = connect_with_retry(
      @net.PeerHandshakeMode::Plain,
      "ws://127.0.0.1:\{server.bound_port()}\{@net.PEER_WS_PATH}",
    )
    client.send_message(
      @net.Control(payload=@net.make_hello("BINDEV", None, None)),
    )
    let data = pattern_bytes(1024 * 1024)
    client.send_binary(data)
    let frame = recv_frame_timeout(client) catch { _ => panic() }
    match frame {
      Some(@net.PeerFrame::Binary(echoed)) => assert_eq(echoed, data)
      _ => panic()
    }
    close_and_wait(client, collector, "BINDEV")
  }
}

///|
async test "畸形消息丢弃但连接存活" {
  @async.with_task_group() <| group => {
    let collector = new_collector()
    let server_box : Array[@net.PeerServer] = []
    let _ = start_test_server(
      @net.PeerHandshakeMode::Plain,
      echo_handlers(collector, server_box),
      server_box,
    )
    let server = server_box[0]
    group.spawn_bg(no_wait=true) <| () => { server.listen() }
    let client = connect_with_retry(
      @net.PeerHandshakeMode::Plain,
      "ws://127.0.0.1:\{server.bound_port()}\{@net.PEER_WS_PATH}",
    )
    client.send_message(
      @net.Control(payload=@net.make_hello("BADDEV", None, None)),
    )
    // 畸形 JSON:丢整条,不掀翻连接
    client.send_text("{ not json")
    // 随后的合法消息仍能到达并触发回声
    client.send_message(
      @net.Index(folder="/ok", payload="[]", full=None, relayed=None),
    )
    let reply = recv_message_timeout(client) catch { _ => panic() }
    assert_true(reply is Some(@net.IndexAck(folder="/ok")))
    assert_true(wait_until(() => collector.errors.length() >= 1))
    close_and_wait(client, collector, "BADDEV")
  }
}

///|
async test "Plain 模式首条非 Hello:连接被忽略" {
  @async.with_task_group() <| group => {
    let collector = new_collector()
    let server_box : Array[@net.PeerServer] = []
    let _ = start_test_server(
      @net.PeerHandshakeMode::Plain,
      echo_handlers(collector, server_box),
      server_box,
    )
    let server = server_box[0]
    group.spawn_bg(no_wait=true) <| () => { server.listen() }
    let client = connect_with_retry(
      @net.PeerHandshakeMode::Plain,
      "ws://127.0.0.1:\{server.bound_port()}\{@net.PEER_WS_PATH}",
    )
    // 首条不是 hello:连接进入 Dead,后续一切消息被忽略
    client.send_message(
      @net.Index(folder="/x", payload="[]", full=None, relayed=None),
    )
    client.send_message(
      @net.Control(payload=@net.make_hello("LATEDEV", None, None)),
    )
    assert_true(wait_until(() => collector.errors.length() >= 1))
    @async.sleep(100)
    assert_eq(collector.connected.length(), 0)
    assert_eq(collector.messages.length(), 0)
    client.close()
    @async.sleep(100)
  }
}

///|
async test "ping-pong:链路存活" {
  @async.with_task_group() <| group => {
    let collector = new_collector()
    let server_box : Array[@net.PeerServer] = []
    let _ = start_test_server(
      @net.PeerHandshakeMode::Plain,
      echo_handlers(collector, server_box),
      server_box,
    )
    let server = server_box[0]
    group.spawn_bg(no_wait=true) <| () => { server.listen() }
    let client = connect_with_retry(
      @net.PeerHandshakeMode::Plain,
      "ws://127.0.0.1:\{server.bound_port()}\{@net.PEER_WS_PATH}",
    )
    client.send_message(
      @net.Control(payload=@net.make_hello("PINGDEV", None, None)),
    )
    // pong 只在有人读帧时被消化:ping 任务挂后台,主流程做几轮回声,
    // 每轮 recv 都会顺带处理积压的 pong 并唤醒 ping 任务
    let ping_task = group.spawn(no_wait=true) <| () => {
      @async.sleep(100)
      client.ping() catch {
        _ => ()
      }
    }
    let mut ponged = false
    for _ in 0..<20 {
      // 每轮留出窗口:ping 任务(100ms 后发 ping)必须在轮次跨度内被调度
      @async.sleep(50)
      client.send_message(
        @net.Index(folder="/ping", payload="[]", full=None, relayed=None),
      )
      let reply = recv_message_timeout(client) catch { _ => panic() }
      assert_true(reply is Some(@net.IndexAck(folder="/ping")))
      let done = ping_task.try_wait() catch { _ => None }
      if done is Some(_) {
        ponged = true
        break
      }
    }
    assert_true(ponged)
    close_and_wait(client, collector, "PINGDEV")
  }
}

///|
async test "Secure 端到端:握手 + 会话密钥 + 消息往返" {
  @async.with_task_group() <| group => {
    let identity_a = @net.DeviceIdentity::generate() catch { _ => panic() }
    let identity_b = @net.DeviceIdentity::generate() catch { _ => panic() }
    let collector = new_collector()
    let server_box : Array[@net.PeerServer] = []
    let _ = start_test_server(
      @net.PeerHandshakeMode::Secure(identity_a),
      echo_handlers(collector, server_box),
      server_box,
    )
    let server = server_box[0]
    group.spawn_bg(no_wait=true) <| () => { server.listen() }
    // 客户端把本机监听端口写进 kx,服务端注册时应能看到
    let client = connect_with_retry(
      @net.PeerHandshakeMode::Secure(identity_b),
      "ws://127.0.0.1:\{server.bound_port()}\{@net.PEER_WS_PATH}",
      listen_port=Some(39451),
    )
    // 客户端看到的远端 = 服务端身份
    assert_eq(client.remote_device_id(), Some(identity_a.device_id))
    // 服务端注册的对端 = 客户端身份,握手产物一致
    assert_true(
      wait_until(() => collector.connected.contains(identity_b.device_id)),
    )
    let info = server.connection(identity_b.device_id)
    let session_key = match info {
      Some({ session_key: Some(key), .. }) => key
      _ => panic()
    }
    assert_eq(session_key, client.session_key().unwrap_or(b""))
    match info {
      Some({ listen_port: Some(port), .. }) => assert_eq(port, 39451)
      _ => panic()
    }
    let caps = match info {
      Some({ caps: Some(caps), .. }) => caps
      _ => panic()
    }
    assert_eq(caps, ["binary1"])
    // caps 双端互认
    assert_true(client.supports_binary())
    // 数据面:客户端发 Hello,服务端按注册 deviceId 分发
    client.send_message(
      @net.Control(payload=@net.make_hello(identity_b.device_id, None, None)),
    )
    assert_true(wait_until(() => collector.messages.length() >= 1))
    close_and_wait(client, collector, identity_b.device_id)
  }
}

///|
async test "Secure:对端首条不是合法公钥,握手失败" {
  @async.with_task_group() <| group => {
    let identity = @net.DeviceIdentity::generate() catch { _ => panic() }
    let collector = new_collector()
    let server_box : Array[@net.PeerServer] = []
    let _ = start_test_server(
      @net.PeerHandshakeMode::Secure(identity),
      echo_handlers(collector, server_box),
      server_box,
    )
    let server = server_box[0]
    group.spawn_bg(no_wait=true) <| () => { server.listen() }
    // 用明文客户端打进 Secure 端点:首条消息不是 PEM
    let client = connect_with_retry(
      @net.PeerHandshakeMode::Plain,
      "ws://127.0.0.1:\{server.bound_port()}\{@net.PEER_WS_PATH}",
    )
    client.send_text("not-a-pem")
    assert_true(
      wait_until(() => {
        collector.errors.length() >= 1 &&
        collector.errors[0].contains("公钥非法")
      }),
    )
    assert_eq(collector.connected.length(), 0)
    client.close()
    @async.sleep(100)
  }
}

///|
async test "WS 升级被拒:未知路径回 404,客户端报 Handshake" {
  @async.with_task_group() <| group => {
    let collector = new_collector()
    let server_box : Array[@net.PeerServer] = []
    let server = start_test_server(
      @net.PeerHandshakeMode::Plain,
      echo_handlers(collector, server_box),
      server_box,
    )
    group.spawn_bg(no_wait=true) <| () => { server.listen() }
    // 拉起窗口期的 Transport(连接被拒)重试;一旦服务端回 404(升级被拒)
    // 即是结论
    let mut verdict = "none"
    for _ in 0..<100 {
      let attempt = try {
        let _ = @net.connect_peer(
          @net.PeerHandshakeMode::Plain,
          "ws://127.0.0.1:\{server.bound_port()}/no-such-path",
        )
        "connected"
      } catch {
        Handshake(_) => "handshake-rejected"
        _ => "retry"
      }
      if attempt != "retry" {
        verdict = attempt
        break
      }
      @async.sleep(25)
    }
    assert_eq(verdict, "handshake-rejected")
  }
}

///|
async test "出站闸门:未注册设备与超限帧" {
  @async.with_task_group() <| group => {
    let collector = new_collector()
    let server_box : Array[@net.PeerServer] = []
    let server = start_test_server(
      @net.PeerHandshakeMode::Plain,
      echo_handlers(collector, server_box),
      server_box,
    )
    group.spawn_bg(no_wait=true) <| () => { server.listen() }
    // 未注册设备:查表与发送都拿不到连接
    assert_true(server.connection("NOBODY") is None)
    let sent = try {
      server.send_message("NOBODY", @net.IndexAck(folder="/x"))
      true
    } catch {
      NotConnected(_) => false
      _ => false
    }
    assert_true(!sent)
    let client = connect_with_retry(
      @net.PeerHandshakeMode::Plain,
      "ws://127.0.0.1:\{server.bound_port()}\{@net.PEER_WS_PATH}",
    )
    client.send_message(
      @net.Control(payload=@net.make_hello("CAPDEV", None, None)),
    )
    // 超限:构造 64MB+1 的二进制帧,发送前拒收(不进 socket)
    let oversized = Bytes::make(64 * 1024 * 1024 + 1, b'x')
    let sent_ok = try {
      client.send_binary(oversized)
      true
    } catch {
      TooLarge(_) => false
      _ => false
    }
    assert_true(!sent_ok)
    // 拒收后连接仍可用
    client.send_message(
      @net.Index(folder="/after", payload="[]", full=None, relayed=None),
    )
    let reply = recv_message_timeout(client) catch { _ => panic() }
    assert_true(reply is Some(@net.IndexAck(folder="/after")))
    close_and_wait(client, collector, "CAPDEV")
  }
}

///|
async test "根路径也能握手(兼容旧对端的连法)" {
  @async.with_task_group() <| group => {
    let collector = new_collector()
    let server_box : Array[@net.PeerServer] = []
    let _ = start_test_server(
      @net.PeerHandshakeMode::Plain,
      echo_handlers(collector, server_box),
      server_box,
    )
    let server = server_box[0]
    group.spawn_bg(no_wait=true) <| () => { server.listen() }
    // Node/Rust 客户端连 ws://host:port 时请求路径是 "/",必须能握手
    let client = connect_with_retry(
      @net.PeerHandshakeMode::Plain,
      "ws://127.0.0.1:\{server.bound_port()}/",
    )
    client.send_message(
      @net.Control(payload=@net.make_hello("ROOTDEV", None, None)),
    )
    assert_true(wait_until(() => collector.connected.contains("ROOTDEV")))
    close_and_wait(client, collector, "ROOTDEV")
  }
}
