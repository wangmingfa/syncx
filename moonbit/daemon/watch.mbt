///|
/// 文件系统监听驱动的扫描 + 定时兜底全扫(ADR-0026 集成层;三端统一契约,
/// 对应 Node `src/cli.ts` 周期扫描段的升级形态)。
///
/// 架构契约:
///  - 每个「未暂停」的共享目录一条 `@fs.Watcher`(递归监听整棵树)。目录清单
///    以供应者闭包给定,对账循环按拍 diff —— 配置热重载下目录增删/暂停切换
///    即插即拔。身份校验门禁(folderIdentity 收养)落地前暂以 paused 为闸;
///  - 事件只当**触发器**:判定(相对路径拼接、diff、墓碑、忽略、嵌套共享根)
///    完全走 scanner.mbt 现有管线,这里不复制任何判定逻辑;
///  - 事件聚合防抖靠 `@fs.Watcher` 自带的 debounce(debounce_timeout = 事件静默
///    满这么久才把这批交给 wait();max_debounce_delay = 自首批事件起的强制冲刷
///    上限,连续事件流不能一直憋着):wait() 返回的一批事件塌缩成该目录**一次**
///    重扫。重入闸与现有语义一致 —— actor 单线程命令循环串行处理 ScanFolder,
///    重扫天然互斥;自己写入也产生事件,不过滤,聚合后重扫幂等;
///  - 定时兜底全扫:watcher 正常时按 fsWatchFallbackScanSecs(缺省 600s,可配置)
///    对一次总账;watcher 创建失败/不可用 → 该目录进降级名册,按原扫描间隔
///    (DEGRADED_SCAN_INTERVAL_MS,接 watcher 之前的 30s 节奏)周期全扫并
///    warn 一次;fsWatchEnabled=false → 纯定时全扫,行为与接 watcher 之前
///    完全一致;
///  - watcher 失效(目录被删重建):值守任务记 rebuilds + 补一扫,对账循环
///    下一拍重建;目录被移除/暂停的主动撤除不计失效。目录消失期间由
///    「降级节奏的周期全扫 + 兜底定时器」顶着,不崩。失效检测与平台无关:
///    wait 抛错按失效,wait 挂着不动(部分后端对根目录被删无反应)则由
///    存活探针定期查根目录还在不在。
///
/// 日志:watcher 启动/重建走 @log 门面(启动 Information / 失效重建 Warning);
/// 事件批聚合数超阈值才记(平时零噪声,Debug);降级 warn 一次(同一段失效
/// 期内不刷屏,恢复后再次失效会重新 warn);兜底全扫触发记 Information。

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
/// 目录列表由装配层以**供应者闭包**给定(配置热重载:每次对账现读最新
/// config.shared_folders,目录增删/暂停切换即插即拔);暂停目录不建
/// watcher(扫描侧本就跳过它们),但仍在兜底定时器名册里 —— 是否真扫由
/// actor 的 paused 闸决定,与接 watcher 之前的纯定时行为一致。
///
/// 形态:一条对账循环(节拍 = min(1s, 存活探针间隔))按供应者清单 diff 当前
/// watcher 集 —— 新目录建 watcher 起值守任务、消失/暂停目录 close watcher
/// (值守任务随之 Broken 退出);建不出 watcher 的目录进降级名册,由降级
/// 节奏的周期全扫顶着,恢复后自动接上。原「每目录自建自重建」形态的失效
/// 重建职责由对账循环承担,行为等价。
pub fn start_fs_watch(
  group : @async.TaskGroup[Unit],
  handle : ActorHandle,
  folders_of : () -> Array[FsWatchFolder],
  options : FsWatchOptions,
) -> WatchStats {
  let stats : WatchStats = { starts: 0, rebuilds: 0, degrades: 0 }
  if !options.enabled {
    // 配置关闭:纯定时全扫,节奏 = 原扫描间隔,行为与接 watcher 之前一致
    @log.info(
      "fsWatchEnabled=false,按原 {Ms}ms 周期定时全扫",
      [Json::number(options.degraded_scan_ms.to_double())],
    )
    let interval = options.degraded_scan_ms
    group.spawn_bg(allow_failure=true, no_wait=true) <| () => {
      fallback_scan_loop(handle, folders_of, interval)
    }
    return stats
  }
  // 兜底全扫定时器:watcher 再可靠也有内核截断/overflow/竞态窗口,隔一段
  // 时间全量对一次账。首轮立即扫(与接 watcher 之前的启动行为一致,
  // 也给 watcher 建好之前的存量文件一个基准)。
  let fallback_ms = options.fallback_scan_ms
  group.spawn_bg(allow_failure=true, no_wait=true) <| () => {
    fallback_scan_loop(handle, folders_of, fallback_ms)
  }
  // watcher 对账循环 + 降级扫描循环(降级名册由对账循环维护)
  let reconcile_ms = if options.alive_probe_ms < 1000 {
    options.alive_probe_ms
  } else {
    1000
  }
  let degraded : Map[String, FsWatchFolder] = Map([])
  group.spawn_bg(allow_failure=true, no_wait=true) <| () => {
    watch_reconcile_loop(group, handle, folders_of, options, stats, degraded, reconcile_ms)
  }
  group.spawn_bg(allow_failure=true, no_wait=true) <| () => {
    degraded_scan_loop(handle, degraded, options)
  }
  stats
}

