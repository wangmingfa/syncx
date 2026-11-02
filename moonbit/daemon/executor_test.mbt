///|
/// 执行器黑盒测试:真实文件系统行为(/tmp 临时目录)。
/// 覆盖落地管线(tmp → fsync → 验块 → rename)、路径安全闸门、回收站删除、
/// 冲突副本、版本快照与修剪。

///|
async fn fresh_dir(tag : String) -> String {
  let dir = "/tmp/syncx-mb-exec-\{tag}-\{@daemon.now_ms()}"
  @fs.mkdir(dir, recursive=true, allow_exist=true)
  dir
}

///|
async fn new_store(tag : String) -> @daemon.IndexStore {
  let dir = "/tmp/syncx-mb-exec-store-\{tag}"
  @fs.mkdir(dir, recursive=true, allow_exist=true)
  let db = @sqlite.open("\{dir}/index.db")
  db.exec("DROP TABLE IF EXISTS entries")
  db.close()
  @daemon.IndexStore::open("\{dir}/index.db")
}

///|
/// 构造一条「远端推送过来」的条目:块哈希与内容自洽。
fn remote_entry(path : String, content : Bytes) -> @daemon.Entry {
  {
    path,
    version: Map([("dev-b", 5L)]),
    size: content.length().to_int64(),
    deleted: false,
    blocks: [@core.hash_block(content)],
    cdh: None,
    clens: None,
    mtime: None,
    placeholder: false,
  }
}

///|
async test "resolve_share_path: 正常解析、越界拒绝、硬忽略闸门" {
  let root = fresh_dir("resolve")
  let abs = @daemon.resolve_share_path(root, "a/b/c.txt", false)
  assert_eq(abs, "\{root}/a/b/c.txt")
  // 前导 / 与反斜杠都按段切分,不越界
  let abs2 = @daemon.resolve_share_path(root, "/x\\y.txt", false)
  assert_eq(abs2, "\{root}/x/y.txt")
  // 越过根的 .. 一律拒绝
  let escaped = try {
    let _ = @daemon.resolve_share_path(root, "../escape.txt", false)
    true
  } catch {
    _ => false
  }
  assert_true(!escaped)
  // 硬忽略路径拒绝;冲突副本链路放行
  let blocked = try {
    let _ = @daemon.resolve_share_path(root, ".git/config", false)
    true
  } catch {
    _ => false
  }
  assert_true(!blocked)
  let allowed = @daemon.resolve_share_path(
    root, "报告.sync-conflict-ab12-PYQAAAAAAE.md", true,
  )
  assert_eq(allowed, "\{root}/报告.sync-conflict-ab12-PYQAAAAAAE.md")
}

///|
async test "resolve_share_path: 符号链接逃逸被逐段拦截" {
  let root = fresh_dir("symlink")
  let outside = fresh_dir("symlink-outside")
  @fs.write_file(
    "\{outside}/secret.txt",
    "secret",
    create_mode=CreateOrTruncate,
  )
  @fs.mkdir("\{root}/sub", recursive=true, allow_exist=true)
  @fs.symlink(target=outside, "\{root}/sub/link")
  // 中段是逃出共享根的符号链接 → 拒绝
  let blocked = try {
    let _ = @daemon.resolve_share_path(root, "sub/link/secret.txt", false)
    true
  } catch {
    _ => false
  }
  assert_true(!blocked)
  // 根不存在时跳过越界检查(祖先链断了,任何段都不可能存在)
  let absent = @daemon.resolve_share_path(
    "\{root}/no-such-root",
    "a.txt",
    false,
  )
  assert_eq(absent, "\{root}/no-such-root/a.txt")
}

///|
async test "apply_file: 落地、登记索引、不留 tmp" {
  let root = fresh_dir("apply")
  let store = new_store("apply")
  let exec = @daemon.LocalExecutor::new(root, "\{root}/../trash-apply")
  let content = b"hello syncx"
  let entry = remote_entry("docs/报告.md", content)
  exec.apply_file(store, entry, content)
  // 内容、目录创建、无残留
  assert_true(@fs.exists("\{root}/docs/报告.md"))
  assert_eq(@fs.read_file("\{root}/docs/报告.md").text(), "hello syncx")
  assert_true(!@fs.exists("\{root}/docs/报告.md.syncx-tmp"))
  // 索引:版本照抄、mtime 记录、非占位
  let saved = store.get_entry("docs/报告.md")
  assert_true(saved is Some(_))
  let s = saved.unwrap()
  assert_eq(s.version["dev-b"], 5L)
  assert_true(s.mtime is Some(_))
  assert_true(!s.placeholder)
  store.close()
}

