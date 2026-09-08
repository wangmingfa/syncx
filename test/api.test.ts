import { describe, expect, it } from 'vitest';
import { request } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createControlServer } from '../src/api.js';

function fetchJson(
  port: number,
  path: string,
  token?: string,
  options: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: data === '' ? undefined : JSON.parse(data),
          });
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('control api', () => {
  it('GET /health needs no auth and only reports ok + uptime', async () => {    const server = createControlServer({ token: 'secret', getStatus: () => ({ ok: true }) });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;

    const res = await fetchJson(port, '/health');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, msg: 'syncx is ok' });
    expect((res.body as { uptime: number }).uptime).toBeGreaterThanOrEqual(0);

    server.close();
  });

  it('POST /api/shutdown requires auth and invokes the shutdown hook', async () => {
    let called = 0;
    const server = createControlServer({
      token: 'secret',
      getStatus: () => ({}),
      shutdown: () => {
        called += 1;
      },
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;

    // 无凭据:必须 401,绝不能让匿名请求关停服务
    const denied = await fetchJson(port, '/api/shutdown', undefined, { method: 'POST' });
    expect(denied.status).toBe(401);
    expect(called).toBe(0);

    // 带正确令牌:200 + 50ms 内回调被触发(路由 setTimeout 50ms 后调用)
    const ok = await fetchJson(port, '/api/shutdown', 'secret', { method: 'POST' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, msg: 'shutting down' });
    await new Promise((r) => setTimeout(r, 100));
    expect(called).toBe(1);

    server.close();
  });

  it('rejects requests without a token', async () => {
    const server = createControlServer({ token: 'secret', getStatus: () => ({ ok: true }) });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;

    const res = await fetchJson(port, '/api/status');

    expect(res.status).toBe(401);

    server.close();
  });

  it('rejects requests with a wrong token', async () => {
    const server = createControlServer({ token: 'secret', getStatus: () => ({ ok: true }) });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;

    const res = await fetchJson(port, '/api/status', 'wrong');

    expect(res.status).toBe(401);

    server.close();
  });

  it('serves the status payload with the correct token', async () => {
    const server = createControlServer({
      token: 'secret',
      getStatus: () => ({ deviceId: 'DEV1234567', folders: 1, entries: 42 }),
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;

    const res = await fetchJson(port, '/api/status', 'secret');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deviceId: 'DEV1234567', folders: 1, entries: 42 });

    server.close();
  });

  it('returns 404 for unknown paths', async () => {
    const server = createControlServer({ token: 'secret', getStatus: () => ({ ok: true }) });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;

    const res = await fetchJson(port, '/api/nope', 'secret');

    expect(res.status).toBe(404);

    server.close();
  });
});