///|
/// 兜底全扫循环:先扫后睡(首轮立即,保住「启动即扫一遍」的旧语义);
/// 每轮目录清单现取(热重载即插即拔);actor 队列已关 = 退出。
/// 每轮触发记 Information(低频,600s 一条)。
async fn fallback_scan_loop(
  handle : ActorHandle,
  folders_of : () -> Array[FsWatchFolder],
  interval_ms : Int,
) -> Unit {
  for ;; {
    for folder in folders_of() {
      @log.info("目录 {Folder} 兜底全扫触发", [Json::string(folder.id)])
      if !handle.send(Cmd::ScanFolder(folder.id)) {
        return
      }
    }
    @async.sleep(interval_ms)
  }
}

///|
/// 降级扫描循环:对「建不出 watcher」的降级名册按原扫描间隔周期全扫
/// (目录暂缺/平台不支持时的最后防线;名册由对账循环维护,建出 watcher
/// 即摘除)。
async fn degraded_scan_loop(
  handle : ActorHandle,
  degraded : Map[String, FsWatchFolder],
  options : FsWatchOptions,
) -> Unit {
  for ;; {
    @async.sleep(options.degraded_scan_ms)
    for pair in degraded {
      if !handle.send(Cmd::ScanFolder(pair.1.id)) {
        return
      }
    }
  }
}

