//! 同步时段模型(全局 + 目录级共用一份)。对应 Node 侧 `src/schedule.ts`。
//!
//! 三条不变的既有哲学(与旧版 `HH:MM-HH:MM` 一致):
//!  1. **空/缺省 = 全天同步** —— 时段是节流手段,不是安全边界;
//!  2. **解析失败 = 全天同步** —— 绝不为一个配置笔误把目录永久锁死;
//!  3. 窗口 `from == to` 按「这一条不设限」处理,而不是零长度窗口。
//!
//! **本模块不碰时区也不碰日历系统**:时间以「民用日期 + 当天第几分钟」表示
//! (`CivilMoment`),"今天是否工作日"由调用方注入 `IsWorkday`。
//!
//! 这样设计不只是为了好测 —— Node 侧用 `Date` 实现,`nextScheduleChangeAt`
//! 的返回值依赖机器本地时区与 DST 规则,同一份配置在两台机器上可能算出不同时刻。
//! 把时区解释收敛到 daemon 层(它知道自己该按哪个时区解释用户填的墙上时间),
//! 纯逻辑这层才有可能用 fixture 逐条对拍。

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 日期条件。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum DayPredicate {
    /// 每天。
    Any,
    /// 工作日:查节假日日历(调休补班的周末算工作日)。
    Workday,
    /// 休息日:与 workday 互补。
    Offday,
    /// 指定星期几,0=周日 … 6=周六(与 JS `Date.getDay()` 同口径)。
    Dow { days: Vec<u32> },
}

/// 一个时间窗口,单位是「当天第几分钟」;`from > to` 表示跨午夜。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScheduleWindow {
    pub from: u32,
    pub to: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScheduleRule {
    pub days: DayPredicate,
    pub windows: Vec<ScheduleWindow>,
}

pub type Schedule = Vec<ScheduleRule>;

/// 规则与窗口的上限:防 UI 误操作刷出巨型配置(每次判定都要扫一遍)。
pub const SCHEDULE_MAX_RULES: usize = 8;
pub const SCHEDULE_MAX_WINDOWS: usize = 8;

pub const MINUTES_PER_DAY: u32 = 1440;

/// 「工作日」判定的注入点。
pub type IsWorkday = dyn Fn(i32, u32, u32) -> bool;

/// 民用时刻:年/月/日 + 当天第几分钟。不含时区,由调用方负责解释。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct CivilMoment {
    pub year: i32,
    pub month: u32,
    pub day: u32,
    pub minutes: u32,
}

impl CivilMoment {
    pub fn new(year: i32, month: u32, day: u32, minutes: u32) -> Self {
        Self {
            year,
            month,
            day,
            minutes,
        }
    }

    /// 从时分构造。
    pub fn at(year: i32, month: u32, day: u32, hour: u32, minute: u32) -> Self {
        Self::new(year, month, day, hour * 60 + minute)
    }

    /// 星期几,0=周日 … 6=周六(与 JS `Date.getDay()` 同口径)。
    pub fn day_of_week(&self) -> u32 {
        // 1970-01-01 是周四(=4)。把民用日期折算成「距纪元的天数」再取模。
        let days = days_from_civil(self.year, self.month, self.day);
        (((days + 4) % 7 + 7) % 7) as u32
    }
}

/// 民用日期 → 距 1970-01-01 的天数(Howard Hinnant 的 days_from_civil)。
///
/// 不用 `chrono` 是为了让 core 保持零依赖、零时区:这里只需要一个可逆的
/// 日期整数表示,不需要任何日历系统知识(闰秒、闰年规则由算法本身覆盖)。
fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year } as i64;
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let m = month as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `days_from_civil` 的逆运算。
fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    ((if m <= 2 { y + 1 } else { y }) as i32, m as u32, d as u32)
}

/// 次日零点(民用日期 +1 天)。
fn next_midnight(moment: &CivilMoment) -> CivilMoment {
    let (y, m, d) = civil_from_days(days_from_civil(moment.year, moment.month, moment.day) + 1);
    CivilMoment::new(y, m, d, 0)
}

/// 某时刻是否落在窗口内。
pub fn within_window(window: ScheduleWindow, minutes_of_day: u32) -> bool {
    if window.from == window.to {
        return true; // 不设限(哲学第 3 条)
    }
    if window.from < window.to {
        return minutes_of_day >= window.from && minutes_of_day < window.to;
    }
    // 跨午夜:拆成「今晚上 from 到午夜」与「零点到 to」两段
    minutes_of_day >= window.from || minutes_of_day < window.to
}

fn matches_day(days: &DayPredicate, moment: &CivilMoment, is_workday: &IsWorkday) -> bool {
    match days {
        DayPredicate::Any => true,
        DayPredicate::Workday => is_workday(moment.year, moment.month, moment.day),
        DayPredicate::Offday => !is_workday(moment.year, moment.month, moment.day),
        DayPredicate::Dow { days } => days.contains(&moment.day_of_week()),
    }
}

