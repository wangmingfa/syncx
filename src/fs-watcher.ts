import { existsSync, statSync, watch, type FSWatcher } from 'node:fs';

/**
 * 文件系统监听驱动的按需重扫(三端架构契约的 Node 侧实现)。
 *
 * 背景:Termux 实测证实定时全量扫描是事件循环卡顿主源(扫描已异步化,但仍每轮全树
 * 遍历)。新架构:每个共享目录挂一个递归 fs.watch,事件**只当触发器** —— 聚合到
 * 「该目录脏了」,防抖 2s 后触发该目录的单目录重扫(判定引擎/diff/墓碑全复用现有
 * 扫描管线);定时全扫只做兜底(间隔由 manager.fallbackScanIntervalMs 决定)。
 *
 * 关键设计:
 *  - 事件名与 rename 语义跨平台差异很大,这里只取「该目录有变化」这一比特信息
 *    (事件回调不看参数),天然规避差异;自己写入也产生事件,不过滤,聚合后重扫幂等。
 *  - 平台不支持递归 watch(Node <20 的 Linux 等,创建时同步抛 ENOSYS)→ 全局降级:
 *    关闭全部 watcher 并 warn 一次(不刷屏),调用方退回原扫描间隔。
 *  - watcher 失效(目录被删/重建):异步 error 事件 → close + 立即触发该目录扫描 +
 *    退避重建;目录不存在期间不崩、不重建风暴(2^n 退避,封顶 30s)。Linux 上目录
 *    删除常无 error 事件而是 watcher 静默死亡 —— syncFolders 对账时发现「目录 inode
 *    与建 watch 时不一致」即视为失效,主动 close 重建(同一 protection 对 macOS 上
 *    「FSEvents 反而存活」的场景无害,换新 watcher 总是安全的)。
 *  - 忽略范围的事件在**聚合之前**就丢弃(filterEvent 谓词,见 onFsEvent)—— 2026-10
 *    实测事故的根治:生产 daemon 自某晚起持续 ~95% CPU,共享目录被每 ~2s 全量重扫
 *    一轮(639 条目、1.7s/轮、事件循环卡顿 ~1s),36243 轮不断。根因链:WebStorm
 *    后台 git 集成持续刷新 .git/index(实测 .git 目录 mtime 每 2s 跳动)→ macOS 递归
 *    fs.watch 把 .git 子树事件也报上来 → 旧设计「事件只当触发器、回调不看参数、
 *    不过滤」让每次刷新都触发重扫。`.git` 对**同步语义**是硬忽略,监听层没有理由
 *    再看见它;谓词由 manager 注入(与扫描同源判据),语义红线:过滤仅限忽略范围,
 *    自己写入同步文件产生的事件照常触发,daemon 自己写 .git 的场景(git 镜像提交)
 *    同样被滤 —— 这正是目的。
 */

/** 一个被监听的共享目录:wire id + 共享根绝对路径。 */
export interface WatchableFolder {
  id: string;
  path: string;
  /**
   * 事件过滤谓词(可选):入参是「相对共享根的 POSIX 路径」(hub 已归一化,见
   * normalizeWatchFilename),返回 true = 丢弃该事件(不打脏位、不触发重扫)。
   * 由 manager 用该目录的硬忽略 + 忽略规则生成,与扫描同源判据(见 session-manager
   * 的 syncWatchers);hub 在每次 syncFolders 对账时换入最新谓词,规则热重载即时生效。
   * 缺省 = 不过滤,行为与无谓词时代完全一致(向后兼容)。
   */
  filterEvent?: (filename: string) => boolean;
}

/**
 * 把 fs.watch 回调给的 filename 归一化成「相对监听根的 POSIX 路径」;归一不出来
 * 返回 null(调用方按 null 语义处理:保留触发,不过滤 —— 宁可多扫不可漏扫)。
 *
 * 防御背景:filename 形态跨平台不一 —— macOS/Linux 递归 watch 给根相对 POSIX 路径,
 * Windows 可能给反斜杠分隔甚至盘符绝对路径;直接拿原始串做规则匹配会漏判(漏判 =
 * 事件照旧触发,退化回扫描风暴),所以先归一化再判:
 *  - 反斜杠一律替换为 '/';
 *  - 绝对路径(POSIX '/' 开头或 Windows 盘符)尝试用监听根剥前缀,剥不上 → null;
 *  - './' 前缀剥掉;含 '..' 段的路径不可信 → null;空串 → null。
 */
