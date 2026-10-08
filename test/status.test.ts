import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStatus } from '../src/status.js';

const IDENTITY = { deviceId: 'DEV1234567', publicKey: 'pk', privateKey: 'sk' };

describe('status aggregation', () => {
  it('aggregates identity, config and index stats', () => {
    const status = buildStatus(
      IDENTITY,
      {
        sharedFolders: [
          { path: '/data/docs', devices: ['DEV1234567'] },
          { path: '/data/photos', devices: ['DEV1234567', 'DEVABCDEFG'] },
        ],
        peers: [],
        knownDevices: [],
        pendingOffers: [],
      },
      { entries: 42, tombstones: 3 },
    );

    expect(status.deviceId).toBe('DEV1234567');
    // /data/* 在测试机上不存在 → gitRepo 探测为 false(正反例见下一条用例)
    expect(status.folders).toEqual([
      { path: '/data/docs', devices: ['DEV1234567'], gitRepo: false },
      { path: '/data/photos', devices: ['DEV1234567', 'DEVABCDEFG'], gitRepo: false },
    ]);
    expect(status.entries).toBe(42);
    expect(status.tombstones).toBe(3);
    // 平台要透给前端:共享目录输入框的路径示例按 **daemon 平台** 给(web/utils/format.ts 的
    // folderPathPlaceholder),浏览器可能跑在另一台机器上,不能用 navigator 判断。
    expect(status.platform).toBe(process.platform);
  });

  it('folders 的 gitRepo 是实时探测:仓库为 true,普通目录/不存在路径为 false', () => {
    const base = mkdtempSync(join(tmpdir(), 'syncx-status-gitrepo-'));
    try {
      const repo = join(base, 'repo');
      const plain = join(base, 'plain');
      mkdirSync(join(repo, '.git'), { recursive: true });
      mkdirSync(plain, { recursive: true });

      const status = buildStatus(
        IDENTITY,
        {
          sharedFolders: [
            { path: repo, devices: [] },
            { path: plain, devices: [] },
            { path: join(base, 'missing'), devices: [] },
          ],
          peers: [],
          knownDevices: [],
          pendingOffers: [],
        },
        { entries: 0, tombstones: 0 },
      );

      // 正例证明字段真的会动;两个反例(普通目录、不存在路径)证明它不是恒量。
      expect(status.folders.map((f) => f.gitRepo)).toEqual([true, false, false]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
