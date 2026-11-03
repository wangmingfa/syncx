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
async fn watch_run(
  root : String,
  options : @daemon.FsWatchOptions,
  body : async (@daemon.ActorHandle, @daemon.WatchStats) -> Unit,
) -> Unit raise {
  @async.with_task_group() <| group => {
    let spec = actor_make_spec(root)
    let handle = @daemon.start_session_actor(group, "watch-test-device", [spec])
    let folders : Array[@daemon.FsWatchFolder] = [
      { id: "f1", root, paused: false },
    ]
    let stats = @daemon.start_fs_watch(group, handle, folders, options)
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
