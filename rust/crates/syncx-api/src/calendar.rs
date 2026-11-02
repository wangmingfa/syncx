//! 日历面板的读取侧:某年的节假日表 + 手动覆盖。
//!
//! 判定路径上绝不打网络(与 Node `holidays.ts` 同一约束)。这里只读
//! `<configDir>/holidays-<year>.json` 缓存 —— 缓存不存在就回空表,前端按星期几退化,
//! 绝不因为「还没拉到数据」把目录判成不同步。拉取动作由 CLI/装配层负责,
//! API 只回答「现在盘上有什么」。
//!
//! 缓存**不写进 config.json**:那个文件被 fs.watch 盯着做热重载,年度数据写进去会让
//! 每次刷新都触发一轮配置重载。

use std::path::Path;

use serde_json::{json, Map, Value};

/// 手动覆盖只认这两种身份。
pub const DAY_TYPE_WORKDAY: &str = "workday";
pub const DAY_TYPE_HOLIDAY: &str = "holiday";

/// `YYYY-MM-DD` 且**真实存在**(回环校验,`2026-02-30` 不算)。
pub fn is_real_date_key(key: &str) -> bool {
    use chrono::NaiveDate;
    if key.len() != 10 {
        return false;
    }
    NaiveDate::parse_from_str(key, "%Y-%m-%d").is_ok()
}

fn cache_path(config_dir: &Path, year: i32) -> std::path::PathBuf {
    config_dir.join(format!("holidays-{year}.json"))
}

/// 该年的日期表;无缓存或缓存损坏返回 `None`(坏缓存等同没有,不影响判定)。
pub fn year_days(config_dir: &Path, year: i32) -> Option<Value> {
    let raw = std::fs::read_to_string(cache_path(config_dir, year)).ok()?;
    let parsed: Value = serde_json::from_str(&raw).ok()?;
    let days = parsed.get("days")?.as_object()?;
    let mut out = Map::new();
    for (key, value) in days {
        let ok_value = matches!(
            value.as_str(),
            Some(DAY_TYPE_WORKDAY) | Some(DAY_TYPE_HOLIDAY)
        );
        if is_real_date_key(key) && ok_value {
            out.insert(key.clone(), value.clone());
        }
    }
    Some(Value::Object(out))
}

/// 该年缓存是否已落盘(供 `fetched` 标志)。
pub fn fetched(config_dir: &Path, year: i32) -> bool {
    year_days(config_dir, year).is_some()
}

/// `GET /api/calendar` 的响应体:`{year, days, overrides, fetched}`。
pub fn calendar_payload(
    config_dir: &Path,
    year: i32,
    overrides: &std::collections::BTreeMap<String, String>,
) -> Value {
    let days = year_days(config_dir, year).unwrap_or_else(|| json!({}));
    json!({
        "year": year,
        "days": days,
        "overrides": overrides,
        "fetched": fetched(config_dir, year),
    })
}

/// 手动覆盖的写入校验。`None` = 撤销覆盖。与 Node 文案一致。
pub fn validate_override(date: &str, day_type: Option<&str>) -> Result<(), String> {
    if !is_real_date_key(date) {
        return Err("date must be a string (YYYY-MM-DD)".to_string());
    }
    match day_type {
        None | Some(DAY_TYPE_WORKDAY) | Some(DAY_TYPE_HOLIDAY) => Ok(()),
        _ => Err("type must be 'workday' | 'holiday' | null".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "syncx-api-calendar-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn real_date_keys_reject_impossible_dates() {
        assert!(is_real_date_key("2026-10-01"));
        assert!(!is_real_date_key("2026-13-01"));
        assert!(!is_real_date_key("2026-02-30"));
        assert!(!is_real_date_key("2026-2-1"));
        assert!(!is_real_date_key(""));
    }

    #[test]
    fn missing_cache_yields_empty_days() {
        let dir = temp("missing");
        let payload = calendar_payload(&dir, 2026, &Default::default());
        assert_eq!(payload["days"], json!({}));
        assert_eq!(payload["fetched"], json!(false));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_cache_is_treated_as_absent() {
        let dir = temp("corrupt");
        std::fs::write(dir.join("holidays-2026.json"), b"{not json").unwrap();
        assert_eq!(year_days(&dir, 2026), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cache_filters_unknown_day_types() {
        let dir = temp("filter");
        std::fs::write(
            dir.join("holidays-2026.json"),
            br#"{"year":2026,"fetchedAt":1,"days":{"2026-10-01":"holiday","2026-02-30":"holiday","2026-10-02":"nope"}}"#,
        )
        .unwrap();
        let days = year_days(&dir, 2026).unwrap();
        assert_eq!(days["2026-10-01"], json!("holiday"));
        assert!(days.get("2026-02-30").is_none(), "不可能存在的日期不入表");
        assert!(days.get("2026-10-02").is_none(), "未知身份不入表");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
