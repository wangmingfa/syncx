///|
/// git 镜像提交循环的闸门测试:intake 闸(模式/去重/未知目录)、drain 闸
/// 矩阵、flush 结算(干净树跳过 / 范围收敛 / 中继与回声登记 / 退避)。
/// 端到端双实例互镜像由冒烟覆盖,这里用真实 actor + 真实 git 仓库单机验证。

///|
/// Option 判空辅助(与 daemon/git_test 同款夹具,编译单元独立各带一份)。
fn[T] gm_is_none(o : T?) -> Bool {
  match o {
    None => true
    Some(_) => false
  }
}

///|
/// 构造一条 GitCommitNotify 控制消息(测试夹具;self-info 全 None)。
fn gm_notify(
  from : String,
  folder_id : String,
  hash : String,
  message~ : String = "syncx: 测试提交",
  changed~ : Array[String] = ["a.txt"],
  subjects~ : Array[String]? = None,
) -> @net.ControlMessage {
  @net.ControlMessage::GitCommitNotify(
    from_device_id=from,
    folder_id=folder_id,
    commit_hash=hash,
    commit_message=message,
    changed_files=changed,
    diff_stat=None,
    commit_subjects=subjects,
    parent_hash="0000000",
    version=None,
    hostname=None,
    platform=None,
    runtime=None,
  )
}

///|
/// 在 dir 里跑一条 git 命令,失败即 panic(测试夹具)。
async fn gm_git(cwd : String, args : Array[String]) -> Unit {
  let code = @process.run("git", args, cwd~, no_console_window=true)
  if code != 0 {
    panic()
  }
}

///|
/// 初始化一个可提交的空仓库(配好 user.name/email)。
async fn gm_fresh_repo(tag : String) -> String {
  let dir = "/tmp/syncx-mb-mirror-\{tag}-\{@daemon.now_ms()}"
  @fs.mkdir(dir, recursive=true, allow_exist=true)
  gm_git(dir, ["init", "-q"])
  gm_git(dir, ["config", "user.name", "syncx-test"])
  gm_git(dir, ["config", "user.email", "t@example.com"])
  dir
}

///|
/// 造一笔提交:写文件 + git add + git commit -m。
async fn gm_commit(
  repo : String,
  name : String,
  content : String,
  message : String,
) -> Unit {
  @fs.write_file("\{repo}/\{name}", content)
  gm_git(repo, ["add", name])
  gm_git(repo, ["commit", "-q", "-m", message])
}

///|
/// 跑一条 git 命令拿输出(git 拉不起来按空串降级)。
async fn gm_git_out(cwd : String, args : Array[String]) -> String {
  let (_, out, _) : (Int32, String, String) = @daemon.run_git("git", cwd, args) catch {
    _ => (1, "", "")
  }
  out
}

///|
/// 镜像夹具:空目录 actor(镜像测试不依赖 actor 的目录行为;句柄只承载
/// 基线回填命令与在途读数)+ 注入的注册表与发送闭包表。actor 的常驻循环
/// 由 group 接管 —— 测试收尾必须 `handle.send(Shutdown)` 收工,否则
/// with_task_group 等它到天荒地老。
fn gm_mirror(
  group : @async.TaskGroup[Unit],
  config : @core.Config,
  registry : @cli.PeerSessionRegistry,
  senders : @cli.PeerSenders,
) -> (@cli.GitMirror, @daemon.ActorHandle) {
  let handle = @daemon.start_session_actor(group, "SELF-DEV", []) catch {
    e => {
      println("start_session_actor 失败: \{@daemon.IndexStoreError::to_text(e)}")
      panic()
    }
  }
  (@cli.GitMirror::new(config_of=() => config, registry~, senders~, handle~), handle)
}

