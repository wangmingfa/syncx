///|
/// 会话 actor 黑盒测试:真实文件系统行为(/tmp 临时目录),对端用出站队列
/// 扮演(收帧 → 转命令 → 检查出站),闭环覆盖「扫描 → 规划 → 执行」与
/// 指纹交换、增量规划、墓碑删除、冲突保留。

///|
/// 读回小文件文本(测试断言用;一次读满即可,文件都是几十字节)。
async fn actor_read_text(path : String) -> String {
  let file = @fs.open(path, mode=ReadOnly) catch { _ => return "" }
  defer file.close()
  let buf : FixedArray[Byte] = FixedArray::make(4096, b'\x00')
  let n = file.read(buf)
  @utf8.decode_lossy(Bytes::from_array(buf.exact_view(end=n)))
}

///|
/// 建一个本测试专属的临时根目录。
async fn actor_fresh_root(tag : String) -> String {
  let root = "/tmp/syncx-mb-actor-\{tag}-\{@daemon.now_ms()}"
  @fs.mkdir(root, recursive=true, allow_exist=true)
  root
}

///|
async fn actor_write_file(
  root : String,
  rel : String,
  content : String,
) -> String {
  let abs = "\{root}/\{rel}"
  let idx = abs.rev_find("/")
  match idx {
    Some(i) => @fs.mkdir(abs[0:i].to_owned(), recursive=true, allow_exist=true)
    None => ()
  }
  @fs.write_file(abs, content, create_mode=CreateOrTruncate)
  abs
}

///|
/// 构造目录参数:状态目录(index.db / 回收站)放共享树之外,
/// 否则它们自己也会被扫进 changed。每个测试独占一份,不互串。
/// `kbps` 供限速测试设置目录级 maxBandwidthKbps(None = 不限)。
async fn actor_make_spec(
  root : String,
  kbps~ : Int32? = None,
) -> @daemon.FolderSpec {
  let state = "\{root}-state"
  @fs.mkdir(state, recursive=true, allow_exist=true)
  // 清掉上次运行可能残留的同名库(同毫秒时间戳撞名时兜底)
  let db = @sqlite.open("\{state}/index.db")
  db.exec("DROP TABLE IF EXISTS entries")
  db.close()
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
    max_bandwidth_kbps: kbps,
    // actor 单测不覆盖 git 镜像路径,一律按 off 装配(检测/镜像全关)。
    git_sync: @daemon.GitSyncMode::Off,
    git_strip_co_authored: false,
  }
}

///|
/// wire 索引条目:定长块哈希由内容直接算出(size 与 blocks 一致)。
fn actor_wire_entry(
  path : String,
  content : String,
  version : Array[(String, Int64)],
  deleted~ : Bool = false,
) -> @net.WireEntry {
  {
    path,
    version,
    size: if deleted {
      0L
    } else {
      @utf8.encode(content).length().to_int64()
    },
    deleted,
    blocks: if deleted {
      []
    } else {
      [@core.hash_block(@utf8.encode(content))]
    },
    mtime: 0.0,
    cdh: None,
    clens: None,
  }
}

///|
/// 组一条 Index 消息(与驱动层同一编码路径:encodeIndex → base64)。
fn actor_index_message(
  folder : String,
  entries : Array[@net.WireEntry],
  full~ : Bool = false,
) -> @net.WireMessage {
  let body = @net.encode_index(entries)
  @net.WireMessage::Index(
    folder~,
    payload=@base64.encode(@utf8.encode(body)),
    full=Some(full),
    relayed=None,
  )
}

///|
/// 组一条块响应消息。
fn actor_block_response(
  folder : String,
  path : String,
  hash : String,
  content : String,
) -> @net.WireMessage {
  @net.WireMessage::BlockResponse(folder~, payload={
    device_id: "peer",
    path,
    block_index: 0L,
    hash,
    data: @base64.encode(@utf8.encode(content)),
    cdc: None,
  })
}

///|
/// 非阻塞地看一眼出站队列:有帧返回,没有返回 None(用于断言「不该再发」)。
fn actor_try_peek(sink : @async.Queue[@daemon.Outbound]) -> @daemon.Outbound? {
  sink.try_get() catch {
    _ => None
  }
}

///|
async test "actor: 并发投递的命令全部串行落账" {
  let root = actor_fresh_root("serial")
  let _ = actor_write_file(root, "a.txt", "hello")
  let spec = actor_make_spec(root)
  @async.with_task_group() <| group => {
    let handle = @daemon.start_session_actor(group, "dev-a", [spec])
    // 三个并发发送者:各挂一个对端会话;done 队列确保三者都已投递,
    // 再叠一条扫描命令 —— actor 串行消化这四条,一条不丢。
    let done : @async.Queue[String] = @async.Queue(kind=Unbounded)
    for device in ["dev-b", "dev-c", "dev-d"] {
      group.spawn_bg(allow_failure=true) <| () => {
        let sink : @async.Queue[@daemon.Outbound] = @async.Queue(kind=Unbounded)
        let _ = handle.send(
          @daemon.Cmd::PeerOpen(folder="f1", remote_device_id=device, sink~),
        )
        done.put(device)
      }
    }
    // 等三个发送者全部投递完,再补一条扫描命令
    let _ = done.get()
    let _ = done.get()
    let _ = done.get()
    let _ = handle.send(@daemon.Cmd::ScanFolder("f1"))
    // 快照回执 = 此前全部命令都已处理完
    let snap = handle.sync_snapshot()
    assert_eq(snap.folders.length(), 1)
    let status = snap.folders[0]
    assert_eq(status.id, "f1")
    assert_eq(status.peers, 3)
    assert_eq(status.entries, 1L)
    assert_eq(status.tombstones, 0L)
    assert_eq(status.paused, false)
    let _ = handle.send(@daemon.Cmd::Shutdown)
    ()
  }
}

