//! 同步周报:近 7 天变更/冲突/对端活跃度聚合。
//!
//! 纯读、无副作用。流量字节不在口径内:`TrafficStats` 是内存态、daemon 重启即清零,
//! 拿不到可信的 7 天累计,所以周报只谈**条数**。
//!
//! 与 Node `report.ts` 同口径的细节都集中在 [`aggregate`] 里:
//!  * 窗口是「今天往前 6 个自然日的 00:00」起 —— 用本地时区切日,不是 7×24 小时;
//!  * `days` 恒为 7 项,没有事件的日期也占位(前端直接画柱);
//!  * 目录哪怕 0 条也出现在列表里(「谁没动」和「谁动了」一样有信息量);
//!  * 截断判定看**目录最早一条记录**是否已贴着窗口起点 —— 贴着就说明可能已被保留上限裁过。

use serde_json::{json, Value};

use crate::history::{HistoryStore, SyncEvent};

/// 统计窗口:自然日粒度、含今天的最近 7 天。
pub const REPORT_WINDOW_DAYS: usize = 7;
/// 冲突明细最多回传条数(完整列表在冲突页)。
const MAX_CONFLICT_ITEMS: usize = 50;
const DAY_MS: i64 = 86_400_000;

/// 毫秒时间戳 → 本地日期键 `YYYY-MM-DD`。
pub fn day_key(ts: i64) -> String {
    use chrono::{Local, TimeZone};
    match Local.timestamp_millis_opt(ts).single() {
        Some(moment) => moment.format("%Y-%m-%d").to_string(),
        None => String::new(),
    }
}

/// 本地当天零点(毫秒)。
fn start_of_today(now: i64) -> i64 {
    use chrono::{Local, TimeZone};
    match Local.timestamp_millis_opt(now).single() {
        Some(moment) => moment
            .date_naive()
            .and_hms_opt(0, 0, 0)
            .and_then(|naive| Local.from_local_datetime(&naive).single())
            .map(|start| start.timestamp_millis())
            .unwrap_or(now - now.rem_euclid(DAY_MS)),
        None => now,
    }
}

/// 一个目录在窗口内的计数。
#[derive(Default)]
struct FolderRow {
    add: i64,
    update: i64,
    delete: i64,
    conflict: i64,
    total: i64,
}

impl FolderRow {
    fn bump(&mut self, action: &str) {
        match action {
            "add" => self.add += 1,
            "update" => self.update += 1,
            "delete" => self.delete += 1,
            "conflict" => self.conflict += 1,
            _ => return,
        }
        self.total += 1;
    }

    fn value(&self, id: &str, path: &str) -> Value {
        json!({
            "id": id,
            "path": path,
            "add": self.add,
            "update": self.update,
            "delete": self.delete,
            "conflict": self.conflict,
            "total": self.total,
        })
    }
}

