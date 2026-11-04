///|
/// fsWatch 监督器测试:在 /tmp 临时目录上跑真实的文件系统事件(macOS
/// kqueue / Linux inotify),actor 走 `start_session_actor` 的真实装配。
/// 观测口径有两个:
///  - 快照 entries:事件触发扫描后,文件经 executor 入索引库,publish 上报;
///  - WatchStats(starts/rebuilds/degrades):监督器自身的启动/重建/降级轨迹。
/// 所有断言都走带超时的轮询 —— 事件驱动是异步的,轮询超时让平台节奏差异
/// 表现为断言失败而不是挂死。防抖用 100ms 短窗口「真实等」一批事件塌缩。

///|
/// 测试用短节奏选项:防抖 100ms;兜底全扫 2s(watcher 失灵时的最后防线,
/// 也是存量文件的基准轮);存活探针 100ms;降级重试/纯定时 100ms。
fn watch_test_options() -> @daemon.FsWatchOptions {
  {
    enabled: true,
    fallback_scan_ms: 2_000,
    debounce_ms: 100,
    debounce_max_ms: 200,
    alive_probe_ms: 100,
    degraded_scan_ms: 100,
  }
}

///|
/// 起一个「真实 actor + 监督器」的最小装配并在任务组内跑 body;返回前投递
/// Shutdown(actor 退出关队列),watcher 任务随组收尾取消。清理放在任务组
/// 结束之后 —— watcher 已停值,删除目录不再触发扫描事件/墓碑落地。
/// `ignore_lines` 给 actor 扫描器与默认过滤谓词同一套规则行(同源判据);
/// `folders_of` 供谓词热替换测试注入自管清单(谓词可随时间变化),给出时
/// 忽略 ignore_lines 的谓词侧,由清单自带 filter。
async fn watch_run(
  root : String,
  options : @daemon.FsWatchOptions,
  body : async (@daemon.ActorHandle, @daemon.WatchStats) -> Unit,
  ignore_lines~ : Array[String] = [],
  folders_of~ : (() -> Array[@daemon.FsWatchFolder])? = None,
) -> Unit raise {
  @async.with_task_group() <| group => {
    let spec = actor_make_spec(root, ignore_lines~)
    let handle = @daemon.start_session_actor(group, "watch-test-device", [spec])
    let folders : Array[@daemon.FsWatchFolder] = [
      {
        id: "f1",
        root,
        paused: false,
        filter: Some(
          @daemon.event_ignore_filter(@core.IgnoreRuleset::from_lines(ignore_lines)),
        ),
      },
    ]
    let supplier : () -> Array[@daemon.FsWatchFolder] = match folders_of {
      Some(f) => f
      None => () => folders
    }
    let stats = @daemon.start_fs_watch(group, handle, supplier, options)
    body(handle, stats)
    let _ = handle.send(@daemon.Cmd::Shutdown)
  }
  watch_cleanup(root)
}

///|
/// 测试专属临时根目录(目录名带毫秒戳,各测试独占)。
async fn watch_fresh_root(tag : String) -> String {
  let root = "/tmp/syncx-mb-watch-\{tag}-\{@daemon.now_ms()}"
  @fs.mkdir(root, recursive=true, allow_exist=true)
  root
}

///|
/// 带超时的条件轮询:条件成立即返回 true;超时返回最后一次判定
/// (调用方直接 assert_true,失败信息就是「等了 10s 也没等到」)。
async fn watch_poll(
  cond : () -> Bool,
  timeout_ms~ : Int = 10_000,
) -> Bool {
  let deadline = @daemon.now_ms() + timeout_ms.to_int64()
  while @daemon.now_ms() < deadline {
    if cond() {
      return true
    }
    @async.sleep(20)
  }
  cond()
}

///|
/// 轮询等待某目录的索引条目数达到期望(sync_snapshot 是 async 往返,
/// 不能塞进 sync 谓词闭包,单独成环)。
async fn watch_poll_entries(
  handle : @daemon.ActorHandle,
  want : Int64,
  timeout_ms~ : Int = 10_000,
) -> Bool {
  let deadline = @daemon.now_ms() + timeout_ms.to_int64()
  while @daemon.now_ms() < deadline {
    let snapshot = handle.sync_snapshot()
    for folder in snapshot.folders {
      if folder.entries == want {
        return true
      }
    }
    @async.sleep(20)
  }
  let snapshot = handle.sync_snapshot()
  for folder in snapshot.folders {
    if folder.entries == want {
      return true
    }
  }
  false
}

