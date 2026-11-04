///|
/// WS 推送回环测试:随机端口起 `serve`(自管监听),用 moonbitlang/async
/// 的 WebSocket 客户端订阅 `/api/events`,断言:
///   - 认证通过后立刻收到一帧全量状态(Node status-hub 同款语义);
///   - actor 的一次真实远端接收被排水成一条 `syncEvent` 帧(字段与前端
///     `SyncEventItem` 逐字对齐);
///   - 未带凭据的握手被拒(401),与 `/api` 路由认证门同语义;
///   - 状态层是差异驱动:没有变化就不推重复帧。
/// 事件制造路径与 `daemon/actor_test.mbt` 的闭环用例同款:挂对端 → 发
/// 全量索引 → ApplyPlan → 回块 → complete_receive 记事件。

///|
/// 以 control.token 为签名基签发一枚有效会话票据(ws_mint 前缀避免与
/// api_test.mbt 的同名助手撞名 —— 同包测试文件共享顶层作用域)。
fn ws_mint_ticket() -> String {
  let secret = @api.session_secret("test-token")
  @api.sign_session(
    { via: "token", sub: "token", exp: @api.now_ms() + 60_000L, },
    secret,
  )
}

///|
/// 建一个本测试专属的临时根目录。
async fn ws_fresh_root(tag : String) -> String {
  let root = "/tmp/syncx-mb-api-ws-\{tag}-\{@daemon.now_ms()}"
  @fs.mkdir(root, recursive=true, allow_exist=true)
  root
}

///|
/// 构造目录参数:状态目录(index.db / 回收站)放共享树之外。
async fn ws_make_spec(root : String) -> @daemon.FolderSpec {
  let state = "\{root}-state"
  @fs.mkdir(state, recursive=true, allow_exist=true)
  {
    id: "f1",
    root,
    index_path: "\{state}/index.db",
    trash_dir: "\{state}/trash",
    versions_dir: None,
    versions_per_path: None,
    rules: @core.IgnoreRuleset::from_lines([]),
    receive_only: false,
    conflict_policy: @daemon.ConflictPolicy::KeepBoth,
    paused: false,
    paused_files: [],
    baseline_pending: false,
    max_bandwidth_kbps: None,
    // ws 层单测不覆盖 git 镜像路径,一律按 off 装配。
    git_sync: @daemon.GitSyncMode::Off,
    git_strip_co_authored: false,
  }
}

///|
/// wire 索引条目(定长块哈希由内容直接算出)。
fn ws_wire_entry(
  path : String,
  content : String,
  version : Array[(String, Int64)],
) -> @net.WireEntry {
  {
    path,
    version,
    size: @utf8.encode(content).length().to_int64(),
    deleted: false,
    blocks: [@core.hash_block(@utf8.encode(content))],
    mtime: 0.0,
    cdh: None,
    clens: None,
  }
}

///|
/// 组一条全量 Index 消息(encode_index → base64,与驱动层同一编码路径)。
fn ws_index_message(
  folder : String,
  entries : Array[@net.WireEntry],
) -> @net.WireMessage {
  let body = @net.encode_index(entries)
  @net.WireMessage::Index(
    folder~,
    payload=@base64.encode(@utf8.encode(body)),
    full=Some(true),
    relayed=None,
  )
}

///|
/// 组一条块响应消息。
fn ws_block_response(
  folder : String,
  path : String,
  hash : String,
  content : String,
) -> @net.WireMessage {
  @net.WireMessage::BlockResponse(folder~, payload={
    device_id: "dev-b",
    path,
    block_index: 0L,
    hash,
    data: @base64.encode(@utf8.encode(content)),
    cdc: None,
  })
}

///|
/// 收一帧文本(超时回 None):解析后的 JSON 对象;非法内容按 None 处理。
async fn ws_recv_frame(conn : @websocket.Conn) -> Json? {
  let text : String? = @async.with_timeout_opt(3000, () => {
    let msg = conn.recv()
    @utf8.decode_lossy(msg.read_all().binary())
  }) catch {
    _ => None
  }
  match text {
    Some(raw) => {
      let json = @json.parse(raw) catch { _ => return None }
      if json is Object(_) {
        Some(json)
      } else {
        None
      }
    }
    None => None
  }
}

///|
/// 取 JSON 对象的字符串字段(断言用,绕开 Json::String 只读构造)。
fn ws_json_str(obj : Map[String, Json], key : String) -> String? {
  match obj.get(key) {
    Some(String(value)) => Some(value)
    _ => None
  }
}

