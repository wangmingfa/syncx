import type { IndexEntry } from './index.js';
import { buildPlan } from './plan.js';
import type { BlockRequest, BlockResponse } from './messages.js';
import type { LocalExecutor } from './executor.js';
import { verifyBlock, BLOCK_SIZE } from './blockstore.js';
import type { ProgressCounts } from './status.js';

export interface PeerTransport {
  sendEntries(entries: IndexEntry[]): void;
  sendBlockRequest(request: BlockRequest): void;
  sendBlockResponse(response: BlockResponse): void;
}

export interface SyncPeerDeps {
  transport: PeerTransport;
  localIndex: Map<string, IndexEntry>;
  executor?: LocalExecutor;
  readLocalBlock(path: string, blockIndex: number): Buffer;
  deviceId: string;
  /** Peer device ID, used to name conflict copies. */
  remoteDeviceId?: string;
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

/**
 * Wire one sync round over an injected transport: on receiving the peer's
 * index, send newer local entries, request missing blocks, apply deletions
 * and prepare conflict copies; collect block responses until a file is
 * complete, then apply it via the executor.
 */
export function createSyncPeer(deps: SyncPeerDeps): SyncPeer {
  const { transport, localIndex, executor, readLocalBlock, deviceId, remoteDeviceId } = deps;
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
        // 重试耗尽:该块无法收齐,清掉对应 pending 条目(下一轮 onPeerIndex 会自然重建),
        // 避免条目无期限滞留
        pendingBlocks.delete(key);
        pending.delete(path);
        return;
      }
    }

    transport.sendBlockRequest({ deviceId, path, blockIndex, hash });
    const nextRetries = retries + 1;
    const timeout = setTimeout(() => requestBlock(path, blockIndex, hash), BLOCK_REQUEST_TIMEOUT_MS);
    pendingBlocks.set(key, { retries: nextRetries, timeout });
  }

  function requestAllBlocks(entry: IndexEntry): void {
    entry.blocks.forEach((hash, blockIndex) => requestBlock(entry.path, blockIndex, hash));
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
      const landed = await executor?.applyConflict(
        path,
        item.local,
        item.entry,
        provider,
        remoteDeviceId ?? '',
      );
      // 同步内存索引,使后续规划基于最新本地状态:以实际落盘结果为准
      if (landed) {
        localIndex.set(path, landed);
      }
    } else {
      await executor?.applyReceive(item.entry, provider);
      localIndex.set(path, item.entry);
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
              requestAllBlocks(remoteEntry);
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
              requestAllBlocks(remoteEntry);
              await completeIfReady(remoteEntry.path);
            }
            break;
          }
        }
      }

      transport.sendEntries(sends);
      pendingSendCount = sends.length;
    },

    onBlockRequest(request: BlockRequest): void {
      // 越界/非整数索引直接拒绝,避免对本地文件做无谓的整文件读取
      if (!Number.isInteger(request.blockIndex) || request.blockIndex < 0) return;
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