///|
/// 清掉测试目录树(共享根 + 索引状态目录);watcher 可能还在值班,删除
/// 触发的事件只是让 actor 多扫一轮空目录,无副作用。
async fn watch_cleanup(root : String) -> Unit {
  @fs.rmdir(root, recursive=true) catch { _ => () }
  @fs.rmdir("\{root}-state", recursive=true) catch { _ => () }
}

///|
test "FsWatchOptions::from_config 按配置折算" {
  // 旧配置无字段:监听开、兜底 600s、降级节奏 = 原扫描间隔
  let options = @daemon.FsWatchOptions::from_config(@core.parse_config("{}"))
  assert_true(options.enabled)
  assert_eq(options.fallback_scan_ms, 600_000)
  assert_eq(options.debounce_ms, @daemon.FS_WATCH_DEBOUNCE_MS)
  assert_eq(
    options.degraded_scan_ms,
    @daemon.DEGRADED_SCAN_INTERVAL_MS,
  )
  // 显式配置生效;间隔带上限(防配置笔误顶到溢出量级)
  let custom = @daemon.FsWatchOptions::from_config(
    @core.parse_config(
      "{\"fsWatchEnabled\":false,\"fsWatchFallbackScanSecs\":900}",
    ),
  )
  assert_false(custom.enabled)
  assert_eq(custom.fallback_scan_ms, 900_000)
  let capped = @daemon.FsWatchOptions::from_config(
    @core.parse_config("{\"fsWatchFallbackScanSecs\":999999999}"),
  )
  assert_eq(capped.fallback_scan_ms, 86_400_000)
}

///|
async test "fsWatch:文件事件防抖后触发该目录重扫" {
  let root = watch_fresh_root("basic")
  // 空目录起家:watcher 启动后再写文件,保证事件一定来自「本次写入」
  watch_run(root, watch_test_options(), (handle, stats) => {
    assert_true(
      watch_poll(() => stats.start_count() >= 1, timeout_ms=5_000),
      msg="watcher 应在 5s 内启动",
    )
    @fs.write_file("\{root}/a.txt", "alpha", create_mode=CreateOrTruncate)
    // 事件路径必须明显快于 2s 的兜底定时器,否则说明事件没驱动扫描
    assert_true(
      watch_poll_entries(handle, 1L, timeout_ms=1_500),
      msg="写入 a.txt 后 1.5s 内应经事件触发扫描入索引",
    )
    @fs.write_file("\{root}/b.txt", "beta", create_mode=CreateOrTruncate)
    assert_true(
      watch_poll_entries(handle, 2L, timeout_ms=1_500),
      msg="写入 b.txt 后 1.5s 内应再次经事件触发扫描",
    )
  })
}

///|
async test "fsWatch:watcher 创建失败降级,目录就绪后自动恢复" {
  // 故障注入:root 先是一个普通文件,@fs.Watcher 构造必然 ENOTDIR 失败
  let root = "/tmp/syncx-mb-watch-degrade-\{@daemon.now_ms()}"
  @fs.write_file(root, "not a directory", create_mode=CreateOrTruncate)
  watch_run(root, watch_test_options(), (handle, stats) => {
    assert_true(
      watch_poll(() => stats.degrade_count() >= 1, timeout_ms=5_000),
      msg="非目录根上建 watcher 应失败并进入降级",
    )
    assert_eq(stats.start_count(), 0)
    // 目录就位:下一次降级重试应建出 watcher 并接管
    @fs.remove(root)
    @fs.mkdir(root, recursive=true, allow_exist=true)
    assert_true(
      watch_poll(() => stats.start_count() >= 1, timeout_ms=5_000),
      msg="目录创建后 watcher 应自动建起来(不再停留降级)",
    )
    @fs.write_file("\{root}/a.txt", "alpha", create_mode=CreateOrTruncate)
    assert_true(
      watch_poll_entries(handle, 1L, timeout_ms=1_500),
      msg="恢复后写入的文件应经事件触发扫描入索引",
    )
  })
}