///|
async test "actor: 扫描→计划→执行闭环(全量索引驱动落地)" {
  let root = actor_fresh_root("loop")
  let _ = actor_write_file(root, "a.txt", "hello")
  let spec = actor_make_spec(root)
  @async.with_task_group() <| group => {
    let handle = @daemon.start_session_actor(group, "dev-a", [spec])
    let _ = handle.send(@daemon.Cmd::ScanFolder("f1"))
    let snap = handle.sync_snapshot()
    assert_eq(snap.folders[0].entries, 1L)
    // 挂对端 → 先收到本机索引指纹
    let sink : @async.Queue[@daemon.Outbound] = @async.Queue(kind=Unbounded)
    let _ = handle.send(
      @daemon.Cmd::PeerOpen(folder="f1", remote_device_id="dev-b", sink~),
    )
    let fingerprint = match sink.get() {
      IndexFingerprint(fp) => fp
      _ => fail("首帧应为索引指纹")
    }
    assert_true(fingerprint.length() > 0)
    // 对端发全量:a.txt 与本地一致(无动作)+ b.txt 新文件(接收)
    let remote_entries : Array[@net.WireEntry] = [
      actor_wire_entry("a.txt", "hello", [("dev-a", 1L)]),
      actor_wire_entry("b.txt", "world", [("dev-b", 1L)]),
    ]
    let _ = handle.send(
      @daemon.Cmd::PeerMessage(
        folder="f1",
        remote_device_id="dev-b",
        message=actor_index_message("f1", remote_entries, full=true),
      ),
    )
    let _ = handle.send(@daemon.Cmd::ApplyPlan("f1"))
    // 唯一的动作是 b.txt 的块请求(a.txt 判等无动作,没有回推帧)
    let request = match sink.get() {
      BlockRequest(req) => req
      _ => fail("应为块请求")
    }
    assert_eq(request.path, "b.txt")
    assert_eq(request.block_index, 0L)
    // 回块 → 落地执行
    let _ = handle.send(
      @daemon.Cmd::PeerMessage(
        folder="f1",
        remote_device_id="dev-b",
        message=actor_block_response("f1", "b.txt", request.hash, "world"),
      ),
    )
    let snap = handle.sync_snapshot()
    assert_eq(snap.folders[0].entries, 2L)
    assert_eq(actor_read_text("\{root}/b.txt"), "world")
    // 事件流:一次远端新增
    let events_reply : @async.Queue[Array[@daemon.SyncEventRecord]] = @async.Queue(
      kind=Unbounded,
    )
    let _ = handle.send(
      @daemon.Cmd::DrainEvents(folder="f1", reply=events_reply),
    )
    let events = events_reply.get()
    assert_eq(events.length(), 1)
    assert_eq(events[0].path, "b.txt")
    assert_eq(events[0].direction, "remote")
    assert_eq(events[0].action, "add")
    let _ = handle.send(@daemon.Cmd::Shutdown)
    ()
  }
}

///|
async test "actor: 增量规划不回推未提及的条目" {
  let root = actor_fresh_root("delta")
  let _ = actor_write_file(root, "a.txt", "aaa")
  let _ = actor_write_file(root, "c.txt", "ccc")
  let spec = actor_make_spec(root)
  @async.with_task_group() <| group => {
    let handle = @daemon.start_session_actor(group, "dev-a", [spec])
    let _ = handle.send(@daemon.Cmd::ScanFolder("f1"))
    let sink : @async.Queue[@daemon.Outbound] = @async.Queue(kind=Unbounded)
    let _ = handle.send(
      @daemon.Cmd::PeerOpen(folder="f1", remote_device_id="dev-b", sink~),
    )
    let _ = sink.get() // 指纹帧
    // 增量索引只提 a.txt(对端改过它);c.txt 没提到 ≠ 对端缺失
    let delta : Array[@net.WireEntry] = [
      actor_wire_entry("a.txt", "changed", [("dev-a", 1L), ("dev-b", 1L)]),
    ]
    let _ = handle.send(
      @daemon.Cmd::PeerMessage(
        folder="f1",
        remote_device_id="dev-b",
        message=actor_index_message("f1", delta, full=false),
      ),
    )
    let _ = handle.send(@daemon.Cmd::ApplyPlan("f1"))
    // 只该有 a.txt 的块请求,绝不该有「回推 c.txt」的 Entries 帧
    let request = match sink.get() {
      BlockRequest(req) => req
      _ => fail("应为块请求")
    }
    assert_eq(request.path, "a.txt")
    assert_true(actor_try_peek(sink) is None)
    let snap = handle.sync_snapshot()
    assert_eq(snap.folders[0].entries, 2L)
    let _ = handle.send(@daemon.Cmd::Shutdown)
    ()
  }
}

