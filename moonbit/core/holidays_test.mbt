///|
/// 源数据解析:holiday-cn 的 days 数组形态(isOffDay true=休 false=班),
/// 非法日期逐条丢弃(坏键会让「已缓存」的判断说谎)。
test "parse_holiday_payload:days 数组形态" {
  let body = @json.parse(
    "{\"days\":[{\"date\":\"2026-01-01\",\"isOffDay\":true},{\"date\":\"2026-01-04\",\"isOffDay\":false},{\"date\":\"2026-13-99\",\"isOffDay\":true},{\"date\":\"bad\",\"isOffDay\":true}]}",
  )
  let days = parse_holiday_payload(Some(body))
  assert_eq(days.get("2026-01-01"), Some("holiday"))
  assert_eq(days.get("2026-01-04"), Some("workday"))
  assert_eq(days.get("2026-13-99"), None)
  assert_eq(days.get("bad"), None)
}

///|
/// 源数据解析:扁平布尔映射形态({date: true=休 | false=班}),非法键丢弃。
test "parse_holiday_payload:扁平映射形态" {
  let body = @json.parse(
    "{\"2026-10-01\":true,\"2026-09-27\":false,\"junk\":true,\"2026-02-30\":true}",
  )
  let days = parse_holiday_payload(Some(body))
  assert_eq(days.get("2026-10-01"), Some("holiday"))
  assert_eq(days.get("2026-09-27"), Some("workday"))
  assert_eq(days.get("junk"), None)
  assert_eq(days.get("2026-02-30"), None)
}

///|
/// 非对象载荷与缺 days 键:回空表(源数据为空时上层记 last_error,不影响判定)。
test "parse_holiday_payload:畸形载荷回空表" {
  assert_eq(parse_holiday_payload(None).length(), 0)
  assert_eq(parse_holiday_payload(Some(@json.parse("[]"))).length(), 0)
  assert_eq(parse_holiday_payload(Some(@json.parse("{}"))).length(), 0)
}

///|
/// 生效源地址:未配置回默认源,配置了用配置(设置页展示与拉取共用口径)。
test "effective_holiday_source:缺省回默认" {
  let config = parse_config("{}")
  assert_eq(effective_holiday_source(config), DEFAULT_HOLIDAY_SOURCE)
  assert_true(DEFAULT_HOLIDAY_SOURCE.contains("{year}"))
  config.holiday_source_url = Some("https://example.com/cal-{year}.json")
  assert_eq(
    effective_holiday_source(config),
    "https://example.com/cal-{year}.json",
  )
}
