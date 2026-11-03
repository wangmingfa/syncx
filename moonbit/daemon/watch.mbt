///|
/// 文件系统监听驱动的扫描 + 定时兜底全扫(ADR-0026 集成层;三端统一契约,
/// 对应 Node `src/cli.ts` 周期扫描段的升级形态)。
///
/// 架构契约:
///  - 每个「未暂停」的共享目录一条 `@fs.Watcher`(递归监听整棵树)。身份校验
///    门禁(folderIdentity 收养)落地前暂以 paused 为闸,与 cli 装配层 TODO 同步;
///  - 事件只当**触发器**:判定(相对路径拼接、diff、墓碑、忽略、嵌套共享根)
///    完全走 scanner.mbt 现有管线,这里不复制任何判定逻辑;
///  - 事件聚合防抖靠 `@fs.Watcher` 自带的 debounce(debounce_timeout = 事件静默
///    满这么久才把这批交给 wait();max_debounce_delay = 自首批事件起的强制冲刷
///    上限,连续事件流不能一直憋着):wait() 返回的一批事件塌缩成该目录**一次**
///    重扫。重入闸与现有语义一致 —— actor 单线程命令循环串行处理 ScanFolder,
///    重扫天然互斥;自己写入也产生事件,不过滤,聚合后重扫幂等;
///  - 定时兜底全扫:watcher 正常时按 fsWatchFallbackScanSecs(缺省 600s,可配置)
///    对一次总账;watcher 创建失败/不可用 → 该目录退回原扫描间隔
///    (DEGRADED_SCAN_INTERVAL_MS,接 watcher 之前的 30s 节奏)并 warn 一次;
///    fsWatchEnabled=false → 纯定时全扫,行为与接 watcher 之前完全一致;
///  - watcher 失效(目录被删重建):close 后重建 + 立即触发该目录扫描;目录
///    消失期间由「重建重试的降级节奏 + 兜底定时器」顶着,不崩。失效检测与
///    平台无关:wait 抛错按失效,wait 挂着不动(部分后端对根目录被删无反应)
///    则由存活探针定期查根目录还在不在。
///
/// 日志:watcher 启动/重建 info;事件批聚合数超阈值才记(平时零噪声);
/// 降级 warn 一次(同一段失效期内不刷屏,恢复后再次失效会重新 warn)。
/// 通道沿用 daemon 现状:标准输出 println。

///|
/// watcher 启动/重建的 info 日志前缀(daemon 尚无分级 logger,统一用标签)。
const WATCH_LOG_TAG : String = "[watch]"

///|
/// 事件防抖静默窗口毫秒:`@fs.Watcher` 的 debounce_timeout 语义是「事件静默满
/// 这么久才把这批交给 wait()」。取 2s:写完一个文件到触发重扫最多再等 2s,
/// 而解压整棵树、git 操作这类连续事件流能在窗口内塌缩成一批。
pub const FS_WATCH_DEBOUNCE_MS : Int = 2000

///|
/// 根目录存活探针间隔毫秒:`wait()` 对「被监听根目录本身被删」的行为是平台
/// 相关的(文档明说 undefined)——macOS kqueue 在事件批已交付后可能既不报错
/// 也不再给事件,wait 会无限挂起。把 wait 用超时切成片,每片结束探一次根目录
/// 还在不在,失效检测因此与平台无关。探针按**路径存在性**判定:删除与重建
/// 都落在同一片内、且目录内容原样的情形属于理论盲区(索引本就与盘一致,
/// 无需重扫),由兜底全扫兜住;任何跨探针片的删除/重建都走失效重建。
/// 生产 1s 足够;测试调短。
pub const FS_WATCH_ALIVE_PROBE_MS : Int = 1000

///|
/// 防抖强制冲刷上限毫秒(`max_debounce_delay`):持续不断的写入(比如对端
/// 回放大批文件)下,静默窗口永远凑不满,超过上限就把手头的事件冲出来,
/// 不让重扫无限滞后。取静默窗口的 2 倍。
pub const FS_WATCH_DEBOUNCE_MAX_MS : Int = 2 * FS_WATCH_DEBOUNCE_MS

