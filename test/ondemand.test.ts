import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createControlServer } from '../src/api.js';
import { hashBlock } from '../src/blockstore.js';
import { isUnderDirPrefix, loadConfig } from '../src/config.js';
import { setFolderOnDemand, setFolderOnDemandDir } from '../src/devices.js';
import { decodeIndex, encodeIndex } from '../src/messages.js';
import type { IndexEntry } from '../src/index.js';
import { createLocalExecutor } from '../src/executor.js';
import { openIndexStore } from '../src/indexstore.js';
import { createSyncPeer, type PeerTransport } from '../src/peer.js';
import type { BlockRequest } from '../src/messages.js';
import { scanFolder } from '../src/scanner.js';
import { rmDir } from './helpers.js';

/**
 * 按需同步(稀疏文件)的测试:占位标志的存储/出线收口、扫描不墓碑、
 * peer 的「receive 改记占位 → materialize 拉块落地」闭环、配置持久化与路由校验。
 */

const openServers: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const s of openServers) s.close();
  openServers.length = 0;
});

function entry(
  path: string,
  version: Array<[string, number]>,
  blocks: string[],
  size = 100,
  extra: Partial<IndexEntry> = {},
): IndexEntry {
  return { path, version: new Map(version), size, deleted: false, blocks, ...extra };
}

function fakeTransport() {
  const requests: BlockRequest[] = [];
  const sentEntries: IndexEntry[] = [];
  return {
    transport: {
      sendEntries(entries: IndexEntry[]): void {
        sentEntries.push(...entries);
      },
      sendBlockRequest(request: BlockRequest): void {
        requests.push(request);
      },
      sendBlockResponse(): void {},
    } satisfies PeerTransport,
    requests,
    sentEntries,
  };
}

describe('占位标志的存储与收口', () => {
  it('indexstore:placeholder 往返 + 重开库仍在;普通条目无标志', () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-od-store-'));
    const file = join(dir, 'index.db');
    const index = openIndexStore(file);
    index.saveEntry(entry('a.txt', [['DEV-A', 1]], ['h1'], 10, { placeholder: true }));
    index.saveEntry(entry('b.txt', [['DEV-A', 1]], ['h1'], 10));
    expect(index.getEntry('a.txt')?.placeholder).toBe(true);
    expect(index.getEntry('b.txt')?.placeholder).toBeUndefined();
    index.close();
    const again = openIndexStore(file);
    expect(again.getEntry('a.txt')?.placeholder).toBe(true);
    again.close();
    rmDir(dir);
  });

  it('encodeIndex:占位条目永不出线(实体照常,双向字段不变)', () => {
    const live = entry('live.txt', [['DEV-A', 1]], ['h1'], 10, { mtime: 123 });
    const ph = entry('ph.txt', [['DEV-B', 2]], ['h2'], 20, { placeholder: true });
    const decoded = decodeIndex(encodeIndex([live, ph]));
    expect(decoded).toHaveLength(1);
    expect(decoded[0]?.path).toBe('live.txt');
    expect(decoded[0]?.placeholder).toBeUndefined();
  });

  it('scanFolder:占位条目盘上不存在也不生成墓碑;真删除照常墓碑', () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-od-scan-'));
    const root = join(dir, 'share');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'real.txt'), 'abc');
    const index = openIndexStore(join(dir, 'index.db'));
    const st = statSync(join(root, 'real.txt'));
    index.saveEntry(entry('real.txt', [['DEV-A', 1]], [hashBlock(Buffer.from('abc'))], st.size, { mtime: st.mtimeMs }));
    index.saveEntry(entry('ghost.txt', [['DEV-B', 1]], ['h1'], 50, { placeholder: true }));
    index.saveEntry(entry('gone.txt', [['DEV-A', 1]], ['h1'], 5));
    const diff = scanFolder(root, index, [], 'DEV-A');
    index.close();
    rmDir(dir);
    expect(diff.changed).toEqual([]);
    expect(diff.tombstones.map((t) => t.path)).toEqual(['gone.txt']);
  });
});

