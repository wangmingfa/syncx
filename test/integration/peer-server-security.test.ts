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
    // 先占住一个端口
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
    const port = (blocker.address() as { port: number }).port;

    let onErrorMessage: string | undefined;
    // 修复前:同步阶段抛 "Cannot read properties of null (reading 'port')" ——
    // 误导性的 TypeError,无法定位是端口被占用
    expect(() =>
      startPeerServer(
        identity,
        {
          onPeerConnected() {},
          onError: (e) => {
            onErrorMessage = e.message;
          },
        },
        port,
      ),
    ).toThrow(/in use|not available|EADDRINUSE/i);

    // 异步的 EADDRINUSE 事件仍应到达 onError(不能被吞掉导致未处理错误)
    await new Promise((r) => setTimeout(r, 50));
    expect(onErrorMessage).toMatch(/EADDRINUSE|address already in use/i);

    blocker.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
