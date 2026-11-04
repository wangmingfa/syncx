///|
/// 流量账本白盒单测:窗口推进数学、未闭合窗口不进 samples、两方向独立累计、
/// 回填护栏与环长封顶。时钟全部注入,不依赖真实时间(窗口宽/环长取
/// traffic.mbt 的常量,断言按 5min × 288 折算)。

///|
test "traffic: 两方向独立累计,非正数忽略,未闭合窗口不进 samples" {
  let ledger = TrafficLedger::new(0L)
  ledger.add_sent(600L)
  ledger.add_sent(50L)
  ledger.add_received(70L)
  ledger.add_received(0L) // 非正数忽略
  ledger.add_sent(-1L)
  let stats = ledger.snapshot(0L)
  assert_eq(stats.sent, 650L)
  assert_eq(stats.received, 70L)
  // 当前窗口未闭合:不进 samples(曲线画的是已完成窗口的历史)
  assert_eq(stats.samples.length(), 0)
}

///|
test "traffic: 跨窗口推进闭合增量,空闲窗口补零" {
  let ledger = TrafficLedger::new(0L)
  ledger.add_sent(600L)
  ledger.add_received(100L)
  // 推进到第三个窗口内:前两个窗口闭合,增量记为样本
  let stats = ledger.snapshot(650_000L)
  assert_eq(stats.sent, 600L)
  assert_eq(stats.received, 100L)
  assert_eq(stats.samples.length(), 2)
  assert_eq(stats.samples[0].at, 0L)
  assert_eq(stats.samples[0].sent, 600L)
  assert_eq(stats.samples[0].received, 100L)
  // 第二个窗口空闲:补零保持时间轴连续
  assert_eq(stats.samples[1].at, TRAFFIC_WINDOW_MS)
  assert_eq(stats.samples[1].sent, 0L)
  assert_eq(stats.samples[1].received, 0L)
  // 当前窗口(600s–900s)未闭合:后续增量不进 samples,累计照常
  ledger.add_sent(50L)
  let again = ledger.snapshot(650_000L)
  assert_eq(again.sent, 650L)
  assert_eq(again.samples.length(), 2)
}

///|
test "traffic: 回填护栏 —— 久睡跳窗,环长封顶丢最旧" {
  let ledger = TrafficLedger::new(0L)
  ledger.add_sent(288L)
  // 一次性推进 290 个窗口:护栏最多回填环长个,游标直接跳到当前窗口
  let stats = ledger.snapshot(290L * TRAFFIC_WINDOW_MS)
  assert_eq(stats.samples.length(), TRAFFIC_RING_LEN)
  assert_eq(stats.samples[0].at, 0L)
  assert_eq(ledger.window_start, 290L * TRAFFIC_WINDOW_MS)
  // 跳窗后继续正常推进:新窗口闭合时把最旧的样本挤出去
  ledger.add_sent(10L)
  let next = ledger.snapshot(290L * TRAFFIC_WINDOW_MS + TRAFFIC_WINDOW_MS)
  assert_eq(next.samples.length(), TRAFFIC_RING_LEN)
  assert_eq(next.samples[0].at, TRAFFIC_WINDOW_MS)
  let last = next.samples[next.samples.length() - 1]
  assert_eq(last.at, 290L * TRAFFIC_WINDOW_MS)
  assert_eq(last.sent, 10L)
  assert_eq(last.received, 0L)
}
