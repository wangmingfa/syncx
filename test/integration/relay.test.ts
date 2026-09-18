import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { rmDir } from '../helpers.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import { startPeerServer } from '../../src/net/server.js';
import { connectPeer } from '../../src/net/client.js';
import { loadOrCreateIdentity } from '../../src/identity.js';
import { openIndexStore, type IndexStore } from '../../src/indexstore.js';
import { createLocalExecutor, type LocalExecutor } from '../../src/executor.js';
import { createSyncPeer, type SyncPeer, type PeerTransport, type IndexMode } from '../../src/peer.js';
import { encodeIndex, decodeIndex } from '../../src/messages.js';
import { splitIntoBlocks } from '../../src/blockstore.js';
import type { IndexEntry } from '../../src/index.js';

function entry(
  path: string,
  version: Array<[string, number]>,
  blocks: string[] = [],
  size = 0,
  deleted = false,
): IndexEntry {
  return { path, version: new Map(version), size, deleted, blocks };
}

function waitFor(condition: () => boolean, timeoutMs = 4000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = (): void => {
      if (condition()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('timed out waiting for condition'));
        return;
      }
      setTimeout(check, 25);
    };
    check();
  });
}

/* ==================== 链路集成:中继的传播与回声 ==================== */

interface ChainDevice {
  id: string;
  dir: string;
  share: string;
  index: IndexStore;
  executor: LocalExecutor;
  deviceId: string;
  local: Map<string, IndexEntry>;
  /** 本端向对端发送索引的 socket(叶子端用). */
  socket: WebSocket;
  /** 本端发出的 index 消息条数(回声环检测). */
  sent: { count: number };
  /** 本端收到的 index 消息条数(确认 hub 不把改动弹回来源端). */
  received: { count: number };
}

/** Send-side only: 透传 full / relayed 标记,统计发送条数. */
function makeTransport(socket: WebSocket, sent: { count: number }): PeerTransport {
  return {
    sendEntries(entries: IndexEntry[], mode: IndexMode, opts?: { relayed?: boolean }): void {
      sent.count += 1;
      socket.send(
        JSON.stringify({
          type: 'index',
          payload: encodeIndex(entries).toString('base64'),
          full: mode === 'full',
          relayed: opts?.relayed === true,
        }),
      );
    },
    sendBlockRequest(request): void {
      socket.send(JSON.stringify({ type: 'block-request', payload: request }));
    },
    sendBlockResponse(response): void {
      socket.send(
        JSON.stringify({
          type: 'block-response',
          payload: { ...response, data: response.data.toString('base64') },
        }),
      );
    },
  };
}

/** Receive-side: 分发入站消息给 peer,统计接收条数,透传 relayed 标记. */
function attachIncoming(peer: SyncPeer, socket: WebSocket, received: { count: number }): void {
  socket.on('message', (data) => {
    const raw = data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data as Buffer);
    const msg = JSON.parse(raw.toString('utf8')) as {
      type: 'index' | 'block-request' | 'block-response';
      payload: unknown;
      full?: boolean;
      relayed?: boolean;
    };
    if (msg.type === 'index') received.count += 1;
    switch (msg.type) {
      case 'index':
        void peer.onPeerIndex(decodeIndex(Buffer.from(msg.payload as string, 'base64')), {
          full: msg.full === true,
          relayed: msg.relayed === true,
        });
        break;
      case 'block-request':
        peer.onBlockRequest(msg.payload as never);
        break;
      case 'block-response': {
        const payload = msg.payload as { data: string } & Omit<
          import('../../src/messages.js').BlockResponse,
          'data'
        >;
        void peer.onBlockResponse({ ...payload, data: Buffer.from(payload.data, 'base64') });
        break;
      }
    }
  });
}

interface Chain {
  a: ChainDevice;
  b: ChainDevice;
  c: ChainDevice;
  sockets: WebSocket[];
}

/**
 * 建一条 A-B-C 链:A 只连 B,B 是 hub(同时连 A 和 C),C 只连 B。
 * B 的两个 peer 互相把「收到的落地条目」中转给对方(排除来源端),即 ADR-0014 的 mesh transit。
 */
