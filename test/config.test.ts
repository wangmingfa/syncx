import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { rmDir } from './helpers.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, mutateConfig, saveConfig, isValidSchedule, isWithinSchedule, type Config } from '../src/config.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'syncx-config-'));
}

/**
 * saveConfig 的契约是完整 Config,但本组用例只关心「写进去什么就读出什么」,
 * 因此刻意传入省略 peers/knownDevices/pendingOffers 的偏对象——由 loadConfig
 * 在读取时补默认值。此处用断言表达「有意为之」,而不去放松生产代码的类型。
 */
function savePartial(path: string, partial: Partial<Config>): void {
  saveConfig(path, partial as Config);
}

describe('config store', () => {
  it('returns a default config when the file does not exist', () => {
    const dir = tempDir();

    const config = loadConfig(join(dir, 'config.json'));

    expect(config).toEqual({ sharedFolders: [], peers: [], knownDevices: [], pendingOffers: [] });

    rmDir(dir);
  });

  it('round-trips a saved config', () => {
    const dir = tempDir();
    const path = join(dir, 'config.json');

    savePartial(path, {
      sharedFolders: [
        {
          path: '/data/docs',
          devices: ['DEV1234567'],
        },
      ],
      peers: ['ws://192.168.1.10:22000'],
    });

    expect(loadConfig(path)).toEqual({
      sharedFolders: [{ path: '/data/docs', devices: ['DEV1234567'] }],
      peers: ['ws://192.168.1.10:22000'],
      knownDevices: [],
      pendingOffers: [],
    });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      sharedFolders: [{ path: '/data/docs', devices: ['DEV1234567'] }],
      peers: ['ws://192.168.1.10:22000'],
    });

    rmDir(dir);
  });

  it('defaults missing peers to an empty list', () => {
    const dir = tempDir();
    const path = join(dir, 'config.json');
    savePartial(path, { sharedFolders: [] });

    expect(loadConfig(path)).toEqual({ sharedFolders: [], peers: [], knownDevices: [], pendingOffers: [] });

    rmDir(dir);
  });

  it('normalizes legacy ::ffff:-mapped peer entries on load', () => {
    const dir = tempDir();
    const path = join(dir, 'config.json');
    writeFileSync(
      path,
      JSON.stringify({
        sharedFolders: [],
        peers: ['ws://[::ffff:10.13.18.36]:22000', 'ws://10.13.18.36:22000'],
      }),
    );

    // 两条等价记录合并为一条纯 IPv4 形式
    expect(loadConfig(path).peers).toEqual(['ws://10.13.18.36:22000']);

    rmDir(dir);
  });

  it('keeps genuine IPv6 peers bracketed while normalizing host case', () => {
    const dir = tempDir();
    const path = join(dir, 'config.json');
    writeFileSync(
      path,
      JSON.stringify({
        sharedFolders: [],
        peers: ['ws://[FE80::1]:22000', 'ws://[::1]:54949'],
      }),
    );

    expect(loadConfig(path).peers).toEqual(['ws://[fe80::1]:22000', 'ws://[::1]:54949']);

    rmDir(dir);
  });

  it('drops non-string and empty peer entries on load', () => {
    const dir = tempDir();
    const path = join(dir, 'config.json');
    writeFileSync(
      path,
      JSON.stringify({
        sharedFolders: [],
        // 故意写非法形态(绕过 TS 类型,模拟手改配置文件)
        peers: ['ws://10.0.0.2:22000', '', null, 'not-a-url'],
      } as unknown as Record<string, unknown>),
    );

    expect(loadConfig(path).peers).toEqual(['ws://10.0.0.2:22000', 'not-a-url']);

    rmDir(dir);
  });
});

