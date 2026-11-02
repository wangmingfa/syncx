/// 索引库(ADR-0026 §5):与 Node `src/indexstore.ts`、Rust
/// `rust/crates/syncx-daemon/src/indexstore.rs` 共用同一套 `index-*.db`,
/// schema 与序列化逐列照抄。任何一处不同都会表现为「另一端读不出条目」——
/// 而那种症状是「同步突然什么都不传了」,不是报错。
///
/// | 列 | 类型 | 序列化 |
/// |---|---|---|
/// | `path` | TEXT | 相对路径(`/` 分隔) |
/// | `version` | TEXT | `[[deviceId, count], ...]` —— JS `Map` 的 JSON 形态 |
/// | `size` | INTEGER | |
/// | `deleted` | INTEGER | 0/1 |
/// | `blocks` | TEXT | JSON 字符串数组 |
/// | `mtime` | INTEGER | 毫秒;0 / NULL 表示无 |
/// | `placeholder` | INTEGER | 0/1 |
/// | `cdh` / `clens` | TEXT | JSON 数组;空串 = 无 CDC 视图 |
///
/// `busy_timeout = 5000` 同样照抄:同一个库会被多个进程同时打开(daemon 做
/// 同步、`syncx status` 读统计、测试在 daemon 存活时断言),拿写锁时若对方
/// 正在提交,默认 `busy_timeout = 0` 会立刻 `SQLITE_BUSY`。

///|
/// 索引里的一条条目(字段对齐 Node `IndexEntry` / Rust `StoredEntry`,
/// 即 entries 表的全部列)。
pub(all) struct Entry {
  path : String
  /// 版本向量:deviceId -> 计数
  version : Map[String, Int64]
  size : Int64
  deleted : Bool
  /// 组成文件内容的定长块的 SHA-256
  blocks : Array[String]
  /// CDC 视图块哈希(与 blocks 并存);None = 无 CDC 视图
  cdh : Array[String]?
  /// CDC 块长度列表(与 cdh 一一对应);None = 无 CDC 视图
  clens : Array[Int64]?
  /// 本地文件修改时间(毫秒);None = 未知(旧库 0 / NULL)
  mtime : Int64?
  /// 按需同步占位条目(仅本机,不进 wire)
  placeholder : Bool
}

///|
/// 条目/墓碑计数(状态接口下发的统计口径)。
pub struct IndexCounts {
  entries : Int64
  tombstones : Int64
}

///|
/// 索引库错误(与 Rust `StoreError` 对应)。
pub(all) suberror IndexStoreError {
  Sqlite(@sqlite.SqliteError)
  Corrupt(String)
}

///|
pub fn IndexStoreError::to_text(self : IndexStoreError) -> String {
  match self {
    Sqlite(e) => "索引库错误: \{sqlite_error_text(e)}"
    Corrupt(msg) => "索引库数据损坏: \{msg}"
  }
}

///|
/// SqliteError 的五个变体都只携带消息字符串,取出来拼日志。
fn sqlite_error_text(e : @sqlite.SqliteError) -> String {
  match e {
    OpenFailed(m) => m
    ExecFailed(m) => m
    PrepareFailed(m) => m
    StepFailed(m) => m
    BindFailed(m) => m
  }
}

///|
/// 把一段只抛 SqliteError 的操作整体包成 IndexStoreError。
/// catch 按体抛类型收窄,五个变体逐一转换;必须穷尽,缺一个就漏抛原错误。
fn[T] wrap_sqlite(
  body : () -> T raise @sqlite.SqliteError,
) -> T raise IndexStoreError {
  body() catch {
    OpenFailed(m) => raise Sqlite(OpenFailed(m))
    ExecFailed(m) => raise Sqlite(ExecFailed(m))
    PrepareFailed(m) => raise Sqlite(PrepareFailed(m))
    StepFailed(m) => raise Sqlite(StepFailed(m))
    BindFailed(m) => raise Sqlite(BindFailed(m))
  }
}

///|
/// 索引库:单连接;跨进程并发靠 `busy_timeout` 兜底(见 open)。
pub struct IndexStore {
  db : @sqlite.Db
}

// ---- SQL:与 Node/Rust 逐字对齐 ----------------------------------------------

///|
const SQL_CREATE_TABLE : String = "CREATE TABLE IF NOT EXISTS entries (\n      path TEXT PRIMARY KEY,\n      version TEXT NOT NULL,\n      size INTEGER NOT NULL,\n      deleted INTEGER NOT NULL,\n      blocks TEXT NOT NULL\n    );"

///|
const SQL_UPSERT : String = "INSERT OR REPLACE INTO entries (path, version, size, deleted, blocks, mtime, placeholder, cdh, clens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"