///|
async test "fsWatch:目录被删后 watcher 失效重建,恢复事件驱动扫描" {
  // 先有存量文件再起监督器:兜底定时器首轮立即扫,把它作为基准
  let root = watch_fresh_root("rebuild")
  @fs.write_file("\{root}/a.txt", "alpha", create_mode=CreateOrTruncate)
  watch_run(root, watch_test_options(), (handle, stats) => {
    assert_true(
      watch_poll_entries(handle, 1L, timeout_ms=5_000),
      msg="存量文件应由首轮兜底扫描入索引",
    )
    // 等 watcher 真正盯着**原目录**再动手:否则删除可能发生在建 watcher
    // 之前,后面的「失效重建」就无从谈起
    assert_true(
      watch_poll(() => stats.start_count() >= 1, timeout_ms=5_000),
      msg="watcher 应在删除前已启动",
    )
    // 整树删除,并让缺席状态保持到探针观测到为止:wait 对「根目录被删」的
    // 行为平台相关(macOS kqueue 可能既不报错也不再来事件),存活探针会在
    // 超时片发现根目录没了 → 失效重建分支;缺席期间重建尝试失败 → 降级
    @fs.rmdir(root, recursive=true)
    assert_true(
      watch_poll(() => stats.rebuild_count() >= 1, timeout_ms=10_000),
      msg="目录缺席应被探针发现并计入重建统计",
    )
    // 原地重建:降级期的周期重试应建出新 watcher 接管
    @fs.mkdir(root, recursive=true, allow_exist=true)
    assert_true(
      watch_poll(() => stats.start_count() >= 2, timeout_ms=10_000),
      msg="目录重建后 watcher 应重建(启动次数 ≥ 2)",
    )
    @fs.write_file("\{root}/b.txt", "beta", create_mode=CreateOrTruncate)
    // 收敛态:缺席期的周期扫描已把 a.txt 落成墓碑(deleted=1 不计 entries),
    // b.txt 经事件扫描入索引 → entries==1 且墓碑 ≥ 1。中间态可能短暂出现
    // entries==2(b.txt 先于 a.txt 墓碑被扫到),收敛判定与竞争顺序无关
    assert_true(
      watch_poll(
        () => {
          let snapshot = handle.snapshot()
          for folder in snapshot.folders {
            if folder.entries == 1L && folder.tombstones >= 1L {
              return true
            }
          }
          false
        },
        timeout_ms=3_000,
      ),
      msg="重建后 b.txt 应经事件扫描入索引,a.txt 应已落墓碑",
    )
  })
}

///|
async test "fsWatch:配置关闭后为纯定时全扫,不建 watcher" {
  let root = watch_fresh_root("off")
  @fs.write_file("\{root}/a.txt", "alpha", create_mode=CreateOrTruncate)
  let options : @daemon.FsWatchOptions = {
    enabled: false,
    fallback_scan_ms: 2_000,
    debounce_ms: 100,
    debounce_max_ms: 200,
    alive_probe_ms: 100,
    degraded_scan_ms: 100,
  }
  watch_run(root, options, (handle, stats) => {
    // 关闭形态不建任何 watcher
    assert_eq(stats.start_count(), 0)
    // 纯定时首轮立即扫(与接 watcher 之前的启动行为一致)
    assert_true(
      watch_poll_entries(handle, 1L, timeout_ms=1_500),
      msg="关闭监听后应按周期全扫把存量文件入索引",
    )
    // 周期节奏(100ms)追上后续写入
    @fs.write_file("\{root}/b.txt", "beta", create_mode=CreateOrTruncate)
    assert_true(
      watch_poll_entries(handle, 2L, timeout_ms=1_500),
      msg="周期全扫应追上后续写入",
    )
  })
}

///|
/// 轮询等待某路径的索引内容块与基线不同(事件驱动的重扫会更新指纹;
/// 无重扫则指纹冻结 —— 过滤压制的可观测判据)。
async fn watch_poll_blocks_changed(
  handle : @daemon.ActorHandle,
  path : String,
  baseline : Array[String],
  timeout_ms~ : Int = 5_000,
) -> Bool {
  let deadline = @daemon.now_ms() + timeout_ms.to_int64()
  while @daemon.now_ms() < deadline {
    for entry in handle.entry_lookup("f1", [path]) {
      if entry.path == path && entry.blocks != baseline {
        return true
      }
    }
    @async.sleep(20)
  }
  false
}

///|
/// 取某路径当前索引条目的内容块哈希(无条目返回空表)。
async fn watch_blocks_of(handle : @daemon.ActorHandle, path : String) -> Array[String] {
  for entry in handle.entry_lookup("f1", [path]) {
    if entry.path == path {
      return entry.blocks
    }
  }
  []
}

