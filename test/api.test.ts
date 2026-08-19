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
    const server = createControlServer({ token: 'secret', getStatus: () => ({ ok: true }) });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;

    const cookies = await new Promise<string[]>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path: '/login',
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        },
        (res) => {
          resolve((res.headers['set-cookie'] as string[] | undefined) ?? []);
          res.resume();
        },
      );
      req.on('error', reject);
      req.write('token=secret');
      req.end();
    });

    expect(
      cookies.some(
        (c) => c.includes('syncx_session=secret') && c.includes('HttpOnly') && c.includes('Path=/'),
      ),
    ).toBe(true);

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
