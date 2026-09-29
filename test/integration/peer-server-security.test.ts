import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { rmDir } from '../helpers.js';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { loadOrCreateIdentity } from '../../src/identity.js';
import { startPeerServer } from '../../src/net/server.js';
import { startLoopbackPeerServer } from './ports.js';

function openRaw(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

/** 等待连接在超时前被服务端关闭(close 或 error 均可视为被断)。 */
function expectClosed(ws: WebSocket, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (): void => resolve(true);
    ws.on('close', done);
    ws.on('error', done);
    setTimeout(() => resolve(false), timeoutMs);
  });
}

describe('peer WebSocket server hardening', () => {
  it('terminates connections beyond the concurrent limit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-sec-'));
    const identity = loadOrCreateIdentity(dir);
    // 端口由系统分配并独占绑在 127.0.0.1 上(见 ports.ts 的说明)
    const server = await startLoopbackPeerServer(identity, { onPeerConnected() {}, onError() {} }, {
      maxConnections: 1,
    });
    try {
      const first = await openRaw(server.port);
      const second = new WebSocket(`ws://127.0.0.1:${server.port}`);
      const dropped = await expectClosed(second, 1000);
      // 第二个连接占满唯一名额,应被直接断开
      expect(dropped).toBe(true);
      first.close();
    } finally {
      server.close();
      rmDir(dir);
    }
  });

  it('terminates a connection that never completes the handshake', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-sec-'));
    const identity = loadOrCreateIdentity(dir);
    const server = await startLoopbackPeerServer(identity, { onPeerConnected() {}, onError() {} }, {
      handshakeTimeoutMs: 150,
    });
    try {
      const ws = await openRaw(server.port);
      // 连上后不发公钥,握手超时后服务端应主动断开
      const terminated = await expectClosed(ws, 1200);
      expect(terminated).toBe(true);
    } finally {
      server.close();
      rmDir(dir);
    }
  });

  it('closes the socket when a single message exceeds the payload limit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-sec-'));
    const identity = loadOrCreateIdentity(dir);
    // 用小上限便于确定性测试,默认仍是 MAX_MESSAGE_BYTES
    const server = await startLoopbackPeerServer(identity, { onPeerConnected() {}, onError() {} }, {
      maxPayloadBytes: 32,
    });
    try {
      const ws = await openRaw(server.port);
      // 连上后发送超出上限(32 字节)的消息,服务端应主动断开
      ws.send('x'.repeat(100));
      const dropped = await expectClosed(ws, 1200);
      expect(dropped).toBe(true);
    } finally {
      server.close();
      rmDir(dir);
    }
  });

  /**
   * 锁死「偶发 Unexpected server response: 404」回归(2026-09-29)。
   *
   * 症状:集成测试里 connectPeer 拨 `ws://127.0.0.1:P`,拿到的不是升级应答而是一个
   * 普通 HTTP 404 —— 也就是这条连接**根本没接到 peer server**。
   *
   * 根因在地址族:`startPeerServer` 不传 host 时,ws 内部把 http server 绑到 `::`
   * (双栈)。实测(macOS/BSD)内核给 `listen(0)` 挑端口时确实会避开**已被 v4 占用**
   * 的端口(200 次抽样零碰撞),但 `::` 这个绑定**不保留 v4 侧**:之后任何人显式绑
   * `127.0.0.1:P` 都能成功,并且比 `::` 更具体 —— 环回流量从此改道给它。测试之间端口
   * 彼此不保留,谁晚绑谁抢走前者,于是同一端口上出现两个「房东」,晚到的那个用 404
   * 回答升级请求。
   *
   * 修复形状:peer server 复用调用方传入的、已独占绑在 127.0.0.1 上的 http server
   * (见 ports.ts 的 startLoopbackPeerServer)。本用例把「独占」这件事本身钉住:
   * 断言①是抢端口这条路径的守门人 —— 老写法在这里会**绑定成功**(而不是 EADDRINUSE),
   * 那正是 bug;断言②是症状本身 —— 升级请求必须真到达 peer server。
   */
  it('owns the loopback port exclusively, so a later bind cannot steal the connection', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-sec-'));
    const identity = loadOrCreateIdentity(dir);
    const server = await startLoopbackPeerServer(identity, { onPeerConnected() {}, onError() {} });
    const squatter = createServer();
    try {
      // ① 同一端口再绑一次 127.0.0.1 必须失败
      let errno: string | undefined;
      await new Promise<void>((resolve) => {
        squatter.once('error', (e) => {
          errno = (e as NodeJS.ErrnoException).code;
          resolve();
        });
        squatter.listen(server.port, '127.0.0.1', () => resolve());
      });
      expect(errno).toBe('EADDRINUSE');

      // ② 升级请求由 peer server 亲自应答(被抢时这里是 404)
      const ws = await openRaw(server.port);
      ws.close();
    } finally {
      squatter.close(); // 绑定没成功时它是空操作,不需要条件判断
      server.close();
      rmDir(dir);
    }
  });

  it('fails with a clear error when the peer port is already in use', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-sec-'));
    const identity = loadOrCreateIdentity(dir);
    // 先占住一个端口;用默认地址(与 startPeerServer 一致)才能可靠触发冲突。
    // 若显式绑 127.0.0.1,macOS 双栈下新 server 绑 :: 不与之冲突,测试会假阴性。
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, () => r()));
    const port = (blocker.address() as { port: number }).port;

    let syncError: Error | undefined;
    let asyncError: string | undefined;
    try {
      startPeerServer(
        identity,
        {
          onPeerConnected() {},
          onError: (e) => {
            asyncError = e.message;
          },
        },
        port,
      );
    } catch (e) {
      syncError = e as Error;
    }
    // 端口占用错误要么经 wss.address()===null 同步抛出清晰错误,
    // 要么以异步 'error' 事件经 onError 上报,二者任一都算正确兜底。
    if (syncError) {
      expect(syncError.message).toMatch(/not available|EADDRINUSE|in use/i);
    } else {
      await new Promise((r) => setTimeout(r, 100));
      expect(asyncError).toMatch(/EADDRINUSE|address already in use/i);
    }

    blocker.close();
    rmDir(dir);
  });
});