///|
test "drain 闸矩阵:在途/来源离线挡道,60s 封顶强推" {
  let t : Int64 = 1_000_000L
  // 无挡因:放行,记账清空
  let g1 = @cli.drain_gate(0, false, None, t)
  assert_true(g1.flush_now)
  assert_eq(g1.reasons, "")
  assert_true(gm_is_none(g1.blocked_since))
  // 有在途接收:挡道,记账起点起算
  let g2 = @cli.drain_gate(3, false, None, t)
  assert_false(g2.flush_now)
  assert_true(g2.reasons.contains("3 in-flight"))
  match g2.blocked_since {
    Some(s) => assert_eq(s, t)
    None => panic()
  }
  // 来源离线:挡道(挡因独立成句)
  let g3 = @cli.drain_gate(0, true, None, t)
  assert_false(g3.flush_now)
  assert_true(g3.reasons.contains("offline"))
  // 双挡因并存 + 未到期:延续既有记账起点,不放行
  let g4 = @cli.drain_gate(2, true, Some(t - 10_000L), t)
  assert_false(g4.flush_now)
  match g4.blocked_since {
    Some(s) => assert_eq(s, t - 10_000L)
    None => panic()
  }
  // 封顶到点(61s):强推,记账起点保留
  let g5 = @cli.drain_gate(0, true, Some(t - 61_000L), t)
  assert_true(g5.flush_now)
}

///|
test "镜像提交消息多行保真:wire 往返不折行" {
  // 消息正文带换行(镜像提交的核心保真点):JSON 信封转义后原样还原
  let multiline = "syncx: 多行标题\n\n正文第一段\n正文第二段"
  let notify = gm_notify("DEV-A", "f1", "h-multiline", message=multiline)
  let back = @net.ControlMessage::from_json(@net.ControlMessage::to_json(notify))
  assert_eq(back, notify)
}

///|
async test "镜像 intake:未知目录/模式闸/去重/槽位覆盖" {
  @async.with_task_group() <| group => {
    let config = @core.parse_config(
      "{\"sharedFolders\":[{\"path\":\"/tmp/nope-a\",\"id\":\"f-full\",\"gitSync\":\"full\"},{\"path\":\"/tmp/nope-b\",\"id\":\"f-send\",\"gitSync\":\"send\"},{\"path\":\"/tmp/nope-c\",\"id\":\"f-off\"}]}",
    )
    let (mirror, handle) = gm_mirror(
      group,
      config,
      @cli.PeerSessionRegistry::new(),
      @cli.PeerSenders::new(),
    )
    // 未知目录:忽略
    mirror.on_notify(gm_notify("DEV-A", "zzz", "h-unknown"), Some("DEV-A"))
    assert_false(mirror.has_slot("zzz"))
    // off / send:只出不进,不入队
    mirror.on_notify(gm_notify("DEV-A", "f-off", "h-off"), Some("DEV-A"))
    assert_false(mirror.has_slot("f-off"))
    mirror.on_notify(gm_notify("DEV-A", "f-send", "h-send"), Some("DEV-A"))
    assert_false(mirror.has_slot("f-send"))
    // full:入队;同一哈希重达(重连补发)只登记一次
    mirror.on_notify(gm_notify("DEV-A", "f-full", "h-1"), Some("DEV-A"))
    assert_true(mirror.has_slot("f-full"))
    assert_eq(mirror.processed_size(), 1)
    mirror.on_notify(gm_notify("DEV-A", "f-full", "h-1"), Some("DEV-A"))
    assert_eq(mirror.processed_size(), 1)
    // 新哈希覆盖单槽(单笔槽位;上一笔的失败计数随覆盖归零)
    mirror.on_notify(gm_notify("DEV-A", "f-full", "h-2"), Some("DEV-A"))
    assert_true(mirror.has_slot("f-full"))
    assert_eq(mirror.processed_size(), 2)
    // 去重集合容量:>1000 淘最旧 500(Map 保序,逐笔灌到 1004 笔后余 506:
    // 2 笔先入库,第 1001 笔触发淘汰,之后 4 笔顺次入账)
    let mut i = 0
    while i < 1004 {
      mirror.on_notify(gm_notify("DEV-A", "f-full", "bulk-\{i}"), Some("DEV-A"))
      i = i + 1
    }
    assert_eq(mirror.processed_size(), 506)
    // 收尾:叫停 actor 常驻循环(group 收拢才会返回)
    let _ = handle.send(@daemon.Cmd::Shutdown)
  }
}

