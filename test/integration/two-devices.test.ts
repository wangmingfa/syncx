import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import { startPeerServer } from '../../src/net/server.js';
import { connectPeer } from '../../src/net/client.js';
import { loadOrCreateIdentity } from '../../src/identity.js';
import { openIndexStore, type IndexStore } from '../../src/indexstore.js';
import { createLocalExecutor, type LocalExecutor } from '../../src/executor.js';
import { createSyncPeer, type SyncPeer, type PeerTransport } from '../../src/peer.js';
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
    rmSync(dir, { recursive: true, force: true });
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
}

/** Send-side only: messages flow over the socket. */
function makeTransport(socket: WebSocket): PeerTransport {
  return {
    sendEntries(entries: IndexEntry[]): void {
      socket.send(JSON.stringify({ type: 'index', payload: encodeIndex(entries).toString('base64') }));
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
    };
    switch (msg.type) {
      case 'index':
        void peer.onPeerIndex(decodeIndex(Buffer.from(msg.payload as string, 'base64')));
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
): Promise<{ a: TestDevice; b: TestDevice }> {
  const aIdentity = loadOrCreateIdentity(aDir);
  const bIdentity = loadOrCreateIdentity(bDir);
  const aIndex = openIndexStore(join(aDir, 'index.db'));
  const bIndex = openIndexStore(join(bDir, 'index.db'));
  const aExec = createLocalExecutor(aRoot, aIndex);
  const bExec = createLocalExecutor(bRoot, bIndex);

  const port = 24000 + Math.floor(Math.random() * 10000);
  let aSocket: WebSocket | undefined;

  startPeerServer(
    aIdentity,
    {
      onPeerConnected(socket) {
        aSocket = socket;
      },
      onError() {
        // ignore
      },
    },
    port,
  );

  const bConnected = await connectPeer(bIdentity, `ws://127.0.0.1:${port}`);
  const bSocket = bConnected.socket;
  await waitFor(() => aSocket !== undefined, 3000);

  const aTransport = makeTransport(aSocket!);
  const bTransport = makeTransport(bSocket);
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
  });
  attachIncoming(aPeer, aSocket!);
  attachIncoming(bPeer, bSocket);

  // 双方互发完整索引
  aSocket!.send(JSON.stringify({ type: 'index', payload: encodeIndex([...aLocal.values()]).toString('base64') }));
  bSocket.send(JSON.stringify({ type: 'index', payload: encodeIndex([...bLocal.values()]).toString('base64') }));

  return {
    a: {
      dir: aDir,
      share: aRoot,
      index: aIndex,
      executor: aExec,
      peer: aPeer,
      deviceId: aIdentity.deviceId,
      socket: aSocket!,
    },
    b: {
      dir: bDir,
      share: bRoot,
      index: bIndex,
      executor: bExec,
      peer: bPeer,
      deviceId: bIdentity.deviceId,
      socket: bSocket,
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
});
