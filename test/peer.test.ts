import { describe, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  symlinkSync,
  readdirSync,
} from 'node:fs';
import { rmDir, canCreateSymlinks } from './helpers.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSyncPeer, type PeerTransport, type IndexMode } from '../src/peer.js';
import type { BlockRequest, BlockResponse } from '../src/messages.js';
import { createLocalExecutor, type LocalExecutor } from '../src/executor.js';
import { openIndexStore } from '../src/indexstore.js';
import { hashBlock, BLOCK_SIZE } from '../src/blockstore.js';
import { mergeVersions } from '../src/version.js';
import type { IndexEntry } from '../src/index.js';

function entry(
  path: string,
  version: Array<[string, number]>,
  blocks: string[],
  size = 100,
  deleted = false,
) {
  return {
    path,
    version: new Map(version),
    size,
    deleted,
    blocks,
  };
}

describe('sync peer session', () => {
  function fakeTransport() {
    const sentEntries: ReturnType<typeof entry>[] = [];
    const requests: BlockRequest[] = [];
    const responses: BlockResponse[] = [];
    return {
      transport: {
        sendEntries(entries: ReturnType<typeof entry>[]): void {
          sentEntries.push(...entries);
        },
        sendBlockRequest(request: BlockRequest): void {
          requests.push(request);
        },
        sendBlockResponse(response: BlockResponse): void {
          responses.push(response);
        },
      } satisfies PeerTransport,
      sentEntries,
      requests,
      responses,
    };
  }

  it('sends newer local entries and requests remote blocks on peer index', async () => {
    const { transport, sentEntries, requests } = fakeTransport();
    const local = new Map([['local.txt', entry('local.txt', [['dev-a', 2]], ['l1'])]]);
    const peer = createSyncPeer({
      transport,
      localIndex: local,
      executor: null as never,
      readLocalBlock: () => Buffer.from(''),
      deviceId: 'DEV-A',
    });

    const remote = [
      entry('local.txt', [['dev-a', 1]], ['l0']),
      entry('remote.txt', [['dev-b', 3]], ['r1', 'r2'], 200),
    ];
    await peer.onPeerIndex(remote);

    expect(sentEntries).toEqual([entry('local.txt', [['dev-a', 2]], ['l1'])]);
    expect(requests).toEqual([
      { deviceId: 'DEV-A', path: 'remote.txt', blockIndex: 0, hash: 'r1' },
      { deviceId: 'DEV-A', path: 'remote.txt', blockIndex: 1, hash: 'r2' },
    ]);
  });

  it('applies received blocks to the local executor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-peer-'));
    const root = join(dir, 'share');
    mkdirSync(root, { recursive: true });
    const index = openIndexStore(join(dir, 'index.db'));
    const executor = createLocalExecutor(root, index, join(root, '.syncx-trash'));
    const { transport } = fakeTransport();

    const content = Buffer.from('hello peer');
    const peer = createSyncPeer({
      transport,
      localIndex: new Map(),
      executor,
      readLocalBlock: () => Buffer.from(''),
      deviceId: 'DEV-A',
    });

    await peer.onPeerIndex([
      entry('incoming.txt', [['dev-b', 1]], [hashBlock(content)], content.length),
    ]);

    // 收到对端返回的所有块后,文件应落地
    peer.onBlockResponse({
      deviceId: 'DEV-B',
      path: 'incoming.txt',
      blockIndex: 0,
      hash: hashBlock(content),
      data: content,
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(readFileSync(join(root, 'incoming.txt'))).toEqual(content);
    expect(index.getEntry('incoming.txt')?.version.get('dev-b')).toBe(1);

    index.close();
    rmDir(dir);
  });

  it('skips requesting blocks whose hash already exists locally', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-peer-'));
    const root = join(dir, 'share');
    mkdirSync(root, { recursive: true });
    const index = openIndexStore(join(dir, 'index.db'));
    const executor = createLocalExecutor(root, index, join(root, '.syncx-trash'));
    const { transport, requests } = fakeTransport();

    // 本地文件 3 块:A/B/C;对端改为 A/X/C(仅中间块变化)
    const blockA = Buffer.alloc(BLOCK_SIZE, 0x61);
    const blockB = Buffer.alloc(BLOCK_SIZE, 0x62);
    const blockC = Buffer.from('tail-content'); // 不足一块
    const blockX = Buffer.alloc(BLOCK_SIZE, 0x78);
    const localContent = Buffer.concat([blockA, blockB, blockC]);
    const remoteContent = Buffer.concat([blockA, blockX, blockC]);
    writeFileSync(join(root, 'changed.bin'), localContent);

    const localEntry = entry(
      'changed.bin',
      [['dev-b', 1]],
      [hashBlock(blockA), hashBlock(blockB), hashBlock(blockC)],
      localContent.length,
    );
    const remoteEntry = entry(
      'changed.bin',
      [['dev-b', 2]],
      [hashBlock(blockA), hashBlock(blockX), hashBlock(blockC)],
      remoteContent.length,
    );

    const peer = createSyncPeer({
      transport,
      localIndex: new Map([['changed.bin', localEntry]]),
      executor,
      readLocalBlock: (_path, blockIndex) => {
        const offset = blockIndex * BLOCK_SIZE;
        return localContent.subarray(offset, Math.min(offset + BLOCK_SIZE, localContent.length));
      },
      deviceId: 'DEV-A',
    });

    await peer.onPeerIndex([remoteEntry]);

    // 仅中间块(哈希不同)走网络请求;首尾块哈希相同,直接从本地填充
    expect(requests).toEqual([
      { deviceId: 'DEV-A', path: 'changed.bin', blockIndex: 1, hash: hashBlock(blockX) },
    ]);

    // 回传缺失块后文件落地,内容与对端一致
    peer.onBlockResponse({
      deviceId: 'DEV-B',
      path: 'changed.bin',
      blockIndex: 1,
      hash: hashBlock(blockX),
      data: blockX,
    });
    await new Promise((r) => setTimeout(r, 10));
    // 用 Buffer#equals 逐字节比较,不用 toEqual:vitest 的深比较对此处的 2MB Buffer
    // 要跑十几秒(本机 2.3s,termux/Android 上 15.7s),会把用例拖过超时线。
    // equals 走原生 memcmp,微秒级。先断长度,失败时能直接看出是截断还是内容不符。
    const landed = readFileSync(join(root, 'changed.bin'));
    expect(landed.length).toBe(remoteContent.length);
    expect(landed.equals(remoteContent)).toBe(true);
    expect(index.getEntry('changed.bin')?.version.get('dev-b')).toBe(2);

    index.close();
    rmDir(dir);
  });

  it('lands empty files (0 blocks) without any block round-trip', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-peer-'));
    const root = join(dir, 'share');
    mkdirSync(root, { recursive: true });
    const index = openIndexStore(join(dir, 'index.db'));
    const executor = createLocalExecutor(root, index, join(root, '.syncx-trash'));
    const { transport, requests } = fakeTransport();

    const peer = createSyncPeer({
      transport,
      localIndex: new Map(),
      executor,
      readLocalBlock: () => Buffer.from(''),
      deviceId: 'DEV-A',
    });

    // 空文件:blocks 为 [],不应发送任何块请求,文件应直接落地
    await peer.onPeerIndex([entry('empty.txt', [['dev-b', 1]], [], 0)]);

    expect(requests).toEqual([]);
    expect(readFileSync(join(root, 'empty.txt'))).toEqual(Buffer.from(''));
    expect(index.getEntry('empty.txt')?.version.get('dev-b')).toBe(1);

    index.close();
    rmDir(dir);
  });

  it('ignores duplicate block responses instead of over-counting', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-peer-'));
    const root = join(dir, 'share');
    mkdirSync(root, { recursive: true });
    const index = openIndexStore(join(dir, 'index.db'));
    const executor = createLocalExecutor(root, index, join(root, '.syncx-trash'));
    const { transport } = fakeTransport();

    const content = Buffer.from('dedupe me');
    const peer = createSyncPeer({
      transport,
      localIndex: new Map(),
      executor,
      readLocalBlock: () => Buffer.from(''),
      deviceId: 'DEV-A',
    });

    peer.onPeerIndex([entry('dup.txt', [['dev-b', 1]], [hashBlock(content)], content.length)]);
    const response = {
      deviceId: 'DEV-B',
      path: 'dup.txt',
      blockIndex: 0,
      hash: hashBlock(content),
      data: content,
    };
    peer.onBlockResponse(response);
    // 同一块重复收到:不应让 received 虚增导致提前落地不完整文件
    peer.onBlockResponse(response);

    await new Promise((r) => setTimeout(r, 10));
    expect(readFileSync(join(root, 'dup.txt'))).toEqual(content);

    index.close();
    rmDir(dir);
  });

  it('keeps the in-memory index in sync so a repeated peer index does not re-request received files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-peer-'));
    const root = join(dir, 'share');
    mkdirSync(root, { recursive: true });
    const index = openIndexStore(join(dir, 'index.db'));
    const executor = createLocalExecutor(root, index, join(root, '.syncx-trash'));
    // 共享的内存索引:模拟 daemon 在会话内复用的同一个 Map
    const localIndex = new Map();
    const { transport, requests } = fakeTransport();

    const peer = createSyncPeer({
      transport,
      localIndex,
      executor,
      readLocalBlock: () => Buffer.from(''),
      deviceId: 'DEV-A',
    });

    const content = Buffer.from('repeat test');
    const remote = [entry('r.txt', [['dev-b', 1]], [hashBlock(content)], content.length)];

    // 第一次:收到对端索引 → 请求块 → 落地
    await peer.onPeerIndex(remote);
    peer.onBlockResponse({
      deviceId: 'DEV-B',
      path: 'r.txt',
      blockIndex: 0,
      hash: hashBlock(content),
      data: content,
    });
    await new Promise((r) => setTimeout(r, 10));

    // 内存索引应已反映收到的文件(修复:之前永不更新,导致后续重复下载)
    expect(localIndex.get('r.txt')?.version.get('dev-b')).toBe(1);

    // 对端再次发来相同索引:本地已是最新,不应再发任何块请求
    const before = requests.length;
    await peer.onPeerIndex(remote);
    expect(requests.length).toBe(before);

    index.close();
    rmDir(dir);
  });

  it('ignores out-of-range, non-integer, and oversized block responses', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-peer-'));
    const root = join(dir, 'share');
    mkdirSync(root, { recursive: true });
    const index = openIndexStore(join(dir, 'index.db'));
    const executor = createLocalExecutor(root, index, join(root, '.syncx-trash'));
    const { transport } = fakeTransport();

    const peer = createSyncPeer({
      transport,
      localIndex: new Map(),
      executor,
      readLocalBlock: () => Buffer.from(''),
      deviceId: 'DEV-A',
    });

    const content = Buffer.from('bounded');
    const hash = hashBlock(content);
    peer.onPeerIndex([entry('f.txt', [['dev-b', 1]], [hash], content.length)]);

    // 越界 / 负数 / 非整数 / 超大块:都应被忽略,不写文件、不崩溃
    peer.onBlockResponse({ deviceId: 'DEV-B', path: 'f.txt', blockIndex: 99, hash, data: content });
    peer.onBlockResponse({ deviceId: 'DEV-B', path: 'f.txt', blockIndex: -1, hash, data: content });
    peer.onBlockResponse({ deviceId: 'DEV-B', path: 'f.txt', blockIndex: 1.5, hash, data: content });
    peer.onBlockResponse({
      deviceId: 'DEV-B',
      path: 'f.txt',
      blockIndex: 0,
      hash,
      data: Buffer.alloc(BLOCK_SIZE + 1000),
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(existsSync(join(root, 'f.txt'))).toBe(false);

    // 合法的块仍应正常落地
    peer.onBlockResponse({ deviceId: 'DEV-B', path: 'f.txt', blockIndex: 0, hash, data: content });
    await new Promise((r) => setTimeout(r, 10));
    expect(readFileSync(join(root, 'f.txt'))).toEqual(content);

    index.close();
    rmDir(dir);
  });

  it('rejects out-of-range block requests without reading', async () => {
    const { transport, requests } = fakeTransport();
    const peer = createSyncPeer({
      transport,
      localIndex: new Map(),
      executor: null as never,
      // 若越界索引未被拦截,这里会抛错使测试失败
      readLocalBlock: (): Buffer => {
        throw new Error('readLocalBlock should not be called for out-of-range index');
      },
      deviceId: 'DEV-A',
    });

    peer.onBlockRequest({ deviceId: 'DEV-B', path: 'f.txt', blockIndex: -1, hash: 'h' });
    peer.onBlockRequest({ deviceId: 'DEV-B', path: 'f.txt', blockIndex: 1.5, hash: 'h' });

    expect(requests).toEqual([]);
  });

  it('keeps a stalled entry in pending and retries at a long interval after fast retries exhaust', async () => {
    const { transport, requests } = fakeTransport();
    const peer = createSyncPeer({
      transport,
      localIndex: new Map(),
      executor: null as never,
      readLocalBlock: () => Buffer.from(''),
      deviceId: 'DEV-A',
    });

    vi.useFakeTimers();
    // 单块文件 → 只发 1 次块请求,该请求永远无响应(对端离线)
    const content = Buffer.from('stalled');
    await peer.onPeerIndex([entry('missing.txt', [['dev-b', 1]], [hashBlock(content)], content.length)]);

    expect(peer.getSyncProgress().pending).toBe(1);

    // 快速重试窗口:5s × (1 + MAX_BLOCK_RETRIES) = 20s
    await vi.advanceTimersByTimeAsync(5000 * 4);

    // 修复前:条目被静默丢弃(pending=0、请求停止),但 onPeerIndex 只在对端
    // 发索引时触发,对端无变化时文件会永久不同步;修复后:条目保持 pending
    expect(peer.getSyncProgress().pending).toBe(1);
    const fastRequests = requests.length;
    expect(fastRequests).toBeGreaterThanOrEqual(3);

    // 退避到 30s 长间隔后仍持续重试
    await vi.advanceTimersByTimeAsync(30000);
    expect(requests.length).toBeGreaterThan(fastRequests);
    expect(peer.getSyncProgress().pending).toBe(1);

    // 块最终到达 → 条目落地,pending 清空(长间隔重试期间仍可完成)
    await peer.onBlockResponse({
      deviceId: 'DEV-B',
      path: 'missing.txt',
      blockIndex: 0,
      hash: hashBlock(content),
      data: content,
    });
    expect(peer.getSyncProgress().pending).toBe(0);

    vi.useRealTimers();
  });

  it('gives up a pending receive entirely when block retries exhaust (~10 min)', async () => {
    const { transport, requests } = fakeTransport();
    const onStallDrop = vi.fn();
    const peer = createSyncPeer({
      transport,
      localIndex: new Map(),
      executor: null as never,
      readLocalBlock: () => Buffer.from(''),
      deviceId: 'DEV-A',
      onStallDrop,
    });

    vi.useFakeTimers();
    // 单块文件,块请求永远无响应:对端索引声明有这个文件,但磁盘上早已没有
    // (2026-09-22 事故:对端编辑器 tmp 中间文件进索引后随即被改名)
    const content = Buffer.from('ghost');
    await peer.onPeerIndex([entry('ghost.txt', [['dev-b', 1]], [hashBlock(content)], content.length)]);
    expect(peer.getSyncProgress().receiving).toBe(1);

    // 推进越过总重试上限:3×5s 快速 + 20×30s 长间隔 = 615s
    await vi.advanceTimersByTimeAsync(620_000);

    // 放弃后:进度归零(UI 不再挂「接收中」)、回调带缺失块数触发、不再发新请求
    expect(onStallDrop).toHaveBeenCalledWith('ghost.txt', 1);
    expect(peer.getSyncProgress().pending).toBe(0);
    expect(peer.getSyncProgress().receiving).toBe(0);
    const atGiveUp = requests.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(requests.length).toBe(atGiveUp);

    // 自愈路径:对端稍后重推同一文件(新版本增量)→ 重新排队接收,重试从零开始
    await peer.onPeerIndex([entry('ghost.txt', [['dev-b', 2]], [hashBlock(content)], content.length)]);
    expect(peer.getSyncProgress().receiving).toBe(1);
    expect(requests.length).toBeGreaterThan(atGiveUp);

    vi.useRealTimers();
  });

  it.skipIf(!canCreateSymlinks())('does not serve blocks for paths escaping the root via a symlink', () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-peer-'));
    const root = join(dir, 'share');
    const outside = join(dir, 'outside');
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secret.txt'), 'top secret');
    // 共享目录内指向外部的符号链接:块请求不得经它读取目录外文件
    symlinkSync(outside, join(root, 'link'));

    const { transport, responses } = fakeTransport();
    const peer = createSyncPeer({
      transport,
      localIndex: new Map(),
      // root 校验依赖:读取侧与写入侧同款 realpath 守卫
      root,
      readLocalBlock: (path: string): Buffer => {
        // 若未被拦截,这里会真的读到外部文件 —— 断言不响应
        return readFileSync(join(root, path));
      },
      deviceId: 'DEV-A',
    });

    peer.onBlockRequest({ deviceId: 'DEV-B', path: 'link/secret.txt', blockIndex: 0, hash: 'h' });
    expect(responses).toHaveLength(0);

    rmDir(dir);
  });

  it('clears stale pending entries when the peer full index no longer references them', async () => {
    const { transport } = fakeTransport();
    const peer = createSyncPeer({
      transport,
      localIndex: new Map(),
      executor: null as never,
      readLocalBlock: () => Buffer.from(''),
      deviceId: 'DEV-A',
    });

    const content = Buffer.from('gone');
    await peer.onPeerIndex([
      entry('gone.txt', [['dev-b', 1]], [hashBlock(content)], content.length),
    ]);
    expect(peer.getSyncProgress().pending).toBe(1);

    // 对端下一轮**全量**索引不再包含该路径(如对端删除后不再广播该条目):
    // 上一轮遗留的 pending 条目应被清理,而非永久滞留(进度虚报 +
    // 迟到块响应可能复活已被删除的文件)
    await peer.onPeerIndex([], { full: true });
    expect(peer.getSyncProgress().pending).toBe(0);

    // 迟到块响应不应复活已清理的条目
    await peer.onBlockResponse({
      deviceId: 'DEV-B',
      path: 'gone.txt',
      blockIndex: 0,
      hash: hashBlock(content),
      data: content,
    });
    expect(peer.getSyncProgress().pending).toBe(0);

    vi.useRealTimers();
  });

  it('uses the latest local entry when landing a conflict', async () => {
    const { transport } = fakeTransport();
    const localIndex = new Map<string, IndexEntry>();
    const landed: Array<{ version: Map<string, number> }> = [];
    const peer = createSyncPeer({
      transport,
      localIndex,
      executor: {
        applyConflict: async (path: string, local: IndexEntry, remote: IndexEntry) => {
          const merged: IndexEntry = {
            path,
            version: mergeVersions(local.version, remote.version),
            size: 0,
            deleted: false,
            blocks: [],
          };
          landed.push(merged);
          return merged;
        },
      } as unknown as LocalExecutor,
      readLocalBlock: () => Buffer.from(''),
      deviceId: 'DEV-A',
      remoteDeviceId: 'DEV-B',
    });

    const content = Buffer.from('remote edit');
    localIndex.set(
      'doc.txt',
      entry('doc.txt', [['DEV-A', 2]], [hashBlock(Buffer.from('local'))], 5),
    );
    const remote = entry(
      'doc.txt',
      [
        ['DEV-A', 1],
        ['DEV-B', 2],
      ],
      [hashBlock(content)],
      content.length,
    );

    await peer.onPeerIndex([remote]);
    expect(peer.getSyncProgress().pending).toBe(1);

    // 冲突规划后、块到达前,本地被新一轮扫描更新(DEV-A:2 → DEV-A:3):
    // 合并必须用最新本地版本,否则版本向量回退(修复前用规划时捕获的 DEV-A:2)
    localIndex.set(
      'doc.txt',
      entry('doc.txt', [['DEV-A', 3]], [hashBlock(Buffer.from('local v2'))], 7),
    );

    await peer.onBlockResponse({
      deviceId: 'DEV-B',
      path: 'doc.txt',
      blockIndex: 0,
      hash: hashBlock(content),
      data: content,
    });

    expect(landed).toHaveLength(1);
    expect(landed[0]!.version.get('DEV-A')).toBe(3);
    expect(landed[0]!.version.get('DEV-B')).toBe(2);
  });

  it('preserves a pre-existing un-indexed local file as a conflict copy on receive (cold-start guard)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-peer-'));
    const root = join(dir, 'share');
    mkdirSync(root, { recursive: true });
    const index = openIndexStore(join(dir, 'index.db'));
    const executor = createLocalExecutor(root, index, join(root, '.syncx-trash'));
    const { transport } = fakeTransport();

    // 冷设备:磁盘已有 doc.txt,但 localIndex 为空(尚未首扫);对端是“热”的
    const localContent = Buffer.from('my local work');
    writeFileSync(join(root, 'doc.txt'), localContent);
    const localIndex = new Map();
    const events: string[] = [];

    const peer = createSyncPeer({
      transport,
      localIndex,
      executor,
      readLocalBlock: () => Buffer.from(''),
      deviceId: 'DEV-A',
      remoteDeviceId: 'DEV-B',
      root,
      readIgnoreLines: () => [],
      onEvent: (ev) => events.push(ev.action),
    });

    const remoteContent = Buffer.from('peer version');
    await peer.onPeerIndex([entry('doc.txt', [['dev-b', 1]], [hashBlock(remoteContent)], remoteContent.length)]);
    peer.onBlockResponse({
      deviceId: 'DEV-B',
      path: 'doc.txt',
      blockIndex: 0,
      hash: hashBlock(remoteContent),
      data: remoteContent,
    });
    await new Promise((r) => setTimeout(r, 10));

    // 关键:本机原文件未被覆盖,保留为 .sync-conflict 副本;对端版本正常落地
    const copies = readdirSync(root).filter((n) => n.startsWith('doc.sync-conflict-'));
    expect(copies).toHaveLength(1);
    expect(readFileSync(join(root, copies[0]!))).toEqual(localContent);
    expect(readFileSync(join(root, 'doc.txt'))).toEqual(remoteContent);
    expect(events).toContain('conflict');

    index.close();
    rmDir(dir);
  });

  it('leaves an ignored path completely alone on receive (inbound gate, ADR 0012)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-peer-'));
    const root = join(dir, 'share');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, '.syncxignore'), 'secret.txt\n');
    const index = openIndexStore(join(dir, 'index.db'));
    const executor = createLocalExecutor(root, index, join(root, '.syncx-trash'));
    const { transport, requests } = fakeTransport();

    const localContent = Buffer.from('local ignored');
    writeFileSync(join(root, 'secret.txt'), localContent);
    const localIndex = new Map();
    const events: string[] = [];

    const peer = createSyncPeer({
      transport,
      localIndex,
      executor,
      readLocalBlock: () => Buffer.from(''),
      deviceId: 'DEV-A',
      remoteDeviceId: 'DEV-B',
      root,
      readIgnoreLines: () => ['secret.txt'],
      onEvent: (ev) => events.push(ev.action),
    });

    // 对端推来一个活条目 + 一个墓碑:两者都不该被本机应用
    const remoteContent = Buffer.from('peer version');
    await peer.onPeerIndex([
      entry('secret.txt', [['dev-b', 1]], [hashBlock(remoteContent)], remoteContent.length),
    ]);
    await peer.onPeerIndex([entry('secret.txt', [['dev-b', 2]], [], 0, true)], { full: true });

    // 不落盘、不覆盖(连冲突副本也不留)、不请求块、不进 pending、不记变更
    expect(readFileSync(join(root, 'secret.txt'))).toEqual(localContent);
    expect(readdirSync(root).filter((n) => n.includes('.sync-conflict-'))).toHaveLength(0);
    expect(requests).toEqual([]);
    expect(peer.getSyncProgress()).toEqual({ pending: 0, sending: 0, receiving: 0 });
    expect(events).toEqual([]);

    index.close();
    rmDir(dir);
  });

  it('reads ignore rules per message instead of snapshotting them at attach', async () => {
    const { transport, requests } = fakeTransport();
    let lines: string[] = [];
    const peer = createSyncPeer({
      transport,
      localIndex: new Map(),
      executor: null as never,
      readLocalBlock: () => Buffer.from(''),
      deviceId: 'DEV-A',
      remoteDeviceId: 'DEV-B',
      readIgnoreLines: () => lines,
    });

    // 规则是运行期改的(scanOnce 每轮重读):同一份 peer 上必须立刻生效,
    // 否则「刚加进 .gitignore 的路径」要等重连才被挡住,而扫描侧下一轮就停了
    await peer.onPeerIndex([entry('later.txt', [['dev-b', 1]], ['h1'])]);
    expect(requests.map((r) => r.path)).toEqual(['later.txt']);

    requests.length = 0;
    lines = ['later.txt'];
    await peer.onPeerIndex([entry('later.txt', [['dev-b', 2]], ['h2'])], { full: true });
    expect(requests).toEqual([]);
    expect(peer.getSyncProgress().pending).toBe(0);
  });
});