///|
/// 串行事件帧的序列化面(不起 socket):字段与前端 SyncEventItem 逐字对齐。
test "sync_event_frame:字段与前端 SyncEventItem 对齐" {
  let event : @daemon.SyncEventRecord = {
    path: "a.txt",
    direction: "remote",
    action: "add",
  }
  let frame = @json.parse(
    @api.sync_event_frame("f1", event, 1_720_000_000_000L),
  ) catch {
    _ => panic()
  }
  match frame {
    Object(obj) => {
      assert_eq(ws_json_str(obj, "type"), Some("syncEvent"))
      match obj.get("event") {
        Some(Object(event)) => {
          assert_eq(ws_json_str(event, "folderId"), Some("f1"))
          assert_eq(ws_json_str(event, "path"), Some("a.txt"))
          assert_eq(ws_json_str(event, "action"), Some("add"))
          assert_eq(ws_json_str(event, "direction"), Some("remote"))
          assert_true(event.get("ts") is Some(Number(_)))
        }
        _ => panic()
      }
    }
    _ => panic()
  }
  // status / ping 帧的信封
  let status = @json.parse(@api.status_frame(Json::object(Map([])))) catch {
    _ => panic()
  }
  match status {
    Object(obj) => assert_eq(ws_json_str(obj, "type"), Some("status"))
    _ => panic()
  }
  let ping = @json.parse(@api.ping_frame(1L)) catch { _ => panic() }
  match ping {
    Object(obj) => {
      assert_eq(ws_json_str(obj, "type"), Some("ping"))
      assert_true(obj.get("ts") is Some(Number(_)))
    }
    _ => panic()
  }
}

///|
/// 回环主用例:真实 actor + 真实 WS,断言状态帧与同步事件帧。
async test "WS /api/events:订阅后收到状态帧与真实同步事件" {
  let root = ws_fresh_root("loop")
  let spec = ws_make_spec(root)
  @async.with_task_group() <| group => {
    let handle = @daemon.start_session_actor(group, "dev-a", [spec])
    let options = @api.ApiOptions::new(
      device_id="TESTDEVICE01",
      control_token="test-token",
      config_file=Some("\{root}/config.json"),
      actor=Some(handle),
    )
    // 随机端口:先绑 :0 让内核挑,随即释放给本服务
    let probe = @socket.TcpServer(
      @socket.Addr::parse("127.0.0.1:0") catch {
        _ => panic()
      },
    )
    let port = probe.addr.port()
    probe.close()
    group.spawn_bg(no_wait=true) <| () => {
      @api.serve(options, "127.0.0.1:\{port}")
    }
    // 带签名票据连接(退避等监听就绪)
    let headers : Map[@http.CaseInsensitiveString, String] = Map([])
    headers.set("Cookie", "syncx_session=\{ws_mint_ticket()}")
    let url = "ws://127.0.0.1:\{port}/api/events"
    let mut connected : @websocket.Conn? = None
    for _ in 0..<100 {
      let attempt : @websocket.Conn? = @async.with_timeout_opt(200, () => {
        @websocket.Conn::connect(url, headers~)
      }) catch {
        _ => None
      }
      match attempt {
        Some(conn) => {
          connected = Some(conn)
          break
        }
        None => ()
      }
    }
    let conn = match connected {
      Some(conn) => conn
      None => panic()
    }
    // 第一帧:连上立刻收到的全量状态(Node status-hub 同款)
    let first = match ws_recv_frame(conn) {
      Some(frame) => frame
      None => panic()
    }
    match first {
      Object(obj) => {
        assert_eq(ws_json_str(obj, "type"), Some("status"))
        match obj.get("status") {
          Some(Object(status)) => {
            assert_eq(ws_json_str(status, "deviceId"), Some("TESTDEVICE01"))
            assert_eq(ws_json_str(status, "runtime"), Some("moonbit"))
            match status.get("entries") {
              Some(Number(entries, ..)) => assert_eq(entries, 0.0)
              _ => panic()
            }
            match status.get("folders") {
              Some(Array(folders)) => {
                assert_eq(folders.length(), 1)
                match folders[0] {
                  Object(folder) => {
                    assert_eq(ws_json_str(folder, "id"), Some("f1"))
                    assert_eq(ws_json_str(folder, "path"), Some(root))
                  }
                  _ => panic()
                }
              }
              _ => panic()
            }
          }
          _ => panic()
        }
      }
      _ => panic()
    }
    // 制造一次真实同步事件:挂对端 → 全量索引(b.txt 新文件)→ 规划执行
    let sink : @async.Queue[@daemon.Outbound] = @async.Queue(kind=Unbounded)
    let _ = handle.send(
      @daemon.Cmd::PeerOpen(folder="f1", remote_device_id="dev-b", sink~),
    )
    let _ = handle.send(
      @daemon.Cmd::PeerMessage(
        folder="f1",
        remote_device_id="dev-b",
        message=ws_index_message("f1", [
          ws_wire_entry("b.txt", "world", [("dev-b", 1L)]),
        ]),
      ),
    )
    let _ = handle.send(@daemon.Cmd::ApplyPlan("f1"))
    // 出站队列里等块请求(首帧是指纹,跳过),回块驱动落地完成
    let mut request : @net.WireBlockRequest? = None
    for _ in 0..<10 {
      let frame = sink.get()
      match frame {
        BlockRequest(req) => {
          request = Some(req)
          break
        }
        _ => ()
      }
    }
    let req = match request {
      Some(req) => req
      None => panic()
    }
    assert_eq(req.path, "b.txt")
    let _ = handle.send(
      @daemon.Cmd::PeerMessage(
        folder="f1",
        remote_device_id="dev-b",
        message=ws_block_response("f1", "b.txt", req.hash, "world"),
      ),
    )
    // 收帧直到 syncEvent(状态帧可能先到/后到,只认事件帧)
    let mut seen_event : Json? = None
    for _ in 0..<20 {
      match ws_recv_frame(conn) {
        Some(Object(obj)) =>
          match obj.get("type") {
            Some(String("syncEvent")) => {
              seen_event = obj.get("event")
              break
            }
            _ => ()
          }
        _ => panic()
      }
    }
    match seen_event {
      Some(Object(event)) => {
        assert_eq(ws_json_str(event, "folderId"), Some("f1"))
        assert_eq(ws_json_str(event, "path"), Some("b.txt"))
        assert_eq(ws_json_str(event, "action"), Some("add"))
        assert_eq(ws_json_str(event, "direction"), Some("remote"))
        assert_true(event.get("ts") is Some(Number(_)))
      }
      _ => panic()
    }
    // 差异驱动:状态变化后应再收一帧 entries=1 的 status(至多几帧内)
    let mut seen_updated = false
    for _ in 0..<20 {
      match ws_recv_frame(conn) {
        Some(Object(obj)) =>
          match obj.get("type") {
            Some(String("status")) =>
              match obj.get("status") {
                Some(Object(status)) =>
                  if status.get("entries") is Some(Number(n, ..)) && n == 1.0 {
                    seen_updated = true
                    break
                  }
                _ => ()
              }
            _ => ()
          }
        _ => break
      }
    }
    assert_true(seen_updated)
    conn.close()
    let _ = handle.send(@daemon.Cmd::Shutdown)
  }
}

