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
async test "改动计数:未跟踪计入、改名两段一条、中间态排除、非仓库 None" {
  let repo = fresh_repo("changes-count")
  // 空仓库(还没有提交):计数 0 而不是 None —— 「干净」是正常态
  assert_true(@daemon.uncommitted_change_count(repo) == Some(0))
  commit_file(repo, "a.txt", "v1", "init")
  assert_true(@daemon.uncommitted_change_count(repo) == Some(0))
  // 未跟踪文件 → 1
  @fs.write_file("\{repo}/new.txt", "x")
  assert_true(@daemon.uncommitted_change_count(repo) == Some(1))
  // staged 改名:XY 带 R 占两段记录(新路径 + 原路径),按一条计 → 改名 + new.txt = 2
  git_in(repo, ["mv", "a.txt", "a2.txt"])
  assert_true(@daemon.uncommitted_change_count(repo) == Some(2))
  // syncx 在途中间态两头排除:tmp/partial 不进计数
  @fs.write_file("\{repo}/big.bin.syncx-tmp", "half")
  @fs.write_file("\{repo}/big.bin.syncx-partial", "bitmap")
  assert_true(@daemon.uncommitted_change_count(repo) == Some(2))
  // 非仓库目录 → None(徽标循环按 0 处理)
  let plain = git_tmp_dir("plain-count")
  assert_true(is_none(@daemon.uncommitted_change_count(plain)))
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
/// 跑一条 git 命令拿输出(测试夹具;git 拉不起来时按空输出降级)。
async fn git_out(cwd : String, args : Array[String]) -> String {
  let (_, out, _) : (Int32, String, String) = @daemon.run_git("git", cwd, args) catch {
    _ => (1, "", "")
  }
  out
}

///|
/// 范围收敛(55b1c35 契约):changed_files 精确 stage —— 通知外的用户并发
/// 改动绝不被镜像提交打包带走(根治 2026-11-04 回声吞变更事故)。
async test "auto_commit:changed_files 精确 stage,通知外改动不被吞" {
  let repo = fresh_repo("scope")
  commit_file(repo, "a.txt", "v1", "init")
  commit_file(repo, "b.txt", "v1", "init-b")
  // 两处脏改动 + 一个用户新文件:只有 a.txt 在通知清单里,其余是用户并发改动
  @fs.write_file("\{repo}/a.txt", "v2")
  @fs.write_file("\{repo}/b.txt", "v2-user")
  @fs.write_file("\{repo}/c-new.txt", "user-new")
  @fs.write_file("\{repo}/c-new.txt.syncx-tmp", "in-flight")
  let r = @daemon.auto_commit(repo, "syncx: 镜像 a", changed_files=["a.txt"])
  assert_true(r.success)
  assert_false(r.skipped)
  // 提交内容 = 通知清单:a.txt 进了,其余没被顺手打包
  let names = git_out(repo, ["show", "--name-only", "--format=", "HEAD"])
  assert_true(names.contains("a.txt"))
  assert_false(names.contains("b.txt"))
  assert_false(names.contains("c-new.txt"))
  // 工作树仍脏:通知外的改动原样保留(a.txt 已提交、不再出现在 status)
  assert_true(@daemon.has_uncommitted_changes(repo))
  let status = git_out(repo, ["status", "--porcelain"])
  assert_true(status.contains("b.txt"))
  assert_true(status.contains("c-new.txt"))
  assert_false(status.contains("a.txt"))
  // 空清单(旧对端没给清单)退回全量兜底:剩余变更收进一笔
  let r2 = @daemon.auto_commit(repo, "syncx: 兜底", changed_files=[])
  assert_true(r2.success)
  assert_false(@daemon.has_uncommitted_changes(repo))
  assert_true(@fs.exists("\{repo}/c-new.txt.syncx-tmp")) // 在途中间态仍不入库
}

///|
/// 陌生路径容错:清单里混入本机 git 从未见过的路径(对端删除了本机从未收到
/// 过的文件、新文件缺块未落地),批量 add 一票否决会让整笔提交落不了 ——
/// 降级逐文件 stage 后能落的照常落,陌生路径记入 skipped_files;跳过不是
/// 失败,不烧重试计数。
async test "auto_commit:清单内陌生路径跳过,其余照常提交" {
  let repo = fresh_repo("skip-unknown")
  commit_file(repo, "a.txt", "v1", "init")
  @fs.write_file("\{repo}/b.txt", "new")
  let r = @daemon.auto_commit(
    repo,
    "syncx: 镜像",
    changed_files=["b.txt", "scripts/never-received.py"],
  )
  assert_true(r.success)
  assert_true(is_none(r.error))
  // 只有陌生路径被跳过
  assert_eq(r.skipped_files.length(), 1)
  assert_eq(r.skipped_files[0], "scripts/never-received.py")
  // b.txt 照常进了这笔提交,工作树不留残渣
  let names = git_out(repo, ["show", "--name-only", "--format=", "HEAD"])
  assert_true(names.contains("b.txt"))
  assert_false(@daemon.has_uncommitted_changes(repo))
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
async test "get_commit_info:full_message 保留标题与正文间的空行" {
  // 格式串里 %s 与 %b 只隔一个换行,重组时必须把标题后的空行补回:丢了它,
  // 镜像提交落库后标题与正文同段,git 的 %s 会把整段折成一行(2026-11-06
  // 对端「提交信息糊成一块」的根因)。
  let repo = fresh_repo("fullmsg")
  commit_file(repo, "a.txt", "v1", "init: a")
  let first = unwrap_or_panic(@daemon.get_last_commit_hash(repo), "应有基线提交")
  commit_file(repo, "b.txt", "v1", "feat: 标题\n\n正文第一段\n正文第二段")
  let second = unwrap_or_panic(@daemon.get_last_commit_hash(repo), "应有新提交")
  let info = unwrap_or_panic(
    @daemon.get_commit_info(repo, first, second),
    "应收集到批次信息",
  )
  assert_eq(info.message, "feat: 标题")
  assert_eq(info.full_message, "feat: 标题\n\n正文第一段\n正文第二段")
  // 单行消息不加多余空行
  commit_file(repo, "c.txt", "v1", "chore: 单行")
  let third = unwrap_or_panic(@daemon.get_last_commit_hash(repo), "应有第三笔")
  let single = unwrap_or_panic(
    @daemon.get_commit_info(repo, second, third),
    "应收集到单行批次",
  )
  assert_eq(single.full_message, "chore: 单行")
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

///|
/// 装一个 repo 范围的 git PATH shim:脚本先于真实 git 置于 PATH,但只对
/// 「commit 子命令 + 当前目录恰为指定测试仓库」的调用按 commit_script 分叉
/// ({REAL}/{REPO} 占位符替换),其余任何调用(其它并发测试在各自己的仓库里
/// 跑 git)原样透传 —— 无进程级全局状态,并发安全。用于模拟 MoonBit 形态
/// 造不出的「命令报错但提交已落盘」中间态(run_git 无超时;post-commit hook
/// 失败不影响 git commit 退出码、pre-commit 里嵌套 commit 会死锁,均实测)。
async fn install_git_shim(
  repo : String,
  tag : String,
  commit_script : String,
) -> Unit {
  // 真实 git 绝对路径与仓库的物理路径(getcwd 语义,macOS 下 /tmp 会被
  // 解析成 /private/tmp,必须两边同口径)
  let (_, real_git, _) = @daemon.run_git("sh", repo, ["-c", "command -v git"])
  let real = real_git.trim().to_owned()
  let (_, resolved, _) = @daemon.run_git("sh", repo, ["-c", "pwd -P"])
  let repo_real = resolved.trim().to_owned()
  let branch = commit_script.replace(old="{REAL}", new=real)
  let shim_dir = git_tmp_dir("shim-\{tag}")
  @fs.write_file(
    "\{shim_dir}/git",
    "#!/bin/sh\nif [ \"$1\" = \"commit\" ] && [ \"$(pwd -P)\" = \"\{repo_real}\" ]; then\n\{branch}\nfi\nexec \{real} \"$@\"\n",
  )
  @fs.chmod("\{shim_dir}/git", 0o755)
  let orig_path = @env.get_env_var("PATH").unwrap_or("")
  @env.set_env_var("PATH", "\{shim_dir}:\{orig_path}")
}

///|
async test "auto_commit:提交阶段失败的探测(成功落盘 / 真失败 / 消息不一致)" {
  // 并发测试进程共享 PATH,shim 必须 repo 范围隔离且**全部先装好**:不管
  // PATH 前插次序如何,每个仓库只会命中自己的 shim,其余调用原样透传。
  // 三个仓库各代表一种「提交阶段失败」形态:
  let repo_ok = fresh_repo("probe-ok")
  commit_file(repo_ok, "base.txt", "v1", "init: base")
  @fs.write_file("\{repo_ok}/work.txt", "v2")
  // 形态 1:commit 真跑(对象落盘)后伪装退出码 1 —— 「提交已成功而命令
  // 报错」的中间态(对应 Node 侧慢盘 fsync / hook 卡顿被超时误杀)
  install_git_shim(repo_ok, "ok", "  {REAL} \"$@\" >/dev/null 2>&1\n  exit 1")
  let repo_fail = fresh_repo("probe-fail")
  commit_file(repo_fail, "base.txt", "v1", "init: base")
  @fs.write_file("\{repo_fail}/work.txt", "v2")
  // 形态 2:commit 直接退出 1(不真跑)—— HEAD 不动,探测必须回落失败
  install_git_shim(
    repo_fail, "fail", "  echo \"fake commit failure\" >&2\n  exit 1",
  )
  let repo_mix = fresh_repo("probe-mix")
  commit_file(repo_mix, "base.txt", "v1", "init: base")
  @fs.write_file("\{repo_mix}/work.txt", "v2")
  // 形态 3:commit 换消息真跑后伪装退出 1 —— HEAD 前进但落的是他消息
  // (并发了他程序提交的等价物),账目对不上必须保守按失败
  install_git_shim(
    repo_mix, "mix", "  {REAL} commit -m \"other: concurrent\" --allow-empty >/dev/null 2>&1\n  exit 1",
  )
  // 形态 1:HEAD 前进且消息一致 → 探测按成功结算,避免按失败重试吞双笔
  let ok = @daemon.auto_commit(repo_ok, "mirror: probe")
  assert_true(ok.success)
  assert_true(!is_none(ok.hash))
  // 提交内容确已落盘:HEAD 消息与本次一致,脏文件也已提交
  let (_, head_msg, _) = @daemon.run_git("git", repo_ok, [
    "log", "-1", "--format=%B",
  ]) catch {
    _ => panic()
  }
  assert_eq(head_msg.trim().to_owned(), "mirror: probe")
  assert_false(@daemon.has_uncommitted_changes(repo_ok))
  // 形态 2:HEAD 未前进 → 按失败,error 为 shim 的 stderr 首行
  let failed = @daemon.auto_commit(repo_fail, "mirror: fail")
  assert_false(failed.success)
  assert_eq(failed.error, Some("fake commit failure"))
  assert_true(is_none(failed.hash))
  // 形态 3:消息不一致 → 保守按失败
  let mixed = @daemon.auto_commit(repo_mix, "mirror: mix")
  assert_false(mixed.success)
  assert_true(is_none(mixed.hash))
}

///|
async test "auto_commit:index.lock 残留 → 失败路径不变" {
  let repo = fresh_repo("lock")
  commit_file(repo, "base.txt", "v1", "init: base")
  let before = unwrap_or_panic(
    @daemon.get_last_commit_hash(repo),
    "基线应存在",
  )
  // 残留锁文件:git add 直接失败,HEAD 不动
  @fs.write_file("\{repo}/.git/index.lock", "stale")
  @fs.write_file("\{repo}/work.txt", "v2")
  let result = @daemon.auto_commit(repo, "mirror: locked")
  assert_false(result.success)
  assert_true(result.error is Some(_))
  assert_eq(@daemon.get_last_commit_hash(repo), Some(before))
}

///|
/// 按内容构造活条目(块哈希与 content 逐块一致)——「索引声明的内容」与盘上
/// 字节比对的夹具(与 Node 测试 entryFor / Rust entry_for 同形;测试内容都
/// 小于 BLOCK_SIZE,单块即整文件)。
fn align_entry(rel : String, content : String) -> @daemon.Entry {
  {
    path: rel,
    version: Map([]),
    size: @utf8.encode(content).length().to_int64(),
    deleted: false,
    blocks: [@core.hash_block(@utf8.encode(content))],
    cdh: None,
    clens: None,
    mtime: None,
    placeholder: false,
  }
}

///|
/// 墓碑条目:索引已标记删除、块列表为空(与接收侧落墓碑同形)。
fn align_tombstone(rel : String) -> @daemon.Entry {
  {
    path: rel,
    version: Map([]),
    size: 0L,
    deleted: true,
    blocks: [],
    cdh: None,
    clens: None,
    mtime: None,
    placeholder: false,
  }
}

///|
/// 结算对齐判据(work_tree_content_aligned):判定必须用内容本身,不看
/// mtime —— 落齐 / 半途(含同长不同内容)/ 墓碑±盘上 / 无条目 / 幽灵占位,
/// 逐形态对齐 Node workTreeContentAligned 的口径。
async test "结算对齐判据:按内容判定,不看 mtime" {
  let dir = git_tmp_dir("align")
  // 落齐:盘上字节与索引逐块一致 → 对齐
  @fs.write_file("\{dir}/a.txt", "landed-a")
  assert_true(
    @daemon.work_tree_content_aligned(
      dir,
      "a.txt",
      Some(align_entry("a.txt", "landed-a")),
    ),
  )
  // 半途:索引宣告 'final-b',盘上还是 'half-way' → 未对齐(消息对内容错的
  // 事故形态)
  @fs.write_file("\{dir}/b.txt", "half-way")
  assert_false(
    @daemon.work_tree_content_aligned(
      dir,
      "b.txt",
      Some(align_entry("b.txt", "final-b")),
    ),
  )
  // 同长度不同内容:必须真的逐块哈希,大小短路兜不住
  @fs.write_file("\{dir}/b2.txt", "aaaa")
  assert_false(
    @daemon.work_tree_content_aligned(
      dir,
      "b2.txt",
      Some(align_entry("b2.txt", "aaab")),
    ),
  )
  // 大小不同:短路,不切块
  @fs.write_file("\{dir}/b3.txt", "short")
  assert_false(
    @daemon.work_tree_content_aligned(
      dir,
      "b3.txt",
      Some(align_entry("b3.txt", "a-much-longer-content")),
    ),
  )
  // 墓碑 + 盘上缺失 = 对齐(删除语义);墓碑 + 盘上还在 = 删除尚未落地,未对齐
  assert_true(
    @daemon.work_tree_content_aligned(
      dir,
      "missing.txt",
      Some(align_tombstone("missing.txt")),
    ),
  )
  @fs.write_file("\{dir}/still-there.txt", "x")
  assert_false(
    @daemon.work_tree_content_aligned(
      dir,
      "still-there.txt",
      Some(align_tombstone("still-there.txt")),
    ),
  )
  // 索引无条目(从未收到过该路径的内容)→ 未对齐
  @fs.write_file("\{dir}/c.txt", "anything")
  assert_false(@daemon.work_tree_content_aligned(dir, "c.txt", None))
  // 盘上根本没有文件(按需同步占位条目的形态)→ 未对齐
  assert_false(
    @daemon.work_tree_content_aligned(
      dir,
      "ghost.txt",
      Some(align_entry("ghost.txt", "never landed")),
    ),
  )
}

///|
test "收敛提交消息的 subject 截断:64 码点一刀" {
  // 两侧 trim:收敛消息里引用的是干净的首行
  assert_eq(
    @daemon.truncate_git_subject("  feat: 短主题  "),
    "feat: 短主题",
  )
  let mut fits = "feat: "
  for _ in 0..<58 {
    fits = fits + "长"
  }
  assert_eq(fits.char_length(), 64)
  assert_eq(@daemon.truncate_git_subject(fits), fits)
  // 按码点截:64 个码点处一刀,接省略号;多字节字符不劈半
  let mut over = "feat: "
  for _ in 0..<70 {
    over = over + "字"
  }
  let builder = StringBuilder()
  let mut count = 0
  for ch in over {
    if count >= 64 {
      break
    }
    builder.write_char(ch)
    count = count + 1
  }
  assert_eq(@daemon.truncate_git_subject(over), "\{builder.to_string()}…")
  assert_eq(@daemon.truncate_git_subject(""), "")
}
