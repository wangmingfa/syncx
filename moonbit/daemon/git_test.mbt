///|
/// git 集成黑盒测试:用 /tmp 临时目录 `git init` 真实仓库,断言探测 / 自动
/// 提交 / 未推送计数逻辑。git 拉不起来时相关用例通过降级路径自然通过,不挂测试。

///|
/// Option 判空辅助(结构体未派生 Eq,不能用 == None)。
fn[T] is_none(o : T?) -> Bool {
  match o {
    None => true
    Some(_) => false
  }
}

///|
/// Option 解包辅助:None 直接判失败。
fn[T] unwrap_or_panic(o : T?, what : String) -> T {
  match o {
    Some(v) => v
    None => {
      println("unwrap 失败: \{what}")
      panic()
    }
  }
}

///|
/// 造一个唯一临时目录(幂等:目录名带毫秒时间戳,每轮测试各用各的)。
async fn git_tmp_dir(tag : String) -> String {
  let dir = "/tmp/syncx-mb-git-\{tag}-\{@daemon.now_ms()}"
  @fs.mkdir(dir, recursive=true, allow_exist=true)
  dir
}

///|
/// 在 dir 里跑一条 git 命令,失败即 panic(测试夹具,不值得兜)。
async fn git_in(cwd : String, args : Array[String]) -> Unit {
  let code = @process.run("git", args, cwd~, no_console_window=true)
  if code != 0 {
    panic()
  }
}

///|
/// 初始化一个可提交的空仓库(配好 user.name/email,免得依赖全局 git 配置)。
async fn fresh_repo(tag : String) -> String {
  let dir = git_tmp_dir(tag)
  git_in(dir, ["init", "-q"])
  git_in(dir, ["config", "user.name", "syncx-test"])
  git_in(dir, ["config", "user.email", "t@example.com"])
  dir
}

///|
/// 造一笔提交:写文件 + git add + git commit -m。
async fn commit_file(
  repo : String,
  name : String,
  content : String,
  message : String,
) -> Unit {
  @fs.write_file("\{repo}/\{name}", content)
  git_in(repo, ["add", name])
  git_in(repo, ["commit", "-q", "-m", message])
}

///|
async test "探测:非 git 目录全部降级" {
  let dir = git_tmp_dir("plain")
  assert_false(@daemon.is_git_repo(dir))
  assert_true(is_none(@daemon.get_last_commit_hash(dir)))
  assert_false(@daemon.has_uncommitted_changes(dir))
  assert_true(is_none(@daemon.count_unpushed_commits(dir)))
  assert_true(is_none(@daemon.list_unpushed_commits(dir)))
  // 非仓库目录上的观察器:不炸、不产提交信息、基线被清
  let w = @daemon.GitWatcher::new(dir, @daemon.Full)
  assert_true(is_none(w.check_new_commit()))
  assert_true(is_none(w.last_hash))
}

///|
async test "探测:空仓库与基线建立" {
  let repo = fresh_repo("empty")
  assert_true(@daemon.is_git_repo(repo))
  // 空仓库:rev-parse HEAD 退出非零 → None
  assert_true(is_none(@daemon.get_last_commit_hash(repo)))
  assert_false(@daemon.has_uncommitted_changes(repo))
  // 首次观察:只建基线,不产提交信息(绝不重放历史提交)
  commit_file(repo, "a.txt", "hello", "init: a")
  let w = @daemon.GitWatcher::new(repo, @daemon.Full)
  assert_true(is_none(w.check_new_commit()))
  assert_true(!is_none(w.last_hash))
}

///|
async test "变更探测:两次提交之间能被观察器发现" {
  let repo = fresh_repo("watch")
  commit_file(repo, "a.txt", "v1", "feat: a")
  let w = @daemon.GitWatcher::new(repo, @daemon.Full)
  assert_true(is_none(w.check_new_commit())) // 建基线
  // 没有新提交:HEAD 未动
  assert_true(is_none(w.check_new_commit()))
  // 落一笔新提交:下一轮检出 CommitInfo,基线推进
  commit_file(repo, "b.txt", "v1", "feat: b")
  let i = unwrap_or_panic(w.check_new_commit(), "应检出 feat: b")
  assert_eq(i.message, "feat: b")
  assert_eq(i.changed_files.length(), 1)
  assert_eq(i.changed_files[0], "b.txt")
  // 整批 subject 旧→新,含最后一笔
  assert_eq(i.commit_subjects.length(), 1)
  assert_eq(i.commit_subjects[0], "feat: b")
  assert_true(i.parent_hash != "")
  assert_true(!is_none(i.diff_stat))
  // 基线已推进:再查一次为空
  assert_true(is_none(w.check_new_commit()))
  // 攒多笔再查:commit_subjects 收齐整批
  commit_file(repo, "c.txt", "v1", "feat: c")
  commit_file(repo, "d.txt", "v1", "feat: d")
  let batch = unwrap_or_panic(w.check_new_commit(), "应检出批次提交")
  assert_eq(batch.commit_subjects.length(), 2)
  assert_eq(batch.commit_subjects[0], "feat: c")
  assert_eq(batch.commit_subjects[1], "feat: d")
  assert_eq(batch.message, "feat: d")
}

