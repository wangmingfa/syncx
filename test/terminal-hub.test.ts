import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

/**
 * 终端 hub 的集成回归:用 mock 的 node-pty(绝不 spawn 真实 shell)+ 假时钟,
 * 驱动 createTerminalHub().handle(ws) 全链路,验证纯函数 reapStale 覆盖不到的
 * 「接线」—— 入站帧刷新闲置钟(ping/in)、闲置到点由服务端主动 close 并杀 shell、
 * 持续 ping 能把连接从回收线下方续住、绝对上限兜不诚实心跳、用户关掉即杀进程。
 */

// vi.mock 工厂被提升到模块顶,只能引用 vi.hoisted 出来的绑定。
const { spawned, FakePty } = vi.hoisted(() => {
  const spawned: unknown[] = [];
  class FakePty {
    killed = false;
    writes: string[] = [];
    private dataCb?: (d: string) => void;
    onExitCb?: (e: { exitCode: number }) => void;
    write(d: string): void {
      this.writes.push(d);
    }
    resize(): void {}
    kill(): void {
      this.killed = true;
    }
    onData(cb: (d: string) => void): void {
      this.dataCb = cb;
    }
    onExit(cb: (e: { exitCode: number }) => void): void {
      this.onExitCb = cb;
    }
    emitData(d: string): void {
      this.dataCb?.(d);
    }
  }
  return { spawned: spawned as FakePty[], FakePty };
});

vi.mock('node-pty', () => {
  const mod = {
    spawn: () => {
      const p = new FakePty();
      spawned.push(p);
      return p;
    },
  };
  // loadPty 读 `mod.default ?? mod`:node-pty 是 CJS,vitest mock 若不给 default
  // 会在访问 .default 时抛错 → 被 loadPty 的 catch 吞掉 → 回退真实 spawn。
  return { default: mod, ...mod };
});

const { createTerminalHub, TERMINAL_IDLE_MS, TERMINAL_MAX_LIFETIME_MS } = await import('../src/api/terminal.js');

/** 满足 handle() 用到的 WebSocket 表面:readyState/OPEN、事件、send、close。 */
class FakeWs extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  sent: unknown[] = [];
  send(data: string): void {
    if (this.readyState === this.OPEN) this.sent.push(JSON.parse(data));
  }
  close(): void {
    if (this.readyState !== this.OPEN) return;
    this.readyState = 3;
    this.emit('close');
  }
  /** 模拟前端发来的 JSON 帧。 */
  receive(msg: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(msg)));
  }
  gotReady(): boolean {
    return this.sent.some((m) => (m as { t?: string }).t === 'ready');
  }
}

async function openSession(hub: ReturnType<typeof createTerminalHub>, ws: FakeWs): Promise<(typeof spawned)[number]> {
  hub.handle(ws as never);
  // 放行 loadPty 的动态 import(微任务)与随后的 spawn
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
  expect(ws.gotReady()).toBe(true);
  return spawned[spawned.length - 1]!;
}

beforeEach(() => {
  vi.useFakeTimers();
  spawned.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('terminal hub 存活门(集成)', () => {
  it('闲置到点:服务端主动关闭连接并杀掉 shell 进程', async () => {
    const hub = createTerminalHub();
    const ws = new FakeWs();
    const proc = await openSession(hub, ws);

    await vi.advanceTimersByTimeAsync(TERMINAL_IDLE_MS + 1_000);

    expect(ws.readyState).toBe(3); // 被服务端 close
    expect(proc.killed).toBe(true); // close 事件连带 kill shell
    hub.close();
  });

  it('入站 in 帧刷新闲置钟:持续打字不会被回收,停止后才收', async () => {
    const hub = createTerminalHub();
    const ws = new FakeWs();
    const proc = await openSession(hub, ws);

    // 每(闲置窗 − 1 分钟)敲一次,累计跨过两个闲置窗
    for (let i = 0; i < 2; i++) {
      await vi.advanceTimersByTimeAsync(TERMINAL_IDLE_MS - 60_000);
      ws.receive({ t: 'in', data: 'ls\r' });
      expect(ws.readyState).toBe(1); // 刚活动,仍在
    }
    expect(proc.writes).toContain('ls\r'); // 输入确实透传给了 shell

    // 停止活动后,过闲置窗即被收
    await vi.advanceTimersByTimeAsync(TERMINAL_IDLE_MS + 1_000);
    expect(ws.readyState).toBe(3);
    expect(proc.killed).toBe(true);
    hub.close();
  });

  it('后台会话靠 ping 心跳续命:无输入但用户在场不被收;心跳断流后被收', async () => {
    const hub = createTerminalHub();
    const ws = new FakeWs();
    const proc = await openSession(hub, ws);

    // 模拟前端在场心跳:每 30s 一帧 ping,连发覆盖约三个闲置窗
    for (let i = 0; i < (3 * TERMINAL_IDLE_MS) / 30_000; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
      ws.receive({ t: 'ping' });
    }
    expect(ws.readyState).toBe(1); // 一直有 ping → 不回收
    expect(proc.killed).toBe(false);

    // 用户走了(ping 断流)→ 到闲置阈值被服务端收
    await vi.advanceTimersByTimeAsync(TERMINAL_IDLE_MS + 1_000);
    expect(ws.readyState).toBe(3);
    expect(proc.killed).toBe(true);
    hub.close();
  });

  it('ping 帧不会污染 shell(不被当作输入透传)', async () => {
    const hub = createTerminalHub();
    const ws = new FakeWs();
    const proc = await openSession(hub, ws);
    ws.receive({ t: 'ping' });
    await vi.advanceTimersByTimeAsync(0);
    expect(proc.writes.length).toBe(0);
    hub.close();
  });

  it('绝对上限兜底:持续 ping 但存活超上限仍被收(不诚实心跳)', async () => {
    const hub = createTerminalHub();
    const ws = new FakeWs();
    const proc = await openSession(hub, ws);

    // 每 60s 发 ping(永不过闲置窗),但累计到绝对上限
    const steps = Math.ceil(TERMINAL_MAX_LIFETIME_MS / 60_000) + 2;
    for (let i = 0; i < steps; i++) {
      await vi.advanceTimersByTimeAsync(60_000);
      ws.receive({ t: 'ping' });
    }
    expect(ws.readyState).toBe(3); // 绝对上限到点,即使一直有心跳
    expect(proc.killed).toBe(true);
    hub.close();
  });

  it('用户主动关闭:连接结束即杀 shell 并摘除登记,巡检不再误触', async () => {
    const hub = createTerminalHub();
    const ws = new FakeWs();
    const proc = await openSession(hub, ws);

    ws.close(); // 客户端断开
    expect(proc.killed).toBe(true);

    // 摘除后推进时钟不应再有动作(也没有别的连接可收)
    await vi.advanceTimersByTimeAsync(TERMINAL_IDLE_MS * 2);
    expect(spawned.length).toBe(1);
    hub.close();
  });
});
