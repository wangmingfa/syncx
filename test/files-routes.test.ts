import { describe, expect, it } from 'vitest';
import { request } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createControlServer } from '../src/api.js';
import { PathUnsafeError } from '../src/filebrowser.js';

/**
 * 文件管理器域的分档鉴权(与 web/FileManagerPage.vue 对应):
 * - 列举 / 下载:只读,登录会话(Bearer 或 cookie)即可,无需提权 cookie;
 * - 删除:变更操作,登录之外必须有有效提权 cookie(syncx_su),否则 403;
 *   提权 cookie 不能单独冒充登录凭据(无会话时先撞 401);
 * - 提权放行(及携带有效提权 cookie 的任意放行请求)顺手续期(滑动),
 *   续期频率逻辑与拆分前一致 —— 未提权的浏览绝不该下发 syncx_su。
 */

interface RawRes {
  status: number;
  headers: NodeJS.Dict<string | string[]>;
  text: string;
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
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text: data }),
        );
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** 从 Set-Cookie 头里抽出 syncx_su 提权 cookie 的「name=value」段。 */
function elevateCookieOf(res: RawRes): string | undefined {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const su = list.find((c) => c.startsWith('syncx_su='));
  return su ? su.slice(0, su.indexOf(';')) : undefined;
}

/** POST /api/elevate 用控制令牌换一枚提权 cookie。 */
async function mintElevateCookie(port: number): Promise<string> {
  const res = await reqRaw(port, '/api/elevate', {
    method: 'POST',
    token: 'secret',
    body: { token: 'secret' },
  });
  expect(res.status).toBe(200);
  const cookie = elevateCookieOf(res);
  expect(cookie).toBeDefined();
  return cookie as string;
}