async function connectChain(
  aLocal: Map<string, IndexEntry>,
  bLocal: Map<string, IndexEntry>,
  cLocal: Map<string, IndexEntry>,
  roots: { a: string; b: string; c: string },
): Promise<Chain> {
  const dirs = { a: join(roots.a, '..'), b: join(roots.b, '..'), c: join(roots.c, '..') };
  const aIdentity = loadOrCreateIdentity(join(dirs.a, 'id'));
  const bIdentity = loadOrCreateIdentity(join(dirs.b, 'id'));
  const cIdentity = loadOrCreateIdentity(join(dirs.c, 'id'));

  const aIndex = openIndexStore(join(dirs.a, 'index.db'));
  const bIndex = openIndexStore(join(dirs.b, 'index.db'));
  const cIndex = openIndexStore(join(dirs.c, 'index.db'));
  const aExec = createLocalExecutor(roots.a, aIndex, join(roots.a, '.syncx-trash'));
  const bExec = createLocalExecutor(roots.b, bIndex, join(roots.b, '.syncx-trash'));
  const cExec = createLocalExecutor(roots.c, cIndex, join(roots.c, '.syncx-trash'));

  const sent = { a: { count: 0 }, b: { count: 0 }, c: { count: 0 } };
  const recv = { a: { count: 0 }, b: { count: 0 }, c: { count: 0 } };

  let aSocket: WebSocket | undefined;
  let bFromC: WebSocket | undefined;
  const aServer = startPeerServer(aIdentity, { onPeerConnected: (s) => (aSocket = s), onError: () => {} }, 0);
  const bServer = startPeerServer(bIdentity, { onPeerConnected: (s) => (bFromC = s), onError: () => {} }, 0);

  // B 拨 A,C 拨 B
  const bToA = (await connectPeer(bIdentity, `ws://127.0.0.1:${aServer.port}`)).socket;
  const cToB = (await connectPeer(cIdentity, `ws://127.0.0.1:${bServer.port}`)).socket;
  await waitFor(() => aSocket !== undefined && bFromC !== undefined, 3000);

  const readBlock = (root: string) => (path: string, blockIndex: number) => {
    const blocks = splitIntoBlocks(readFileSync(join(root, path)));
    return blocks[blockIndex]!;
  };

  const aTransport = makeTransport(aSocket!, sent.a);
  const bTransportToA = makeTransport(bToA, sent.b);
  const bTransportToC = makeTransport(bFromC!, sent.b);
  const cTransport = makeTransport(cToB, sent.c);

  const aPeer = createSyncPeer({
    transport: aTransport, localIndex: aLocal, executor: aExec, readLocalBlock: readBlock(roots.a),
    deviceId: aIdentity.deviceId, remoteDeviceId: bIdentity.deviceId,
    onLanded: () => {}, // 叶子端(A),无兄弟可中转
  });
  const bPeerToA = createSyncPeer({
    transport: bTransportToA, localIndex: bLocal, executor: bExec, readLocalBlock: readBlock(roots.b),
    deviceId: bIdentity.deviceId, remoteDeviceId: aIdentity.deviceId,
    onLanded: (entries) => bTransportToC.sendEntries(entries, 'delta', { relayed: true }),
  });
  const bPeerToC = createSyncPeer({
    transport: bTransportToC, localIndex: bLocal, executor: bExec, readLocalBlock: readBlock(roots.b),
    deviceId: bIdentity.deviceId, remoteDeviceId: cIdentity.deviceId,
    onLanded: (entries) => bTransportToA.sendEntries(entries, 'delta', { relayed: true }),
  });
  const cPeer = createSyncPeer({
    transport: cTransport, localIndex: cLocal, executor: cExec, readLocalBlock: readBlock(roots.c),
    deviceId: cIdentity.deviceId, remoteDeviceId: bIdentity.deviceId,
    onLanded: () => {}, // 叶子端(C),无兄弟可中转
  });

  attachIncoming(aPeer, aSocket!, recv.a);
  attachIncoming(bPeerToA, bToA, recv.b);
  attachIncoming(bPeerToC, bFromC!, recv.b);
  attachIncoming(cPeer, cToB, recv.c);

  // 会话建立时互发完整索引(与生产 attachFolderToSession 一致)
  const sendFull = (socket: WebSocket, local: Map<string, IndexEntry>): void => {
    socket.send(
      JSON.stringify({ type: 'index', payload: encodeIndex([...local.values()]).toString('base64'), full: true }),
    );
  };
  sendFull(aSocket!, aLocal);
  sendFull(bToA, bLocal);
  sendFull(bFromC!, bLocal);
  sendFull(cToB, cLocal);

  const mk = (
    id: string, dir: string, share: string, index: IndexStore, exec: LocalExecutor,
    local: Map<string, IndexEntry>, socket: WebSocket, s: { count: number }, r: { count: number },
  ): ChainDevice => ({ id, dir, share, index, executor: exec, deviceId: id, local, socket, sent: s, received: r });

  return {
    a: mk('A', dirs.a, roots.a, aIndex, aExec, aLocal, aSocket!, sent.a, recv.a),
    b: mk('B', dirs.b, roots.b, bIndex, bExec, bLocal, bFromC!, sent.b, recv.b),
    c: mk('C', dirs.c, roots.c, cIndex, cExec, cLocal, cToB, sent.c, recv.c),
    sockets: [aSocket!, bToA, bFromC!, cToB],
  };
}

