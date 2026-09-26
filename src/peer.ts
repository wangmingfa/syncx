import type { IndexEntry } from './index.js';
import { buildPlan, buildDeltaPlan } from './plan.js';
import type { BlockRequest, BlockResponse } from './messages.js';
import type { LocalExecutor } from './executor.js';
import { resolveSharePath, preserveLocalAsConflict } from './executor.js';
import { verifyBlock, hashBlock, BLOCK_SIZE } from './blockstore.js';
import { decPathFor, encryptBlock } from './e2e.js';
import { parseIgnoreRules, isIgnoredPath, isHardIgnored, type IgnoreRule } from './ignore.js';
import { mergeVersions } from './version.js';
import type { ConflictPolicy } from './config.js';
import type { ProgressCounts, TransferFile } from './status.js';

/**
 * 索引消息的两种语义:
 *  - `full`:这条消息是**本机索引的完整声明**(会话建立时互发),接收方按并集规划;
 *  - `delta`:只包含本轮改动的那几条,接收方**只判消息里提到的路径**。
 * 语义搞反的后果不对称:把 delta 当 full 会引发两端互为回声的无限循环
 * (2026-09-16 事故);把 full 当 delta 最多是少一次回推,而双方各自在会话建立时
 * 都会发 full,收敛不受影响。所以**缺省一律按 delta**(见 SyncPeer.onPeerIndex)。
 */
export type IndexMode = 'full' | 'delta';

export interface PeerTransport {
  sendEntries(entries: IndexEntry[], mode: IndexMode, opts?: { relayed?: boolean }): void;
  sendBlockRequest(request: BlockRequest): void;
  /** opts.priority = 源块请求带「优先同步」标记:实现侧据此把响应插到发送队列最前。 */
  sendBlockResponse(response: BlockResponse, opts?: { priority?: boolean }): void;
}

/** 对端索引到达时的附加说明。缺省(undefined)按 delta 处理,见 IndexMode。 */
export interface PeerIndexOptions {
  full?: boolean;
  /**
   * 这条索引是中转来的(某兄弟 peer 收到后又转发给我),见 ADR-0014。
   * 接收端据此区分「并发版本 = 兄弟端自己真改过(保留冲突副本)」与
   * 「并发版本 = 兄弟端只是陈旧同步副本(直接覆盖,不生成 .sync-conflict)」,
   * 避免给从没改过文件的设备刷出一堆冲突副本。旧版对端不发该字段,忽略即可。
   */
  relayed?: boolean;
}

/** 一条待记录的同步变更(不含 folderId,由调用方补全)。 */
export interface SyncEventInput {
  ts: number;
  path: string;
  action: 'add' | 'update' | 'delete' | 'conflict';
  direction: 'local' | 'remote';
  deviceId?: string;
}

export interface SyncPeerDeps {
  transport: PeerTransport;
  localIndex: Map<string, IndexEntry>;
  executor?: LocalExecutor;
  readLocalBlock(path: string, blockIndex: number): Buffer;
  deviceId: string;
  /** Peer device ID, used to name conflict copies. */
  remoteDeviceId?: string;
  /** 共享目录根路径:块请求服务侧用它拒绝经符号链接逃逸目录的路径。 */
  root?: string;
  /**
   * 取共享目录**当前生效**的忽略规则行(`.gitignore` + `.syncxignore` + 内置默认)。
   *
   * 是函数而非数组快照,这是刻意的:`.gitignore` 是运行期改的 —— `scanOnce` 每轮重读
   * 并整体回写 `folder.ignoreLines`。若在会话建立时快照一份,刚写进忽略的路径要等
   * 重连之后才被入向闸门挡住,而扫描侧(外推)下一轮就生效了 —— 同一个规则两个方向
   * 生效时间不一致,排查起来极难。
   *
   * 用途有二:接收保护据此跳过被忽略的文件(冷启动不覆盖);入向闸门据此丢弃
   * 命中的条目(见 docs/adr/0012)。
   */
  readIgnoreLines?: () => string[];
  /**
   * 从对端索引里丢弃硬忽略条目(见 HARD_IGNORE_NAMES)时回调一次,参数是路径列表。
   * 这条路径是「静默保护」——正常运行时不该触发,一旦触发说明对端在推 .git 之类的
   * 内容(对端版本旧、或对端把忽略规则负向覆盖了),值得在日志里留痕便于定位。
   */
  onHardIgnoredDropped?: (paths: string[], remoteDeviceId: string) => void;
  /** 记录一次同步变更(新增/修改/删除/冲突),由上层写入历史存储。 */
  onEvent?: (ev: SyncEventInput) => void;
  /**
   * 网络字节计数(流量统计):每发出一块/收下一块回调一次增量。
   * 与瞬时速率共用 recordBytes 通道 —— 本地预填的块(磁盘读)不走这里,口径是网络量。
   */
  onTraffic?: (sent: number, received: number) => void;
  /**
   * 收到并落地远程条目后回调(中转用,见 ADR-0014):上层据此把这批条目转发给
   * 同目录的其它 transport。只在「增量(非 full)接收」时触发——full 交换已经
   * 收敛整张网,无需再中转,否则每次(重)连都会把整份索引爆发式转发给兄弟端。
   * 包含真正进入 receive/conflict 落地的条目,以及应用对端墓碑的删除(二者的
   * 版本向量已是最终值);不含 send 与本地墓碑外推——这两类是本机决策动作,
   * 本机扫描生成它们时已通过 broadcast 广播过,再中转纯属重复。
   */
  onLanded?: (entries: IndexEntry[]) => void;
  /**
   * 一条待接收因块请求长期无响应而被放弃时回调(路径, 缺失块数)。这是
   * 「对端索引声明有、但内容长期供不出」的兜底出口 —— 典型是对端编辑器的
   * tmp 中间文件进了索引随即被改名。上层据此打 WARN 日志并刷新状态推送,
   * 否则用户只能对着一条永不消失的「接收中」进度条(2026-09-22 事故)。
   */
  onStallDrop?: (path: string, missingBlocks: number) => void;
  /**
   * 接收模式(只拉不推):本机只从对端拉取变更、应用对端删除,但**绝不**把本机
   * 的本地新增/修改/删除反灌给对端。开启后:本地较新/本地墓碑不再外推,冲突
   * 直接以对端版本覆盖本地。缺省 false = 双向同步。
   */
  receiveOnly?: boolean;
  /**
   * 取该目录**当前生效**的冲突自动处理策略(见 config.SharedFolderConfig.conflictPolicy)。
   * 与 readIgnoreLines 同理用函数而非快照:策略在设置弹窗改完后无需重连即生效。
   * 缺省(旧调用方/测试)按 'keep-both' = 现行为(拉回远端 + 本地留冲突副本)。
   */
  getConflictPolicy?: () => ConflictPolicy;
  /**
   * 磁盘空间守卫(见 ROADMAP「磁盘空间守卫」):本轮规划出的接收量(字节,已扣除
   * 将被覆盖的本地文件将释放的体积)在落盘前问一次上层。返回 false = 空间不足 →
   * 本轮**跳过全部 receive/conflict 动作**(删除照常应用 —— 删除是释放空间的方向;
   * send 也照常,推出去不占本机盘),并记下本轮索引,待空间恢复后由上层调
   * {@link SyncPeer.retryDiskBlocked} 重放。缺省(旧调用方/测试)恒放行。
   */
  checkDiskSpace?: (neededBytes: number) => boolean;
  /**
   * 端到端加密视图(对不可信peer的盲区口径,见 src/e2e.ts):该目录为此对端设了口令时,
   * 上层交给它的 transport 已是密文变换壳(sendEntries 前条目被换成密文视图)。SyncPeer
   * 再补两道:①对端索引宣告**整轮忽略**(盲区端只有密文副本,它的「回推」会把密文当
   * 明文塞进本机共享目录);②块请求按「密文路径→解回明文路径→读明文块→现场加密」响应,
   * 全程不出明文内容。缺省 undefined = 普通双向同步,一切照旧。
   */
  e2eKey?: Buffer;
}

