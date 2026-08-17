import type { IndexEntry } from './index.js';
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
