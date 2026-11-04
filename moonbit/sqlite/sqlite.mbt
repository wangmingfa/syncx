/// sqlite3 C FFI 绑定(ADR-0026 §2):三端共享同一套 index-*.db,
/// 行为必须与 Node(node:sqlite)/ Rust(rusqlite)完全一致。
///
/// 文本与二进制在 FFI 边界一律走 Bytes + 显式长度(String 先 @utf8.encode);
/// 错误信息从 c_sqlite3_errmsg 取回再 decode。

///|
#borrow(path)
extern "C" fn c_open(path : Bytes, len : Int32) -> Int64 = "c_sqlite3_open"

///|
extern "C" fn c_errmsg(db : Int64) -> Bytes = "c_sqlite3_errmsg"

///|
#borrow(sql)
extern "C" fn c_exec(db : Int64, sql : Bytes, len : Int32) -> Int32 = "c_sqlite3_exec"

///|
#borrow(sql)
extern "C" fn c_prepare(db : Int64, sql : Bytes, len : Int32) -> Int64 = "c_sqlite3_prepare"

///|
extern "C" fn c_bind_int64(stmt : Int64, idx : Int32, v : Int64) -> Int32 = "c_sqlite3_bind_int64"

///|
extern "C" fn c_bind_double(stmt : Int64, idx : Int32, v : Double) -> Int32 = "c_sqlite3_bind_double"

///|
#borrow(p)
extern "C" fn c_bind_text(
  stmt : Int64,
  idx : Int32,
  p : Bytes,
  len : Int32,
) -> Int32 = "c_sqlite3_bind_text"

///|
#borrow(p)
extern "C" fn c_bind_blob(
  stmt : Int64,
  idx : Int32,
  p : Bytes,
  len : Int32,
) -> Int32 = "c_sqlite3_bind_blob"

///|
extern "C" fn c_bind_null(stmt : Int64, idx : Int32) -> Int32 = "c_sqlite3_bind_null"

///|
extern "C" fn c_step(stmt : Int64) -> Int32 = "c_sqlite3_step"

///|
extern "C" fn c_reset(stmt : Int64) -> Int32 = "c_sqlite3_reset"

///|
extern "C" fn c_finalize(stmt : Int64) -> Unit = "c_sqlite3_finalize"

///|
extern "C" fn c_close(db : Int64) -> Unit = "c_sqlite3_close"

///|
extern "C" fn c_column_count(stmt : Int64) -> Int32 = "c_sqlite3_column_count"

///|
extern "C" fn c_column_type(stmt : Int64, col : Int32) -> Int32 = "c_sqlite3_column_type"

///|
extern "C" fn c_column_int64(stmt : Int64, col : Int32) -> Int64 = "c_sqlite3_column_int64"

///|
extern "C" fn c_column_double(stmt : Int64, col : Int32) -> Double = "c_sqlite3_column_double"

///|
extern "C" fn c_column_text(stmt : Int64, col : Int32) -> Bytes = "c_sqlite3_column_text"

///|
extern "C" fn c_column_blob(stmt : Int64, col : Int32) -> Bytes = "c_sqlite3_column_blob"

///|
extern "C" fn c_changes(db : Int64) -> Int64 = "c_sqlite3_changes"

///|
extern "C" fn c_last_insert_rowid(db : Int64) -> Int64 = "c_sqlite3_last_insert_rowid"

// sqlite3 常量(step 返回值与列类型)

///|
const SQLITE_OK : Int32 = 0

///|
const SQLITE_ROW : Int32 = 100

///|
const SQLITE_DONE : Int32 = 101

///|
const SQLITE_NULL : Int32 = 5

///|
pub(all) suberror SqliteError {
  OpenFailed(String)
  ExecFailed(String)
  PrepareFailed(String)
  StepFailed(String)
  BindFailed(String)
}

///|
fn errmsg(db : Int64) -> String {
  @utf8.decode(c_errmsg(db)) catch {
    _ => "sqlite error (undecodable message)"
  }
}

///|
/// 打开的数据库连接;close 之后句柄置 0,所有方法变 no-op(防 use-after-close)。
pub(all) struct Db {
  // pub(all) 暴露字段给跨包构造;外部约定只通过方法访问
  mut handle : Int64
}

///|
/// 打开(必要时创建)数据库文件。
pub fn open(path : String) -> Db raise SqliteError {
  let bytes = @utf8.encode(path)
  let h = c_open(bytes, bytes.length())
  if h == 0 {
    raise OpenFailed("无法打开数据库: \{path}")
  }
  { handle: h, }
}

///|
/// 执行无结果集 SQL(可多条);失败时错误消息来自 sqlite3_errmsg。
pub fn Db::exec(self : Db, sql : String) -> Unit raise SqliteError {
  if self.handle == 0 {
    return
  }
  let bytes = @utf8.encode(sql)
  if c_exec(self.handle, bytes, bytes.length()) != SQLITE_OK {
    raise ExecFailed(errmsg(self.handle))
  }
}