///|
/// watcher 对账循环:每拍按供应者清单 diff 当前 watcher 集。
///  - 新目录(未暂停):建 watcher → 记 starts → 起值守任务;
///  - 消失/暂停目录:从名册摘除并 close watcher —— 值守任务随 Broken 退出
///    (retired 闸把这次主动撤销与「失效重建」区分开,不刷 rebuilds/不补扫);
///  - 建不出 watcher:进降级名册(每段失效期 warn 一次),降级扫描循环顶着。
async fn watch_reconcile_loop(
  group : @async.TaskGroup[Unit],
  handle : ActorHandle,
  folders_of : () -> Array[FsWatchFolder],
  options : FsWatchOptions,
  stats : WatchStats,
  degraded : Map[String, FsWatchFolder],
  reconcile_ms : Int,
) -> Unit {
  // folder_id → 该目录的在值值守(active watcher 与 retired 闸)
  let active : Map[String, @fs.Watcher] = Map([])
  let retired : Map[String, Ref[Bool]] = Map([])
  // 降级 warn 只发一次:同一段失效期内不刷屏;建出 watcher 后清旗,再次
  // 失效会重新 warn 并计入新的失效期
  let warned : Map[String, Bool] = Map([])
  for ;; {
    let desired : Map[String, FsWatchFolder] = Map([])
    for folder in folders_of() {
      if !folder.paused {
        desired.set(folder.id, folder)
      }
    }
    // 新目录接入
    for id, folder in desired {
      if active.contains(id) {
        continue
      }
      match make_folder_watcher(folder.root, options) {
        Some(watcher) => {
          active.set(id, watcher)
          retired.set(id, Ref(false))
          warned.remove(id)
          stats.starts += 1
          @log.info("目录 {Folder} 的文件系统监听已启动({Root})", [
            Json::string(folder.id), Json::string(folder.root),
          ])
          let stop = retired.get(id).unwrap_or(Ref(false))
          let f = folder
          group.spawn_bg(allow_failure=true, no_wait=true) <| () => {
            watch_until_broken(handle, f, watcher, options, stats, stop)
            // 值守结束(失效断裂;主动撤除的对账侧已摘过名册,幂等):把
            // 名册条目摘掉 —— 对账循环下一拍发现「还在配置里但已不在值」,
            // 重建接管。摘除与返回之间无 await 点,不会插进新一轮重建。
            active.remove(f.id)
            retired.remove(f.id)
          }
        }
        None => {
          degraded.set(id, folder)
          match warned.get(id) {
            Some(_) => ()
            None => {
              stats.degrades += 1
              @log.warn(
                "目录 {Folder}({Root})无法建文件系统监听,退回 {Ms}ms 周期全扫",
                [
                  Json::string(folder.id),
                  Json::string(folder.root),
                  Json::number(options.degraded_scan_ms.to_double()),
                ],
              )
              warned.set(id, true)
            }
          }
        }
      }
    }
    // 消失/暂停目录撤除:置 retired 后 close —— 值守任务 Broken 退出且不计重建
    // (先取键快照再删:Map 边遍历边删是未定义行为)
    let gone : Array[String] = []
    for id, _ in active {
      if !desired.contains(id) {
        gone.push(id)
      }
    }
    for id in gone {
      match retired.get(id) {
        Some(flag) => flag.val = true
        None => ()
      }
      match active.get(id) {
        Some(watcher) => watcher.close()
        None => ()
      }
      active.remove(id)
      retired.remove(id)
    }
    @async.sleep(reconcile_ms)
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
/// 一个 watcher 实例的值守周期:批量取事件并触发该目录重扫,直到失效或被
/// 对账循环撤除(retired)才返回;重建职责在对账循环。任何一批事件只投一条
/// ScanFolder —— wait() 已经在静默窗口内做过聚合,一批 = 一次该目录重扫;
/// 事件路径一律不看,判定完全交给现有扫描管线。失效(非撤除)时记一次
/// rebuilds 并补一扫对账(目录若被原地重建,这一刀把存量对上账)。
async fn watch_until_broken(
  handle : ActorHandle,
  folder : FsWatchFolder,
  watcher : @fs.Watcher,
  options : FsWatchOptions,
  stats : WatchStats,
  stop : Ref[Bool],
) -> Unit {
  defer watcher.close()
  for ;; {
    match watch_wait_slice(watcher, folder.root, options.alive_probe_ms) {
      Events(events) =>
        // 空批(创建+删除在同窗口内互相抵消)什么都不用做
        if events.length() > 0 {
          if events.length() >= WATCH_EVENT_LOG_THRESHOLD {
            @log.debug("目录 {Folder} 一批聚合了 {Count} 个文件事件,触发重扫", [
              Json::string(folder.id),
              Json::number(events.length().to_double()),
            ])
          }
          if !handle.send(Cmd::ScanFolder(folder.id)) {
            return // actor 已退出(队列已关)
          }
        }
      Quiet => continue
      Broken => {
        if stop.val {
          return // 对账循环主动撤除(目录被移除/暂停):不计失效
        }
        stats.rebuilds += 1
        @log.warn("目录 {Folder} 的监听已失效,关闭后重建", [Json::string(folder.id)])
        let _ = handle.send(Cmd::ScanFolder(folder.id))
        return
      }
    }
  }
}