///|
async test "镜像 flush:来源会话不在则挂起,在线且树干净则跳过结清" {
  @async.with_task_group() <| group => {
    let repo = gm_fresh_repo("clean")
    gm_commit(repo, "a.txt", "v1", "init")
    let head_before = @daemon.get_last_commit_hash(repo)
    let config = @core.parse_config(
      "{\"sharedFolders\":[{\"path\":\"\{repo}\",\"id\":\"f1\",\"gitSync\":\"full\"}]}",
    )
    let registry = @cli.PeerSessionRegistry::new()
    let (mirror, handle) = gm_mirror(group, config, registry, @cli.PeerSenders::new())
    // 来源 DEV-A 会话不在:drain 闸挡道,槽位保留不结算(60s 封顶未到)
    mirror.on_notify(gm_notify("DEV-A", "f1", "deadbeef"), Some("DEV-A"))
    assert_true(mirror.has_slot("f1"))
    mirror.flush()
    assert_true(mirror.has_slot("f1"))
    // 来源会话登记(重连):闸放行;工作树干净 → 跳过分支,槽位结清、
    // 不落新提交,基线回填到当前 HEAD(cmd 已投给 actor;防回声端到端由冒烟覆盖)
    registry.register(
      "DEV-A",
      { version: None, platform: None, hostname: None, url: None },
    )
    mirror.flush()
    assert_false(mirror.has_slot("f1"))
    let head_after = @daemon.get_last_commit_hash(repo)
    match (head_before, head_after) {
      (Some(b), Some(a)) => assert_eq(b, a)
      _ => panic()
    }
    // 收尾:叫停 actor 常驻循环
    let _ = handle.send(@daemon.Cmd::Shutdown)
  }
}

///|
async test "镜像 flush:范围收敛 + 多笔脉络消息 + 中继与回声登记" {
  @async.with_task_group() <| group => {
    let repo = gm_fresh_repo("mirror")
    gm_commit(repo, "a.txt", "v1", "init")
    gm_commit(repo, "b.txt", "v1", "init-b")
    // 通知只宣称 a.txt;b.txt 与新文件是用户并发改动,绝不能被顺手打包
    @fs.write_file("\{repo}/a.txt", "v2")
    @fs.write_file("\{repo}/b.txt", "v2-user")
    @fs.write_file("\{repo}/c-user.txt", "user-new")
    let config = @core.parse_config(
      "{\"sharedFolders\":[{\"path\":\"\{repo}\",\"id\":\"f1\",\"gitSync\":\"full\",\"devices\":[\"DEV-A\",\"DEV-B\",\"DEV-C\"]}]}",
    )
    let registry = @cli.PeerSessionRegistry::new()
    registry.register(
      "DEV-A",
      { version: None, platform: None, hostname: None, url: None },
    )
    // 中继记录器:DEV-B 在线收中继(DEV-C 未登记 = 离线)
    let relayed : Ref[Array[@net.ControlMessage]] = Ref([])
    let senders = @cli.PeerSenders::new()
    senders.register("DEV-B", msg => {
      match msg {
        Control(payload=n) => relayed.val.push(n)
        _ => ()
      }
      true
    })
    let (mirror, handle) = gm_mirror(group, config, registry, senders)
    // 多行消息 + 多笔 subjects:镜像提交的 body 要带整批脉络(旧→新,
    // 末笔的 subject 是正文本身,不重复附)
    let message = "syncx: 镜像远端提交\n\n远端正文第二行"
    let subjects : Array[String]? = Some(["feat: 旧笔", "syncx: 镜像远端提交"])
    mirror.on_notify(
      gm_notify("DEV-A", "f1", "aaaa1111", message=message, changed=["a.txt"], subjects=subjects),
      Some("DEV-A"),
    )
    assert_true(mirror.has_slot("f1"))
    mirror.flush()
    // 槽位结清;去重集合登记了镜像新哈希(入队 1 + 镜像 head 1 = 2)
    assert_false(mirror.has_slot("f1"))
    assert_eq(mirror.processed_size(), 2)
    // 提交内容 = 通知清单:b.txt / c-user.txt 原样留在工作树
    assert_true(@daemon.has_uncommitted_changes(repo))
    let status = gm_git_out(repo, ["status", "--porcelain"])
    assert_true(status.contains("b.txt"))
    assert_true(status.contains("c-user.txt"))
    assert_false(status.contains("a.txt"))
    // 镜像提交消息 = 组装结果(正文保留多行 + 批次脉络,未开 strip)
    let body = gm_git_out(repo, ["log", "-1", "--format=%B"])
    assert_true(body.contains("远端正文第二行"))
    assert_true(body.contains("feat: 旧笔"))
    // 中继:原始通知原样转发给其余对端(不含来源 DEV-A;离线 DEV-C 记 deferred)
    assert_eq(relayed.val.length(), 1)
    let expected = gm_notify(
      "DEV-A",
      "f1",
      "aaaa1111",
      message=message,
      changed=["a.txt"],
      subjects=subjects,
    )
    assert_eq(relayed.val[0], expected)
    // 收尾:叫停 actor 常驻循环
    let _ = handle.send(@daemon.Cmd::Shutdown)
  }
}

