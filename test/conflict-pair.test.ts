import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadOrCreateIdentity } from '../src/identity.js';
import { createLogger } from '../src/logger.js';
import { SyncSessionManager } from '../src/session-manager.js';
import { rmDir } from './helpers.js';

/**
 * 冲突「查看对比」的数据源(SyncSessionManager.readConflictPair)真读盘用例。
 *
 * 这里刻意**不 stub** —— test/api.test.ts 那组只验路由透传与参数校验,把
 * conflictFilePair 整个换成假实现,于是「读盘这一层能不能读到副本」从来没被跑过:
 * 副本命名是硬忽略对象,而对比读取复用了没开闸门的通用读法,抛的错又被 catch 压成
 * 「文件不存在」,冲突弹窗因此永远说「副本没有这个文件」(2026-10-08)。要钉住的就是
 * 这条真实路径,所以必须用真 manager + 真临时目录。
 *
 * 也不需要 peer:两侧都是本机文件(原文件 = 对端版,副本 = 本机让位下来的旧版)。
 */

/** 冲突副本命名(与 executor.preserveLocalAsConflict 一致):<base>.sync-conflict-<ts36>-<设备ID><ext> */
const DEV = 'ABCDEFGH23';
const COPY_NAME = `a.sync-conflict-lxq8ab-${DEV}.txt`;

interface Harness {
  manager: SyncSessionManager;
  /** 共享根(对比的两侧都在它里面)。 */
  share: string;
  close: () => void;
}

function boot(): Harness {
  const base = mkdtempSync(join(tmpdir(), 'syncx-cpair-'));
  const dir = join(base, 'config');
  const share = join(base, 'share');
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(share, 'docs'), { recursive: true });
  const configPath = join(dir, 'config.json');
  const sharedFolders = [{ id: 'main', path: share, devices: [DEV] }];
  writeFileSync(configPath, JSON.stringify({ sharedFolders, knownDevices: [], peers: [] }));
  const manager = new SyncSessionManager(
    {
      identity: loadOrCreateIdentity(dir),
      configPath,
      configDir: dir,
      peerPort: 0,
      logger: createLogger(undefined),
    },
    sharedFolders,
  );
  return {
    manager,
    share,
    close: () => {
      manager.close();
      rmDir(base);
    },
  };
}

describe('conflict pair reader (real disk)', () => {
  it('reads both sides — the hard-ignored copy included', () => {
    const h = boot();
    try {
      writeFileSync(join(h.share, 'docs', 'a.txt'), 'peer version');
      writeFileSync(join(h.share, 'docs', COPY_NAME), 'local old version');

      const r = h.manager.readConflictPair('main', `docs/${COPY_NAME}`);

      expect(r.folderId).toBe('main');
      expect(r.folderPath).toBe(h.share);
      // 原路径由副本命名反解,设备 ID 标出冲突来源
      expect(r.path).toBe('docs/a.txt');
      expect(r.deviceId).toBe(DEV);
      // 左侧:原文件当前内容(对端版)
      expect(r.local.exists).toBe(true);
      expect(r.local.text).toBe('peer version');
      // 右侧:冲突副本。**这条就是回归点** —— 闸门没开口子时这里是 exists:false,
      // 弹窗于是说「副本没有这个文件」,并把两个整文件动作一起锁死。
      expect(r.remote.exists).toBe(true);
      expect(r.remote.text).toBe('local old version');
      expect(r.remote.size).toBe(Buffer.byteLength('local old version'));
      // 读到了就不该带失败原因
      expect(r.remote.error).toBeUndefined();
      // 副本从不进索引(硬忽略),所以那一侧没有版本向量可展示
      expect(r.remote.version).toBeUndefined();
    } finally {
      h.close();
    }
  });

  it('says "missing" only when the copy really is gone', () => {
    const h = boot();
    try {
      writeFileSync(join(h.share, 'docs', 'a.txt'), 'peer version');
      // 副本被用户手动删了 / 已被收件箱处理掉:这才是「没有这个文件」,不该编出内部错误
      const r = h.manager.readConflictPair('main', `docs/${COPY_NAME}`);

      expect(r.local.exists).toBe(true);
      expect(r.remote.exists).toBe(false);
      expect(r.remote.error).toBeUndefined();
      expect(r.remote.text).toBeUndefined();
    } finally {
      h.close();
    }
  });

  it('keeps the traversal guard on the copy side and reports why it refused', () => {
    const h = boot();
    try {
      // 共享根之外放一份诱饵:allowHardIgnored 只豁免硬忽略闸门,越界守卫永远生效
      writeFileSync(join(h.share, '..', `a.sync-conflict-lxq8ab-${DEV}.txt`), 'outside the share');
      writeFileSync(join(h.share, '..', 'a.txt'), 'outside original');

      const r = h.manager.readConflictPair('main', `../${COPY_NAME}`);

      for (const side of [r.local, r.remote]) {
        expect(side.exists).toBe(false);
        expect(side.text).toBeUndefined();
        // 「有,但读不到」要说得出原因,不能伪装成缺失 —— 否则下一次还得从代码倒推
        expect(side.error).toMatch(/unsafe path/);
      }
    } finally {
      h.close();
    }
  });
});
