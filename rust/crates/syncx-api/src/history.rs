//! 同步历史:每目录一份 JSONL,`<configDir>/history/<folderId 转义>.jsonl`。
//!
//! 与 Node 侧 `src/history.ts` 同一份落盘格式与同一套查询口径 —— 历史文件是
//! 两个后端共享的只读视图,格式不一致就会「换后端之后历史全部消失」。
//!
//! 与 Node 的**唯一刻意差异**:聚合落盘改成即时追加,不再攒 200ms。
//! 攒批是为了减少同步高峰期的 IO 次数;Node 靠 `setTimeout` 的闭包捕获状态,
//! 而 Rust 里同样的事要么引入一个后台任务 + 通道,要么在查询前显式 flush。
//! 直接每次追加一行(一次 `append` 系统调用、O_APPEND 原子)在读写语义上完全等价,
//! 而且消除了「进程刚好在攒批窗口里被杀,最后几条记录丢失」这个 Node 侧的已知瑕疵。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// 每个目录保留的最大记录条数(未配置 `historyMaxEvents` 时的兜底)。
pub const DEFAULT_MAX_EVENTS: usize = 2000;

pub const ACTION_ADD: &str = "add";
pub const ACTION_UPDATE: &str = "update";
pub const ACTION_DELETE: &str = "delete";
pub const ACTION_CONFLICT: &str = "conflict";

pub const DIRECTION_LOCAL: &str = "local";
pub const DIRECTION_REMOTE: &str = "remote";

/// 一条同步记录:某目录内某文件的某次变更。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SyncEvent {
    pub ts: i64,
    #[serde(rename = "folderId")]
    pub folder_id: String,
    pub path: String,
    pub action: String,
    pub direction: String,
    /// 对端设备 ID(仅 remote 方向有值)。
    #[serde(rename = "deviceId", default, skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    /// 本次同步耗时(毫秒)。**只有真实存在「传输起止」的记录才有值**;
    /// 缺省表示「没有耗时可测」,不是「耗时为 0」—— 前端必须区分这两者,
    /// 否则本次改动之前写入的全部历史都会显示成「小于 1 秒」。
    #[serde(rename = "durationMs", default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<i64>,
}

/// 查询筛选条件。缺省字段 = 该维度不筛。
#[derive(Debug, Clone, Default)]
pub struct HistoryFilter {
    pub direction: Option<String>,
    pub device_id: Option<String>,
    pub action: Option<String>,
    pub query: Option<String>,
}

impl HistoryFilter {
    pub fn is_empty(&self) -> bool {
        self.direction.is_none()
            && self.device_id.is_none()
            && self.action.is_none()
            && self.query.is_none()
    }

    fn matches(&self, event: &SyncEvent) -> bool {
        if let Some(direction) = &self.direction {
            if &event.direction != direction {
                return false;
            }
        }
        if let Some(device_id) = &self.device_id {
            if event.device_id.as_deref() != Some(device_id.as_str()) {
                return false;
            }
        }
        if let Some(action) = &self.action {
            if &event.action != action {
                return false;
            }
        }
        if let Some(query) = &self.query {
            if !event.path.to_lowercase().contains(&query.to_lowercase()) {
                return false;
            }
        }
        true
    }
}

/// 一次历史查询的完整结果。
#[derive(Debug, Clone, Serialize)]
pub struct HistoryResult {
    /// 命中筛选、按 limit 截断后的事件,倒序(最新在前)。
    pub events: Vec<SyncEvent>,
    /// 保留窗口内的全部记录条数(筛选前)。
    pub total: usize,
    /// 命中筛选条件的条数(截断前)。
    pub matched: usize,
    /// 保留窗口内最早一条记录的时间戳;无记录为 null。
    #[serde(rename = "oldestTs")]
    pub oldest_ts: Option<i64>,
    /// 保留上限。
    #[serde(rename = "maxRetention")]
    pub max_retention: usize,
}

/// 全局时间线的一条:事件 + 所属目录的展示路径(聚合层补,不落盘)。
#[derive(Debug, Clone, Serialize)]
pub struct GlobalHistoryEntry {
    #[serde(flatten)]
    pub event: SyncEvent,
    #[serde(rename = "folderPath")]
    pub folder_path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GlobalHistoryResult {
    pub events: Vec<GlobalHistoryEntry>,
    pub total: usize,
    pub matched: usize,
    #[serde(rename = "oldestTs")]
    pub oldest_ts: Option<i64>,
    #[serde(rename = "maxRetention")]
    pub max_retention: usize,
}

/// 历史存储。持有 config 路径与保留上限。
#[derive(Debug, Clone)]
pub struct HistoryStore {
    config_path: PathBuf,
    max_events: usize,
}

impl HistoryStore {
    pub fn new(config_path: impl Into<PathBuf>, max_events: Option<u64>) -> Self {
        Self {
            config_path: config_path.into(),
            max_events: max_events
                .map(|n| n.max(1) as usize)
                .unwrap_or(DEFAULT_MAX_EVENTS),
        }
    }

