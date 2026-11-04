///|
/// 传输可靠性白盒测试:令牌桶数学、发送窗口占额/释放/衰减、块重试上限。
/// 发送窗口用 `send_window_cell` 调小(对齐 Rust 的 SYNCX_SEND_WINDOW_BYTES
/// 环境变量做法),在 KB 级数据上触发挂起与重放。

///|
/// 造一个空会话(白盒可见内部结构)。
fn wb_session() -> PeerSession {
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
    events: [],
  }
}

///|
/// 造一条块请求。
fn wb_request(path : String) -> @net.WireBlockRequest {
  {
    device_id: "me",
    path,
    block_index: 0L,
    hash: "h",
    priority: None,
    cdc: None,
  }
}

///|
test "reliability: 限速令牌桶按时间补充,容量封顶" {
  // 1 KB/s → rate 1.024 B/ms,容量 1024B
  let limiter = make_rate_limiter(Some(1))
  assert_true(limiter is Some(_))
  let limiter = limiter.unwrap()
  // 首包:整桶可用
  assert_eq(limiter.try_consume(1000, 100), true)
  // 余额 24B:再要 100B 不够,拒绝且不扣
  assert_eq(limiter.try_consume(100, 100), false)
  // 1s 后补满(24 + 1024 → 封顶 1024)
  assert_eq(limiter.try_consume(100, 1100), true)
}

///|
test "reliability: 0 与未配置都不限速" {
  assert_true(make_rate_limiter(None) is None)
  assert_true(make_rate_limiter(Some(0)) is None)
}

///|
test "reliability: 超过桶容量的单条消息清桶放行" {
  let limiter = make_rate_limiter(Some(1)).unwrap()
  // 5000B > 容量 1024B:永远凑不齐,清桶后放行(对齐 Node drain 语义)
  assert_eq(limiter.try_consume(5000, 100), true)
  // 桶已被清空:下一条小额也要等补充
  assert_eq(limiter.try_consume(100, 101), false)
}

///|
test "reliability: 发送窗口占额/释放与租约衰减" {
  let session = wb_session()
  acquire_send_window(session, 600, 1000)
  assert_eq(session.inflight_bytes, 600L)
  assert_eq(session.last_serve_ms, 1000L)
  release_send_window(session, 200)
  assert_eq(session.inflight_bytes, 400L)
  // 释放多于余额:钳到 0
  release_send_window(session, 999)
  assert_eq(session.inflight_bytes, 0L)
  // 占额后 15s 无回账:租约到期清零(防「额度只涨不跌」)
  acquire_send_window(session, 500, 2000)
  decay_serve_lease(session, 2000 + SERVE_LEASE_MS)
  assert_eq(session.inflight_bytes, 500L) // 恰好到期还没过线,不清
  decay_serve_lease(session, 2000 + SERVE_LEASE_MS + 1)
  assert_eq(session.inflight_bytes, 0L)
}

///|
test "reliability: 窗口满则延迟,单块超窗放行" {
  // 窗口调到 1000B(用完恢复,不影响其它测试)
  let saved = set_send_window_bytes(1000)
  defer {
    let _ = set_send_window_bytes(saved)
  }
  let session = wb_session()
  acquire_send_window(session, 900, 1)
  let small = wb_request("a.txt")
  let big = wb_request("b.txt")
  // 900 + 200 > 1000:进延迟队列
  assert_eq(has_send_room(session, 200), false)
  defer_request(session, small)
  assert_eq(session.deferred.length(), 1)
  // 同键去重
  defer_request(session, small)
  assert_eq(session.deferred.length(), 1)
  // 单块超过整个窗口:放行,否则它会永远卡在队首
  assert_eq(has_send_room(session, 1000), true)
  // 900 + 99 < 1000:还有位置;900 + 100 恰好压线,没有位置
  assert_eq(has_send_room(session, 99), true)
  assert_eq(has_send_room(session, 100), false)
  // 优先级请求插队
  let priority : @net.WireBlockRequest = {
    device_id: "me",
    path: "c.txt",
    block_index: 0L,
    hash: "h",
    priority: Some(true),
    cdc: None,
  }
  defer_request(session, big)
  defer_request(session, priority)
  assert_eq(session.deferred[0].path, "c.txt")
  assert_eq(session.deferred.length(), 3)
}

