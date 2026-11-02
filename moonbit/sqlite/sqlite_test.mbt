///|
// 黑盒测试:固定库文件 + DROP IF EXISTS 保证幂等,不依赖文件系统 API。
test "open/exec/prepare 基本闭环" {
  let path = "/tmp/syncx-sqlite-test.db"
  let db = @sqlite.open(path)
  db.exec("DROP TABLE IF EXISTS t")
  db.exec(
    "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, size INTEGER, blob BLOB)",
  )
  // prepared + 参数绑定 + 逐行读回
  let stmt = db.prepare("INSERT INTO t (name, size, blob) VALUES (?, ?, ?)")
  stmt.bind_text(1, "hello 同步")
  stmt.bind_int(2, 42)
  stmt.bind_blob(3, b"\x01\x02\x00\xFF")
  let r = stmt.step()
  // INSERT 无结果集,step 返回 Done
  assert_eq(r, Done)
  stmt.finalize()
  assert_eq(db.changes(), 1L)
  let sel = db.prepare("SELECT id, name, size, blob FROM t")
  match sel.step() {
    Row => {
      assert_eq(sel.column_int(0), 1L)
      assert_eq(sel.column_text(1), "hello 同步")
      assert_eq(sel.column_int(2), 42L)
      let blob = sel.column_blob(3)
      assert_eq(blob.length(), 4)
      assert_eq(blob[3], 0xFF)
    }
    Done => abort("应该有一行")
  }
  match sel.step() {
    Done => () // 到头了
    Row => abort("只有一行")
  }
  sel.finalize()
  db.close()
}

///|
test "错误路径:语法错误与错误消息" {
  let db = @sqlite.open("/tmp/syncx-sqlite-err.db")
  // 语法错误 → 抛 ExecFailed
  let syntax_failed = try {
    db.exec("THIS IS NOT SQL")
    false
  } catch {
    ExecFailed(_) => true
    _ => false
  }
  assert_eq(syntax_failed, true)
  // 不存在的表 → 抛 PrepareFailed
  let table_failed = try {
    let stmt = db.prepare("SELECT * FROM no_such_table_xyz")
    stmt.finalize()
    false
  } catch {
    PrepareFailed(_) => true
    _ => false
  }
  assert_eq(table_failed, true)
  db.close()
}