///|
test "normalize_watch_event_path:事件路径形态防御归一化(对齐 Node normalizeWatchFilename)" {
  // 常规根相对路径原样通过
  assert_eq(
    @daemon.normalize_watch_event_path("a.txt", "/tmp/x"),
    Some("a.txt"),
  )
  assert_eq(
    @daemon.normalize_watch_event_path("src/a.txt", "/tmp/x"),
    Some("src/a.txt"),
  )
  // 反斜杠一律转 '/'
  assert_eq(
    @daemon.normalize_watch_event_path("src\\a.txt", "/tmp/x"),
    Some("src/a.txt"),
  )
  // 绝对路径:挂在监听根之下则剥前缀;剥不上(别的根/别的盘)→ None
  assert_eq(
    @daemon.normalize_watch_event_path("/tmp/x/src/a.txt", "/tmp/x"),
    Some("src/a.txt"),
  )
  assert_eq(@daemon.normalize_watch_event_path("/tmp/y/a.txt", "/tmp/x"), None)
  assert_eq(@daemon.normalize_watch_event_path("C:/x/a.txt", "/tmp/x"), None)
  // './' 前缀剥掉
  assert_eq(
    @daemon.normalize_watch_event_path("./a.txt", "/tmp/x"),
    Some("a.txt"),
  )
  assert_eq(
    @daemon.normalize_watch_event_path("././a.txt", "/tmp/x"),
    Some("a.txt"),
  )
  // '..' 段 / 空串不可信 → None(调用方按「无路径」放行)
  assert_eq(@daemon.normalize_watch_event_path("a/../b.txt", "/tmp/x"), None)
  assert_eq(@daemon.normalize_watch_event_path("..", "/tmp/x"), None)
  assert_eq(@daemon.normalize_watch_event_path("", "/tmp/x"), None)
  // 监听根自身的尾斜杠剥掉后再比对
  assert_eq(
    @daemon.normalize_watch_event_path("/tmp/x/a.txt", "/tmp/x/"),
    Some("a.txt"),
  )
}

///|
test "event_ignore_filter:硬忽略闸门 + 目录规则一套判据(与扫描同源)" {
  let rules = @core.IgnoreRuleset::from_lines(["node_modules/", "!.git", "logs"])
  let filter = @daemon.event_ignore_filter(rules)
  // 硬忽略闸门独立于规则:.git 命中硬忽略,`!.git` 负向规则解不开
  // (Node 同红线:必须走含硬忽略闸门的 isIgnoredPath,否则 `!.git`
  // 会把 .git 重新放开)
  assert_true(filter(".git/index"), msg=".git/index 必须被硬忽略闸门滤掉")
  assert_true(filter(".git"), msg=".git 自身必须被滤")
  // 目录规则经前缀回溯命中被忽略目录下的文件
  assert_true(filter("node_modules/x"), msg="node_modules/x 应被目录规则滤掉")
  assert_true(filter("node_modules/a/b.js"), msg="更深层的文件同样滤掉")
  // 被忽略目录自身的孤立事件:dir-only 规则按文件语义判 → 放行
  // (宁可多扫,不冒吞掉整棵子树变化的风险)
  assert_false(filter("node_modules"), msg="node_modules 自身的孤立事件应放行")
  // 非 dir-only 规则按任意段命中
  assert_true(filter("logs"), msg="logs 应被非目录规则滤掉")
  assert_true(filter("logs/a.txt"), msg="logs 下的文件应被滤掉")
  // 同步文件照常放行(过滤仅限忽略范围)
  assert_false(filter("a.txt"), msg="同步文件自身写入的事件必须放行")
  assert_false(filter("src/a.txt"), msg="普通路径必须放行")
}

///|
async test "fsWatch:忽略规则命中的事件在触发前被丢弃,同步文件照常触发" {
  let root = watch_fresh_root("filter")
  // 被忽略目录在 watcher 启动**前**建好:init 扫描即把它纳入监视树
  // (用户级规则不做树级剪枝),写入其内文件的事件因此确定到达 ——
  // 随后验证的是「事件到达但被谓词丢弃」,而不是「根本没有事件」
  @fs.mkdir("\{root}/node_modules", recursive=true, allow_exist=true)
  // 目录规则 node_modules/:扫描器与过滤谓词同源(actor 不索引该子树,
  // 监听层滤掉它的事件)
  watch_run(
    root,
    watch_test_options(),
    (handle, stats) => {
      assert_true(
        watch_poll(() => stats.start_count() >= 1, timeout_ms=5_000),
        msg="watcher 应在 5s 内启动",
      )
      @fs.write_file("\{root}/a.txt", "alpha", create_mode=CreateOrTruncate)
      assert_true(
        watch_poll_entries(handle, 1L, timeout_ms=1_500),
        msg="写入 a.txt 后应经事件触发扫描入索引",
      )
      // 被忽略目录内的文件:事件到达但被谓词丢弃,不打脏位、不触发重扫
      @fs.write_file("\{root}/node_modules/x", "x", create_mode=CreateOrTruncate)
      assert_true(
        watch_poll(() => stats.drop_count() >= 1, timeout_ms=3_000),
        msg="node_modules/x 的事件应被谓词丢弃并计数",
      )
      assert_true(
        watch_poll_entries(handle, 1L, timeout_ms=500),
        msg="忽略子树写入不得改变索引条目数",
      )
      // 再写一个忽略文件:丢弃计数继续上涨(事件源仍在刷,只是不再触发扫描)
      let before = stats.drop_count()
      @fs.write_file("\{root}/node_modules/y", "y", create_mode=CreateOrTruncate)
      assert_true(
        watch_poll(() => stats.drop_count() > before, timeout_ms=3_000),
        msg="继续写忽略文件应继续计入丢弃",
      )
      // 语义红线:过滤仅限忽略范围,同步文件自身写入照常触发
      @fs.write_file("\{root}/b.txt", "beta", create_mode=CreateOrTruncate)
      assert_true(
        watch_poll_entries(handle, 2L, timeout_ms=1_500),
        msg="丢弃发生后,同步文件写入仍应照常触发扫描",
      )
    },
    ignore_lines=["node_modules/"],
  )
}

