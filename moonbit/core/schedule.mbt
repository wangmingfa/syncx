///|
/// 同步时段模型(全局 + 目录级共用一份)。对应 Rust 侧
/// `rust/crates/syncx-core/src/schedule.rs`(权威移植)与 Node 侧 `src/schedule.ts`。
///
/// 三条不变的既有哲学(与旧版 `HH:MM-HH:MM` 一致):
///  1. **空/缺省 = 全天同步** —— 时段是节流手段,不是安全边界;
///  2. **解析失败 = 全天同步** —— 绝不为一个配置笔误把目录永久锁死;
///  3. 窗口 `from == to` 按「这一条不设限」处理,而不是零长度窗口。
///
/// **本模块不碰时区也不碰日历系统**:时间以「民用日期 + 当天第几分钟」表示
/// (`CivilMoment`),"今天是否工作日"由调用方注入 `IsWorkday`。把时区解释收敛到
/// daemon 层(它知道自己该按哪个时区解释用户填的墙上时间),纯逻辑这层才有可能
/// 用 fixture 与 Node/Rust 逐条对拍。

///|
/// 日期条件。
#derive(Eq)
pub(all) enum DayPredicate {
  /// 每天。
  Any
  /// 工作日:查节假日日历(调休补班的周末算工作日)。
  Workday
  /// 休息日:与 workday 互补。
  Offday
  /// 指定星期几,0=周日 … 6=周六(与 JS `Date.getDay()` 同口径)。
  Dow(Array[Int32])
}

///|
pub extend DayPredicate with Eq::{equal, not_equal}

///|
/// 一个时间窗口,单位是「当天第几分钟」;`from > to` 表示跨午夜。
#derive(Eq)
pub(all) struct ScheduleWindow {
  from : Int32
  to : Int32
}

///|
pub extend ScheduleWindow with Eq::{equal, not_equal}

///|
/// 一条规则 = 日期条件 ∧ 若干窗口(窗口之间 OR)。
#derive(Eq)
pub(all) struct ScheduleRule {
  days : DayPredicate
  windows : Array[ScheduleWindow]
}

///|
pub extend ScheduleRule with Eq::{equal, not_equal}

///|
/// 规则数组,规则之间 OR。
pub type Schedule = Array[ScheduleRule]

///|
/// 规则与窗口的上限:防 UI 误操作刷出巨型配置(每次判定都要扫一遍)。
pub const SCHEDULE_MAX_RULES : Int32 = 8

///|
pub const SCHEDULE_MAX_WINDOWS : Int32 = 8

///|
pub const MINUTES_PER_DAY : Int32 = 1440

///|
/// 「工作日」判定的注入点(见 daemon 层的节假日日历)。
pub type IsWorkday = (Int32, Int32, Int32) -> Bool

///|
/// 民用时刻:年/月/日 + 当天第几分钟。不含时区,由调用方负责解释。
#derive(Eq)
pub(all) struct CivilMoment {
  year : Int32
  month : Int32
  day : Int32
  minutes : Int32
}

///|
pub extend CivilMoment with Eq::{equal, not_equal}

///|
pub fn CivilMoment::new(
  year : Int32,
  month : Int32,
  day : Int32,
  minutes : Int32,
) -> CivilMoment {
  { year, month, day, minutes, }
}

///|
/// 从时分构造。
pub fn CivilMoment::at(
  year : Int32,
  month : Int32,
  day : Int32,
  hour : Int32,
  minute : Int32,
) -> CivilMoment {
  CivilMoment::new(year, month, day, hour * 60 + minute)
}

///|
/// 星期几,0=周日 … 6=周六(与 JS `Date.getDay()` 同口径)。
pub fn CivilMoment::day_of_week(self : CivilMoment) -> Int32 {
  // 1970-01-01 是周四(=4)。把民用日期折算成「距纪元的天数」再取模。
  let days = days_from_civil(self.year, self.month, self.day)
  (((days + 4L) % 7L + 7L) % 7L).to_int()
}

///|
/// 民用日期 → 距 1970-01-01 的天数(Howard Hinnant 的 days_from_civil)。
///
/// 不用任何日历库是为了让本模块保持零依赖、零时区:这里只需要一个可逆的
/// 日期整数表示,闰年规则由算法本身覆盖。天数用 Int64,极端年份也不溢出。
pub fn days_from_civil(year : Int32, month : Int32, day : Int32) -> Int64 {
  let y = (if month <= 2 { year - 1 } else { year }).to_int64()
  let era = (if y >= 0 { y } else { y - 399 }) / 400
  let yoe = y - era * 400 // [0, 399]
  let m = month.to_int64()
  let doy = (153L * (if m > 2 { m - 3 } else { m + 9 }) + 2L) / 5L +
    day.to_int64() -
    1L
  let doe = yoe * 365L + yoe / 4L - yoe / 100L + doy
  era * 146097L + doe - 719468L
}