/**
 * 增量索引语义与「发送中」进度 —— 2026-09-16 两端目录卡空转事故的回归。
 *
 * 事故形态:A 的扫描器广播 19 条改动 → B 把这条**增量**消息当成全量快照,按并集
 * 规划,于是「本地有、消息里没提到的 246 条」被判成对端缺失 → 回推 246 条 → A
 * 同样处理 → 回推 19 条 …… 无限循环。每轮条目版本其实相等,所以全程静默:不落盘、
 * 不记历史、不打日志,只有两端网卡和 CPU 知道(实测 A 空转烧掉约半核 CPU);
 * 卡片则永远停在「传输中 · 发送 N」。
 */
describe('delta index semantics (回声环回归)', () => {
  function fakeTransport() {
    const sent: Array<{ entries: ReturnType<typeof entry>[]; mode: IndexMode }> = [];
    const requests: BlockRequest[] = [];
    return {
      transport: {
        sendEntries(entries: ReturnType<typeof entry>[], mode: IndexMode): void {
          sent.push({ entries, mode });
        },
        sendBlockRequest(request: BlockRequest): void {
          requests.push(request);
        },
        sendBlockResponse(): void {},
      } satisfies PeerTransport,
      sent,
      requests,
    };
  }

  /** 本机独有的存量条目:对端从未见过。 */
  function localOnlyPeer(count: number) {
    const local = new Map<string, ReturnType<typeof entry>>();
    for (let i = 0; i < count; i += 1) {
      local.set(`local-${i}.txt`, entry(`local-${i}.txt`, [['dev-a', 1]], [`h${i}`]));
    }
    return local;
  }

  function peerWith(local: Map<string, ReturnType<typeof entry>>, transport: PeerTransport) {
    return createSyncPeer({
      transport,
      localIndex: local,
      executor: null as never,
      readLocalBlock: () => Buffer.from(''),
      deviceId: 'DEV-A',
    });
  }

  it('never echoes back local-only entries that the message did not mention', async () => {
    const { transport, sent } = fakeTransport();
    const peer = peerWith(localOnlyPeer(3), transport);

    // 对端这轮只改了一个文件
    await peer.onPeerIndex([entry('changed.txt', [['dev-b', 2]], ['x1'])]);

    // 修复前:本机独有、消息里没提到的 3 条会被判成「对端没有」而回推,
    // 对端同样处理 → 两端互为回声,直到下一次全量交换才可能停
    expect(sent).toEqual([]);
  });

  it('uses union planning only for a full index message', async () => {
    const { transport, sent } = fakeTransport();
    const peer = peerWith(localOnlyPeer(2), transport);

    await peer.onPeerIndex([entry('changed.txt', [['dev-b', 2]], ['x1'])], { full: true });

    // 全量消息是对端索引的完整声明,「本机有、它没有」才真的意味着要推过去
    expect(sent).toHaveLength(1);
    expect(sent[0]!.mode).toBe('delta'); // 回推本身永远是针对若干路径的应答
    expect(sent[0]!.entries.map((e) => e.path)).toEqual(['local-0.txt', 'local-1.txt']);
  });

  it('labels its planned replies as delta', async () => {
    const { transport, sent } = fakeTransport();
    const peer = peerWith(
      new Map([['doc.txt', entry('doc.txt', [['dev-a', 2]], ['h1'])]]),
      transport,
    );

    await peer.onPeerIndex([entry('doc.txt', [['dev-a', 1]], ['h0'])]);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.mode).toBe('delta');
    expect(sent[0]!.entries.map((e) => e.path)).toEqual(['doc.txt']);
  });

  it('keeps in-flight receives alive across a delta message that does not mention them', async () => {
    const { transport } = fakeTransport();
    const peer = createSyncPeer({
      transport,
      localIndex: new Map(),
      executor: null as never,
      readLocalBlock: () => Buffer.from(''),
      deviceId: 'DEV-A',
    });

    const content = Buffer.from('in flight');
    await peer.onPeerIndex([
      entry('big.txt', [['dev-b', 1]], [hashBlock(content)], content.length),
    ]);
    expect(peer.getSyncProgress().pending).toBe(1);

    // 对端这轮改了另一个文件,没提 big.txt。修复前任何一条索引消息都会清掉
    // 「本轮未引用」的 pending,把正在传的文件腰斩,而且不会再有谁重新规划它。
    await peer.onPeerIndex([entry('other.txt', [['dev-b', 1]], ['h'], 1)]);
    expect(peer.getSyncProgress().pending).toBe(2);

    await peer.onBlockResponse({
      deviceId: 'DEV-B',
      path: 'big.txt',
      blockIndex: 0,
      hash: hashBlock(content),
      data: content,
    });
    expect(peer.getSyncProgress().pending).toBe(1);
  });

  it('aborts an in-flight receive when a delta message reports that path deleted', async () => {
    const { transport } = fakeTransport();
    const localIndex = new Map<string, ReturnType<typeof entry>>();
    const peer = createSyncPeer({
      transport,
      localIndex,
      executor: null as never,
      readLocalBlock: () => Buffer.from(''),
      deviceId: 'DEV-A',
    });

    const content = Buffer.from('doomed');
    await peer.onPeerIndex([entry('gone.txt', [['dev-b', 1]], [hashBlock(content)], content.length)]);
    expect(peer.getSyncProgress().pending).toBe(1);

    // 对端删掉了它 → 本机在途接收应被中止,迟到块响应不得把已删除的文件复活
    await peer.onPeerIndex([entry('gone.txt', [['dev-b', 2]], [], 0, true)]);
    expect(peer.getSyncProgress().pending).toBe(0);
    expect(localIndex.get('gone.txt')?.deleted).toBe(true);

    await peer.onBlockResponse({
      deviceId: 'DEV-B',
      path: 'gone.txt',
      blockIndex: 0,
      hash: hashBlock(content),
      data: content,
    });
    expect(peer.getSyncProgress().pending).toBe(0);
  });

  it('does not report「传输中」for entries the delta message never mentioned', async () => {
    const { transport, sent } = fakeTransport();
    const local = localOnlyPeer(2);
    local.set('doc.txt', entry('doc.txt', [['dev-b', 1]], ['h']));
    const peer = peerWith(local, transport);

    // 对端复发了一条双方本就一致的条目 —— 这一轮没有任何数据要传
    await peer.onPeerIndex([entry('doc.txt', [['dev-b', 1]], ['h'])]);

    // 修复前:本机独有的 2 条会被判成「对端没有」而回推,sending 停在 2;
    // 而且它只在下一次收到对端索引时才重算 —— 对端不再发索引就永远停在「传输中」
    expect(sent).toEqual([]);
    expect(peer.getSyncProgress()).toEqual({ pending: 0, sending: 0, receiving: 0 });
  });
});