///|
async test "actor: 指纹交换(一致互免全量,不一致请求全量)" {
  let root = actor_fresh_root("fingerprint")
  let spec = actor_make_spec(root)
  @async.with_task_group() <| group => {
    let handle = @daemon.start_session_actor(group, "dev-a", [spec])
    let sink : @async.Queue[@daemon.Outbound] = @async.Queue(kind=Unbounded)
    let _ = handle.send(
      @daemon.Cmd::PeerOpen(folder="f1", remote_device_id="dev-b", sink~),
    )
    let fingerprint = match sink.get() {
      IndexFingerprint(fp) => fp
      _ => fail("首帧应为索引指纹")
    }
    // 对端指纹一致 → 本机确认,不再发全量
    let _ = handle.send(
      @daemon.Cmd::PeerMessage(
        folder="f1",
        remote_device_id="dev-b",
        message=@net.WireMessage::IndexFingerprint(folder="f1", fingerprint~),
      ),
    )
    let _ = handle.sync_snapshot()
    assert_eq(sink.get() is IndexAck, true)
    // 对端指纹不同 → 请求对端发全量
    let _ = handle.send(
      @daemon.Cmd::PeerMessage(
        folder="f1",
        remote_device_id="dev-b",
        message=@net.WireMessage::IndexFingerprint(
          folder="f1",
          fingerprint="definitely-different",
        ),
      ),
    )
    let _ = handle.sync_snapshot()
    assert_eq(sink.get() is IndexRequest, true)
    // 对端按请求回全量 → 本机侧的同一分支也会给出自己的全量
    let _ = handle.send(
      @daemon.Cmd::PeerMessage(
        folder="f1",
        remote_device_id="dev-b",
        message=@net.WireMessage::IndexRequest(folder="f1"),
      ),
    )
    let _ = handle.sync_snapshot()
    match sink.get() {
      Entries(full~, ..) => assert_eq(full, true)
      _ => fail("应为全量索引帧")
    }
    let _ = handle.send(@daemon.Cmd::Shutdown)
    ()
  }
}

///|
async test "actor: 对端墓碑驱动本地删除" {
  let root = actor_fresh_root("tombstone")
  let _ = actor_write_file(root, "gone.txt", "bye")
  let spec = actor_make_spec(root)
  @async.with_task_group() <| group => {
    let handle = @daemon.start_session_actor(group, "dev-a", [spec])
    let _ = handle.send(@daemon.Cmd::ScanFolder("f1"))
    let sink : @async.Queue[@daemon.Outbound] = @async.Queue(kind=Unbounded)
    let _ = handle.send(
      @daemon.Cmd::PeerOpen(folder="f1", remote_device_id="dev-b", sink~),
    )
    let _ = sink.get() // 指纹帧
    // 对端已删除该文件(版本比本地新)
    let delta : Array[@net.WireEntry] = [
      actor_wire_entry(
        "gone.txt",
        "",
        [("dev-a", 1L), ("dev-b", 1L)],
        deleted=true,
      ),
    ]
    let _ = handle.send(
      @daemon.Cmd::PeerMessage(
        folder="f1",
        remote_device_id="dev-b",
        message=actor_index_message("f1", delta, full=false),
      ),
    )
    let _ = handle.send(@daemon.Cmd::ApplyPlan("f1"))
    let snap = handle.sync_snapshot()
    assert_eq(snap.folders[0].tombstones, 1L)
    assert_eq(snap.folders[0].entries, 0L)
    // 文件本体已进回收站(共享树里不再有)
    assert_eq(@fs.exists("\{root}/gone.txt") catch { _ => true }, false)
    let events_reply : @async.Queue[Array[@daemon.SyncEventRecord]] = @async.Queue(
      kind=Unbounded,
    )
    let _ = handle.send(
      @daemon.Cmd::DrainEvents(folder="f1", reply=events_reply),
    )
    let events = events_reply.get()
    assert_eq(events.length(), 1)
    assert_eq(events[0].path, "gone.txt")
    assert_eq(events[0].direction, "remote")
    assert_eq(events[0].action, "delete")
    let _ = handle.send(@daemon.Cmd::Shutdown)
    ()
  }
}

