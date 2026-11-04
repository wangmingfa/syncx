///|
/// syncProgress 聚合的白盒单测:构造会话状态断言 pending/sending/receiving
/// 计数与 files 字段、租约过期清点、速率「窗口空则省略」。磁盘中间态用真实
/// /tmp 目录(与 reliability_wbtest 同款做法)。

///|
/// 造一个空会话(字段与 reliability_wbtest 的 wb_session 同款,名字避开重名)。
fn prog_session() -> PeerSession {
  {
    remote_device_id: "peer",
    sink: @async.Queue(kind=Unbounded),
    pending_index: None,
    pending_full: false,
    pending_relayed: false,
    pending: Map([]),
    block_retries: Map([]),
    inflight_bytes: 0L,
    last_serve_ms: 0L,
    deferred: [],
    deferred_keys: Map([]),
    initial_deadline: None,
    initial_settled: false,
    serving: Map([]),
    rate_samples: [],
    events: [],
  }
}

///|
/// 按 path 从聚合行的 files 里找一条(台账是 Map,行序不定)。
fn prog_file(item : SyncProgress, path : String) -> TransferFileInfo? {
  match item.files {
    Some(files) =>
      for f in files {
        if f.path == path {
          return Some(f)
        }
      }
    None => ()
  }
  None
}

///|
async test "progress: pending/receiving 计数,接收行问句柄" {
  let session = prog_session()
  let root = "/tmp/syncx-mb-progress-recv-\{now_ms()}"
  @fs.mkdir(root, recursive=true, allow_exist=true)
  // 5 字节单块条目;先落一块进 store —— 本地预填与续传的旧进度同样计入
  // (它们都真落在了 tmp 里,口径对齐 Node 的 handle.bytes())
  let data = @utf8.encode("hello")
  let entry : Entry = {
    path: "a.txt",
    version: Map([("dev-x", 1L)]),
    size: data.length().to_int64(),
    deleted: false,
    blocks: [@core.hash_block(data)],
    cdh: None,
    clens: None,
    mtime: None,
    placeholder: false,
  }
  let store = PartialStore::begin(root, entry, false) catch { _ => panic() }
  store.append(0, data) catch { _ => panic() }
  session.pending.set("a.txt", {
    is_conflict: false,
    entry,
    local_entry: None,
    store,
  })
  let item = aggregate_sync_progress("f1", session, now_ms())
  assert_eq(item.folder, "f1")
  assert_eq(item.pending, 1)
  assert_eq(item.receiving, 1)
  assert_eq(item.sending, 0)
  let row = prog_file(item, "a.txt").unwrap()
  assert_eq(row.direction, "receive")
  assert_eq(row.bytes_done, 5L)
  assert_eq(row.bytes_total, 5L)
  // 窗口内无字节:速率字段省略(None)
  assert_true(item.send_rate is None)
  assert_true(item.receive_rate is None)
}

///|
test "progress: sending 统计文件数,重试同块不重复计" {
  let session = prog_session()
  let now = 1000L
  // b.txt 两个块 + c.txt 一个块:sending 是 2 个文件,不是 3 个块
  mark_served(session, "b.txt", 0L, 100L, 1000L, now)
  mark_served(session, "b.txt", 1L, 200L, 1000L, now + 1L)
  // 对端重试同一块:已供字节不重复计
  mark_served(session, "b.txt", 1L, 200L, 1000L, now + 2L)
  mark_served(session, "c.txt", 0L, 50L, 500L, now + 3L)
  let item = aggregate_sync_progress("f1", session, now + 4L)
  assert_eq(item.pending, 0)
  assert_eq(item.receiving, 0)
  assert_eq(item.sending, 2)
  let b = prog_file(item, "b.txt").unwrap()
  assert_eq(b.direction, "send")
  assert_eq(b.bytes_done, 300L)
  assert_eq(b.bytes_total, 1000L)
  let c = prog_file(item, "c.txt").unwrap()
  assert_eq(c.bytes_done, 50L)
  assert_eq(c.bytes_total, 500L)
}

///|
test "progress: 租约过期清点,发送归零且字节账一并清" {
  let session = prog_session()
  let now = 50_000L
  mark_served(session, "b.txt", 0L, 100L, 1000L, now)
  // 恰好到线未过线:仍在租约内(超时判定是严格大于)
  let alive = aggregate_sync_progress("f1", session, now + SERVE_LEASE_MS)
  assert_eq(alive.sending, 1)
  // 超线:发送行消失,租约与字节账一并出清
  let expired = aggregate_sync_progress("f1", session, now + SERVE_LEASE_MS + 1L)
  assert_eq(expired.sending, 0)
  assert_eq(session.serving.length(), 0)
  // 三项全零(上层 publish 据此丢弃该行,仅非零项进状态)
  assert_eq(expired.pending, 0)
  assert_eq(expired.receiving, 0)
  assert_true(expired.files is None)
}

///|
test "progress: 速率按滚动窗口,首帧按 1s 平滑,窗口空则省略" {
  let session = prog_session()
  // 刚开传的第一帧跨度取 1s 下限:3000B → 3000 B/s(Node RATE_SPAN_FLOOR_MS)
  record_rate(session, 3000L, 0L, 10_000L)
  let first = aggregate_sync_progress("f1", session, 10_000L)
  assert_eq(first.send_rate, Some(3000.0))
  assert_true(first.receive_rate is None)
  // 两方向独立累计
  record_rate(session, 0L, 500L, 11_000L)
  let second = aggregate_sync_progress("f1", session, 11_000L)
  assert_eq(second.send_rate, Some(3000.0))
  assert_eq(second.receive_rate, Some(500.0))
  // 窗口滑出(读时剪枝):无样本 → 0 → 字段省略,采样环剪空
  let drained = aggregate_sync_progress("f1", session, 16_001L)
  assert_true(drained.send_rate is None)
  assert_true(drained.receive_rate is None)
  assert_eq(session.rate_samples.length(), 0)
}

///|
async test "progress: 收发两方向同行呈现,零计数由上层过滤" {
  let session = prog_session()
  let root = "/tmp/syncx-mb-progress-both-\{now_ms()}"
  @fs.mkdir(root, recursive=true, allow_exist=true)
  let data = @utf8.encode("abc")
  let entry : Entry = {
    path: "a.txt",
    version: Map([("dev-x", 1L)]),
    size: data.length().to_int64(),
    deleted: false,
    blocks: [@core.hash_block(data)],
    cdh: None,
    clens: None,
    mtime: None,
    placeholder: false,
  }
  let store = PartialStore::begin(root, entry, false) catch { _ => panic() }
  store.append(0, data) catch { _ => panic() }
  session.pending.set("a.txt", {
    is_conflict: false,
    entry,
    local_entry: None,
    store,
  })
  mark_served(session, "b.txt", 0L, 40L, 100L, 70_000L)
  let item = aggregate_sync_progress("f1", session, 70_001L)
  assert_eq(item.pending, 1)
  assert_eq(item.sending, 1)
  assert_eq(item.receiving, 1)
  assert_eq(prog_file(item, "a.txt").unwrap().direction, "receive")
  assert_eq(prog_file(item, "b.txt").unwrap().direction, "send")
  // 发送行总字节取本机索引 size(serve_block 落账时传入的 entry.size)
  assert_eq(prog_file(item, "b.txt").unwrap().bytes_total, 100L)
}