///|
async test "apply_file: 块哈希不符时目标一字不动" {
  let root = fresh_dir("apply-mismatch")
  let store = new_store("apply-mismatch")
  let exec = @daemon.LocalExecutor::new(root, "\{root}/../trash-mm")
  @fs.write_file("\{root}/old.txt", "old content", create_mode=CreateOrTruncate)
  // 故意错误的块哈希:验块不过时目标一字不动
  let entry : @daemon.Entry = {
    path: "old.txt",
    version: Map([("dev-b", 5L)]),
    size: 11L,
    deleted: false,
    blocks: ["deadbeef"],
    cdh: None,
    clens: None,
    mtime: None,
    placeholder: false,
  }
  let rejected = try {
    exec.apply_file(store, entry, b"new content")
    false
  } catch {
    _ => true
  }
  assert_true(rejected)
  // 原文件保持原样,tmp 不留
  assert_eq(@fs.read_file("\{root}/old.txt").text(), "old content")
  assert_true(!@fs.exists("\{root}/old.txt.syncx-tmp"))
  // 索引没有这条
  assert_true(store.get_entry("old.txt") is None)
  store.close()
}

///|
async test "apply_delete: 移入回收站并写墓碑" {
  let root = fresh_dir("delete")
  let store = new_store("delete")
  let trash = "\{root}-trash"
  let exec = @daemon.LocalExecutor::new(root, trash)
  @fs.write_file("\{root}/gone.txt", "bye", create_mode=CreateOrTruncate)
  let entry : @daemon.Entry = {
    path: "gone.txt",
    version: Map([("dev-a", 2L)]),
    size: 3L,
    deleted: false,
    blocks: [],
    cdh: None,
    clens: None,
    mtime: None,
    placeholder: false,
  }
  store.save_entry(entry)
  let tombstone = @daemon.tombstone_of(entry, "dev-a")
  exec.apply_delete(store, "gone.txt", tombstone)
  assert_true(!@fs.exists("\{root}/gone.txt"))
  // 回收站里的名字带时间戳后缀:`<rel>.<stamp36>`
  let trashed = @fs.readdir(trash)
  let mut found = false
  for name in trashed {
    if name.has_prefix("gone.txt.") {
      found = true
    }
  }
  assert_true(found)
  let saved = store.get_entry("gone.txt")
  assert_true(saved is Some(_))
  assert_true(saved.unwrap().deleted)
  assert_eq(saved.unwrap().version["dev-a"], 3L)
  store.close()
}

///|
async test "apply_conflict: 本地保留冲突副本、远端落地、版本合并" {
  let root = fresh_dir("conflict")
  let store = new_store("conflict")
  let exec = @daemon.LocalExecutor::new(root, "\{root}-trash")
  @fs.write_file(
    "\{root}/note.txt",
    "local version",
    create_mode=CreateOrTruncate,
  )
  let local_entry : @daemon.Entry = {
    path: "note.txt",
    version: Map([("dev-a", 3L)]),
    size: 13L,
    deleted: false,
    blocks: [],
    cdh: None,
    clens: None,
    mtime: None,
    placeholder: false,
  }
  let remote = remote_entry("note.txt", b"remote version")
  let landed = exec.apply_conflict(
    store, "note.txt", local_entry, remote, b"remote version", "DEVBBBBBBC",
  )
  // 远端内容落地原路径
  assert_eq(@fs.read_file("\{root}/note.txt").text(), "remote version")
  // 冲突副本存在,且命名可被 core 的模式反解
  let names = @fs.readdir(root)
  let mut copy = ""
  for name in names {
    if name != "note.txt" {
      copy = name
    }
  }
  assert_true(copy != "")
  assert_true(@core.is_conflict_copy_name(copy))
  let parsed = @core.parse_conflict_copy_name(copy)
  assert_true(parsed is Some(_))
  assert_eq(parsed.unwrap().0, "note.txt")
  assert_eq(parsed.unwrap().1, "DEVBBBBBBC")
  // 索引:版本合并、非删除
  assert_eq(landed.version["dev-a"], 3L)
  assert_eq(landed.version["dev-b"], 5L)
  assert_true(!landed.deleted)
  store.close()
}

///|
async test "apply_conflict: 双方同时删除只写墓碑,不复活空文件" {
  let root = fresh_dir("conflict-del")
  let store = new_store("conflict-del")
  let exec = @daemon.LocalExecutor::new(root, "\{root}-trash")
  let local_entry : @daemon.Entry = {
    path: "x.txt",
    version: Map([("dev-a", 3L)]),
    size: 0L,
    deleted: true,
    blocks: [],
    cdh: None,
    clens: None,
    mtime: None,
    placeholder: false,
  }
  let remote : @daemon.Entry = {
    path: "x.txt",
    version: Map([("dev-b", 5L)]),
    size: 0L,
    deleted: true,
    blocks: [],
    cdh: None,
    clens: None,
    mtime: None,
    placeholder: false,
  }
  let merged = exec.apply_conflict(
    store, "x.txt", local_entry, remote, b"", "DEVBBBBBBC",
  )
  assert_true(merged.deleted)
  // 盘上没有任何东西被写出来
  assert_true(!@fs.exists("\{root}/x.txt"))
  assert_true(store.get_entry("x.txt") is Some(_))
  store.close()
}

