import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { rmDir } from './helpers.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadConfig,
  mutateConfig,
  saveConfig,
  assertFormatVersion,
  FormatVersionError,
  FORMAT_VERSION,
  type Config,
} from '../src/config.js';

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

    // generatedBy 随运行版本变化,不适合写死;断言结构与代数即可
    expect(config).toMatchObject({
      sharedFolders: [],
      peers: [],
      knownDevices: [],
      pendingOffers: [],
      formatVersion: FORMAT_VERSION,
    });

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

    expect(loadConfig(path)).toMatchObject({
      sharedFolders: [{ path: '/data/docs', devices: ['DEV1234567'] }],
      peers: ['ws://192.168.1.10:22000'],
      knownDevices: [],
      pendingOffers: [],
      formatVersion: FORMAT_VERSION,
    });
    // saveConfig 现在总会打上代数与版本(见 config.ts 的 saveConfig)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      sharedFolders: [{ path: '/data/docs', devices: ['DEV1234567'] }],
      peers: ['ws://192.168.1.10:22000'],
      formatVersion: FORMAT_VERSION,
    });

    rmDir(dir);
  });

  it('defaults missing peers to an empty list', () => {
    const dir = tempDir();
    const path = join(dir, 'config.json');
    savePartial(path, { sharedFolders: [] });

    expect(loadConfig(path)).toMatchObject({
      sharedFolders: [],
      peers: [],
      knownDevices: [],
      pendingOffers: [],
      formatVersion: FORMAT_VERSION,
    });

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

  it('preserves unknown keys written by another backend across a mutate cycle', () => {
    // Node 与 Rust 后端共用同一数据目录(见 docs/adr/0025)。Rust 写入的配置键本端不认识,
    // 但 mutateConfig 是 load→改→整体回写,未知键一旦在 loadConfig 处被丢掉就会永久消失
    // —— 这条用例是那个约束的唯一执行保障。
    const dir = tempDir();
    const path = join(dir, 'config.json');
    // formatVersion 用本代:高于本代的数据目录会被启动闸门直接拒绝,不会走到 mutate,
    // 拿它当本用例的场景反而测不到东西(见下面那条「拒绝启动」的用例)。
    writeFileSync(
      path,
      JSON.stringify({
        sharedFolders: [],
        formatVersion: FORMAT_VERSION,
        generatedBy: '0.6.1',
        futureField: { nested: ['a', 1] },
      }),
    );

    mutateConfig(path, (config) => {
      config.peers.push('ws://10.0.0.2:22000');
    });

    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    // 未知键必须活过这一轮写;已知的元数据被本端按当前值覆盖是正常的(那是本端的声明)。
    expect(onDisk.formatVersion).toBe(FORMAT_VERSION);
    expect(onDisk.futureField).toEqual({ nested: ['a', 1] });
    expect(onDisk.peers).toEqual(['ws://10.0.0.2:22000']);
    rmDir(dir);
  });

  it('stamps formatVersion and generatedBy on every write', () => {
    // 只认不写的话库里的代数永远不会前进,「缺失即第 1 代」就变成永远的第 1 代。
    const dir = tempDir();
    const path = join(dir, 'config.json');
    savePartial(path, { sharedFolders: [] });

    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(onDisk.formatVersion).toBe(FORMAT_VERSION);
    expect(typeof onDisk.generatedBy).toBe('string');
    rmDir(dir);
  });

  it('treats a missing formatVersion as generation 1 instead of rejecting', () => {
    // 本字段引入前的配置就是一个合法的第 1 代;缺失不能让老用户开不了机。
    const dir = tempDir();
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ sharedFolders: [] }));

    expect(loadConfig(path).formatVersion).toBe(1);
    expect(() => assertFormatVersion(loadConfig(path))).not.toThrow();
    rmDir(dir);
  });

  it('refuses to run when the data dir was written by a newer format version', () => {
    // Node 与 Rust 共用同一数据目录(ADR-0025):旧代码读新结构会静默读坏,
    // 这里必须明确拒绝,而不是降级读取。
    const dir = tempDir();
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ sharedFolders: [], formatVersion: FORMAT_VERSION + 1 }));

    expect(() => assertFormatVersion(loadConfig(path))).toThrow(FormatVersionError);
    expect(() => assertFormatVersion(loadConfig(path))).toThrow(/formatVersion/);
    rmDir(dir);
  });

  it('still sanitizes known keys even when the raw file carries them', () => {
    // 未知键保留不能以「跳过已知字段的清洗」为代价:负数带宽必须在加载时被丢弃,
    // 否则手改坏的 config.json 会把非法值带进内存。
    const dir = tempDir();
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ sharedFolders: [], maxSendKbps: -5, unknownKey: 1 }));

    const config = loadConfig(path);

    expect(config.maxSendKbps).toBeUndefined();
    expect((config as unknown as Record<string, unknown>).unknownKey).toBe(1);
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

describe('sync schedule 的配置层(迁移与清洗)', () => {
  // 时段判定本身搬到 test/schedule.test.ts(模型从字符串换成规则数组);
  // 这里只钉「配置读写」这一层:旧形态迁移、坏值清洗、全局字段回退。
  function writeConfig(body: unknown): string {
    const path = join(tempDir(), 'config.json');
    writeFileSync(path, JSON.stringify(body));
    return path;
  }

  it('migrates the legacy "HH:MM-HH:MM" string into one unrestricted rule', () => {
    const cfg = loadConfig(writeConfig({ sharedFolders: [{ path: '/a', devices: [], schedule: '22:00-08:00' }] }));
    expect(cfg.sharedFolders[0]!.schedule).toEqual([{ days: { kind: 'any' }, windows: [{ from: 1320, to: 480 }] }]);
  });

  it('drops garbage schedule values to "no constraint" instead of locking the folder', () => {
    const cfg = loadConfig(
      writeConfig({
        sharedFolders: [{ path: '/a', devices: [], schedule: 'nonsense' }],
        syncSchedule: [{ days: { kind: 'nope' }, windows: [{ from: 'abc', to: 10 }] }],
      }),
    );
    expect(cfg.sharedFolders[0]!.schedule).toBeUndefined();
    expect(cfg.syncSchedule).toBeUndefined();
  });

  it('keeps a well-formed global schedule and clamps nonsense override entries', () => {
    const cfg = loadConfig(
      writeConfig({
        syncSchedule: [{ days: { kind: 'workday' }, windows: [{ from: '09:00', to: '18:00' }] }],
        scheduleOverrideUntil: -5,
        calendarOverrides: { '2026-10-01': 'holiday', 'bad-key': 'workday', '2026-10-02': 'someday' },
        holidayAutoFetch: false,
      }),
    );
    expect(cfg.syncSchedule).toEqual([{ days: { kind: 'workday' }, windows: [{ from: 540, to: 1080 }] }]);
    expect(cfg.scheduleOverrideUntil).toBeUndefined();
    expect(cfg.calendarOverrides).toEqual({ '2026-10-01': 'holiday' });
    expect(cfg.holidayAutoFetch).toBe(false);
  });
});