///|
/// 预编译语句。遍历完自动 reset(见 step),重复 finalize 是安全的 no-op。
pub fn Db::prepare(self : Db, sql : String) -> Stmt raise SqliteError {
  if self.handle == 0 {
    raise PrepareFailed("数据库已关闭")
  }
  let bytes = @utf8.encode(sql)
  let h = c_prepare(self.handle, bytes, bytes.length())
  if h == 0 {
    raise PrepareFailed(errmsg(self.handle))
  }
  { handle: h, db: self.handle, }
}

///|
pub fn Db::changes(self : Db) -> Int64 {
  if self.handle == 0 {
    return 0L
  }
  c_changes(self.handle)
}

///|
pub fn Db::last_insert_rowid(self : Db) -> Int64 {
  if self.handle == 0 {
    return 0L
  }
  c_last_insert_rowid(self.handle)
}

///|
pub fn Db::close(self : Db) -> Unit {
  if self.handle != 0 {
    c_close(self.handle)
    self.handle = 0
  }
}

///|
pub(all) struct Stmt {
  mut handle : Int64
  // 保留 db 句柄用于错误消息;close 顺序由调用方保证
  db : Int64
}

///|
pub fn Stmt::bind_int(
  self : Stmt,
  idx : Int32,
  v : Int64,
) -> Unit raise SqliteError {
  if c_bind_int64(self.handle, idx, v) != SQLITE_OK {
    raise BindFailed(errmsg(self.db))
  }
}

///|
pub fn Stmt::bind_double(
  self : Stmt,
  idx : Int32,
  v : Double,
) -> Unit raise SqliteError {
  if c_bind_double(self.handle, idx, v) != SQLITE_OK {
    raise BindFailed(errmsg(self.db))
  }
}

///|
pub fn Stmt::bind_text(
  self : Stmt,
  idx : Int32,
  v : String,
) -> Unit raise SqliteError {
  let bytes = @utf8.encode(v)
  if c_bind_text(self.handle, idx, bytes, bytes.length()) != SQLITE_OK {
    raise BindFailed(errmsg(self.db))
  }
}

///|
pub fn Stmt::bind_blob(
  self : Stmt,
  idx : Int32,
  v : Bytes,
) -> Unit raise SqliteError {
  if c_bind_blob(self.handle, idx, v, v.length()) != SQLITE_OK {
    raise BindFailed(errmsg(self.db))
  }
}

///|
pub fn Stmt::bind_null(self : Stmt, idx : Int32) -> Unit raise SqliteError {
  if c_bind_null(self.handle, idx) != SQLITE_OK {
    raise BindFailed(errmsg(self.db))
  }
}

///|
/// step 的两种结局。
#derive(Eq, Debug)
pub(all) enum StepResult {
  Row
  Done
}

///|
/// 显式方法提升(消除 implicit_impl_as_method 警告)
pub extend StepResult with Eq::{equal, not_equal}

///|
pub extend StepResult with @moonbitlang/core/debug.Debug::{to_repr}

///|
/// 单步执行。Row = 当前行可读;Done = 遍历结束(内部已 reset,语句可复用)。
pub fn Stmt::step(self : Stmt) -> StepResult raise SqliteError {
  match c_step(self.handle) {
    r if r == SQLITE_ROW => Row
    r if r == SQLITE_DONE => {
      // 遍历完自动 reset,方便同一条语句重复跑(与 rusqlite 复用习惯一致)
      let _ = c_reset(self.handle)
      Done
    }
    _ => raise StepFailed(errmsg(self.db))
  }
}

///|
pub fn Stmt::column_count(self : Stmt) -> Int32 {
  c_column_count(self.handle)
}

///|
pub fn Stmt::column_is_null(self : Stmt, col : Int32) -> Bool {
  c_column_type(self.handle, col) == SQLITE_NULL
}

///|
pub fn Stmt::column_int(self : Stmt, col : Int32) -> Int64 {
  c_column_int64(self.handle, col)
}

///|
pub fn Stmt::column_double(self : Stmt, col : Int32) -> Double {
  c_column_double(self.handle, col)
}

///|
pub fn Stmt::column_text(self : Stmt, col : Int32) -> String {
  @utf8.decode(c_column_text(self.handle, col)) catch {
    _ => ""
  }
}

///|
pub fn Stmt::column_blob(self : Stmt, col : Int32) -> Bytes {
  c_column_blob(self.handle, col)
}

///|
pub fn Stmt::finalize(self : Stmt) -> Unit {
  if self.handle != 0 {
    c_finalize(self.handle)
    self.handle = 0
  }
}
