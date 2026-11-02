///|
/// 扫描器黑盒测试:真实文件系统行为(/tmp 临时目录),不碰用户目录。
/// 与 Rust `scanner.rs` 的对拍(golden fixtures)属 ADR-0026 清单第 9 项,
/// 这里只验行为闭环:新增 / 免哈希跳过 / 内容变化 / 墓碑 / 忽略 / 嵌套根。

///|
/// 建一个本测试专属的临时根目录。
async fn fresh_root(tag : String) -> String {
  let root = "/tmp/syncx-mb-daemon-\{tag}-\{@daemon.now_ms()}"
  @fs.mkdir(root, recursive=true, allow_exist=true)
  root
}

///|
async fn write_file(root : String, rel : String, content : String) -> String {
  let abs = "\{root}/\{rel}"
  let idx = abs.rev_find("/")
  match idx {
    Some(i) => @fs.mkdir(abs[0:i].to_owned(), recursive=true, allow_exist=true)
    None => ()
  }
  @fs.write_file(abs, content, create_mode=CreateOrTruncate)
  abs
}

///|
async fn open_store(root : String) -> @daemon.IndexStore {
  // 库文件放扫描树之外:否则 index.db 自己也会被扫进 changed
  let store_dir = "/tmp/syncx-mb-daemon-store-\{root}"
  @fs.mkdir(store_dir, recursive=true, allow_exist=true)
  let db = @sqlite.open("\{store_dir}/index.db")
  db.exec("DROP TABLE IF EXISTS entries")
  db.close()
  @daemon.IndexStore::open("\{store_dir}/index.db")
}

///|
async test "scan_folder: 首扫全部进 changed,空目录跳过" {
  let root = fresh_root("scan-basic")
  let _ = write_file(root, "a.txt", "hello")
  let _ = write_file(root, "sub/b.txt", "world")
  @fs.mkdir("\{root}/emptydir", recursive=true, allow_exist=true)
  let store = open_store(root)
  let rules = @core.IgnoreRuleset::from_lines([])
  let diff = @daemon.scan_folder(root, store, rules, "dev-a", [])
  assert_eq(diff.changed.length(), 2)
  assert_true(diff.changed.contains("a.txt"))
  assert_true(diff.changed.contains("sub/b.txt"))
  assert_eq(diff.files_seen, 2)
  assert_eq(diff.tombstones.length(), 0)
  assert_eq(diff.conflict_count, 0)
  store.close()
}

///|
async test "scan_folder: 索引未变走免哈希快速路径,内容变了才报 changed" {
  let root = fresh_root("scan-fastpath")
  let a_abs = write_file(root, "a.txt", "hello")
  let store = open_store(root)
  // 把首扫结果写进索引(模拟 apply_send):size + mtime + 块哈希
  let mt = @daemon.mtime_ms(a_abs)
  assert_true(mt is Some(_))
  let stored : @daemon.Entry = {
    path: "a.txt",
    version: Map([("dev-a", 1L)]),
    size: 5L,
    deleted: false,
    blocks: [@core.hash_block(b"hello")],
    cdh: None,
    clens: None,
    mtime: mt,
    placeholder: false,
  }
  store.save_entry(stored)
  let rules = @core.IgnoreRuleset::from_lines([])
  // 第二轮:内容未变 → 免哈希快速路径跳过
  let diff = @daemon.scan_folder(root, store, rules, "dev-a", [])
  assert_eq(diff.changed.length(), 0)
  assert_eq(diff.files_seen, 1)
  // 内容变了 → 报 changed
  let _ = write_file(root, "a.txt", "hello world")
  let diff2 = @daemon.scan_folder(root, store, rules, "dev-a", [])
  assert_eq(diff2.changed, ["a.txt"])
  store.close()
}

