///|
/// 版本/回收站命名反解的正反例(黑盒)。契约来源:Node src/rollback.ts 的
/// parseVersionName / parseTrashName 与 src/cli.ts 的 versionOriginalPath;
/// 命名生成在 executor 的 snapshot_version / move_to_trash,反解必须与生成
/// 严格互逆(恢复入口据此反推原路径)。

///|
async test "version 命名反解:正例、杂散文件、多重标记取最右" {
  // 正例:带目录层级 + 时间戳(+ 碰撞序号),反解回原相对路径
  let parsed = @daemon.parse_version_name("docs/plan.md.syncx-v-mcz7x2k")
  assert_true(parsed is Some(_))
  assert_eq(parsed.unwrap().0, "docs/plan.md")
  assert_true(parsed.unwrap().1 > 0L)
  let seq = @daemon.parse_version_name("a/b.txt.syncx-v-mcz7x2k.3")
  assert_true(seq is Some(_))
  assert_eq(seq.unwrap().0, "a/b.txt")
  // 列表口径(宽松反解):无合法后缀原样返回 —— 混进版本目录的杂散文件照列
  assert_eq(
    @daemon.version_original_path("docs/plan.md.syncx-v-mcz7x2k"),
    "docs/plan.md",
  )
  assert_eq(@daemon.version_original_path("a.txt.syncx-v-mcz7x2k.3"), "a.txt")
  assert_eq(@daemon.version_original_path("plain.txt"), "plain.txt")
  // 后缀形态不对(点后非数字)不剥离 —— Node 正则 $ 锚同口径
  assert_eq(@daemon.version_original_path("a.syncx-v-x.b"), "a.syncx-v-x.b")
  // 点后空段(无时间戳)不剥离
  assert_true(@daemon.parse_version_name("a.syncx-v-.12") is None)
  // 多重标记:最右合法切分胜出(Node 贪婪 (.*) 回溯同序)
  assert_eq(
    @daemon.version_original_path("a.syncx-v-x.syncx-v-y"),
    "a.syncx-v-x",
  )
  // 严格解析:无标记 → None
  assert_true(@daemon.parse_version_name("plain.txt") is None)
}

///|
async test "trash 命名反解:正例与全部守卫" {
  // 正例:时间戳段 8 位、含碰撞序号
  let ok = @daemon.parse_trash_name("docs/a.txt.mtest001")
  assert_true(ok is Some(_))
  assert_eq(ok.unwrap().0, "docs/a.txt")
  assert_true(ok.unwrap().1 >= 100000000000L)
  let seq = @daemon.parse_trash_name("a.txt.mtest001.2")
  assert_true(seq is Some(_))
  assert_eq(seq.unwrap().0, "a.txt")
  // 无后缀 / 段太短(7 位)/ 段太长(14 位)→ None
  assert_true(@daemon.parse_trash_name("plain.txt") is None)
  assert_true(@daemon.parse_trash_name("a.txt.1234567") is None)
  assert_true(@daemon.parse_trash_name("a.txt.12345678901234") is None)
  // 版本文件不误认(relPath 以 .syncx-v 结尾的守卫)
  assert_true(@daemon.parse_trash_name("x.syncx-v.mtest001") is None)
  // ts 下限:base36 值低于 1e11 的数值尾巴(日期后缀形态)
  assert_true(@daemon.parse_trash_name("a.txt.00000001") is None)
  // seq 之后还有杂散尾巴 → 整体不成立
  assert_true(@daemon.parse_trash_name("a.txt.mtest001.extra") is None)
}

///|
async test "executor 快照命名 ↔ 反解互逆" {
  let root = fresh_dir("vname")
  let store = new_store("vname")
  let versions = "\{root}-versions"
  let exec = @daemon.LocalExecutor::new(root, "\{root}-trash", versions_dir=versions)
  @fs.mkdir("\{root}/docs", recursive=true, allow_exist=true)
  @fs.write_file("\{root}/docs/n.md", "old", create_mode=CreateOrTruncate)
  // 对端推送覆盖:apply_file 落地前把旧内容快照进版本目录
  let content : Bytes = b"new"
  let entry : @daemon.Entry = {
    path: "docs/n.md",
    version: Map([("dev-b", 5L)]),
    size: 3L,
    deleted: false,
    blocks: [@core.hash_block(content)],
    cdh: None,
    clens: None,
    mtime: None,
    placeholder: false,
  }
  exec.apply_file(store, entry, content)
  // 盘面:新内容在原路径,旧内容在版本目录
  assert_eq(@fs.read_file("\{root}/docs/n.md").text(), "new")
  let names = @fs.readdir("\{versions}/docs")
  let mut snap = ""
  for name in names {
    if name.has_prefix("n.md.syncx-v-") {
      snap = name
    }
  }
  assert_true(snap != "")
  assert_eq(@fs.read_file("\{versions}/docs/\{snap}").text(), "old")
  // 命名反解:恢复入口据此推回原路径,时间戳可解析为毫秒数
  let parsed = @daemon.parse_version_name("docs/\{snap}")
  assert_true(parsed is Some(_))
  assert_eq(parsed.unwrap().0, "docs/n.md")
  assert_true(parsed.unwrap().1 > 0L)
  store.close()
}

///|
async test "executor 回收站命名 ↔ 反解互逆" {
  let root = fresh_dir("tname")
  let store = new_store("tname")
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
  let names = @fs.readdir(trash)
  let mut copy = ""
  for name in names {
    if name.has_prefix("gone.txt.") {
      copy = name
    }
  }
  assert_true(copy != "")
  let parsed = @daemon.parse_trash_name(copy)
  assert_true(parsed is Some(_))
  assert_eq(parsed.unwrap().0, "gone.txt")
  assert_true(parsed.unwrap().1 >= 100000000000L)
  store.close()
}