///|
async test "未提交变更:脏工作树与在途中间态排除" {
  let repo = fresh_repo("dirty")
  assert_false(@daemon.has_uncommitted_changes(repo))
  commit_file(repo, "a.txt", "v1", "init")
  assert_false(@daemon.has_uncommitted_changes(repo))
  // 未跟踪文件 → 有变更
  @fs.write_file("\{repo}/new.txt", "x")
  assert_true(@daemon.has_uncommitted_changes(repo))
  // 已跟踪文件被修改 → 有变更
  commit_file(repo, "a.txt", "v2", "update")
  @fs.write_file("\{repo}/a.txt", "v3")
  assert_true(@daemon.has_uncommitted_changes(repo))
  // syncx 在途中间态两头排除:只留 tmp/partial 时不报脏
  git_in(repo, ["reset", "-q"])
  @fs.remove("\{repo}/new.txt")
  @fs.write_file("\{repo}/a.txt", "v2")
  @fs.write_file("\{repo}/big.bin.syncx-tmp", "half")
  @fs.write_file("\{repo}/big.bin.syncx-partial", "bitmap")
  assert_false(@daemon.has_uncommitted_changes(repo))
}

///|
async test "自动提交:脏树落一笔,干净树跳过" {
  let repo = fresh_repo("autocommit")
  commit_file(repo, "a.txt", "v1", "init")
  // 干净树:skipped
  let clean = @daemon.auto_commit_if_dirty(repo, "syncx: 镜像提交")
  assert_true(clean.success)
  assert_true(clean.skipped)
  assert_true(is_none(clean.hash))
  // 脏树:真正落一笔
  @fs.write_file("\{repo}/b.txt", "new")
  @fs.write_file("\{repo}/c.txt.syncx-tmp", "in-flight") // 不该进这笔提交
  let r = @daemon.auto_commit_if_dirty(repo, "syncx: 镜像提交")
  assert_true(r.success)
  assert_false(r.skipped)
  assert_true(!is_none(r.hash))
  assert_true(is_none(r.error))
  // 提交后工作树干净(在途中间态留在原地、且不算未提交)
  assert_false(@daemon.has_uncommitted_changes(repo))
  assert_true(@fs.exists("\{repo}/c.txt.syncx-tmp"))
  // 镜像提交内容真实存在:HEAD 就是传入的消息
  let head = unwrap_or_panic(
    @daemon.get_last_commit_hash(repo),
    "HEAD 应存在",
  )
  let w = @daemon.GitWatcher::new(repo, @daemon.Full)
  assert_true(is_none(w.check_new_commit())) // 建基线在镜像提交上
  commit_file(repo, "d.txt", "x", "feat: d")
  let info = unwrap_or_panic(w.check_new_commit(), "应检出 feat: d")
  assert_eq(info.message, "feat: d")
  assert_eq(info.parent_hash, head) // 上一笔正是镜像提交
}

///|
async test "自动提交:非仓库目录降级为跳过" {
  let dir = git_tmp_dir("notrepo")
  let r = @daemon.auto_commit_if_dirty(dir, "msg")
  // 非仓库:工作树判定按「无变更」降级 → 跳过而不是报错
  assert_true(r.success)
  assert_true(r.skipped)
}

