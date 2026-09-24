import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rmDir } from './helpers.js';
import {
  LEGACY_FOLDER_MARKER,
  acceptedDevs,
  checkFolderIdentity,
  compareIdentity,
  readFolderIdentity,
  removeLegacyFolderMarker,
  withAcceptedDev,
} from '../src/folder-identity.js';
import { SyncSessionManager } from '../src/session-manager.js';
import { loadConfig } from '../src/config.js';
import { setFolderPaused } from '../src/devices.js';
import { loadOrCreateIdentity } from '../src/identity.js';
import { createLogger } from '../src/logger.js';

/**
 * 共享目录身份指纹(dev + ino)。
 *
 * 这层替代了旧版写在共享根里的 `.syncx-folder` 标记文件:标记文件直观,却会在用户的
 * 共享目录里留下常驻痕迹(被 git status 报成未跟踪文件)。指纹的作用不变——区分
 * 「盘未挂载 / 目录被整体清空」与「用户确实删光了文件」——而且还更强:换盘、重新挂载、
 * 目录被删了重建都会改变 dev/ino,而「同一个路径上换了另一块盘」标记文件认不出。
 */
function tempDir(prefix = 'syncx-fid-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('readFolderIdentity', () => {
  it('returns dev + ino for an existing directory', () => {
    const dir = tempDir();
    const identity = readFolderIdentity(dir);
    expect(identity).not.toBeNull();
    // 十进制字符串:JSON 无法序列化 BigInt,且部分文件系统的 inode 超过 2^53
    expect(identity?.dev).toMatch(/^\d+$/);
    expect(identity?.ino).toMatch(/^\d+$/);
    rmDir(dir);
  });

  it('is stable across calls for the same directory', () => {
    const dir = tempDir();
    const sub = join(dir, 'share');
    mkdirSync(sub);
    expect(readFolderIdentity(sub)).toEqual(readFolderIdentity(sub));
    rmDir(dir);
  });

  it('returns null for a missing path or a non-directory', () => {
    const dir = tempDir();
    const file = join(dir, 'a.txt');
    writeFileSync(file, 'x');
    expect(readFolderIdentity(join(dir, 'does-not-exist'))).toBeNull();
    expect(readFolderIdentity(file)).toBeNull();
    rmDir(dir);
  });
});

describe('checkFolderIdentity', () => {
  it('reports ok when the recorded identity matches', () => {
    const dir = tempDir();
    expect(checkFolderIdentity(dir, readFolderIdentity(dir) ?? undefined)).toBe('ok');
    rmDir(dir);
  });

  it('reports changed when dev/ino differ (换盘 / 重新挂载 / 目录被重建)', () => {
    const dir = tempDir();
    expect(checkFolderIdentity(dir, { dev: '1', ino: '2' })).toBe('changed');
    rmDir(dir);
  });

  it('reports missing when the path is gone', () => {
    const dir = tempDir();
    const gone = join(dir, 'unmounted');
    expect(checkFolderIdentity(gone, { dev: '1', ino: '2' })).toBe('missing');
    rmDir(dir);
  });

  it('reports unknown (never ok) when nothing was recorded', () => {
    const dir = tempDir();
    // 未记录指纹时宁可退化到结构守卫,也不凭空信任
    expect(checkFolderIdentity(dir, undefined)).toBe('unknown');
    rmDir(dir);
  });
});