///|
const SQL_SELECT : String = "SELECT path, version, size, deleted, blocks, mtime, placeholder, cdh, clens FROM entries"

// ---- 打开 / schema ----------------------------------------------------------

///|
/// 打开(或创建)索引库并确保 schema 就绪。
pub fn IndexStore::open(path : String) -> IndexStore raise IndexStoreError {
  let db = wrap_sqlite(() => @sqlite.open(path))
  try {
    // 与 Node/Rust 同值:daemon 单条语句的写窗口是亚毫秒级,5s 足够覆盖,
    // 真死锁也不会无限挂起。
    db.exec("PRAGMA busy_timeout = 5000")
    db.exec(SQL_CREATE_TABLE)
    // 四个后加列:旧库安全追加,已存在则忽略
    add_column_if_absent(
      db, "ALTER TABLE entries ADD COLUMN mtime INTEGER NOT NULL DEFAULT 0",
    )
    add_column_if_absent(
      db, "ALTER TABLE entries ADD COLUMN placeholder INTEGER NOT NULL DEFAULT 0",
    )
    add_column_if_absent(
      db, "ALTER TABLE entries ADD COLUMN cdh TEXT NOT NULL DEFAULT ''",
    )
    add_column_if_absent(
      db, "ALTER TABLE entries ADD COLUMN clens TEXT NOT NULL DEFAULT ''",
    )
    { db, }
  } catch {
    OpenFailed(m) => {
      db.close()
      raise Sqlite(OpenFailed(m))
    }
    ExecFailed(m) => {
      db.close()
      raise Sqlite(ExecFailed(m))
    }
    PrepareFailed(m) => {
      db.close()
      raise Sqlite(PrepareFailed(m))
    }
    StepFailed(m) => {
      db.close()
      raise Sqlite(StepFailed(m))
    }
    BindFailed(m) => {
      db.close()
      raise Sqlite(BindFailed(m))
    }
  }
}

///|
/// 追加一列;仅容忍 duplicate column(旧库已带该列),其它错误
/// (只读库、锁、schema 损坏)必须向上抛,避免带着坏 schema 继续跑、保存时才炸。
fn add_column_if_absent(
  db : @sqlite.Db,
  ddl : String,
) -> Unit raise @sqlite.SqliteError {
  db.exec(ddl) catch {
    ExecFailed(msg) =>
      if msg.contains("duplicate column name") {
        ()
      } else {
        raise ExecFailed(msg)
      }
    OpenFailed(m) => raise OpenFailed(m)
    PrepareFailed(m) => raise PrepareFailed(m)
    StepFailed(m) => raise StepFailed(m)
    BindFailed(m) => raise BindFailed(m)
  }
}

// ---- 写 ---------------------------------------------------------------------

///|
/// 绑定一条条目到 upsert 语句(9 列全量,参数索引 1 起)。
fn bind_entry(
  stmt : @sqlite.Stmt,
  entry : Entry,
) -> Unit raise @sqlite.SqliteError {
  stmt.bind_text(1, entry.path)
  stmt.bind_text(2, serialize_version(entry.version))
  stmt.bind_int(3, entry.size)
  stmt.bind_int(4, if entry.deleted { 1L } else { 0L })
  stmt.bind_text(5, serialize_strings(entry.blocks))
  stmt.bind_int(
    6,
    match entry.mtime {
      Some(ms) => ms
      None => 0L
    },
  )
  stmt.bind_int(7, if entry.placeholder { 1L } else { 0L })
  stmt.bind_text(
    8,
    match entry.cdh {
      Some(items) => serialize_strings(items)
      None => ""
    },
  )
  stmt.bind_text(
    9,
    match entry.clens {
      Some(items) => serialize_lengths(items)
      None => ""
    },
  )
}

///|
/// 写入(或覆盖)一条条目。与 Node/Rust 的 `INSERT OR REPLACE` 同义。
pub fn IndexStore::save_entry(
  self : IndexStore,
  entry : Entry,
) -> Unit raise IndexStoreError {
  wrap_sqlite(() => {
    let stmt = self.db.prepare(SQL_UPSERT)
    bind_entry(stmt, entry)
    let _ = stmt.step()
    stmt.finalize()
  })
}

