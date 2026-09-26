import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createControlServer } from '../src/api.js';
import { hashBlock } from '../src/blockstore.js';
import { loadConfig } from '../src/config.js';
import { setFolderPausedFile } from '../src/devices.js';
import type { IndexEntry } from '../src/index.js';
import { createLocalExecutor } from '../src/executor.js';
import { openIndexStore } from '../src/indexstore.js';
import { createSyncPeer, type PeerTransport } from '../src/peer.js';
import type { BlockRequest } from '../src/messages.js';
import { rmDir } from './helpers.js';

/**
 * Web 回收站 + 单文件暂停的测试:
 * - devices.setFolderPausedFile 的持久化(去重 / 反斜杠归一 / 清空存 undefined);
 * - peer 的 isPausedPath 双向冻结(对端新文件不落地、对端删除不应用、本地较新不外推);
 * - POST /api/folders/pause-file 的严格校验与透传;
 * - /api/trash* 的分档鉴权(列举仅需登录,还原/彻底删除需提权)与参数校验。
 */

function entry(
  path: string,
  version: Array<[string, number]>,
  blocks: string[],
  size = 100,
  extra: Partial<IndexEntry> = {},
): IndexEntry {
  return { path, version: new Map(version), size, deleted: false, blocks, ...extra };
}

const openServers: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const s of openServers) s.close();
  openServers.length = 0;
});

// ---------------------------------------------------------------------------
// devices.setFolderPausedFile
// ---------------------------------------------------------------------------