describe('compareIdentity (纯比对,重挂 vs 换盘)', () => {
  it('ok when both dev and ino match', () => {
    expect(compareIdentity({ dev: '65115', ino: '210052' }, { dev: '65115', ino: '210052' })).toBe('ok');
  });

  it('remounted when only dev changed (同一磁盘重新挂载的典型指纹)', () => {
    // 真实现场:Linux 设备重启后磁盘重枚举,dev 65114→65115 而 ino 不变
    expect(compareIdentity({ dev: '65115', ino: '210052' }, { dev: '65114', ino: '210052' })).toBe('remounted');
  });

  it('changed when ino differs (目录被重建 / 换了别的盘)', () => {
    expect(compareIdentity({ dev: '65115', ino: '999' }, { dev: '65114', ino: '210052' })).toBe('changed');
    expect(compareIdentity({ dev: '65115', ino: '999' }, { dev: '65115', ino: '210052' })).toBe('changed');
  });

  // ↓ Android A/B 分区设备实测:两次 OTA 让 /data 的 st_dev 在 65114 / 65115 之间来回跳,
  //   inode 始终不变(见 docs/adr/0009 附录)。第一次遇到新值仍要人确认,确认过就不再打扰。
  it('remounted-known when 该设备号曾经人工确认过(A/B 摆回来)', () => {
    const recorded = { dev: '65115', ino: '210052', devs: ['65114', '65115'] };
    expect(compareIdentity({ dev: '65114', ino: '210052' }, recorded)).toBe('remounted-known');
  });

  it('remounted(需人工确认)when 设备号没在集合里,哪怕集合已存在', () => {
    const recorded = { dev: '65115', ino: '210052', devs: ['65114', '65115'] };
    expect(compareIdentity({ dev: '65116', ino: '210052' }, recorded)).toBe('remounted');
  });

  it('ino 不同时集合命中也不放行 —— 集合只赦免「仅 dev 变」', () => {
    const recorded = { dev: '65115', ino: '210052', devs: ['65114', '65115'] };
    expect(compareIdentity({ dev: '65114', ino: '777' }, recorded)).toBe('changed');
  });
});

describe('acceptedDevs / withAcceptedDev (可接受设备号集合)', () => {
  it('旧配置没有 devs 字段时,退化成只有 dev 一个值', () => {
    expect(acceptedDevs({ dev: '65114', ino: '1' })).toEqual(['65114']);
  });

  it('devs 存在时补齐当前 dev 并去重', () => {
    expect(acceptedDevs({ dev: '65115', ino: '1', devs: ['65114', '65115'] })).toEqual(['65114', '65115']);
    expect(acceptedDevs({ dev: '65116', ino: '1', devs: ['65114', '65115'] })).toEqual(['65114', '65115', '65116']);
  });

  it('并入新确认的 dev:去重、保持顺序、不重复堆积', () => {
    expect(withAcceptedDev({ dev: '65114', ino: '1' }, '65115')).toEqual(['65114', '65115']);
    expect(withAcceptedDev({ dev: '65115', ino: '1', devs: ['65114', '65115'] }, '65114')).toEqual(['65115', '65114']);
  });

  it('集合有上限,超了丢最旧(别让 config.json 无界膨胀)', () => {
    let id = { dev: 'd0', ino: '1', devs: Array.from({ length: 8 }, (_, i) => `d${i}`) };
    id = { dev: 'dX', ino: '1', devs: withAcceptedDev(id, 'dX') };
    expect(id.devs).toHaveLength(8);
    expect(id.devs?.[0]).toBe('d1');
    expect(id.devs?.[7]).toBe('dX');
  });

  it('没有历史记录时以当前 dev 起步', () => {
    expect(withAcceptedDev(undefined, '65114')).toEqual(['65114']);
  });
});

describe('removeLegacyFolderMarker', () => {
  it('deletes the marker syncx wrote', () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, LEGACY_FOLDER_MARKER),
      '此文件由 syncx 生成,用于确认该共享目录已正确挂载/内容可信。\n',
    );
    expect(removeLegacyFolderMarker(dir)).toBe(true);
    expect(existsSync(join(dir, LEGACY_FOLDER_MARKER))).toBe(false);
    rmDir(dir);
  });

  it('deletes a zero-byte leftover', () => {
    const dir = tempDir();
    writeFileSync(join(dir, LEGACY_FOLDER_MARKER), '');
    expect(removeLegacyFolderMarker(dir)).toBe(true);
    rmDir(dir);
  });

  it('leaves a user file with the same name but unrelated content alone', () => {
    const dir = tempDir();
    const path = join(dir, LEGACY_FOLDER_MARKER);
    writeFileSync(path, '我自己放的文件,别动它\n');
    expect(removeLegacyFolderMarker(dir)).toBe(false);
    expect(existsSync(path)).toBe(true);
    rmDir(dir);
  });

  it('reports false when there is nothing to remove', () => {
    const dir = tempDir();
    expect(removeLegacyFolderMarker(dir)).toBe(false);
    rmDir(dir);
  });
});

/**
 * 端到端钉住「人工确认会记住这个设备号」—— 它要写 config.json,纯函数测不到那次落盘。
 * 写坏有两个方向都不好:漏记 → 下次 A/B 摆动又弹框;多记 → 把没确认过的设备号当成信任。
 */
