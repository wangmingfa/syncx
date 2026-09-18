import type { IndexEntry } from './index.js';
import { buildPlan, buildDeltaPlan } from './plan.js';
import type { BlockRequest, BlockResponse } from './messages.js';
import type { LocalExecutor } from './executor.js';
import { resolveSharePath, preserveLocalAsConflict } from './executor.js';
import { verifyBlock, BLOCK_SIZE } from './blockstore.js';
import { parseIgnoreRules, isIgnoredPath, isHardIgnored, type IgnoreRule } from './ignore.js';
import type { ProgressCounts } from './status.js';

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
  sendBlockResponse(response: BlockResponse): void;
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
   * 收到并落地远程条目后回调(中转用,见 ADR-0014):上层据此把这批条目转发给
   * 同目录的其它 transport。只在「增量(非 full)接收」时触发——full 交换已经
   * 收敛整张网,无需再中转,否则每次(重)连都会把整份索引爆发式转发给兄弟端。
   * 仅包含真正进入 receive/conflict 落地的条目(其版本向量已是最终值),
   * 不含 send/delete 这类本地决策动作。
   */
  onLanded?: (entries: IndexEntry[]) => void;
  /**
   * 接收模式(只拉不推):本机只从对端拉取变更、应用对端删除,但**绝不**把本机
   * 的本地新增/修改/删除反灌给对端。开启后:本地较新/本地墓碑不再外推,冲突
   * 直接以对端版本覆盖本地。缺省 false = 双向同步。
   */
  receiveOnly?: boolean;
}

export interface SyncPeer {
  onPeerIndex(entries: IndexEntry[], opts?: PeerIndexOptions): Promise<void>;
  onBlockRequest(request: BlockRequest): void;
  onBlockResponse(response: BlockResponse): Promise<void>;
  getSyncProgress(): ProgressCounts;
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
/** 快速重试耗尽后的长间隔退避:继续重试而非丢弃条目。 */
const BLOCK_RETRY_LONG_MS = 30_000;

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
 * 所以只有真正停下来不传了,租约才会过期。
 */
const SERVE_LEASE_MS = 15_000;

/**
 * Wire one sync round over an injected transport: on receiving the peer's
 * index, send newer local entries, request missing blocks, apply deletions
 * and prepare conflict copies; collect block responses until a file is
 * complete, then apply it via the executor.
 */
export function createSyncPeer(deps: SyncPeerDeps): SyncPeer {
  const { transport, localIndex, executor, readLocalBlock, deviceId, remoteDeviceId, root, onEvent, readIgnoreLines, receiveOnly, onHardIgnoredDropped, onLanded } = deps;
  const pending = new Map<string, PendingEntry>();
  // 逐块跟踪超时重试:块响应丢失/丢弃时自动重发,避免文件永远收不齐
  const pendingBlocks = new Map<string, PendingBlockRequest>();
  // 正在向外供块的路径 → 最后一次发出该文件块的时间,用于展示「发送中」(见 SERVE_LEASE_MS)
  const serving = new Map<string, number>();

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
    for (const [key, request] of pendingBlocks) {
      if (key.slice(0, key.lastIndexOf(':')) !== path) continue;
      clearTimeout(request.timeout);
      pendingBlocks.delete(key);
    }
  }

  /** 发送单个块请求并设置超时重试。 */
  function requestBlock(path: string, blockIndex: number, hash: string): void {
    const key = blockKey(path, blockIndex);
    const existing = pendingBlocks.get(key);
    const retries = existing?.retries ?? 0;

    if (existing) {
      clearTimeout(existing.timeout);
      if (retries >= MAX_BLOCK_RETRIES) {
        // 快速重试(5s×3)耗尽后退避到 30s 长间隔继续重试,绝不丢弃条目:
        // 丢弃依赖"下一轮对端索引重建",但 onPeerIndex 只在对端发索引时触发,
        // 连接保持且对端无变化时条目会永久丢失、文件静默不同步。
        transport.sendBlockRequest({ deviceId, path, blockIndex, hash });
        const timeout = setTimeout(
          () => requestBlock(path, blockIndex, hash),
          BLOCK_RETRY_LONG_MS,
        );
        pendingBlocks.set(key, { retries, timeout });
        return;
      }
    }

    transport.sendBlockRequest({ deviceId, path, blockIndex, hash });
    const nextRetries = retries + 1;
    const timeout = setTimeout(() => requestBlock(path, blockIndex, hash), BLOCK_REQUEST_TIMEOUT_MS);
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

  return {
    async onPeerIndex(entries: IndexEntry[], opts?: PeerIndexOptions): Promise<void> {
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
      const sends: IndexEntry[] = [];
      // 本轮索引实际引用的 pending 路径:仅用于全量轮次清理上一轮遗留的陈旧条目
      const livePending = new Set<string>();
      // 本轮真正落地(进入 receive/conflict 接收)的远程条目:供 onLanded 中转给兄弟端
      const landed: IndexEntry[] = [];

      for (const action of actions) {
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
      transport.sendBlockResponse({
        deviceId,
        path: request.path,
        blockIndex: request.blockIndex,
        hash: request.hash,
        data,
      });
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
          continue;
        }
        servingCount += 1;
      }
      return {
        pending: pending.size,
        sending: servingCount,
        receiving,
      };
    },
  };
}
