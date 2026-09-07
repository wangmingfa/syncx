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
import { createSyncPeer, type PeerTransport } from '../src/peer.js';
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
    const requests: Array<Record<string, unknown>> = [];
    const responses: Array<Record<string, unknown>> = [];
    return {
      transport: {
        sendEntries(entries: ReturnType<typeof entry>[]): void {
          sentEntries.push(...entries);
        },
        sendBlockRequest(request: Record<string, unknown>): void {
          requests.push(request);
        },
        sendBlockResponse(response: Record<string, unknown>): void {
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
    const executor = createLocalExecutor(root, index);
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

  it('lands empty files (0 blocks) without any block round-trip', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-peer-'));
    const root = join(dir, 'share');
    mkdirSync(root, { recursive: true });
    const index = openIndexStore(join(dir, 'index.db'));
    const executor = createLocalExecutor(root, index);
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
    const executor = createLocalExecutor(root, index);
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
    const executor = createLocalExecutor(root, index);
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
    const executor = createLocalExecutor(root, index);
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

  it('clears stale pending entries when the peer index no longer references them', async () => {
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

    // 对端下一轮索引不再包含该路径(如对端删除后不再广播该条目):
    // 上一轮遗留的 pending 条目应被清理,而非永久滞留(进度虚报 +
    // 迟到块响应可能复活已被删除的文件)
    await peer.onPeerIndex([]);
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
    const executor = createLocalExecutor(root, index);
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
      ignoreLines: [],
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

  it('does not preserve ignored files on receive (lets them be overwritten, avoids re-syncing them out)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-peer-'));
    const root = join(dir, 'share');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, '.syncxignore'), 'secret.txt\n');
    const index = openIndexStore(join(dir, 'index.db'));
    const executor = createLocalExecutor(root, index);
    const { transport } = fakeTransport();

    writeFileSync(join(root, 'secret.txt'), 'local ignored');
    const localIndex = new Map();

    const peer = createSyncPeer({
      transport,
      localIndex,
      executor,
      readLocalBlock: () => Buffer.from(''),
      deviceId: 'DEV-A',
      remoteDeviceId: 'DEV-B',
      root,
      ignoreLines: ['secret.txt'],
    });

    const remoteContent = Buffer.from('peer version');
    await peer.onPeerIndex([entry('secret.txt', [['dev-b', 1]], [hashBlock(remoteContent)], remoteContent.length)]);
    peer.onBlockResponse({
      deviceId: 'DEV-B',
      path: 'secret.txt',
      blockIndex: 0,
      hash: hashBlock(remoteContent),
      data: remoteContent,
    });
    await new Promise((r) => setTimeout(r, 10));

    // 被忽略文件:不保留冲突副本,直接接收覆盖(与旧行为一致,避免反向同步出去)
    expect(readdirSync(root).filter((n) => n.includes('.sync-conflict-'))).toHaveLength(0);
    expect(readFileSync(join(root, 'secret.txt'))).toEqual(remoteContent);

    index.close();
    rmDir(dir);
  });
});
