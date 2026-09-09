import type { IndexEntry } from './index.js';
import { buildPlan } from './plan.js';
import type { BlockRequest, BlockResponse } from './messages.js';
import type { LocalExecutor } from './executor.js';
import { resolveSharePath, preserveLocalAsConflict } from './executor.js';
import { verifyBlock, BLOCK_SIZE } from './blockstore.js';
import { parseIgnoreRules, isIgnored } from './ignore.js';
import type { ProgressCounts } from './status.js';

export interface PeerTransport {
  sendEntries(entries: IndexEntry[]): void;
  sendBlockRequest(request: BlockRequest): void;
  sendBlockResponse(response: BlockResponse): void;
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
  /** 共享目录的 .syncxignore 行:接收保护据此跳过被忽略的文件。 */
  ignoreLines?: string[];
  /** 所属共享目录 ID(用于落盘同步记录)。 */
  folderId: string;
  /** 记录一次同步变更(新增/修改/删除/冲突),由上层写入历史存储。 */
  onEvent?: (ev: SyncEventInput) => void;
}

export interface SyncPeer {
  onPeerIndex(entries: IndexEntry[]): Promise<void>;
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
 * Wire one sync round over an injected transport: on receiving the peer's
 * index, send newer local entries, request missing blocks, apply deletions
 * and prepare conflict copies; collect block responses until a file is
 * complete, then apply it via the executor.
 */
export function createSyncPeer(deps: SyncPeerDeps): SyncPeer {
  const { transport, localIndex, executor, readLocalBlock, deviceId, remoteDeviceId, root, onEvent, ignoreLines } = deps;
  const pending = new Map<string, PendingEntry>();
  // 逐块跟踪超时重试:块响应丢失/丢弃时自动重发,避免文件永远收不齐
  const pendingBlocks = new Map<string, PendingBlockRequest>();
  // 本轮待发送条目数(上次 onPeerIndex 产生的 sends 数量),用于同步进度展示
  let pendingSendCount = 0;

  function blockKey(path: string, blockIndex: number): string {
    return `${path}:${blockIndex}`;
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
          const rules = ignoreLines ? parseIgnoreRules(ignoreLines) : [];
          if (!isIgnored(rules, path, false)) {
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
    async onPeerIndex(entries: IndexEntry[]): Promise<void> {
      // 新索引到达(如重连后)时清除旧块请求,避免基于过期条目重试
      for (const bReq of pendingBlocks.values()) clearTimeout(bReq.timeout);
      pendingBlocks.clear();
      pendingSendCount = 0;
      const remote = new Map(entries.map((e) => [e.path, e]));
      const actions = buildPlan(localIndex, remote);
      const sends: IndexEntry[] = [];
      // 本轮索引实际引用的 pending 路径:用于清理上一轮遗留的陈旧条目
      const livePending = new Set<string>();

      for (const action of actions) {
        switch (action.kind) {
          case 'send':
            sends.push(action.entry);
            break;
          case 'delete': {
            const localEntry = localIndex.get(action.path);
            const remoteEntry = remote.get(action.path);
            if (localEntry?.deleted) {
              // 本地墓碑:传播给对端
              sends.push(localEntry);
            } else if (remoteEntry?.deleted) {
              // 对端墓碑:本地删除
              await executor?.applyDelete(action.path, remoteEntry);
              localIndex.set(action.path, remoteEntry);
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
              requestMissingBlocks(remoteEntry.path, remoteEntry);
              // 空文件(0 块)不产生块请求,直接落地
              await completeIfReady(remoteEntry.path);
            }
            break;
          }
          case 'conflict': {
            const remoteEntry = remote.get(action.path);
            const localEntry = localIndex.get(action.path);
            if (remoteEntry && localEntry) {
              pending.set(remoteEntry.path, {
                kind: 'conflict',
                entry: remoteEntry,
                local: localEntry,
                blocks: new Array<Buffer | undefined>(remoteEntry.blocks.length),
                received: 0,
              });
              livePending.add(remoteEntry.path);
              requestMissingBlocks(remoteEntry.path, remoteEntry);
              await completeIfReady(remoteEntry.path);
            }
            break;
          }
        }
      }

      // 清理上一轮遗留、本轮索引已不再引用的陈旧 pending 条目:
      // 对端删除/改名后这些条目会永久滞留(进度虚报),且迟到的块响应
      // 可能把刚删除的文件临时复活
      for (const path of pending.keys()) {
        if (!livePending.has(path)) {
          pending.delete(path);
        }
      }

      if (sends.length > 0) {
        transport.sendEntries(sends);
      }
      pendingSendCount = sends.length;
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
      return {
        pending: pending.size,
        sending: pendingSendCount,
        receiving,
      };
    },
  };
}