///|
async test "actor: 双活冲突保留双方(本地副本 + 远端内容)" {
  let root = actor_fresh_root("conflict")
  let _ = actor_write_file(root, "doc.txt", "local-edit")
  let spec = actor_make_spec(root)
  @async.with_task_group() <| group => {
    let handle = @daemon.start_session_actor(group, "dev-a", [spec])
    let _ = handle.send(@daemon.Cmd::ScanFolder("f1"))
    let sink : @async.Queue[@daemon.Outbound] = @async.Queue(kind=Unbounded)
    let _ = handle.send(
      @daemon.Cmd::PeerOpen(folder="f1", remote_device_id="dev-b", sink~),
    )
    let _ = sink.get() // 指纹帧
    // 双方各自改过 doc.txt(版本并发)
    let delta : Array[@net.WireEntry] = [
      actor_wire_entry("doc.txt", "remote-edit", [("dev-b", 1L)]),
    ]
    let _ = handle.send(
      @daemon.Cmd::PeerMessage(
        folder="f1",
        remote_device_id="dev-b",
        message=actor_index_message("f1", delta, full=false),
      ),
    )
    let _ = handle.send(@daemon.Cmd::ApplyPlan("f1"))
    // 冲突也走拉块:远端内容落地,本地保留为冲突副本
    let request = match sink.get() {
      BlockRequest(req) => req
      _ => fail("应为块请求")
    }
    assert_eq(request.path, "doc.txt")
    let _ = handle.send(
      @daemon.Cmd::PeerMessage(
        folder="f1",
        remote_device_id="dev-b",
        message=actor_block_response(
          "f1",
          "doc.txt",
          request.hash,
          "remote-edit",
        ),
      ),
    )
    let snap = handle.sync_snapshot()
    assert_eq(snap.folders[0].entries, 1L)
    // 原路径换成了远端内容
    assert_eq(actor_read_text("\{root}/doc.txt"), "remote-edit")
    // 本地内容保留为 .sync-conflict- 副本
    let copies : Array[String] = []
    for name in @fs.readdir(root) {
      if name.contains(".sync-conflict-") {
        copies.push(name)
      }
    }
    assert_eq(copies.length(), 1)
    assert_eq(actor_read_text("\{root}/\{copies[0]}"), "local-edit")
    let _ = handle.send(@daemon.Cmd::Shutdown)
    ()
  }
}

///|
async test "actor: Shutdown 结束循环,此后投递被拒绝" {
  let root = actor_fresh_root("shutdown")
  let spec = actor_make_spec(root)
  @async.with_task_group() <| group => {
    let handle = @daemon.start_session_actor(group, "dev-a", [spec])
    let _ = handle.send(@daemon.Cmd::Shutdown)
    // 轮询等待 actor 退出(队列关闭后 send 返回 false)
    let mut closed = false
    for _ in 0..<200 {
      if !handle.send(@daemon.Cmd::ScanFolder("f1")) {
        closed = true
        break
      }
      @async.sleep(10)
    }
    assert_eq(closed, true)
  }
}

// ==================== 传输可靠性:真实回环 ====================

///|
/// 轮询等待(总量 ~5s,50ms 一拍)。
async fn actor_wait_until(check : () -> Bool) -> Bool {
  for _ in 0..<100 {
    if check() {
      return true
    }
    @async.sleep(50)
  }
  false
}

///|
/// 建目录(接收侧空根也要存在,否则落地写不进去)。
async fn actor_mkdir(path : String) -> Unit {
  @fs.mkdir(path, recursive=true, allow_exist=true)
}

///|
/// Outbound 帧 → wire 消息(测试驱动层,模拟未来 WS 驱动层的编码职责;
/// 文本信封口径与 daemon 侧 decode_index_payload 对称)。
fn actor_outbound_to_wire(
  folder : String,
  frame : @daemon.Outbound,
) -> @net.WireMessage {
  match frame {
    Entries(entries~, full~, relayed~) =>
      @net.WireMessage::Index(
        folder~,
        payload=@base64.encode(@utf8.encode(@net.encode_index(entries))),
        full=Some(full),
        relayed=Some(relayed),
      )
    BlockRequest(req) => @net.WireMessage::BlockRequest(folder~, payload=req)
    BlockResponse(resp) =>
      @net.WireMessage::BlockResponse(folder~, payload=resp)
    IndexFingerprint(fp) =>
      @net.WireMessage::IndexFingerprint(folder~, fingerprint=fp)
    IndexAck => @net.WireMessage::IndexAck(folder~)
    IndexRequest => @net.WireMessage::IndexRequest(folder~)
    GitCommitNotify(notify) => @net.WireMessage::Control(payload=notify)
  }
}

///|
/// 回环环境:两条会话 actor 经真实 WS(PeerServer × PeerClient,Plain
/// 模式)互连。A 是客户端侧主动连 B;两侧各一条「出站泵」把 Outbound 帧
/// 编码成 wire 消息写进 socket,入站消息原样转成 PeerMessage,索引到达
/// 再补一条 ApplyPlan —— 这就是未来 WS 驱动层的全部职责面。
struct ActorLoop {
  handle_a : @daemon.ActorHandle
  handle_b : @daemon.ActorHandle
  /// B 侧收到的块请求记录:`path#index#cdc`(重试计数 / 口径断言用)。
  requests : Array[String]
  /// A 的出站队列(测试收尾要关掉它,叫停出站泵)。
  sink_a : @async.Queue[@daemon.Outbound]
  /// B 的出站队列(同上)。
  sink_b : @async.Queue[@daemon.Outbound]
  /// A 发出的全量索引帧计数(初始交换兜底测试用)。
  fulls_from_a : Array[Bool]
  /// A 侧客户端连接(收尾必须关掉,否则 A 的读循环永不退出,
  /// TaskGroup 陪着它一起挂住)。
  client : @net.PeerClient
}