/** 模拟 C 的扫描器:把一批改动作为**增量**广播给 B(走 C→B 的 socket). */
function sendDeltaToB(chain: Chain, entries: IndexEntry[]): void {
  chain.c.socket.send(
    JSON.stringify({ type: 'index', payload: encodeIndex(entries).toString('base64'), full: false }),
  );
}

async function teardown(chain: Chain): Promise<void> {
  for (const s of chain.sockets) s.close();
  await new Promise((r) => setTimeout(r, 50));
  for (const d of [chain.a, chain.b, chain.c]) d.index.close();
  for (const d of [chain.a, chain.b, chain.c]) rmDir(d.dir);
}

function makeRoots(): { a: string; b: string; c: string } {
  const roots = {
    a: join(mkdtempSync(join(tmpdir(), 'syncx-relay-a-')), 'share'),
    b: join(mkdtempSync(join(tmpdir(), 'syncx-relay-b-')), 'share'),
    c: join(mkdtempSync(join(tmpdir(), 'syncx-relay-c-')), 'share'),
  };
  for (const r of [roots.a, roots.b, roots.c]) mkdirSync(r, { recursive: true });
  return roots;
}

describe('relay propagation across a chain (ADR-0014)', () => {
  it('propagates an incremental edit on C to A through the B hub', async () => {
    const roots = makeRoots();
    // 三端初始一致(都已有 {dev-c:1});连接期的 full 交换不会产生跨端 planning,
    // 这样随后 C 的增量才真正只经由中继到达 A。
    const seed = (): Map<string, IndexEntry> => new Map([['doc.txt', entry('doc.txt', [['dev-c', 1]])]]);
    const chain = await connectChain(seed(), seed(), seed(), roots);

    const updated = entry('doc.txt', [['dev-c', 2]]);
    chain.c.local.set('doc.txt', updated);
    sendDeltaToB(chain, [updated]);

    await waitFor(() => chain.a.local.get('doc.txt')?.version.get('dev-c') === 2);
    expect(chain.b.local.get('doc.txt')?.version.get('dev-c')).toBe(2);

    await teardown(chain);
  });

  it('does not echo the relayed change back to the origin (C)', async () => {
    const roots = makeRoots();
    const seed = (): Map<string, IndexEntry> => new Map([['doc.txt', entry('doc.txt', [['dev-c', 1]])]]);
    const chain = await connectChain(seed(), seed(), seed(), roots);

    const updated = entry('doc.txt', [['dev-c', 2]]);
    chain.c.local.set('doc.txt', updated);
    sendDeltaToB(chain, [updated]);

    await waitFor(() => chain.a.local.get('doc.txt')?.version.get('dev-c') === 2);
    await new Promise((r) => setTimeout(r, 300));

    const snap = {
      aS: chain.a.sent.count, bS: chain.b.sent.count, cS: chain.c.sent.count,
      aR: chain.a.received.count, bR: chain.b.received.count, cR: chain.c.received.count,
    };
    await new Promise((r) => setTimeout(r, 500));
    expect(chain.a.sent.count).toBe(snap.aS);
    expect(chain.b.sent.count).toBe(snap.bS);
    expect(chain.c.sent.count).toBe(snap.cS);
    expect(chain.a.received.count).toBe(snap.aR);
    expect(chain.b.received.count).toBe(snap.bR);
    // 关键:hub(B)绝不把中转来的改动弹回来源端 C
    expect(chain.c.received.count).toBe(snap.cR);

    await teardown(chain);
  });
});

