import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planSyncRound, createSyncPeer, type PeerTransport } from '../src/peer.js';
import { createLocalExecutor } from '../src/executor.js';
import { openIndexStore } from '../src/indexstore.js';
import { hashBlock } from '../src/blockstore.js';

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

describe('sync peer round planning', () => {
  it('plans sends for newer local entries and block requests for remote receives', () => {
    const local = new Map([
      ['local.txt', entry('local.txt', [['dev-a', 2]], ['l1'])],
      ['shared.txt', entry('shared.txt', [['dev-a', 1]], ['s1'])],
    ]);
    const remote = new Map([
      ['remote.txt', entry('remote.txt', [['dev-b', 3]], ['r1', 'r2'], 200)],
      ['shared.txt', entry('shared.txt', [['dev-a', 1]], ['s1'])],
    ]);

    const plan = planSyncRound(local, remote);

    expect(plan.send).toEqual([entry('local.txt', [['dev-a', 2]], ['l1'])]);
    expect(plan.requestBlocks).toEqual([
      { path: 'remote.txt', blockIndex: 0, hash: 'r1' },
      { path: 'remote.txt', blockIndex: 1, hash: 'r2' },
    ]);
  });

  it('requests no blocks when the remote has nothing newer', () => {
    const local = new Map([['a.txt', entry('a.txt', [['dev-a', 2]], ['a1'])]]);
    const remote = new Map([['a.txt', entry('a.txt', [['dev-a', 1]], ['a0'])]]);

    const plan = planSyncRound(local, remote);

    expect(plan.send).toEqual([entry('a.txt', [['dev-a', 2]], ['a1'])]);
    expect(plan.requestBlocks).toEqual([]);
  });
});

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
});