describe('sync progress: 「发送中」以租约自愈', () => {
  function fakeTransport() {
    const responses: BlockResponse[] = [];
    return {
      transport: {
        sendEntries(): void {},
        sendBlockRequest(): void {},
        sendBlockResponse(response: BlockResponse): void {
          responses.push(response);
        },
      } satisfies PeerTransport,
      responses,
    };
  }

  it('counts files being served to the peer and decays to zero when they stop asking', async () => {
    const { transport, responses } = fakeTransport();
    const peer = createSyncPeer({
      transport,
      localIndex: new Map(),
      executor: null as never,
      readLocalBlock: () => Buffer.from('served'),
      deviceId: 'DEV-A',
    });

    vi.useFakeTimers();
    peer.onBlockRequest({ deviceId: 'DEV-B', path: 'a.txt', blockIndex: 0, hash: 'h' });
    expect(peer.getSyncProgress().sending).toBe(1);

    // 同一个文件的多个块只算 1 个文件;另一个文件再 +1
    peer.onBlockRequest({ deviceId: 'DEV-B', path: 'a.txt', blockIndex: 1, hash: 'h' });
    peer.onBlockRequest({ deviceId: 'DEV-B', path: 'b.txt', blockIndex: 0, hash: 'h' });
    expect(peer.getSyncProgress().sending).toBe(2);
    expect(responses).toHaveLength(3);

    // 对端不再拉块 → 租约过期后自动归零,无需任何外部事件来清零
    await vi.advanceTimersByTimeAsync(16_000);
    expect(peer.getSyncProgress()).toEqual({ pending: 0, sending: 0, receiving: 0 });

    vi.useRealTimers();
  });

  it('renews the lease while blocks keep flowing', async () => {
    const { transport } = fakeTransport();
    const peer = createSyncPeer({
      transport,
      localIndex: new Map(),
      executor: null as never,
      readLocalBlock: () => Buffer.from('served'),
      deviceId: 'DEV-A',
    });

    vi.useFakeTimers();
    peer.onBlockRequest({ deviceId: 'DEV-B', path: 'big.bin', blockIndex: 0, hash: 'h' });
    await vi.advanceTimersByTimeAsync(14_000);
    expect(peer.getSyncProgress().sending).toBe(1);

    // 慢速链路:块间隔接近租约上限,但只要还有块进来就不能判为已传完
    peer.onBlockRequest({ deviceId: 'DEV-B', path: 'big.bin', blockIndex: 1, hash: 'h' });
    await vi.advanceTimersByTimeAsync(14_000);
    expect(peer.getSyncProgress().sending).toBe(1);

    vi.useRealTimers();
  });
});