export function normalizeWatchFilename(filename: string, watchRoot?: string): string | null {
  let s = filename.includes('\\') ? filename.replace(/\\/g, '/') : filename;
  if (s === '') return null;
  const root = watchRoot !== undefined ? watchRoot.replace(/\\/g, '/').replace(/\/+$/, '') : undefined;
  const isAbsolute = s.startsWith('/') || /^[A-Za-z]:\//.test(s);
  if (isAbsolute) {
    if (root === undefined || !s.startsWith(root + '/')) return null;
    s = s.slice(root.length + 1);
  }
  while (s.startsWith('./')) s = s.slice(2);
  if (s === '') return null;
  if (s.split('/').includes('..')) return null;
  return s;
}

export type WatchLogLevel = 'info' | 'warn' | 'debug';

export interface FolderWatchHubOptions {
  /** 防抖窗口(毫秒):窗口内 N 个事件塌缩成一次重扫。缺省 2000;测试注入短窗口。 */
  debounceMs?: number;
  /** 重建退避基数(毫秒),按 2^n 增长。缺省 1000。 */
  rebuildBaseMs?: number;
  /** 重建退避上限(毫秒)。缺省 30000。 */
  rebuildMaxMs?: number;
  /** 防抖窗口结束时触发:参数为本窗口聚合出的脏目录 id 列表(按目录单目录重扫)。 */
  onScanDirty: (folderIds: string[]) => void;
  /** 平台级降级(watch 不可用)时回调一次:调用方据此把兜底扫描间隔退回原节奏。 */
  onDegraded?: () => void;
  /** 日志通道:watcher 启动/重建 info;聚合摘要 debug;降级 warn(只一次)。 */
  log?: (level: WatchLogLevel, line: string) => void;
  /** 注入 fs.watch 工厂(测试模拟「平台不支持递归」等创建失败用);缺省 node:fs.watch。 */
  watchFn?: (path: string, opts: { recursive: true }) => FSWatcher;
}

export const DEFAULT_FS_WATCH_DEBOUNCE_MS = 2000;
const DEFAULT_REBUILD_BASE_MS = 1000;
const DEFAULT_REBUILD_MAX_MS = 30_000;
/**
 * 同一目录「目录明明存在却连续创建失败」达到该次数,视为平台级不可用(而非瞬时故障):
 * 覆盖「错误不经同步抛出而走 error 事件」的平台形态,避免无限重建循环。
 */
const MAX_CONSECUTIVE_CREATION_FAILURES = 3;
/** 平台明确不支持递归 watch 的错误码(Node<20 的 Linux 创建时同步抛)。 */
const UNSUPPORTED_WATCH_CODES = new Set(['ENOSYS', 'ERR_FEATURE_UNRESOLVED']);

export class FolderWatchHub {
  private readonly debounceMs: number;
  private readonly rebuildBaseMs: number;
  private readonly rebuildMaxMs: number;
  private readonly onScanDirty: (folderIds: string[]) => void;
  private readonly onDegraded?: () => void;
  private readonly log?: (level: WatchLogLevel, line: string) => void;
  private readonly watchFn: (path: string, opts: { recursive: true }) => FSWatcher;

  /** 存活 watcher,按目录 wire id。 */
  private readonly watchers = new Map<string, FSWatcher>();
  /** 各目录共享根的绝对路径(closeOne 时用于清重建登记)。 */
  private readonly paths = new Map<string, string>();
  /** 建监听时抓到的目录身份(dev/ino):syncFolders 据此发现「目录被删后重建」的静默失效。 */
  private readonly watchedIdentity = new Map<string, { dev: number; ino: number }>();
  /** 重建退避定时器;挂起期间 syncFolders 不重复发起创建。 */
  private readonly rebuildTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 重建退避步数(决定下次延迟;成功建 watch 即清零)。 */
  private readonly rebuildAttempts = new Map<string, number>();
  /** 「目录存在却创建失败」的连续次数(成功即清零;达到上限判定平台不可用)。 */
  private readonly creationFailures = new Map<string, number>();
  /** 脏目录聚合窗口:窗口内任意数量的事件只把目录 id 放进来。 */
  private readonly dirty = new Set<string>();
  /** 各目录当前生效的事件过滤谓词(见 WatchableFolder.filterEvent);缺条目 = 不过滤。 */
  private readonly filters = new Map<string, (filename: string) => boolean>();
  /** 本防抖窗口内被谓词丢弃的忽略事件数(聚合进 debug 摘要,绝不逐事件打日志)。 */
  private droppedEvents = 0;
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private platformDegraded = false;
  private closed = false;