///|
async test "未推送计数与推送:有上游才计数,push 后归零" {
  let base = git_tmp_dir("push")
  let origin = "\{base}/origin.git"
  let bare = @process.run(
    "git",
    ["init", "-q", "--bare", origin],
    no_console_window=true,
  )
  assert_eq(bare, 0)
  let work = "\{base}/work"
  let clone = @process.run(
    "git",
    ["clone", "-q", origin, work],
    no_console_window=true,
  )
  assert_eq(clone, 0)
  git_in(work, ["config", "user.name", "syncx-test"])
  git_in(work, ["config", "user.email", "t@example.com"])
  // 空仓库克隆:还没有任何提交,计数为 None
  assert_true(is_none(@daemon.count_unpushed_commits(work)))
  commit_file(work, "a.txt", "v1", "feat: a")
  // 第一次 push -u 建立上游
  git_in(work, ["push", "-q", "-u", "origin", "HEAD"])
  assert_true(@daemon.count_unpushed_commits(work) == Some(0))
  // 新攒两笔未推送
  commit_file(work, "b.txt", "v1", "feat: b")
  commit_file(work, "c.txt", "v1", "feat: c")
  assert_true(@daemon.count_unpushed_commits(work) == Some(2))
  // 未推送列表:新→旧,subject 对得上
  let unpushed = unwrap_or_panic(
    @daemon.list_unpushed_commits(work),
    "应能列出未推送提交",
  )
  assert_eq(unpushed.length(), 2)
  assert_eq(unpushed[0].subject, "feat: c")
  assert_eq(unpushed[1].subject, "feat: b")
  assert_eq(unpushed[0].author, "syncx-test")
  assert_true(unpushed[0].date != "")
  // git_push 推走,计数归零
  let pushed = @daemon.git_push(work)
  assert_true(pushed.ok)
  assert_true(is_none(pushed.error))
  assert_true(@daemon.count_unpushed_commits(work) == Some(0))
  let empty = unwrap_or_panic(
    @daemon.list_unpushed_commits(work),
    "推送后列表应为空而非不可列",
  )
  assert_eq(empty.length(), 0)
}

///|
async test "git_push:无上游时报错不抛" {
  let repo = fresh_repo("pushnoupstream")
  commit_file(repo, "a.txt", "v1", "init")
  let r = @daemon.git_push(repo)
  // 无上游分支:失败,error 里是 git 的 stderr 首行或兜底文案
  assert_false(r.ok)
  assert_true(!is_none(r.error))
}

///|
async test "镜像提交信息格式:单笔原样,多笔带批次脉络" {
  // 单笔:与原消息一致
  assert_eq(
    @daemon.compose_mirror_commit_message("feat: a\n\nbody", ["feat: a"]),
    "feat: a\n\nbody",
  )
  assert_eq(@daemon.compose_mirror_commit_message("feat: a", []), "feat: a")
  // 多笔:去掉最后一条(它就是 full_message 的首行),其余旧→新附在 body
  assert_eq(
    @daemon.compose_mirror_commit_message("feat: c\n\nbody-c", [
      "feat: a", "feat: b", "feat: c",
    ]),
    "feat: c\n\nbody-c\n\nfeat: a\nfeat: b",
  )
  // 空串 subject 被滤掉
  assert_eq(
    @daemon.compose_mirror_commit_message("feat: c", [
      "  ", "feat: b", "feat: c",
    ]),
    "feat: c\n\nfeat: b",
  )
}

///|
async test "gitSync 模式解析与策略面" {
  assert_true(@daemon.git_sync_mode_of(None) == @daemon.Off)
  assert_true(@daemon.git_sync_mode_of(Some("")) == @daemon.Off)
  assert_true(@daemon.git_sync_mode_of(Some("bogus")) == @daemon.Off)
  assert_true(@daemon.git_sync_mode_of(Some("send")) == @daemon.Send)
  assert_true(@daemon.git_sync_mode_of(Some("receive")) == @daemon.Receive)
  assert_true(@daemon.git_sync_mode_of(Some("full")) == @daemon.Full)
  // 策略面:send 只广播,receive 只收,full 双向 + 中继
  assert_true(
    @daemon.git_sync_plan(@daemon.Off) ==
    { watch_local: false, auto_commit_remote: false, relay: false, },
  )
  assert_true(
    @daemon.git_sync_plan(@daemon.Send) ==
    { watch_local: true, auto_commit_remote: false, relay: false, },
  )
  assert_true(
    @daemon.git_sync_plan(@daemon.Receive) ==
    { watch_local: false, auto_commit_remote: true, relay: false, },
  )
  assert_true(
    @daemon.git_sync_plan(@daemon.Full) ==
    { watch_local: true, auto_commit_remote: true, relay: true, },
  )
}

