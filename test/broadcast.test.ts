import { describe, expect, it } from 'vitest';
import { broadcastFolderUpdates } from '../src/broadcast.js';
import type { PeerTransport } from '../src/peer.js';
import type { IndexEntry } from '../src/index.js';

function fakeTransport() {
  const sent: IndexEntry[][] = [];
  const transport: PeerTransport = {
    sendEntries(entries: IndexEntry[]): void {
      sent.push(entries);
    },
    sendBlockRequest(): void {},
    sendBlockResponse(): void {},
  };
  return { transport, sent };
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