describe('devices.setFolderPausedFile', () => {
  function tempConfig(): string {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-pfile-cfg-'));
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

  it('暂停落列表、去重、反斜杠归一;恢复逐个摘除,清空存 undefined', () => {
    const file = tempConfig();
    const list = () => loadConfig(file).sharedFolders[0]?.pausedFiles;

    setFolderPausedFile(file, '/data/box', 'a.txt', true);
    setFolderPausedFile(file, '/data/box', 'dir/b.txt', true);
    expect(list()).toEqual(['a.txt', 'dir/b.txt']);

    // 重复暂停同一路径:去重,不产生第二条
    setFolderPausedFile(file, '/data/box', 'a.txt', true);
    expect(list()).toEqual(['a.txt', 'dir/b.txt']);

    // Windows 分隔符入参归一成 '/'(与索引同形)
    setFolderPausedFile(file, '/data/box', 'dir\\c.txt', true);
    expect(list()).toEqual(['a.txt', 'dir/b.txt', 'dir/c.txt']);

    setFolderPausedFile(file, '/data/box', 'dir/c.txt', false);
    expect(list()).toEqual(['a.txt', 'dir/b.txt']);
    setFolderPausedFile(file, '/data/box', 'a.txt', false);
    setFolderPausedFile(file, '/data/box', 'dir/b.txt', false);
    // 空列表不留迹:缺省承载默认语义(同 onDemand)
    expect(list()).toBeUndefined();

    rmDir(join(file, '..'));
  });

  it('未知目录抛错', () => {
    const file = tempConfig();
    expect(() => setFolderPausedFile(file, '/nope', 'a.txt', true)).toThrow(/未找到共享目录/);
    rmDir(join(file, '..'));
  });
});

// ---------------------------------------------------------------------------
// peer 的 isPausedPath 双向冻结
// ---------------------------------------------------------------------------

describe('peer 单文件暂停:双向冻结', () => {
  function setup(paused: string[]) {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-pfile-peer-'));
    const root = join(dir, 'share');
    mkdirSync(root, { recursive: true });
    const index = openIndexStore(join(dir, 'index.db'));
    const executor = createLocalExecutor(root, index, join(root, '.syncx-trash'));
    const localIndex = new Map<string, IndexEntry>();
    const requests: BlockRequest[] = [];
    const sentEntries: IndexEntry[] = [];
    const transport: PeerTransport = {
      sendEntries(entries: IndexEntry[]): void {
        sentEntries.push(...entries);
      },
      sendBlockRequest(req: BlockRequest): void {
        requests.push(req);
      },
      sendBlockResponse(): void {},
    };
    const events: Array<{ path: string; action: string }> = [];
    const peer = createSyncPeer({
      transport,
      localIndex,
      executor,
      readLocalBlock: () => Buffer.alloc(0),
      deviceId: 'DEV-A',
      remoteDeviceId: 'DEV-B',
      isPausedPath: (p) => paused.includes(p),
      onEvent: (ev) => events.push({ path: ev.path, action: ev.action }),
    });
    return { dir, root, index, localIndex, requests, sentEntries, events, peer };
  }

  it('暂停路径:对端较新文件不落地、不发块请求、索引不动、无记录', async () => {
    const s = setup(['frozen.bin']);
    const content = Buffer.from('被冻结的对端版本');
    await s.peer.onPeerIndex([entry('frozen.bin', [['DEV-B', 1]], [hashBlock(content)], content.length)]);
    expect(s.requests).toHaveLength(0);
    expect(existsSync(join(s.root, 'frozen.bin'))).toBe(false);
    expect(s.localIndex.has('frozen.bin')).toBe(false);
    expect(s.index.getEntry('frozen.bin')).toBeUndefined();
    expect(s.events).toEqual([]);
    s.index.close();
    rmDir(s.dir);
  });

  it('对照:未暂停的同款交换照常拉块', async () => {
    const s = setup([]);
    const content = Buffer.from('正常接收');
    await s.peer.onPeerIndex([entry('ok.bin', [['DEV-B', 1]], [hashBlock(content)], content.length)]);
    expect(s.requests).toHaveLength(1);
    s.index.close();
    rmDir(s.dir);
  });

  it('暂停路径:对端墓碑不执行,本地实体与索引原样保留', async () => {
    const s = setup(['keep.txt']);
    writeFileSync(join(s.root, 'keep.txt'), 'abc');
    const local = entry('keep.txt', [['DEV-A', 1]], ['h1'], 3);
    s.localIndex.set('keep.txt', local);
    s.index.saveEntry(local);
    // 对端墓碑:向量严格更新(含本地 DEV-A:1 再加 DEV-B:1)→ 计划里是 delete
    await s.peer.onPeerIndex([entry('keep.txt', [['DEV-A', 1], ['DEV-B', 1]], [], 0, { deleted: true })]);
    expect(existsSync(join(s.root, 'keep.txt'))).toBe(true);
    expect(s.localIndex.get('keep.txt')?.deleted).toBe(false);
    expect(s.index.getEntry('keep.txt')?.deleted).toBe(false);
    s.index.close();
    rmDir(s.dir);
  });

  it('暂停路径:本地较新条目不外推(其余路径照常发送)', async () => {
    const s = setup(['frozen.bin']);
    s.localIndex.set('frozen.bin', entry('frozen.bin', [['dev-a', 2]], ['l2']));
    s.localIndex.set('loose.bin', entry('loose.bin', [['dev-a', 2]], ['m2']));
    await s.peer.onPeerIndex([
      entry('frozen.bin', [['dev-a', 1]], ['l1']),
      entry('loose.bin', [['dev-a', 1]], ['m1']),
    ]);
    expect(s.sentEntries.map((e) => e.path)).toEqual(['loose.bin']);
    s.index.close();
    rmDir(s.dir);
  });
});

// ---------------------------------------------------------------------------
// 路由:POST /api/folders/pause-file 与 /api/trash*
// ---------------------------------------------------------------------------

interface RawRes {
  status: number;
  headers: NodeJS.Dict<string | string[]>;
  json: Record<string, unknown>;
}

function reqRaw(
  port: number,
  path: string,
  opts: { method?: string; token?: string; cookie?: string; body?: unknown } = {},
): Promise<RawRes> {
  return new Promise((resolve, reject) => {
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: opts.method ?? 'GET',
        headers: {
          ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
          ...(opts.cookie ? { Cookie: opts.cookie } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
      },
      (res) => {
        res.setEncoding('utf8');
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            json: data === '' ? {} : (JSON.parse(data) as Record<string, unknown>),
          }),
        );
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function elevateCookieOf(res: RawRes): string | undefined {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const su = list.find((c) => c.startsWith('syncx_su='));
  return su ? su.slice(0, su.indexOf(';')) : undefined;
}

async function mintElevateCookie(port: number): Promise<string> {
  const res = await reqRaw(port, '/api/elevate', { method: 'POST', token: 'secret', body: { token: 'secret' } });
  expect(res.status).toBe(200);
  const cookie = elevateCookieOf(res);
  expect(cookie).toBeDefined();
  return cookie as string;
}

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

describe('POST /api/folders/pause-file', () => {
  it('folderId/path/paused 严格校验,合法值透传', async () => {
    const calls: Array<[string, string, boolean]> = [];
    const port = await withServer({
      setFolderFilePaused: (folderId, p, paused) => {
        calls.push([folderId, p, paused]);
      },
    });
    expect((await reqRaw(port, '/api/folders/pause-file', { method: 'POST', token: 'secret', body: { path: 'a.txt', paused: true } })).status).toBe(400);
    expect((await reqRaw(port, '/api/folders/pause-file', { method: 'POST', token: 'secret', body: { folderId: 'box', paused: true } })).status).toBe(400);
    expect(
      (
        await reqRaw(port, '/api/folders/pause-file', {
          method: 'POST',
          token: 'secret',
          body: { folderId: 'box', path: 'a.txt', paused: 'yes' },
        })
      ).status,
    ).toBe(400);
    const ok = await reqRaw(port, '/api/folders/pause-file', {
      method: 'POST',
      token: 'secret',
      body: { folderId: 'box', path: 'a.txt', paused: true },
    });
    expect(ok.status).toBe(200);
    expect(calls).toEqual([['box', 'a.txt', true]]);
  });

  it('manager 抛错原样 400 透出', async () => {
    const port = await withServer({
      setFolderFilePaused: () => {
        throw new Error('未找到共享目录:「box」');
      },
    });
    const res = await reqRaw(port, '/api/folders/pause-file', {
      method: 'POST',
      token: 'secret',
      body: { folderId: 'box', path: 'a.txt', paused: true },
    });
    expect(res.status).toBe(400);
    expect(String(res.json.error)).toContain('未找到共享目录');
  });
});

describe('/api/trash* 回收站路由', () => {
  function makeHarness() {
    const listed: string[] = [];
    const restored: Array<[string, string]> = [];
    const purged: Array<[string, string | undefined]> = [];
    const deps = {
      listFolderTrash: (folderId: string) => {
        listed.push(folderId);
        if (folderId === 'boom') throw new Error('回收站目录不可读');
        return [{ file: 'a.txt.m1x2y3z4', path: 'a.txt', ts: 1700000000000, size: 5 }];
      },
      restoreFolderTrash: (folderId: string, file: string) => {
        restored.push([folderId, file]);
        if (file === 'missing') throw new Error('回收站里没有这个副本');
      },
      purgeFolderTrash: (folderId: string, file?: string) => {
        purged.push([folderId, file]);
      },
    };
    return { deps, listed, restored, purged };
  }

  it('deps 未接线:GET /api/trash → 503(不误入文件管理器域的守卫)', async () => {
    const port = await withServer({});
    const res = await reqRaw(port, '/api/trash?folderId=box', { token: 'secret' });
    expect(res.status).toBe(503);
  });

  it('列举仅需登录:200 + entries;缺 folderId 400;不透明错误 400 透出', async () => {
    const h = makeHarness();
    const port = await withServer(h.deps);
    const ok = await reqRaw(port, '/api/trash?folderId=box', { token: 'secret' });
    expect(ok.status).toBe(200);
    expect(ok.json.entries).toEqual([{ file: 'a.txt.m1x2y3z4', path: 'a.txt', ts: 1700000000000, size: 5 }]);
    expect(h.listed).toEqual(['box']);
    expect((await reqRaw(port, '/api/trash', { token: 'secret' })).status).toBe(400);
    const boom = await reqRaw(port, '/api/trash?folderId=boom', { token: 'secret' });
    expect(boom.status).toBe(400);
    expect(String(boom.json.error)).toContain('回收站目录不可读');
  });

  it('还原/彻底删除需提权:无 syncx_su → 403 且处理器不被调用;提权后 200 + 透传', async () => {
    const h = makeHarness();
    const port = await withServer(h.deps);
    // 无提权 cookie:两个变更端点都 403
    expect(
      (await reqRaw(port, '/api/trash/restore', { method: 'POST', token: 'secret', body: { folderId: 'box', file: 'a.txt.m1x2y3z4' } })).status,
    ).toBe(403);
    expect(
      (await reqRaw(port, '/api/trash/purge', { method: 'POST', token: 'secret', body: { folderId: 'box' } })).status,
    ).toBe(403);
    expect(h.restored).toEqual([]);
    expect(h.purged).toEqual([]);

    const su = await mintElevateCookie(port);
    const ok = await reqRaw(port, '/api/trash/restore', {
      method: 'POST',
      token: 'secret',
      cookie: su,
      body: { folderId: 'box', file: 'a.txt.m1x2y3z4' },
    });
    expect(ok.status).toBe(200);
    expect(h.restored).toEqual([['box', 'a.txt.m1x2y3z4']]);

    // file 必填;处理器抛错原样 400
    expect(
      (await reqRaw(port, '/api/trash/restore', { method: 'POST', token: 'secret', cookie: su, body: { folderId: 'box' } })).status,
    ).toBe(400);
    const fail = await reqRaw(port, '/api/trash/restore', {
      method: 'POST',
      token: 'secret',
      cookie: su,
      body: { folderId: 'box', file: 'missing' },
    });
    expect(fail.status).toBe(400);
    expect(String(fail.json.error)).toContain('回收站里没有这个副本');
  });

  it('彻底删除:file 缺省 = 清空(透传 undefined);file 非字符串 400', async () => {
    const h = makeHarness();
    const port = await withServer(h.deps);
    const su = await mintElevateCookie(port);
    const one = await reqRaw(port, '/api/trash/purge', {
      method: 'POST',
      token: 'secret',
      cookie: su,
      body: { folderId: 'box', file: 'a.txt.m1x2y3z4' },
    });
    expect(one.status).toBe(200);
    const all = await reqRaw(port, '/api/trash/purge', { method: 'POST', token: 'secret', cookie: su, body: { folderId: 'box' } });
    expect(all.status).toBe(200);
    expect(h.purged).toEqual([['box', 'a.txt.m1x2y3z4'], ['box', undefined]]);
    expect(
      (await reqRaw(port, '/api/trash/purge', { method: 'POST', token: 'secret', cookie: su, body: { folderId: 'box', file: 42 } })).status,
    ).toBe(400);
  });
});