///|
/// `days_from_civil` 的逆运算:返回 (年, 月, 日)。
pub fn civil_from_days(days : Int64) -> (Int32, Int32, Int32) {
  let z = days + 719468L
  let era = (if z >= 0L { z } else { z - 146096L }) / 146097L
  let doe = z - era * 146097L
  let yoe = (doe - doe / 1460L + doe / 36524L - doe / 146096L) / 365L
  let y = yoe + era * 400L
  let doy = doe - (365L * yoe + yoe / 4L - yoe / 100L)
  let mp = (5L * doy + 2L) / 153L
  let d = doy - (153L * mp + 2L) / 5L + 1L
  let m = if mp < 10 { mp + 3 } else { mp - 9 }
  ((if m <= 2 { y + 1 } else { y }).to_int(), m.to_int(), d.to_int())
}

///|
/// 某时刻是否落在窗口内。`from == to` = 不设限(哲学第 3 条);`from > to`
/// 跨午夜,拆成「今晚 from 到午夜」与「零点到 to」两段。
pub fn within_window(window : ScheduleWindow, minutes_of_day : Int32) -> Bool {
  if window.from == window.to {
    return true
  }
  if window.from < window.to {
    return minutes_of_day >= window.from && minutes_of_day < window.to
  }
  minutes_of_day >= window.from || minutes_of_day < window.to
}

///|
fn matches_day(
  days : DayPredicate,
  moment : CivilMoment,
  is_workday : IsWorkday,
) -> Bool {
  match days {
    Any => true
    Workday => is_workday(moment.year, moment.month, moment.day)
    Offday => !is_workday(moment.year, moment.month, moment.day)
    Dow(list) => dow_contains(list, moment.day_of_week())
  }
}

///|
fn dow_contains(days : Array[Int32], d : Int32) -> Bool {
  for x in days {
    if x == d {
      return true
    }
  }
  false
}

///|
/// 没有任何有效约束(整体为空、或每条规则都没有有效窗口)= 全天同步。
pub fn schedule_is_unbounded(schedule : Schedule?) -> Bool {
  match schedule {
    None => true
    Some(rules) => {
      for rule in rules {
        if !(rule.windows.length() == 0 || has_unlimited_window(rule.windows)) {
          return false
        }
      }
      true
    }
  }
}

///|
fn has_unlimited_window(windows : Array[ScheduleWindow]) -> Bool {
  for w in windows {
    if w.from == w.to {
      return true
    }
  }
  false
}

///|
/// 此刻是否允许同步。空/缺省/非法(已在 normalize_schedule 里清洗)= 允许。
pub fn within_schedule(
  schedule : Schedule?,
  moment : CivilMoment,
  is_workday : IsWorkday,
) -> Bool {
  if schedule_is_unbounded(schedule) {
    return true
  }
  let rules : Array[ScheduleRule] = match schedule {
    Some(rules) => rules
    None => []
  }
  for rule in rules {
    if matches_day(rule.days, moment, is_workday) &&
      has_matching_window(rule.windows, moment.minutes) {
      return true
    }
  }
  false
}

///|
fn has_matching_window(
  windows : Array[ScheduleWindow],
  minutes : Int32,
) -> Bool {
  for w in windows {
    if within_window(w, minutes) {
      return true
    }
  }
  false
}

///|
/// next_schedule_change 的候选边界:距今天数 + 当天分钟。
priv struct Candidate {
  day_offset : Int64
  minutes : Int32
}

