import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { loadOrCreateIdentity } from '../../src/identity.js';
import { startPeerServer } from '../../src/net/server.js';

function freePort(): number {
  return 24000 + Math.floor(Math.random() * 10000);
}

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
    const port = freePort();
    const server = startPeerServer(
      identity,
      { onPeerConnected() {}, onError() {} },
      port,
      { maxConnections: 1 },
    );
    try {
      const first = await openRaw(port);
      const second = new WebSocket(`ws://127.0.0.1:${port}`);
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
    const port = freePort();
    const server = startPeerServer(
      identity,
      { onPeerConnected() {}, onError() {} },
      port,
      { handshakeTimeoutMs: 150 },
    );
    try {
      const ws = await openRaw(port);
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
    const port = freePort();
    // 用小上限便于确定性测试,默认仍是 MAX_MESSAGE_BYTES
    const server = startPeerServer(
      identity,
      { onPeerConnected() {}, onError() {} },
      port,
      { maxPayloadBytes: 32 },
    );
    try {
      const ws = await openRaw(port);
      // 连上后发送超出上限(32 字节)的消息,服务端应主动断开
      ws.send('x'.repeat(100));
      const dropped = await expectClosed(ws, 1200);
      expect(dropped).toBe(true);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