describe('peer 按需接收与 materialize', () => {
  function setup(onDemand: boolean) {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-od-peer-'));
    const root = join(dir, 'share');
    mkdirSync(root, { recursive: true });
    const index = openIndexStore(join(dir, 'index.db'));
    const executor = createLocalExecutor(root, index, join(root, '.syncx-trash'));
    const localIndex = new Map<string, IndexEntry>();
    const t = fakeTransport();
    const events: Array<{ path: string; action: string }> = [];
    const peer = createSyncPeer({
      transport: t.transport,
      localIndex,
      executor,
      readLocalBlock: (path, blockIndex) => {
        const data = readFileSync(join(root, path));
        return data.subarray(blockIndex * 1024 * 1024, (blockIndex + 1) * 1024 * 1024);
      },
      deviceId: 'DEV-A',
      remoteDeviceId: 'DEV-B',
      getOnDemand: () => onDemand,
      onEvent: (ev) => events.push({ path: ev.path, action: ev.action }),
    });
    return { dir, root, index, localIndex, t, events, peer };
  }

  it('开:非空文件只记占位,不发块请求、不落盘;记录照常生成', async () => {
    const s = setup(true);
    const content = Buffer.from('按需同步的载荷');
    await s.peer.onPeerIndex([entry('big.bin', [['DEV-B', 1]], [hashBlock(content)], content.length)]);
    expect(s.t.requests).toHaveLength(0);
    expect(existsSync(join(s.root, 'big.bin'))).toBe(false);
    expect(s.localIndex.get('big.bin')?.placeholder).toBe(true);
    expect(s.index.getEntry('big.bin')?.placeholder).toBe(true);
    expect(s.events).toEqual([{ path: 'big.bin', action: 'add' }]);
    s.index.close();
    rmDir(s.dir);
  });

  it('开:空文件无盘可省,照常即时落地', async () => {
    const s = setup(true);
    await s.peer.onPeerIndex([entry('empty.txt', [['DEV-B', 1]], [], 0)]);
    expect(existsSync(join(s.root, 'empty.txt'))).toBe(true);
    expect(s.index.getEntry('empty.txt')?.placeholder).toBeUndefined();
    s.index.close();
    rmDir(s.dir);
  });

  it('materialize:补发块请求,块收齐后落盘、占位标志清除', async () => {
    const s = setup(true);
    const content = Buffer.from('materialize me');
    const hash = hashBlock(content);
    await s.peer.onPeerIndex([entry('doc.md', [['DEV-B', 1]], [hash], content.length)]);
    expect(s.peer.materialize('doc.md')).toBe(true);
    expect(s.t.requests).toEqual([
      { deviceId: 'DEV-A', path: 'doc.md', blockIndex: 0, hash },
    ]);
    // 幂等:再点一次不重复排队
    expect(s.peer.materialize('doc.md')).toBe(true);
    expect(s.t.requests).toHaveLength(1);
    await s.peer.onBlockResponse({ deviceId: 'DEV-B', path: 'doc.md', blockIndex: 0, hash, data: content });
    expect(readFileSync(join(s.root, 'doc.md'))).toEqual(content);
    expect(s.localIndex.get('doc.md')?.placeholder).toBeUndefined();
    expect(s.index.getEntry('doc.md')?.placeholder).toBeUndefined();
    s.index.close();
    rmDir(s.dir);
  });

  it('materialize:非占位路径(实体/不存在)是空操作', () => {
    const s = setup(true);
    expect(s.peer.materialize('nope.txt')).toBe(false);
    s.localIndex.set('real.txt', entry('real.txt', [['DEV-A', 1]], ['h1'], 3));
    expect(s.peer.materialize('real.txt')).toBe(false);
    s.index.close();
    rmDir(s.dir);
  });

  it('关:行为与既有一致 —— 直接拉块,无占位', async () => {
    const s = setup(false);
    const content = Buffer.from('normal receive');
    const hash = hashBlock(content);
    await s.peer.onPeerIndex([entry('n.txt', [['DEV-B', 1]], [hash], content.length)]);
    expect(s.t.requests).toHaveLength(1);
    expect(s.localIndex.get('n.txt')?.placeholder).toBeUndefined();
    s.index.close();
    rmDir(s.dir);
  });
});