/// 没有任何有效约束(整体为空、或每条规则都没有有效窗口)= 全天同步。
pub fn schedule_is_unbounded(schedule: Option<&Schedule>) -> bool {
    match schedule {
        None => true,
        Some(rules) if rules.is_empty() => true,
        Some(rules) => rules
            .iter()
            .all(|r| r.windows.is_empty() || r.windows.iter().any(|w| w.from == w.to)),
    }
}

/// 此刻是否允许同步。空/缺省/非法(已在 normalize 里清洗)= 允许。
pub fn within_schedule(
    schedule: Option<&Schedule>,
    moment: &CivilMoment,
    is_workday: &IsWorkday,
) -> bool {
    if schedule_is_unbounded(schedule) {
        return true;
    }
    let rules = schedule.unwrap_or(&Vec::new()).clone();
    rules.iter().any(|rule| {
        matches_day(&rule.days, moment, is_workday)
            && rule
                .windows
                .iter()
                .any(|w| within_window(*w, moment.minutes))
    })
}

/// 下一次「时段状态可能翻转」的时刻,用于文案与准点唤醒。
///
/// 收集今天/明天凌晨的所有窗口边界 + 次日零点(日期条件会变),按时间升序取
/// **第一个判定结果确实与现在不同**的候选。`None` = 全天无约束。
///
/// 候选数量有界(规则 ≤8 × 窗口 ≤8 × 2 端点 + 零点),不做分钟级扫描。
pub fn next_schedule_change(
    schedule: Option<&Schedule>,
    now: &CivilMoment,
    is_workday: &IsWorkday,
) -> Option<CivilMoment> {
    if schedule_is_unbounded(schedule) {
        return None;
    }
    let rules = schedule.unwrap_or(&Vec::new()).clone();
    let tomorrow = next_midnight(now);

    // 候选用 (距今天数, 当天分钟) 表示,按实际时间排序;同刻去重。
    let mut candidates: Vec<(i64, u32)> = Vec::new();
    let push = |day_offset: i64, minutes: u32, out: &mut Vec<(i64, u32)>| {
        let later = day_offset > 0 || minutes > now.minutes;
        if later && !out.contains(&(day_offset, minutes)) {
            out.push((day_offset, minutes));
        }
    };

    for rule in &rules {
        for w in &rule.windows {
            if w.from == w.to {
                continue; // 不设限的窗口不产生边界
            }
            push(0, w.from, &mut candidates);
            push(0, w.to, &mut candidates);
            push(1, w.from, &mut candidates);
            push(1, w.to, &mut candidates);
        }
    }
    push(1, 0, &mut candidates); // 零点:星期/节假日身份切换

    candidates.sort();

    let now_inside = within_schedule(schedule, now, is_workday);
    let today_days = days_from_civil(now.year, now.month, now.day);
    for (day_offset, minutes) in candidates {
        let (y, m, d) = civil_from_days(today_days + day_offset);
        let moment = CivilMoment::new(y, m, d, minutes);
        if within_schedule(schedule, &moment, is_workday) != now_inside {
            return Some(moment);
        }
    }
    let _ = tomorrow; // 仅用于表达「次日零点」的语义,实际由 day_offset=1 表示
    None
}

/* ==================== 解析 / 归一化(含旧格式迁移) ==================== */

fn parse_clock(raw: &Value) -> Option<u32> {
    if let Some(n) = raw.as_f64() {
        if n.is_finite() && (0.0..MINUTES_PER_DAY as f64).contains(&n) {
            return Some(n.floor() as u32);
        }
        return None;
    }
    let s = raw.as_str()?.trim();
    // ^(\d{1,2}):(\d{2})$
    let (h, m) = s.split_once(':')?;
    if h.is_empty() || h.len() > 2 || m.len() != 2 {
        return None;
    }
    if !h.bytes().all(|b| b.is_ascii_digit()) || !m.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let hour: u32 = h.parse().ok()?;
    let minute: u32 = m.parse().ok()?;
    if hour > 23 || minute > 59 {
        return None;
    }
    Some(hour * 60 + minute)
}

fn normalize_days(raw: &Value) -> DayPredicate {
    if let Some(obj) = raw.as_object() {
        match obj.get("kind").and_then(|k| k.as_str()) {
            Some("workday") => return DayPredicate::Workday,
            Some("offday") => return DayPredicate::Offday,
            Some("dow") => {
                let mut days: Vec<u32> = match obj.get("days").and_then(|d| d.as_array()) {
                    Some(arr) => arr
                        .iter()
                        .filter_map(|x| x.as_i64())
                        .filter(|x| (0..=6).contains(x))
                        .map(|x| x as u32)
                        .collect(),
                    None => Vec::new(),
                };
                days.sort_unstable();
                days.dedup();
                // 选了 7 天等于「不限」,归一成 any 免得界面上留一条看起来更严实则等价的规则
                if days.len() == 7 {
                    return DayPredicate::Any;
                }
                // 空选没有意义(那条规则永不命中),按不设限处理而不是静默锁死
                if days.is_empty() {
                    return DayPredicate::Any;
                }
                return DayPredicate::Dow { days };
            }
            _ => return DayPredicate::Any,
        }
    }
    if let Some(s) = raw.as_str() {
        if s == "workday" || s == "offday" {
            return if s == "workday" {
                DayPredicate::Workday
            } else {
                DayPredicate::Offday
            };
        }
    }
    DayPredicate::Any
}

