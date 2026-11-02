//! 索引库:与 Node 侧 `src/indexstore.ts` **同一个 schema**、同一种序列化。
//!
//! 两个后端共用同一个 `index.db`,任何一处不同都会表现为「另一端读不出条目」——
//! 而那种症状是「同步突然什么都不传了」,不是报错。所以这里逐列照抄:
//!
//! | 列 | 类型 | 序列化 |
//! |---|---|---|
//! | `path` | TEXT | 相对路径(`/` 分隔) |
//! | `version` | TEXT | `[[deviceId, count], ...]` —— JS `Map` 的 JSON 形态 |
//! | `size` | INTEGER | |
//! | `deleted` | INTEGER | 0/1 |
//! | `blocks` | TEXT | JSON 字符串数组 |
//! | `mtime` | INTEGER | 毫秒;0 / NULL 表示无 |
//! | `placeholder` | INTEGER | 0/1 |
//! | `cdh` / `clens` | TEXT | JSON 数组;空串 = 无 CDC 视图 |
//!
//! `busy_timeout = 5000` 同样照抄:同一个库会被多个进程打开(Node daemon 做同步、
//! `syncx status` 读统计、测试在 daemon 存活时断言),拿写锁时对方正在提交的话,
//! 默认 `busy_timeout = 0` 会立刻 `SQLITE_BUSY`,表现为随机的「database is locked」。

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use syncx_core::version::VersionVector;

use crate::entry::StoredEntry;

/// 条目/墓碑计数(状态接口下发的统计口径)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct IndexCounts {
    pub entries: u64,
    pub tombstones: u64,
}

/// 索引库错误。
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("索引库错误:{0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("索引库数据损坏:{0}")]
    Corrupt(String),
}

/// 索引库:`Connection` 不是 `Send`,故整个对象由调用方固定在单个 task 内使用
/// (daemon 里是 `spawn_blocking` 池的一个专属线程,见 `store::IndexStoreHandle`)。
pub struct IndexStore {
    db: Connection,
}

impl IndexStore {
    /// 打开(或创建)索引库并确保 schema 就绪。
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        let db = Connection::open(path)?;
        Self::from_connection(db)
    }

    /// 内存库(测试用)。
    pub fn open_in_memory() -> Result<Self, StoreError> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(db: Connection) -> Result<Self, StoreError> {
        // 与 Node 同值:亚毫秒级的写窗口,5s 足够覆盖,真死锁也不会无限挂起。
        db.execute_batch("PRAGMA busy_timeout = 5000")?;
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS entries (
               path TEXT PRIMARY KEY,
               version TEXT NOT NULL,
               size INTEGER NOT NULL,
               deleted INTEGER NOT NULL,
               blocks TEXT NOT NULL
             );",
        )?;
        // 四个后加列:旧库安全追加,已存在则忽略。只看 duplicate column ——
        // 只读库、锁、schema 损坏必须向上抛,否则会带着坏 schema 继续跑、保存时才炸。
        for ddl in [
            "ALTER TABLE entries ADD COLUMN mtime INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE entries ADD COLUMN placeholder INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE entries ADD COLUMN cdh TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE entries ADD COLUMN clens TEXT NOT NULL DEFAULT ''",
        ] {
            if let Err(error) = db.execute_batch(ddl) {
                if !error.to_string().contains("duplicate column name") {
                    return Err(StoreError::Sqlite(error));
                }
            }
        }
        Ok(Self { db })
    }

    /// 写入(或覆盖)一条条目。与 Node 的 `INSERT OR REPLACE` 同义。
    pub fn save_entry(&self, entry: &StoredEntry) -> Result<(), StoreError> {
        self.db.execute(
            "INSERT OR REPLACE INTO entries
               (path, version, size, deleted, blocks, mtime, placeholder, cdh, clens)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                entry.path,
                serialize_version(&entry.version),
                entry.size as i64,
                if entry.deleted { 1 } else { 0 },
                serde_json::to_string(&entry.blocks)
                    .map_err(|e| StoreError::Corrupt(e.to_string()))?,
                entry.mtime.unwrap_or(0),
                if entry.placeholder { 1 } else { 0 },
                entry
                    .cdh
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()
                    .map_err(|e| StoreError::Corrupt(e.to_string()))?
                    .unwrap_or_default(),
                entry
                    .clens
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()
                    .map_err(|e| StoreError::Corrupt(e.to_string()))?
                    .unwrap_or_default(),
            ],
        )?;
        Ok(())
    }

    /// 批量写入,**单事务提交**。
    ///
    /// 逐条 `save_entry` 是逐条 autocommit,每条一次 fsync;两千条就是两千次,
    /// 在 CI / 机械盘上能拖到十秒级。种子导入、全量重建这类场景必须走这里。
    pub fn save_entries(&mut self, entries: &[StoredEntry]) -> Result<(), StoreError> {
        let tx = self.db.transaction()?;
        for entry in entries {
            tx.execute(
                "INSERT OR REPLACE INTO entries
                   (path, version, size, deleted, blocks, mtime, placeholder, cdh, clens)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    entry.path,
                    serialize_version(&entry.version),
                    entry.size as i64,
                    if entry.deleted { 1 } else { 0 },
                    serde_json::to_string(&entry.blocks)
                        .map_err(|e| StoreError::Corrupt(e.to_string()))?,
                    entry.mtime.unwrap_or(0),
                    if entry.placeholder { 1 } else { 0 },
                    entry
                        .cdh
                        .as_ref()
                        .map(serde_json::to_string)
                        .transpose()
                        .map_err(|e| StoreError::Corrupt(e.to_string()))?
                        .unwrap_or_default(),
                    entry
                        .clens
                        .as_ref()
                        .map(serde_json::to_string)
                        .transpose()
                        .map_err(|e| StoreError::Corrupt(e.to_string()))?
                        .unwrap_or_default(),
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn get_entry(&self, path: &str) -> Result<Option<StoredEntry>, StoreError> {
        let row = self
            .db
            .query_row(
                "SELECT path, version, size, deleted, blocks, mtime, placeholder, cdh, clens
                   FROM entries WHERE path = ?1",
                params![path],
                row_to_entry,
            )
            .optional()?;
        row.transpose()
    }

    pub fn list_entries(&self) -> Result<Vec<StoredEntry>, StoreError> {
        let mut statement = self.db.prepare(
            "SELECT path, version, size, deleted, blocks, mtime, placeholder, cdh, clens
               FROM entries",
        )?;
        let rows = statement.query_map([], row_to_entry)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row??);
        }
        Ok(out)
    }

    /// 条目/墓碑计数。两条 `COUNT(*)` 聚合,不把全表拉进内存 —— 状态接口与被推送的
    /// 每一帧都要用它,而 `list_entries()` 是「全表 SELECT + 逐行反序列化」。
    pub fn count_entries(&self) -> Result<IndexCounts, StoreError> {
        let entries: i64 =
            self.db
                .query_row("SELECT COUNT(*) FROM entries WHERE deleted = 0", [], |r| {
                    r.get(0)
                })?;
        let tombstones: i64 =
            self.db
                .query_row("SELECT COUNT(*) FROM entries WHERE deleted = 1", [], |r| {
                    r.get(0)
                })?;
        Ok(IndexCounts {
            entries: entries.max(0) as u64,
            tombstones: tombstones.max(0) as u64,
        })
    }

    pub fn remove_entry(&self, path: &str) -> Result<(), StoreError> {
        self.db
            .execute("DELETE FROM entries WHERE path = ?1", params![path])?;
        Ok(())
    }
}

