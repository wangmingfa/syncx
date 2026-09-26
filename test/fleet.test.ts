import { createServer, type Server } from 'node:http';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createControlServer } from '../src/api.js';

/**
 * fleet 代理路由(POST /api/fleet/call)的测试:
 * 校验白名单/入参、真实转发、非 JSON/不可达的降级,以及「令牌只进不出」。
 */

const openServers: Server[] = [];

afterEach(() => {
  for (const s of openServers) s.close();
  openServers.length = 0;
});

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  openServers.push(server);
  return (server.address() as AddressInfo).port;
}

/** 本机 daemon(认证 + 挂进 fleet 路由链)。 */
async function withLocal(): Promise<number> {
  return listen(
    createControlServer({
      token: 'secret',
      getStatus: () => ({}),
    } as Parameters<typeof createControlServer>[0]),
  );
}

/** 任意 stub 远端:handler 决定响应,records 捕获请求。 */
async function withStub(
  handler: (req: { method: string; url: string; auth: string | undefined; body: string }, res: { writeHead(status: number, headers?: Record<string, string>): void; end(data?: string): void }) => void,
): Promise<{ port: number; seen: () => { method: string; url: string; auth: string | undefined; body: string } }> {
  let last = { method: '', url: '', auth: undefined as string | undefined, body: '' };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += String(c)));
    req.on('end', () => {
      last = { method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization, body };
      handler(last, res);
    });
  });
  const port = await listen(server);
  return { port, seen: () => last };
}

function callFleet(port: number, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/fleet/call',
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

describe('fleet 代理入参校验', () => {
  it('GET 不命中路由,落到 404', async () => {
    const port = await withLocal();
    const res = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, path: '/api/fleet/call', method: 'GET', headers: { Authorization: 'Bearer secret' } },
        (r) => {
          let d = '';
          r.on('data', (c) => (d += c));
          r.on('end', () => resolve({ status: r.statusCode ?? 0, text: d }));
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(res.status).toBe(404);
  });

  it('url/token/path 非法分别 400', async () => {
    const port = await withLocal();
    expect((await callFleet(port, { token: 't', path: '/api/status' })).status).toBe(400);
    expect((await callFleet(port, { url: 'http://127.0.0.1:1', path: '/api/status' })).status).toBe(400);
    expect((await callFleet(port, { url: 'http://127.0.0.1:1', token: '', path: '/api/status' })).status).toBe(400);
    expect((await callFleet(port, { url: 'http://127.0.0.1:1', token: 'x'.repeat(513), path: '/api/status' })).status).toBe(400);
    expect((await callFleet(port, { url: 'http://127.0.0.1:1', token: 't', path: '/api/files' })).status).toBe(400);
  });

  it('url 带路径 / 非 http(s) scheme 拒绝', async () => {
    const port = await withLocal();
    expect((await callFleet(port, { url: 'http://127.0.0.1:8384/api/status', token: 't', path: '/api/status' })).status).toBe(400);
    expect((await callFleet(port, { url: 'ftp://127.0.0.1:8384', token: 't', path: '/api/status' })).status).toBe(400);
    expect((await callFleet(port, { url: 'not a url', token: 't', path: '/api/status' })).status).toBe(400);
  });
});

describe('fleet 代理转发', () => {
  it('GET /api/status 成功:原样回传 status + data,且不回显令牌', async () => {
    const remote = await withStub((seen, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ deviceId: 'REMOTE1', folders: [] }));
      void seen;
    });
    const port = await withLocal();
    const res = await callFleet(port, {
      url: `http://127.0.0.1:${remote.port}`,
      token: 'remote-secret',
      path: '/api/status',
    });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, status: 200, data: { deviceId: 'REMOTE1', folders: [] } });
    expect(JSON.stringify(res.json)).not.toContain('remote-secret');
    expect(remote.seen().auth).toBe('Bearer remote-secret');
    expect(remote.seen().method).toBe('GET');
  });

  it('POST 白名单带 body:方法与 JSON 请求体透传', async () => {
    const remote = await withStub((_seen, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ paused: true }));
    });
    const port = await withLocal();
    const res = await callFleet(port, {
      url: `http://127.0.0.1:${remote.port}`,
      token: 'rt',
      path: '/api/pause',
      body: { paused: true },
    });
    expect(res.json).toEqual({ ok: true, status: 200, data: { paused: true } });
    expect(remote.seen().method).toBe('POST');
    expect(remote.seen().body).toBe('{"paused":true}');
  });

  it('远端 4xx 状态原样透出(交给页面映射错误)', async () => {
    const remote = await withStub((_seen, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
    });
    const port = await withLocal();
    const res = await callFleet(port, {
      url: `http://127.0.0.1:${remote.port}`,
      token: 'wrong',
      path: '/api/status',
    });
    expect(res.json).toEqual({ ok: true, status: 401, data: { error: 'unauthorized' } });
  });

  it('端口无人监听:ok:false + 无法连接', async () => {
    const port = await withLocal();
    const res = await callFleet(port, { url: 'http://127.0.0.1:1', token: 't', path: '/api/status' });
    expect(res.json.ok).toBe(false);
    expect(String(res.json.error)).toContain('无法连接远端');
  });

  it('远端响应非 JSON:错误里带状态与前 200 字', async () => {
    const remote = await withStub((_seen, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html>not the api</html>');
    });
    const port = await withLocal();
    const res = await callFleet(port, {
      url: `http://127.0.0.1:${remote.port}`,
      token: 't',
      path: '/api/status',
    });
    expect(res.json.ok).toBe(false);
    expect(res.json.status).toBe(200);
    expect(String(res.json.error)).toContain('远端响应不是 JSON');
  });
});
