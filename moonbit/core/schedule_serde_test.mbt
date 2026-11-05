///|
// 时段配置持久化面的契约测试(schedule_to_json / normalize_schedule_opt /
// weekday_workday_fallback)。判定语义已由 schedule_test.mbt 的 fixture 对拍
// 覆盖,这里只锁「落盘形态与 Node 逐字同形 + 坏数据退化为不设限」。

///|
test "schedule_to_json:归一化形态与 Node 落盘逐字同形" {
  // 旧字符串迁移 → 数组形态(dow 排序去重保留)
  let raw = @json.parse("\"22:00-08:00\"")
  let normalized = @core.normalize_schedule(raw)
  assert_true(normalized is Some(_))
  let json = match @core.schedule_to_json(normalized) {
    Some(j) => j
    None => fail("应为合法 Json")
  }
  assert_eq(
    json.stringify(),
    "[{\"days\":{\"kind\":\"any\"},\"windows\":[{\"from\":1320,\"to\":480}]}]",
  )
  let raw_dow = @json.parse(
    "[{\"days\":{\"kind\":\"dow\",\"days\":[5,1,3]},\"windows\":[{\"from\":\"10:00\",\"to\":\"11:40\"}]}]",
  )
  let json_dow = match
    @core.schedule_to_json(@core.normalize_schedule(raw_dow)) {
    Some(j) => j
    None => fail("应为合法 Json")
  }
  assert_eq(
    json_dow.stringify(),
    "[{\"days\":{\"kind\":\"dow\",\"days\":[1,3,5]},\"windows\":[{\"from\":600,\"to\":700}]}]",
  )
}

///|
test "schedule_to_json:None = 不设限,落盘不写键" {
  assert_true(@core.schedule_to_json(None) is None)
  assert_true(
    @core.schedule_to_json(@core.normalize_schedule(@json.parse("null")))
    is None,
  )
}

///|
test "normalize_schedule_opt:字段缺省/清除退化成不设限" {
  assert_true(@core.normalize_schedule_opt(None) is None)
  assert_true(@core.normalize_schedule_opt(Some(@json.parse("null"))) is None)
  // 非法片段整体回退(None),绝不锁死
  assert_true(
    @core.normalize_schedule_opt(Some(@json.parse("\"nonsense\""))) is None,
  )
  // 旧字符串照常迁移
  assert_true(
    @core.normalize_schedule_opt(Some(@json.parse("\"09:00-18:00\"")))
    is Some(_),
  )
}

///|
test "weekday_workday_fallback:周一~周五口径(与 Node isWeekdayByClock 同语义)" {
  // fixture 同款日期:2026-10-28 周三、10-31 周六、11-01 周日
  assert_true(@core.weekday_workday_fallback(2026, 10, 28))
  assert_false(@core.weekday_workday_fallback(2026, 10, 31))
  assert_false(@core.weekday_workday_fallback(2026, 11, 1))
  // 闰年 2/29(2020-02-29 周六)不炸
  assert_false(@core.weekday_workday_fallback(2020, 2, 29))
}