///|
async test "镜像 flush:提交失败退避,通知不丢" {
  @async.with_task_group() <| group => {
    let repo = gm_fresh_repo("retry")
    gm_commit(repo, "a.txt", "v1", "init")
    // 残留 index.lock:提交命令必失败(git_test 同款失败夹具)
    @fs.write_file("\{repo}/.git/index.lock", "stale")
    @fs.write_file("\{repo}/a.txt", "v2")
    let config = @core.parse_config(
      "{\"sharedFolders\":[{\"path\":\"\{repo}\",\"id\":\"f1\",\"gitSync\":\"full\"}]}",
    )
    let registry = @cli.PeerSessionRegistry::new()
    registry.register(
      "DEV-A",
      { version: None, platform: None, hostname: None, url: None },
    )
    let (mirror, handle) = gm_mirror(group, config, registry, @cli.PeerSenders::new())
    mirror.on_notify(gm_notify("DEV-A", "f1", "aaaa2222"), Some("DEV-A"))
    mirror.flush()
    // 失败:计数 +1、退避记账,通知槽保留(内容还在工作树里,到点再试)
    assert_eq(mirror.slot_attempts("f1"), 1)
    assert_true(mirror.has_slot("f1"))
    // 退避期内立即再 flush:不重试(计数不涨)
    mirror.flush()
    assert_eq(mirror.slot_attempts("f1"), 1)
    // 失败夹具本身仍在:残留锁没被清掉,工作树依旧脏
    assert_true(@fs.exists("\{repo}/.git/index.lock"))
    // 收尾:叫停 actor 常驻循环
    let _ = handle.send(@daemon.Cmd::Shutdown)
  }
}

///|
async test "镜像热重载:配置单元格现读,gitSync 关闭即刻生效" {
  @async.with_task_group() <| group => {
    let config = @core.parse_config(
      "{\"sharedFolders\":[{\"path\":\"/tmp/nope-m\",\"id\":\"f1\",\"gitSync\":\"full\"}]}",
    )
    let (mirror, handle) = gm_mirror(
      group,
      config,
      @cli.PeerSessionRegistry::new(),
      @cli.PeerSenders::new(),
    )
    mirror.on_notify(gm_notify("DEV-A", "f1", "h-live"), Some("DEV-A"))
    assert_true(mirror.has_slot("f1"))
    // 热重载:整目录拷贝替换把 gitSync 改为 off(与写路由同款语义;
    // 供应者闭包每次现读)
    let f = config.shared_folders[0]
    config.shared_folders[0] = { ..f, git_sync: Some("off") }
    // 入队闸即刻收紧:新通知不再入队
    mirror.on_notify(gm_notify("DEV-A", "f1", "h-live-2"), Some("DEV-A"))
    assert_eq(mirror.processed_size(), 1)
    // 已挂的槽在下一拍 flush 被模式闸结算(off 只出不进)
    mirror.flush()
    assert_false(mirror.has_slot("f1"))
    let _ = handle.send(@daemon.Cmd::Shutdown)
  }
}
