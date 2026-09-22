import { describe, expect, it } from 'vitest';
import { TrafficLedger } from '../src/traffic.js';

// 窗口对齐到 5min 边界:测试里所有时刻都用整数毫秒,手动 flushTo 驱动,不吃真实时间
const WINDOW = 5 * 60 * 1000;
const base = (): number => Math.floor(Date.now() / WINDOW) * WINDOW;

describe('traffic ledger', () => {
  it('accumulates totals across directions', () => {
    const t = new TrafficLedger();
    t.add('send', 1000);
    t.add('receive', 250);
    t.add('send', 0); // 非正数忽略
    const s = t.snapshot(base() + 10);
    expect(s.sent).toBe(1000);
    expect(s.received).toBe(250);
  });

  it('emits a per-window delta sample when the clock crosses a boundary', () => {
    const t = new TrafficLedger();
    const w = base();
    t.add('send', 400);
    t.add('receive', 100);
    t.flushTo(w + WINDOW + 1); // 跨过当前窗口 → 闭合的一格带全部增量
    const s = t.snapshot(w + WINDOW + 1);
    expect(s.samples.length).toBeGreaterThanOrEqual(1);
    expect(s.samples.reduce((a, x) => a + x.sent, 0)).toBe(400);
    expect(s.samples.reduce((a, x) => a + x.received, 0)).toBe(100);
    // 后续同窗口内读取不产生新样本
    const n = s.samples.length;
    expect(t.snapshot(w + WINDOW + 2).samples.length).toBe(n);
  });

  it('zero-pads idle windows so the timeline stays continuous', () => {
    const t = new TrafficLedger();
    const w = base();
    t.add('send', 700);
    t.flushTo(w + 4 * WINDOW + 1);
    const s = t.snapshot(w + 4 * WINDOW + 1);
    // 跨过 4 个窗口:其中一格带 700,其余补零,时间轴不缺格
    expect(s.samples.length).toBeGreaterThanOrEqual(4);
    expect(s.samples.reduce((a, x) => a + x.sent, 0)).toBe(700);
    expect(s.samples.some((x) => x.sent === 0 && x.received === 0)).toBe(true);
  });

  it('caps the ring at 24h and jumps the cursor after long dormancy', () => {
    const t = new TrafficLedger();
    const w = base();
    for (let i = 0; i < 300; i++) {
      t.add('send', 10);
      t.flushTo(w + (i + 1) * WINDOW + 1);
    }
    const s = t.snapshot(w + 300 * WINDOW + 1);
    expect(s.samples.length).toBeLessThanOrEqual(288);
    // 久睡唤醒(跨过环长那么多窗口):不回填爆量,游标直接跳到当前
    t.flushTo(w + 10_000 * WINDOW);
    expect(t.snapshot(w + 10_000 * WINDOW).samples.length).toBeLessThanOrEqual(288);
  });
});