describe('devices.setFolderOnDemand', () => {
  function tempConfig(): string {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-od-cfg-'));
    const file = join(dir, 'config.json');
    writeFileSync(
      file,
      JSON.stringify({
        sharedFolders: [{ path: '/data/box', devices: ['DEVA'] }],
        peers: [],
        knownDevices: [],
      }),
    );
    return file;
  }

  it('开=true 落盘;关=undefined 不留迹;未知目录抛错', () => {
    const file = tempConfig();
    setFolderOnDemand(file, '/data/box', true);
    expect(loadConfig(file).sharedFolders[0]?.onDemand).toBe(true);
    setFolderOnDemand(file, '/data/box', false);
    expect(loadConfig(file).sharedFolders[0]?.onDemand).toBeUndefined();
    expect(() => setFolderOnDemand(file, '/nope', true)).toThrow(/未找到共享目录/);
    rmDir(join(file, '..'));
  });
});

describe('POST /api/folders/on-demand 与 /api/folders/materialize', () => {
  async function withServer(
    deps: Partial<Parameters<typeof createControlServer>[0]>,
  ): Promise<number> {
    const server = createControlServer({
      token: 'secret',
      getStatus: () => ({}),
      ...deps,
    } as Parameters<typeof createControlServer>[0]);
    server.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    openServers.push({ close: () => server.close() });
    return (server.address() as AddressInfo).port;
  }

  function post(port: number, path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path,
          method: 'POST',
          headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
        },
        (res) => {
          res.setEncoding('utf8');
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, json: data === '' ? {} : (JSON.parse(data) as Record<string, unknown>) }),
          );
        },
      );
      req.on('error', reject);
      req.write(JSON.stringify(body));
      req.end();
    });
  }

  it('on-demand:folderId/onDemand 严格校验,合法值透传', async () => {
    let call: { folderId: string; on: boolean } | null = null;
    const port = await withServer({
      setFolderOnDemand: (folderId, on) => {
        call = { folderId, on };
      },
    });
    expect((await post(port, '/api/folders/on-demand', { onDemand: true })).status).toBe(400);
    expect((await post(port, '/api/folders/on-demand', { folderId: 'box', onDemand: 'yes' })).status).toBe(400);
    const res = await post(port, '/api/folders/on-demand', { folderId: 'box', onDemand: true });
    expect(res.status).toBe(200);
    expect(call).toEqual({ folderId: 'box', on: true });
  });

  it('materialize:path 必填;manager 抛错原样 400 透出', async () => {
    const port = await withServer({
      materializeFile: async (_folderId, p) => {
        if (p === 'bad.bin') throw new Error('当前没有在线对端能提供该文件(等对端上线后重试)');
      },
    });
    expect((await post(port, '/api/folders/materialize', { folderId: 'box' })).status).toBe(400);
    const fail = await post(port, '/api/folders/materialize', { folderId: 'box', path: 'bad.bin' });
    expect(fail.status).toBe(400);
    expect(String(fail.json.error)).toContain('没有在线对端');
    const ok = await post(port, '/api/folders/materialize', { folderId: 'box', path: 'good.bin' });
    expect(ok.status).toBe(200);
  });

  it('on-demand-dir(选择性同步):folderId/path/onDemand 严格校验,合法值透传', async () => {
    const calls: Array<[string, string, boolean]> = [];
    const port = await withServer({
      setFolderOnDemandDir: (folderId, p, on) => {
        calls.push([folderId, p, on]);
      },
    });
    expect((await post(port, '/api/folders/on-demand-dir', { path: 'media', onDemand: true })).status).toBe(400);
    expect((await post(port, '/api/folders/on-demand-dir', { folderId: 'box', onDemand: true })).status).toBe(400);
    expect(
      (await post(port, '/api/folders/on-demand-dir', { folderId: 'box', path: 'media', onDemand: 'yes' })).status,
    ).toBe(400);
    const ok = await post(port, '/api/folders/on-demand-dir', { folderId: 'box', path: 'media', onDemand: true });
    expect(ok.status).toBe(200);
    expect(calls).toEqual([['box', 'media', true]]);
  });
});

// ---------------------------------------------------------------------------
// 选择性同步(子目录级占位):前缀匹配 / 持久化 / peer 按路径占位
// ---------------------------------------------------------------------------

