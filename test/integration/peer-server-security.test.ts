import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { loadOrCreateIdentity } from '../../src/identity.js';
import { startPeerServer } from '../../src/net/server.js';

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
    // 端口 0 由系统分配,避免并行测试文件的随机端口区间互相碰撞
    const server = startPeerServer(
      identity,
      { onPeerConnected() {}, onError() {} },
      0,
      { maxConnections: 1 },
    );
    try {
      const first = await openRaw(server.port);
      const second = new WebSocket(`ws://127.0.0.1:${server.port}`);
      const dropped = await expectClosed(second, 1000);
      // 第二个连接占满唯一名额,应被直接断开
      expect(dropped).toBe(true);
      first.close();
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('terminates a connection that never completes the handshake', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-sec-'));
    const identity = loadOrCreateIdentity(dir);
    const server = startPeerServer(
      identity,
      { onPeerConnected() {}, onError() {} },
      0,
      { handshakeTimeoutMs: 150 },
    );
    try {
      const ws = await openRaw(server.port);
      // 连上后不发公钥,握手超时后服务端应主动断开
      const terminated = await expectClosed(ws, 1200);
      expect(terminated).toBe(true);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('closes the socket when a single message exceeds the payload limit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-sec-'));
    const identity = loadOrCreateIdentity(dir);
    // 用小上限便于确定性测试,默认仍是 MAX_MESSAGE_BYTES;端口 0 由系统分配
    const server = startPeerServer(
      identity,
      { onPeerConnected() {}, onError() {} },
      0,
      { maxPayloadBytes: 32 },
    );
    try {
      const ws = await openRaw(server.port);
      // 连上后发送超出上限(32 字节)的消息,服务端应主动断开
      ws.send('x'.repeat(100));
      const dropped = await expectClosed(ws, 1200);
      expect(dropped).toBe(true);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
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
    rmSync(dir, { recursive: true, force: true });
  });
});