///|
/// 批量写入,**单事务提交**。逐条 save_entry 是逐条 autocommit —— 每条一次
/// fsync,两千条就是两千次;种子导入、全量重建这类场景必须走这里。
pub fn IndexStore::save_entries(
  self : IndexStore,
  entries : Array[Entry],
) -> Unit raise IndexStoreError {
  // 事务内任何失败:先回滚(回滚失败不影响向上抛原始错误)
  let rollback = () => self.db.exec("ROLLBACK") catch { _ => () }
  try {
    self.db.exec("BEGIN")
    let stmt = self.db.prepare(SQL_UPSERT)
    for entry in entries {
      bind_entry(stmt, entry)
      let _ = stmt.step()
    }
    stmt.finalize()
    self.db.exec("COMMIT")
  } catch {
    OpenFailed(m) => {
      rollback()
      raise Sqlite(OpenFailed(m))
    }
    ExecFailed(m) => {
      rollback()
      raise Sqlite(ExecFailed(m))
    }
    PrepareFailed(m) => {
      rollback()
      raise Sqlite(PrepareFailed(m))
    }
    StepFailed(m) => {
      rollback()
      raise Sqlite(StepFailed(m))
    }
    BindFailed(m) => {
      rollback()
      raise Sqlite(BindFailed(m))
    }
  }
}

// ---- 读 ---------------------------------------------------------------------

///|
/// 一行的原始列值(在只抛 SqliteError 的段落里读出,解析在 try 外做,
/// 避免单条 catch 混抛两种错误类型)。
priv struct RawRow {
  path : String
  version : String
  size : Int64
  deleted : Int64
  blocks : String
  mtime : Int64
  placeholder : Int64
  cdh : String
  clens : String
}

///|
fn read_raw_row(stmt : @sqlite.Stmt) -> RawRow {
  {
    path: stmt.column_text(0),
    version: stmt.column_text(1),
    size: stmt.column_int(2),
    deleted: stmt.column_int(3),
    blocks: stmt.column_text(4),
    // 0 / NULL 都是「没有 mtime」(旧库 DEFAULT 0、旧条目未写)
    mtime: if stmt.column_is_null(5) {
      0L
    } else {
      stmt.column_int(5)
    },
    placeholder: stmt.column_int(6),
    cdh: stmt.column_text(7),
    clens: stmt.column_text(8),
  }
}

///|
/// 读取一条条目;不存在返回 None。
pub fn IndexStore::get_entry(
  self : IndexStore,
  path : String,
) -> Entry? raise IndexStoreError {
  let raw : RawRow? = wrap_sqlite(() => {
    let stmt = self.db.prepare("\{SQL_SELECT} WHERE path = ?")
    stmt.bind_text(1, path)
    let found = match stmt.step() {
      Row => Some(read_raw_row(stmt))
      Done => None
    }
    stmt.finalize()
    found
  })
  match raw {
    Some(row) => Some(raw_row_to_entry(row))
    None => None
  }
}

///|
/// 全表条目(含墓碑)。
pub fn IndexStore::list_entries(
  self : IndexStore,
) -> Array[Entry] raise IndexStoreError {
  let rows : Array[RawRow] = wrap_sqlite(() => {
    let stmt = self.db.prepare(SQL_SELECT)
    let out : Array[RawRow] = []
    while stmt.step() == Row {
      out.push(read_raw_row(stmt))
    }
    stmt.finalize()
    out
  })
  let entries : Array[Entry] = []
  for row in rows {
    entries.push(raw_row_to_entry(row))
  }
  entries
}

///|
/// 条目/墓碑计数。两条 COUNT(*) 聚合,不把全表拉进内存 —— 状态接口与被推送的
/// 每一帧都要用它,而 list_entries 是「全表 SELECT + 逐行反序列化」。
pub fn IndexStore::count_entries(
  self : IndexStore,
) -> IndexCounts raise IndexStoreError {
  let counts = wrap_sqlite(() => {
    (count_where(self, "deleted = 0"), count_where(self, "deleted = 1"))
  })
  { entries: counts.0, tombstones: counts.1, }
}

///|
fn count_where(
  store : IndexStore,
  cond : String,
) -> Int64 raise @sqlite.SqliteError {
  let stmt = store.db.prepare("SELECT COUNT(*) AS n FROM entries WHERE \{cond}")
  let n = match stmt.step() {
    Row => stmt.column_int(0)
    Done => 0L
  }
  stmt.finalize()
  n
}

///|
pub fn IndexStore::remove_entry(
  self : IndexStore,
  path : String,
) -> Unit raise IndexStoreError {
  wrap_sqlite(() => {
    let stmt = self.db.prepare("DELETE FROM entries WHERE path = ?")
    stmt.bind_text(1, path)
    let _ = stmt.step()
    stmt.finalize()
  })
}

///|
pub fn IndexStore::close(self : IndexStore) -> Unit {
  self.db.close()
}

// ---- 行 <-> 条目 -------------------------------------------------------------