///|
/// 降级周期全扫间隔毫秒:接 watcher 之前的原扫描节奏(cli 装配层原先写死的
/// 30s)。watcher 创建失败/不可用,以及 fsWatchEnabled=false 的纯定时形态,
/// 都退回这个间隔。
pub const DEGRADED_SCAN_INTERVAL_MS : Int = 30_000

///|
/// 单批事件聚合数的日志阈值:一批事件少于这个数不值得一行日志
/// (保存文件就是一两个事件,重扫是例行公事);超过阈值说明刚发生了
/// 批量动作(解压/检出/批量删除),点名出来供排查。
const WATCH_EVENT_LOG_THRESHOLD : Int = 32

///|
/// 兜底全扫间隔的折算上限(秒):一日已覆盖任何合理的兜底节奏,同时防配置
/// 笔误把间隔顶到 sleep 参数溢出的量级。
const FS_WATCH_FALLBACK_SECS_CAP : Int32 = 86400

///|
/// 一个被监听共享目录的最小描述(id 定位 actor 里的目录,root 建监听)。
pub(all) struct FsWatchFolder {
  id : String
  root : String
  paused : Bool
}

///|
/// 监督器运行参数。生产用 `FsWatchOptions::new` / `FsWatchOptions::from_config`
/// 构造;测试直接写字面量调短节奏。
pub(all) struct FsWatchOptions {
  /// 总开关(fsWatchEnabled;false = 不建 watcher,纯定时全扫)。
  enabled : Bool
  /// 兜底全扫间隔毫秒(生产 = fsWatchFallbackScanSecs × 1000)。
  fallback_scan_ms : Int
  /// 事件防抖静默窗口毫秒(@fs.Watcher debounce_timeout)。
  debounce_ms : Int
  /// 防抖强制冲刷上限毫秒(@fs.Watcher max_debounce_delay)。
  debounce_max_ms : Int
  /// 根目录存活探针间隔毫秒(wait 分片等待的切片长度)。
  alive_probe_ms : Int
  /// 降级周期全扫间隔毫秒(watcher 不可用或整体关闭时;生产 = 原扫描间隔)。
  degraded_scan_ms : Int
}

///|
/// 按全局配置折算监督器参数(enabled / fallback_scan_secs 来自 config.json
/// 的 fsWatchEnabled / fsWatchFallbackScanSecs,清洗与缺省值在 core)。
pub fn FsWatchOptions::from_config(config : @core.Config) -> FsWatchOptions {
  FsWatchOptions::new(
    enabled=config.fs_watch_enabled(),
    fallback_scan_secs=config.fs_watch_fallback_scan_secs(),
  )
}

///|
/// 生产缺省参数:监听开、兜底 600s、防抖 2s、降级节奏 = 原扫描间隔。
pub fn FsWatchOptions::new(
  enabled~ : Bool = true,
  fallback_scan_secs~ : Int32 = @core.FS_WATCH_FALLBACK_SCAN_SECS,
) -> FsWatchOptions {
  let secs = if fallback_scan_secs < 1 {
    1
  } else if fallback_scan_secs > FS_WATCH_FALLBACK_SECS_CAP {
    FS_WATCH_FALLBACK_SECS_CAP
  } else {
    fallback_scan_secs
  }
  {
    enabled,
    fallback_scan_ms: secs * 1000,
    debounce_ms: FS_WATCH_DEBOUNCE_MS,
    debounce_max_ms: FS_WATCH_DEBOUNCE_MAX_MS,
    alive_probe_ms: FS_WATCH_ALIVE_PROBE_MS,
    degraded_scan_ms: DEGRADED_SCAN_INTERVAL_MS,
  }
}

///|
/// 运行统计(诊断与测试观测):单线程事件循环内读写,无锁。
pub struct WatchStats {
  priv mut starts : Int
  priv mut rebuilds : Int
  priv mut degrades : Int
}

///|
/// watcher 创建成功的总次数(启动 + 重建;≥ 2 即发生过重建)。
pub fn WatchStats::start_count(self : WatchStats) -> Int {
  self.starts
}

