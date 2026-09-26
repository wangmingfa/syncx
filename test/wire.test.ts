import { describe, expect, it, vi } from 'vitest';
import {
  encryptMessage,
  decryptMessage,
  makePeerTransport,
  type WireMessage,
} from '../src/net/wire.js';
import { RateLimiter } from '../src/ratelimit.js';
import type { BlockResponse } from '../src/messages.js';
import type { WebSocket } from 'ws';

const key = Buffer.from('0123456789abcdef0123456789abcdef'); // 32 字节 AES-256

describe('wire message encryption', () => {
  it('round-trips an index message', () => {
    const msg: WireMessage = { type: 'index', folder: 'main', payload: 'aGk=' };
    expect(decryptMessage(key, encryptMessage(key, msg))).toEqual(msg);
  });

  it('round-trips block-request and block-response messages', () => {
    const req: WireMessage = {
      type: 'block-request',
      folder: 'main',
      payload: { deviceId: 'DEV-A', path: 'a.txt', blockIndex: 0, hash: 'h1' },
    };
    expect(decryptMessage(key, encryptMessage(key, req))).toEqual(req);

    const resp: WireMessage = {
      type: 'block-response',
      folder: 'main',
      payload: {
        deviceId: 'DEV-A',
        path: 'a.txt',
        blockIndex: 0,
        hash: 'h1',
        data: 'aGVsbG8=',
      },
    };
    expect(decryptMessage(key, encryptMessage(key, resp))).toEqual(resp);
  });

  it('produces distinct ciphertexts for the same plaintext (random iv)', () => {
    const msg: WireMessage = { type: 'index', folder: 'main', payload: 'aGk=' };
    expect(encryptMessage(key, msg)).not.toBe(encryptMessage(key, msg));
  });

  it('fails to decrypt with the wrong key', () => {
    const other = Buffer.from('fedcba9876543210fedcba9876543210');
    const cipher = encryptMessage(key, { type: 'index', folder: 'main', payload: 'aGk=' });
    expect(() => decryptMessage(other, cipher)).toThrow();
  });

  it('rejects unencrypted (plaintext) wire input', () => {
    expect(() => decryptMessage(key, '{"type":"index","folder":"main","payload":"aGk="}')).toThrow(
      'expected encrypted',
    );
  });
});

describe('priority outbox (makePeerTransport)', () => {
  it('jumps a priority block response ahead of the normal queue behind the rate limit', async () => {
    const sent: string[] = [];
    const socket = { send: (data: string) => sent.push(data) } as unknown as WebSocket;
    // 故意收紧限速(1 KB/s,桶 = 1 秒容量):前几条消息即耗尽令牌,其余排队等桶
    // —— 这正是插队要发挥作用的窗口
    const transport = makePeerTransport(socket, key, 'main', new RateLimiter(1));

    vi.useFakeTimers();
    try {
      for (let i = 0; i < 12; i++) {
        transport.sendBlockRequest({ deviceId: 'DEV-A', path: `p${i}`, blockIndex: 0, hash: 'h' });
      }
      // 最后入队却插到队首:应越过排在前面的普通消息发出(带一个混进来的 priority
      // 字段:它只是本端排队决策,不得上线)
      transport.sendBlockResponse(
        {
          deviceId: 'DEV-A',
          path: 'urgent',
          blockIndex: 0,
          hash: 'h',
          data: Buffer.from('xx'),
          priority: true,
        } as BlockResponse & { priority?: boolean },
        { priority: true },
      );
      await vi.advanceTimersByTimeAsync(60_000);
    } finally {
      vi.useRealTimers();
    }

    expect(sent).toHaveLength(13);
    const kinds = sent.map((raw) => (decryptMessage(key, raw).type === 'block-response' ? 'u' : 'r'));
    const u = kinds.indexOf('u');
    expect(u).toBeGreaterThan(0); // 是排队等过限速的,不是同步直发
    expect(u).toBeLessThan(12); // 插到了至少一条已在队列里的普通块请求之前

    const resp = decryptMessage(key, sent[u]!);
    if (resp.type !== 'block-response') throw new Error('expected block-response');
    expect('priority' in resp.payload).toBe(false);
    expect(resp.payload.path).toBe('urgent');
  });

  it('sends everything in FIFO order when nothing is flagged priority', async () => {
    const sent: string[] = [];
    const socket = { send: (data: string) => sent.push(data) } as unknown as WebSocket;
    const transport = makePeerTransport(socket, key, 'main', new RateLimiter(1));

    vi.useFakeTimers();
    try {
      for (let i = 0; i < 6; i++) {
        transport.sendBlockRequest({ deviceId: 'DEV-A', path: `p${i}`, blockIndex: 0, hash: 'h' });
      }
      await vi.advanceTimersByTimeAsync(60_000);
    } finally {
      vi.useRealTimers();
    }

    expect(sent).toHaveLength(6);
    const paths = sent.map((raw) => {
      const m = decryptMessage(key, raw);
      if (m.type !== 'block-request') throw new Error('expected block-request');
      return m.payload.path;
    });
    expect(paths).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5']);
  });
});
