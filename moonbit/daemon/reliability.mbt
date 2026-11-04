///|
/// 传输可靠性增强:块请求重试、发送窗口(配额租约)与限速窗口。
/// 对应 Rust `peer.rs` 的「重试与超时」一节与 Node `ratelimit.ts` 的令牌桶。
///
/// 三件事的分工:
///  - **块请求重试**(接收侧):在途块请求超时未响应则重发,快速重试
///    (5s × `MAX_BLOCK_RETRIES` 次)耗尽后放弃该路径的整条接收并记录事件
///    (对齐 Rust `pending_blocks` + `drop_if_unservable`;与 Rust 的差异:
///    Rust 耗尽快速重试后还有 30s 慢退避、总计 23 次发送上限,这里按任务
///    裁剪为 3 次重发后立即放弃 —— MoonBit 侧尚无断点续传中间态,留着
///    只会让「接收中」永久虚报,下轮索引交换 / 重连会重新规划自愈)。
///  - **发送窗口**(发送侧):出站块响应的配额租约 —— 发之前占额,驱动层
///    写完帧经 `Cmd::BlockSent` 释放;配额按字节计(`SEND_WINDOW_BYTES`),
///    与 Rust 同值。租约没有别的衰减路径,超时(`SERVE_LEASE_MS`)由
///    `decay_serve_lease` 兜底清零,防止驱动层失联后窗口永久关闭。
///  - **限速窗口**(发送侧):目录级 `maxBandwidthKbps` 令牌桶(对齐 Node
///    `RateLimiter`,0/未配置 = 不限),供块出口扣令牌,不够就延迟,
///    由 `Cmd::PollTimeouts` 周期泵重放。

///|
/// 在途块请求的快速重试超时(毫秒;对齐 Rust/Node `BLOCK_REQUEST_TIMEOUT_MS`)。
pub const BLOCK_REQUEST_TIMEOUT_MS : Int64 = 5_000L

///|
/// 快速重试次数上限:超时重发最多这么多次,再超时就放弃该块
/// (Rust 为 3 次快速 + 30s 慢退避共 23 次发送,这里刻意裁剪,见文件头)。
pub const MAX_BLOCK_RETRIES : Int32 = 3

///|
/// 发送租约时长(毫秒;对齐 Rust `SERVE_LEASE_MS`):配额占额超过它没有
/// `BlockSent` 回执即视为已发完,窗口额度清零。计数器没有衰减路径的话,
/// 建连互发全量之后卡片会永远停在「传输中」(2026-09-16 事故)。
pub const SERVE_LEASE_MS : Int64 = 15_000L

///|
/// 发送侧在途字节窗口(对齐 Rust `SEND_WINDOW_BYTES`):同一对端同时出站
/// 的块响应按 wire 体积估算占额,超过窗口的请求进延迟队列。
pub const SEND_WINDOW_BYTES : Int32 = 64 * 1024 * 1024

///|
/// 延迟队列长度上限(条数;对齐 Rust `DEFERRED_MAX`)。请求由对端决定,
/// 不设限就是另一种内存耗尽。
pub const DEFERRED_MAX : Int32 = 4096

///|
/// 发送窗口配置单元:生产恒为 `SEND_WINDOW_BYTES`,集成测试把它调小才能
/// 在 KB 级数据上触发挂起与重放(对齐 Rust 的 `SYNCX_SEND_WINDOW_BYTES`
/// 环境变量做法;只应被白盒测试改写)。
priv struct SendWindowCell {
  mut bytes : Int32
}

///|
/// 发送窗口当前值(读侧唯一入口,便于测试覆写)。
let send_window_cell : SendWindowCell = { bytes: SEND_WINDOW_BYTES, }

///|
/// 覆写发送窗口并返回旧值(测试钩子:窗口调小才能在 KB 级数据上触发挂起与
/// 重放,对齐 Rust 的 `SYNCX_SEND_WINDOW_BYTES` 环境变量做法;生产代码
/// 不应调用)。调用方负责用返回值恢复。
pub fn set_send_window_bytes(bytes : Int32) -> Int32 {
  let saved = send_window_cell.bytes
  send_window_cell.bytes = bytes
  saved
}

///|
/// 供块周期泵的节拍(毫秒):重试到期、租约衰减与限速重放都靠它驱动。
/// 驱动层(WS)接入后由 `start_session_actor` 的定时任务自动投递
/// `Cmd::PollTimeouts`。
pub const POLL_TICK_MS : Int32 = 500

// ==================== 块请求重试(接收侧) ====================

