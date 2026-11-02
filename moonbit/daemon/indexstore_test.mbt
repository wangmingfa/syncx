///|
// 黑盒测试:固定库文件 + DROP IF EXISTS 保证幂等,不依赖文件系统 API。
// 与 Node/Rust 的对拍(golden fixtures)在 ADR-0026 清单第 9 项,这里只验行为闭环。
test "open 建表 + upsert/读回往返" {
  let path = "/tmp/syncx-daemon-indexstore-test.db"
  let db = @sqlite.open(path)
  db.exec("DROP TABLE IF EXISTS entries")
  db.close()
  // 首次 open:建表 + 追加四列
  let store = @daemon.IndexStore::open(path)
  let entry : @daemon.Entry = {
    path: "docs/报告.md",
    version: Map([("dev-a", 3L), ("dev-b", 7L)]),
    size: 12345L,
    deleted: false,
    blocks: ["aa", "bb", "cc"],
    cdh: Some(["h1", "h2"]),
    clens: Some([1048576L, 186000L]),
    mtime: Some(1762000000000L),
    placeholder: true,
  }
  store.save_entry(entry)
  // 二次 open:ALTER 撞 duplicate column 必须被吞掉
  let store2 = @daemon.IndexStore::open(path)
  let back = store2.get_entry("docs/报告.md")
  match back {
    Some(e) => {
      assert_eq(e.path, "docs/报告.md")
      assert_eq(e.version["dev-a"], 3L)
      assert_eq(e.version["dev-b"], 7L)
      assert_eq(e.version.length(), 2)
      assert_eq(e.size, 12345L)
      assert_eq(e.deleted, false)
      assert_eq(e.blocks, ["aa", "bb", "cc"])
      assert_eq(e.cdh, Some(["h1", "h2"]))
      assert_eq(e.clens, Some([1048576L, 186000L]))
      assert_eq(e.mtime, Some(1762000000000L))
      assert_eq(e.placeholder, true)
    }
    None => abort("应该能读回刚写入的条目")
  }
  // 不存在的路径
  match store2.get_entry("no/such/path") {
    None => ()
    Some(_) => abort("不存在的路径应返回 None")
  }
  store.close()
  store2.close()
}

///|
test "墓碑往返 + 计数 + 删除" {
  let path = "/tmp/syncx-daemon-indexstore-tomb.db"
  let db = @sqlite.open(path)
  db.exec("DROP TABLE IF EXISTS entries")
  db.close()
  let store = @daemon.IndexStore::open(path)
  // 活条目:mtime/cdh 缺省(旧条目形态)
  let live : @daemon.Entry = {
    path: "a.txt",
    version: Map([("dev-a", 1L)]),
    size: 100L,
    deleted: false,
    blocks: ["x"],
    cdh: None,
    clens: None,
    mtime: None,
    placeholder: false,
  }
  store.save_entry(live)
  // 墓碑:deleted = true,version 已推进
  let tomb : @daemon.Entry = {
    path: "b.txt",
    version: Map([("dev-a", 2L)]),
    size: 0L,
    deleted: true,
    blocks: [],
    cdh: None,
    clens: None,
    mtime: None,
    placeholder: false,
  }
  store.save_entry(tomb)
  let counts = store.count_entries()
  assert_eq(counts.entries, 1L)
  assert_eq(counts.tombstones, 1L)
  // 墓碑读回:deleted 语义不丢
  match store.get_entry("b.txt") {
    Some(e) => {
      assert_eq(e.deleted, true)
      assert_eq(e.version["dev-a"], 2L)
      assert_eq(e.blocks.length(), 0)
      // mtime 未写 → 0 → None;cdh 未写 → 空串 → None
      assert_eq(e.mtime, None)
      assert_eq(e.cdh, None)
      assert_eq(e.clens, None)
      assert_eq(e.placeholder, false)
    }
    None => abort("墓碑也应该能读回")
  }
  // 覆盖写:同 path 覆盖(INSERT OR REPLACE),不是新增
  let revived : @daemon.Entry = {
    path: "b.txt",
    version: Map([("dev-a", 3L), ("dev-c", 1L)]),
    size: 55L,
    deleted: false,
    blocks: ["y", "z"],
    cdh: None,
    clens: None,
    mtime: Some(42L),
    placeholder: false,
  }
  store.save_entry(revived)
  assert_eq(store.count_entries().entries, 2L)
  assert_eq(store.count_entries().tombstones, 0L)
  // list_entries 全量
  assert_eq(store.list_entries().length(), 2)
  // 删除
  store.remove_entry("a.txt")
  match store.get_entry("a.txt") {
    None => ()
    Some(_) => abort("删除后应读不到")
  }
  assert_eq(store.count_entries().entries, 1L)
  store.close()
}