/** 一套最小文件域 deps:记录调用,列举/解析/删除都走内存假象 + 一个真实临时文件。 */
function makeHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'syncx-files-route-'));
  const realFile = join(dir, 'a.txt');
  writeFileSync(realFile, 'hello');

  const deleted: Array<[string, string]> = [];
  let listCalls = 0;

  const server = createControlServer({
    token: 'secret',
    getStatus: () => ({}),
    listFolderDirectory: (folderId, relPath) => {
      listCalls += 1;
      if (!folderId) throw new Error('folderId required');
      return {
        entries: [
          { path: 'a.txt', name: 'a.txt', dir: false, size: 5, mtime: 1 },
          { path: 'sub', name: 'sub', dir: true, size: 0, mtime: 2 },
        ],
        truncated: false,
        relPath,
      };
    },
    resolveFolderFile: (_folderId, relPath) => {
      if (relPath.includes('..')) throw new PathUnsafeError('路径越界');
      if (relPath !== 'a.txt') throw new Error('文件不存在');
      return realFile;
    },
    deleteFolderEntry: (folderId, relPath) => {
      deleted.push([folderId, relPath]);
    },
  });

  return {
    server,
    deleted,
    get listCalls() {
      return listCalls;
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function listen(server: ReturnType<typeof createControlServer>): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

describe('文件管理器域鉴权分档', () => {
  it('列举只需登录:无提权 cookie 也 200,且不下发 syncx_su(浏览不给提权续命)', async () => {
    const h = makeHarness();
    const port = await listen(h.server);

    const res = await reqRaw(port, '/api/folder-files?folderId=f1&path=', { token: 'secret' });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toMatchObject({ truncated: false });
    expect(elevateCookieOf(res)).toBeUndefined();

    h.server.close();
    h.cleanup();
  });

  it('下载只需登录:流式回真实文件内容', async () => {
    const h = makeHarness();
    const port = await listen(h.server);

    const res = await reqRaw(port, '/api/folder-files/download?folderId=f1&path=a.txt', {
      token: 'secret',
    });
    expect(res.status).toBe(200);
    expect(res.text).toBe('hello');
    expect(String(res.headers['content-disposition'])).toContain('attachment');

    h.server.close();
    h.cleanup();
  });

  it('删除需提权:仅登录(无 syncx_su)→ 403,删除绝不落地', async () => {
    const h = makeHarness();
    const port = await listen(h.server);

    const res = await reqRaw(port, '/api/folder-files?folderId=f1&path=a.txt', {
      method: 'DELETE',
      token: 'secret',
    });
    expect(res.status).toBe(403);
    expect(h.deleted).toEqual([]);

    h.server.close();
    h.cleanup();
  });

  it('提权后删除 200 且顺手续期(响应携带新的 syncx_su Set-Cookie)', async () => {
    const h = makeHarness();
    const port = await listen(h.server);
    const su = await mintElevateCookie(port);

    const res = await reqRaw(port, '/api/folder-files?folderId=f1&path=a.txt', {
      method: 'DELETE',
      token: 'secret',
      cookie: su,
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({ ok: true });
    expect(h.deleted).toEqual([['f1', 'a.txt']]);
    // 滑动续期:提权请求的响应必须重新下发提权 cookie
    expect(elevateCookieOf(res)).toBeDefined();

    h.server.close();
    h.cleanup();
  });

  it('提权 cookie 不能冒充登录:只有 syncx_su 无任何登录凭据 → 401', async () => {
    const h = makeHarness();
    const port = await listen(h.server);
    const su = await mintElevateCookie(port);

    const del = await reqRaw(port, '/api/folder-files?folderId=f1&path=a.txt', {
      method: 'DELETE',
      cookie: su,
    });
    expect(del.status).toBe(401);
    const list = await reqRaw(port, '/api/folder-files?folderId=f1', { cookie: su });
    expect(list.status).toBe(401);
    expect(h.deleted).toEqual([]);

    h.server.close();
    h.cleanup();
  });

  it('完全匿名(无令牌无 cookie):三个端点一律 401', async () => {
    const h = makeHarness();
    const port = await listen(h.server);

    expect((await reqRaw(port, '/api/folder-files?folderId=f1')).status).toBe(401);
    expect((await reqRaw(port, '/api/folder-files/download?folderId=f1&path=a.txt')).status).toBe(401);
    expect(
      (await reqRaw(port, '/api/folder-files?folderId=f1&path=a.txt', { method: 'DELETE' })).status,
    ).toBe(401);

    h.server.close();
    h.cleanup();
  });

  it('参数校验保持:缺 folderId 400、删根 400、路径越界 400', async () => {
    const h = makeHarness();
    const port = await listen(h.server);
    const su = await mintElevateCookie(port);

    const noFolder = await reqRaw(port, '/api/folder-files?path=a.txt', { token: 'secret' });
    expect(noFolder.status).toBe(400);

    const rootDelete = await reqRaw(port, '/api/folder-files?folderId=f1&path=', {
      method: 'DELETE',
      token: 'secret',
      cookie: su,
    });
    expect(rootDelete.status).toBe(400);
    expect(JSON.parse(rootDelete.text).error).toContain('不能删除共享目录本身');

    const unsafe = await reqRaw(port, '/api/folder-files/download?folderId=f1&path=..%2Fsecret', {
      token: 'secret',
    });
    expect(unsafe.status).toBe(400);

    h.server.close();
    h.cleanup();
  });
});

describe('/files 页面壳与路由回退', () => {
  it('GET /files 免认证回页面壳(可刷新/分享);未知路径仍 404', async () => {
    const server = createControlServer({ token: 'secret', getStatus: () => ({}) });
    const port = await listen(server);

    const shell = await reqRaw(port, '/files');
    expect(shell.status).toBe(200);
    expect(shell.text).toContain('/client.js');

    const withQuery = await reqRaw(port, '/files?folder=f1');
    expect(withQuery.status).toBe(200);

    const unknown = await reqRaw(port, '/nope', { token: 'secret' });
    expect(unknown.status).toBe(404);

    server.close();
  });
});
