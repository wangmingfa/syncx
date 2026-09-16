import { describe, expect, it, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { createStatusHub } from '../src/status-hub.js';

/**
 * 假 socket:只实现 hub 用到的 send/close 与事件订阅。
 * hub 把从它这里发出的每一帧都记下来,便于断言「推了什么、推了几次」。
 */
class FakeSocket extends EventEmitter {
  readonly frames: string[] = [];
  closed = false;

  send(data: string): void {
    this.frames.push(data);
  }

  close(): void {
    this.closed = true;
    this.emit('close');
  }

  /** 已发出的帧(解析后)。 */
  messages(): Array<{ type: string; status?: unknown }> {
    return this.frames.map((f) => JSON.parse(f) as { type: string; status?: unknown });
  }

  statuses(): unknown[] {
    return this.messages().filter((m) => m.type === 'status').map((m) => m.status);
  }
}

function attach(hub: ReturnType<typeof createStatusHub>, socket: FakeSocket): void {
  hub.attach(socket as unknown as WebSocket);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('status hub', () => {
  it('sends a full frame as soon as a client attaches', () => {
    const hub = createStatusHub({ getStatus: () => ({ n: 1 }) });
    const socket = new FakeSocket();

    attach(hub, socket);

    expect(socket.statuses()).toEqual([{ n: 1 }]);
    hub.close();
  });

  it('coalesces a burst of notifies into one frame', () => {
    vi.useFakeTimers();
    let n = 0;
    const hub = createStatusHub({ getStatus: () => ({ n }), flushMs: 250 });
    const socket = new FakeSocket();
    attach(hub, socket);
    socket.frames.length = 0;

    // 一轮扫描会在很短时间内连续改动多处状态
    n = 1;
    hub.notify();
    n = 2;
    hub.notify();
    n = 3;
    hub.notify();

    // 合并窗口内一帧都不发
    expect(socket.statuses()).toEqual([]);
    vi.advanceTimersByTime(250);
    // 只发一帧,且是最新状态
    expect(socket.statuses()).toEqual([{ n: 3 }]);
    hub.close();
  });

  it('never sends a frame when the computed status did not change', () => {
    vi.useFakeTimers();
    let n = 1;
    const hub = createStatusHub({ getStatus: () => ({ n }), fallbackMs: 1000 });
    const socket = new FakeSocket();
    attach(hub, socket);
    socket.frames.length = 0;

    // 兜底 tick 无条件重算,但状态没变 → 一帧都不该发(否则兜底退化成定频推送)
    vi.advanceTimersByTime(5000);
    expect(socket.statuses()).toEqual([]);

    // 状态真的变了才发
    n = 2;
    hub.notify();
    vi.advanceTimersByTime(250);

    expect(socket.statuses()).toEqual([{ n: 2 }]);
    hub.close();
  });

  it('replays a frame to a client that reconnects after the last one left', () => {
    vi.useFakeTimers();
    const hub = createStatusHub({ getStatus: () => ({ n: 1 }) });
    const first = new FakeSocket();
    attach(hub, first);
    first.close();

    const second = new FakeSocket();
    attach(hub, second);

    expect(second.statuses()).toEqual([{ n: 1 }]);
    hub.close();
  });

  it('keeps pinging so idle connections are not dropped by intermediaries', () => {
    vi.useFakeTimers();
    const hub = createStatusHub({ getStatus: () => ({ n: 1 }), pingMs: 30000 });
    const socket = new FakeSocket();
    attach(hub, socket);

    vi.advanceTimersByTime(30000);

    expect(socket.messages().some((m) => m.type === 'ping')).toBe(true);
    hub.close();
  });

  it('does no work at all while no client is connected', () => {
    vi.useFakeTimers();
    const getStatus = vi.fn(() => ({ n: 1 }));
    const hub = createStatusHub({ getStatus, fallbackMs: 1000 });

    const socket = new FakeSocket();
    attach(hub, socket);
    hub.notify();
    vi.advanceTimersByTime(5000);
    const callsWhileConnected = getStatus.mock.calls.length;
    expect(callsWhileConnected).toBeGreaterThan(0);

    // 最后一个客户端离开:兜底 tick 停止,daemon 回到零开销
    socket.close();
    vi.advanceTimersByTime(10000);
    expect(getStatus.mock.calls.length).toBe(callsWhileConnected);
    hub.close();
  });

  it('closes every connection on shutdown', () => {
    const hub = createStatusHub({ getStatus: () => ({ n: 1 }) });
    const a = new FakeSocket();
    const b = new FakeSocket();
    attach(hub, a);
    attach(hub, b);
    expect(hub.clientCount()).toBe(2);

    hub.close();

    expect(a.closed).toBe(true);
    expect(b.closed).toBe(true);
    expect(hub.clientCount()).toBe(0);
  });

  it('survives a failing status snapshot instead of killing the channel', () => {
    vi.useFakeTimers();
    const getStatus = vi.fn((): { n: number } => {
      throw new Error('boom');
    });
    const logs: string[] = [];
    const hub = createStatusHub({ getStatus, log: (m) => logs.push(m) });
    const socket = new FakeSocket();

    attach(hub, socket);
    hub.notify();
    vi.advanceTimersByTime(1000);

    expect(socket.statuses()).toEqual([]);
    expect(logs.some((l) => l.includes('status snapshot failed'))).toBe(true);
    hub.close();
  });
});
