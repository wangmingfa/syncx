///|
// Git 弹窗数据面原语的契约测试(daemon/gitdata.mbt):解析口径与 Node
// getUncommittedChanges / listRecentCommits / listCommitFiles /
// getCommitParents / readFileAt 逐条对拍;夹具与 git_test.mbt 同款真仓库。

///|
async test "改动清单:未跟踪/折叠目录/staged/改名/删除 全口径" {
  // 非仓库 → None
  let plain = git_tmp_dir("changes-plain")
  assert_true(@daemon.get_uncommitted_changes(plain) is None)
  let repo = fresh_repo("changes")
  // 空仓库 = 空清单
  let empty = @daemon.get_uncommitted_changes(repo).unwrap()
  assert_eq(empty.entries.length(), 0)
  assert_false(empty.truncated)
  commit_file(repo, "a.txt", "v1", "init")
  // 未跟踪文件 → added、未 staged
  @fs.write_file("\{repo}/new.txt", "x")
  // 未跟踪目录折叠成一条:去尾斜杠 + dir 标记
  @fs.mkdir("\{repo}/sub", allow_exist=true)
  @fs.write_file("\{repo}/sub/in.txt", "y")
  // 已跟踪文件修改(未 staged)→ modified
  @fs.write_file("\{repo}/a.txt", "v2")
  // 已跟踪文件删除 → deleted
  @fs.remove("\{repo}/a.txt")
  let scan = @daemon.get_uncommitted_changes(repo).unwrap()
  let mut saw_new = false
  let mut saw_sub = false
  let mut saw_deleted = false
  for entry in scan.entries {
    if entry.path == "new.txt" {
      saw_new = entry.status == "added" && !entry.staged
    }
    if entry.path == "sub" {
      saw_sub = entry.dir && entry.status == "added"
    }
    if entry.path == "a.txt" {
      saw_deleted = entry.status == "deleted"
    }
  }
  assert_true(saw_new)
  assert_true(saw_sub)
  assert_true(saw_deleted)
  // staged 改动:第一列非空 → staged=true;git mv 折叠成 renamed + 原路径
  git_in(repo, ["reset", "-q"])
  git_in(repo, ["checkout", "-q", "--", "a.txt"])
  @fs.remove("\{repo}/new.txt")
  @fs.remove("\{repo}/sub/in.txt")
  @fs.rmdir("\{repo}/sub")
  commit_file(repo, "b.txt", "vb", "second")
  git_in(repo, ["mv", "b.txt", "b2.txt"])
  let scan = @daemon.get_uncommitted_changes(repo).unwrap()
  assert_eq(scan.entries.length(), 1)
  assert_eq(scan.entries[0].status, "renamed")
  assert_eq(scan.entries[0].path, "b2.txt")
  assert_eq(scan.entries[0].orig_path, Some("b.txt"))
  assert_true(scan.entries[0].staged)
  // syncx 在途中间态照旧排除
  @fs.write_file("\{repo}/half.bin.syncx-tmp", "half")
  @fs.write_file("\{repo}/half.bin.syncx-partial", "bitmap")
  let scan = @daemon.get_uncommitted_changes(repo).unwrap()
  assert_eq(scan.entries.length(), 1)
}

