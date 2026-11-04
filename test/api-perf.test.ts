import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { instrumentRequest, pickSink, processPerfSink, setProcessPerfSink, slowRequestMs, startLoopLagSampler } from '../src/api/perf.js';
import { getLastCommitHash } from '../src/git-monitor.js';

/** 假 res:只实现 finish 事件语义,触发即回调注册的监听。 */
function fakeRes(): { statusCode: number; on: (ev: 'finish', cb: () => void) => unknown; finish(): void } {
  const ee = new EventEmitter();
  return {
    statusCode: 200,
    on: (ev, cb) => ee.on(ev, cb),
    finish: () => ee.emit('finish'),
  };
}

describe('api/perf 探针', () => {
  it('阈值:缺省 300ms,SYNCX_SLOW_REQ_MS 可覆盖,非法值回缺省', () => {
    expect(slowRequestMs()).toBe(300);
    process.env.SYNCX_SLOW_REQ_MS = '50';
    expect(slowRequestMs()).toBe(50);
    process.env.SYNCX_SLOW_REQ_MS = 'abc';
    expect(slowRequestMs()).toBe(300);
    delete process.env.SYNCX_SLOW_REQ_MS;
  });

  it('sink:未注入 perfLog 且未开 SYNCX_PERF_LOG 时完全静默,开启后退回 console', () => {
    delete process.env.SYNCX_PERF_LOG;
    expect(pickSink(undefined)).toBeNull();
    process.env.SYNCX_PERF_LOG = '1';
    expect(pickSink(undefined)).not.toBeNull();
    delete process.env.SYNCX_PERF_LOG;
    expect(pickSink((l) => void l)).not.toBeNull();
  });

  it('instrumentRequest:超过阈值记一笔(方法/路径/状态/耗时),未超时不记', () => {
    process.env.SYNCX_SLOW_REQ_MS = '0'; // 全部都算慢,便于确定性断言
    const lines: string[] = [];
    const res = fakeRes();
    instrumentRequest((l) => lines.push(l), { method: 'GET', url: '/api/status?q=1' }, res, '/api/status', performance.now() - 5);
    res.finish();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('GET /api/status -> 200');
    expect(lines[0]).toContain('ms');

    const lines2: string[] = [];
    process.env.SYNCX_SLOW_REQ_MS = '300';
    const res2 = fakeRes();
    instrumentRequest((l) => lines2.push(l), { method: 'POST', url: '/api/x' }, res2, '/api/x', performance.now());
    res2.finish();
    expect(lines2).toHaveLength(0);
    delete process.env.SYNCX_SLOW_REQ_MS;
  });

  it('loopLagSampler:tick 实际滞后超阈值才记一笔', async () => {
    const lines: string[] = [];
    // 阈值 30ms,tick 10ms:setTimeout 不阻塞循环,要同步忙等 50ms 制造真实滞后
    const stop = startLoopLagSampler((l) => lines.push(l), 10, 30);
    const busyUntil = Date.now() + 50;
    while (Date.now() < busyUntil) {
      // 忙等霸占主线程 —— 正是采样器要逮住的那类卡顿
    }
    await new Promise((r) => setTimeout(r, 30));
    stop();
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines[0]).toContain('事件循环卡顿');
  });

  it('进程级 sink:注入后生效、置 null 撤销、未注入且未开环境变量时静默', () => {
    delete process.env.SYNCX_PERF_LOG;
    setProcessPerfSink(null);
    expect(processPerfSink()).toBeNull();
    const lines: string[] = [];
    setProcessPerfSink((l) => lines.push(l));
    expect(processPerfSink()).not.toBeNull();
    setProcessPerfSink(null);
    expect(processPerfSink()).toBeNull();
  });

  it('git 调用超过阈值时记一笔(命令 + 仓库名)', async () => {
    process.env.SYNCX_SLOW_REQ_MS = '0'; // 全部记,便于确定性断言
    const lines: string[] = [];
    setProcessPerfSink((l) => lines.push(l));
    try {
      const repo = mkdtempSync(join(tmpdir(), 'syncx-gitperf-'));
      execFileSync('git', ['init', '-q'], { cwd: repo });
      // 空仓库 getLastCommitHash 回 null,但调用发生了、perf 记账照记
      expect(await getLastCommitHash(repo)).toBeNull();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('git rev-parse');
      expect(lines[0]).toContain('ms');
      setProcessPerfSink(null);
      await getLastCommitHash(repo);
      expect(lines).toHaveLength(1); // 撤销后不再记
    } finally {
      delete process.env.SYNCX_SLOW_REQ_MS;
      setProcessPerfSink(null);
    }
  });
});