///|
/// 下一次「时段状态可能翻转」的时刻,用于文案与准点唤醒。
///
/// 收集今天/明天凌晨的所有窗口边界 + 次日零点(日期条件会变),按时间升序取
/// **第一个判定结果确实与现在不同**的候选。`None` = 全天无约束。
/// 候选数量有界(规则 ≤8 × 窗口 ≤8 × 2 端点 + 零点),不做分钟级扫描。
pub fn next_schedule_change(
  schedule : Schedule?,
  now : CivilMoment,
  is_workday : IsWorkday,
) -> CivilMoment? {
  if schedule_is_unbounded(schedule) {
    return None
  }
  let rules : Array[ScheduleRule] = match schedule {
    Some(rules) => rules
    None => []
  }
  // 候选按 (距今天数, 当天分钟) 表示;同刻去重
  let candidates : Array[Candidate] = []
  for rule in rules {
    for w in rule.windows {
      if w.from == w.to {
        continue // 不设限的窗口不产生边界
      }
      add_candidate(candidates, now.minutes, 0, w.from)
      add_candidate(candidates, now.minutes, 0, w.to)
      add_candidate(candidates, now.minutes, 1, w.from)
      add_candidate(candidates, now.minutes, 1, w.to)
    }
  }
  add_candidate(candidates, now.minutes, 1, 0) // 零点:星期/节假日身份切换
  candidates.sort_by(compare_candidates)
  let now_inside = within_schedule(schedule, now, is_workday)
  let today_days = days_from_civil(now.year, now.month, now.day)
  for candidate in candidates {
    let (y, m, d) = civil_from_days(today_days + candidate.day_offset)
    let moment = CivilMoment::new(y, m, d, candidate.minutes)
    if within_schedule(schedule, moment, is_workday) != now_inside {
      return Some(moment)
    }
  }
  None
}

///|
/// 只收「晚于现在」的候选,并做同刻去重。
fn add_candidate(
  out : Array[Candidate],
  now_minutes : Int32,
  day_offset : Int64,
  minutes : Int32,
) -> Unit {
  let later = day_offset > 0 || minutes > now_minutes
  if later {
    for existing in out {
      if existing.day_offset == day_offset && existing.minutes == minutes {
        return
      }
    }
    out.push({ day_offset, minutes, })
  }
}

///|
fn compare_candidates(a : Candidate, b : Candidate) -> Int32 {
  if a.day_offset < b.day_offset {
    -1
  } else if a.day_offset > b.day_offset {
    1
  } else if a.minutes < b.minutes {
    -1
  } else if a.minutes > b.minutes {
    1
  } else {
    0
  }
}

// ==================== 解析 / 归一化(含旧格式迁移) ====================

///|
/// 解析一个时刻:数字(分钟数,向下取整)或 `HH:MM` 文本。其余一律 None。
fn parse_clock(raw : Json?) -> Int32? {
  match raw {
    // Rust:is_finite 且 0 ≤ n < 1440;NaN/±inf 过不了比较,天然被拒
    Some(Number(n, ..)) =>
      if n >= 0.0 && n < 1440.0 {
        Some(n.floor().to_int())
      } else {
        None
      }
    Some(String(s)) => parse_clock_text(s.trim())
    _ => None
  }
}

///|
/// `HH:MM` 文本 → 分钟数,要求 `^\d{1,2}:\d{2}$` 且时分不越界。
fn parse_clock_text(raw : StringView) -> Int32? {
  match raw.split_once(":") {
    Some((h, m)) => {
      if h.char_length() == 0 || h.char_length() > 2 || m.char_length() != 2 {
        return None
      }
      if !all_digits(h) || !all_digits(m) {
        return None
      }
      let hour = digits_value(h)
      let minute = digits_value(m)
      if hour > 23 || minute > 59 {
        return None
      }
      Some(hour * 60 + minute)
    }
    None => None
  }
}

///|
/// 纯十进制字串 → Int;含非数字或为空返回 None。
fn all_digits(s : StringView) -> Bool {
  if s.char_length() == 0 {
    return false
  }
  for c in s {
    if c < '0' || c > '9' {
      return false
    }
  }
  true
}

///|
/// 调用方须先用 `all_digits` 校验。
fn digits_value(s : StringView) -> Int32 {
  let mut n = 0
  for c in s {
    n = n * 10 + (c.to_int() - '0'.to_int())
  }
  n
}

///|
/// 近似 serde_json 的 `as_i64`:只有整数字面量(`-?\d+`)才算整数;
/// `5.0`、`1e2` 这类浮点表示不算。
fn is_integer_text(text : String) -> Bool {
  let chars = text.to_array()
  let n = chars.length()
  let start = if n > 0 && chars[0] == '-' { 1 } else { 0 }
  if start >= n {
    return false
  }
  for i in start..<n {
    let c = chars[i]
    if c < '0' || c > '9' {
      return false
    }
  }
  true
}