    pub fn max_events(&self) -> usize {
        self.max_events
    }

    /// 目录 ID 转义成文件名安全的形式:非 `[A-Za-z0-9._-]` 一律换成 `_`。
    pub fn file_for(&self, folder_id: &str) -> PathBuf {
        let dir = self
            .config_path
            .parent()
            .unwrap_or(Path::new("."))
            .join("history");
        let safe: String = folder_id
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        dir.join(format!("{safe}.jsonl"))
    }

    /// 读全部事件(截断到保留上限)。损坏行逐行跳过,不整份失败 ——
    /// 一份被截断的 JSONL 不该让历史页面永远空白。
    fn read_all(&self, folder_id: &str) -> Vec<SyncEvent> {
        let file = self.file_for(folder_id);
        let Ok(raw) = std::fs::read_to_string(&file) else {
            return Vec::new();
        };
        let mut events: Vec<SyncEvent> = raw
            .lines()
            .filter(|line| !line.trim().is_empty())
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect();
        if events.len() > self.max_events {
            events.drain(..events.len() - self.max_events);
        }
        events
    }

    /// 追加一条记录。超出保留上限时整文件轮转(与 Node 的 flush 口径一致)。
    pub fn record(&self, event: SyncEvent) -> std::io::Result<()> {
        let file = self.file_for(&event.folder_id);
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let line = serde_json::to_string(&event)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;

        // 先看现有行数:只有超限才需要整份重写,否则 O_APPEND 追加。
        let existing = std::fs::read_to_string(&file).map(|s| s.lines().count()).unwrap_or(0);
        if existing < self.max_events {
            use std::io::Write;
            let mut handle = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&file)?;
            writeln!(handle, "{line}")?;
            return Ok(());
        }
        // 轮转:读全量 → 截尾 → 整文件重写
        let mut events = self.read_all(&event.folder_id);
        events.push(event);
        if events.len() > self.max_events {
            events.drain(..events.len() - self.max_events);
        }
        let body: String = events
            .iter()
            .filter_map(|e| serde_json::to_string(e).ok())
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(&file, if body.is_empty() { String::new() } else { body + "\n" })
    }

    /// 查询某目录的历史。
    pub fn query(&self, folder_id: &str, limit: usize, filter: &HistoryFilter) -> HistoryResult {
        let all = self.read_all(folder_id);
        let matched: Vec<&SyncEvent> = if filter.is_empty() {
            all.iter().collect()
        } else {
            all.iter().filter(|e| filter.matches(e)).collect()
        };
        let start = matched.len().saturating_sub(limit);
        let events: Vec<SyncEvent> = matched[start..].iter().rev().map(|e| (*e).clone()).collect();
        HistoryResult {
            events,
            total: all.len(),
            matched: matched.len(),
            oldest_ts: all.first().map(|e| e.ts),
            max_retention: self.max_events,
        }
    }

    /// 汇总各目录的历史,按时间归并。
    ///
    /// 每目录各取筛选后的前 `limit` 条再归并 —— 这是正确而非取巧的截断:
    /// 某条事件若要进入全局前 limit,它在自己目录里必然也位于前 limit。
    pub fn query_global(
        &self,
        folders: &[(String, String)],
        limit: usize,
        filter: &HistoryFilter,
    ) -> GlobalHistoryResult {
        let mut total = 0;
        let mut matched = 0;
        let mut oldest_ts: Option<i64> = None;
        let mut merged: Vec<GlobalHistoryEntry> = Vec::new();
        for (folder_id, folder_path) in folders {
            let result = self.query(folder_id, limit, filter);
            total += result.total;
            matched += result.matched;
            if let Some(ts) = result.oldest_ts {
                oldest_ts = Some(oldest_ts.map_or(ts, |current: i64| current.min(ts)));
            }
            for event in result.events {
                merged.push(GlobalHistoryEntry {
                    event,
                    folder_path: folder_path.clone(),
                });
            }
        }
        // 时间倒序;同 ts 时按路径稳定排序,避免刷新顺序抖动
        merged.sort_by(|a, b| {
            b.event
                .ts
                .cmp(&a.event.ts)
                .then_with(|| a.event.path.cmp(&b.event.path))
        });
        merged.truncate(limit);
        GlobalHistoryResult {
            events: merged,
            total,
            matched,
            oldest_ts,
            max_retention: self.max_events,
        }
    }