describe('reAdoptFolderIdentity 落盘', () => {
  it('确认后把当前设备号并入 devs 并写回 config.json', async () => {
    const dir = tempDir('syncx-fid-adopt-');
    try {
      const share = join(dir, 'share');
      mkdirSync(share, { recursive: true });
      const real = readFolderIdentity(share);
      expect(real).not.toBeNull();
      const configPath = join(dir, 'config.json');
      // 设备号记成一个不可能匹配的值、inode 用真实的 → 判定为 remounted(需人工确认)
      writeFileSync(
        configPath,
        JSON.stringify({
          sharedFolders: [
            { id: 'f1', path: share, devices: [], folderIdentity: { dev: '999999999', ino: real!.ino } },
          ],
          peers: [],
        }),
      );
      const manager = new SyncSessionManager(
        {
          identity: loadOrCreateIdentity(dir),
          configPath,
          configDir: dir,
          peerPort: 0,
          logger: createLogger(undefined),
        },
        loadConfig(configPath).sharedFolders,
      );

      manager.reAdoptFolderIdentity('f1');

      const saved = loadConfig(configPath).sharedFolders[0]?.folderIdentity;
      expect(saved?.dev).toBe(real!.dev);
      expect(saved?.ino).toBe(real!.ino);
      expect(saved?.devs).toContain(real!.dev);
      // 旧值必须**保留**:A/B 是在两个设备号之间来回跳,忘掉上一个就等于下次跳回去
      // 又要人确认一次 —— 那正是这次改动要消掉的东西。新值追加在末尾。
      expect(saved?.devs).toEqual(['999999999', real!.dev]);
      // reAdopt 内部发的是 `void runScan()`,而 runScan 在已有扫描在跑时只置一个
      // scanQueued 就立刻返回(见其重入注释)—— 直接 await 它等于没等到,close() 会
      // 落在扫描进行中,索引库句柄没释放,Windows 上临时目录锁死、rmDir 直接 EPERM。
      await new Promise((r) => setTimeout(r, 250));
      await manager.runScan();
      manager.close();
    } finally {
      rmDir(dir);
    }
  });

  /**
   * 兼容性里最容易被动坏的一条:`devs` 靠 config.json 往返存活。loadConfig 是逐字段
   * 重建顶层 Config 的(见其实现),而 sharedFolders 是整批透传 —— 只要哪天有人把某个
   * 目录的改动从「改一个属性」写成「重建整个 folder 对象」,记忆就会被静默洗掉,
   * 表现是每次 A/B 摆动又开始弹框,而且没有任何报错。
   */
  it('无关的配置写入(如暂停)不会洗掉 devs', () => {
    const dir = tempDir('syncx-fid-keep-');
    try {
      const share = join(dir, 'share');
      mkdirSync(share, { recursive: true });
      const configPath = join(dir, 'config.json');
      writeFileSync(
        configPath,
        JSON.stringify({
          sharedFolders: [
            { id: 'f1', path: share, devices: [], folderIdentity: { dev: '65115', ino: '210052', devs: ['65114', '65115'] } },
          ],
          peers: [],
        }),
      );

      setFolderPaused(configPath, 'f1', true);

      const saved = loadConfig(configPath).sharedFolders[0]?.folderIdentity;
      expect(saved?.devs).toEqual(['65114', '65115']);
      // 集合命中过的设备号再出现,仍然判为可静默重采 —— 记忆没丢
      expect(compareIdentity({ dev: '65114', ino: '210052' }, saved!)).toBe('remounted-known');
    } finally {
      rmDir(dir);
    }
  });

  /** 升级前写的配置没有 devs 字段:必须照旧工作,且第一次遇到新设备号仍要人确认。 */
  it('旧格式(只有 dev/ino)读得通,且不会凭空信任新设备号', () => {
    const legacy = { dev: '65114', ino: '210052' };
    expect(acceptedDevs(legacy)).toEqual(['65114']);
    // 同一个值再统计为 ok;摆到没确认过的另一个值 → remounted(弹框),不是 remounted-known
    expect(compareIdentity({ dev: '65114', ino: '210052' }, legacy)).toBe('ok');
    expect(compareIdentity({ dev: '65115', ino: '210052' }, legacy)).toBe('remounted');
  });
});