///|
/// 起回环。`drop_responses` = B→A 方向丢弃块响应(模拟对端「请求收得到、
/// 响应回不来」的失联,驱动 A 侧的超时重试与放弃)。
async fn actor_loop_start(
  group : @async.TaskGroup[Unit],
  spec_a : @daemon.FolderSpec,
  spec_b : @daemon.FolderSpec,
  drop_responses~ : Bool = false,
  drop_fingerprints~ : Bool = false,
) -> ActorLoop {
  let handle_a = @daemon.start_session_actor(group, "DEV-A", [spec_a])
  let handle_b = @daemon.start_session_actor(group, "DEV-B", [spec_b])
  let requests : Array[String] = []
  let fulls_from_a : Array[Bool] = []
  let sink_a : @async.Queue[@daemon.Outbound] = @async.Queue(kind=Unbounded)
  let sink_b : @async.Queue[@daemon.Outbound] = @async.Queue(kind=Unbounded)
  // B 侧服务端:注册即挂会话;入站转命令,索引到达补 ApplyPlan
  let handlers : @net.PeerServerHandlers = {
    on_connect: device => {
      let _ = handle_b.send(
        @daemon.Cmd::PeerOpen(folder="f1", remote_device_id=device, sink=sink_b),
      )
      ()
    },
    on_message: (device, message) => {
      match message {
        BlockRequest(payload~, ..) =>
          requests.push(
            "\{payload.path}#\{payload.block_index}#\{payload.cdc == Some(true)}",
          )
        _ => ()
      }
      // drop_fingerprints:模拟旧版对端 —— 收到指纹不转交也不应答,
      // A 侧的初始交换兜底因此成为唯一出路
      if drop_fingerprints && message is IndexFingerprint(_) {
        return
      }
      let _ = handle_b.send(
        @daemon.Cmd::PeerMessage(folder="f1", remote_device_id=device, message~),
      )
      match message {
        Index(..) => {
          let _ = handle_b.send(@daemon.Cmd::ApplyPlan("f1"))
          ()
        }
        _ => ()
      }
    },
    on_binary: (_device, _data) => (),
    on_disconnect: device => {
      let _ = handle_b.send(
        @daemon.Cmd::PeerClose(folder="f1", remote_device_id=device),
      )
    },
    on_error: _reason => (),
  }
  let server = @net.start_peer_server(@net.PeerHandshakeMode::Plain, handlers) catch {
    _ => panic()
  }
  group.spawn_bg(no_wait=true) <| () => { server.listen() }
  // A 侧客户端:连上即自报家门(Plain 注册),再挂 A 的会话
  let url = "ws://127.0.0.1:\{server.bound_port()}\{@net.PEER_WS_PATH}"
  let client = @net.connect_peer(@net.PeerHandshakeMode::Plain, url) catch {
    _ => panic()
  }
  client.send_message(
    @net.Control(payload=@net.make_hello("DEV-A", None, None)),
  )
  let _ = handle_a.send(
    @daemon.Cmd::PeerOpen(folder="f1", remote_device_id="DEV-B", sink=sink_a),
  )
  // A 出站泵:Outbound 帧 → wire 消息
  group.spawn_bg(allow_failure=true, no_wait=true) <| () => {
    let mut running = true
    while running {
      let frame : @daemon.Outbound? = Some(sink_a.get()) catch { _ => None }
      match frame {
        Some(Entries(full~, ..)) => fulls_from_a.push(full)
        Some(_) => ()
        None => running = false
      }
      match frame {
        Some(f) =>
          client.send_message(actor_outbound_to_wire("f1", f)) catch {
            _ => running = false
          }
        None => running = false
      }
    }
  }
  // A 入站泵:wire 消息 → PeerMessage(索引到达补 ApplyPlan)
  group.spawn_bg(allow_failure=true, no_wait=true) <| () => {
    let mut running = true
    while running {
      let incoming : @net.WireMessage? = Some(client.recv_message()) catch {
        _ => None
      }
      match incoming {
        Some(m) => {
          let _ = handle_a.send(
            @daemon.Cmd::PeerMessage(
              folder="f1",
              remote_device_id="DEV-B",
              message=m,
            ),
          )
          match m {
            Index(..) => {
              let _ = handle_a.send(@daemon.Cmd::ApplyPlan("f1"))
              ()
            }
            _ => ()
          }
        }
        None => running = false
      }
    }
  }
  // B 出站泵:可按需丢块响应(模拟失联)/ 丢指纹(模拟旧版对端)
  group.spawn_bg(allow_failure=true, no_wait=true) <| () => {
    let mut running = true
    while running {
      let frame : @daemon.Outbound? = Some(sink_b.get()) catch { _ => None }
      match frame {
        Some(BlockResponse(_)) =>
          if drop_responses {
            () // 丢弃:让 A 侧的超时重试机制成为唯一出路
          } else {
            // B 是服务端侧:出站经 server 写回客户端
            server.send_message(
              "DEV-A",
              actor_outbound_to_wire("f1", frame.unwrap()),
            ) catch {
              _ => running = false
            }
          }
        Some(IndexFingerprint(_)) =>
          if drop_fingerprints {
            () // 丢弃:B 的主动指纹也不许结算 A 的会话
          } else {
            server.send_message(
              "DEV-A",
              actor_outbound_to_wire("f1", frame.unwrap()),
            ) catch {
              _ => running = false
            }
          }
        Some(f) =>
          server.send_message("DEV-A", actor_outbound_to_wire("f1", f)) catch {
            _ => running = false
          }
        None => running = false
      }
    }
  }
  { handle_a, handle_b, requests, sink_a, sink_b, fulls_from_a, client, }
}