/// 纯聚合:给定「目录 → 该目录全部保留事件」与基准时刻,产出周报。
pub fn aggregate(folders: &[(String, String, Vec<SyncEvent>)], now: i64) -> Value {
    let from_ts = start_of_today(now) - (REPORT_WINDOW_DAYS as i64 - 1) * DAY_MS;

    // 先铺 7 个空格子(旧→新),再往里累加
    let days: Vec<String> = (0..REPORT_WINDOW_DAYS)
        .map(|index| day_key(from_ts + index as i64 * DAY_MS))
        .collect();
    let mut day_rows: Vec<FolderRow> = (0..REPORT_WINDOW_DAYS).map(|_| FolderRow::default()).collect();
    let day_index: std::collections::HashMap<&str, usize> = days
        .iter()
        .enumerate()
        .map(|(index, key)| (key.as_str(), index))
        .collect();

    let mut folder_rows: Vec<(String, String, FolderRow)> = Vec::new();
    let mut device_counts: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
    let mut conflicts: Vec<Value> = Vec::new();
    let mut totals = FolderRow::default();
    let mut truncated = false;

    for (id, path, events) in folders {
        let mut row = FolderRow::default();
        let mut oldest: Option<i64> = None;
        for event in events {
            oldest = Some(oldest.map_or(event.ts, |cur| cur.min(event.ts)));
            if event.ts < from_ts {
                continue;
            }
            row.bump(&event.action);
            if let Some(index) = day_index.get(day_key(event.ts).as_str()) {
                day_rows[*index].bump(&event.action);
            }
            if event.action == "conflict" {
                let mut item = json!({
                    "ts": event.ts,
                    "folderPath": path,
                    "path": event.path,
                });
                if let Some(device_id) = &event.device_id {
                    item["deviceId"] = json!(device_id);
                }
                conflicts.push(item);
            }
            if event.direction == "remote" {
                if let Some(device_id) = &event.device_id {
                    *device_counts.entry(device_id.clone()).or_insert(0) += 1;
                }
            }
        }
        // 最早记录已贴到窗口首日 → 窗口内的量可能已被保留上限裁掉过
        if let Some(oldest) = oldest {
            if oldest <= from_ts + DAY_MS {
                truncated = true;
            }
        }
        totals.add += row.add;
        totals.update += row.update;
        totals.delete += row.delete;
        totals.conflict += row.conflict;
        totals.total += row.total;
        folder_rows.push((id.clone(), path.clone(), row));
    }

    conflicts.sort_by_key(|item| -item["ts"].as_i64().unwrap_or(0));
    conflicts.truncate(MAX_CONFLICT_ITEMS);
    folder_rows.sort_by_key(|row| std::cmp::Reverse(row.2.total));

    let mut device_list: Vec<(String, i64)> = device_counts.into_iter().collect();
    device_list.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));

    json!({
        "fromTs": from_ts,
        "toTs": now,
        "days": days.iter().enumerate().map(|(index, day)| json!({
            "day": day,
            "add": day_rows[index].add,
            "update": day_rows[index].update,
            "delete": day_rows[index].delete,
            "conflict": day_rows[index].conflict,
        })).collect::<Vec<_>>(),
        "totals": {
            "add": totals.add,
            "update": totals.update,
            "delete": totals.delete,
            "conflict": totals.conflict,
            "total": totals.total,
        },
        "folders": folder_rows.iter().map(|(id, path, row)| row.value(id, path)).collect::<Vec<_>>(),
        "activeDevices": device_list.iter().map(|(device_id, count)| json!({
            "deviceId": device_id,
            "count": count,
        })).collect::<Vec<_>>(),
        "conflicts": conflicts,
        "truncated": truncated,
    })
}

/// 采集入口:逐目录读全量保留记录,交给纯聚合器。
pub fn collect(history: &HistoryStore, folders: &[(String, String)], now: i64) -> Value {
    let collected: Vec<(String, String, Vec<SyncEvent>)> = folders
        .iter()
        .map(|(id, path)| {
            let result = history.query(id, usize::MAX, &Default::default());
            (id.clone(), path.clone(), result.events)
        })
        .collect();
    aggregate(&collected, now)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(ts: i64, action: &str, direction: &str, device: Option<&str>) -> SyncEvent {
        SyncEvent {
            ts,
            folder_id: "f".into(),
            path: "a.txt".into(),
            action: action.into(),
            direction: direction.into(),
            device_id: device.map(|id| id.to_string()),
            duration_ms: None,
        }
    }

    #[test]
    fn report_has_seven_days_and_counts() {
        // 用固定时刻:2026-10-31 12:00 本地
        let now = start_of_today(1_793_000_000_000) + 12 * 3_600_000;
        let from = start_of_today(now) - 6 * DAY_MS;
        let events = vec![
            event(from + 1000, "add", "local", None),
            event(now - 1000, "conflict", "remote", Some("DEV1")),
            event(from - 10 * DAY_MS, "update", "remote", Some("DEV1")),
        ];
        let report = aggregate(&[("f1".into(), "/data".into(), events)], now);
        assert_eq!(report["days"].as_array().unwrap().len(), 7);
        assert_eq!(report["totals"]["add"], 1);
        assert_eq!(report["totals"]["conflict"], 1);
        assert_eq!(report["totals"]["update"], 0, "窗口外的事件不计入");
        assert_eq!(report["activeDevices"][0]["deviceId"], "DEV1");
        assert_eq!(report["activeDevices"][0]["count"], 1);
        assert_eq!(report["conflicts"].as_array().unwrap().len(), 1);
        assert_eq!(report["truncated"], true, "最早记录贴着窗口首日");
    }

    #[test]
    fn zero_activity_folder_still_listed() {
        let now = 1_793_000_000_000;
        let report = aggregate(&[("f1".into(), "/data".into(), Vec::new())], now);
        assert_eq!(report["folders"].as_array().unwrap().len(), 1);
        assert_eq!(report["folders"][0]["total"], 0);
        assert_eq!(report["truncated"], false);
    }
}