///|
/// 一条在途块请求的重试台账。键为 `block_key`,值带重发用的原始请求。
priv struct PendingBlock {
  /// 下次到期时刻(毫秒);`now >= deadline` 即触发重发或放弃。
  mut deadline : Int64
  /// 已重发次数(首次发送不计)。
  mut retries : Int32
  /// 原始请求:重发原样上栈(哈希与槽位不变)。
  request : @net.WireBlockRequest
}

///|
/// 块台账键:口径前缀 + 路径 + 槽位(同一文件的每个块独立计数)。cdc 参与
/// 键构造:同一路径下「定长第 i 块」与「CDC 第 i 块」是两个不同的东西,
/// 重规划切换口径时两套在途请求与重试不能互相顶掉(对齐 Node blockKey)。
/// 键只做身份不做结构:清路径在途项按记录本体的 request.path 字段匹配,
/// 不解析键字符串(路径可含任意字符,包括分隔符本身)。
fn block_key(path : String, block_index : Int64, cdc : Bool) -> String {
  let tag = if cdc { "c" } else { "b" }
  "\{tag}:\{path}\u{1f}\{block_index}"
}

///|
/// 登记一条块请求的重试台账(发送时调用)。
fn track_block_request(
  session : PeerSession,
  request : @net.WireBlockRequest,
  now : Int64,
) -> Unit {
  session.block_retries.set(
    block_key(request.path, request.block_index, request.cdc == Some(true)),
    { deadline: now + BLOCK_REQUEST_TIMEOUT_MS, retries: 0, request, },
  )
}

///|
/// 块响应到达:该块有了着落,摘掉重试台账(口径须与请求发出时一致)。
fn untrack_block_response(
  session : PeerSession,
  path : String,
  block_index : Int64,
  cdc : Bool,
) -> Unit {
  let _ = session.block_retries.remove(block_key(path, block_index, cdc))
}

///|
/// 摘掉某条路径的全部重试台账(接收落地 / 对端墓碑中止时调用)。
fn purge_block_retries(session : PeerSession, path : String) -> Unit {
  let stale : Array[String] = []
  for key, entry in session.block_retries {
    if entry.request.path == path {
      stale.push(key)
    }
  }
  for key in stale {
    let _ = session.block_retries.remove(key)
  }
}

///|
/// 周期泵:处理到期的块重试。到期未响应 → 重发并记 `block_retry` 事件;
/// 重发次数已达上限 → 摘台账并放弃整条接收(`block_giveup` 事件)。
async fn poll_block_retries(session : PeerSession, now : Int64) -> Unit {
  let due : Array[String] = []
  for key, entry in session.block_retries {
    if now >= entry.deadline {
      due.push(key)
    }
  }
  for key in due {
    let entry = match session.block_retries.get(key) {
      Some(e) => e
      None => continue
    }
    if entry.retries >= MAX_BLOCK_RETRIES {
      let _ = session.block_retries.remove(key)
      drop_if_unservable(session, entry.request.path)
    } else {
      entry.retries += 1
      entry.deadline = now + BLOCK_REQUEST_TIMEOUT_MS
      push_outbound(session, BlockRequest(entry.request))
      session.events.push({
        path: entry.request.path,
        direction: "remote",
        action: "block_retry",
      })
    }
  }
}

///|
/// 某路径的最后一个在途块请求被放弃时:整条放弃接收。
/// 放弃 ≠ 作废:**保留断点续传中间态**(句柄交代干净后关闭,位图留在盘上),
/// 重连后 `open_receive` 从位图续传。放弃是安全的,自愈路径有三
/// (对齐 Rust `drop_if_unservable` 的论证):
/// 对端推墓碑 / 对端文件回来推新版本增量 / 任何重连互发全量索引。
async fn drop_if_unservable(session : PeerSession, path : String) -> Unit {
  for _, entry in session.block_retries {
    if entry.request.path == path {
      return // 还有别的块在途:整条还没到放弃的时候
    }
  }
  match session.pending.remove_and_get(path) {
    Some(pending) => {
      pending.store.abort(keep_partial=true)
      session.events.push({ path, direction: "remote", action: "block_giveup", })
    }
    None => ()
  }
}

// ==================== 发送窗口与延迟队列(发送侧) ====================

///|
/// 块响应的 wire 体积保守估算(对齐 Rust `expected_wire_bytes`:按文本信封
/// 估,两层 base64 ≈ 1.78 倍。二进制信封会低估,但窗口的语义是「别攒到
/// 内存爆掉」,保守方向的误差只让窗口更早关上)。
fn wire_bytes_estimate(plain : Int32) -> Int32 {
  plain + 16 + plain * 7 / 9 + 512
}