///|
async test "scan_folder: 本地删除生成墓碑,版本向量 +1" {
  let root = fresh_root("scan-tombstone")
  let a_abs = write_file(root, "a.txt", "hello")
  let store = open_store(root)
  let stored : @daemon.Entry = {
    path: "a.txt",
    version: Map([("dev-a", 3L), ("dev-b", 2L)]),
    size: 5L,
    deleted: false,
    blocks: [@core.hash_block(b"hello")],
    cdh: None,
    clens: None,
    mtime: @daemon.mtime_ms(a_abs),
    placeholder: false,
  }
  store.save_entry(stored)
  @fs.remove(a_abs)
  let rules = @core.IgnoreRuleset::from_lines([])
  let diff = @daemon.scan_folder(root, store, rules, "dev-a", [])
  assert_eq(diff.tombstones.length(), 1)
  let tomb = diff.tombstones[0]
  assert_eq(tomb.path, "a.txt")
  assert_true(tomb.deleted)
  assert_eq(tomb.size, 0L)
  assert_eq(tomb.blocks.length(), 0)
  // dev-a 递增,dev-b 保留
  assert_eq(tomb.version["dev-a"], 4L)
  assert_eq(tomb.version["dev-b"], 2L)
  store.close()
}

///|
async test "scan_folder: 根不存在时不做墓碑推断" {
  let root = fresh_root("scan-missing")
  let store = open_store(root)
  // 预置一条索引,然后删掉整个目录树
  let stored : @daemon.Entry = {
    path: "a.txt",
    version: Map([("dev-a", 1L)]),
    size: 5L,
    deleted: false,
    blocks: [],
    cdh: None,
    clens: None,
    mtime: None,
    placeholder: false,
  }
  store.save_entry(stored)
  @fs.rmdir(root, recursive=true)
  let rules = @core.IgnoreRuleset::from_lines([])
  let diff = @daemon.scan_folder(root, store, rules, "dev-a", [])
  // 盘上根都没了:宁可漏一轮同步,绝不把整棵索引当已删除
  assert_eq(diff.changed.length(), 0)
  assert_eq(diff.tombstones.length(), 0)
  assert_eq(diff.files_seen, 0)
  store.close()
}

///|
async test "scan_folder: 用户忽略规则命中既不进 changed 也不生成墓碑" {
  let root = fresh_root("scan-ignore")
  let _ = write_file(root, "keep.txt", "keep")
  let _ = write_file(root, "drop.log", "drop")
  let _ = write_file(root, "sub/drop.log", "drop")
  let store = open_store(root)
  // 索引里预先有 drop.log:用户忽略后删除不传播
  let pre : @daemon.Entry = {
    path: "drop.log",
    version: Map([("dev-a", 1L)]),
    size: 4L,
    deleted: false,
    blocks: [],
    cdh: None,
    clens: None,
    mtime: None,
    placeholder: false,
  }
  store.save_entry(pre)
  let rules = @core.IgnoreRuleset::from_lines(["*.log"])
  let diff = @daemon.scan_folder(root, store, rules, "dev-a", [])
  assert_eq(diff.changed, ["keep.txt"])
  @fs.remove("\{root}/drop.log")
  let diff2 = @daemon.scan_folder(root, store, rules, "dev-a", [])
  assert_eq(diff2.tombstones.length(), 0)
  store.close()
}

///|
async test "scan_folder: 硬忽略与冲突副本 —— 不进 changed、不墓碑、副本计数" {
  let root = fresh_root("scan-hard")
  let _ = write_file(root, "ok.txt", "ok")
  let _ = write_file(root, ".git/config", "git")
  let _ = write_file(
    root, "报告.sync-conflict-ab12cd34-PYQAAAAAAE.md", "conflict",
  )
  let store = open_store(root)
  // 历史遗留的 .git 条目(正常不会出现,出现了也绝不墓碑)
  let git_entry : @daemon.Entry = {
    path: ".git/config",
    version: Map([("dev-a", 1L)]),
    size: 3L,
    deleted: false,
    blocks: [],
    cdh: None,
    clens: None,
    mtime: None,
    placeholder: false,
  }
  store.save_entry(git_entry)
  let rules = @core.IgnoreRuleset::from_lines([])
  let diff = @daemon.scan_folder(root, store, rules, "dev-a", [])
  // 冲突副本只计数,不参与同步/索引
  assert_eq(diff.conflict_count, 1)
  assert_eq(diff.changed, ["ok.txt"])
  // .git 条目消失也不生成墓碑
  @fs.rmdir("\{root}/.git", recursive=true)
  let diff2 = @daemon.scan_folder(root, store, rules, "dev-a", [])
  assert_eq(diff2.tombstones.length(), 0)
  assert_eq(diff2.conflict_count, 1)
  store.close()
}

