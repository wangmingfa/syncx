import { describe, expect, it } from 'vitest';
import { request } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createControlServer } from '../src/api.js';

function fetchJson(port: number, path: string, token?: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
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