///|
/// 窗口还有没有位置。单块就超过整个窗口时窗口没有意义:放行它,否则它会
/// 永远卡在队首让整条延迟队列停摆(对齐 Rust `has_send_room`)。
fn has_send_room(session : PeerSession, wire : Int32) -> Bool {
  let window = send_window_cell.bytes
  if wire >= window {
    return true
  }
  session.inflight_bytes + wire.to_int64() < window.to_int64()
}

///|
/// 占额(真正要发的时候才占)。
fn acquire_send_window(
  session : PeerSession,
  wire : Int32,
  now : Int64,
) -> Unit {
  session.inflight_bytes += wire.to_int64()
  session.last_serve_ms = now
}

///|
/// 释放:驱动层写完一帧块响应后经 `Cmd::BlockSent` 回账。
fn release_send_window(session : PeerSession, bytes : Int32) -> Unit {
  if session.inflight_bytes > bytes.to_int64() {
    session.inflight_bytes -= bytes.to_int64()
  } else {
    session.inflight_bytes = 0L
  }
}

///|
/// 租约到期兜底:超过 `SERVE_LEASE_MS` 没有 `BlockSent` 回报,窗口额度
/// 清零。驱动层接线后回账是主路径,这里只是防「额度只涨不跌」的保险丝。
fn decay_serve_lease(session : PeerSession, now : Int64) -> Unit {
  if session.inflight_bytes > 0L && now - session.last_serve_ms > SERVE_LEASE_MS {
    session.inflight_bytes = 0L
  }
}

///|
/// 请求进延迟队列(窗口满 / 令牌不够时)。满则装作没听见 —— 对端的重试
/// 会再来;同键去重,优先级请求插队(对齐 Rust `defer_request`)。
fn defer_request(
  session : PeerSession,
  request : @net.WireBlockRequest,
) -> Unit {
  if session.deferred.length() >= DEFERRED_MAX {
    return
  }
  let key = block_key(
    request.path,
    request.block_index,
    request.cdc == Some(true),
  )
  if session.deferred_keys.contains(key) {
    return
  }
  session.deferred_keys.set(key, ())
  if request.priority == Some(true) {
    session.deferred.insert(0, request)
  } else {
    session.deferred.push(request)
  }
}

// ==================== 限速窗口(目录级令牌桶) ====================

///|
/// 令牌桶(对齐 Node `ratelimit.ts`):按 KB/s 限制累计发送字节数,
/// 桶容量 = 1 秒的额度(允许小突发)。0 / 未配置 = 不限(构造返回 None)。
priv struct RateLimiter {
  /// 每毫秒补充的令牌数(字节);0 = 不限(不会构造出来)。
  rate_bytes_per_ms : Double
  /// 桶容量 = rate × 1000(1 秒突发额度)。
  capacity : Double
  mut tokens : Double
  mut last_refill_ms : Int64
}

///|
/// 由目录级 `maxBandwidthKbps` 折算令牌桶;0 / None = 不限速。
fn make_rate_limiter(kbps : Int32?) -> RateLimiter? {
  match kbps {
    Some(value) =>
      if value > 0 {
        let rate = value.to_double() * 1024.0 / 1000.0
        Some({
          rate_bytes_per_ms: rate,
          capacity: rate * 1000.0,
          tokens: rate * 1000.0,
          last_refill_ms: 0L,
        })
      } else {
        None
      }
    None => None
  }
}

///|
/// 尝试消耗 bytes 字节的额度。超大消息(超过桶容量)无法一次消耗:
/// 清空桶后照常放行,避免它完全绕过限速(对齐 Node 的 drain 语义)。
fn RateLimiter::try_consume(
  self : RateLimiter,
  bytes : Int32,
  now : Int64,
) -> Bool {
  // 首次调用只对表:避免构造时刻与首包之间的空档被算成补充量
  if self.last_refill_ms == 0L {
    self.last_refill_ms = now
  } else {
    let elapsed = now - self.last_refill_ms
    if elapsed > 0L {
      let refilled = self.tokens + self.rate_bytes_per_ms * elapsed.to_double()
      self.tokens = if refilled > self.capacity {
        self.capacity
      } else {
        refilled
      }
      self.last_refill_ms = now
    }
  }
  let need = bytes.to_double()
  if need > self.capacity {
    self.tokens = 0.0
    return true
  }
  if need > self.tokens {
    return false
  }
  self.tokens -= need
  true
}