/**
 * 硬忽略闸门(见 docs/adr/0008):对端推来的 .git 一类条目一条都不收,本机也一条都不发。
 * 这组用例针对的正是「本机规则管不住对端规则」的实际场景——对端版本旧、或对端把忽略
 * 规则负向覆盖了,都会把 .git 条目推过来,若不拦,本机真实的 .git 会被覆盖或被移进回收站。
 */
describe('hard ignore (VCS 元数据不收不发)', () => {
  function fakeTransport() {
    const sentEntries: ReturnType<typeof entry>[] = [];
    const requests: BlockRequest[] = [];
    const responses: BlockResponse[] = [];
    return {
      transport: {
        sendEntries(entries: ReturnType<typeof entry>[]): void {
          sentEntries.push(...entries);
        },
        sendBlockRequest(request: BlockRequest): void {
          requests.push(request);
        },
        sendBlockResponse(response: BlockResponse): void {
          responses.push(response);
        },
      } satisfies PeerTransport,
      sentEntries,
      requests,
      responses,
    };
  }

  it('drops hard-ignored entries from the peer index: nothing written, nothing deleted, nothing echoed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-peer-hardignore-'));
    const root = join(dir, 'share');
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, '.git', 'config'), 'local git config');
    const index = openIndexStore(join(dir, 'index.db'));
    const executor = createLocalExecutor(root, index, join(root, '.syncx-trash'));
    const { transport, sentEntries, requests } = fakeTransport();
    const dropped: string[][] = [];
    const localIndex = new Map<string, ReturnType<typeof entry>>();

    // 冷设备形态:本机索引为空,对端「热」。若不拦,.git/config 会先被冷启动保护
    // 当成新文件、再被对端版本覆盖;.git/HEAD 的墓碑会把本机文件移进回收站。
    const peer = createSyncPeer({
      transport,
      localIndex,
      executor,
      readLocalBlock: () => Buffer.from(''),
      deviceId: 'DEV-A',
      remoteDeviceId: 'DEV-B',
      root,
      readIgnoreLines: () => [],
      onHardIgnoredDropped: (paths) => dropped.push(paths),
    });

    const peerGit = Buffer.from('peer git config');
    const peerNotes = Buffer.from('hi');
    await peer.onPeerIndex([
      entry('.git/config', [['dev-b', 1]], [hashBlock(peerGit)], peerGit.length),
      entry('.git/HEAD', [['dev-b', 1]], [], 0, true),
      entry('.syncx-trash/old.txt.1ab', [['dev-b', 1]], [], 0, true),
      entry('notes.txt', [['dev-b', 1]], [hashBlock(peerNotes)], peerNotes.length),
    ]);

    // 本机 .git 既没被写也没被删
    expect(readFileSync(join(root, '.git', 'config'), 'utf8')).toBe('local git config');
    expect(existsSync(join(root, '.git', 'HEAD'))).toBe(false);
    // 被丢弃的条目不进本地索引,也不为其请求块
    expect(localIndex.has('.git/config')).toBe(false);
    expect(requests.map((r) => r.path)).toEqual(['notes.txt']);
    // 也不回推
    expect(sentEntries).toEqual([]);
    // 丢弃事件原样上报,便于在日志里发现「对端在推 .git」(通常是版本旧)
    expect(dropped.flat()).toEqual(['.git/config', '.git/HEAD', '.syncx-trash/old.txt.1ab']);

    index.close();
    rmDir(dir);
  });

  it('never sends a hard-ignored entry even if one somehow reaches the local index', async () => {
    const { transport, sentEntries } = fakeTransport();
    // 正常路径下 localIndex 不可能含硬忽略路径(createFolderState 会过滤掉),
    // 这里刻意构造,验证出向闸门是独立生效的最后一道,而不是依赖上游记得过滤
    const local = new Map([['.git/config', entry('.git/config', [['dev-a', 2]], ['l1'], 100)]]);
    const peer = createSyncPeer({
      transport,
      localIndex: local,
      executor: null as never,
      readLocalBlock: () => Buffer.from(''),
      deviceId: 'DEV-A',
    });

    await peer.onPeerIndex([entry('.git/config', [['dev-a', 1]], ['l0'], 100)]);

    expect(sentEntries).toEqual([]);
  });
});

