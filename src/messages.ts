import type { IndexEntry } from './index.js';
import type { SnapshotEntry } from './diff.js';
import type { VersionVector } from './version.js';

interface WireEntry {
  path: string;
  version: Array<[string, number]>;
  size: number;
  deleted: boolean;
  blocks: string[];
}

export function encodeIndex(entries: IndexEntry[]): Buffer {
  const wire: WireEntry[] = entries.map((e) => ({
    path: e.path,
    version: [...e.version.entries()],
    size: e.size,
    deleted: e.deleted,
    blocks: e.blocks,
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
}

export interface BlockResponse {
  deviceId: string;
  path: string;
  blockIndex: number;
  hash: string;
  data: Buffer;
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
  };
}
