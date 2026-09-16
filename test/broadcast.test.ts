import { describe, expect, it } from 'vitest';
import { broadcastFolderUpdates } from '../src/broadcast.js';
import type { PeerTransport, IndexMode } from '../src/peer.js';
import type { IndexEntry } from '../src/index.js';

function fakeTransport() {
  const sent: IndexEntry[][] = [];
  const modes: IndexMode[] = [];
  const transport: PeerTransport = {
    sendEntries(entries: IndexEntry[], mode: IndexMode): void {
      sent.push(entries);
      modes.push(mode);
    },
    sendBlockRequest(): void {},
    sendBlockResponse(): void {},
  };
  return { transport, sent, modes };
}

const e = (path: string): IndexEntry => ({
  path,
  version: new Map(),
  size: 0,
  deleted: false,
  blocks: [],
});

describe('broadcastFolderUpdates', () => {
  it('sends entries only to the same folder transports, never to other folders', () => {
    const a1 = fakeTransport();
    const a2 = fakeTransport();
    const b1 = fakeTransport();
    const folderA = { transports: [a1.transport, a2.transport] };
    const folderB = { transports: [b1.transport] };

    broadcastFolderUpdates(folderA, [e('a-only.txt')]);

    expect(a1.sent).toEqual([[e('a-only.txt')]]);
    expect(a2.sent).toEqual([[e('a-only.txt')]]);
    // 广播出去的是增量,必须标 delta:标成 full 会让对端按并集规划,
    // 把「本机独有的条目」当成对端缺失而回推,两端互为回声(2026-09-16 事故)
    expect(a1.modes).toEqual(['delta']);
    expect(a2.modes).toEqual(['delta']);
    // 关键:目录 B 的 transport 绝不能收到目录 A 的条目(历史跨目录错路由 bug)
    expect(b1.sent).toEqual([]);
  });

  it('does not broadcast when there are no entries', () => {
    const a1 = fakeTransport();
    const folderA = { transports: [a1.transport] };
    broadcastFolderUpdates(folderA, []);
    expect(a1.sent).toEqual([]);
  });
});
