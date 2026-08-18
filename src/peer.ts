import type { IndexEntry } from './index.js';
import { buildPlan } from './plan.js';
import type { BlockRequest, BlockResponse } from './messages.js';
import type { LocalExecutor } from './executor.js';
import { verifyBlock, BLOCK_SIZE } from './blockstore.js';
import { mergeVersions } from './version.js';

export interface RoundPlan {
  send: IndexEntry[];
  /** Blocks to request; the peer session fills in deviceId later. */
  requestBlocks: Array<Omit<BlockRequest, 'deviceId'>>;
}

/**
 * Plan one sync round from the local perspective: which entries to send
 * to the remote, and which blocks to request from the remote.
 */
export function planSyncRound(
  local: Map<string, IndexEntry>,
  remote: Map<string, IndexEntry>,
): RoundPlan {
  const actions = buildPlan(local, remote);
  const send: IndexEntry[] = [];
  const requestBlocks: Array<Omit<BlockRequest, 'deviceId'>> = [];

  for (const action of actions) {
    switch (action.kind) {
      case 'send':
        send.push(action.entry);
        break;
      case 'delete': {
        const localEntry = local.get(action.path);
        if (localEntry?.deleted) {
          send.push(localEntry);
        }
        break;
      }
      case 'receive':
        action.entry.blocks.forEach((hash, blockIndex) => {
          requestBlocks.push({
            path: action.path,
            blockIndex,
            hash,
          });
        });
        break;
      case 'conflict':
        // conflict 由会话层处理:拉远端块,完成后生成冲突副本
        break;
    }
  }

  return { send, requestBlocks };
}

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

/**
 * Wire one sync round over an injected transport: on receiving the peer's
 * index, send newer local entries, request missing blocks, apply deletions
 * and prepare conflict copies; collect block responses until a file is
 * complete, then apply it via the executor.
 */
export function createSyncPeer(deps: SyncPeerDeps): SyncPeer {
  const { transport, localIndex, executor, readLocalBlock, deviceId, remoteDeviceId } = deps;
  const pending = new Map<string, PendingEntry>();

  function requestAllBlocks(entry: IndexEntry): void {
    entry.blocks.forEach((hash, blockIndex) => {
      transport.sendBlockRequest({ deviceId, path: entry.path, blockIndex, hash });
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
      await executor?.applyConflict(
        path,
        item.local,
        item.entry,
        provider,
        remoteDeviceId ?? '',
      );
      // 同步内存索引,使后续规划基于最新本地状态
      localIndex.set(path, { ...item.entry, version: mergeVersions(item.local.version, item.entry.version) });
    } else {
      await executor?.applyReceive(item.entry, provider);
      localIndex.set(path, item.entry);
    }
  }

  return {
    async onPeerIndex(entries: IndexEntry[]): Promise<void> {
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

      await completeIfReady(response.path);
    },
  };
}
