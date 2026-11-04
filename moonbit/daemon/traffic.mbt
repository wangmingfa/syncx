///|
/// 传输字节账本:累计量 + 固定窗口的采样环(供流量面板画 24h 曲线)。
/// 逐条对齐 Node `src/traffic.ts` 的 TrafficLedger。设计约束(注释原文照搬):
///  - 采样环容量按「窗口宽 × 环长 = 覆盖时长」定(5min × 288 = 24h),超出丢最旧;
///  - 曲线要的是「这段时间走了多少」而非「当前总量」,所以每次推进窗口记录的是
///    **窗口内增量**(与上次读数的差),而不是绝对值;这样曲线段的高度直接对应
///    速率,读图无需再算差;
///  - daemon 重启即清零(内存态,不落盘):统计是「这次在线期间」的观测量。
///
/// 落账口径(对齐 Node「真发出去了才记」):发送在 serve_block 产出站帧处
/// `add_sent`(块真发出去才记),接收在 on_block_response 收下块处
/// `add_received`(重复响应不记);本地预填是磁盘读,不走这里。

///|
/// 采样窗口宽(毫秒):5 分钟一个点(Node WINDOW_MS 同值)。
pub const TRAFFIC_WINDOW_MS : Int64 = 300_000L

///|
/// 采样环长:288 × 5min = 24 小时(Node RING_LEN 同值)。
pub const TRAFFIC_RING_LEN : Int = 288

///|
/// 一个采样窗口的流量增量(前端 TrafficSample)。`at` 为被闭合窗口的起点
/// (毫秒时间戳;与 Node pushSample 的取值口径一致),sent/received 为窗口内
/// 增量。
pub(all) struct TrafficSample {
  at : Int64
  sent : Int64
  received : Int64
}

///|
/// 传输统计:daemon 启动以来的累计字节 + 最近已完成窗口的采样序列(前端
/// TrafficData;重启清零)。
pub(all) struct TrafficStats {
  sent : Int64
  received : Int64
  samples : Array[TrafficSample]
}

///|
/// 账本本体。由会话 actor 单线程持有(单线程事件循环,无需锁)。
pub struct TrafficLedger {
  /// 两方向的累计字节(重启清零)。
  priv mut sent : Int64
  priv mut received : Int64
  /// 上个采样窗口结束时的累计读数,用于算下一段的增量。
  priv mut last_sent : Int64
  priv mut last_received : Int64
  /// 当前采样窗口起点(对齐到窗口边界)。
  priv mut window_start : Int64
  priv samples : Array[TrafficSample]
}

///|
/// 以给定时刻对齐初始窗口(生产传 now_ms();测试注入时钟)。
pub fn TrafficLedger::new(now : Int64) -> TrafficLedger {
  {
    sent: 0L,
    received: 0L,
    last_sent: 0L,
    last_received: 0L,
    window_start: now / TRAFFIC_WINDOW_MS * TRAFFIC_WINDOW_MS,
    samples: [],
  }
}

///|
/// 记一笔发送字节(本机供出;对齐 Node add('send'))。非正数忽略。
pub fn TrafficLedger::add_sent(self : TrafficLedger, bytes : Int64) -> Unit {
  if bytes <= 0L {
    return
  }
  self.sent += bytes
}

///|
/// 记一笔接收字节(本机拉入;对齐 Node add('receive'))。非正数忽略。
pub fn TrafficLedger::add_received(self : TrafficLedger, bytes : Int64) -> Unit {
  if bytes <= 0L {
    return
  }
  self.received += bytes
}

///|
/// 入环并保容量(超出丢最旧)。
fn TrafficLedger::push_sample(self : TrafficLedger, sample : TrafficSample) -> Unit {
  self.samples.push(sample)
  if self.samples.length() > TRAFFIC_RING_LEN {
    let _ = self.samples.remove(0)
  }
}

///|
/// 推进到给定时刻:凡是跨过了采样窗口边界,就把「自上次推进起的增量」记为
/// 一个样本,并按窗口边界对齐推进。空闲(无流量)窗口仍会补零,让曲线时间轴
/// 连续(否则稀疏流量下 x 轴会误判相邻点间距)。单次最多回填环长个窗口,
/// 防止长时间挂起后一次性灌爆循环;护栏触发时游标直接跳到当前窗口,丢弃
/// 中间的空白区间(对齐 Node flushTo)。
pub fn TrafficLedger::flush_to(self : TrafficLedger, now : Int64) -> Unit {
  let target = now / TRAFFIC_WINDOW_MS * TRAFFIC_WINDOW_MS
  if target <= self.window_start {
    return // 还在当前窗口内,不产生新样本
  }
  let mut backfill = 0
  while self.window_start < target && backfill < TRAFFIC_RING_LEN {
    self.push_sample({
      at: self.window_start,
      sent: self.sent - self.last_sent,
      received: self.received - self.last_received,
    })
    self.last_sent = self.sent
    self.last_received = self.received
    self.window_start += TRAFFIC_WINDOW_MS
    backfill += 1
  }
  if self.window_start < target {
    self.last_sent = self.sent
    self.last_received = self.received
    self.window_start = target
  }
}

///|
/// 取当前累计 + 采样序列(先按 now 推进窗口)。未闭合的当前窗口不进 samples
/// —— 避免把「进行中」的半截增量当成一格;曲线展示的是已完成窗口的历史。
pub fn TrafficLedger::snapshot(self : TrafficLedger, now : Int64) -> TrafficStats {
  self.flush_to(now)
  { sent: self.sent, received: self.received, samples: self.samples.copy() }
}