///|
async test "reliability: 块请求超时重发,达上限后停止" {
  let session = wb_session()
  // 挂一条真实中间态,让「放弃」走完整分支(停表 + 事件)
  let root = "/tmp/syncx-mb-reliability-\{now_ms()}"
  @fs.mkdir(root, recursive=true, allow_exist=true)
  let entry : Entry = {
    path: "file.txt",
    version: Map([("DEV-B", 1L)]),
    size: 5L,
    deleted: false,
    blocks: ["h"],
    cdh: None,
    clens: None,
    mtime: None,
    placeholder: false,
  }
  let store = PartialStore::begin(root, entry, false) catch { _ => panic() }
  session.pending.set("file.txt", {
    is_conflict: false,
    entry,
    local_entry: None,
    store,
  })
  let request = wb_request("file.txt")
  track_block_request(session, request, 1000)
  // 快进 5s × 4:前 3 次各重发一条,第 4 次重试耗尽放弃
  let mut now = 1000L
  for _ in [1, 2, 3] {
    now += BLOCK_REQUEST_TIMEOUT_MS
    poll_block_retries(session, now)
    // 每次重发都会入出站队列,并记一条 block_retry 事件
    let frame : Outbound? = session.sink.try_get() catch { _ => None }
    assert_true(frame is Some(_))
  }
  now += BLOCK_REQUEST_TIMEOUT_MS
  poll_block_retries(session, now)
  // 放弃后:台账与在途接收出清、队列里再无新请求、事件里是 3 重发 + 1 放弃
  assert_eq(session.block_retries.length(), 0)
  assert_eq(session.pending.length(), 0)
  let drained : Outbound? = session.sink.try_get() catch { _ => None }
  assert_true(drained is None)
  let mut retries = 0
  let mut giveups = 0
  for event in session.events {
    if event.action == "block_retry" {
      retries += 1
    }
    if event.action == "block_giveup" {
      giveups += 1
    }
  }
  assert_eq(retries, 3)
  assert_eq(giveups, 1)
  // 再快进也不再有任何动作
  now += BLOCK_REQUEST_TIMEOUT_MS
  poll_block_retries(session, now)
  let drained_again : Outbound? = session.sink.try_get() catch { _ => None }
  assert_true(drained_again is None)
  assert_eq(session.events.length(), 4)
}

///|
async test "reliability: 块响应到达即出台账,路径级整批摘除" {
  let session = wb_session()
  // 同一路径两个块在途
  let one = wb_request("f.txt")
  let two : @net.WireBlockRequest = {
    device_id: "me",
    path: "f.txt",
    block_index: 1L,
    hash: "h2",
    priority: None,
    cdc: None,
  }
  track_block_request(session, one, 1000)
  track_block_request(session, two, 1000)
  assert_eq(session.block_retries.length(), 2)
  // 一块到账:只摘一块
  untrack_block_response(session, "f.txt", 0L, false)
  assert_eq(session.block_retries.length(), 1)
  // 路径级摘除(接收落地 / 对端墓碑中止):整批出清
  purge_block_retries(session, "f.txt")
  assert_eq(session.block_retries.length(), 0)
}

///|
/// 同路径同槽位的定长与 CDC 请求是两个不同的块:登记互不顶掉,摘除按口径
/// 精确出队(重规划切换口径时两套在途不能互相冲账)。
test "reliability: 跨口径重试键互不顶掉" {
  let session = wb_session()
  let fixed = wb_request("f.txt")
  let cdc : @net.WireBlockRequest = {
    device_id: "me",
    path: "f.txt",
    block_index: 0L,
    hash: "h",
    priority: None,
    cdc: Some(true),
  }
  track_block_request(session, fixed, 1000)
  track_block_request(session, cdc, 1000)
  // 同路径同槽位,口径不同 → 两条台账共存
  assert_eq(session.block_retries.length(), 2)
  // CDC 块到账:只摘 CDC 台账,定长的还在途
  untrack_block_response(session, "f.txt", 0L, true)
  assert_eq(session.block_retries.length(), 1)
  let remaining = session.block_retries.get(block_key("f.txt", 0L, false))
  assert_true(remaining is Some(_))
  // 定长块到账:台账出清
  untrack_block_response(session, "f.txt", 0L, false)
  assert_eq(session.block_retries.length(), 0)
}
