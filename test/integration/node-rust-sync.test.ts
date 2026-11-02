import { describe, expect, it, afterEach, beforeAll } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WebSocket } from 'ws';
import { rmDir } from '../helpers.js';
import { connectPeer } from '../../src/net/client.js';
import { loadOrCreateIdentity } from '../../src/identity.js';
import { openIndexStore, type IndexStore } from '../../src/indexstore.js';
import { createLocalExecutor, type LocalExecutor } from '../../src/executor.js';
import { createSyncPeer, type SyncPeer } from '../../src/peer.js';
import { attachPeerMessages, makePeerTransport } from '../../src/net/wire.js';
import { scanFolder } from '../../src/scanner.js';
import { splitIntoBlocks } from '../../src/blockstore.js';
import type { IndexEntry } from '../../src/index.js';

/**
 * Node ↔ Rust 双向同步端到端(ADR-0025 实现清单第 5 项的验收条件)。
 *
 * 为什么必须是**跨实现**的测试:Rust 自己的测试只证明 Rust 与 Rust 一致。
 * 协议互操作是这套移植唯一的可信标准(见 ADR §7),所以这里一端跑真的
 * `syncx-daemon`(`examples/rust_peer.rs`:真握手、真 actor、真扫描、真落盘),
 * 另一端是 Node 的生产代码(connectPeer / createSyncPeer / executor),
 * 中间**没有任何替身协议**。
 *
 * 这条用例抓到的第一类问题就是活教材:Node 的 `mtimeMs` 是带小数的毫秒
 * (如 `1750000000123.456`),Rust 侧若用 `i64` 反序列化,整条索引解析失败 ——
 * 连接看着正常、握手成功、日志无错,就是一条索引也收不到。纯 Rust 测试
 * 永远发现不了它,因为 Rust 自己发出的 mtime 总是整数。
 */

const rustRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const rustPeerBin = join(rustRoot, 'rust', 'target', 'debug', 'examples', 'rust_peer');

beforeAll(() => {
  if (existsSync(rustPeerBin)) return;
  // 与 build-artifact.test.ts 同一口径:本地没构建就现场构建一次,而不是静默跳过 ——
  // 跳过会让「互操作没验过」看起来像「验过了」。
  execFileSync(
    'cargo',
    ['build', '--manifest-path', join(rustRoot, 'rust', 'Cargo.toml'), '-p', 'syncx-daemon', '--example', 'rust_peer'],
    { stdio: 'pipe' },
  );
}, 300_000);

const children: ChildProcess[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          child.once('exit', () => resolve());
          child.kill('SIGKILL');
        }),
    ),
  );
  children.length = 0;
  for (const dir of dirs) rmDir(dir);
  dirs.length = 0;
});

function waitFor(condition: () => boolean, timeoutMs = 20_000, what = '条件'): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = (): void => {
      if (condition()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`等待超时:${what}`));
        return;
      }
      setTimeout(check, 25);
    };
    check();
  });
}

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** 真 Rust 后端进程。和一个测试期的临时目录一一对应。 */
interface RustSide {
  share: string;
  deviceId: string;
  port: number;
}

async function startRustPeer(share: string): Promise<RustSide> {
  const data = tmp('syncx-rust-data-');
  const portFile = join(data, 'peer.port');
  const child = spawn(
    rustPeerBin,
    ['--root', share, '--data', data, '--port-file', portFile, '--folder-id', 'share'],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, RUST_LOG: process.env.RUST_LOG ?? 'warn' } },
  );
  // 子进程的 stderr 不读会被管道缓冲塞满,进而卡死 Rust 侧的日志输出
  child.stdout?.resume();
  child.stderr?.resume();
  children.push(child);

  await waitFor(() => existsSync(portFile), 30_000, 'rust peer 写端口文件');
  const port = Number(readFileSync(portFile, 'utf8').trim());
  // Rust 侧用与 Node 同一份落盘形态写身份,直接读它拿 Device ID
  const identity = JSON.parse(readFileSync(join(data, 'device.key'), 'utf8')) as { deviceId: string };
  return { share, deviceId: identity.deviceId, port };
}

