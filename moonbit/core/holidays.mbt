///|
/// 节假日日历的纯模型侧:默认源、源数据解析与生效地址。判定用的仓库在
/// daemon 层(daemon/holidays.mbt),对齐 Node src/holidays.ts 的三条硬约束:
/// 判定路径绝不打网络 / 无数据退化按星期几判 / 缓存不进 config.json。

///|
/// 默认源:{year} 为占位符。holiday-cn 逐条摘自国务院公告,含
/// isOffDay:false 的调休补班 —— 中国语境下「周六上班」必须能表达,否则
/// 「工作日」判定整年错位。
pub const DEFAULT_HOLIDAY_SOURCE : String = "https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{year}.json"

///|
/// 解析节假日源返回的 JSON,归一成 dateKey → "workday" | "holiday"。
/// 兼容两种形态:holiday-cn 的 {"days":[{"date":"...","isOffDay":true},..]}
/// 与扁平映射 {"2026-10-01": true(休) | false(班)};非法日期与非法身份
/// 逐条丢弃(与 Node parseHolidayPayload 同口径)。
pub fn parse_holiday_payload(body : @json.Json?) -> Map[String, String] {
  let out : Map[String, String] = Map([])
  let fields : Map[String, @json.Json] = match body {
    Some(Object(map)) => map
    _ => return out
  }
  match fields.get("days") {
    Some(Array(items)) => {
      for item in items {
        match item {
          Object(day) => {
            let date = match day.get("date") {
              Some(String(s)) => s
              _ => continue
            }
            let off = match day.get("isOffDay") {
              Some(True) => true
              Some(False) => false
              _ => continue
            }
            if is_real_date_key(date) {
              out.set(date, if off { "holiday" } else { "workday" })
            }
          }
          _ => ()
        }
      }
      return out
    }
    _ => ()
  }
  for key, value in fields {
    let b = match value {
      True => true
      False => false
      _ => continue
    }
    if is_real_date_key(key) {
      out.set(key, if b { "holiday" } else { "workday" })
    }
  }
  out
}

///|
/// 当前生效的节假日源地址(未配置回默认;设置页展示与拉取共用同一口径,
/// 对齐 Node effectiveHolidaySource)。
pub fn effective_holiday_source(config : Config) -> String {
  match config.holiday_source_url {
    Some(url) => url
    None => DEFAULT_HOLIDAY_SOURCE
  }
}
