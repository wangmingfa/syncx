import type { IndexEntry } from './index.js';
import type { SnapshotEntry } from './diff.js';
import type { VersionVector } from './version.js';

interface WireEntry {
  path: string;
  version: Array<[string, number]>;
  size: number;
  deleted: boolean;
  blocks: string[];
  /**
   * 对端落盘该条目时的文件修改时间(毫秒)。**供「冲突自动策略 = newest-wins」跨机比较**。
   * 可选:旧版对端不发(解码为 undefined,收侧退回 keep-both),新版发到旧对端时被其
   * 显式字段映射直接丢弃,双向兼容。跨机比较依赖各机时钟,漂移大时判定可能不准 ——
   * 这是 mtime 语义的固有代价,策略文案中已向用户提示。
   */
  mtime?: number;
  /**
   * CDC 块哈希/块长(见 IndexEntry.cdh)。**纯附加**字段:旧版对端的解码是显式
   * 字段映射,不认识它就直接丢弃 → 自动退回定长块口径;新版↔新版双方都有时才
   * 启用按内容分块的差集规划。正因为是纯附加,这里**不需要任何能力协商**。
   */
  cdh?: string[];
  clens?: number[];
}

export function encodeIndex(entries: IndexEntry[]): Buffer {
  // 按需同步的占位条目永不出线(唯一收口):盘上没有实体文件,宣告出去等于
  // 谎称「我供得出这块内容」——对端会来拉块而永远拿不到(见 IndexEntry.placeholder)。
  // 占位的传播由真正持有内容的设备负责;本机落地(materialize)后自然恢复宣告。
  const wire: WireEntry[] = entries.filter((e) => !e.placeholder).map((e) => ({
    path: e.path,
    version: [...e.version.entries()],
    size: e.size,
    deleted: e.deleted,
    blocks: e.blocks,
    // mtime 随索引出线:供对端 newest-wins 冲突策略比较新旧(见 WireEntry.mtime)
    mtime: e.mtime,
    // CDC 视图随条目出线(纯附加,旧对端忽略,见 WireEntry.cdh)
    cdh: e.cdh,
    clens: e.clens,
  }));
  return Buffer.from(JSON.stringify(wire), 'utf8');
}

export function decodeIndex(buffer: Buffer): IndexEntry[] {
  const wire = JSON.parse(buffer.toString('utf8')) as WireEntry[];
  return wire.map((e) => ({
    path: e.path,
    version: new Map(e.version) as VersionVector,
    size: e.size,
    deleted: e.deleted,
    blocks: e.blocks,
    mtime: e.mtime,
    // cdh 与 clens 必须等长且非空才算有 CDC 视图(对端数据不可信,宽进严出)
    ...(e.cdh && e.clens && e.cdh.length > 0 && e.cdh.length === e.clens.length
      ? { cdh: e.cdh, clens: e.clens }
      : {}),
  }));
}

/**
 * 诊断用的索引快照编解码(内容对比功能)。
 *
 * 与 encodeIndex 的区别:快照条目带的是**折叠后的内容摘要**而不是完整块列表
 * (见 diff.ts 的 SnapshotEntry),因此条目体积不随文件大小膨胀,几千个文件的
 * 目录也能靠分片传完。分片逻辑在 session-manager(每片若干条 + seq/total),
 * 这里只负责一帧之内的编解码。
 */
export function encodeSnapshot(entries: SnapshotEntry[]): Buffer {
  return Buffer.from(JSON.stringify(entries), 'utf8');
}

export function decodeSnapshot(buffer: Buffer): SnapshotEntry[] {
  return JSON.parse(buffer.toString('utf8')) as SnapshotEntry[];
}

export interface BlockRequest {
  deviceId: string;
  path: string;
  blockIndex: number;
  hash: string;
  /**
   * 「优先同步」标记:接收方手动提队某文件后,为该文件重发的块请求带上它。
   * 发送方据此把该文件的块响应插到限速发送队列最前(见 wire.ts),让被卡住的
   * 小文件越过排在前面的一大块。可选字段,JSON 协议旧版对端直接忽略 —— 只是
   * 少了插队能力,正确性不受影响。
   */
  priority?: boolean;
  /**
   * 块口径标记:true = blockIndex/hash 按 **CDC 内容分块**口径
   * (该路径条目 cdh/clens 列表的下标与偏移,响应块长可达 CDC_MAX_CHUNK)。
   * 可选字段:不带 = 定长 1MB 块(旧版对端、或本条目没有 CDC 视图),双向兼容,
   * 无需协商 —— 旧对端收到带标记的请求也只会按定长供块,接收端哈希校验不过自然
   * 退回重试/下轮收敛(效率退化,数据不会坏)。
   */
  cdc?: boolean;
}

export interface BlockResponse {
  deviceId: string;
  path: string;
  blockIndex: number;
  hash: string;
  data: Buffer;
  /** 回显请求的 CDC 口径标记(见 BlockRequest.cdc),接收端据此选择校验列表。 */
  cdc?: boolean;
}

export function encodeBlockRequest(request: BlockRequest): Buffer {
  return Buffer.from(JSON.stringify(request), 'utf8');
}

export function decodeBlockRequest(buffer: Buffer): BlockRequest {
  return JSON.parse(buffer.toString('utf8')) as BlockRequest;
}

export function encodeBlockResponse(response: BlockResponse): Buffer {
  return Buffer.from(
    JSON.stringify({
      deviceId: response.deviceId,
      path: response.path,
      blockIndex: response.blockIndex,
      hash: response.hash,
      data: response.data.toString('base64'),
      cdc: response.cdc,
    }),
    'utf8',
  );
}

export function decodeBlockResponse(buffer: Buffer): BlockResponse {
  const wire = JSON.parse(buffer.toString('utf8')) as Omit<BlockResponse, 'data'> & {
    data: string;
  };
  return {
    deviceId: wire.deviceId,
    path: wire.path,
    blockIndex: wire.blockIndex,
    hash: wire.hash,
    data: Buffer.from(wire.data, 'base64'),
    ...(wire.cdc === true ? { cdc: true } : {}),
  };
}