interface NodeSide {
  share: string;
  deviceId: string;
  index: IndexStore;
  executor: LocalExecutor;
  localIndex: Map<string, IndexEntry>;
  socket: WebSocket;
  transport: ReturnType<typeof makePeerTransport>;
  peer: SyncPeer;
  /** 本端发出的索引条数(回声环检测)。 */
  sentIndex: { count: number };
}

/** Node 侧:按生产路径建索引(扫一轮 → applySend),再连 Rust 对端。 */
async function startNodeSide(share: string, rust: RustSide): Promise<NodeSide> {
  const data = tmp('syncx-node-data-');
  const identity = loadOrCreateIdentity(data);
  const index = openIndexStore(join(data, 'index.db'));
  const executor = createLocalExecutor(share, index, join(data, 'trash'), join(data, 'versions'));
  const localIndex = new Map<string, IndexEntry>();

  const diff = scanFolder(share, index, [], identity.deviceId, []);
  for (const path of diff.changed) {
    localIndex.set(path, await executor.applySend(path, identity.deviceId));
  }

  const connected = await connectPeer(identity, `ws://127.0.0.1:${rust.port}`);
  const sentIndex = { count: 0 };
  const transport = makePeerTransport(connected.socket, connected.key, 'share', undefined, {
    canSendBinary: () => connected.peerCaps?.includes('binary1') === true,
  });
  const peer = createSyncPeer({
    transport,
    localIndex,
    executor,
    readLocalBlock: (path, blockIndex) => splitIntoBlocks(readFileSync(join(share, path)))[blockIndex]!,
    deviceId: identity.deviceId,
    remoteDeviceId: rust.deviceId,
    root: share,
  });
  // 统计本端发出的索引条数:发送侧包一层,不改生产代码
  const sendEntries = transport.sendEntries.bind(transport);
  transport.sendEntries = (entries, mode, opts) => {
    sentIndex.count += 1;
    sendEntries(entries, mode, opts);
  };
  attachPeerMessages(
    new Map([['share', peer]]),
    connected.socket,
    connected.key,
    undefined,
    connected.takePendingFrames,
  );
  peer.beginInitialIndexExchange();

  return {
    share,
    deviceId: identity.deviceId,
    index,
    executor,
    localIndex,
    socket: connected.socket,
    transport,
    peer,
    sentIndex,
  };
}

/** 本机改动外推:与生产 `broadcastFolderUpdates` 同一形态(增量 + 单目录)。 */
function publish(transport: ReturnType<typeof makePeerTransport>, entry: IndexEntry): void {
  transport.sendEntries([entry], 'delta');
}

