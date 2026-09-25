import { describe, expect, it } from 'vitest';
import {
  reapStale,
  TERMINAL_IDLE_MS,
  TERMINAL_MAX_LIFETIME_MS,
  type ReapTarget,
} from '../src/api/terminal.js';

/**
 * 服务端存活巡检的判定:闲置线 + 绝对上限线,阈值用 `>=`(到点即收,不留余量)。
 * 这里测纯函数 reapStale,真实 close 事件杀 shell 的链路见 terminal.ts 各分支。
 */

function conn(over: Partial<ReapTarget> & { ws?: { close: () => void } } = {}): ReapTarget & { closed: boolean } {
  const c = { ws: { close: () => void (c.closed = true) }, lastTouch: 0, openedAt: 0, closed: false } as ReapTarget & { closed: boolean };
  Object.assign(c, over);
  return c;
}

describe('reapStale', () => {
  it('到闲置阈值的连接被关掉(边界取 >=)', () => {
    const t = TERMINAL_IDLE_MS;
    const c = conn({ lastTouch: 1000, openedAt: 1000 });
    const reaped = reapStale([c], { idleMs: t, maxLifetimeMs: TERMINAL_MAX_LIFETIME_MS }, 1000 + t);
    expect(c.closed).toBe(true);
    expect(reaped).toEqual([c]);
  });

  it('闲置未超阈且未超绝对上限的连接被保留', () => {
    const now = 5000 + TERMINAL_IDLE_MS - 1;
    const c = conn({ lastTouch: 5000, openedAt: 5000 - 1 });
    const reaped = reapStale([c], { idleMs: TERMINAL_IDLE_MS, maxLifetimeMs: TERMINAL_MAX_LIFETIME_MS }, now);
    expect(c.closed).toBe(false);
    expect(reaped).toEqual([]);
  });

  it('绝对上限兜住持续心跳的不诚实连接:即使刚 touch 过,到点也收', () => {
    // lastTouch 很近(不会因闲置被收),但 openedAt 已超 1 小时上限
    const c = conn({ lastTouch: 10_000_000, openedAt: 0 });
    const reaped = reapStale([c], { idleMs: TERMINAL_IDLE_MS, maxLifetimeMs: TERMINAL_MAX_LIFETIME_MS }, 10_000_000);
    expect(c.closed).toBe(true);
    expect(reaped).toEqual([c]);
  });

  it('闲置与上限混合批次:只收该收的,不误伤新鲜连接', () => {
    const now = 20 * 60 * 1000; // 20 分钟
    const fresh = conn({ lastTouch: now - 1000, openedAt: now - 1000 });
    const idle = conn({ lastTouch: now - TERMINAL_IDLE_MS, openedAt: now - TERMINAL_IDLE_MS });
    const reaped = reapStale([fresh, idle], { idleMs: TERMINAL_IDLE_MS, maxLifetimeMs: TERMINAL_MAX_LIFETIME_MS }, now);
    expect(fresh.closed).toBe(false);
    expect(idle.closed).toBe(true);
    expect(reaped).toEqual([idle]);
  });
});