  constructor(opts: FolderWatchHubOptions) {
    this.debounceMs = opts.debounceMs ?? DEFAULT_FS_WATCH_DEBOUNCE_MS;
    this.rebuildBaseMs = opts.rebuildBaseMs ?? DEFAULT_REBUILD_BASE_MS;
    this.rebuildMaxMs = opts.rebuildMaxMs ?? DEFAULT_REBUILD_MAX_MS;
    this.onScanDirty = opts.onScanDirty;
    this.onDegraded = opts.onDegraded;
    this.log = opts.log;
    this.watchFn = opts.watchFn ?? ((path, o) => watch(path, o));
  }

  /** watcher 体系是否可用(平台级降级后为 false,调用方退回纯定时扫描)。 */
  get healthy(): boolean {
    return !this.platformDegraded;
  }

  /** 当前有 watcher 的目录 id(测试/观测用)。 */
  watchedIds(): string[] {
    return [...this.watchers.keys()];
  }

  hasWatcher(folderId: string): boolean {
    return this.watchers.has(folderId);
  }

  /**
   * 对账:watchables 是「此刻应当被监听」的目录(未暂停且身份校验通过,由调用方判定)。
   * 多余的关闭、缺的补建;已有 watcher 的目录若根目录身份变了(被删后重建),视为
   * watcher 静默失效并 close 重建 —— 重建后立即触发该目录扫描,补上失效空窗期的变化。
   */
  syncFolders(watchables: WatchableFolder[]): void {
    if (this.closed) return;
    const wanted = new Map(watchables.map((w) => [w.id, w]));
    // 快照遍历:closeOne 会原地改 map
    for (const id of [...this.watchers.keys()]) {
      const w = wanted.get(id);
      if (w === undefined) {
        this.closeOne(id);
        this.filters.delete(id);
        continue;
      }
      // 谓词新鲜度:每次对账都换入最新谓词。事件回调按 id 现查表(见 onFsEvent),
      // 换表项即换谓词 —— 规则热重载/规则保存后的新鲜度因此**不需要重建 watcher**
      // (重建徒留事件空窗 + announce 触发的多余扫描);manager 侧每轮对账用最新
      // 规则对象重建谓词闭包,两侧配合保证谓词永不陈旧。
      if (w.filterEvent !== undefined) this.filters.set(id, w.filterEvent);
      else this.filters.delete(id);
      // 静默失效检测:目录被删后重建(inode/dev 变了),Linux 上旧 inotify watch 已死且
      // 常无 error 事件;macOS 上旧 watch 反而可能存活,换新总是安全的。ino 为 0(部分
      // 网络文件系统不提供)时无从判断,跳过该检测。
      const created = this.watchedIdentity.get(id);
      let current: { dev: number; ino: number } | undefined;
      try {
        const st = statSync(w.path);
        current = { dev: st.dev, ino: st.ino };
      } catch {
        current = undefined; // stat 失败(刚好被删?)交由 error 事件/退避重建兜
      }
      if (
        created &&
        current &&
        created.ino !== 0 &&
        current.ino !== 0 &&
        (current.ino !== created.ino || current.dev !== created.dev)
      ) {
        this.log?.('info', `[fs-watch] folder ${id}: root identity changed since watch, rebuilding watcher`);
        this.closeOne(id);
        this.createOne(id, w.path, { announce: true, filterEvent: w.filterEvent });
      }
    }
    if (this.platformDegraded) return;
    for (const [id, w] of wanted) {
      if (!this.watchers.has(id) && !this.rebuildTimers.has(id)) {
        this.createOne(id, w.path, { announce: false, filterEvent: w.filterEvent });
      }
    }
  }