///|
async test "fsWatch:谓词对账热替换,规则修改即刻生效" {
  let root = watch_fresh_root("hotswap")
  // 被忽略目录在 watcher 启动前建好:init 扫描即纳入监视树,后续写入其内
  // 文件的事件确定到达(用户级规则不做树级剪枝,事件级谓词才是过滤挂点)
  @fs.mkdir("\{root}/node_modules", recursive=true, allow_exist=true)
  // 谓词格子由测试持有:对账循环每拍把供应者清单里的最新谓词换进格子,
  // 值守任务按批现查 —— 换内容即换谓词,不重建 watcher(对齐 Node
  // 「回调现查表、对账换入」的热替换语义)
  let filter_cell : Ref[((String) -> Bool)?] = Ref(None)
  let supplier : () -> Array[@daemon.FsWatchFolder] = () => [
    { id: "f1", root, paused: false, filter: filter_cell.val },
  ]
  // 兜底全扫抬高到断言窗口之外:指纹冻结断言不允许任何额外扫描源干扰
  let options : @daemon.FsWatchOptions = {
    ..watch_test_options(),
    fallback_scan_ms: 60_000,
  }
  // actor 扫描规则为空:node_modules/x 会被正常索引,「重扫是否发生」
  // 因此可以通过内容指纹直接观测
  watch_run(
    root,
    options,
    (handle, stats) => {
      assert_true(
        watch_poll(() => stats.start_count() >= 1, timeout_ms=5_000),
        msg="watcher 应在 5s 内启动",
      )
      // 阶段一:谓词缺省(不过滤),node_modules/x 照常入索引
      @fs.write_file("\{root}/a.txt", "alpha", create_mode=CreateOrTruncate)
      @fs.write_file("\{root}/node_modules/x", "v1", create_mode=CreateOrTruncate)
      assert_true(
        watch_poll_entries(handle, 2L, timeout_ms=5_000),
        msg="不过滤阶段 node_modules/x 应照常入索引",
      )
      let baseline = watch_blocks_of(handle, "node_modules/x")
      let a_before = watch_blocks_of(handle, "a.txt")
      // 阶段二:热替换谓词为「忽略 node_modules/」,等对账拍换入格子
      filter_cell.val = Some(
        @daemon.event_ignore_filter(
          @core.IgnoreRuleset::from_lines(["node_modules/"]),
        ),
      )
      @async.sleep(500)
      // 阶段三:改写 node_modules/x —— 事件被新谓词丢弃,重扫不发生,
      // 内容指纹定格在旧值
      @fs.write_file(
        "\{root}/node_modules/x",
        "v2-much-longer-content",
        create_mode=CreateOrTruncate,
      )
      assert_true(
        watch_poll(() => stats.drop_count() >= 1, timeout_ms=3_000),
        msg="热替换后 node_modules/x 的事件应被丢弃",
      )
      @async.sleep(300)
      assert_true(
        watch_blocks_of(handle, "node_modules/x") == baseline,
        msg="热替换后 node_modules/x 的内容指纹应冻结(重扫被过滤压制)",
      )
      // 阶段四:同步文件写入照常触发,指纹照常更新(过滤仅限忽略范围)
      @fs.write_file("\{root}/a.txt", "alpha-v2", create_mode=CreateOrTruncate)
      assert_true(
        watch_poll_blocks_changed(handle, "a.txt", a_before),
        msg="热替换后同步文件写入仍应触发重扫并更新指纹",
      )
    },
    folders_of=Some(supplier),
  )
}
