import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import pino from 'pino';
import { SyncSessionManager } from '../src/session-manager.js';
import { loadConfig, folderIndexKey, folderIndexPath } from '../src/config.js';
import { loadOrCreateIdentity } from '../src/identity.js';
import { openIndexStore } from '../src/indexstore.js';
import { rmDir } from './helpers.js';

/**
 * 回溯清理(session-manager.purgeNowIgnoredEntries / createFolderState 装载清理):
 * ignore 规则每轮重读,但索引库只会增量写 —— 规则加入之前扫进去的条目(2026-11-23
 * 实测:.gitignore 漏配 target/ 时 rust/target 十万级构建产物滞留索引,把弱机端的
 * 每次全量对账拖到分钟级)不会被追认删除。用例钉死两条口径:
 *  1. 活条目在规则加入后的首轮扫描被摘除(库 + localIndex 双侧);
 *  2. 墓碑(deleted=1)保留 —— 它是删除传播的载体(filterIndexedEntries 同口径),
 *     摘墓碑会让「规则化之前发生的真实删除」无法传播到对端。
 */

function boot(prefix: string): { dir: string; share: string; manager: SyncSessionManager; key: string } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const share = join(dir, 'share');
  mkdirSync(share, { recursive: true });
  const configPath = join(dir, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({ sharedFolders: [{ id: 'main', path: share, devices: [] }], knownDevices: [], peers: [] }),
  );
  const logger = pino({ level: 'warn' }, { write: () => {} });
  const manager = new SyncSessionManager(
    { identity: loadOrCreateIdentity(dir), configPath, configDir: dir, peerPort: 0, logger },
    loadConfig(configPath).sharedFolders,
  );
  return { dir, share, manager, key: folderIndexKey({ id: 'main', path: share, devices: [] }) };
}

describe('回溯清理:ignore 规则变更后,滞留条目从索引/localIndex 摘除', () => {
  it('活条目:规则加入后的首轮扫描摘除(库 + localIndex 双侧),未命中条目不动', async () => {
    const h = boot('syncx-purge-live-');
    try {
      mkdirSync(join(h.share, 'target'), { recursive: true });
      writeFileSync(join(h.share, 'keep.txt'), 'keep');
      writeFileSync(join(h.share, 'target', 'artifact.o'), 'junk');
      await h.manager.runScan(); // 首扫:target/ 尚未被忽略,两条都正常入库

      const db = openIndexStore(folderIndexPath(h.dir, h.key));
      expect(db.getEntry('target/artifact.o')?.deleted).toBe(false);
      expect(db.getEntry('keep.txt')).toBeDefined();

      // 规则加入 target/ → 下一轮扫描回溯清理:活条目从库与 localIndex 双双摘除
      writeFileSync(join(h.share, '.gitignore'), 'target/\n');
      await h.manager.runScan();
      expect(db.getEntry('target/artifact.o')).toBeUndefined();
      const localIndex = (
        h.manager as unknown as { folderStates: Array<{ id: string; localIndex: Map<string, unknown> }> }
      ).folderStates.find((f) => f.id === 'main')!.localIndex;
      expect(localIndex.has('target/artifact.o')).toBe(false);
      expect(localIndex.has('keep.txt')).toBe(true);
      db.close();
    } finally {
      h.manager.close();
      rmDir(h.dir);
    }
  });

  it('墓碑保留:规则化之前的真实删除仍能传播,回溯清理不吞墓碑', async () => {
    const h = boot('syncx-purge-tomb-');
    try {
      mkdirSync(join(h.share, 'target'), { recursive: true });
      writeFileSync(join(h.share, 'keep.txt'), 'keep');
      writeFileSync(join(h.share, 'target', 'gone.o'), 'junk');
      await h.manager.runScan(); // 首扫入库

      rmSync(join(h.share, 'target'), { recursive: true });
      await h.manager.runScan(); // 规则未变:真实删除正常生成墓碑
      const db = openIndexStore(folderIndexPath(h.dir, h.key));
      expect(db.getEntry('target/gone.o')?.deleted).toBe(true);

      writeFileSync(join(h.share, '.gitignore'), 'target/\n');
      await h.manager.runScan(); // 规则变更:回溯清理只摘活条目,墓碑原样保留
      expect(db.getEntry('target/gone.o')?.deleted).toBe(true);
      expect(db.getEntry('keep.txt')).toBeDefined();
      db.close();
    } finally {
      h.manager.close();
      rmDir(h.dir);
    }
  });
});