///|
async test "git 不存在时优雅降级" {
  let dir = git_tmp_dir("nobin")
  // 拉起不存在的二进制:run_git 抛 SpawnFailed,不 panic
  let raised = try {
    let _ = @daemon.run_git("/nonexistent/syncx-git-nope", dir, ["--version"])
    false
  } catch {
    _ => true
  }
  assert_true(raised)
  // 探测类在任何异常输入下都返回「无」值
  assert_true(
    is_none(@daemon.get_last_commit_hash("/nonexistent/syncx-dir-nope")),
  )
  assert_false(@daemon.has_uncommitted_changes("/nonexistent/syncx-dir-nope"))
  assert_true(
    is_none(@daemon.count_unpushed_commits("/nonexistent/syncx-dir-nope")),
  )
  // 自动提交对不存在的目录:降级为 skip(工作树判定按无变更)
  let r = @daemon.auto_commit_if_dirty("/nonexistent/syncx-dir-nope", "m")
  assert_true(r.success)
  assert_true(r.skipped)
}

///|
async test "剔除 Co-Authored-By 行:尾注/大小写/连字符/尾巴" {
  // 经典尾注:整行剔除,尾部不留空行尾巴
  assert_eq(
    @daemon.strip_co_authored_lines(
      "feat: a\n\nbody\n\nCo-Authored-By: MOSS <moss@example>",
    ),
    "feat: a\n\nbody",
  )
  // 无尾注:逐字节原样返回(连结尾部的换行都不动)
  assert_eq(
    @daemon.strip_co_authored_lines("feat: a\n\nbody"),
    "feat: a\n\nbody",
  )
  assert_eq(
    @daemon.strip_co_authored_lines("feat: a\n\nbody\n"),
    "feat: a\n\nbody\n",
  )
  // 大小写不敏感 + 连字符可有可无(/co-?authored-by/i)
  assert_eq(
    @daemon.strip_co_authored_lines(
      "feat: a\n\nco-authored-by: x\n\nCO-AUTHORED-BY: Y\n\nCoAuthored-By: Z",
    ),
    "feat: a",
  )
  // 不只首行:一整组尾注全部剔除,尾巴空行一并裁掉
  assert_eq(
    @daemon.strip_co_authored_lines(
      "feat: a\n\nCo-Authored-By: x\n\nCo-Authored-By: y",
    ),
    "feat: a",
  )
  // 带缩进的尾注(行内出现即命中,正则未锚定)
  assert_eq(
    @daemon.strip_co_authored_lines("feat: a\n  Co-Authored-By: x"),
    "feat: a",
  )
  // 正文中间的尾注同样剔除;契约只裁尾巴,正文内部空行保持原样
  assert_eq(
    @daemon.strip_co_authored_lines("p1\n\nCo-Authored-By: x\n\np2"),
    "p1\n\n\np2",
  )
  // 只剩尾注的消息:剔完为空串
  assert_eq(@daemon.strip_co_authored_lines("Co-Authored-By: x"), "")
  // 非 AI 尾注的普通行不动
  assert_eq(
    @daemon.strip_co_authored_lines(
      "feat: a\n\nbody\n\nSigned-off-by: u <u@example>",
    ),
    "feat: a\n\nbody\n\nSigned-off-by: u <u@example>",
  )
}

///|
async test "镜像提交信息组装:strip 开关作用在最终消息上" {
  // 开启 strip:组装出的最终消息剔除尾注(单笔,正文带 AI 尾注)
  assert_eq(
    @daemon.compose_mirror_commit_message(
      "feat: a\n\nbody-a\n\nCo-Authored-By: MOSS <moss@example>",
      ["feat: a"],
      strip=true,
    ),
    "feat: a\n\nbody-a",
  )
  // 开启 strip 且多笔:尾注夹在 full_message 与批次脉络之间,照样剔除
  assert_eq(
    @daemon.compose_mirror_commit_message(
      "feat: c\nbody-c\nCo-Authored-By: MOSS",
      ["feat: a", "feat: b", "feat: c"],
      strip=true,
    ),
    "feat: c\nbody-c\n\nfeat: a\nfeat: b",
  )
  // 开启 strip 但消息干净:原样返回
  assert_eq(
    @daemon.compose_mirror_commit_message(
      "feat: a\n\nbody",
      ["feat: a"],
      strip=true,
    ),
    "feat: a\n\nbody",
  )
  // 缺省(不开 strip):行为不变,尾注原样保留
  assert_eq(
    @daemon.compose_mirror_commit_message(
      "feat: a\n\nbody\n\nCo-Authored-By: MOSS",
      ["feat: a"],
    ),
    "feat: a\n\nbody\n\nCo-Authored-By: MOSS",
  )
}