///|
async test "apply_send: 流式算视图 + 版本向量递增" {
  let root = fresh_dir("send")
  let store = new_store("send")
  let exec = @daemon.LocalExecutor::new(root, "\{root}-trash")
  @fs.write_file(
    "\{root}/data.bin",
    "0123456789abcdef",
    create_mode=CreateOrTruncate,
  )
  let sent = exec.apply_send(store, "data.bin", "dev-a")
  assert_eq(sent.size, 16L)
  assert_eq(sent.blocks, [@core.hash_block(b"0123456789abcdef")])
  assert_true(sent.blocks.length() > 0)
  assert_eq(sent.version["dev-a"], 1L)
  assert_true(!sent.deleted)
  assert_true(sent.mtime is Some(_))
  // 再发一次:版本再递增
  let sent2 = exec.apply_send(store, "data.bin", "dev-a")
  assert_eq(sent2.version["dev-a"], 2L)
  // 文件不存在时如实报错
  let raised = try {
    let _ = exec.apply_send(store, "nope.txt", "dev-a")
    false
  } catch {
    _ => true
  }
  assert_true(raised)
  store.close()
}

///|
async test "preserve_local_as_conflict + apply_placeholder" {
  let root = fresh_dir("preserve")
  let store = new_store("preserve")
  let exec = @daemon.LocalExecutor::new(root, "\{root}-trash")
  @fs.write_file("\{root}/warm.txt", "warm", create_mode=CreateOrTruncate)
  let preserved = exec.preserve_local_as_conflict("warm.txt", "DEVBBBBBBC")
  assert_true(preserved)
  assert_true(!@fs.exists("\{root}/warm.txt"))
  let names = @fs.readdir(root)
  let mut found = false
  for name in names {
    if @core.is_conflict_copy_name(name) {
      found = true
    }
  }
  assert_true(found)
  // 不存在的文件:不保护、不报错
  let preserved2 = exec.preserve_local_as_conflict("cold.txt", "DEVBBBBBBC")
  assert_true(!preserved2)
  // 占位:只写索引,盘上不动
  let entry = remote_entry("ghost.txt", b"placeholder-body")
  exec.apply_placeholder(store, entry)
  let saved = store.get_entry("ghost.txt")
  assert_true(saved is Some(_))
  assert_true(saved.unwrap().placeholder)
  assert_true(!@fs.exists("\{root}/ghost.txt"))
  store.close()
}

///|
async test "版本快照与修剪:超限删最旧" {
  let root = fresh_dir("versions")
  let store = new_store("versions")
  let versions_dir = "\{root}-versions"
  // 每路径只保留 2 份
  let exec = @daemon.LocalExecutor::new(
    root,
    "\{root}-trash",
    versions_dir~,
    versions_per_path=2,
  )
  // 落地 4 次,每次内容不同(mtime/内容都变,快照按时间戳序积累)
  for i in 0..<4 {
    let text = "version-\{i}"
    let content = @utf8.encode(text)
    let entry = remote_entry("doc.txt", content)
    exec.apply_file(store, entry, content)
  }
  // 版本目录里恰好 2 份快照
  let names = @fs.readdir(versions_dir)
  assert_eq(names.length(), 2)
  // 最终内容是最后一次落地
  assert_eq(@fs.read_file("\{root}/doc.txt").text(), "version-3")
  store.close()
}

///|
test "split_ext / base36:与 Node 同口径" {
  assert_eq(@daemon.split_ext("a/b/c.txt"), ("a/b/c", ".txt"))
  assert_eq(@daemon.split_ext("noext"), ("noext", ""))
  assert_eq(@daemon.split_ext("dir/.gitignore"), ("dir/.gitignore", ""))
  assert_eq(@daemon.split_ext("a.tar.gz"), ("a.tar", ".gz"))
  assert_eq(@daemon.base36(0L), "0")
  assert_eq(@daemon.base36(1L), "1")
  assert_eq(@daemon.base36(35L), "z")
  assert_eq(@daemon.base36(36L), "10")
  assert_eq(@daemon.base36(1762000000000L), "mhg9b18g")
}

///|
async test "apply_conflict_keep_local: 磁盘一字不动,只写合并版本" {
  let root = fresh_dir("keep")
  let store = new_store("keep")
  let exec = @daemon.LocalExecutor::new(root, "\{root}-trash")
  @fs.write_file("\{root}/keep.txt", "local wins", create_mode=CreateOrTruncate)
  let local_entry : @daemon.Entry = {
    path: "keep.txt",
    version: Map([("dev-a", 3L)]),
    size: 10L,
    deleted: false,
    blocks: [],
    cdh: None,
    clens: None,
    mtime: None,
    placeholder: false,
  }
  let remote : @daemon.Entry = {
    path: "keep.txt",
    version: Map([("dev-b", 9L)]),
    size: 5L,
    deleted: false,
    blocks: [],
    cdh: None,
    clens: None,
    mtime: None,
    placeholder: false,
  }
  let kept = exec.apply_conflict_keep_local(store, local_entry, remote)
  assert_eq(kept.version["dev-a"], 3L)
  assert_eq(kept.version["dev-b"], 9L)
  assert_eq(kept.size, 10L) // 本地内容仍是权威
  assert_eq(@fs.read_file("\{root}/keep.txt").text(), "local wins")
  store.close()
}