/* ==================== 接收端决策:relayed 并发版本的覆盖 vs 保留 ==================== */

interface PeerHarness {
  peer: SyncPeer;
  dir: string;
  root: string;
  index: IndexStore;
}

function makePeer(root: string, deviceId: string, local: Map<string, IndexEntry>): PeerHarness {
  const dir = join(root, '..');
  const index = openIndexStore(join(dir, 'index.db'));
  const executor = createLocalExecutor(root, index, join(root, '.syncx-trash'));
  const transport: PeerTransport = {
    sendEntries(): void {},
    sendBlockRequest(): void {},
    sendBlockResponse(): void {},
  };
  const peer = createSyncPeer({
    transport, localIndex: local, executor,
    readLocalBlock: () => Buffer.alloc(0),
    deviceId, remoteDeviceId: 'dev-c',
  });
  return { peer, dir, root, index };
}

function conflictCopies(root: string): string[] {
  return readdirSync(root).filter((n) => n.includes('.sync-conflict-'));
}

describe('relayed concurrent receive: overwrite stale copy, keep genuine edit (ADR-0014)', () => {
  it('overwrites a stale synced copy (no local counter) without a conflict copy', async () => {
    const root = join(mkdtempSync(join(tmpdir(), 'syncx-relay-peer-')), 'share');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'p.txt'), '');
    // 本机从没改过:版本向量里没有本机计数器(dev-a),只是从别处同步来的陈旧副本
    const local = new Map([['p.txt', entry('p.txt', [['dev-x', 3]])]]);
    const h = makePeer(root, 'dev-a', local);

    // 中转来的并发版本(dev-c:1 与 {dev-x:3} 互不支配)
    await h.peer.onPeerIndex([entry('p.txt', [['dev-c', 1]])], { relayed: true });

    expect(local.get('p.txt')?.version.get('dev-c')).toBe(1);
    expect(conflictCopies(root).length).toBe(0);

    h.index.close();
    rmDir(h.dir);
  });

  it('still preserves a genuine local edit (local counter > 0) as a conflict copy', async () => {
    const root = join(mkdtempSync(join(tmpdir(), 'syncx-relay-peer-')), 'share');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'p.txt'), '');
    // 本机真改过:版本向量带本机计数器 dev-a:2
    const local = new Map([['p.txt', entry('p.txt', [['dev-a', 2]])]]);
    const h = makePeer(root, 'dev-a', local);

    await h.peer.onPeerIndex([entry('p.txt', [['dev-c', 1]])], { relayed: true });

    expect(conflictCopies(root).length).toBeGreaterThan(0);
    // 本地编辑版本保留在索引里(合并后仍带 dev-a:2)
    expect(local.get('p.txt')?.version.get('dev-a')).toBe(2);

    h.index.close();
    rmDir(h.dir);
  });

  it('a direct (non-relayed) concurrent version still creates a conflict copy', async () => {
    const root = join(mkdtempSync(join(tmpdir(), 'syncx-relay-peer-')), 'share');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'p.txt'), '');
    // 直连对端的并发版本:即便本机计数器为 0,也保持原冲突语义(生成冲突副本)。
    // 这正是「relayed 标记」存在的意义 —— 只放宽中转来的陈旧副本,不动直连语义。
    const local = new Map([['p.txt', entry('p.txt', [['dev-x', 3]])]]);
    const h = makePeer(root, 'dev-a', local);

    await h.peer.onPeerIndex([entry('p.txt', [['dev-c', 1]])]);

    expect(conflictCopies(root).length).toBeGreaterThan(0);

    h.index.close();
    rmDir(h.dir);
  });
});