///|
/// 日期条件清洗:kind 缺省/不认识 = any;dow 的 days 只收 0..=6 的整数,
/// 去重升序后,选满 7 天或空选都归一成 any(等价于不限,免得界面留一条
/// 看起来更严实则等价/永不命中的规则)。
fn normalize_days(raw : Json?) -> DayPredicate {
  match raw {
    Some(Object(obj)) =>
      match obj.get("kind") {
        Some(String(kind)) =>
          if kind == "workday" {
            Workday
          } else if kind == "offday" {
            Offday
          } else if kind == "dow" {
            normalize_dow_days(obj.get("days"))
          } else {
            Any
          }
        _ => Any
      }
    Some(String(s)) =>
      if s == "workday" {
        Workday
      } else if s == "offday" {
        Offday
      } else {
        Any
      }
    _ => Any
  }
}

///|
fn normalize_dow_days(raw : Json?) -> DayPredicate {
  let picked : Array[Int32] = []
  match raw {
    Some(Array(items)) =>
      for item in items {
        match item {
          Number(n, repr~) => {
            // 只认整数。serde_json 的 as_i64 对 `5.0` 这类浮点表示返回
            // None;保留原文(repr)时按整数字面量判定,拿不到原文时退
            // 化为 floor 判定(与 Node 口径一致,仅 `5.0` 这类边角不同)
            let integral = match repr {
              Some(text) => is_integer_text(text)
              None => !n.is_nan() && n == n.floor()
            }
            if integral && n >= 0.0 && n <= 6.0 {
              picked.push(n.to_int())
            }
          }
          _ => ()
        }
      }
    _ => ()
  }
  picked.sort_by(compare_int32)
  // 去重(已升序)
  let days : Array[Int32] = []
  for d in picked {
    if days.length() == 0 || days[days.length() - 1] != d {
      days.push(d)
    }
  }
  if days.length() == 7 || days.length() == 0 {
    Any
  } else {
    Dow(days)
  }
}

///|
fn compare_int32(a : Int32, b : Int32) -> Int32 {
  if a < b {
    -1
  } else if a > b {
    1
  } else {
    0
  }
}

///|
/// 旧格式 `HH:MM-HH:MM` 的匹配:返回 (from, to)。
fn parse_legacy(raw : String) -> (Int32, Int32)? {
  let s = raw.trim()
  match s.split_once("-") {
    Some((left, right)) => {
      let from = parse_clock_text(left)
      let to = parse_clock_text(right)
      match (from, to) {
        (Some(from), Some(to)) => Some((from, to))
        _ => None
      }
    }
    None => None
  }
}

///|
/// 清洗任意来源(旧配置文件、设置弹窗、手改 JSON)的时段配置。
/// 返回 `None` = 不设限。规则与窗口都去重并截断到上限;任何解析不出来的
/// 片段一律丢弃而不是报错 —— 时段是节流手段,坏数据必须退化成「不设限」,
/// 绝不锁死。
pub fn normalize_schedule(raw : Json) -> Schedule? {
  match raw {
    Null => None
    String(s) =>
      if s == "" {
        None
      } else {
        // 旧格式:`HH:MM-HH:MM` 字符串(含跨午夜),迁移成一条「不限日期」
        // 的规则;from == to 视为不设限
        match parse_legacy(s) {
          Some((from, to)) =>
            if from == to {
              None
            } else {
              Some([{ days: Any, windows: [{ from, to, }], }])
            }
          None => None
        }
      }
    Array(items) => {
      let rules : Array[ScheduleRule] = []
      for i, item in items {
        if i >= SCHEDULE_MAX_RULES {
          break
        }
        match item {
          Object(obj) => {
            let windows : Array[ScheduleWindow] = []
            match obj.get("windows") {
              Some(Array(raw_windows)) =>
                for j, w in raw_windows {
                  if j >= SCHEDULE_MAX_WINDOWS {
                    break
                  }
                  match w {
                    Object(pair) =>
                      match
                        (
                          parse_clock(pair.get("from")),
                          parse_clock(pair.get("to")),
                        ) {
                        (Some(from), Some(to)) =>
                          if !windows_contain(windows, from, to) {
                            windows.push({ from, to, })
                          }
                        _ => ()
                      }
                    _ => ()
                  }
                }
              // 兼容「一条规则只有一个窗口」的平铺简化写法(前端表单的直接产物)
              _ =>
                if obj.contains("from") || obj.contains("to") {
                  match
                    (parse_clock(obj.get("from")), parse_clock(obj.get("to"))) {
                    (Some(from), Some(to)) => windows.push({ from, to, })
                    _ => ()
                  }
                }
            }
            if windows.length() > 0 {
              rules.push({ days: normalize_days(obj.get("days")), windows, })
            }
          }
          _ => ()
        }
      }
      if rules.length() > 0 {
        Some(rules)
      } else {
        None
      }
    }
    _ => None
  }
}