export interface SyncPeer {
  onPeerIndex(entries: IndexEntry[], opts?: PeerIndexOptions): Promise<void>;
  onBlockRequest(request: BlockRequest): void;
  onBlockResponse(response: BlockResponse): Promise<void>;
  getSyncProgress(): ProgressCounts;
  /**
   * 磁盘守卫放行后重放被拦下的那轮索引(见 deps.checkDiskSpace)。
   * 没有积压(未拦截过 / 已重放)时是空操作;重放轮再次空间不足会重新挂起等待下次重放。
   */
  retryDiskBlocked(): void;
  /**
   * 「优先同步」(传输优先级):用户点名某在传文件插队。
   *
   * 本端能做两件事:①为该路径全部未收齐的块**重发**带 priority 标记的块请求 ——
   * 发送端据此把这些文件的块响应插到限速队列最前(重复响应在接收闸门处去重,安全);
   * ②记住该路径直到落地/中止,后续超时重试同样带标记,并在传输进度里透出 priority。
   * 不在接收中的路径调用是空操作(还没开传的文件本就按规划顺序进行,无需插队)。
   */
  markPriority(path: string): void;
}

interface PendingEntry {
  kind: 'receive' | 'conflict';
  /** The remote entry to land. */
  entry: IndexEntry;
  /** The local entry, only for conflicts. */
  local?: IndexEntry;
  blocks: Array<Buffer | undefined>;
  received: number;
}

/** 单个块请求的超时与重试状态。 */
interface PendingBlockRequest {
  timeout: ReturnType<typeof setTimeout>;
  retries: number;
}

const BLOCK_REQUEST_TIMEOUT_MS = 5000;
const MAX_BLOCK_RETRIES = 3;
/** 快速重试耗尽后的长间隔退避:继续重试而非立即丢弃条目。 */
const BLOCK_RETRY_LONG_MS = 30_000;
/**
 * 块重试总上限(发送次数):3 次快速(5s)+ 20 次长间隔(30s)≈ 10 分钟。
 * 耗尽后放弃该块;某路径的全部在途块都放弃时,整条待接收一并放弃(见
 * dropIfUnservable)。无限重试的代价是「对端文件已消失时进度条永久虚报」
 * (2026-09-22 事故:对端编辑器 tmp 中间文件进索引后随即被改名,块请求永远
 * 无人应答,UI 挂着「接收 1 · 0%」十几小时),有界重试 + 下游自愈更划算。
 */
const MAX_BLOCK_RETRIES_TOTAL = 23;

/**
 * 「发送中」的租约时长:对端每来一个块请求,就给该路径续一次期;超过这个时长
 * 没有新请求,即认为这条文件已经传完。
 *
 * 用租约而不是「本轮计划推送的条数」这种计数器,是因为计数器没有衰减路径:
 * 它只在下一次收到对端索引时才被重算,而建立连接时互发的那次全量索引之后,
 * 对端可能很久都不再发索引 —— 于是卡片会永远停在「传输中 · 发送 N」(2026-09-16
 * 两端卡片转圈不停的事故形态之一)。租约天然自愈,不需要任何外部事件来清零。
 *
 * 取 15s:块请求的超时是 5s,正常的块流至少每 5s 会来一波(超时后的重试本身也续期),
 * 所以只有真正停下来不传了,租约才会过期。集成测试可用 SYNCX_SERVE_LEASE_MS 调短。
 */
