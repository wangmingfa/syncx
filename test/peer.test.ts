import { describe, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSyncPeer, type PeerTransport } from '../src/peer.js';
import { createLocalExecutor } from '../src/executor.js';
import { openIndexStore } from '../src/indexstore.js';
import { hashBlock, BLOCK_SIZE } from '../src/blockstore.js';

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
    rmSync(dir, { recursive: true, force: true });
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
    rmSync(dir, { recursive: true, force: true });
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
    rmSync(dir, { recursive: true, force: true });
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
    rmSync(dir, { recursive: true, force: true });
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
    rmSync(dir, { recursive: true, force: true });
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

  it('does not serve blocks for paths escaping the root via a symlink', () => {
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

    rmSync(dir, { recursive: true, force: true });
  });
});