describe('Node ↔ Rust 双向同步', () => {
  it('Node 的改动落到 Rust 的盘上,再回推给 Node', async () => {
    const rustShare = tmp('syncx-rust-share-');
    const nodeShare = tmp('syncx-node-share-');
    mkdirSync(nodeShare, { recursive: true });

    const content = Buffer.from('来自 Node 的内容\n');
    writeFileSync(join(nodeShare, 'from-node.txt'), content);

    const rust = await startRustPeer(rustShare);
    const node = await startNodeSide(nodeShare, rust);

    await waitFor(
      () => existsSync(join(rustShare, 'from-node.txt')),
      20_000,
      'Rust 落盘 Node 的条目',
    );
    expect(readFileSync(join(rustShare, 'from-node.txt'))).toEqual(content);
    // Node 的版本向量原样抵达:说明对端认的是「谁的版本」而不是「什么内容」
    expect(node.localIndex.get('from-node.txt')?.version.get(node.deviceId)).toBe(1);

    // 反向:Rust 侧新写一个文件,它的扫描循环会增量广播过来
    writeFileSync(join(rustShare, 'from-rust.txt'), '来自 Rust 的内容');
    await waitFor(
      () => existsSync(join(nodeShare, 'from-rust.txt')),
      20_000,
      'Node 接收 Rust 的条目',
    );
    expect(readFileSync(join(nodeShare, 'from-rust.txt'), 'utf8')).toBe('来自 Rust 的内容');

    node.socket.close();
  });

  it('Rust 侧的删除传播到 Node,Node 的删除也传播到 Rust', async () => {
    const rustShare = tmp('syncx-rust-share-');
    const nodeShare = tmp('syncx-node-share-');
    mkdirSync(nodeShare, { recursive: true });
    writeFileSync(join(nodeShare, 'doomed.txt'), 'delete me');

    const rust = await startRustPeer(rustShare);
    const node = await startNodeSide(nodeShare, rust);
    await waitFor(() => existsSync(join(rustShare, 'doomed.txt')), 20_000, 'Rust 收到文件');

    // Rust 侧删除 → 它的扫描生成墓碑 → 增量广播给 Node
    rmSync(join(rustShare, 'doomed.txt'));
    await waitFor(() => !existsSync(join(nodeShare, 'doomed.txt')), 20_000, 'Node 执行删除');
    expect(node.index.getEntry('doomed.txt')?.deleted).toBe(true);

    // 反向:Node 侧新建再删除,墓碑要能推到 Rust(两侧都是墓碑时不能互相回推)
    writeFileSync(join(nodeShare, 'roundtrip.txt'), 'v1');
    const first = await node.executor.applySend('roundtrip.txt', node.deviceId);
    node.localIndex.set('roundtrip.txt', first);
    publish(node.transport, first);
    await waitFor(() => existsSync(join(rustShare, 'roundtrip.txt')), 20_000, 'Rust 收到新文件');

    rmSync(join(nodeShare, 'roundtrip.txt'));
    const tombstone: IndexEntry = {
      ...first,
      version: new Map(first.version).set(node.deviceId, (first.version.get(node.deviceId) ?? 1) + 1),
      deleted: true,
      size: 0,
      blocks: [],
    };
    await node.executor.applyDelete('roundtrip.txt', tombstone);
    node.localIndex.set('roundtrip.txt', tombstone);
    publish(node.transport, tombstone);
    await waitFor(() => !existsSync(join(rustShare, 'roundtrip.txt')), 20_000, 'Rust 执行删除');

    node.socket.close();
  });

  it('两端并发改同一文件时生成冲突副本,版本向量合并', async () => {
    const rustShare = tmp('syncx-rust-share-');
    const nodeShare = tmp('syncx-node-share-');
    mkdirSync(rustShare, { recursive: true });
    mkdirSync(nodeShare, { recursive: true });
    // 两侧各自独立编辑同一路径:各自版本里只有自己,互不支配
    writeFileSync(join(nodeShare, 'doc.txt'), 'edit by node');
    writeFileSync(join(rustShare, 'doc.txt'), 'edit by rust');

    const rust = await startRustPeer(rustShare);
    const node = await startNodeSide(nodeShare, rust);

    // 双方都采纳合并后的版本向量(各设备计数都到 1)
    await waitFor(
      () => {
        const entry = node.localIndex.get('doc.txt');
        return entry?.version.get(node.deviceId) === 1 && entry?.version.get(rust.deviceId) === 1;
      },
      20_000,
      'Node 合并版本向量',
    );

    // 至少一侧留下冲突副本:内容是本次落地前的那一份,不能静默丢
    await waitFor(
      () => readdirSync(nodeShare).some((name) => name.includes('.sync-conflict-')),
      20_000,
      'Node 生成冲突副本',
    );
    const copies = readdirSync(nodeShare).filter((name) => name.includes('.sync-conflict-'));
    expect(copies.length).toBeGreaterThan(0);

    node.socket.close();
  });

  it('静置后不再互相回推索引(无回声环)', async () => {
    const rustShare = tmp('syncx-rust-share-');
    const nodeShare = tmp('syncx-node-share-');
    mkdirSync(nodeShare, { recursive: true });
    writeFileSync(join(nodeShare, 'a-only.txt'), 'only on node');

    const rust = await startRustPeer(rustShare);
    const node = await startNodeSide(nodeShare, rust);
    await waitFor(() => existsSync(join(rustShare, 'a-only.txt')), 20_000, 'Rust 收到文件');

    // 收敛后静置:两端都不该再有新的索引消息。增量被当成全量会造成无限往返,
    // 而症状只有「卡片永远转圈、CPU 半核」,日志里一片安静(2026-09-16 事故)。
    await new Promise((resolve) => setTimeout(resolve, 600));
    const settled = node.sentIndex.count;
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(node.sentIndex.count).toBe(settled);
    expect(node.peer.getSyncProgress().pending).toBe(0);

    node.socket.close();
  });
});
