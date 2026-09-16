import { describe, expect, it } from 'vitest';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { createControlServer } from '../src/api.js';
import { createStatusHub } from '../src/status-hub.js';
import { sessionSecret, signSession, SESSION_TTL_MS } from '../src/auth.js';
import { COOKIE_NAME } from '../src/api/helpers.js';

/**
 * WS /api/events 的握手层:浏览器无法给 WebSocket 设置请求头,真实 Web UI 只能靠
 * 同源 cookie 通过鉴权 —— 这里把两条凭据路径都覆盖住,并确认未授权时握手被拒。
 */
async function startServer(status: unknown = { deviceId: 'DEV-A' }, token = 'secret') {
  const hub = createStatusHub({ getStatus: () => status });
  const server = createControlServer({ token, getStatus: () => status, statusHub: hub });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    hub,
    close: () => {
      hub.close();
      server.close();
    },
  };
}

function wsUrl(port: number): string {
  return `ws://127.0.0.1:${port}/api/events`;
}

/** 取第一帧 status 消息(握手后服务端会立即下发一帧全量)。 */
function firstStatus(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no status frame within 3s')), 3000);
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString('utf8')) as { type?: string; status?: unknown };
      if (message.type !== 'status') return;
      clearTimeout(timer);
      resolve(message.status);
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/**
 * 建立连接并取回首帧。监听必须在 'open' 之前挂上 —— 服务端在握手完成的那一刻就发帧,
 * 若等 'open' 之后再挂,那一帧会先于监听器到达而被丢掉(表现为「连上了却没有数据」)。
 */
async function connectAndReceive(port: number, headers: Record<string, string>): Promise<unknown> {
  const socket = new WebSocket(wsUrl(port), { headers });
  const frame = firstStatus(socket);
  await once(socket, 'open');
  const status = await frame;
  socket.close();
  return status;
}

describe('status events websocket', () => {
  it('accepts a browser-style session cookie and pushes a frame right away', async () => {
    const { port, close } = await startServer({ deviceId: 'DEV-A', entries: 7 });
    const cookie = signSession(
      { via: 'token', sub: 'token', exp: Date.now() + SESSION_TTL_MS },
      sessionSecret('secret'),
    );

    const status = await connectAndReceive(port, { cookie: `${COOKIE_NAME}=${cookie}` });

    expect(status).toEqual({ deviceId: 'DEV-A', entries: 7 });
    close();
  });

  it('accepts a bearer token for non-browser clients', async () => {
    const { port, close } = await startServer({ deviceId: 'DEV-B' });

    const status = await connectAndReceive(port, { authorization: 'Bearer secret' });

    expect(status).toEqual({ deviceId: 'DEV-B' });
    close();
  });

  it('rejects the handshake when credentials are missing or wrong', async () => {
    const { port, close } = await startServer();

    const status = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(wsUrl(port), { headers: { authorization: 'Bearer wrong' } });
      socket.on('unexpected-response', (_req, res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      socket.on('open', () => reject(new Error('handshake should not succeed')));
      socket.on('error', (error) => reject(error));
    });

    expect(status).toBe(401);
    close();
  });

  it('refuses upgrades to other paths', async () => {
    const { port, close } = await startServer();

    const outcome = await new Promise<string>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/api/status`, {
        headers: { authorization: 'Bearer secret' },
      });
      socket.on('open', () => resolve('opened'));
      socket.on('error', () => resolve('rejected'));
    });

    expect(outcome).toBe('rejected');
    close();
  });

  it('acknowledges through the hub so shutdown closes the channel', async () => {
    const { port, hub, close } = await startServer({ deviceId: 'DEV-A' });
    const socket = new WebSocket(wsUrl(port), { headers: { authorization: 'Bearer secret' } });
    const frame = firstStatus(socket);
    await once(socket, 'open');
    await frame;
    expect(hub.clientCount()).toBe(1);

    const closed = once(socket, 'close');
    hub.close();
    await closed;

    expect(hub.clientCount()).toBe(0);
    close();
  });
});
