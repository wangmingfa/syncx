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
    folder_id~,
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
/// 仓库提交笔数(rev-list --count 的手工十进制解析;解析失败 -1 显形)。
async fn gm_commit_count(repo : String) -> Int32 {
  let (_, out, _) : (Int32, String, String) = @daemon.run_git("git", repo, [
    "rev-list", "--count", "HEAD",
  ]) catch {
    _ => (1, "", "")
  }
  let mut n = 0
  for c in out.trim().to_owned() {
    if c < '0' || c > '9' {
      return -1
    }
    n = n * 10 + (c.to_int() - '0'.to_int())
  }
  n
}

///|
/// HEAD 一笔提交的文件清单(git show --name-only;夹具)。
async fn gm_head_files(repo : String) -> Array[String] {
  let out = gm_git_out(repo, ["show", "--name-only", "--format="])
  let files : Array[String] = []
  for line in out.split("\n") {
    let t = line.trim().to_owned()
    if t != "" {
      files.push(t)
    }
  }
  files
}

///|
/// HEAD 的 subject 行(git log -1 --format=%s;夹具)。
async fn gm_head_subject(repo : String) -> String {
  gm_git_out(repo, ["log", "-1", "--format=%s"]).trim().to_owned()
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
/// 镜像夹具的临时配置文件序号(同毫秒防同名)。
let gm_seq : Ref[Int32] = Ref(0)

///|
/// 镜像夹具:空目录 actor(镜像测试不依赖 actor 的目录行为;句柄只承载
/// 基线回填命令与在途读数)+ 注入的注册表与发送闭包表 + 配置的盘上副本
/// (台账落盘/恢复走真实文件,与生产同语义)。actor 的常驻循环由 group
/// 接管 —— 测试收尾必须 `handle.send(Shutdown)` 收工,否则 with_task_group
/// 等它到天荒地老。
async fn gm_mirror(
  group : @async.TaskGroup[Unit],
  config : @core.Config,
  registry : @cliapp.PeerSessionRegistry,
  senders : @cliapp.PeerSenders,
) -> (@cliapp.GitMirror, @daemon.ActorHandle, String) {
  gm_seq.val = gm_seq.val + 1
  let file = "/tmp/syncx-mb-gm-\{@daemon.now_ms()}-\{gm_seq.val}.json"
  @fs.write_file(file, config.to_json().stringify() + "\n")
  let handle = @daemon.start_session_actor(group, "SELF-DEV", []) catch {
    e => {
      println(
        "start_session_actor 失败: \{@daemon.IndexStoreError::to_text(e)}",
      )
      panic()
    }
  }
  (
    @cliapp.GitMirror::new(
      config_of=() => config,
      config_file=file,
      registry~,
      senders~,
      handle~,
    ),
    handle,
    file,
  )
}

///|
/// 读盘上配置里首个目录的 gitBroadcastPending 记录(台账落盘断言用)。
async fn gm_disk_broadcast_pending(file : String) -> Json? {
  let text = @fs.read_file(file).text()
  @core.parse_config(text).shared_folders[0].git_broadcast_pending
}

///|
/// 读盘上配置里首个目录的 gitDeferredMirror 记录(漂移台账落盘断言用)。
async fn gm_disk_deferred(file : String) -> Json? {
  let text = @fs.read_file(file).text()
  @core.parse_config(text).shared_folders[0].git_deferred_mirror
}

///|
/// 模拟「内容已经数据面落地」:写盘 + 扫描入库(索引宣告与盘上字节一致)。
/// 真实链路里接收侧落地即写索引,测试走真实扫描管线同语义;sync_snapshot
/// 作屏障 —— 回执到达即 ScanFolder 已处理完,读数是确定性的。
async fn gm_land(
  handle : @daemon.ActorHandle,
  folder_id : String,
  repo : String,
  rel : String,
  content : String,
) -> Unit {
  @fs.write_file("\{repo}/\{rel}", content)
  let _ = handle.send(@daemon.Cmd::ScanFolder(folder_id))
  let _ = handle.sync_snapshot()
}

///|
/// 镜像夹具(带目录态):actor 持有该仓库的目录 —— 结算内容对齐与漂移自愈
/// 的判据数据源是 actor 的本机索引(folder.local_index),夹具必须把目录注册
/// 进 actor 才能表达「索引宣告 vs 盘上字节」的两态。目录按 receive 模式装配:
/// 心跳静默扫描(watch_local)随之关闭,扫描时机全部由测试显式控制 —— 否则
/// 周期泵的静默扫描会把「盘上半途内容」重新索引回对齐态,欠账前提被冲掉。
async fn gm_mirror_repo(
  group : @async.TaskGroup[Unit],
  config : @core.Config,
  registry : @cliapp.PeerSessionRegistry,
  senders : @cliapp.PeerSenders,
  repo : String,
  folder_id : String,
) -> (@cliapp.GitMirror, @daemon.ActorHandle, String) {
  gm_seq.val = gm_seq.val + 1
  let dir = "/tmp/syncx-mb-gm-\{@daemon.now_ms()}-\{gm_seq.val}"
  let file = "\{dir}.json"
  @fs.write_file(file, config.to_json().stringify() + "\n")
  let spec : @daemon.FolderSpec = {
    id: folder_id,
    root: repo,
    index_path: "\{dir}-index.db",
    trash_dir: "\{dir}-trash",
    versions_dir: None,
    versions_per_path: None,
    rules: @core.IgnoreRuleset::from_lines([]),
    receive_only: false,
    conflict_policy: @daemon.ConflictPolicy::KeepBoth,
    paused: false,
    paused_files: [],
    baseline_pending: false,
    max_bandwidth_kbps: None,
    git_sync: @daemon.GitSyncMode::Receive,
    git_strip_co_authored: false,
    schedule: None,
  }
  let handle = @daemon.start_session_actor(group, "SELF-DEV", [spec]) catch {
    e => {
      println(
        "start_session_actor 失败: \{@daemon.IndexStoreError::to_text(e)}",
      )
      panic()
    }
  }
  (
    @cliapp.GitMirror::new(
      config_of=() => config,
      config_file=file,
      registry~,
      senders~,
      handle~,
    ),
    handle,
    file,
  )
}

///|
test "drain 闸矩阵:在途/来源离线挡道,60s 封顶强推" {
  let t : Int64 = 1_000_000L
  // 无挡因:放行,记账清空
  let g1 = @cliapp.drain_gate(0, false, None, t)
  assert_true(g1.flush_now)
  assert_eq(g1.reasons, "")
  assert_true(gm_is_none(g1.blocked_since))
  // 有在途接收:挡道,记账起点起算
  let g2 = @cliapp.drain_gate(3, false, None, t)
  assert_false(g2.flush_now)
  assert_true(g2.reasons.contains("3 in-flight"))
  match g2.blocked_since {
    Some(s) => assert_eq(s, t)
    None => panic()
  }
  // 来源离线:挡道(挡因独立成句)
  let g3 = @cliapp.drain_gate(0, true, None, t)
  assert_false(g3.flush_now)
  assert_true(g3.reasons.contains("offline"))
  // 双挡因并存 + 未到期:延续既有记账起点,不放行
  let g4 = @cliapp.drain_gate(2, true, Some(t - 10_000L), t)
  assert_false(g4.flush_now)
  match g4.blocked_since {
    Some(s) => assert_eq(s, t - 10_000L)
    None => panic()
  }
  // 封顶到点(61s):强推,记账起点保留
  let g5 = @cliapp.drain_gate(0, true, Some(t - 61_000L), t)
  assert_true(g5.flush_now)
}

///|
test "镜像提交消息多行保真:wire 往返不折行" {
  // 消息正文带换行(镜像提交的核心保真点):JSON 信封转义后原样还原
  let multiline = "syncx: 多行标题\n\n正文第一段\n正文第二段"
  let notify = gm_notify("DEV-A", "f1", "h-multiline", message=multiline)
  let back = @net.ControlMessage::from_json(
    @net.ControlMessage::to_json(notify),
  )
  assert_eq(back, notify)
}

///|
async test "镜像 intake:未知目录/模式闸/去重/槽位覆盖" {
  @async.with_task_group() <| group => {
    let config = @core.parse_config(
      "{\"sharedFolders\":[{\"path\":\"/tmp/nope-a\",\"id\":\"f-full\",\"gitSync\":\"full\"},{\"path\":\"/tmp/nope-b\",\"id\":\"f-send\",\"gitSync\":\"send\"},{\"path\":\"/tmp/nope-c\",\"id\":\"f-off\"}]}",
    )
    let (mirror, handle, _) = gm_mirror(
      group,
      config,
      @cliapp.PeerSessionRegistry::new(),
      @cliapp.PeerSenders::new(),
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
    let registry = @cliapp.PeerSessionRegistry::new()
    let (mirror, handle, _) = gm_mirror(
      group,
      config,
      registry,
      @cliapp.PeerSenders::new(),
    )
    // 来源 DEV-A 会话不在:drain 闸挡道,槽位保留不结算(60s 封顶未到)
    mirror.on_notify(gm_notify("DEV-A", "f1", "deadbeef"), Some("DEV-A"))
    assert_true(mirror.has_slot("f1"))
    mirror.flush()
    assert_true(mirror.has_slot("f1"))
    // 来源会话登记(重连):闸放行;工作树干净 → 跳过分支,槽位结清、
    // 不落新提交,基线回填到当前 HEAD(cmd 已投给 actor;防回声端到端由冒烟覆盖)
    registry.register("DEV-A", {
      version: None,
      platform: None,
      hostname: None,
      url: None,
    })
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
async test "镜像 intake:覆盖旧槽时合并欠账清单" {
  // 范围收敛后接收方只 stage 通知声明的路径 —— 新通知覆盖旧槽若丢弃旧清单,
  // 只出现在旧 changed_files 里的文件从此不进任何镜像提交(2026-11-10 实测:
  // ws 超时修复一笔被 fs-watch 一笔顶掉,漏 moonbit/api/ws_test.mbt)
  @async.with_task_group() <| group => {
    let repo = gm_fresh_repo("merge-slot")
    gm_commit(repo, "keep.txt", "v1", "init")
    let config = @core.parse_config(
      "{\"sharedFolders\":[{\"path\":\"\{repo}\",\"id\":\"f1\",\"gitSync\":\"full\"}]}",
    )
    let (mirror, handle, _) = gm_mirror(
      group,
      config,
      @cliapp.PeerSessionRegistry::new(),
      @cliapp.PeerSenders::new(),
    )
    // 第一笔入队(未结算),第二笔覆盖:清单必须并集
    mirror.on_notify(
      gm_notify(
        "DEV-A",
        "f1",
        "h-1",
        message="feat: 第一笔",
        changed=["a.txt"],
        subjects=Some(["feat: 第一笔"]),
      ),
      Some("DEV-A"),
    )
    mirror.on_notify(
      gm_notify(
        "DEV-A",
        "f1",
        "h-2",
        message="feat: 第二笔",
        changed=["b.txt"],
        subjects=Some(["feat: 第二笔"]),
      ),
      Some("DEV-A"),
    )
    let (files, subjects) = mirror.slot_notify_files("f1")
    assert_true(files.contains("a.txt") && files.contains("b.txt"))
    assert_true(subjects.contains("feat: 第一笔") && subjects.contains("feat: 第二笔"))
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
    let registry = @cliapp.PeerSessionRegistry::new()
    registry.register("DEV-A", {
      version: None,
      platform: None,
      hostname: None,
      url: None,
    })
    // 中继记录器:DEV-B 在线收中继(DEV-C 未登记 = 离线)
    let relayed : Ref[Array[@net.ControlMessage]] = Ref([])
    let senders = @cliapp.PeerSenders::new()
    senders.register("DEV-B", msg => {
      match msg {
        Control(payload=n) => relayed.val.push(n)
        _ => ()
      }
      true
    })
    let (mirror, handle, _) = gm_mirror_repo(
      group, config, registry, senders, repo, "f1",
    )
    // a.txt 的通知内容落进本机索引(结算对齐判据的数据源;扫描入库与生产
    // 接收侧同语义)—— 不落索引就是「索引无条目 → 未对齐」,只会进台账
    gm_land(handle, "f1", repo, "a.txt", "v2")
    // 多行消息 + 多笔 subjects:镜像提交的 body 要带整批脉络(旧→新,
    // 末笔的 subject 是正文本身,不重复附)
    let message = "syncx: 镜像远端提交\n\n远端正文第二行"
    let subjects : Array[String]? = Some([
      "feat: 旧笔", "syncx: 镜像远端提交",
    ])
    mirror.on_notify(
      gm_notify(
        "DEV-A",
        "f1",
        "aaaa1111",
        message~,
        changed=["a.txt"],
        subjects~,
      ),
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
      message~,
      changed=["a.txt"],
      subjects~,
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
    let registry = @cliapp.PeerSessionRegistry::new()
    registry.register("DEV-A", {
      version: None,
      platform: None,
      hostname: None,
      url: None,
    })
    let (mirror, handle, _) = gm_mirror_repo(
      group,
      config,
      registry,
      @cliapp.PeerSenders::new(),
      repo,
      "f1",
    )
    // 通知内容落齐(索引有 a.txt 的 v2 条目),失败夹具是残留锁而非内容
    gm_land(handle, "f1", repo, "a.txt", "v2")
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
    let (mirror, handle, _) = gm_mirror(
      group,
      config,
      @cliapp.PeerSessionRegistry::new(),
      @cliapp.PeerSenders::new(),
    )
    mirror.on_notify(gm_notify("DEV-A", "f1", "h-live"), Some("DEV-A"))
    assert_true(mirror.has_slot("f1"))
    // 热重载:整目录拷贝替换把 gitSync 改为 off(与写路由同款语义;
    // 供应者闭包每次现读)
    let f = config.shared_folders[0]
    config.shared_folders[0] = { ..f, git_sync: Some("off"), }
    // 入队闸即刻收紧:新通知不再入队
    mirror.on_notify(gm_notify("DEV-A", "f1", "h-live-2"), Some("DEV-A"))
    assert_eq(mirror.processed_size(), 1)
    // 已挂的槽在下一拍 flush 被模式闸结算(off 只出不进)
    mirror.flush()
    assert_false(mirror.has_slot("f1"))
    let _ = handle.send(@daemon.Cmd::Shutdown)
  }
}

///|
/// 台账夹具配置:单目录 full 模式、共享给 DEV-B(路径不要求真实存在 ——
/// 广播/台账路径不碰工作树,结算路径才需要仓库)。
fn gm_ledger_config() -> @core.Config {
  @core.parse_config(
    "{\"sharedFolders\":[{\"path\":\"/tmp/nope-ledger\",\"id\":\"f1\",\"gitSync\":\"full\",\"devices\":[\"DEV-B\"]}]}",
  )
}

///|
/// 记录 DEV-B 收到的 Control 帧(测试夹具;返回登记好的发送表)。
fn gm_inbox_senders() -> (@cliapp.PeerSenders, Ref[Array[@net.ControlMessage]]) {
  let inbox : Ref[Array[@net.ControlMessage]] = Ref([])
  let senders = @cliapp.PeerSenders::new()
  senders.register("DEV-B", msg => {
    match msg {
      Control(payload=n) => inbox.val.push(n)
      _ => ()
    }
    true
  })
  (senders, inbox)
}

///|
async test "发送台账:离线不耗次数,重启恢复,重连补投,ack 销账" {
  @async.with_task_group() <| group => {
    let config = gm_ledger_config()
    let notify = gm_notify("SELF-DEV", "f1", "aaaa1111")
    // DEV-B 先离线(空发送表),重连时再往同一张表登记 —— PeerSenders 是
    // 可变注册表,「上线」就是把闭包挂进去
    let registry = @cliapp.PeerSessionRegistry::new()
    let senders = @cliapp.PeerSenders::new()
    let (mirror, handle, file) = gm_mirror(group, config, registry, senders)
    mirror.on_local_git_notify(notify)
    assert_eq(mirror.ledger_targets("f1"), Some(["DEV-B"]))
    assert_true(gm_is_none(mirror.ledger_attempt_of("f1", "DEV-B")))
    match gm_disk_broadcast_pending(file) {
      Some(Json::Object(pending)) =>
        match pending.get("targets") {
          Some(Json::Array(items)) => assert_true(items.length() > 0)
          _ => panic()
        }
      _ => panic()
    }
    // 重启语义:全新镜像(内存台账为空)从盘上记录恢复(attempts 不恢复)
    let mirror2 = @cliapp.GitMirror::new(
      config_of=() => config,
      config_file=file,
      registry~,
      senders~,
      handle~,
    )
    mirror2.adopt_pending()
    assert_eq(mirror2.ledger_targets("f1"), Some(["DEV-B"]))
    // 重连补投:DEV-B 上线后下一拍 flush 送达,计数 +1,继续挂账等回执
    let inbox : Ref[Array[@net.ControlMessage]] = Ref([])
    senders.register("DEV-B", msg => {
      match msg {
        Control(payload=n) => inbox.val.push(n)
        _ => ()
      }
      true
    })
    mirror2.flush()
    assert_eq(inbox.val.length(), 1)
    assert_eq(mirror2.ledger_attempt_of("f1", "DEV-B"), Some(1))
    assert_eq(mirror2.ledger_targets("f1"), Some(["DEV-B"]))
    // 回执到达:入队(同步回调)→ 下一拍 flush 销账,内存台账清空、盘上
    // 记录位清掉
    mirror2.on_git_ack("DEV-B", "f1", "aaaa1111")
    mirror2.flush()
    assert_true(gm_is_none(mirror2.ledger_targets("f1")))
    assert_true(gm_is_none(gm_disk_broadcast_pending(file)))
    // 收尾:叫停 actor 常驻循环
    let _ = handle.send(@daemon.Cmd::Shutdown)
  }
}

///|
async test "发送台账:在线不回执,重发满上限放弃并清账" {
  @async.with_task_group() <| group => {
    // DEV-B 在线但永不回执(旧版本对端形态)
    let (senders, inbox) = gm_inbox_senders()
    let (mirror, handle, file) = gm_mirror(
      group,
      gm_ledger_config(),
      @cliapp.PeerSessionRegistry::new(),
      senders,
    )
    mirror.on_local_git_notify(gm_notify("SELF-DEV", "f1", "aaaa2222"))
    // 首投计 1 次;此后每拍补投一次(flush 开头即补投),第 5 次达到上限放弃
    mirror.flush()
    assert_eq(mirror.ledger_attempt_of("f1", "DEV-B"), Some(2))
    let mut tick = 0
    while tick < 2 {
      mirror.flush()
      tick = tick + 1
    }
    assert_eq(mirror.ledger_attempt_of("f1", "DEV-B"), Some(4))
    mirror.flush()
    // 上限到点:目标放弃,台账清空、盘上记录清掉;总投递 1 + 4 = 5 次
    assert_eq(inbox.val.length(), 5)
    assert_true(gm_is_none(mirror.ledger_targets("f1")))
    assert_true(gm_is_none(gm_disk_broadcast_pending(file)))
    let _ = handle.send(@daemon.Cmd::Shutdown)
  }
}

///|
async test "发送台账:盘上遗留记录恢复后,模式关断即作废清账" {
  @async.with_task_group() <| group => {
    // 上一实例遗留的待回执记录直接写在盘上配置里(重启场景);内存配置
    // 则是同一目录的现行值(full 模式,无 pending)—— 两份刻意不同步,
    // 恢复只认盘上记录,模式闸只认内存现值
    let config = gm_ledger_config()
    gm_seq.val = gm_seq.val + 1
    let file = "/tmp/syncx-mb-gm-\{@daemon.now_ms()}-\{gm_seq.val}.json"
    let legacy = "{\"sharedFolders\":[{\"path\":\"/tmp/nope-ledger\",\"id\":\"f1\",\"gitSync\":\"full\",\"devices\":[\"DEV-B\"],\"gitBroadcastPending\":{\"fromDeviceId\":\"SELF-DEV\",\"folderId\":\"f1\",\"commitHash\":\"aaaa9999\",\"commitMessage\":\"legacy\",\"changedFiles\":[\"a.txt\"],\"parentHash\":\"0000000\",\"targets\":[\"DEV-B\"]}}]}"
    @fs.write_file(file, legacy)
    // 恢复:遗留记录采纳进内存台账(镜像循环启动首拍的同款语义)
    let handle = @daemon.start_session_actor(group, "SELF-DEV", []) catch {
      _ => panic()
    }
    let mirror2 = @cliapp.GitMirror::new(
      config_of=() => config,
      config_file=file,
      registry=@cliapp.PeerSessionRegistry::new(),
      senders=@cliapp.PeerSenders::new(),
      handle~,
    )
    mirror2.adopt_pending()
    assert_eq(mirror2.ledger_targets("f1"), Some(["DEV-B"]))
    // 热重载把 gitSync 改为 off(内存现值;供应者闭包每次现读):下一拍
    // flush 模式闸作废台账,盘上记录一并清掉 —— 关掉发送的目录不该再补投
    config.shared_folders[0] = {
      ..config.shared_folders[0],
      git_sync: Some("off"),
    }
    mirror2.flush()
    assert_true(gm_is_none(mirror2.ledger_targets("f1")))
    assert_true(gm_is_none(gm_disk_broadcast_pending(file)))
    let _ = handle.send(@daemon.Cmd::Shutdown)
  }
}

///|
/// 结算内容对齐 + 漂移自愈(对齐 Node 1122fbc / Rust 8767648)的集成测试。
/// 2026-11-04 实测事故的契约:结算把 changedFiles 按「工作树内容 vs 本机
/// 索引」拆分,只提交对齐的(宁缺勿错);未对齐的进漂移台账
/// gitDeferredMirror,由结算轮尾的自愈在内容到齐后补一笔收敛提交。测试走
/// 真实 actor + 真实仓库:结算与自愈的完整闸门链都在 flush 一条路径上,
/// 单测替不了。

///|
async test "结算对齐:混合批次只提交落齐文件,半途进漂移台账" {
  @async.with_task_group() <| group => {
    let repo = gm_fresh_repo("align-mixed")
    gm_commit(repo, "seed.txt", "seed", "init")
    let config = @core.parse_config(
      "{\"sharedFolders\":[{\"path\":\"\{repo}\",\"id\":\"f1\",\"gitSync\":\"full\"}]}",
    )
    let registry = @cliapp.PeerSessionRegistry::new()
    let (mirror, handle, file) = gm_mirror_repo(
      group,
      config,
      registry,
      @cliapp.PeerSenders::new(),
      repo,
      "f1",
    )
    // a.txt 已落齐;b.txt 半途(索引宣告 'final-b',盘上还是 'half-way')
    gm_land(handle, "f1", repo, "a.txt", "landed-a")
    gm_land(handle, "f1", repo, "b.txt", "final-b")
    @fs.write_file("\{repo}/b.txt", "half-way")
    registry.register("DEV-A", {
      version: None,
      platform: None,
      hostname: None,
      url: None,
    })
    mirror.on_notify(
      gm_notify(
        "DEV-A",
        "f1",
        "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111",
        message="feat: 半途事故",
        changed=["a.txt", "b.txt"],
      ),
      Some("DEV-A"),
    )
    mirror.flush()
    // 镜像提交只含 a.txt;b.txt 没有被定格进去(宁缺勿错)
    // 初始提交 + 只含 a.txt 的镜像提交
    assert_eq(gm_commit_count(repo), 2)
    assert_eq(gm_head_files(repo), ["a.txt"])
    // 通知照常结算,槽位清空
    assert_false(mirror.has_slot("f1"))
    // b.txt 进漂移台账(内存),信息来自来源通知
    let ledger = match mirror.deferred_of("f1") {
      Some(l) => l
      None => panic()
    }
    assert_eq(ledger.hash, "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111")
    assert_eq(ledger.message, "feat: 半途事故")
    assert_eq(ledger.files, ["b.txt"])
    // 台账与磁盘同值(camelCase 契约,与 Node/Rust 同一份 config.json 互读)
    match gm_disk_deferred(file) {
      Some(Json::Object(d)) => {
        match d.get("hash") {
          Some(Json::String(h)) =>
            assert_eq(h, "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111")
          _ => panic()
        }
        match d.get("message") {
          Some(Json::String(m)) => assert_eq(m, "feat: 半途事故")
          _ => panic()
        }
        match d.get("files") {
          Some(Json::Array(items)) => assert_eq(items.length(), 1)
          _ => panic()
        }
      }
      _ => panic()
    }
    let _ = handle.send(@daemon.Cmd::Shutdown)
  }
}

///|
async test "结算对齐:全不对齐不提交但照常结算" {
  @async.with_task_group() <| group => {
    let repo = gm_fresh_repo("align-none")
    gm_commit(repo, "seed.txt", "seed", "init")
    let config = @core.parse_config(
      "{\"sharedFolders\":[{\"path\":\"\{repo}\",\"id\":\"f1\",\"gitSync\":\"full\"}]}",
    )
    let registry = @cliapp.PeerSessionRegistry::new()
    let (mirror, handle, file) = gm_mirror_repo(
      group,
      config,
      registry,
      @cliapp.PeerSenders::new(),
      repo,
      "f1",
    )
    // 两份内容都半途:盘上字节与索引宣告不符(先落齐两份索引声明再写盘半途
    // 内容 —— 扫描是全树入库,后一次扫描会把先写的半途内容重新索引回对齐态)
    gm_land(handle, "f1", repo, "a.txt", "final-a")
    gm_land(handle, "f1", repo, "b.txt", "final-b")
    @fs.write_file("\{repo}/a.txt", "half-a")
    @fs.write_file("\{repo}/b.txt", "half-b")
    registry.register("DEV-A", {
      version: None,
      platform: None,
      hostname: None,
      url: None,
    })
    mirror.on_notify(
      gm_notify(
        "DEV-A",
        "f1",
        "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222",
        message="feat: 全半途",
        changed=["a.txt", "b.txt"],
      ),
      Some("DEV-A"),
    )
    mirror.flush()
    // 宁缺勿错:一笔也不提交;但通知照常结算(槽位清空,不卡队列)
    assert_eq(gm_commit_count(repo), 1)
    assert_false(mirror.has_slot("f1"))
    // 台账收全(内存与磁盘同值)
    let ledger = match mirror.deferred_of("f1") {
      Some(l) => l
      None => panic()
    }
    assert_eq(ledger.files, ["a.txt", "b.txt"])
    assert_eq(ledger.hash, "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222")
    match gm_disk_deferred(file) {
      Some(Json::Object(d)) =>
        match d.get("files") {
          Some(Json::Array(items)) => assert_eq(items.length(), 2)
          _ => panic()
        }
      _ => panic()
    }
    let _ = handle.send(@daemon.Cmd::Shutdown)
  }
}

///|
async test "漂移自愈:落齐补收敛提交,剩余保留,收敛清空台账" {
  @async.with_task_group() <| group => {
    let repo = gm_fresh_repo("heal")
    gm_commit(repo, "seed.txt", "seed", "init")
    let config = @core.parse_config(
      "{\"sharedFolders\":[{\"path\":\"\{repo}\",\"id\":\"f1\",\"gitSync\":\"full\"}]}",
    )
    let registry = @cliapp.PeerSessionRegistry::new()
    let (mirror, handle, file) = gm_mirror_repo(
      group,
      config,
      registry,
      @cliapp.PeerSenders::new(),
      repo,
      "f1",
    )
    registry.register("DEV-A", {
      version: None,
      platform: None,
      hostname: None,
      url: None,
    })
    // 先把两份索引声明落齐,再统一写盘半途内容(扫描是全树入库,后一次扫描
    // 会把先写的半途内容重新索引回对齐态,欠账前提会被冲掉)
    gm_land(handle, "f1", repo, "b.txt", "final-b")
    gm_land(handle, "f1", repo, "c.txt", "final-c")
    // 先欠 b.txt 的账(内容半途 → 结算不提交但照常结算)
    @fs.write_file("\{repo}/b.txt", "half-way")
    mirror.on_notify(
      gm_notify(
        "DEV-A",
        "f1",
        "cccc3333cccc3333cccc3333cccc3333cccc3333",
        message="feat: 台账里的欠账\n\n正文第二行",
        changed=["b.txt"],
      ),
      Some("DEV-A"),
    )
    mirror.flush()
    assert_eq(gm_commit_count(repo), 1)
    // 再欠 c.txt:两笔通知的欠账合并(files 取并集),hash/message 取最新一笔
    @fs.write_file("\{repo}/c.txt", "half-c")
    mirror.on_notify(
      gm_notify(
        "DEV-A",
        "f1",
        "dddd4444dddd4444dddd4444dddd4444dddd4444",
        message="feat: 第二笔欠账",
        changed=["c.txt"],
      ),
      Some("DEV-A"),
    )
    mirror.flush()
    let ledger = match mirror.deferred_of("f1") {
      Some(l) => l
      None => panic()
    }
    assert_eq(ledger.files, ["b.txt", "c.txt"])
    assert_eq(ledger.hash, "dddd4444dddd4444dddd4444dddd4444dddd4444")
    // b.txt 内容落齐:下一拍产生只含 b.txt 的收敛提交,剩余 c.txt 保留。
    // 台账合并后 hash/message 取最新一笔(第二笔欠账),收敛消息引用它。
    @fs.write_file("\{repo}/b.txt", "final-b")
    mirror.flush()
    assert_eq(gm_commit_count(repo), 2)
    assert_eq(
      gm_head_subject(repo),
      "chore: 收敛镜像提交后到达的内容 (dddd4444 feat: 第二笔欠账)",
    )
    assert_eq(gm_head_files(repo), ["b.txt"])
    let ledger = match mirror.deferred_of("f1") {
      Some(l) => l
      None => panic()
    }
    // 未落齐的 c.txt 应保留在台账;剩余欠账保留原来源信息
    assert_eq(ledger.files, ["c.txt"])
    assert_eq(ledger.hash, "dddd4444dddd4444dddd4444dddd4444dddd4444")
    // c.txt 也落齐:再一拍清空台账(内存与磁盘同值)
    @fs.write_file("\{repo}/c.txt", "final-c")
    mirror.flush()
    assert_eq(gm_commit_count(repo), 3)
    // 收敛成功应清空台账(内存与磁盘同值)
    assert_true(gm_is_none(mirror.deferred_of("f1")))
    assert_true(gm_is_none(gm_disk_deferred(file)))
    let _ = handle.send(@daemon.Cmd::Shutdown)
  }
}

///|
async test "漂移台账:盘上残缺记录宁可不认(防御性读)" {
  @async.with_task_group() <| group => {
    // 残缺形态:hash 空 / message 缺失 / files 空 / files 全空串 —— 一律视为无
    // (台账本来就是「等内容到齐」的暂记,残缺记录不能凭它对工作树乱下判断)
    let bads : Array[String] = [
      "{\"hash\":\"\",\"message\":\"x\",\"files\":[\"a.txt\"]}", "{\"hash\":\"h\",\"files\":[\"a.txt\"]}",
      "{\"hash\":\"h\",\"message\":\"x\",\"files\":[]}", "{\"hash\":\"h\",\"message\":\"x\",\"files\":[\"\"]}",
    ]
    let handle = @daemon.start_session_actor(group, "SELF-DEV", []) catch {
      _ => panic()
    }
    let registry = @cliapp.PeerSessionRegistry::new()
    let senders = @cliapp.PeerSenders::new()
    for i, bad in bads {
      gm_seq.val = gm_seq.val + 1
      let file = "/tmp/syncx-mb-gm-\{@daemon.now_ms()}-\{gm_seq.val}-\{i}.json"
      let cfg = "{\"sharedFolders\":[{\"path\":\"/tmp/nope-defer\",\"id\":\"f1\",\"gitSync\":\"full\",\"gitDeferredMirror\":\{bad}}]}"
      @fs.write_file(file, cfg)
      let m = @cliapp.GitMirror::new(
        config_of=() => @core.parse_config(cfg),
        config_file=file,
        registry~,
        senders~,
        handle~,
      )
      m.adopt_pending()
      assert_true(gm_is_none(m.deferred_of("f1")))
    }
    let _ = handle.send(@daemon.Cmd::Shutdown)
  }
}

///|
async test "漂移台账:重启后从盘上恢复,自愈继续" {
  @async.with_task_group() <| group => {
    let repo = gm_fresh_repo("heal-restore")
    gm_commit(repo, "seed.txt", "seed", "init")
    let config = @core.parse_config(
      "{\"sharedFolders\":[{\"path\":\"\{repo}\",\"id\":\"f1\",\"gitSync\":\"full\"}]}",
    )
    let registry = @cliapp.PeerSessionRegistry::new()
    let (mirror, handle, file) = gm_mirror_repo(
      group,
      config,
      registry,
      @cliapp.PeerSenders::new(),
      repo,
      "f1",
    )
    registry.register("DEV-A", {
      version: None,
      platform: None,
      hostname: None,
      url: None,
    })
    gm_land(handle, "f1", repo, "b.txt", "final-b")
    @fs.write_file("\{repo}/b.txt", "half-way")
    mirror.on_notify(
      gm_notify(
        "DEV-A",
        "f1",
        "eeee6666eeee6666eeee6666eeee6666eeee6666",
        message="feat: 重启前的欠账",
        changed=["b.txt"],
      ),
      Some("DEV-A"),
    )
    mirror.flush()
    assert_true(!gm_is_none(mirror.deferred_of("f1")))
    // 「重启」:同一份配置文件上新建镜像(内存台账为空)从盘上记录恢复 ——
    // 与既有 ledger 持久化同一条不变式:内存与 config.json 同值
    let mirror2 = @cliapp.GitMirror::new(
      config_of=() => config,
      config_file=file,
      registry~,
      senders=@cliapp.PeerSenders::new(),
      handle~,
    )
    mirror2.adopt_pending()
    let restored = match mirror2.deferred_of("f1") {
      Some(l) => l
      None => panic()
    }
    assert_eq(restored.hash, "eeee6666eeee6666eeee6666eeee6666eeee6666")
    assert_eq(restored.message, "feat: 重启前的欠账")
    assert_eq(restored.files, ["b.txt"])
    // 恢复后自愈继续:内容落齐 → 收敛提交,台账收敛清空
    @fs.write_file("\{repo}/b.txt", "final-b")
    mirror2.flush()
    assert_eq(gm_commit_count(repo), 2)
    assert_true(
      gm_head_subject(repo).contains(
        "chore: 收敛镜像提交后到达的内容",
      ),
    )
    assert_true(gm_is_none(mirror2.deferred_of("f1")))
    assert_true(gm_is_none(gm_disk_deferred(file)))
    let _ = handle.send(@daemon.Cmd::Shutdown)
  }
}

///|
async test "自动提交失败弹窗:status 折算失败口径,retry 重置计数再结算" {
  @async.with_task_group() <| group => {
    let repo = gm_fresh_repo("status")
    gm_commit(repo, "a.txt", "v1", "init")
    // 残留 index.lock:提交必失败的夹具(与退避测试同款)
    @fs.write_file("\{repo}/.git/index.lock", "stale")
    @fs.write_file("\{repo}/a.txt", "v2")
    let config = @core.parse_config(
      "{\"sharedFolders\":[{\"path\":\"\{repo}\",\"id\":\"f1\",\"gitSync\":\"full\"}]}",
    )
    let registry = @cliapp.PeerSessionRegistry::new()
    registry.register("DEV-A", {
      version: None,
      platform: None,
      hostname: None,
      url: None,
    })
    let (mirror, handle, _) = gm_mirror_repo(
      group,
      config,
      registry,
      @cliapp.PeerSenders::new(),
      repo,
      "f1",
    )
    gm_land(handle, "f1", repo, "a.txt", "v2")
    mirror.on_notify(gm_notify("DEV-A", "f1", "aaaa2222"), Some("DEV-A"))
    mirror.flush()
    assert_eq(mirror.slot_attempts("f1"), 1)
    // status:挂起通知折算 —— pending/attempts/错误口径/消息首行
    let status = mirror.commit_status("f1").unwrap()
    match status {
      Object(o) => {
        assert_eq(o.get("pending"), Some(Json::boolean(true)))
        assert_eq(o.get("attempts"), Some(Json::number(1)))
        assert_eq(
          o.get("commitMessage"),
          Some(Json::string("syncx: 测试提交")),
        )
        assert_true(o.get("givenUp") is Some(False))
        match o.get("error") {
          Some(Object(e)) => assert_true(e.get("message") is Some(String(_)))
          _ => fail("应带最近一次失败原因")
        }
      }
      _ => fail("应为对象")
    }
    // 无通知目录:status None / retry 如实回「没有待提交的通知」
    assert_true(mirror.commit_status("nope") is None)
    let r = mirror.retry_folder("nope")
    match r {
      Object(o) =>
        assert_eq(
          o.get("error"),
          Some(Json::string("没有待提交的通知")),
        )
      _ => fail("应为对象")
    }
    // retry:清零计数与退避立即结算 —— 锁还在,再次失败,ok:false 带原因
    let r = mirror.retry_folder("f1")
    match r {
      Object(o) => {
        assert_true(o.get("ok") is Some(False))
        assert_eq(o.get("attempts"), Some(Json::number(1)))
        match o.get("error") {
          Some(String(msg)) =>
            assert_true(msg.contains("index.lock") || msg.contains("fatal"))
          _ => fail("应带失败原因")
        }
      }
      _ => fail("应为对象")
    }
    assert_true(mirror.has_slot("f1"))
    // 收尾:叫停 actor 常驻循环
    let _ = handle.send(@daemon.Cmd::Shutdown)
  }
}
