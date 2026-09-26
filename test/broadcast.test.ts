import { describe, expect, it } from 'vitest';
import { broadcastFolderUpdates } from '../src/broadcast.js';
import { relayToSiblings } from '../src/relay.js';
import type { PeerTransport, IndexMode } from '../src/peer.js';
import type { IndexEntry } from '../src/index.js';

function fakeTransport() {
  const sent: IndexEntry[][] = [];
  const modes: IndexMode[] = [];
  const relayFlags: (boolean | undefined)[] = [];
  const transport: PeerTransport = {
    sendEntries(entries: IndexEntry[], mode: IndexMode, opts?: { relayed?: boolean }): void {
      sent.push(entries);
      modes.push(mode);
      relayFlags.push(opts?.relayed);
    },
    sendBlockRequest(): void {},
    sendBlockResponse(): void {},
  };
  return { transport, sent, modes, relayFlags };
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

  it('sends one copy per device when a device holds two transports (both-direction connections)', () => {
    // 设备对之间至多两条连接(每方向一条,设计内):同一份增量发给两条会诱发
    // 对端双管线并排双落地、后一次覆盖窗口期编辑(2026-09 混版本实测静默分叉)
    const dev1a = fakeTransport();
    const dev1b = fakeTransport();
    const dev2 = fakeTransport();
    const transports = [dev1a.transport, dev1b.transport, dev2.transport];
    const transportDevice = new Map([
      [dev1a.transport, 'DEV-1'],
      [dev1b.transport, 'DEV-1'],
      [dev2.transport, 'DEV-2'],
    ]);

    broadcastFolderUpdates({ transports, transportDevice }, [e('a.txt')]);

    expect(dev1a.sent).toEqual([[e('a.txt')]]);
    expect(dev1b.sent).toEqual([]);
    expect(dev2.sent).toEqual([[e('a.txt')]]);
  });

  it('falls back to per-transport fanout without a device map (legacy callers)', () => {
    const t1 = fakeTransport();
    const t2 = fakeTransport();
    broadcastFolderUpdates({ transports: [t1.transport, t2.transport] }, [e('a.txt')]);
    expect(t1.sent.length).toBe(1);
    expect(t2.sent.length).toBe(1);
  });
});

describe('relayToSiblings', () => {
  it('never relays back to the source device, even via its second transport', () => {
    const srcA = fakeTransport();
    const srcB = fakeTransport(); // 来源设备的另一条连接(反方向)
    const sib = fakeTransport();
    const transportDevice = new Map([
      [srcA.transport, 'DEV-1'],
      [srcB.transport, 'DEV-1'],
      [sib.transport, 'DEV-2'],
    ]);

    relayToSiblings([srcA.transport, srcB.transport, sib.transport], srcA.transport, [e('x.txt')], transportDevice);

    expect(srcA.sent).toEqual([]);
    expect(srcB.sent).toEqual([]);
    expect(sib.sent).toEqual([[e('x.txt')]]);
    // 中转必须标 delta + relayed:当全量会引发回声循环(2026-09-16),
    // 缺 relayed 标记会让兄弟端把陈旧同步副本误判成真冲突、刷出 .sync-conflict
    expect(sib.modes).toEqual(['delta']);
    expect(sib.relayFlags).toEqual([true]);
  });

  it('relays once per sibling device holding two transports', () => {
    const src = fakeTransport();
    const sibA = fakeTransport();
    const sibB = fakeTransport();
    const transportDevice = new Map([
      [src.transport, 'DEV-1'],
      [sibA.transport, 'DEV-2'],
      [sibB.transport, 'DEV-2'],
    ]);

    relayToSiblings([src.transport, sibA.transport, sibB.transport], src.transport, [e('x.txt')], transportDevice);

    expect(sibA.sent.length).toBe(1);
    expect(sibB.sent.length).toBe(0);
  });
});