///|
/// 认证门:未带凭据的握手被拒(前端据此区分「没登录」与「网络不通」)。
async test "WS /api/events:未认证握手被拒" {
  let root = ws_fresh_root("auth")
  let spec = ws_make_spec(root)
  @async.with_task_group() <| group => {
    let handle = @daemon.start_session_actor(group, "dev-a", [spec])
    let options = @api.ApiOptions::new(
      device_id="TESTDEVICE01",
      control_token="test-token",
      config_file=Some("\{root}/config.json"),
      actor=Some(handle),
    )
    let probe = @socket.TcpServer(
      @socket.Addr::parse("127.0.0.1:0") catch {
        _ => panic()
      },
    )
    let port = probe.addr.port()
    probe.close()
    group.spawn_bg(no_wait=true) <| () => {
      @api.serve(options, "127.0.0.1:\{port}")
    }
    // 先等 HTTP 面就绪(/health 免认证):就绪之后 WS 握手失败才可归因于认证门,
    // 而不是「服务还没起」
    let base = "http://127.0.0.1:\{port}"
    let mut ready = false
    for _ in 0..<100 {
      let code : Int32? = @async.with_timeout_opt(500, () => {
        let (response, _) = @http.get("\{base}/health")
        response.code
      }) catch {
        _ => None
      }
      if code is Some(200) {
        ready = true
        break
      }
      @async.sleep(50)
    }
    assert_true(ready)
    // 不带 cookie 的握手必须失败(401 拒升级)
    let attempt : @websocket.Conn? = @async.with_timeout_opt(2000, () => {
      @websocket.Conn::connect("ws://127.0.0.1:\{port}/api/events")
    }) catch {
      _ => None
    }
    assert_true(attempt is None)
    let _ = handle.send(@daemon.Cmd::Shutdown)
  }
}
