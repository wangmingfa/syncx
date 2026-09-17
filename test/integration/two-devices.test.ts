import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
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
import { broadcastFolderUpdates } from '../../src/broadcast.js';
import { encodeIndex, decodeIndex } from '../../src/messages.js';
import { splitIntoBlocks, hashBlock } from '../../src/blockstore.js';
import type { IndexEntry } from '../../src/index.js';

function entry(
  path: string,
  version: Array<[string, number]>,
  blocks: string[],
  size = 100,
  deleted = false,
): IndexEntry {
  return { path, version: new Map(version), size, deleted, blocks };
}

function hashes(content: Buffer): string[] {
  return splitIntoBlocks(content).map(hashBlock);
}

function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
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

/** Close sockets, let in-flight messages settle, then drop dirs. */
async function teardown(devices: TestDevice[], dirs: string[]): Promise<void> {
  for (const device of devices) {
    device.socket.close();
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const device of devices) {
    device.index.close();
  }
  for (const dir of dirs) {
    rmDir(dir);
  }
}

interface TestDevice {
  dir: string;
  share: string;
  index: IndexStore;
  executor: LocalExecutor;
  peer: SyncPeer;
  deviceId: string;
  socket: WebSocket;
  transport: PeerTransport;
  /** 本端发出的 index 消息条数:回声环检测用(静置后必须不再增长)。 */
  indexMessagesSent: { count: number };
}