///|
/// 回环收尾:关两条 actor、断客户端、关出站队列叫停泵,让 TaskGroup 能退出。
async fn actor_loop_stop(env : ActorLoop) -> Unit {
  let _ = env.handle_a.send(@daemon.Cmd::Shutdown)
  let _ = env.handle_b.send(@daemon.Cmd::Shutdown)
  @async.sleep(50)
  env.client.close()
  @async.sleep(50)
  env.sink_a.close(clear=true)
  env.sink_b.close(clear=true)
  @async.sleep(50)
}

///|
async test "actor 回环: 两端经真实 WS 完成一次文件同步" {
  let root_b = actor_fresh_root("env-b")
  let _ = actor_write_file(root_b, "hi.txt", "hello-loopback")
  let root_a = actor_fresh_root("env-a")
  actor_mkdir(root_a)
  let spec_a = actor_make_spec(root_a)
  let spec_b = actor_make_spec(root_b)
  @async.with_task_group() <| group => {
    let env = actor_loop_start(group, spec_a, spec_b)
    // 会话挂上后扫 B:增量外推驱动 A 规划接收
    assert_true(
      actor_wait_until(() => env.handle_b.snapshot().folders[0].peers == 1),
    )
    let _ = env.handle_b.send(@daemon.Cmd::ScanFolder("f1"))
    // B 的文件最终落在 A 的共享树里(扫描 → 规划 → 供块 → 落地全程真实)
    assert_true(
      actor_wait_until(() => env.handle_a.snapshot().folders[0].entries == 1L),
    )
    assert_eq(actor_read_text("\{root_a}/hi.txt"), "hello-loopback")
    actor_loop_stop(env)
  }
}

///|
async test "actor 回环: 块请求超时重发,达上限放弃并记录事件" {
  let root_b = actor_fresh_root("retry-b")
  let _ = actor_write_file(root_b, "slow.txt", "nobody-answers")
  let root_a = actor_fresh_root("retry-a")
  actor_mkdir(root_a)
  let spec_a = actor_make_spec(root_a)
  let spec_b = actor_make_spec(root_b)
  @async.with_task_group() <| group => {
    // B→A 丢块响应:A 的块请求永远无人应答,只能靠超时重试
    let env = actor_loop_start(group, spec_a, spec_b, drop_responses=true)
    assert_true(
      actor_wait_until(() => env.handle_b.snapshot().folders[0].peers == 1),
    )
    // 初始交换兜底与计数共用真实墙钟:极端调度下「指纹无应答」的兜底帧会在
    // 2s 后由周期泵发出(每会话恰一次),其引发的「对端重规划 → 重发增量 →
    // 本端重开接收」会多出一条块请求,冲掉下面的精确计数。先在两侧各快进
    // 一拍把它确定性地消耗掉(已结算则为空操作),再进入计数窗口。
    let _ = env.handle_a.send(
      @daemon.Cmd::PollTimeouts(now=@daemon.now_ms() + 3000L),
    )
    let _ = env.handle_a.sync_snapshot()
    let _ = env.handle_b.send(
      @daemon.Cmd::PollTimeouts(now=@daemon.now_ms() + 3000L),
    )
    let _ = env.handle_b.sync_snapshot()
    @async.sleep(200)
    let _ = env.handle_a.sync_snapshot()
    let _ = env.handle_b.send(@daemon.Cmd::ScanFolder("f1"))
    assert_true(actor_wait_until(() => env.requests.length() >= 1))
    let t0 = @daemon.now_ms()
    // 三次快进 5s:各触发一次重发(首请求 + 3 次重发 = 4 条)
    for step in [6001L, 12001L, 18001L] {
      let _ = env.handle_a.send(@daemon.Cmd::PollTimeouts(now=t0 + step))
      let want = env.requests.length() + 1
      assert_true(actor_wait_until(() => env.requests.length() >= want))
    }
    // 第四次快进:重试耗尽 → 放弃。快照回执作屏障,放弃必已处理完。
    let _ = env.handle_a.send(@daemon.Cmd::PollTimeouts(now=t0 + 24001L))
    let _ = env.handle_a.sync_snapshot()
    assert_eq(env.requests.length(), 4)
    // 事件流:3 次重发 + 1 次放弃
    let reply : @async.Queue[Array[@daemon.SyncEventRecord]] = @async.Queue(
      kind=Unbounded,
    )
    let _ = env.handle_a.send(@daemon.Cmd::DrainEvents(folder="f1", reply~))
    let events = reply.get()
    let mut retries = 0
    let mut giveups = 0
    for event in events {
      if event.action == "block_retry" {
        retries += 1
      }
      if event.action == "block_giveup" {
        giveups += 1
      }
    }
    assert_eq(retries, 3)
    assert_eq(giveups, 1)
    actor_loop_stop(env)
  }
}