///|
/// watcher 失效断裂的次数(wait 出错走重建分支;诊断用)。
pub fn WatchStats::rebuild_count(self : WatchStats) -> Int {
  self.rebuilds
}

///|
/// 进入降级扫描的失效期次数(每次失效期 warn 一次;诊断用)。
pub fn WatchStats::degrade_count(self : WatchStats) -> Int {
  self.degrades
}

///|
/// 起「文件系统监听 + 定时兜底」监督器:返回运行统计(cli 侧可忽略;
/// 测试用来观测启动/重建/降级)。
///
/// 目录列表由装配层给定(通常来自 config.sharedFolders);暂停目录不建
/// watcher(扫描侧本就跳过它们),但仍在兜底定时器名册里 —— 是否真扫由
/// actor 的 paused 闸决定,与接 watcher 之前的纯定时行为一致。
pub fn start_fs_watch(
  group : @async.TaskGroup[Unit],
  handle : ActorHandle,
  folders : Array[FsWatchFolder],
  options : FsWatchOptions,
) -> WatchStats {
  let stats : WatchStats = { starts: 0, rebuilds: 0, degrades: 0 }
  let ids : Array[String] = []
  for folder in folders {
    ids.push(folder.id)
  }
  if !options.enabled {
    // 配置关闭:纯定时全扫,节奏 = 原扫描间隔,行为与接 watcher 之前一致
    println(
      "\{WATCH_LOG_TAG} fsWatchEnabled=false,按原 \{options.degraded_scan_ms}ms 周期定时全扫",
    )
    let interval = options.degraded_scan_ms
    group.spawn_bg(allow_failure=true, no_wait=true) <| () => {
      fallback_scan_loop(handle, ids, interval)
    }
    return stats
  }
  // 兜底全扫定时器:watcher 再可靠也有内核截断/overflow/竞态窗口,隔一段
  // 时间全量对一次账。首轮立即扫(与接 watcher 之前的启动行为一致,
  // 也给 watcher 建好之前的存量文件一个基准)。
  let fallback_ms = options.fallback_scan_ms
  group.spawn_bg(allow_failure=true, no_wait=true) <| () => {
    fallback_scan_loop(handle, ids, fallback_ms)
  }
  // 每个未暂停目录一条 watcher 常驻任务
  for folder in folders {
    if folder.paused {
      continue
    }
    let f = folder
    group.spawn_bg(allow_failure=true, no_wait=true) <| () => {
      folder_watch_loop(handle, f, options, stats)
    }
  }
  stats
}

///|
/// 兜底全扫循环:先扫后睡(首轮立即,保住「启动即扫一遍」的旧语义);
/// actor 队列已关 = 退出。
async fn fallback_scan_loop(
  handle : ActorHandle,
  folder_ids : Array[String],
  interval_ms : Int,
) -> Unit {
  for ;; {
    for id in folder_ids {
      if !handle.send(Cmd::ScanFolder(id)) {
        return
      }
    }
    @async.sleep(interval_ms)
  }
}

///|
/// 单目录 watcher 常驻循环:建 watcher → 值守到失效 → 重建;建不出来
/// (目录缺失/不是目录/平台不支持)→ 降级为原节奏周期全扫,并周期性重试。
async fn folder_watch_loop(
  handle : ActorHandle,
  folder : FsWatchFolder,
  options : FsWatchOptions,
  stats : WatchStats,
) -> Unit {
  // 降级警告只发一次:同一段失效期内不刷屏;恢复(建出 watcher)后再次
  // 失效会重新 warn 并计入新的失效期
  let mut warned = false
  for ;; {
    match make_folder_watcher(folder.root, options) {
      Some(watcher) => {
        warned = false
        stats.starts += 1
        println(
          "\{WATCH_LOG_TAG} 目录 \{folder.id} 的文件系统监听已启动(\{folder.root})",
        )
        watch_until_broken(handle, folder, watcher, options)
        // 到这里 = watcher 失效(目录被删 / 句柄出错):立即补一次该目录扫描
        // (目录若被原地重建,这一刀把存量对上账),随后回循环顶端重建
        stats.rebuilds += 1
        if !handle.send(Cmd::ScanFolder(folder.id)) {
          return
        }
        println("\{WATCH_LOG_TAG} 目录 \{folder.id} 的监听已失效,关闭后重建")
      }
      None => {
        if !warned {
          stats.degrades += 1
          println(
            "\{WATCH_LOG_TAG} [warn] 目录 \{folder.id}(\{folder.root})无法建文件系统监听,退回 \{options.degraded_scan_ms}ms 周期全扫",
          )
          warned = true
        }
        // 降级节奏全扫 + 重试建 watcher:目录只是暂时缺席(未挂载/重建中)
        // 时,两条路都能在目录回来后自动接上
        @async.sleep(options.degraded_scan_ms)
        if !handle.send(Cmd::ScanFolder(folder.id)) {
          return
        }
      }
    }
  }
}