describe('control api folder config', () => {
  it('adds a folder via POST /api/folders with a valid token', async () => {
    const added: Array<{ path: string; devices: string[] }> = [];
    const server = createControlServer({
      token: 'secret',
      getStatus: () => ({ ok: true }),
      addFolder: (path, devices) => {
        added.push({ path, devices });
      },
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;

    const res = await fetchJson(port, '/api/folders', 'secret', {
      method: 'POST',
      body: { path: '/data/docs', devices: ['DEV1234567'] },
    });

    expect(res.status).toBe(201);
    expect(added).toEqual([{ path: '/data/docs', devices: ['DEV1234567'] }]);

    server.close();
  });

  it('hits the folders route when the POST url carries a query string', async () => {
    const added: Array<{ path: string; devices: string[] }> = [];
    const server = createControlServer({
      token: 'secret',
      getStatus: () => ({ ok: true }),
      addFolder: (path, devices) => {
        added.push({ path, devices });
      },
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;

    // 修复前:req.url === '/api/folders' 精确匹配,带查询串的请求落到 404,
    // 与其它路由的 pathname 宽容行为不一致
    const res = await fetchJson(port, '/api/folders?source=web', 'secret', {
      method: 'POST',
      body: { path: '/data/docs', devices: ['DEV1234567'] },
    });

    expect(res.status).toBe(201);
    expect(added).toEqual([{ path: '/data/docs', devices: ['DEV1234567'] }]);

    server.close();
  });

  it('rejects POST /api/folders without a token', async () => {
    const server = createControlServer({
      token: 'secret',
      getStatus: () => ({ ok: true }),
      addFolder: () => {},
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;

    const res = await fetchJson(port, '/api/folders', undefined, {
      method: 'POST',
      body: { path: '/data/docs', devices: [] },
    });

    expect(res.status).toBe(401);

    server.close();
  });

  it('rejects POST /api/folders without a path', async () => {
    const server = createControlServer({
      token: 'secret',
      getStatus: () => ({ ok: true }),
      addFolder: () => {},
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;

    const res = await fetchJson(port, '/api/folders', 'secret', {
      method: 'POST',
      body: { devices: [] },
    });

    expect(res.status).toBe(400);

    server.close();
  });

  it('removes a folder via DELETE /api/folders?path=', async () => {
    const removed: string[] = [];
    const server = createControlServer({
      token: 'secret',
      getStatus: () => ({ ok: true }),
      removeFolder: (path) => {
        removed.push(path);
      },
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;

    const res = await fetchJson(port, '/api/folders?path=%2Fdata%2Fdocs', 'secret', {
      method: 'DELETE',
    });

    expect(res.status).toBe(200);
    expect(removed).toEqual(['/data/docs']);

    server.close();
  });

  it('rejects DELETE /api/folders without a path', async () => {
    const server = createControlServer({
      token: 'secret',
      getStatus: () => ({ ok: true }),
      removeFolder: () => {},
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;

    const res = await fetchJson(port, '/api/folders', 'secret', { method: 'DELETE' });

    expect(res.status).toBe(400);

    server.close();
  });

  it('does not treat /api/foldersX as the folders endpoint', async () => {
    const removed: string[] = [];
    const server = createControlServer({
      token: 'secret',
      getStatus: () => ({ ok: true }),
      removeFolder: (path) => {
        removed.push(path);
      },
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;

    // startsWith 前缀匹配会让 /api/foldersX 也被当成目录接口
    const res = await fetchJson(port, '/api/foldersX?path=%2Fdata%2Fdocs', 'secret', {
      method: 'DELETE',
    });

    expect(res.status).toBe(404);
    expect(removed).toEqual([]);

    server.close();
  });

  it('does not treat /api/reconnectX as the reconnect endpoint', async () => {
    let reconnected: string | undefined;
    const server = createControlServer({
      token: 'secret',
      getStatus: () => ({ ok: true }),
      reconnect: (deviceId) => {
        reconnected = deviceId;
      },
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;

    const res = await fetchJson(port, '/api/reconnectX?deviceId=DEV1234567', 'secret', {
      method: 'POST',
    });

    expect(res.status).toBe(404);
    expect(reconnected).toBeUndefined();

    server.close();
  });
});

describe('control api hardening', () => {
  it('rejects an oversized request body with 413 instead of hanging', async () => {
    const server = createControlServer({
      token: 'secret',
      getStatus: () => ({ ok: true }),
      addFolder: () => {},
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;

    // 约 2MB 的 body,超过 1MB 上限。/folders 表单端点的 readBody 未被内层
    // try/catch 包裹,会走到外层的 413 拒绝,而不是让连接挂起。
    const res = await fetchJson(port, '/folders', 'secret', {
      method: 'POST',
      body: 'x'.repeat(2_000_000),
    });

    expect(res.status).toBe(413);

    server.close();
  });

  it('sets an HttpOnly, Path=/ session cookie on successful login', async () => {
    // 会话 cookie 存的是**签名串**,不再是把 token 原文塞进去:
    // 原文含分号/空格/非 ASCII 时会破坏 cookie 语法(后者还会让 writeHead 抛错)。
    const server = createControlServer({ token: 'secret', getStatus: () => ({ ok: true }) });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;

    const cookies = await new Promise<string[]>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, path: '/login', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
        (res) => {
          resolve((res.headers['set-cookie'] as string[] | undefined) ?? []);
          res.resume();
        },
      );
      req.on('error', reject);
      req.write('token=secret');
      req.end();
    });

    const session = cookies.find((c) => c.startsWith('syncx_session='));
    expect(session).toBeDefined();
    expect(session).toContain('HttpOnly');
    expect(session).toContain('Path=/');
    // 值是 base64url(payload).base64url(签名),不是 token 原文
    const value = (session as string).slice('syncx_session='.length, (session as string).indexOf(';'));
    expect(value).not.toBe('secret');
    expect(value).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    server.close();
  });

  it('rejects unauthenticated requests even when the token is empty (no auth bypass)', async () => {
    // 回归:曾经的 readToken 缺失时按 '' 参与常量时间比较,
    // 与空 token 恒等 → 任何无凭据请求都能通过。现在不予放行。
    const server = createControlServer({ token: '', getStatus: () => ({ ok: true }) });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;

    const noCred = await fetch(`http://127.0.0.1:${port}/api/status`);
    expect(noCred.status).toBe(401);

    // 显式携带空 cookie 也不放行
    const emptyCookie = await fetch(`http://127.0.0.1:${port}/api/status`, {
      headers: { Cookie: 'syncx_session=' },
    });
    expect(emptyCookie.status).toBe(401);

    server.close();
  });
});

describe('control api rescan and reconnect', () => {
  it('triggers rescan via POST /api/rescan', async () => {
    let rescanCalled = false;
    const server = createControlServer({
      token: 'secret',
      getStatus: () => ({ ok: true }),
      rescan: () => {
        rescanCalled = true;
      },
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;

    const res = await fetchJson(port, '/api/rescan', 'secret', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(rescanCalled).toBe(true);

    server.close();
  });

  it('triggers reconnect via POST /api/reconnect?deviceId=', async () => {
    const reconnected: string[] = [];
    const server = createControlServer({
      token: 'secret',
      getStatus: () => ({ ok: true }),
      reconnect: (deviceId) => {
        reconnected.push(deviceId);
      },
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;

    const res = await fetchJson(port, '/api/reconnect?deviceId=PEER234567', 'secret', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(reconnected).toEqual(['PEER234567']);

    server.close();
  });

  it('rejects POST /api/reconnect without deviceId', async () => {
    const server = createControlServer({
      token: 'secret',
      getStatus: () => ({ ok: true }),
      reconnect: () => {},
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;

    const res = await fetchJson(port, '/api/reconnect', 'secret', { method: 'POST' });

    expect(res.status).toBe(400);

    server.close();
  });

  it('triggers rescan via POST /actions form', async () => {
    let rescanCalled = false;
    const server = createControlServer({
      token: 'secret',
      getStatus: () => ({ ok: true }),
      rescan: () => {
        rescanCalled = true;
      },
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;

    await new Promise<void>((resolve, reject) => {
      const body = 'action=rescan';
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path: '/actions',
          method: 'POST',
          headers: {
            Authorization: `Bearer secret`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          expect(res.statusCode).toBe(302);
          res.resume();
          resolve();
        },
      );
      req.on('error', reject);
      req.end(body);
    });

    expect(rescanCalled).toBe(true);

    expect(rescanCalled).toBe(true);

    server.close();
  });

  it('triggers reconnect via POST /actions form', async () => {
    const reconnected: string[] = [];
    const server = createControlServer({
      token: 'secret',
      getStatus: () => ({ ok: true }),
      reconnect: (deviceId) => {
        reconnected.push(deviceId);
      },
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;

    await new Promise<void>((resolve, reject) => {
      const body = 'action=reconnect&deviceId=PEER234567';
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path: '/actions',
          method: 'POST',
          headers: {
            Authorization: `Bearer secret`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          expect(res.statusCode).toBe(302);
          res.resume();
          resolve();
        },
      );
      req.on('error', reject);
      req.end(body);
    });

    expect(reconnected).toEqual(['PEER234567']);

    server.close();
  });
});

describe('routes tolerate query strings', () => {
  it('GET /api/status with a query string returns status', async () => {
    const server = createControlServer({
      token: 'secret',
      getStatus: () => ({ ok: true, folders: 1 }),
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;

    // Web UI 轮询常带缓存破坏参数(如 ?t=timestamp),修复前精确匹配返回 404
    const res = await fetchJson(port, '/api/status?t=123456', 'secret');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, folders: 1 });

    server.close();
  });

  it('POST /api/rescan with a query string triggers rescan', async () => {
    let rescanCalled = false;
    const server = createControlServer({
      token: 'secret',
      getStatus: () => ({ ok: true }),
      rescan: () => {
        rescanCalled = true;
      },
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;

    const res = await fetchJson(port, '/api/rescan?x=1', 'secret', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(rescanCalled).toBe(true);

    server.close();
  });

  it('POST /actions with a query string triggers rescan (form)', async () => {
    let rescanCalled = false;
    const server = createControlServer({
      token: 'secret',
      getStatus: () => ({ ok: true }),
      rescan: () => {
        rescanCalled = true;
      },
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;

    await new Promise<void>((resolve, reject) => {
      const body = 'action=rescan';
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path: '/actions?source=web',
          method: 'POST',
          headers: {
            Authorization: 'Bearer secret',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          expect(res.statusCode).toBe(302);
          res.resume();
          resolve();
        },
      );
      req.on('error', reject);
      req.end(body);
    });

    expect(rescanCalled).toBe(true);

    server.close();
  });

  it('POST /folders with a query string adds a folder (form)', async () => {
    const added: Array<{ path: string; devices: string[] }> = [];
    const server = createControlServer({
      token: 'secret',
      getStatus: () => ({ ok: true }),
      addFolder: (path, devices) => {
        added.push({ path, devices });
      },
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;

    await new Promise<void>((resolve, reject) => {
      const body = 'path=/data/docs&devices=DEV1234567';
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path: '/folders?source=web',
          method: 'POST',
          headers: {
            Authorization: 'Bearer secret',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          expect(res.statusCode).toBe(302);
          res.resume();
          resolve();
        },
      );
      req.on('error', reject);
      req.end(body);
    });

    expect(added).toEqual([{ path: '/data/docs', devices: ['DEV1234567'] }]);

    server.close();
  });
});