///|
async test "actor 回环: 初始交换 2s 无应答,兜底补发全量恰好一次" {
  // 两侧空树:指纹天然一致;对端(B)不认指纹 → A 的指纹永远无人应答,
  // 兜底是初始交换的唯一出路(对齐 Rust INITIAL_INDEX_FALLBACK_MS 场景)
  let root_a = actor_fresh_root("fallback-a")
  actor_mkdir(root_a)
  let root_b = actor_fresh_root("fallback-b")
  actor_mkdir(root_b)
  let spec_a = actor_make_spec(root_a)
  let spec_b = actor_make_spec(root_b)
  @async.with_task_group() <| group => {
    let env = actor_loop_start(group, spec_a, spec_b, drop_fingerprints=true)
    assert_true(
      actor_wait_until(() => env.handle_a.snapshot().folders[0].peers == 1),
    )
    // 兜底恰发一次:真实 500ms 周期泵与注入的快进拍都可能触发,断言只看
    // 「发过一次」与「之后不再发」,不与时序竞争 —— 结算位(deadline 摘除
    // + settled 置位)保证唯一性。
    assert_true(actor_wait_until(() => env.fulls_from_a.length() >= 1))
    let _ = env.handle_a.send(
      @daemon.Cmd::PollTimeouts(now=@daemon.now_ms() + 5000L),
    )
    let _ = env.handle_a.sync_snapshot()
    @async.sleep(100)
    assert_eq(env.fulls_from_a.length(), 1)
    actor_loop_stop(env)
  }
}

///|
async test "actor 回环: 限速下出站块响应被令牌桶压住" {
  let root_b = actor_fresh_root("rate-b")
  // 30 个小文件 × 50B = 1500B;B 配 1 KB/s(桶容量 1024B):
  // 首批最多放行 ~20 条,剩下的必须等令牌补充。
  for i in 0..<30 {
    let _ = actor_write_file(
      root_b,
      "f\{i}.txt",
      "01234567890123456789012345678901234567890123456789",
    )
  }
  let root_a = actor_fresh_root("rate-a")
  actor_mkdir(root_a)
  let spec_a = actor_make_spec(root_a)
  let spec_b = actor_make_spec(root_b, kbps=Some(1))
  @async.with_task_group() <| group => {
    let env = actor_loop_start(group, spec_a, spec_b)
    assert_true(
      actor_wait_until(() => env.handle_b.snapshot().folders[0].peers == 1),
    )
    let _ = env.handle_b.send(@daemon.Cmd::ScanFolder("f1"))
    // 30 条块请求先全部抵达 B
    assert_true(actor_wait_until(() => env.requests.length() >= 30))
    // 短窗内 A 落地的文件数必须被压在 30 以下(不限速时这批小响应
    // 在毫秒级全部到达 —— 见「完成一次文件同步」的对照)
    @async.sleep(200)
    let snap = env.handle_a.snapshot()
    assert_true(
      snap.folders[0].entries < 30L,
      msg="限速应在 200ms 内压住出站",
    )
    // 令牌随时间补充,最终全部送达(1500B @ 1KB/s ≈ 1.5s)
    let done = actor_wait_until(() => {
      let s = env.handle_a.snapshot()
      s.folders[0].entries == 30L
    })
    assert_true(done)
    actor_loop_stop(env)
  }
}

///|
/// 配置热重载:Reconfigure 对账重建目录集。保留目录就地更新运行期字段
/// (paused 即刻生效)、新增目录入列、移除目录出列;索引库按 index_path
/// 复用,重载不清索引。
async test "配置热重载:Reconfigure 对账重建目录集" {
  @async.with_task_group() <| group => {
    let root_a = "/tmp/syncx-mb-actor-reload-a-\{@daemon.now_ms()}"
    let root_b = "/tmp/syncx-mb-actor-reload-b-\{@daemon.now_ms()}"
    @fs.mkdir(root_a, recursive=true, allow_exist=true)
    @fs.mkdir(root_b, recursive=true, allow_exist=true)
    let spec_a = actor_make_spec(root_a)
    let handle = @daemon.start_session_actor(group, "reload-device", [spec_a])
    // 初始:仅 f1;重载后 f1 暂停 + 新增 f2
    let spec_b = { ..actor_make_spec(root_b), id: "f2", }
    let _ = handle.send(
      @daemon.Cmd::Reconfigure(specs=[{ ..spec_a, paused: true, }, spec_b]),
    )
    assert_true(
      actor_wait_until(() => {
        let s = handle.snapshot()
        s.folders.length() == 2 &&
        s.folders[0].paused &&
        s.folders[1].id == "f2"
      }),
      msg="重载后应有两个目录,f1 暂停生效,f2 就位",
    )
    // 移除 f1:f2 保留
    let _ = handle.send(@daemon.Cmd::Reconfigure(specs=[spec_b]))
    assert_true(
      actor_wait_until(() => {
        let s = handle.snapshot()
        s.folders.length() == 1 && s.folders[0].id == "f2"
      }),
      msg="重载后仅剩 f2",
    )
    // 恢复 f1(同 index_path):原库原索引接上,不再是 paused
    let _ = handle.send(@daemon.Cmd::Reconfigure(specs=[spec_a, spec_b]))
    assert_true(
      actor_wait_until(() => {
        let s = handle.snapshot()
        s.folders.length() == 2 && !s.folders[0].paused
      }),
      msg="f1 重新添加后恢复未暂停态",
    )
    let _ = handle.send(@daemon.Cmd::Shutdown)
  }
}