  /**
   * fs.watch 事件入口:任何 change/rename 事件都只把目录标记为脏。公开是因为测试需要
   * 直接驱动聚合逻辑(事件风暴塌缩),生产路径只由 watcher 回调调用。
   */
  markDirty(folderId: string): void {
    if (this.closed || this.platformDegraded) return;
    this.dirty.add(folderId);
    this.ensureWindow();
  }

  /** 开一个防抖窗口(已在窗口中则复用);真实事件与被丢弃的忽略事件共用同一个窗口。 */
  private ensureWindow(): void {
    if (this.closed || this.platformDegraded) return;
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.flushDirty();
    }, this.debounceMs);
    // 不拖进程退出(daemon 退出走显式 close)
    this.debounceTimer.unref?.();
  }

  /**
   * fs.watch 事件入口(带 filename 形态):过滤挂点在聚合之前 —— filename 能归一化
   * 且命中该目录谓词 → 丢弃(不打脏位、不触发重扫)。filename 为 null(部分平台的
   * rename 形态)、归一失败、或没有谓词 → 保留原语义照常触发(向后兼容:谓词缺省时
   * 本函数与旧的「直接 markDirty」完全一致)。
   */
  private onFsEvent(id: string, filename: string | null): void {
    if (this.closed || this.platformDegraded) return;
    const filter = this.filters.get(id);
    if (filter !== undefined && filename !== null) {
      const rel = normalizeWatchFilename(filename, this.paths.get(id));
      if (rel !== null && filter(rel)) {
        this.droppedEvents += 1;
        // 纯丢弃也要开窗口:窗口结算时给一条聚合 debug(风暴被压制的观测证据),
        // 否则事件全被丢弃时连计时器都没有,丢弃计数永远无处汇报
        this.ensureWindow();
        return;
      }
      // rel === null:归一不出来,当 null 处理 —— 保留触发
    }
    this.markDirty(id);
  }

  /** 立即结算聚合窗口(watcher 失效/重建后立刻触发扫描,不等防抖)。 */
  private flushDirty(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    if (this.closed) return;
    const dropped = this.droppedEvents;
    this.droppedEvents = 0;
    if (this.dirty.size === 0) {
      // 本窗口全是被忽略的事件:没有可重扫的目录,但丢弃计数要给一条聚合 debug
      // (排查「风暴是否还在」的依据:这行持续滚动 = 事件源仍在刷,只是不再触发扫描)
      if (dropped > 0) this.log?.('debug', `[fs-watch] dropped ${dropped} ignored fs event(s) in window, nothing to rescan`);
      return;
    }
    const ids = [...this.dirty];
    this.dirty.clear();
    let line = `[fs-watch] aggregated ${ids.length} dirty folder(s), rescanning: ${ids.join(', ')}`;
    if (dropped > 0) line += `, dropped ${dropped} ignored fs event(s)`;
    this.log?.('debug', line);
    this.onScanDirty(ids);
  }

  private createOne(
    id: string,
    path: string,
    opts: { announce: boolean; filterEvent?: (filename: string) => boolean },
  ): void {
    let watcher: FSWatcher;
    try {
      watcher = this.watchFn(path, { recursive: true });
    } catch (err) {
      this.handleCreationFailure(id, path, err);
      return;
    }
    // 事件入口带 filename:过滤判定挂这里、聚合之前(见 onFsEvent)。Buffer 形态
    // (编码异常的文件名)按 null 处理 —— 保留触发,不过滤。
    watcher.on('change', (_eventType, filename) => {
      this.onFsEvent(id, typeof filename === 'string' ? filename : null);
    });
    watcher.on('error', (err) => this.handleWatchError(id, watcher, err));
    this.watchers.set(id, watcher);
    this.paths.set(id, path);
    if (opts.filterEvent !== undefined) this.filters.set(id, opts.filterEvent);
    try {
      const st = statSync(path);
      this.watchedIdentity.set(id, { dev: st.dev, ino: st.ino });
    } catch {
      this.watchedIdentity.delete(id); // 拿不到身份就不做静默失效检测
    }
    this.creationFailures.delete(id);
    this.rebuildAttempts.delete(id);
    this.log?.('info', `[fs-watch] watching folder ${id} (${path}, recursive)`);
    if (opts.announce) {
      // 重建/换新后的立即触发:失效空窗期(目录消失到重建)内的变化无法靠事件补,扫一轮兜住
      this.markDirty(id);
      this.flushDirty();
    }
  }

  /** 创建失败分流:目录不存在 → 退避重建;平台不支持 → 降级;其它 → 计数后退避。 */
  private handleCreationFailure(id: string, path: string, err: unknown): void {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (!existsSync(path)) {
      // 目录不存在(刚被删 / 还没挂上):瞬时态,退避重建,不计入平台不可用
      this.log?.('debug', `[fs-watch] watch ${path} failed (code=${code ?? 'unknown'}), will retry with backoff`);
      this.scheduleRebuild(id, path);
      return;
    }
    if (code !== undefined && UNSUPPORTED_WATCH_CODES.has(code)) {
      this.degrade(err);
      return;
    }
    const n = (this.creationFailures.get(id) ?? 0) + 1;
    this.creationFailures.set(id, n);
    if (n >= MAX_CONSECUTIVE_CREATION_FAILURES) {
      this.degrade(err);
      return;
    }
    this.log?.('debug', `[fs-watch] watch ${path} failed (code=${code ?? 'unknown'}), will retry with backoff`);
    this.scheduleRebuild(id, path);
  }

  /** 平台级降级:关闭全部 watcher 并 warn 一次;此后 markDirty/syncFolders 全部空转。 */
  private degrade(err: unknown): void {
    if (this.platformDegraded) return;
    this.platformDegraded = true;
    this.log?.('warn', `[fs-watch] recursive fs.watch unavailable (${String(err)}); degraded to periodic-only scanning`);
    for (const id of [...this.watchers.keys()]) this.closeOne(id);
    this.dirty.clear();
    this.filters.clear();
    this.droppedEvents = 0;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    this.onDegraded?.();
  }

  private handleWatchError(id: string, watcher: FSWatcher, err: unknown): void {
    // 只处理「现任」watcher 的错误:close 后迟到的 error 事件直接忽略
    if (this.watchers.get(id) !== watcher) return;
    const path = this.paths.get(id);
    this.closeOne(id);
    // 目录可能刚被删:立即触发该目录扫描(扫描对不存在目录安全),随后退避重建
    this.markDirty(id);
    this.flushDirty();
    if (path !== undefined) this.handleCreationFailure(id, path, err);
  }

  /** 退避重建:2^n 增长、封顶 rebuildMaxMs;目录不存在期间持续低调重试,绝不风暴。 */
  private scheduleRebuild(id: string, path: string): void {
    if (this.closed || this.platformDegraded) return;
    if (this.rebuildTimers.has(id)) return; // 已有挂起的重建
    const attempts = this.rebuildAttempts.get(id) ?? 0;
    this.rebuildAttempts.set(id, attempts + 1);
    const delay = Math.min(this.rebuildBaseMs * 2 ** Math.min(attempts, 20), this.rebuildMaxMs);
    const timer = setTimeout(() => {
      this.rebuildTimers.delete(id);
      if (this.closed || this.platformDegraded) return;
      if (existsSync(path)) {
        this.createOne(id, path, { announce: true });
      } else {
        this.scheduleRebuild(id, path); // 还没回来:按退避节奏继续等
      }
    }, delay);
    timer.unref?.();
    this.rebuildTimers.set(id, timer);
  }

  private closeOne(id: string): void {
    const watcher = this.watchers.get(id);
    if (watcher) {
      this.watchers.delete(id);
      this.watchedIdentity.delete(id);
      try {
        watcher.close();
      } catch {
        // 已关闭
      }
    }
    const timer = this.rebuildTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.rebuildTimers.delete(id);
    }
    this.paths.delete(id);
    this.creationFailures.delete(id);
    this.rebuildAttempts.delete(id);
    // 注意:filters 条目**刻意不在这里删** —— error 事件驱动的 close+退避重建会复用
    // 同一谓词(事件按 id 查表),删了反而让重建空窗期的事件漏过滤。摘除目录时由
    // syncFolders 的移除分支显式删除,降级/关闭时统一 clear。
  }

  /** daemon 优雅关闭:清定时器、关全部 watcher,不留悬挂句柄。 */
  close(): void {
    this.closed = true;
    for (const id of [...this.watchers.keys()]) this.closeOne(id);
    this.dirty.clear();
    this.filters.clear();
    this.droppedEvents = 0;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
  }
}