///|
async test "scan_folder: 嵌套共享根不重扫、不墓碑" {
  let root = fresh_root("scan-nested")
  let nested = "\{root}/nested"
  let _ = write_file(root, "top.txt", "top")
  let _ = write_file(root, "nested/inner.txt", "inner")
  let store = open_store(root)
  // 父共享索引里历史遗留的 nested 条目
  let inner : @daemon.Entry = {
    path: "nested/inner.txt",
    version: Map([("dev-a", 1L)]),
    size: 5L,
    deleted: false,
    blocks: [],
    cdh: None,
    clens: None,
    mtime: None,
    placeholder: false,
  }
  store.save_entry(inner)
  let rules = @core.IgnoreRuleset::from_lines([])
  // nested 作为另一个共享的根:本树不进它、也不删它
  let diff = @daemon.scan_folder(root, store, rules, "dev-a", [nested])
  assert_eq(diff.changed, ["top.txt"])
  @fs.remove("\{root}/nested/inner.txt")
  let diff2 = @daemon.scan_folder(root, store, rules, "dev-a", [nested])
  assert_eq(diff2.tombstones.length(), 0)
  // 不带嵌套保护时,同样的删除必须正常生成墓碑
  let diff3 = @daemon.scan_folder(root, store, rules, "dev-a", [])
  assert_eq(diff3.tombstones.length(), 1)
  assert_eq(diff3.tombstones[0].path, "nested/inner.txt")
  store.close()
}

///|
async test "scan_folder: 占位条目永不墓碑" {
  let root = fresh_root("scan-placeholder")
  let store = open_store(root)
  let ph : @daemon.Entry = {
    path: "ghost.txt",
    version: Map([("dev-a", 1L)]),
    size: 5L,
    deleted: false,
    blocks: [],
    cdh: None,
    clens: None,
    mtime: None,
    placeholder: true,
  }
  store.save_entry(ph)
  let rules = @core.IgnoreRuleset::from_lines([])
  let diff = @daemon.scan_folder(root, store, rules, "dev-a", [])
  // 盘上没有实体本来就不是「本地删除」
  assert_eq(diff.tombstones.length(), 0)
  store.close()
}

///|
async test "blocks_match_on_disk: 首处不符即返回" {
  let root = fresh_root("scan-blocks")
  let abs = write_file(root, "f.bin", "0123456789")
  let ok = [@core.hash_block(b"0123456789")]
  assert_true(@daemon.blocks_match_on_disk(abs, ok))
  // 单块不符
  let bad = ["deadbeef"]
  assert_true(!@daemon.blocks_match_on_disk(abs, bad))
  // 盘上比索引短 / 长
  let two : Array[String] = [
    @core.hash_block(b"0123456789"),
    @core.hash_block(b"x"),
  ]
  assert_true(!@daemon.blocks_match_on_disk(abs, two))
  // 空哈希列表(空文件口径)恒真;文件不存在恒假
  assert_true(@daemon.blocks_match_on_disk(abs, []))
  assert_true(!@daemon.blocks_match_on_disk("\{root}/nope.bin", ok))
}

///|
async test "prune_scratch_file: 超期回收整对,未到期不动" {
  let root = fresh_root("scan-prune")
  let tmp = write_file(root, "a.txt.syncx-tmp", "partial")
  let mtime = @daemon.mtime_ms(tmp)
  assert_true(mtime is Some(_))
  let fresh = mtime.unwrap()
  // 未到期:不动
  assert_true(
    !@daemon.prune_scratch_file(root, "a.txt.syncx-tmp", now=fresh + 1L),
  )
  // 超过 7 天:tmp 与 sidecar 一起回收
  let expired = fresh + 8L * 24L * 3600L * 1000L
  let _ = write_file(root, "a.txt.syncx-partial", "{}")
  assert_true(@daemon.prune_scratch_file(root, "a.txt.syncx-tmp", now=expired))
  assert_true(!@fs.exists(tmp))
  assert_true(!@fs.exists("\{root}/a.txt.syncx-partial"))
  // 非中间态后缀:短路不动作
  assert_true(!@daemon.prune_scratch_file(root, "a.txt", now=expired))
}