describe('receive-only mode (只拉不推)', () => {
  function fakeTransport() {
    const sentEntries: ReturnType<typeof entry>[] = [];
    const requests: BlockRequest[] = [];
    const responses: BlockResponse[] = [];
    return {
      transport: {
        sendEntries(entries: ReturnType<typeof entry>[]): void {
          sentEntries.push(...entries);
        },
        sendBlockRequest(request: BlockRequest): void {
          requests.push(request);
        },
        sendBlockResponse(response: BlockResponse): void {
          responses.push(response);
        },
      } satisfies PeerTransport,
      sentEntries,
      requests,
      responses,
    };
  }

  it('does not push local-newer entries to the peer', async () => {
    const { transport, sentEntries, requests } = fakeTransport();
    const local = new Map([['local.txt', entry('local.txt', [['dev-a', 2]], ['l1'])]]);
    const peer = createSyncPeer({
      transport,
      localIndex: local,
      executor: null as never,
      readLocalBlock: () => Buffer.from(''),
      deviceId: 'DEV-A',
      receiveOnly: true,
    });

    const remote = [
      entry('local.txt', [['dev-a', 1]], ['l0']),
      entry('remote.txt', [['dev-b', 3]], ['r1', 'r2'], 200),
    ];
    await peer.onPeerIndex(remote);

    // 本地较新的 local.txt 不外卖;远端较新的 remote.txt 仍被拉取(发出块请求)
    expect(sentEntries).toEqual([]);
    expect(requests).toEqual([
      { deviceId: 'DEV-A', path: 'remote.txt', blockIndex: 0, hash: 'r1' },
      { deviceId: 'DEV-A', path: 'remote.txt', blockIndex: 1, hash: 'r2' },
    ]);
  });

  it('does not propagate a local tombstone to the peer', async () => {
    const { transport, sentEntries } = fakeTransport();
    // 本地已删除(local.txt 为墓碑),对端仍持有该文件
    const local = new Map([['local.txt', entry('local.txt', [['dev-a', 2]], ['l1'], 100, true)]]);
    const peer = createSyncPeer({
      transport,
      localIndex: local,
      executor: null as never,
      readLocalBlock: () => Buffer.from(''),
      deviceId: 'DEV-A',
      receiveOnly: true,
    });

    const remote = [entry('local.txt', [['dev-b', 1]], ['x1'], 100)];
    await peer.onPeerIndex(remote);

    // 接收模式下本地墓碑不外推:对端不会被通知删除(否则会误删完整端)
    expect(sentEntries).toEqual([]);
  });

  it('applies a remote tombstone locally (对端删除仍跟随)', async () => {
    const { transport, sentEntries } = fakeTransport();
    const local = new Map([['gone.txt', entry('gone.txt', [['dev-a', 1]], ['g1'])]]);
    const peer = createSyncPeer({
      transport,
      localIndex: local,
      executor: null as never,
      readLocalBlock: () => Buffer.from(''),
      deviceId: 'DEV-A',
      receiveOnly: true,
    });

    // 对端删除了 gone.txt:接收模式仍应用该删除(纯镜像语义)
    await peer.onPeerIndex([entry('gone.txt', [['dev-b', 2]], [], 0, true)]);
    expect(sentEntries).toEqual([]);
    expect(local.get('gone.txt')?.deleted).toBe(true);
  });

  it('resolves a conflict by taking the remote version (no local conflict copy)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-peer-ro-'));
    const root = join(dir, 'share');
    mkdirSync(root, { recursive: true });
    const index = openIndexStore(join(dir, 'index.db'));
    const executor = createLocalExecutor(root, index, join(root, '.syncx-trash'));
    const { transport } = fakeTransport();

    // 本地与对端都改了 shared.txt,版本向量分叉 → 在双向模式里是 conflict
    const local = new Map([
      ['shared.txt', entry('shared.txt', [['dev-a', 2]], [hashBlock(Buffer.from('local-side'))], 10)],
    ]);
    const peer = createSyncPeer({
      transport,
      localIndex: local,
      executor,
      readLocalBlock: () => Buffer.from(''),
      deviceId: 'DEV-A',
      remoteDeviceId: 'DEV-B',
      root,
      receiveOnly: true,
    });

    const remoteContent = Buffer.from('remote-side');
    await peer.onPeerIndex([
      entry('shared.txt', [['dev-b', 2]], [hashBlock(remoteContent)], remoteContent.length),
    ]);
    peer.onBlockResponse({
      deviceId: 'DEV-B',
      path: 'shared.txt',
      blockIndex: 0,
      hash: hashBlock(remoteContent),
      data: remoteContent,
    });
    await new Promise((r) => setTimeout(r, 10));

    // 冲突以对端版本覆盖本地,且不应生成 .sync-conflict- 副本
    expect(readFileSync(join(root, 'shared.txt'))).toEqual(remoteContent);
    expect(readdirSync(root).filter((n) => n.includes('.sync-conflict-'))).toHaveLength(0);

    index.close();
    rmDir(dir);
  });
});