///|
test "批量写(单事务)" {
  let path = "/tmp/syncx-daemon-indexstore-batch.db"
  let db = @sqlite.open(path)
  db.exec("DROP TABLE IF EXISTS entries")
  db.close()
  let store = @daemon.IndexStore::open(path)
  let entries : Array[@daemon.Entry] = []
  for i in 0..<200 {
    entries.push({
      path: "batch/file-\{i}.txt",
      version: Map([("dev-a", i.to_int64())]),
      size: i.to_int64(),
      deleted: i % 2 == 0,
      blocks: ["b\{i}"],
      cdh: None,
      clens: None,
      mtime: None,
      placeholder: false,
    })
  }
  store.save_entries(entries)
  let counts = store.count_entries()
  assert_eq(counts.entries, 100L)
  assert_eq(counts.tombstones, 100L)
  // 偶数下标是墓碑(deleted = i % 2 == 0),奇数是活条目
  match store.get_entry("batch/file-8.txt") {
    Some(e) => {
      assert_eq(e.deleted, true)
      assert_eq(e.version["dev-a"], 8L)
    }
    None => abort("批量写入的条目应可读回")
  }
  match store.get_entry("batch/file-7.txt") {
    Some(e) => assert_eq(e.deleted, false)
    None => abort("批量写入的条目应可读回")
  }
  store.close()
}

///|
test "坏数据容错:cdh 坏 JSON 按无视图处理,version 坏数据抛 Corrupt" {
  let path = "/tmp/syncx-daemon-indexstore-corrupt.db"
  let db = @sqlite.open(path)
  db.exec("DROP TABLE IF EXISTS entries")
  db.close()
  let store = @daemon.IndexStore::open(path)
  let entry : @daemon.Entry = {
    path: "c.txt",
    version: Map([("dev-a", 1L)]),
    size: 1L,
    deleted: false,
    blocks: ["x"],
    cdh: None,
    clens: None,
    mtime: None,
    placeholder: false,
  }
  store.save_entry(entry)
  // 绕过 Entry 模型直接写坏行:cdh 非法 JSON、clens 为空
  db_insert_raw(
    path, "c-bad-cdc.txt", "[[\"dev-a\",1]]", 1L, 0L, "[\"x\"]", 0L, 0L, "{not json",
    "",
  )
  match store.get_entry("c-bad-cdc.txt") {
    Some(e) => {
      // cdh 坏 → 按无 CDC 视图处理,条目本身仍可读
      assert_eq(e.cdh, None)
      assert_eq(e.clens, None)
      assert_eq(e.path, "c-bad-cdc.txt")
    }
    None => abort("坏 CDC 不应让条目丢失")
  }
  // cdh 与 clens 长度不等 → 无视图
  db_insert_raw(
    path, "c-mismatch.txt", "[[\"dev-a\",1]]", 1L, 0L, "[\"x\"]", 0L, 0L, "[\"h1\",\"h2\"]",
    "[100]",
  )
  match store.get_entry("c-mismatch.txt") {
    Some(e) => {
      assert_eq(e.cdh, None)
      assert_eq(e.clens, None)
    }
    None => abort("长度不匹配不应让条目丢失")
  }
  // version 坏数据 → Corrupt 上抛(与 Rust 一致)
  db_insert_raw(
    path, "c-bad-version.txt", "{not-json", 1L, 0L, "[\"x\"]", 0L, 0L, "", "",
  )
  let corrupt_failed = try {
    let _ = store.get_entry("c-bad-version.txt")
    false
  } catch {
    Corrupt(_) => true
    _ => false
  }
  assert_eq(corrupt_failed, true)
  store.close()
}

///|
/// 直插原始行(绕过 Entry 模型,制造坏数据)。
fn db_insert_raw(
  db_path : String,
  path : String,
  version : String,
  size : Int64,
  deleted : Int64,
  blocks : String,
  mtime : Int64,
  placeholder : Int64,
  cdh : String,
  clens : String,
) -> Unit raise @sqlite.SqliteError {
  let db = @sqlite.open(db_path)
  let stmt = db.prepare(
    "INSERT OR REPLACE INTO entries (path, version, size, deleted, blocks, mtime, placeholder, cdh, clens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
  stmt.bind_text(1, path)
  stmt.bind_text(2, version)
  stmt.bind_int(3, size)
  stmt.bind_int(4, deleted)
  stmt.bind_text(5, blocks)
  stmt.bind_int(6, mtime)
  stmt.bind_int(7, placeholder)
  stmt.bind_text(8, cdh)
  stmt.bind_text(9, clens)
  let _ = stmt.step()
  stmt.finalize()
  db.close()
}