/** Send-side only: messages flow over the socket. */
function makeTransport(socket: WebSocket, indexMessagesSent?: { count: number }): PeerTransport {
  return {
    sendEntries(entries: IndexEntry[], mode: IndexMode): void {
      if (indexMessagesSent) indexMessagesSent.count += 1;
      socket.send(
        JSON.stringify({
          type: 'index',
          payload: encodeIndex(entries).toString('base64'),
          full: mode === 'full',
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

/** Receive-side: dispatch incoming messages to the peer. */
function attachIncoming(peer: SyncPeer, socket: WebSocket): void {
  socket.on('message', (data) => {
    const raw = data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data as Buffer);
    const msg = JSON.parse(raw.toString('utf8')) as {
      type: 'index' | 'block-request' | 'block-response';
      payload: unknown;
      full?: boolean;
    };
    switch (msg.type) {
      case 'index':
        void peer.onPeerIndex(decodeIndex(Buffer.from(msg.payload as string, 'base64')), {
          full: msg.full === true,
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

async function connectPair(
  aLocal: Map<string, IndexEntry>,
  bLocal: Map<string, IndexEntry>,
  aRoot: string,
  bRoot: string,
  aDir: string,
  bDir: string,
  /** 各侧当前生效的忽略规则行(ADR 0012 的入向闸门用);缺省两侧都没有规则。 */
  ignore?: { a?: () => string[]; b?: () => string[] },
): Promise<{ a: TestDevice; b: TestDevice }> {
  const aIdentity = loadOrCreateIdentity(aDir);
  const bIdentity = loadOrCreateIdentity(bDir);
  const aIndex = openIndexStore(join(aDir, 'index.db'));
  const bIndex = openIndexStore(join(bDir, 'index.db'));
  const aExec = createLocalExecutor(aRoot, aIndex, join(aRoot, '.syncx-trash'));
  const bExec = createLocalExecutor(bRoot, bIndex, join(bRoot, '.syncx-trash'));

  let aSocket: WebSocket | undefined;

  // 各自发出的 index 消息条数(回声环检测:静置后必须不再增长)
  const aSent = { count: 0 };
  const bSent = { count: 0 };

  // 进程内服务用端口 0 让系统分配,避免并行测试文件的随机端口区间互相碰撞
  const aServer = startPeerServer(
    aIdentity,
    {
      onPeerConnected(socket) {
        aSocket = socket;
      },
      onError() {
        // ignore
      },
    },
    0,
  );

  const bConnected = await connectPeer(bIdentity, `ws://127.0.0.1:${aServer.port}`);
  const bSocket = bConnected.socket;
  await waitFor(() => aSocket !== undefined, 3000);

  const aTransport = makeTransport(aSocket!, aSent);
  const bTransport = makeTransport(bSocket, bSent);
  const aPeer = createSyncPeer({
    transport: aTransport,
    localIndex: aLocal,
    executor: aExec,
    readLocalBlock: (path, blockIndex) => {
      const blocks = splitIntoBlocks(readFileSync(join(aRoot, path)));
      return blocks[blockIndex]!;
    },
    deviceId: aIdentity.deviceId,
    remoteDeviceId: bIdentity.deviceId,
    readIgnoreLines: ignore?.a,
  });
  const bPeer = createSyncPeer({
    transport: bTransport,
    localIndex: bLocal,
    executor: bExec,
    readLocalBlock: (path, blockIndex) => {
      const blocks = splitIntoBlocks(readFileSync(join(bRoot, path)));
      return blocks[blockIndex]!;
    },
    deviceId: bIdentity.deviceId,
    remoteDeviceId: aIdentity.deviceId,
    readIgnoreLines: ignore?.b,
  });
  attachIncoming(aPeer, aSocket!);
  attachIncoming(bPeer, bSocket);

  // 双方互发完整索引(与生产路径一致:会话建立时 attachFolderToSession 会发 full)
  const aFull = encodeIndex([...aLocal.values()]).toString('base64');
  const bFull = encodeIndex([...bLocal.values()]).toString('base64');
  aSocket!.send(JSON.stringify({ type: 'index', payload: aFull, full: true }));
  bSocket.send(JSON.stringify({ type: 'index', payload: bFull, full: true }));

  return {
    a: {
      dir: aDir,
      share: aRoot,
      index: aIndex,
      executor: aExec,
      peer: aPeer,
      deviceId: aIdentity.deviceId,
      socket: aSocket!,
      transport: aTransport,
      indexMessagesSent: aSent,
    },
    b: {
      dir: bDir,
      share: bRoot,
      index: bIndex,
      executor: bExec,
      peer: bPeer,
      deviceId: bIdentity.deviceId,
      socket: bSocket,
      transport: bTransport,
      indexMessagesSent: bSent,
    },
  };
}

describe('two-device end-to-end sync', () => {
  it('propagates a new file from A to B over a real socket', async () => {
    const aDir = mkdtempSync(join(tmpdir(), 'syncx-e2e-a-'));
    const bDir = mkdtempSync(join(tmpdir(), 'syncx-e2e-b-'));
    const aRoot = join(aDir, 'share');
    const bRoot = join(bDir, 'share');
    mkdirSync(aRoot, { recursive: true });
    mkdirSync(bRoot, { recursive: true });

    const content = Buffer.from('hello from A');
    writeFileSync(join(aRoot, 'new.txt'), content);
    const aLocal = new Map([
      ['new.txt', entry('new.txt', [['dev-a', 1]], hashes(content), content.length)],
    ]);

    const { a, b } = await connectPair(aLocal, new Map(), aRoot, bRoot, aDir, bDir);

    await waitFor(() => existsSync(join(bRoot, 'new.txt')));
    expect(readFileSync(join(bRoot, 'new.txt'))).toEqual(content);
    expect(b.index.getEntry('new.txt')?.version.get('dev-a')).toBe(1);

    await teardown([a, b], [aDir, bDir]);
  });

  it('never applies a peer change for a path the local side ignores (ADR 0012)', async () => {
    const aDir = mkdtempSync(join(tmpdir(), 'syncx-e2e-a-'));
    const bDir = mkdtempSync(join(tmpdir(), 'syncx-e2e-b-'));
    const aRoot = join(aDir, 'share');
    const bRoot = join(bDir, 'share');
    mkdirSync(aRoot, { recursive: true });
    mkdirSync(bRoot, { recursive: true });

    const content = Buffer.from('peer version');
    writeFileSync(join(aRoot, 'secret.txt'), content);
    const aLocal = new Map([
      ['secret.txt', entry('secret.txt', [['dev-a', 1]], hashes(content), content.length)],
    ]);

    // B 侧已把 secret.txt 写进 .gitignore(且它自己的磁盘上什么都没有):
    // 对端条目必须一条都不落地 —— 修复前 B 会把它拉下来覆盖,而这个路径
    // B 已经不扫描了,本地改动将无人保护(ADR 0012 的真实事故形态)
    const { a, b } = await connectPair(aLocal, new Map(), aRoot, bRoot, aDir, bDir, {
      b: () => ['secret.txt'],
    });

    // A 收到 B 的空索引后会把本机较新的条目推过来(并集规划);等它发生完再断言
    await waitFor(() => a.indexMessagesSent.count > 0);
    await new Promise((r) => setTimeout(r, 200));

    expect(existsSync(join(bRoot, 'secret.txt'))).toBe(false);
    expect(b.index.getEntry('secret.txt')).toBeUndefined();
    expect(b.peer.getSyncProgress()).toEqual({ pending: 0, sending: 0, receiving: 0 });

    await teardown([a, b], [aDir, bDir]);
  });

  it('propagates an edit from B to A', async () => {
    const aDir = mkdtempSync(join(tmpdir(), 'syncx-e2e-a-'));
    const bDir = mkdtempSync(join(tmpdir(), 'syncx-e2e-b-'));
    const aRoot = join(aDir, 'share');
    const bRoot = join(bDir, 'share');
    mkdirSync(aRoot, { recursive: true });
    mkdirSync(bRoot, { recursive: true });

    const oldContent = Buffer.from('v1');
    const newContent = Buffer.from('v2 from B');
    writeFileSync(join(aRoot, 'doc.txt'), oldContent);
    writeFileSync(join(bRoot, 'doc.txt'), newContent);

    const aLocal = new Map([
      ['doc.txt', entry('doc.txt', [['dev-a', 1]], hashes(oldContent), oldContent.length)],
    ]);
    const bLocal = new Map([
      ['doc.txt', entry('doc.txt', [['dev-a', 1], ['dev-b', 2]], hashes(newContent), newContent.length)],
    ]);

    const { a, b } = await connectPair(aLocal, bLocal, aRoot, bRoot, aDir, bDir);

    await waitFor(() => readFileSync(join(aRoot, 'doc.txt')).equals(newContent));
    // 接收方 A 的存储应记录 B 的编辑版本
    expect(a.index.getEntry('doc.txt')?.version.get('dev-b')).toBe(2);

    await teardown([a, b], [aDir, bDir]);
  });

  it('propagates a deletion from A to B', async () => {
    const aDir = mkdtempSync(join(tmpdir(), 'syncx-e2e-a-'));
    const bDir = mkdtempSync(join(tmpdir(), 'syncx-e2e-b-'));
    const aRoot = join(aDir, 'share');
    const bRoot = join(bDir, 'share');
    mkdirSync(aRoot, { recursive: true });
    mkdirSync(bRoot, { recursive: true });

    const content = Buffer.from('bye');
    writeFileSync(join(bRoot, 'gone.txt'), content);

    // A 删除了之前由 A 创建的文件(dev-a:1),墓碑 dev-a:2 支配 B 的副本
    const aLocal = new Map([['gone.txt', entry('gone.txt', [['dev-a', 2]], [], 0, true)]]);
    const bLocal = new Map([
      ['gone.txt', entry('gone.txt', [['dev-a', 1]], hashes(content), content.length)],
    ]);

    const { a, b } = await connectPair(aLocal, bLocal, aRoot, bRoot, aDir, bDir);

    await waitFor(() => !existsSync(join(bRoot, 'gone.txt')));
    expect(b.index.getEntry('gone.txt')?.deleted).toBe(true);

    await teardown([a, b], [aDir, bDir]);
  });

  it('creates a conflict copy when both sides edit concurrently', async () => {
    const aDir = mkdtempSync(join(tmpdir(), 'syncx-e2e-a-'));
    const bDir = mkdtempSync(join(tmpdir(), 'syncx-e2e-b-'));
    const aRoot = join(aDir, 'share');
    const bRoot = join(bDir, 'share');
    mkdirSync(aRoot, { recursive: true });
    mkdirSync(bRoot, { recursive: true });

    const aContent = Buffer.from('edit by A');
    const bContent = Buffer.from('edit by B');
    writeFileSync(join(aRoot, 'doc.txt'), aContent);
    writeFileSync(join(bRoot, 'doc.txt'), bContent);

    const aLocal = new Map([
      ['doc.txt', entry('doc.txt', [['dev-a', 2], ['dev-b', 1]], hashes(aContent), aContent.length)],
    ]);
    const bLocal = new Map([
      ['doc.txt', entry('doc.txt', [['dev-a', 1], ['dev-b', 2]], hashes(bContent), bContent.length)],
    ]);

    const { a, b } = await connectPair(aLocal, bLocal, aRoot, bRoot, aDir, bDir);

    // 双方收敛到合并版本(dev-a:2, dev-b:2)
    await waitFor(() => b.index.getEntry('doc.txt')?.version.get('dev-b') === 2);
    await waitFor(() => a.index.getEntry('doc.txt')?.version.get('dev-a') === 2);

    // 至少一方生成了冲突副本
    const copies = readdirSync(aRoot).filter((name) => name.includes('.sync-conflict-'));
    expect(copies.length).toBeGreaterThan(0);

    await teardown([a, b], [aDir, bDir]);
  });

  /**
   * 2026-09-16 事故的端到端回归:两端各有对方没有的存量条目时,任何一条增量广播
   * 都不该演变成「两端互相回推对方没提到的条目」的静默循环。
   *
   * 修复前的形态:A 广播 1 条改动 → B 把它当全量、按并集规划,发现本地独有的
   * b-only.txt「对端没有」→ 回推 → A 同样回推 a-only.txt → …… 无限往返。
   * 全程不落盘、不记历史、不打日志,用户只能看到两张卡片永远「传输中」。
   */
  it('a delta index does not trigger an echo loop between the two sides', async () => {
    const aDir = mkdtempSync(join(tmpdir(), 'syncx-e2e-a-'));
    const bDir = mkdtempSync(join(tmpdir(), 'syncx-e2e-b-'));
    const aRoot = join(aDir, 'share');
    const bRoot = join(bDir, 'share');
    mkdirSync(aRoot, { recursive: true });
    mkdirSync(bRoot, { recursive: true });

    const aContent = Buffer.from('only on A');
    const bContent = Buffer.from('only on B');
    writeFileSync(join(aRoot, 'a-only.txt'), aContent);
    writeFileSync(join(bRoot, 'b-only.txt'), bContent);
    const aLocal = new Map([
      ['a-only.txt', entry('a-only.txt', [['dev-a', 1]], hashes(aContent), aContent.length)],
    ]);
    const bLocal = new Map([
      ['b-only.txt', entry('b-only.txt', [['dev-b', 1]], hashes(bContent), bContent.length)],
    ]);

    const { a, b } = await connectPair(aLocal, bLocal, aRoot, bRoot, aDir, bDir);

    // 全量交换后双方各自拿到对方的文件
    await waitFor(() => existsSync(join(bRoot, 'a-only.txt')) && existsSync(join(aRoot, 'b-only.txt')));
    expect(readFileSync(join(bRoot, 'a-only.txt'))).toEqual(aContent);
    expect(readFileSync(join(aRoot, 'b-only.txt'))).toEqual(bContent);

    // A 侧改了一个文件 → 扫描器广播一条增量(与生产路径 broadcastFolderUpdates 一致)
    const changed = Buffer.from('A changed it');
    writeFileSync(join(aRoot, 'a-only.txt'), changed);
    const updated = entry('a-only.txt', [['dev-a', 2]], hashes(changed), changed.length);
    aLocal.set('a-only.txt', updated);
    broadcastFolderUpdates({ transports: [a.transport] }, [updated]);

    // 改动照常传到对端
    await waitFor(() => readFileSync(join(bRoot, 'a-only.txt')).equals(changed));

    // 静置后两端的索引消息数必须不再增长(修复前这里会一路涨上去)
    await new Promise((resolve) => setTimeout(resolve, 200));
    const aQuiet = a.indexMessagesSent.count;
    const bQuiet = b.indexMessagesSent.count;
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(a.indexMessagesSent.count).toBe(aQuiet);
    expect(b.indexMessagesSent.count).toBe(bQuiet);

    // 两端都没有在途接收 —— 卡片会显示「已同步」而不是一直转圈
    expect(b.peer.getSyncProgress().pending).toBe(0);
    expect(a.peer.getSyncProgress().pending).toBe(0);

    await teardown([a, b], [aDir, bDir]);
  });
});