describe('isUnderDirPrefix', () => {
  it('目录本身与后代命中;相似前缀不误伤;空列表恒 false', () => {
    expect(isUnderDirPrefix('media', ['media'])).toBe(true);
    expect(isUnderDirPrefix('media/a.bin', ['media'])).toBe(true);
    expect(isUnderDirPrefix('media/sub/a.bin', ['media'])).toBe(true);
    expect(isUnderDirPrefix('mediax/a.bin', ['media'])).toBe(false);
    expect(isUnderDirPrefix('other/a.bin', ['media'])).toBe(false);
    expect(isUnderDirPrefix('a/x.bin', ['b', 'a'])).toBe(true);
    expect(isUnderDirPrefix('media/a.bin', undefined)).toBe(false);
    expect(isUnderDirPrefix('media/a.bin', [])).toBe(false);
  });
});

describe('devices.setFolderOnDemandDir', () => {
  function tempConfig(): string {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-oddir-cfg-'));
    const file = join(dir, 'config.json');
    writeFileSync(
      file,
      JSON.stringify({
        sharedFolders: [{ path: '/data/box', devices: ['DEVA'] }],
        peers: [],
        knownDevices: [],
      }),
    );
    return file;
  }

  it('加入去重、反斜杠/尾斜杠归一;移出逐个摘除,清空存 undefined', () => {
    const file = tempConfig();
    const list = () => loadConfig(file).sharedFolders[0]?.onDemandDirs;
    setFolderOnDemandDir(file, '/data/box', 'media', true);
    setFolderOnDemandDir(file, '/data/box', 'videos\\raw', true);
    expect(list()).toEqual(['media', 'videos/raw']);
    setFolderOnDemandDir(file, '/data/box', 'media/', true);
    expect(list()).toEqual(['media', 'videos/raw']);
    setFolderOnDemandDir(file, '/data/box', 'media', false);
    expect(list()).toEqual(['videos/raw']);
    setFolderOnDemandDir(file, '/data/box', 'videos/raw', false);
    expect(list()).toBeUndefined();
    rmDir(join(file, '..'));
  });

  it('空路径抛错;未知目录抛错', () => {
    const file = tempConfig();
    expect(() => setFolderOnDemandDir(file, '/data/box', '', true)).toThrow(/path is required/);
    expect(() => setFolderOnDemandDir(file, '/nope', 'media', true)).toThrow(/未找到共享目录/);
    rmDir(join(file, '..'));
  });
});

describe('peer 按路径的按需判定(子目录命中前缀才占位)', () => {
  it('前缀下非空文件记占位;前缀相似名与名单外路径照常拉块', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-oddir-peer-'));
    const root = join(dir, 'share');
    mkdirSync(root, { recursive: true });
    const index = openIndexStore(join(dir, 'index.db'));
    const executor = createLocalExecutor(root, index, join(root, '.syncx-trash'));
    const localIndex = new Map<string, IndexEntry>();
    const t = fakeTransport();
    const peer = createSyncPeer({
      transport: t.transport,
      localIndex,
      executor,
      readLocalBlock: () => Buffer.alloc(0),
      deviceId: 'DEV-A',
      remoteDeviceId: 'DEV-B',
      getOnDemand: (p) => isUnderDirPrefix(p, ['media']),
    });
    const content = Buffer.from('一段非空载荷');
    const hash = hashBlock(content);
    await peer.onPeerIndex([
      entry('media/a.mp4', [['DEV-B', 1]], [hash], content.length),
      entry('mediax/b.mp4', [['DEV-B', 1]], [hash], content.length),
      entry('docs/c.bin', [['DEV-B', 1]], [hash], content.length),
    ]);
    expect(index.getEntry('media/a.mp4')?.placeholder).toBe(true);
    expect(existsSync(join(root, 'media', 'a.mp4'))).toBe(false);
    expect(index.getEntry('mediax/b.mp4')?.placeholder).toBeUndefined();
    expect(index.getEntry('docs/c.bin')?.placeholder).toBeUndefined();
    expect(t.requests.map((r) => r.path).sort()).toEqual(['docs/c.bin', 'mediax/b.mp4']);
    index.close();
    rmDir(dir);
  });
});
