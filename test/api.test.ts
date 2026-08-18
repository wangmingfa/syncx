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