/// 版本向量序列化成 JS `Map` 的线上形态:`[[deviceId, count], ...]`。
///
/// 绝不能写成对象 —— Node 侧的反序列化是 `new Map(JSON.parse(raw))`,
/// 拿到对象会静默构造出空 Map,症状是「版本号全丢」,所有文件立刻互为并发。
fn serialize_version(version: &VersionVector) -> String {
    let pairs: Vec<(&String, &u64)> = version.iter().collect();
    serde_json::to_string(&pairs).expect("版本向量只含字符串与整数,必然可序列化")
}

fn deserialize_version(raw: &str) -> Result<VersionVector, StoreError> {
    let pairs: Vec<(String, u64)> =
        serde_json::from_str(raw).map_err(|e| StoreError::Corrupt(format!("version: {e}")))?;
    Ok(pairs.into_iter().collect())
}

/// 一行 → 条目。错误双层:外层是 SQLite 的行错,内层是坏数据。
fn row_to_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<Result<StoredEntry, StoreError>> {
    let version_raw: String = row.get(1)?;
    let blocks_raw: String = row.get(4)?;
    let mtime: i64 = row.get(5)?;
    let placeholder: i64 = row.get(6)?;
    let cdh_raw: String = row.get(7)?;
    let clens_raw: String = row.get(8)?;

    let parsed = (|| -> Result<StoredEntry, StoreError> {
        // cdh/clens:空串 = 无 CDC 视图(旧库行 DEFAULT ''、旧条目未写)。非法 JSON
        // (库被写坏)按无视图处理 —— CDC 只是加速视图,丢了最多退化成定长块传输。
        let cdc = if cdh_raw.is_empty() || clens_raw.is_empty() {
            None
        } else {
            serde_json::from_str::<Vec<String>>(&cdh_raw)
                .ok()
                .zip(serde_json::from_str::<Vec<u64>>(&clens_raw).ok())
                // 等长且非空才有视图,与 rowToEntry 同口径
                .filter(|(h, l)| !h.is_empty() && h.len() == l.len())
        };

        Ok(StoredEntry {
            path: row.get(0).map_err(|e| StoreError::Corrupt(e.to_string()))?,
            version: deserialize_version(&version_raw)?,
            size: row.get::<_, i64>(2).map_err(|e| StoreError::Corrupt(e.to_string()))? as u64,
            deleted: row.get::<_, i64>(3).map_err(|e| StoreError::Corrupt(e.to_string()))? == 1,
            blocks: serde_json::from_str(&blocks_raw)
                .map_err(|e| StoreError::Corrupt(format!("blocks: {e}")))?,
            cdh: cdc.as_ref().map(|(h, _)| h.clone()),
            clens: cdc.map(|(_, l)| l),
            // 0 / NULL 都是「没有 mtime」(旧库 DEFAULT 0、旧条目未写)
            mtime: if mtime == 0 { None } else { Some(mtime) },
            placeholder: placeholder == 1,
        })
    })();
    Ok(parsed)
}