describe('mutateConfig (config lock + atomic save)', () => {
  it('applies the mutator and persists the change', () => {
    const dir = tempDir();
    const path = join(dir, 'config.json');
    savePartial(path, { sharedFolders: [] });

    mutateConfig(path, (config) => {
      config.sharedFolders.push({ path: '/data/docs', devices: ['DEV1234567'] });
    });

    expect(loadConfig(path).sharedFolders).toEqual([{ path: '/data/docs', devices: ['DEV1234567'] }]);
    rmDir(dir);
  });

  it('skips persisting when the mutator returns false (no-op / dedup path)', () => {
    const dir = tempDir();
    const path = join(dir, 'config.json');
    savePartial(path, { sharedFolders: [{ path: '/data/docs', devices: ['DEV1234567'] }] });
    const before = readFileSync(path, 'utf8');

    mutateConfig(path, (config) => {
      config.sharedFolders.push({ path: '/tmp/extra', devices: [] }); // 内存改动
      return false; // 但声明无改动,不应落盘
    });

    // 磁盘内容保持不变(未重写)
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(loadConfig(path).sharedFolders).toEqual([{ path: '/data/docs', devices: ['DEV1234567'] }]);
    rmDir(dir);
  });

  it('releases the lock file after a successful mutateConfig (no leak)', () => {
    const dir = tempDir();
    const path = join(dir, 'config.json');
    savePartial(path, { sharedFolders: [] });

    mutateConfig(path, (config) => {
      config.peers.push('ws://10.0.0.2:22000');
    });

    expect(existsSync(`${path}.lock`)).toBe(false);
    expect(loadConfig(path).peers).toEqual(['ws://10.0.0.2:22000']);
    rmDir(dir);
  });

  it('reaps a stale lock left by a crashed process and proceeds', () => {
    const dir = tempDir();
    const path = join(dir, 'config.json');
    savePartial(path, { sharedFolders: [] });

    // 模拟崩溃遗留的陈旧锁(>30s)
    const lockPath = `${path}.lock`;
    writeFileSync(lockPath, '');
    utimesSync(lockPath, new Date(), new Date(Date.now() - 60_000));

    // 陈旧锁应被回收,mutateConfig 正常完成而非永久阻塞
    mutateConfig(path, (config) => {
      config.sharedFolders.push({ path: '/recovered', devices: [] });
    });

    expect(loadConfig(path).sharedFolders).toEqual([{ path: '/recovered', devices: [] }]);
    expect(existsSync(lockPath)).toBe(false);
    rmDir(dir);
  });
});

describe('sync schedule', () => {
  // 固定时刻用本地时间构造,与 isWithinSchedule 的 getHours/getMinutes 口径一致
  function at(hour: number, minute: number): Date {
    return new Date(2026, 0, 15, hour, minute);
  }

  it('validates schedule string shapes (HH:MM-HH:MM, tolerates spaces)', () => {
    expect(isValidSchedule('22:00-08:00')).toBe(true);
    expect(isValidSchedule(' 9:05-18:30 ')).toBe(true);
    expect(isValidSchedule('0:00-23:59')).toBe(true);
    // 形态正确即合法;from===to 交给 isWithinSchedule 按「全天」处理
    expect(isValidSchedule('12:00-12:00')).toBe(true);
    expect(isValidSchedule('')).toBe(false);
    expect(isValidSchedule('22:00')).toBe(false);
    expect(isValidSchedule('24:00-08:00')).toBe(false);
    expect(isValidSchedule('12:60-13:00')).toBe(false);
    expect(isValidSchedule('abc')).toBe(false);
    expect(isValidSchedule('22:00-08:00-06:00')).toBe(false);
  });

  it('treats empty or invalid schedules as all-day (fail-open)', () => {
    expect(isWithinSchedule(undefined, at(12, 0))).toBe(true);
    expect(isWithinSchedule('', at(12, 0))).toBe(true);
    expect(isWithinSchedule('   ', at(12, 0))).toBe(true);
    // 时段是节流手段而非安全边界:解析失败绝不锁死目录
    expect(isWithinSchedule('25:00-08:00', at(12, 0))).toBe(true);
    expect(isWithinSchedule('nonsense', at(12, 0))).toBe(true);
    // from === to:区间为零,等价于全天
    expect(isWithinSchedule('12:00-12:00', at(3, 0))).toBe(true);
  });

  it('gates a same-day window with inclusive from and exclusive to', () => {
    const s = '09:00-18:00';
    expect(isWithinSchedule(s, at(9, 0))).toBe(true);
    expect(isWithinSchedule(s, at(12, 30))).toBe(true);
    expect(isWithinSchedule(s, at(17, 59))).toBe(true);
    expect(isWithinSchedule(s, at(8, 59))).toBe(false);
    expect(isWithinSchedule(s, at(18, 0))).toBe(false);
  });

  it('gates a cross-midnight window (22:00-08:00 spans two days)', () => {
    const s = '22:00-08:00';
    expect(isWithinSchedule(s, at(22, 0))).toBe(true);
    expect(isWithinSchedule(s, at(23, 30))).toBe(true);
    expect(isWithinSchedule(s, at(0, 0))).toBe(true);
    expect(isWithinSchedule(s, at(7, 59))).toBe(true);
    expect(isWithinSchedule(s, at(8, 0))).toBe(false);
    expect(isWithinSchedule(s, at(12, 0))).toBe(false);
    expect(isWithinSchedule(s, at(21, 59))).toBe(false);
  });
});