///|
fn windows_contain(
  windows : Array[ScheduleWindow],
  from : Int32,
  to : Int32,
) -> Bool {
  for w in windows {
    if w.from == from && w.to == to {
      return true
    }
  }
  false
}

///|
/// 一条规则的界面摘要文案(供徽标 tooltip / 列表行):「工作日 09:00–18:00」。
pub fn format_schedule_summary(schedule : Schedule?) -> String {
  if schedule_is_unbounded(schedule) {
    return "全天同步"
  }
  let rules : Array[ScheduleRule] = match schedule {
    Some(rules) => rules
    None => []
  }
  let parts : Array[String] = []
  for rule in rules {
    let windows : Array[String] = []
    for w in rule.windows {
      windows.push("\{clock_text(w.from)}–\{clock_text(w.to)}")
    }
    parts.push("\{day_label(rule.days)} \{join_strings(windows, "、")}")
  }
  join_strings(parts, "；")
}

///|
fn day_label(days : DayPredicate) -> String {
  match days {
    Any => "每天"
    Workday => "工作日"
    Offday => "休息日"
    Dow(list) => {
      let names = [
        "周日", "周一", "周二", "周三", "周四", "周五", "周六",
      ]
      let parts : Array[String] = []
      for d in list {
        if d >= 0 && d <= 6 {
          parts.push(names[d])
        } else {
          parts.push("?")
        }
      }
      join_strings(parts, "、")
    }
  }
}

///|
fn two_digits(n : Int32) -> String {
  if n < 10 {
    "0\{n}"
  } else {
    "\{n}"
  }
}

///|
fn clock_text(minutes : Int32) -> String {
  "\{two_digits(minutes / 60)}:\{two_digits(minutes % 60)}"
}

///|
fn join_strings(parts : Array[String], sep : String) -> String {
  let buf = StringBuilder()
  for i, part in parts {
    if i > 0 {
      buf.write_string(sep)
    }
    buf.write_string(part)
  }
  buf.to_string()
}

///|
/// 归一化后的规则数组 → 配置 JSON 形态(与 Node `normalizeSchedule` 落盘的
/// 对象逐字同形:`{days:{kind,days?},windows:[{from,to}]}`)。None = 不设限。
/// 时段配置的持久化只走这里:API 写入什么形态,读回来就是同一份判定结果。
pub fn schedule_to_json(schedule : Array[ScheduleRule]?) -> Json? {
  match schedule {
    None => None
    Some(rules) => {
      let out : Array[Json] = []
      for rule in rules {
        let days : Map[String, Json] = Map([])
        match rule.days {
          Any => days.set("kind", Json::string("any"))
          Workday => days.set("kind", Json::string("workday"))
          Offday => days.set("kind", Json::string("offday"))
          Dow(list) => {
            days.set("kind", Json::string("dow"))
            let arr : Array[Json] = []
            for d in list {
              arr.push(Json::number(d.to_double()))
            }
            days.set("days", Json::array(arr))
          }
        }
        let windows : Array[Json] = []
        for w in rule.windows {
          let wm : Map[String, Json] = Map([])
          wm.set("from", Json::number(w.from.to_double()))
          wm.set("to", Json::number(w.to.to_double()))
          windows.push(Json::object(wm))
        }
        let rm : Map[String, Json] = Map([])
        rm.set("days", Json::object(days))
        rm.set("windows", Json::array(windows))
        out.push(Json::object(rm))
      }
      Some(Json::array(out))
    }
  }
}

///|
/// 「工作日」的退化口径:周一~周五(与 Node `isWeekdayByClock` 同语义)。
/// MoonBit 后端尚未接节假日日历(清单项),判注入这份退化实现 —— 语义与
/// 「无日历数据」完全一致:绝不为拉不到日历把目录锁死。
pub fn weekday_workday_fallback(
  year : Int32,
  month : Int32,
  day : Int32,
) -> Bool {
  let dow = CivilMoment::new(year, month, day, 0).day_of_week()
  dow >= 1 && dow <= 5
}

///|
/// `Json?` 版归一化(字段缺省/清除 → 不设限):config 模型里的时段字段是
/// 透传 Json?,判定与落盘前都要过这一步。
pub fn normalize_schedule_opt(raw : Json?) -> Schedule? {
  match raw {
    Some(j) => normalize_schedule(j)
    None => None
  }
}