/// 旧格式 `HH:MM-HH:MM` 的匹配:返回 (from, to)。
fn parse_legacy(raw: &str) -> Option<(u32, u32)> {
    let s = raw.trim();
    let (left, right) = s.split_once('-')?;
    let from = parse_clock(&Value::String(left.to_string()))?;
    let to = parse_clock(&Value::String(right.to_string()))?;
    Some((from, to))
}

/// 清洗任意来源(旧配置文件、设置弹窗、手改 JSON)的时段配置。
/// 返回 `None` = 不设限。规则与窗口都去重并截断到上限;任何解析不出来的片段
/// 一律丢弃而不是报错 —— 时段是节流手段,坏数据必须退化成「不设限」,绝不锁死。
pub fn normalize_schedule(raw: &Value) -> Option<Schedule> {
    match raw {
        Value::Null => return None,
        Value::String(s) if s.is_empty() => return None,
        _ => {}
    }

    // 旧格式:`HH:MM-HH:MM` 字符串(含跨午夜)。迁移成一条「不限日期」的规则。
    if let Some(s) = raw.as_str() {
        let (from, to) = parse_legacy(s)?;
        if from == to {
            return None;
        }
        return Some(vec![ScheduleRule {
            days: DayPredicate::Any,
            windows: vec![ScheduleWindow { from, to }],
        }]);
    }

    let items = raw.as_array()?;
    let mut rules: Vec<ScheduleRule> = Vec::new();

    for item in items.iter().take(SCHEDULE_MAX_RULES) {
        let Some(obj) = item.as_object() else {
            continue;
        };
        // 兼容「一条规则只有一个窗口」的简化写法(前端表单的直接产物)
        let raw_windows: Vec<Value> = match obj.get("windows").and_then(|w| w.as_array()) {
            Some(arr) => arr.clone(),
            None => {
                if obj.contains_key("from") || obj.contains_key("to") {
                    vec![Value::Object(
                        [
                            (
                                "from".to_string(),
                                obj.get("from").cloned().unwrap_or(Value::Null),
                            ),
                            (
                                "to".to_string(),
                                obj.get("to").cloned().unwrap_or(Value::Null),
                            ),
                        ]
                        .into_iter()
                        .collect(),
                    )]
                } else {
                    Vec::new()
                }
            }
        };

        let mut windows: Vec<ScheduleWindow> = Vec::new();
        for w in raw_windows.iter().take(SCHEDULE_MAX_WINDOWS) {
            let Some(pair) = w.as_object() else {
                continue;
            };
            let from = parse_clock(pair.get("from").unwrap_or(&Value::Null));
            let to = parse_clock(pair.get("to").unwrap_or(&Value::Null));
            let (Some(from), Some(to)) = (from, to) else {
                continue;
            };
            if windows
                .iter()
                .any(|existing| existing.from == from && existing.to == to)
            {
                continue;
            }
            windows.push(ScheduleWindow { from, to });
        }
        if windows.is_empty() {
            continue;
        }
        rules.push(ScheduleRule {
            days: normalize_days(obj.get("days").unwrap_or(&Value::Null)),
            windows,
        });
    }

    if rules.is_empty() {
        None
    } else {
        Some(rules)
    }
}

/// 一条规则的界面摘要文案(供徽标 tooltip / 列表行):「工作日 09:00–23:00」。
pub fn format_schedule_summary(schedule: Option<&Schedule>) -> String {
    if schedule_is_unbounded(schedule) {
        return "全天同步".to_string();
    }

    fn day_label(d: &DayPredicate) -> String {
        const NAMES: [&str; 7] = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
        match d {
            DayPredicate::Any => "每天".to_string(),
            DayPredicate::Workday => "工作日".to_string(),
            DayPredicate::Offday => "休息日".to_string(),
            DayPredicate::Dow { days } => days
                .iter()
                .map(|&x| NAMES.get(x as usize).copied().unwrap_or("?"))
                .collect::<Vec<_>>()
                .join("、"),
        }
    }

    fn clock(mins: u32) -> String {
        format!("{:02}:{:02}", mins / 60, mins % 60)
    }

    schedule
        .unwrap_or(&Vec::new())
        .iter()
        .map(|r| {
            let windows = r
                .windows
                .iter()
                .map(|w| format!("{}–{}", clock(w.from), clock(w.to)))
                .collect::<Vec<_>>()
                .join("、");
            format!("{} {}", day_label(&r.days), windows)
        })
        .collect::<Vec<_>>()
        .join("；")
}