///|
/// 原始行 → 条目。坏 version/blocks 抛 Corrupt(与 Rust 一致,Node 侧
/// JSON.parse 同样会抛);坏 CDC 按无视图处理,不让整库读崩。
fn raw_row_to_entry(row : RawRow) -> Entry raise IndexStoreError {
  let cdc = parse_cdc(row.cdh, row.clens)
  {
    path: row.path,
    version: deserialize_version(row.version),
    size: row.size,
    deleted: row.deleted == 1L,
    blocks: deserialize_blocks(row.blocks),
    cdh: cdc.0,
    clens: cdc.1,
    mtime: if row.mtime == 0L {
      None
    } else {
      Some(row.mtime)
    },
    placeholder: row.placeholder == 1L,
  }
}

///|
/// 解析 CDC 视图:等长且非空才算有(与 Node rowToEntry / Rust row_to_entry
/// 同口径);任一环节坏数据都按无视图处理。
fn parse_cdc(
  cdh_raw : String,
  clens_raw : String,
) -> (Array[String]?, Array[Int64]?) {
  if cdh_raw == "" || clens_raw == "" {
    return (None, None)
  }
  let hashes : Array[String] = []
  let lengths : Array[Int64] = []
  try {
    match @json.parse(cdh_raw) {
      Array(items) =>
        for item in items {
          match item {
            String(s) => hashes.push(s)
            _ => return (None, None)
          }
        }
      _ => return (None, None)
    }
    match @json.parse(clens_raw) {
      Array(items) =>
        for item in items {
          match item {
            Number(n, ..) => lengths.push(n.to_int64())
            _ => return (None, None)
          }
        }
      _ => return (None, None)
    }
  } catch {
    _ => return (None, None)
  }
  if hashes.length() > 0 && hashes.length() == lengths.length() {
    (Some(hashes), Some(lengths))
  } else {
    (None, None)
  }
}

// ---- 序列化 -------------------------------------------------------------------

///|
/// 版本向量序列化成 JS `Map` 的线上形态:`[[deviceId, count], ...]`。
/// 绝不能写成对象 —— Node 侧的反序列化是 `new Map(JSON.parse(raw))`,
/// 拿到对象会静默构造出空 Map,症状是「版本号全丢」,所有文件立刻互为并发。
fn serialize_version(version : Map[String, Int64]) -> String {
  let pairs : Array[Json] = []
  for key, value in version {
    pairs.push(
      Json::array([Json::string(key), Json::number(value.to_double())]),
    )
  }
  Json::array(pairs).stringify()
}

///|
/// 逆变换;坏数据抛 Corrupt(与 Rust 一致,Node 侧 JSON.parse 同样会抛)。
fn deserialize_version(
  raw : String,
) -> Map[String, Int64] raise IndexStoreError {
  let parsed = @json.parse(raw) catch {
    _ => raise Corrupt("version: 非法 JSON")
  }
  match parsed {
    Array(items) => {
      let map : Map[String, Int64] = Map([])
      for item in items {
        match item {
          Array(pair) => {
            if pair.length() != 2 {
              raise Corrupt("version: 非二元组")
            }
            match (pair[0], pair[1]) {
              (String(k), Number(n, ..)) => map.set(k, n.to_int64())
              _ => raise Corrupt("version: 组内类型错误")
            }
          }
          _ => raise Corrupt("version: 非二元组")
        }
      }
      map
    }
    _ => raise Corrupt("version: 非数组")
  }
}

///|
/// 字符串数组 → JSON 数组文本(blocks / cdh 共用)。
fn serialize_strings(items : Array[String]) -> String {
  let arr : Array[Json] = []
  for item in items {
    arr.push(Json::string(item))
  }
  Json::array(arr).stringify()
}

///|
/// 整数数组 → JSON 数组文本(clens 用)。
fn serialize_lengths(items : Array[Int64]) -> String {
  let arr : Array[Json] = []
  for item in items {
    arr.push(Json::number(item.to_double()))
  }
  Json::array(arr).stringify()
}

///|
/// blocks 反序列化;坏数据抛 Corrupt(Node 侧 JSON.parse 同样会抛)。
fn deserialize_blocks(raw : String) -> Array[String] raise IndexStoreError {
  let parsed = @json.parse(raw) catch {
    _ => raise Corrupt("blocks: 非法 JSON")
  }
  match parsed {
    Array(items) => {
      let out : Array[String] = []
      for item in items {
        match item {
          String(s) => out.push(s)
          _ => raise Corrupt("blocks: 非字符串元素")
        }
      }
      out
    }
    _ => raise Corrupt("blocks: 非数组")
  }
}