///|
async test "提交历史:分页/正文并回/空仓库空态" {
  let repo = fresh_repo("log")
  // 空仓库:git log 128 → 空列表空态(不是故障)
  let commits = @daemon.list_recent_commits(repo).unwrap()
  assert_eq(commits.length(), 0)
  commit_file(repo, "a.txt", "v1", "第一笔")
  commit_file(repo, "b.txt", "v2", "第二笔\n\n正文第二行\n")
  commit_file(repo, "c.txt", "v3", "第三笔")
  let commits = @daemon.list_recent_commits(repo).unwrap()
  assert_eq(commits.length(), 3)
  // 新→旧;subject 取首行,正文并回 body(多行保留)
  assert_eq(commits[0].subject, "第三笔")
  assert_eq(commits[2].subject, "第一笔")
  assert_true(commits[1].body.contains("正文第二行"))
  assert_eq(commits[0].author, "syncx-test")
  // date 是 ISO 8601 形态(带时区偏移)
  assert_true(commits[0].date.contains("T"))
  // 最新一条挂着分支装饰
  assert_true(commits[0].refs.contains("main"))
  // 分页:-n 与 --skip 都是 git 自己的分页参数
  let page = @daemon.list_recent_commits(repo, limit=1).unwrap()
  assert_eq(page.length(), 1)
  assert_eq(page[0].subject, "第三笔")
  let page = @daemon.list_recent_commits(repo, limit=1, skip=1).unwrap()
  assert_eq(page[0].subject, "第二笔")
  // 非仓库 → None
  let plain = git_tmp_dir("log-plain")
  assert_true(@daemon.list_recent_commits(plain) is None)
}

///|
async test "提交文件清单:改名三段一组,非法哈希拒绝" {
  let repo = fresh_repo("cfiles")
  commit_file(repo, "a.txt", "v1", "init")
  git_in(repo, ["mv", "a.txt", "a2.txt"])
  commit_file(repo, "b.txt", "vb", "second")
  let head = @daemon.get_last_commit_hash(repo).unwrap()
  let entries = @daemon.list_commit_files(repo, head)
  assert_eq(entries.length(), 2)
  // 改名条目:R + 新路径 + 原路径;新增条目:A
  let mut saw_rename = false
  let mut saw_add = false
  for entry in entries {
    match entry.orig_path {
      Some(orig) =>
        saw_rename = entry.status.has_prefix("R") &&
          entry.path == "a2.txt" &&
          orig == "a.txt"
      None => if entry.path == "b.txt" { saw_add = entry.status == "A" }
    }
  }
  assert_true(saw_rename)
  assert_true(saw_add)
  // 非法哈希(选项注入面):400 口径在 api 层,这里先拒在原语
  try {
    let _ = @daemon.list_commit_files(repo, "-evil")
    abort("应拒绝非法哈希")
  } catch {
    _ => ()
  }
}

///|
async test "提交父链与文件读取:根提交无父、bytes/absent/error 三态" {
  let repo = fresh_repo("parents")
  commit_file(repo, "a.txt", "v1", "根提交")
  commit_file(repo, "b.txt", "v2", "第二笔")
  let head = @daemon.get_last_commit_hash(repo).unwrap()
  let parents = @daemon.get_commit_parents(repo, head)
  assert_eq(parents.length(), 1)
  // 首父 = 根提交;根提交自身无父
  let root = parents[0]
  assert_eq(@daemon.get_commit_parents(repo, root).length(), 0)
  // HEAD:存在 → bytes 逐字节保真
  match @daemon.read_file_at(repo, "HEAD", "a.txt") {
    Bytes(bytes) => assert_eq(@utf8.decode_lossy(bytes), "v1")
    _ => abort("HEAD 里应有 a.txt")
  }
  // 新文件不在早期 rev → absent(不是 error)
  assert_true(@daemon.read_file_at(repo, root, "b.txt") is Absent)
  // 磁盘上有、rev 里没有 → absent;格式良好但查无此对象 → git 自己说
  // "does not exist in",与 Node 同口径归 absent(不是 error)
  assert_true(@daemon.read_file_at(repo, root, "missing.txt") is Absent)
  assert_true(
    @daemon.read_file_at(
      repo, "0000000000000000000000000000000000000001", "a.txt",
    )
    is Absent,
  )
  // 形状闸:7–40 位十六进制
  assert_true(@daemon.is_commit_hash("abcdef1"))
  assert_true(@daemon.is_commit_hash(head))
  assert_false(@daemon.is_commit_hash("-evil"))
  assert_false(@daemon.is_commit_hash("abc"))
  assert_false(@daemon.is_commit_hash("zzzzzzz"))
}
