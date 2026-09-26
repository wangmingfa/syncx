import { mkdtempSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { setGlobalSettings } from '../src/devices.js';
import { createControlServer } from '../src/api.js';
import {
  computeReason,
  createPowerGuard,
  parseProbeOutput,
  type PowerGuardSettings,
  type PowerGuard,
} from '../src/powerguard.js';

/**
 * 电源守卫单测:exec 全部注入,不起 PowerShell 子进程。
 * 覆盖:探针输出解析、挂起原因计算(计费网络/低电量/并联)、状态机只在变化时上报、
 * 探测失败维持上次判定、非 win32 禁用,以及配置落盘/回显/路由校验的三段接线。
 */

describe('parseProbeOutput', () => {
  it('解析 COST / BAT 行,忽略噪声与非法数字', () => {
    const r = parseProbeOutput('警告: 某某\r\nCOST=Roaming\nBAT=18,1\n');
    expect(r).toEqual({ costType: 'Roaming', batteryPercent: 18, onBattery: true });
  });
  it('BAT 第二段 2 = 外接供电;缺项保持 undefined', () => {
    expect(parseProbeOutput('COST=Standard').costType).toBe('Standard');
    expect(parseProbeOutput('COST=Standard').onBattery).toBeUndefined();
    const r = parseProbeOutput('BAT=95,2');
    expect(r.batteryPercent).toBe(95);
    expect(r.onBattery).toBe(false);
    expect(r.costType).toBeUndefined();
  });
  it('电量越界/状态非法按未探到处理,不误挂起', () => {
    expect(parseProbeOutput('BAT=250,1').batteryPercent).toBeUndefined();
    expect(parseProbeOutput('BAT=50,7').onBattery).toBeUndefined();
    expect(parseProbeOutput('BAT=abc,1').batteryPercent).toBeUndefined();
    expect(parseProbeOutput('COST=').costType).toBeUndefined();
  });
});

describe('computeReason', () => {
  it('计费网络:开关开启 + 成本类型在计费集合内才挂起', () => {
    const s: PowerGuardSettings = { pauseOnMeteredNetwork: true };
    expect(computeReason({ costType: 'Roaming' }, s)).toBe('计费网络(Roaming)');
    expect(computeReason({ costType: 'ApproachingDataCap' }, s)).toBe('计费网络(ApproachingDataCap)');
    // Standard / None / 未知成本不算计费;costType 缺失(未探到)也不挂起
    expect(computeReason({ costType: 'Standard' }, s)).toBeNull();
    expect(computeReason({}, s)).toBeNull();
    expect(computeReason({ costType: 'Roaming' }, {})).toBeNull();
  });
  it('低电量:必须在用电池且 pct <= 阈值(含等于),缺省阈值 20', () => {
    const s: PowerGuardSettings = { pauseOnLowBattery: true };
    expect(computeReason({ batteryPercent: 15, onBattery: true }, s)).toBe('低电量(15%)');
    expect(computeReason({ batteryPercent: 20, onBattery: true }, s)).toBe('低电量(20%)');
    expect(computeReason({ batteryPercent: 21, onBattery: true }, s)).toBeNull();
    expect(computeReason({ batteryPercent: 5, onBattery: false }, s)).toBeNull();
    expect(computeReason({ batteryPercent: 5 }, s)).toBeNull();
    expect(computeReason({ batteryPercent: 35, onBattery: true }, { pauseOnLowBattery: true, batteryPauseThreshold: 40 }))
      .toBe('低电量(35%)');
  });
  it('两条规则同时命中用「、」并联', () => {
    const r = computeReason(
      { costType: 'OverDataCap', batteryPercent: 8, onBattery: true },
      { pauseOnMeteredNetwork: true, pauseOnLowBattery: true },
    );
    expect(r).toBe('计费网络(OverDataCap)、低电量(8%)');
  });
});

/** 可注入 exec 的守卫夹具:脚本输出按队列依次返回,记录回调历史。 */
function guardWith(outputs: (string | Error)[], settings: PowerGuardSettings = {}) {
  const reasons: (string | null)[] = [];
  let i = 0;
  const guard: PowerGuard = createPowerGuard({
    platform: 'win32',
    exec: async () => {
      const next = outputs[Math.min(i, outputs.length - 1)] ?? '';
      i += 1;
      if (next instanceof Error) throw next;
      return next;
    },
    getSettings: () => settings,
    onStateChange: (r) => reasons.push(r),
  });
  return { guard, reasons };
}

/** 等探测(火后忘的 async)落地。 */
async function settle(): Promise<void> {
  for (let k = 0; k < 10; k += 1) await new Promise((r) => setTimeout(r, 5));
}

describe('createPowerGuard', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('非 win32:start 是空操作,exec 一次都不调', async () => {
    let called = 0;
    const reasons: (string | null)[] = [];
    const guard = createPowerGuard({
      platform: 'linux',
      exec: async () => {
        called += 1;
        return 'COST=Roaming';
      },
      getSettings: () => ({ pauseOnMeteredNetwork: true }),
      onStateChange: (r) => reasons.push(r),
    });
    expect(guard.enabled).toBe(false);
    guard.start();
    await settle();
    expect(called).toBe(0);
    expect(reasons).toEqual([]);
    guard.stop();
    expect(reasons).toEqual([]); // 禁用态 stop 也不产生伪事件
  });

  it('命中→解除只在变化时上报一次,stop 解除并停轮询', async () => {
    vi.useFakeTimers();
    const { guard, reasons } = guardWith(['COST=Roaming', 'COST=Roaming', 'COST=Standard'], {
      pauseOnMeteredNetwork: true,
    });
    guard.start();
    await vi.advanceTimersByTimeAsync(0); // 首轮立即探测
    expect(guard.current()).toBe('计费网络(Roaming)');
    expect(reasons).toEqual(['计费网络(Roaming)']);
    // 同一结果再来一轮:不重复上报
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reasons).toEqual(['计费网络(Roaming)']);
    // 条件解除:上报 null
    await vi.advanceTimersByTimeAsync(60_000);
    expect(guard.current()).toBeNull();
    expect(reasons).toEqual(['计费网络(Roaming)', null]);
    guard.stop();
    expect(reasons).toEqual(['计费网络(Roaming)', null]); // 已是 null,stop 不重复
  });

  it('探测失败维持上次判定,恢复后正常上报', async () => {
    vi.useFakeTimers();
    const { guard, reasons } = guardWith(['BAT=10,1', new Error('powershell ENOENT'), 'BAT=90,2'], {
      pauseOnLowBattery: true,
    });
    guard.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(guard.current()).toBe('低电量(10%)');
    // 第二轮探测抛错:原因保持不变(宁可晚一拍恢复,不无依据放行)
    await vi.advanceTimersByTimeAsync(60_000);
    expect(guard.current()).toBe('低电量(10%)');
    expect(reasons).toEqual(['低电量(10%)']);
    // 第三轮成功且条件解除:上报 null
    await vi.advanceTimersByTimeAsync(60_000);
    expect(guard.current()).toBeNull();
    expect(reasons).toEqual(['低电量(10%)', null]);
    guard.stop();
  });

  it('错误输出不产生挂起:解析不到任何行时保持 null', async () => {
    vi.useFakeTimers();
    const { guard, reasons } = guardWith(['', 'COST=Standard'], { pauseOnMeteredNetwork: true, pauseOnLowBattery: true });
    guard.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(reasons).toEqual([]);
    expect(guard.current()).toBeNull();
    guard.stop();
  });
});