///|
/// status 数据面接线(冒烟):供块 → 发送字节落账 + 租约进「发送中」;收块 →
/// 接收字节落账 + 落地。断言对象是 sync_snapshot 带回的 progress / traffic,
/// 口径与 api 层折算前的结构化形态一致(逐字段 JSON 形态在 api 包单测)。
async test "actor: 供块/收块字节落账 syncProgress 与 traffic" {
  let root = actor_fresh_root("progress-wire")
  let content = "0123456789ABCDEF"
  let _ = actor_write_file(root, "send.bin", content)
  let spec = actor_make_spec(root)
  @async.with_task_group() <| group => {
    let handle = @daemon.start_session_actor(group, "dev-a", [spec])
    let _ = handle.send(@daemon.Cmd::ScanFolder("f1"))
    let _ = handle.sync_snapshot()
    let sink : @async.Queue[@daemon.Outbound] = @async.Queue(kind=Unbounded)
    let _ = handle.send(
      @daemon.Cmd::PeerOpen(folder="f1", remote_device_id="dev-b", sink~),
    )
    let _ = sink.get() // 指纹帧
    // —— 供块:对端来要 send.bin 第 0 块 → 出一条 BlockResponse,发送落账
    let send_hash = @core.hash_block(@utf8.encode(content))
    let _ = handle.send(
      @daemon.Cmd::PeerMessage(
        folder="f1",
        remote_device_id="dev-b",
        message=@net.WireMessage::BlockRequest(folder="f1", payload={
          device_id: "dev-b",
          path: "send.bin",
          block_index: 0L,
          hash: send_hash,
          priority: None,
          cdc: None,
        }),
      ),
    )
    match sink.get() {
      @daemon.Outbound::BlockResponse(resp) => assert_eq(resp.hash, send_hash)
      _ => fail("应为 send.bin 的块响应")
    }
    let snap1 = handle.sync_snapshot()
    // 发送字节 = 16(块真发出去了才记);租约内 send.bin 进「发送中」,
    // 文件行按块精确累计(done=16,total=16);速率有采样即非空
    assert_eq(snap1.traffic.sent, 16L)
    assert_eq(snap1.traffic.received, 0L)
    assert_eq(snap1.progress.length(), 1)
    assert_eq(snap1.progress[0].folder, "f1")
    assert_eq(snap1.progress[0].pending, 0)
    assert_eq(snap1.progress[0].sending, 1)
    assert_eq(snap1.progress[0].receiving, 0)
    let send_row = snap1.progress[0].files.unwrap()[0]
    assert_eq(send_row.direction, "send")
    assert_eq(send_row.bytes_done, 16L)
    assert_eq(send_row.bytes_total, 16L)
    assert_true(snap1.progress[0].send_rate is Some(_))
    assert_true(snap1.progress[0].receive_rate is None)
    // —— 收块:对端宣告本机没有的 receive.bin → 规划出在途接收并索块,
    // 回以块响应 → 落地 + 接收字节落账
    let remote : Array[@net.WireEntry] = [
      actor_wire_entry("receive.bin", "recv-xyz", [("dev-b", 1L)]),
    ]
    let _ = handle.send(
      @daemon.Cmd::PeerMessage(
        folder="f1",
        remote_device_id="dev-b",
        message=actor_index_message("f1", remote, full=false),
      ),
    )
    let _ = handle.send(@daemon.Cmd::ApplyPlan("f1"))
    match sink.get() {
      @daemon.Outbound::BlockRequest(req) => assert_eq(req.path, "receive.bin")
      _ => fail("应为 receive.bin 的块请求")
    }
    let _ = handle.send(
      @daemon.Cmd::PeerMessage(
        folder="f1",
        remote_device_id="dev-b",
        message=actor_block_response("f1", "receive.bin", @core.hash_block(@utf8.encode("recv-xyz")), "recv-xyz"),
      ),
    )
    let snap2 = handle.sync_snapshot()
    // 接收字节 = 8;两方向独立累计;receive.bin 已落地(索引两条)
    assert_eq(snap2.traffic.sent, 16L)
    assert_eq(snap2.traffic.received, 8L)
    assert_eq(snap2.folders[0].entries, 2L)
    // 落地后进度只剩发送行(pending/receiving 归零,租约内的发送仍在)
    assert_eq(snap2.progress.length(), 1)
    assert_eq(snap2.progress[0].pending, 0)
    assert_eq(snap2.progress[0].receiving, 0)
    assert_eq(snap2.progress[0].sending, 1)
    assert_true(snap2.progress[0].receive_rate is Some(_))
    let _ = handle.send(@daemon.Cmd::Shutdown)
  }
}