    /// 清空某目录的历史:截断文件。
    pub fn clear(&self, folder_id: &str) -> std::io::Result<()> {
        let file = self.file_for(folder_id);
        if file.exists() {
            std::fs::write(&file, "")?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "syncx-api-history-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("config.json")
    }

    fn event(folder: &str, path: &str, ts: i64, direction: &str) -> SyncEvent {
        SyncEvent {
            ts,
            folder_id: folder.to_string(),
            path: path.to_string(),
            action: ACTION_UPDATE.to_string(),
            direction: direction.to_string(),
            device_id: (direction == DIRECTION_REMOTE).then(|| "dev-1".to_string()),
            duration_ms: None,
        }
    }

    #[test]
    fn escaped_filename_and_roundtrip() {
        let store = HistoryStore::new(temp_file(), None);
        let folder = "/Users/a/我的 目录";
        let file = store.file_for(folder);
        let name = file.file_name().unwrap().to_string_lossy().to_string();
        assert!(!name.contains('/'), "目录 id 里的分隔符必须被转义:{name}");
        assert!(name.ends_with(".jsonl"));
        store.record(event(folder, "a.txt", 10, DIRECTION_LOCAL)).unwrap();
        let result = store.query(folder, 200, &HistoryFilter::default());
        assert_eq!(result.total, 1);
        assert_eq!(result.events[0].path, "a.txt");
        assert_eq!(result.oldest_ts, Some(10));
        let _ = std::fs::remove_file(file);
    }

    #[test]
    fn query_is_reversed_and_limited() {
        let store = HistoryStore::new(temp_file(), None);
        for i in 0..5 {
            store.record(event("f", &format!("{i}.txt"), i, DIRECTION_LOCAL)).unwrap();
        }
        let result = store.query("f", 2, &HistoryFilter::default());
        assert_eq!(result.events.len(), 2);
        assert_eq!(result.events[0].ts, 4, "最新在最前");
        assert_eq!(result.matched, 5);
    }

    #[test]
    fn filter_dimensions() {
        let store = HistoryStore::new(temp_file(), None);
        store.record(event("f", "doc/report.txt", 1, DIRECTION_LOCAL)).unwrap();
        store.record(event("f", "doc/other.md", 2, DIRECTION_REMOTE)).unwrap();

        let by_direction = store.query(
            "f",
            200,
            &HistoryFilter {
                direction: Some(DIRECTION_REMOTE.to_string()),
                ..Default::default()
            },
        );
        assert_eq!(by_direction.matched, 1);
        assert_eq!(by_direction.events[0].path, "doc/other.md");

        // 路径关键词不区分大小写
        let by_query = store.query(
            "f",
            200,
            &HistoryFilter {
                query: Some("REPORT".to_string()),
                ..Default::default()
            },
        );
        assert_eq!(by_query.matched, 1);
    }

    #[test]
    fn retention_rotates_file() {
        let store = HistoryStore::new(temp_file(), Some(3));
        for i in 0..6 {
            store.record(event("f", &format!("{i}.txt"), i, DIRECTION_LOCAL)).unwrap();
        }
        let result = store.query("f", 100, &HistoryFilter::default());
        assert_eq!(result.total, 3, "超过上限后只保留最近 3 条");
        assert_eq!(result.events[0].ts, 5);
        assert_eq!(result.max_retention, 3);
    }

    #[test]
    fn global_merge_orders_by_time() {
        let store = HistoryStore::new(temp_file(), None);
        store.record(event("a", "a1", 1, DIRECTION_LOCAL)).unwrap();
        store.record(event("a", "a2", 5, DIRECTION_LOCAL)).unwrap();
        store.record(event("b", "b1", 3, DIRECTION_LOCAL)).unwrap();
        let folders = vec![
            ("a".to_string(), "/root/a".to_string()),
            ("b".to_string(), "/root/b".to_string()),
        ];
        let result = store.query_global(&folders, 2, &HistoryFilter::default());
        assert_eq!(result.total, 3);
        assert_eq!(result.events.len(), 2);
        assert_eq!(result.events[0].event.path, "a2");
        assert_eq!(result.events[1].event.path, "b1");
        assert_eq!(result.events[1].folder_path, "/root/b");
    }

    #[test]
    fn corrupted_line_is_skipped() {
        let store = HistoryStore::new(temp_file(), None);
        store.record(event("f", "ok.txt", 1, DIRECTION_LOCAL)).unwrap();
        let file = store.file_for("f");
        let mut raw = std::fs::read_to_string(&file).unwrap();
        raw.push_str("{not json\n");
        std::fs::write(&file, raw).unwrap();
        let result = store.query("f", 100, &HistoryFilter::default());
        assert_eq!(result.total, 1, "坏行被跳过,好行仍然可读");
    }
}
