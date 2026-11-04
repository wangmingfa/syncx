///|
/// auto_commit 失败探测的白盒单测:直接驱动私有的 commit_failed_probe /
/// head_message_matches,覆盖端到端 shim 用例造不出来或成本高的分支
/// (空仓库首笔、消息不一致、非仓库降级)。端到端形态见 git_test.mbt 的
/// PATH shim 用例。
/// 注:wbtest 与黑盒 *_test.mbt 是两个编译单元,夹具各自带一份最小版。

///|
/// Option 判空辅助(wbtest 与黑盒 *_test.mbt 是两个编译单元,夹具各自带)。
fn[T] is_none(o : T?) -> Bool {
  match o {
    None => true
    Some(_) => false
  }
}

///|
/// 白盒夹具:临时目录里跑一条 git 命令,失败即 panic。
async fn wb_git(cwd : String, args : Array[String]) -> Unit {
  let code = @process.run("git", args, cwd~, no_console_window=true)
  if code != 0 {
    panic()
  }
}

///|
async fn wb_repo(tag : String) -> String {
  let dir = "/tmp/syncx-mb-git-wb-\{tag}-\{now_ms()}"
  @fs.mkdir(dir, recursive=true, allow_exist=true)
  wb_git(dir, ["init", "-q"])
  wb_git(dir, ["config", "user.name", "syncx-test"])
  wb_git(dir, ["config", "user.email", "t@example.com"])
  dir
}

///|
async fn wb_commit(
  repo : String,
  name : String,
  content : String,
  message : String,
) -> Unit {
  @fs.write_file("\{repo}/\{name}", content)
  wb_git(repo, ["add", name])
  wb_git(repo, ["commit", "-q", "-m", message])
}

///|
async test "探测:HEAD 前进且消息一致 → 按成功(含空仓库首笔)" {
  // 非空仓库:基线为旧 HEAD,真实 HEAD 已前进且消息一致
  let repo = wb_repo("ok")
  wb_commit(repo, "a.txt", "v1", "init: a")
  let before = match get_last_commit_hash(repo) {
    Some(h) => h
    None => panic()
  }
  wb_commit(repo, "b.txt", "v1", "mirror: probe")
  let result = commit_failed_probe(repo, Some(before), "mirror: probe", "fake err")
  assert_true(result.success)
  assert_true(!is_none(result.hash))
  assert_true(is_none(result.error))
  // 空仓库首笔:基线 None → 有 HEAD 即算前进,消息一致按成功
  let empty = wb_repo("empty")
  wb_commit(empty, "a.txt", "v1", "first: mirror")
  let first = commit_failed_probe(empty, None, "first: mirror", "fake err")
  assert_true(first.success)
}

///|
async test "探测:HEAD 未前进 / 消息不一致 / 非仓库 → 一律按失败" {
  // HEAD 未前进:探测回落失败,error 原样透传
  let repo = wb_repo("stale")
  wb_commit(repo, "a.txt", "v1", "init: a")
  let head = match get_last_commit_hash(repo) {
    Some(h) => h
    None => panic()
  }
  let unchanged = commit_failed_probe(repo, Some(head), "mirror: x", "fake err")
  assert_false(unchanged.success)
  assert_eq(unchanged.error, Some("fake err"))
  assert_true(is_none(unchanged.hash))
  // HEAD 前进了但消息与本次不一致(并发了他程序提交):保守按失败
  wb_commit(repo, "b.txt", "v1", "other: concurrent")
  let mismatch = commit_failed_probe(repo, Some(head), "mirror: y", "fake err")
  assert_false(mismatch.success)
  assert_true(is_none(mismatch.hash))
  // 非仓库:探测自身的任何失败都静默回落失败
  let plain = "/tmp/syncx-mb-git-wb-plain-\{now_ms()}"
  @fs.mkdir(plain, recursive=true, allow_exist=true)
  let degraded = commit_failed_probe(plain, Some(head), "mirror: z", "fake err")
  assert_false(degraded.success)
  assert_eq(degraded.error, Some("fake err"))
}

///|
async test "消息比对:一致 / 不一致 / 非仓库" {
  let repo = wb_repo("msgcmp")
  wb_commit(repo, "a.txt", "v1", "feat: alpha")
  // 完整一致;%B 尾部自带换行,trim 后比对
  assert_true(head_message_matches(repo, "feat: alpha"))
  // 消息正文(body)整体参与比对,%B 与 -m 原文逐字对应
  wb_commit(repo, "b.txt", "v1", "feat: beta\n\nbody line")
  assert_true(head_message_matches(repo, "feat: beta\n\nbody line"))
  assert_false(head_message_matches(repo, "feat: alpha"))
  assert_false(head_message_matches(repo, ""))
  // 非仓库:按不一致处理(保守回落失败)
  let plain = "/tmp/syncx-mb-git-wb-plain2-\{now_ms()}"
  @fs.mkdir(plain, recursive=true, allow_exist=true)
  assert_false(head_message_matches(plain, "anything"))
}