describe('配置落盘与回显', () => {
  function tempConfig(initial: Record<string, unknown> = {}): string {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-powerguard-'));
    const file = join(dir, 'config.json');
    writeFileSync(file, JSON.stringify({ sharedFolders: [], peers: [], knownDevices: [], ...initial }));
    return file;
  }

  it('setGlobalSettings:true 落盘,false/null 清除;阈值校验 1–99', () => {
    const file = tempConfig();
    setGlobalSettings(file, { pauseOnMeteredNetwork: true, pauseOnLowBattery: true, batteryPauseThreshold: 30 });
    let cfg = loadConfig(file);
    expect(cfg.pauseOnMeteredNetwork).toBe(true);
    expect(cfg.pauseOnLowBattery).toBe(true);
    expect(cfg.batteryPauseThreshold).toBe(30);

    setGlobalSettings(file, { pauseOnMeteredNetwork: false, pauseOnLowBattery: null, batteryPauseThreshold: null });
    cfg = loadConfig(file);
    expect(cfg.pauseOnMeteredNetwork).toBeUndefined();
    expect(cfg.pauseOnLowBattery).toBeUndefined();
    expect(cfg.batteryPauseThreshold).toBeUndefined();

    expect(() => setGlobalSettings(file, { batteryPauseThreshold: 0 })).toThrow(/1–99|不小于 1/);
    expect(() => setGlobalSettings(file, { batteryPauseThreshold: 100 })).toThrow(/1–99/);
  });

  it('loadConfig 对手改坏值回退:true 之外的类型丢弃,阈值越界丢弃', () => {
    const file = tempConfig({
      pauseOnMeteredNetwork: 'yes',
      pauseOnLowBattery: true,
      batteryPauseThreshold: 500,
    });
    const cfg = loadConfig(file);
    expect(cfg.pauseOnMeteredNetwork).toBeUndefined();
    expect(cfg.pauseOnLowBattery).toBe(true);
    expect(cfg.batteryPauseThreshold).toBeUndefined();
  });
});

describe('POST /api/settings 电源守卫键校验', () => {
  async function withServer(
    deps: Partial<Parameters<typeof createControlServer>[0]>,
  ): Promise<{ port: number; close: () => void }> {
    const server = createControlServer({
      token: 'secret',
      getStatus: () => ({}),
      ...deps,
    } as Parameters<typeof createControlServer>[0]);
    server.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    return {
      port: (server.address() as AddressInfo).port,
      close: () => server.close(),
    };
  }

  function post(port: number, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path: '/api/settings',
          method: 'POST',
          headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
        },
        (res) => {
          res.setEncoding('utf8');
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, json: data === '' ? {} : (JSON.parse(data) as Record<string, unknown>) }),
          );
        },
      );
      req.on('error', reject);
      req.write(JSON.stringify(body));
      req.end();
    });
  }

  it('布尔键非布尔拒绝;数字键非数字拒绝;合法值按 present-key 透传', async () => {
    let patch: Record<string, unknown> | null = null;
    const { port, close } = await withServer({ setGlobalSettings: (p: Record<string, unknown>) => (patch = p) });
    expect((await post(port, { pauseOnMeteredNetwork: 'x' })).status).toBe(400);
    expect((await post(port, { pauseOnLowBattery: 1 })).status).toBe(400);
    expect((await post(port, { batteryPauseThreshold: 'abc' })).status).toBe(400);
    const res = await post(port, { pauseOnMeteredNetwork: true, pauseOnLowBattery: null, batteryPauseThreshold: 25 });
    expect(res.status).toBe(200);
    expect(patch).toEqual({ pauseOnMeteredNetwork: true, pauseOnLowBattery: null, batteryPauseThreshold: 25 });
    close();
  });
});