const SERVE_LEASE_MS = Number(process.env.SYNCX_SERVE_LEASE_MS) || 15_000;

/**
 * 速率采样窗口:瞬时速率 = 最近这段时间内实测字节的平均值。
 * 与兜底状态推送周期(5s)同阶,保证每次快照都能看到窗口内的新鲜数据。
 */
const RATE_WINDOW_MS = 5000;
/**
 * 窗口时间跨度的下限:刚开传的第一帧,分母若取真实跨度(可能只有几毫秒)
 * 会冒出离谱的瞬时峰值;按至少 1s 平滑。
 */
const RATE_SPAN_FLOOR_MS = 1000;

/**
 * Wire one sync round over an injected transport: on receiving the peer's
 * index, send newer local entries, request missing blocks, apply deletions
 * and prepare conflict copies; collect block responses until a file is
 * complete, then apply it via the executor.
 */
export function createSyncPeer(deps: SyncPeerDeps): SyncPeer {
  const { transport, localIndex, executor, readLocalBlock, deviceId, remoteDeviceId, root, onEvent, onTraffic, readIgnoreLines, receiveOnly, getConflictPolicy, checkDiskSpace, onHardIgnoredDropped, onLanded, onStallDrop, e2eKey } = deps;
  const pending = new Map<string, PendingEntry>();
  // 逐块跟踪超时重试:块响应丢失/丢弃时自动重发,避免文件永远收不齐
  const pendingBlocks = new Map<string, PendingBlockRequest>();
  // 磁盘守卫积压:被拦下的那轮索引原文,等上层空间恢复后经 retryDiskBlocked 重放。
  // 不能只等对端下一轮增量 —— 对端没有新改动就不会再发,接收会无限期停摆。
  let diskBlockedRetry: { entries: IndexEntry[]; opts?: PeerIndexOptions } | null = null;
  // 「优先同步」点名中的接收路径:块请求(含超时重试)都带 priority 标记,
  // 直到该文件落地 / 中止 / 被放弃才清除(见 completeIfReady / abortPending / dropIfUnservable)。
  const priorities = new Set<string>();
  // 正在向外供块的路径 → 最后一次发出该文件块的时间,用于展示「发送中」(见 SERVE_LEASE_MS)
  const serving = new Map<string, number>();
  // 文件级发送进度:每个供块路径累计 已发字节 / 总字节。servedBlocks 记录已发出的块下标,
  // 对端重试同一块时不重复计入(否则进度会虚高)。总字节取本地索引的 size,缺则回退 0。
  const servingBytes = new Map<string, { done: number; total: number }>();
  const servedBlocks = new Map<string, Set<number>>();
  // 速率采样:每个块「真正发出 / 真正收下」时记一笔(t + 字节数),读取时按滚动窗口
  // 平均。放在 peer 级(每对端一份)而非全局:速率天然按「目录 × 对端」隔离,join 后
  // 的 ProgressCounts 就各自带各的速率。本地预填的块不记 —— 那是磁盘读,不是网络传输。
  const rateSamples: Array<{ t: number; sent: number; recv: number }> = [];
  function pruneRateSamples(now: number): void {
    while (rateSamples.length > 0 && now - rateSamples[0]!.t > RATE_WINDOW_MS) rateSamples.shift();
  }
  function recordBytes(sent: number, recv: number): void {
    const now = Date.now();
    rateSamples.push({ t: now, sent, recv });
    pruneRateSamples(now);
    // 同一口径喂给全局流量账本(累计 + 采样环);本地预填不走这里,记的都是网络量
    if (onTraffic && (sent > 0 || recv > 0)) onTraffic(sent, recv);
  }
  /** 窗口内的平均速率(字节/秒);窗口里没有该方向的字节时返回 0(上层据此省略字段)。 */
  function bytesPerSecond(kind: 'sent' | 'recv'): number {
    pruneRateSamples(Date.now());
    if (rateSamples.length === 0) return 0;
    let sum = 0;
    for (const s of rateSamples) sum += s[kind];
    const spanMs = Math.max(Date.now() - rateSamples[0]!.t, RATE_SPAN_FLOOR_MS);
    return Math.round(sum / (spanMs / 1000));
  }

  // 忽略规则的解析结果按「数组实例」缓存:readIgnoreLines 每次扫描返回全新数组,
  // 引用变化即失效。这样一条索引消息只解析一次规则,而不是每个条目解析一遍
  // (`.gitignore` 动辄上百行,逐条构造正则的代价会随索引规模放大)。
  let cachedIgnoreLines: string[] | undefined;
  let cachedIgnoreRules: IgnoreRule[] = [];
  function currentIgnoreRules(): IgnoreRule[] {
    const lines = readIgnoreLines?.() ?? [];
    if (lines !== cachedIgnoreLines) {
      cachedIgnoreLines = lines;
      cachedIgnoreRules = parseIgnoreRules(lines);
    }
    return cachedIgnoreRules;
  }

  function blockKey(path: string, blockIndex: number): string {
    return `${path}:${blockIndex}`;
  }

  /** 中止某路径的在途接收与块重试:对端声明它已删除时,继续拉块毫无意义,
   *  而且迟到的块响应会把刚删除的文件临时复活。 */
  function abortPending(path: string): void {
    pending.delete(path);
    priorities.delete(path);
    for (const [key, request] of pendingBlocks) {
      if (key.slice(0, key.lastIndexOf(':')) !== path) continue;
      clearTimeout(request.timeout);
      pendingBlocks.delete(key);
    }
  }

  /**
   * 某路径最后一个在途块请求被放弃时调用:条目仍未收齐 → 整条放弃接收。
   * 放弃是安全的,自愈路径有三 —— ①对端扫描器发现文件消失后推墓碑(delete
   * 分支本就会清 pending);②对端文件回来后推新版本增量(onPeerIndex 重新
   * 规划 receive,从零重排);③任何重连都会互发全量索引(full 轮重建)。
   * 反之留着只会让「接收中」永久虚报,误导用户以为传输卡死。
   */
  function dropIfUnservable(path: string): void {
    const item = pending.get(path);
    if (!item) return;
    for (const key of pendingBlocks.keys()) {
      if (key.slice(0, key.lastIndexOf(':')) === path) return; // 还有别的块在途
    }
    pending.delete(path);
    priorities.delete(path);
    onStallDrop?.(path, item.entry.blocks.length - item.received);
  }

  /** 发送单个块请求并设置超时重试。 */
  function requestBlock(path: string, blockIndex: number, hash: string): void {
    const key = blockKey(path, blockIndex);
    const existing = pendingBlocks.get(key);
    const retries = existing?.retries ?? 0;
    if (existing) clearTimeout(existing.timeout);

    // 总重试耗尽:对端长期供不出这块(索引声明有,磁盘上多半已没有 ——
    // 典型如编辑器 tmp 中间文件)。不再发送,放弃该块;若这是该路径最后一个
    // 在途块,整条待接收一并放弃,进度条随之归零。
    if (existing && retries >= MAX_BLOCK_RETRIES_TOTAL) {
      pendingBlocks.delete(key);
      dropIfUnservable(path);
      return;
    }

    transport.sendBlockRequest({
      deviceId,
      path,
      blockIndex,
      hash,
      // 被「优先同步」点名的路径:请求带标记,让对端发送队列把这些块插到最前
      ...(priorities.has(path) ? { priority: true } : {}),
    });
    const nextRetries = retries + 1;
    // 快速重试(5s×3)覆盖瞬时故障(丢包/对端短暂忙碌),之后退避到 30s 长间隔,
    // 给对端较长故障(重启、文件被锁)留恢复窗口;超过总上限才放弃。
    const timeout = setTimeout(
      () => requestBlock(path, blockIndex, hash),
      nextRetries > MAX_BLOCK_RETRIES ? BLOCK_RETRY_LONG_MS : BLOCK_REQUEST_TIMEOUT_MS,
    );
    pendingBlocks.set(key, { retries: nextRetries, timeout });
  }

  /**
   * 请求一个文件缺失的块:先与本地索引按下标比对块哈希,哈希相同的块直接从
   * 本地文件读取填充(免网络重传),其余才向对端发块请求。
   * 本地条目为墓碑(文件已删)或读取/校验失败时回退为网络请求,正确性不受影响。
   * 仅改文件尾部块、追加、逐块对齐修改等场景可显著减少传输量;文件头部插入
   * 导致块整体错位时哈希全不匹配,退化为全量请求(与原行为一致)。
   */
  function requestMissingBlocks(path: string, entry: IndexEntry): void {
    const item = pending.get(path);
    if (!item) return;
    const localEntry = localIndex.get(path);
    // 墓碑条目内容不可信(文件已删,块哈希指向旧内容):整体走网络请求
    const localBlocks = localEntry && !localEntry.deleted ? localEntry.blocks : undefined;
    entry.blocks.forEach((hash, blockIndex) => {
      if (item.blocks[blockIndex] !== undefined) return; // 已预填或已收到,不重复
      if (localBlocks?.[blockIndex] === hash) {
        try {
          const data = readLocalBlock(path, blockIndex);
          // 本地文件可能在扫描与规划之间被改写:哈希校验不过就不信本地块
          if (verifyBlock(data, hash)) {
            item.blocks[blockIndex] = data;
            item.received += 1;
            return;
          }
        } catch {
          // 文件被移动/删除/暂时不可读:回退网络请求
        }
      }
      requestBlock(path, blockIndex, hash);
    });
  }

  /** 收齐全部块(或空文件本身)后把条目落地;未就绪则无操作。 */
  async function completeIfReady(path: string): Promise<void> {
    const item = pending.get(path);
    if (!item || item.received !== item.entry.blocks.length) return;

    pending.delete(path);
    priorities.delete(path); // 已落地:优先标记的使命完成,后续该路径的新传输回到默认排队
    const provider = {
      getBlocks: async (): Promise<Buffer[]> => item.blocks.map((b) => b ?? Buffer.alloc(0)),
    };

    if (item.kind === 'conflict' && item.local) {
      // 落地时重新读取本地最新条目:冲突规划到块收齐之间,本地可能已被
      // 新一轮扫描更新(A:1→A:2),用规划时捕获的旧版本合并会回退版本向量
      const currentLocal = localIndex.get(path) ?? item.local;
      const landed = await executor?.applyConflict(
        path,
        currentLocal,
        item.entry,
        provider,
        remoteDeviceId ?? '',
      );
      // 同步内存索引,使后续规划基于最新本地状态:以实际落盘结果为准
      if (landed) {
        localIndex.set(path, landed);
      }
      onEvent?.({ ts: Date.now(), path, action: 'conflict', direction: 'remote', deviceId: remoteDeviceId });
    } else {
      const isNew = !localIndex.has(path);
      // 冷启动保护:本机磁盘已有同名文件、但本机索引尚未记录(对端“热”且先于本机
      // 首扫推送)时,先保留为 .sync-conflict 副本,避免被对端版本静默覆盖。
      // 忽略规则命中的文件不保护(旧行为即会接收覆盖,避免把被忽略文件反向同步出去)。
      let preserved = false;
      if (isNew && root !== undefined && remoteDeviceId) {
        try {
          if (!isIgnoredPath(currentIgnoreRules(), path, false)) {
            preserved = preserveLocalAsConflict(root, path, remoteDeviceId);
          }
        } catch {
          // 路径校验 / 重命名失败不阻断接收,退回旧行为(覆盖);保护仅为防丢数据增强
          preserved = false;
        }
      }
      await executor?.applyReceive(item.entry, provider);
      localIndex.set(path, item.entry);
      onEvent?.({
        ts: Date.now(),
        path,
        action: preserved ? 'conflict' : isNew ? 'add' : 'update',
        direction: 'remote',
        deviceId: remoteDeviceId,
      });
    }
  }

  /**
   * 端到端加密视图下的供块(见 deps.e2eKey):盲区按预告的「encPath + 密文块哈希」来索块,
   * 本端解回真实路径读明文、现场加密、以密文块响应 —— 明文内容永不上线。
   * 任一校验不过(encPath 解不开 / 本地无此条目 / 块号越界 / 对方要的哈希与我现算的
   * 密文哈希不符)一律静默忽略:不符说明宣告与请求之间内容变过,或对端在乱问,
   * 让它的超时重试 + 下轮索引自然收敛即可。
   */
  function serveE2EBlock(request: BlockRequest): void {
    if (e2eKey === undefined) return;
    let realPath: string;
    try {
      realPath = decPathFor(e2eKey, request.path);
    } catch {
      return;
    }
    const local = localIndex.get(realPath);
    if (!local || local.deleted) return;
    if (!Number.isInteger(request.blockIndex) || request.blockIndex < 0 || request.blockIndex >= local.blocks.length) return;
    let plain: Buffer;
    try {
      plain = readLocalBlock(realPath, request.blockIndex);
    } catch {
      return;
    }
    const cipher = encryptBlock(e2eKey, request.path, request.blockIndex, plain);
    if (hashBlock(cipher) !== request.hash) return;
    serving.set(request.path, Date.now());
    const sentSet = servedBlocks.get(request.path) ?? new Set<number>();
    if (!sentSet.has(request.blockIndex)) {
      sentSet.add(request.blockIndex);
      servedBlocks.set(request.path, sentSet);
      const rec = servingBytes.get(request.path) ?? { done: 0, total: 0 };
      rec.done += cipher.length;
      servingBytes.set(request.path, rec);
    }
    recordBytes(cipher.length, 0);
    transport.sendBlockResponse(
      { deviceId, path: request.path, blockIndex: request.blockIndex, hash: request.hash, data: cipher },
      { priority: request.priority === true },
    );
  }

  const self: SyncPeer = {
    async onPeerIndex(entries: IndexEntry[], opts?: PeerIndexOptions): Promise<void> {
      // 端到端加密视图(不可信对端):本机对该对端**只出不进**。盲区端回推的索引全是
      // 密文视图条目(路径是密文名、块哈希是密文块的),若当真接收会把密文当明文写进
      // 共享目录;它也没有本机没有的东西,整轮直接忽略最安全。
      if (e2eKey !== undefined) return;
      // 缺省按 delta 处理。旧版对端不带 full 字段,而它**确实**会发增量索引
      // (扫描到改动就只广播那几条);把增量当全量做并集规划,就会为「它没提到的
      // 本地条目」回推变更 → 两端互为回声、无限循环。反过来把全量当增量最多是
      // 这一轮少回推一次,而双方在会话建立时都会各发一次全量,收敛不受影响。
      const full = opts?.full ?? false;

      // 全量轮次:这条消息是对端索引的完整声明,可以据此丢弃上一轮的在途状态
      // (基于过期条目重试的块请求、已不再被对方索引引用的 pending)。增量轮次
      // 绝不可做这两件事:消息里没提到 ≠ 对端没有了,清掉会把正在传的文件腰斩。
      if (full) {
        for (const bReq of pendingBlocks.values()) clearTimeout(bReq.timeout);
        pendingBlocks.clear();
      }

      // 入向闸门一:硬忽略(.git/.hg/.svn/.syncx-trash/.syncx-folder,见 ADR 0008)——
      // 对端推来的这些条目**一条都不收**,活条目与墓碑一视同仁。这是「本机 .git 被对端搅坏」
      // 唯一可靠的堵法——本机的忽略集管不住对端的忽略集:对端版本旧(早于内置忽略加入)、
      // 或对端在 .syncxignore 里写了 `!.git`,都会把 .git 条目推过来。若不拦,活条目会被写进
      // 本机 .git 目录,墓碑会让本机真实的 .git 文件被移进回收站(2026-09-15 事故即此路径)。
      // 丢弃后不进 buildPlan,因此既不落盘也不回推,对端下一轮仍会推,但每次都被丢弃。
      //
      // 入向闸门二:本机忽略规则(.gitignore/.syncxignore,见 ADR 0012)—— **同样活条目与
      // 墓碑一律丢弃**。只挡外推是不够的:被忽略的路径本机不再扫描,它的本地改动就
      // **没有任何索引保护**,而对端的索引里往往仍留着这条(规则变更不会回溯清理任何一端的
      // 索引库),会话建立互发全量索引时本机内存索引已过滤掉它 → 被判成「对端有、本机没有」
      // = remote-newer → 拉回来覆盖落盘。而冷启动保护(preserveLocalAsConflict)对被忽略路径
      // 是刻意跳过的,所以没有冲突副本、直接盖掉(2026-09-16 实测:/shared/mo 的
      // .workbuddy/memory/*.md 与 .idea/workspace.xml 在本机重启时被对端那份旧内容盖回)。
      // 丢弃意味着忽略路径**不会再被本机应用任何入向变更**:对端新增/修改不再覆盖本机,
      // 对端删除也不再跟着删——两边安静分叉,这正是「本机不碰它」的语义。
      // 注意硬忽略仍走在前面:它比用户规则更强(不可用 `!` 解开),这里的分支只是为了留痕。
      const rules = currentIgnoreRules();
      const dropped: string[] = [];
      const remote = new Map<string, IndexEntry>();
      for (const e of entries) {
        if (isHardIgnored(e.path)) {
          dropped.push(e.path);
          continue;
        }
        if (isIgnoredPath(rules, e.path, false)) continue;
        remote.set(e.path, e);
      }
      if (dropped.length > 0) {
        onHardIgnoredDropped?.(dropped, remoteDeviceId ?? '');
      }

      const actions = full ? buildPlan(localIndex, remote) : buildDeltaPlan(localIndex, remote);
      // 磁盘空间守卫:先预估本轮入向体积(扣除被覆盖的本地文件将释放的空间),
      // 不足就整轮跳过 receive/conflict —— 宁可推迟,也不要写到一半失败。
      // 删除照常应用(它是释放空间的方向),send 照常外推(不占本机盘);
      // 本轮索引原文记下,空间恢复后由上层调 retryDiskBlocked 重放。
      let diskSkipsReceive = false;
      if (checkDiskSpace) {
        let needed = 0;
        for (const action of actions) {
          if (action.kind !== 'receive' && action.kind !== 'conflict') continue;
          const incoming = action.kind === 'receive' ? action.entry : action.remote;
          const current = localIndex.get(action.path);
          needed += Math.max(0, incoming.size - (current && !current.deleted ? current.size : 0));
        }
        if (needed > 0 && !checkDiskSpace(needed)) {
          diskSkipsReceive = true;
          diskBlockedRetry = { entries, opts };
        } else {
          // 本轮放行:清掉此前的积压,避免重连/新改动后旧索引被重复重放
          diskBlockedRetry = null;
        }
      }
      const sends: IndexEntry[] = [];
      // 本轮索引实际引用的 pending 路径:仅用于全量轮次清理上一轮遗留的陈旧条目
      const livePending = new Set<string>();
      // 本轮真正落地(receive/conflict 接收、应用对端墓碑)的远程条目:供 onLanded 中转给兄弟端
      const landed: IndexEntry[] = [];

      for (const action of actions) {
        if (diskSkipsReceive && (action.kind === 'receive' || action.kind === 'conflict')) continue;
        switch (action.kind) {
          case 'send':
            // 接收模式:本地较新的变更绝不外推,仅作为镜像忽略
            if (!receiveOnly) sends.push(action.entry);
            break;
          case 'delete': {
            const localEntry = localIndex.get(action.path);
            const remoteEntry = remote.get(action.path);
            if (localEntry?.deleted) {
              // 本地墓碑:接收模式下不外推(避免把完整端误删),双向模式才传播给对端
              if (!receiveOnly) sends.push(localEntry);
            } else if (remoteEntry?.deleted) {
              // 对端墓碑:本地删除。接收模式下同样执行——对端即权威源,删除也跟随
              await executor?.applyDelete(action.path, remoteEntry);
              localIndex.set(action.path, remoteEntry);
              // 该路径已在对端消失,中止本机在途接收,避免迟到块响应把它复活
              abortPending(action.path);
              onEvent?.({ ts: Date.now(), path: action.path, action: 'delete', direction: 'remote', deviceId: remoteDeviceId });
              // 应用对端墓碑也要纳入中转(ADR-0014):否则 hub 应用删除后,兄弟端在
              // 增量通道上永远学不到这条墓碑(本端扫描不会再为它生成事件,索引里已是
              // 墓碑),文件在兄弟端残留到下一次 full 交换(重连)才被补删——三端拓扑下
              // 「编辑器 tmp 中间文件」在叶子端长期残留即此形态(2026-09-20)。接收端走
              // 同一套 plan 机器:并发真改动仍按 conflict 保留冲突副本,不会误删。
              landed.push(remoteEntry);
            }
            break;
          }
          case 'receive': {
            const remoteEntry = remote.get(action.path);
            if (remoteEntry) {
              pending.set(remoteEntry.path, {
                kind: 'receive',
                entry: remoteEntry,
                blocks: new Array<Buffer | undefined>(remoteEntry.blocks.length),
                received: 0,
              });
              livePending.add(remoteEntry.path);
              landed.push(remoteEntry);
              requestMissingBlocks(remoteEntry.path, remoteEntry);
              // 空文件(0 块)不产生块请求,直接落地
              await completeIfReady(remoteEntry.path);
            }
            break;
          }
          case 'conflict': {
            const remoteEntry = remote.get(action.path);
            const localEntry = localIndex.get(action.path);
            // 本端是否真的改过这条文件:版本向量里带本机 deviceId 计数器 > 0 才算。
            // 否则只是「之前从别处同步来的陈旧副本」,与中转来的并发版本不构成真冲突。
            const genuineLocalEdit = !!localEntry && (localEntry.version.get(deviceId) ?? 0) > 0;
            // 中转场景(relayed):兄弟端只是陈旧同步副本 → 直接覆盖,不生成 .sync-conflict
            // (ADR-0014)。接收模式本就镜像覆盖。这两种都走 receive 落地,不保留冲突副本。
            if (receiveOnly || (opts?.relayed === true && !genuineLocalEdit)) {
              if (remoteEntry) {
                pending.set(remoteEntry.path, {
                  kind: 'receive',
                  entry: remoteEntry,
                  blocks: new Array<Buffer | undefined>(remoteEntry.blocks.length),
                  received: 0,
                });
                livePending.add(remoteEntry.path);
                landed.push(remoteEntry);
                requestMissingBlocks(remoteEntry.path, remoteEntry);
                await completeIfReady(remoteEntry.path);
              }
              break;
            }
            // 冲突自动策略(目录配置 conflictPolicy;缺省 keep-both = 下面的冲突副本行为)。
            // 只介入「真正的双活内容并发」:任一侧是墓碑时不判新旧/胜负,
            // 走既有 applyConflict 路径(双方删除有专门的墓碑合并)。
            const policy = getConflictPolicy?.() ?? 'keep-both';
            if (
              policy !== 'keep-both' &&
              remoteEntry &&
              localEntry &&
              !remoteEntry.deleted &&
              !localEntry.deleted
            ) {
              // 判胜负:local-wins 无条件保本地;newest-wins 比对双方 mtime ——
              // 任一侧缺 mtime(旧版对端不发 / 本机条目未记录)或打平都判不了,
              // remoteWins 保持 undefined,退回 keep-both 留冲突副本。
              let remoteWins: boolean | undefined;
              if (policy === 'local-wins') {
                remoteWins = false;
              } else if (localEntry.mtime !== undefined && remoteEntry.mtime !== undefined) {
                if (remoteEntry.mtime > localEntry.mtime) remoteWins = true;
                else if (localEntry.mtime > remoteEntry.mtime) remoteWins = false;
              }
              if (remoteWins === true) {
                // 对端内容胜出:按 receive 直接落地覆盖本地,不生成冲突副本。
                // landRemote 覆盖前的 snapshotVersion 旧内容快照仍会留一份兜底。
                pending.set(remoteEntry.path, {
                  kind: 'receive',
                  entry: remoteEntry,
                  blocks: new Array<Buffer | undefined>(remoteEntry.blocks.length),
                  received: 0,
                });
                livePending.add(remoteEntry.path);
                landed.push(remoteEntry);
                requestMissingBlocks(remoteEntry.path, remoteEntry);
                await completeIfReady(remoteEntry.path);
                break;
              }
              if (remoteWins === false) {
                // 本机内容胜出:不拉任何块,只在索引里采纳合并后的版本向量。
                // merged 逐设备取 max、支配对端版本 → 把本机条目回推,对端本轮
                // 即判「我方较新」来拉本机内容,收敛由协议自然完成、不会乒乓。
                const keep =
                  (await executor?.applyConflictKeepLocal(localEntry, remoteEntry)) ??
                  { ...localEntry, version: mergeVersions(localEntry.version, remoteEntry.version) };
                localIndex.set(action.path, keep);
                sends.push(keep);
                onEvent?.({
                  ts: Date.now(),
                  path: action.path,
                  action: 'conflict',
                  direction: 'local',
                  deviceId: remoteDeviceId,
                });
                break;
              }
            }
            if (remoteEntry && localEntry) {
              pending.set(remoteEntry.path, {
                kind: 'conflict',
                entry: remoteEntry,
                local: localEntry,
                blocks: new Array<Buffer | undefined>(remoteEntry.blocks.length),
                received: 0,
              });
              livePending.add(remoteEntry.path);
              landed.push(remoteEntry);
              requestMissingBlocks(remoteEntry.path, remoteEntry);
              await completeIfReady(remoteEntry.path);
            }
            break;
          }
        }
      }

      // 中转(ADR-0014):非 full 的增量接收落地后,把这批条目转发给同目录其它 transport。
      // 排除源端由 relayToSiblings 负责;full 交换已收敛整网,不中转避免(重)连时爆发式转发。
      // 接收模式(receiveOnly)设备不中转:它的契约就是「不向外推任何索引帧」,中转也是外推。
      if (!opts?.full && !receiveOnly && landed.length > 0) {
        onLanded?.(landed);
      }

      // 清理上一轮遗留、本轮**全量**索引已不再引用的陈旧 pending 条目:
      // 对端删除/改名后这些条目会永久滞留(进度虚报),且迟到的块响应
      // 可能把刚删除的文件临时复活。增量轮次不做这件事 —— 消息里没有的路径
      // 只是「这轮没提」,清掉就会把正在传的文件腰斩、且不会再有谁重新规划它。
      // 这里只需删 pending:本轮的 pendingBlocks 已在上面整体清掉(含全部定时器)。
      if (full) {
        for (const path of pending.keys()) {
          if (!livePending.has(path)) {
            pending.delete(path);
          }
        }
      }

      // 出向硬闸门(localIndex 出口的兜底):进入 localIndex 的条目本已被 filterIndexedEntries
      // 与扫描器过滤过,这里再收一道,保证「任何来源的硬忽略条目都不上线」这一性质只由
      // 本文件的 sendEntries 调用点决定,不依赖上游每一处都记得过滤。
      const outbound = sends.filter((e) => !isHardIgnored(e.path));
      if (outbound.length > 0) {
        // 规划出来的回推永远是「针对某几条路径的应答」,即 delta
        transport.sendEntries(outbound, 'delta');
      }
    },

    onBlockRequest(request: BlockRequest): void {
      // 端到端加密视图:盲区按「密文路径 + 密文块哈希」索块,服务路径完全不同,整支移交
      if (e2eKey !== undefined) {
        serveE2EBlock(request);
        return;
      }
      // 越界/非整数索引直接拒绝,避免对本地文件做无谓的整文件读取
      if (!Number.isInteger(request.blockIndex) || request.blockIndex < 0) return;
      // 读取侧路径防护(与写入侧 resolveSharePath 同款):拒绝 ../ 与经符号链接
      // 逃逸共享目录的路径,防止恶意对端经块请求读取目录外文件
      if (root !== undefined) {
        try {
          resolveSharePath(root, request.path);
        } catch {
          return;
        }
      }
      let data: Buffer;
      try {
        data = readLocalBlock(request.path, request.blockIndex);
      } catch {
        // 本地文件可能在块请求在途时被删除或重命名(如同步冲突处理),
        // 对端会在下一轮索引交换中收敛;忽略该请求即可。
        return;
      }
      // 块确实发出去了 → 该路径进入「发送中」,并按最后一个块续期租约
      serving.set(request.path, Date.now());
      // 文件级发送进度:按块精确累计,跳过已发过的块(对端重试不重复计)
      const sentSet = servedBlocks.get(request.path) ?? new Set<number>();
      if (!sentSet.has(request.blockIndex)) {
        sentSet.add(request.blockIndex);
        servedBlocks.set(request.path, sentSet);
        const total = localIndex.get(request.path)?.size ?? 0;
        const rec = servingBytes.get(request.path) ?? { done: 0, total };
        rec.total = total || rec.total;
        rec.done += data.length;
        servingBytes.set(request.path, rec);
      }
      // 块确实发出去了:记一笔发送字节,供瞬时速率统计
      recordBytes(data.length, 0);
      // 源请求带「优先同步」标记 → 本端发送队列把这个响应插到最前(见 wire.ts)
      transport.sendBlockResponse(
        {
          deviceId,
          path: request.path,
          blockIndex: request.blockIndex,
          hash: request.hash,
          data,
        },
        { priority: request.priority === true },
      );
    },

    async onBlockResponse(response: BlockResponse): Promise<void> {
      const item = pending.get(response.path);
      if (!item) return;
      // 边界校验:非法/越界 blockIndex 会撑大 pending.blocks 数组,造成内存耗尽型 DoS
      if (
        !Number.isInteger(response.blockIndex) ||
        response.blockIndex < 0 ||
        response.blockIndex >= item.entry.blocks.length
      ) {
        return;
      }
      // 块内容必须与本次请求期望的哈希一致(防对端回填自洽但错误的块)
      if (response.hash !== item.entry.blocks[response.blockIndex]) return;
      // 大小上限:合法块不会超过 BLOCK_SIZE,超大块直接丢弃,避免哈希前先撑爆内存
      if (response.data.length > BLOCK_SIZE) return;
      if (!verifyBlock(response.data, response.hash)) return;
      // 重复响应(如重传)不重复计数,避免虚增提前落地不完整文件
      if (item.blocks[response.blockIndex] !== undefined) return;

      item.blocks[response.blockIndex] = response.data;
      item.received += 1;
      // 块真的收下了(重复响应在上面已被挡掉):记一笔接收字节,供瞬时速率统计
      recordBytes(0, response.data.length);

      // 块已收到,清除对应的超时重试
      const bKey = blockKey(response.path, response.blockIndex);
      const bReq = pendingBlocks.get(bKey);
      if (bReq) {
        clearTimeout(bReq.timeout);
        pendingBlocks.delete(bKey);
      }

      await completeIfReady(response.path);
    },

    getSyncProgress(): ProgressCounts {
      const files: TransferFile[] = [];
      // 接收中:逐项累加已收块缓冲的字节数(本地预填的块也是真实 Buffer,一并计入)
      for (const [path, item] of pending) {
        if (item.kind !== 'receive') continue;
        let done = 0;
        for (const b of item.blocks) done += b?.length ?? 0;
        files.push({
          path,
          direction: 'receive',
          bytesDone: done,
          bytesTotal: item.entry.size,
          // 被「优先同步」点名中的行:UI 据此显示已提队状态,再点一次也无妨(幂等)
          ...(priorities.has(path) ? { priority: true } : {}),
        });
      }
      let receiving = 0;
      for (const item of pending.values()) {
        if (item.kind === 'receive') receiving += 1;
      }
      // 「发送中」= 租约内正被对端拉块的文件数。注意它统计的是**文件数**而不是块数:
      // 一个文件可能被请求几十个块,但对用户而言那是「1 个文件在传」。
      const now = Date.now();
      let servingCount = 0;
      for (const [path, ts] of serving) {
        if (now - ts > SERVE_LEASE_MS) {
          serving.delete(path);
          servingBytes.delete(path);
          servedBlocks.delete(path);
          continue;
        }
        servingCount += 1;
        const rec = servingBytes.get(path);
        if (rec) files.push({ path, direction: 'send', bytesDone: rec.done, bytesTotal: rec.total });
      }
      const result: ProgressCounts = {
        pending: pending.size,
        sending: servingCount,
        receiving,
      };
      // 速率按需携带:窗口内没有该方向的字节时省略字段,空闲快照保持与旧版同形
      const sendRate = bytesPerSecond('sent');
      if (sendRate > 0) result.sendRate = sendRate;
      const receiveRate = bytesPerSecond('recv');
      if (receiveRate > 0) result.receiveRate = receiveRate;
      if (files.length) result.files = files;
      return result;
    },
    retryDiskBlocked(): void {
      // 空间恢复后重放被拦下的那轮:与首次规划完全同路径(守卫再判一次,
      // 仍不足会重新挂起等下次重放,所以这里不必预判)。
      const saved = diskBlockedRetry;
      if (!saved) return;
      diskBlockedRetry = null;
      void self.onPeerIndex(saved.entries, saved.opts);
    },
    markPriority(path: string): void {
      const item = pending.get(path);
      if (!item) return; // 不在接收中:无队可插(还没开传的文件本就按规划顺序进行)
      priorities.add(path);
      // 为该路径全部未收齐的块**重发**带标记的块请求:发送端按请求标记把对应
      // 响应插到限速队列最前。重复块响应在 onBlockResponse 的闸门处去重,安全;
      // requestBlock 自身会清旧定时器,重试链不重复叠加。
      for (let i = 0; i < item.entry.blocks.length; i++) {
        if (item.blocks[i] === undefined) requestBlock(path, i, item.entry.blocks[i]!);
      }
    },
  };
  return self;
}