///|
/// 建一个目录 watcher:递归监听整棵树;硬忽略路径(.git/.git-rewrite/.svn、
/// 在途中间态、冲突副本等)直接不进监视树 —— 与扫描管线同一道闸,既省
/// watch 描述符,也免掉自家接收中间态写入的噪声。失败(目录不存在/不是
/// 目录/平台不支持)如实返回 None,由调用方降级重试。
async fn make_folder_watcher(
  root : String,
  options : FsWatchOptions,
) -> @fs.Watcher? {
  let debounce = options.debounce_ms
  let debounce_max = options.debounce_max_ms
  Some(
    @fs.Watcher(
      root,
      debounce_timeout=debounce,
      max_debounce_delay=debounce_max,
      ignored_paths=hard_ignored_rel,
    ),
  ) catch {
    _ => None
  }
}

///|
/// watcher 的 ignored_paths 回调:相对路径(`/` 分隔)按硬忽略口径判定。
fn hard_ignored_rel(rel : String) -> Bool {
  @core.is_hard_ignored(rel)
}

///|
/// 一片等待的结果:有事件 / 无事但根仍在(继续等)/ 失效。
priv enum WatchSlice {
  Events(Array[@fs.FsEvent])
  Quiet
  Broken
}

///|
/// 等一片事件:wait() 被超时切成不超过 probe_ms 的片 —— 片内 wait 正常返回
/// 就交出事件批;超时则探一次根目录存活(目录被删在部分后端上既不报错也
/// 不再来事件,只靠探针兜住);wait 抛错(OSError 等)按失效处理。
/// `@fs.Watcher::wait` 是取消安全的:超时取消不消费任何事件,切片不丢事件。
async fn watch_wait_slice(
  watcher : @fs.Watcher,
  root : String,
  probe_ms : Int,
) -> WatchSlice {
  try {
    Events(@async.with_timeout(probe_ms, () => watcher.wait()))
  } catch {
    @async.TimeoutError => {
      let kind = @fs.kind(root) catch { _ => Unknown }
      if kind is Directory {
        Quiet
      } else {
        Broken
      }
    }
    _ => Broken
  }
}

///|
/// 一个 watcher 实例的值守周期:批量取事件并触发该目录重扫,直到失效才
/// 返回(调用方负责重建)。任何一批事件只投一条 ScanFolder —— wait() 已经
/// 在静默窗口内做过聚合,一批 = 一次该目录重扫;事件路径一律不看,
/// 判定完全交给现有扫描管线。
async fn watch_until_broken(
  handle : ActorHandle,
  folder : FsWatchFolder,
  watcher : @fs.Watcher,
  options : FsWatchOptions,
) -> Unit {
  defer watcher.close()
  for ;; {
    match watch_wait_slice(watcher, folder.root, options.alive_probe_ms) {
      Events(events) =>
        // 空批(创建+删除在同窗口内互相抵消)什么都不用做
        if events.length() > 0 {
          if events.length() >= WATCH_EVENT_LOG_THRESHOLD {
            println(
              "\{WATCH_LOG_TAG} 目录 \{folder.id} 一批聚合了 \{events.length()} 个文件事件,触发重扫",
            )
          }
          if !handle.send(Cmd::ScanFolder(folder.id)) {
            return // actor 已退出(队列已关)
          }
        }
      Quiet => continue
      Broken => return
    }
  }
}
