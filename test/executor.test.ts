import { describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readdirSync,
  symlinkSync,
} from 'node:fs';
import { rmDir, canCreateSymlinks } from './helpers.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalExecutor, resolveSharePath, preserveLocalAsConflict } from '../src/executor.js';
import { openIndexStore } from '../src/indexstore.js';
import { hashBlock } from '../src/blockstore.js';

function entry(
  path: string,
  version: Array<[string, number]>,
  blocks: string[],
  size = 100,
  deleted = false,
) {
  return {
    path,
    version: new Map(version),
    size,
    deleted,
    blocks,
  };
}

describe('local executor receive', () => {
  it('writes a new file in a nested path from provider blocks and records it in the index', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-exec-'));
    const root = join(dir, 'share');
    mkdirSync(root, { recursive: true });
    const index = openIndexStore(join(dir, 'index.db'));

    const executor = createLocalExecutor(root, index, join(root, '.syncx-trash'));
    const content = Buffer.from('hello world');
    const remote = entry('docs/plan.md', [['dev-a', 1]], [hashBlock(content)], content.length);
    const provider = {
      getBlocks: async (): Promise<Buffer[]> => [content],
    };

    await executor.applyReceive(remote, provider);

    expect(readFileSync(join(root, 'docs/plan.md'))).toEqual(content);
    expect(index.getEntry('docs/plan.md')).toMatchObject(remote);

    index.close();
    rmDir(dir);
  });

  it('replaces an existing file atomically on receive', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-exec-'));
    const root = join(dir, 'share');
    mkdirSync(root, { recursive: true });
    const index = openIndexStore(join(dir, 'index.db'));

    const executor = createLocalExecutor(root, index, join(root, '.syncx-trash'));
    const target = join(root, 'doc.txt');
    writeFileSync(target, 'old content that is longer than the new one');

    const newContent = Buffer.from('new');
    const remote = entry('doc.txt', [['dev-b', 1]], [hashBlock(newContent)], newContent.length);
    const provider = {
      getBlocks: async (): Promise<Buffer[]> => [newContent],
    };

    await executor.applyReceive(remote, provider);

    expect(readFileSync(target)).toEqual(newContent);
    expect(existsSync(`${target}.syncx-tmp`)).toBe(false);
    expect(index.getEntry('doc.txt')).toMatchObject(remote);

    index.close();
    rmDir(dir);
  });

  it('rejects blocks that do not match the entry hashes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-exec-'));
    const root = join(dir, 'share');
    mkdirSync(root, { recursive: true });
    const index = openIndexStore(join(dir, 'index.db'));

    const executor = createLocalExecutor(root, index, join(root, '.syncx-trash'));
    const remote = entry('doc.txt', [['dev-a', 1]], [hashBlock(Buffer.from('expected'))]);
    const provider = {
      getBlocks: async (): Promise<Buffer[]> => [Buffer.from('corrupted')],
    };

    await expect(executor.applyReceive(remote, provider)).rejects.toThrow(/hash mismatch/);
    expect(index.getEntry('doc.txt')).toBeUndefined();

    index.close();
    rmDir(dir);
  });

  it.skipIf(!canCreateSymlinks())('rejects a receive that would write outside the shared folder via a symlink', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-exec-'));
    const root = join(dir, 'share');
    const escape = join(dir, 'escape'); // 共享目录之外的敏感目录
    mkdirSync(root, { recursive: true });
    mkdirSync(escape, { recursive: true });
    writeFileSync(join(escape, 'secret.txt'), 'top secret');
    const index = openIndexStore(join(dir, 'index.db'));

    // 共享目录内一个指向目录外的符号链接
    symlinkSync(escape, join(root, 'escape'));

    const executor = createLocalExecutor(root, index, join(root, '.syncx-trash'));
    const content = Buffer.from('injected');
    // 恶意对端:经符号链接写入共享目录之外
    const remote = entry('escape/secret.txt', [['dev-b', 1]], [hashBlock(content)], content.length);
    const provider = {
      getBlocks: async (): Promise<Buffer[]> => [content],
    };

    await expect(executor.applyReceive(remote, provider)).rejects.toThrow(/unsafe path|escape/i);
    // 目录外的文件应保持不变
    expect(readFileSync(join(escape, 'secret.txt'))).toEqual(Buffer.from('top secret'));

    index.close();
    rmDir(dir);
  });

  it.skipIf(!canCreateSymlinks())('resolveSharePath rejects paths escaping through a symlink (read-side guard)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-exec-'));
    const root = join(dir, 'share');
    const escape = join(dir, 'escape');
    mkdirSync(root, { recursive: true });
    mkdirSync(escape, { recursive: true });
    writeFileSync(join(escape, 'secret.txt'), 'top secret');
    symlinkSync(escape, join(root, 'link'));

    // 读取侧(块请求)与写入侧共用同一守卫:拒绝经符号链接越过共享目录
    expect(() => resolveSharePath(root, 'link/secret.txt')).toThrow(/unsafe path/);
    expect(() => resolveSharePath(root, 'ok.txt')).not.toThrow();
    // 文本级 ../ 仍被拒
    expect(() => resolveSharePath(root, '../escape/secret.txt')).toThrow(/unsafe path/);

    rmDir(dir);
  });

  it('resolveSharePath tolerates a missing shared root instead of throwing ENOENT', () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-exec-'));
    const root = join(dir, 'not-created-yet');

    // 根目录不存在(刚配置尚未创建):不得抛 ENOENT(曾导致 unhandledRejection),
    // 返回绝对路径;上层会先 mkdir(auto-create)或由 existsSync 守卫跳过
    expect(() => resolveSharePath(root, 'a/b.txt')).not.toThrow();
    expect(resolveSharePath(root, 'a/b.txt')).toBe(join(root, 'a', 'b.txt'));

    rmDir(dir);
  });

  /**
   * 硬忽略的文件系统级闸门(见 docs/adr/0008)。放在这一层是因为它才是真正动文件的地方:
   * 即便 scanner / peer 的过滤同时失效,同步仍写不进本机 .git,也删不掉它。
   */
  it('resolveSharePath refuses hard-ignored paths and leaves them to nobody', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-exec-'));
    const root = join(dir, 'share');
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, '.git', 'config'), 'local git config');
    const index = openIndexStore(join(dir, 'index.db'));
    const executor = createLocalExecutor(root, index, join(root, '.syncx-trash'));

    expect(() => resolveSharePath(root, '.git/config')).toThrow(/hard-ignored/);
    expect(() => resolveSharePath(root, 'src/.git/HEAD')).toThrow(/hard-ignored/);
    expect(() => resolveSharePath(root, '.syncx-trash/a.txt.1ab')).toThrow(/hard-ignored/);
    expect(() => resolveSharePath(root, '.GIT/config')).toThrow(/hard-ignored/);
    // 段相同才算命中:.github 是普通目录
    expect(() => resolveSharePath(root, '.github/workflows/ci.yml')).not.toThrow();

    // 端到端:接收与删除都被拒,本机 .git 分毫未动
    await expect(
      executor.applyReceive(
        {
          path: '.git/config',
          version: new Map([['dev-b', 1]]),
          size: 4,
          deleted: false,
          blocks: [hashBlock(Buffer.from('evil'))],
        },
        { getBlocks: async () => [Buffer.from('evil')] },
      ),
    ).rejects.toThrow(/hard-ignored/);
    await expect(
      executor.applyDelete('.git/config', {
        path: '.git/config',
        version: new Map([['dev-b', 2]]),
        size: 0,
        deleted: true,
        blocks: [],
      }),
    ).rejects.toThrow(/hard-ignored/);

    expect(readFileSync(join(root, '.git', 'config'), 'utf8')).toBe('local git config');
    expect(existsSync(join(root, '.syncx-trash'))).toBe(false);

    index.close();
    rmDir(dir);
  });
});

describe('local executor delete', () => {
  it('removes an existing file and records the tombstone in the index', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-exec-'));
    const root = join(dir, 'share');
    mkdirSync(root, { recursive: true });
    const index = openIndexStore(join(dir, 'index.db'));

    // 回收站在共享目录**之外**(生产路径是 <configDir>/trash/<index key>):放在共享根里
    // 会在用户目录中留下常驻痕迹,并被 git status 报成未跟踪文件
    const trashDir = join(dir, 'trash');
    const executor = createLocalExecutor(root, index, trashDir);
    const target = join(root, 'doc.txt');
    writeFileSync(target, 'bye');
    index.saveEntry(entry('doc.txt', [['dev-a', 1]], [hashBlock(Buffer.from('bye'))], 3));

    const tombstone = entry('doc.txt', [['dev-a', 2]], [], 0, true);
    await executor.applyDelete('doc.txt', tombstone);

    expect(existsSync(target)).toBe(false); // 原路径已不在(被移走)
    // 删除改进回收站:内容可在回收站找回,而非硬删永久丢失
    const trashed = readdirSync(trashDir);
    expect(trashed).toHaveLength(1);
    const trashedName = trashed[0];
    if (!trashedName) throw new Error('expected the deleted file to be trashed');
    expect(trashedName.startsWith('doc.txt.')).toBe(true);
    expect(readFileSync(join(trashDir, trashedName))).toEqual(Buffer.from('bye'));
    expect(index.getEntry('doc.txt')).toEqual(tombstone);
    // 共享目录里不留任何 syncx 痕迹
    expect(existsSync(join(root, '.syncx-trash'))).toBe(false);
    expect(readdirSync(root)).toEqual([]);

    index.close();
    rmDir(dir);
  });

  it('moves a nested deleted file into the trash preserving its relative path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-exec-'));
    const root = join(dir, 'share');
    mkdirSync(root, { recursive: true });
    const index = openIndexStore(join(dir, 'index.db'));

    const trashDir = join(dir, 'trash');
    const executor = createLocalExecutor(root, index, trashDir);
    const target = join(root, 'docs', 'plan.md');
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(target, 'secret plan');
    index.saveEntry(entry('docs/plan.md', [['dev-a', 1]], [hashBlock(Buffer.from('secret plan'))], 11));

    const tombstone = entry('docs/plan.md', [['dev-a', 2]], [], 0, true);
    await executor.applyDelete('docs/plan.md', tombstone);

    expect(existsSync(target)).toBe(false);
    // 回收站内保留原相对路径结构(docs/plan.md.<stamp>),便于原样还原
    const trashDocs = readdirSync(join(trashDir, 'docs'));
    expect(trashDocs).toHaveLength(1);
    const trashedNested = trashDocs[0];
    if (!trashedNested) throw new Error('expected the nested file to be trashed');
    expect(trashedNested.startsWith('plan.md.')).toBe(true);
    expect(readFileSync(join(trashDir, 'docs', trashedNested))).toEqual(Buffer.from('secret plan'));
    expect(index.getEntry('docs/plan.md')).toEqual(tombstone);
    // 共享目录里只剩空目录结构,不出现 .syncx-trash
    expect(existsSync(join(root, '.syncx-trash'))).toBe(false);
    expect(readdirSync(join(root, 'docs'))).toEqual([]);

    index.close();
    rmDir(dir);
  });

  it('records a tombstone even when the file does not exist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-exec-'));
    const root = join(dir, 'share');
    mkdirSync(root, { recursive: true });
    const index = openIndexStore(join(dir, 'index.db'));

    const executor = createLocalExecutor(root, index, join(root, '.syncx-trash'));
    const tombstone = entry('ghost.txt', [['dev-a', 1]], [], 0, true);
    await executor.applyDelete('ghost.txt', tombstone);

    expect(existsSync(join(root, 'ghost.txt'))).toBe(false);
    expect(index.getEntry('ghost.txt')).toEqual(tombstone);

    index.close();
    rmDir(dir);
  });
});

describe('local executor conflict', () => {
  it('preserves the local file as a conflict copy and lands the remote version', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-exec-'));
    const root = join(dir, 'share');
    mkdirSync(root, { recursive: true });
    const index = openIndexStore(join(dir, 'index.db'));

    const executor = createLocalExecutor(root, index, join(root, '.syncx-trash'));
    const target = join(root, 'doc.txt');
    const localContent = Buffer.from('local edit');
    writeFileSync(target, localContent);
    index.saveEntry(
      entry('doc.txt', [['dev-a', 2]], [hashBlock(localContent)], localContent.length),
    );

    const remoteContent = Buffer.from('remote edit');
    const remote = entry(
      'doc.txt',
      [
        ['dev-a', 1],
        ['dev-b', 2],
      ],
      [hashBlock(remoteContent)],
      remoteContent.length,
    );
    const provider = {
      getBlocks: async (): Promise<Buffer[]> => [remoteContent],
    };

    await executor.applyConflict('doc.txt', index.getEntry('doc.txt')!, remote, provider, 'dev-b');

    // 本地内容保留为冲突副本,远端版本落地,索引记录合并版本
    const copies = readdirSync(root).filter((name) => name.startsWith('doc.sync-conflict-'));
    expect(copies).toHaveLength(1);
    expect(readFileSync(join(root, copies[0]!))).toEqual(localContent);
    expect(readFileSync(target)).toEqual(remoteContent);

    const recorded = index.getEntry('doc.txt')!;
    expect(recorded.version.get('dev-a')).toBe(2);
    expect(recorded.version.get('dev-b')).toBe(2);
    expect(recorded.blocks).toEqual([hashBlock(remoteContent)]);

    index.close();
    rmDir(dir);
  });

  it('does not land a file when both sides are tombstones (concurrent deletes)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-exec-'));
    const root = join(dir, 'share');
    mkdirSync(root, { recursive: true });
    const index = openIndexStore(join(dir, 'index.db'));

    const executor = createLocalExecutor(root, index, join(root, '.syncx-trash'));
    // 双方同时删除:两个墓碑版本向量并发,冲突处理不得把空文件写回磁盘复活删除
    const localTombstone = entry('doc.txt', [['dev-a', 2]], [], 0, true);
    const remoteTombstone = entry('doc.txt', [['dev-b', 2]], [], 0, true);

    const landed = await executor.applyConflict(
      'doc.txt',
      localTombstone,
      remoteTombstone,
      { getBlocks: async (): Promise<Buffer[]> => [] },
      'dev-b',
    );

    expect(existsSync(join(root, 'doc.txt'))).toBe(false);
    expect(landed.deleted).toBe(true);
    const recorded = index.getEntry('doc.txt')!;
    expect(recorded.deleted).toBe(true);
    expect(recorded.version.get('dev-a')).toBe(2);
    expect(recorded.version.get('dev-b')).toBe(2);

    index.close();
    rmDir(dir);
  });

  it('produces distinct conflict copies for two same-second conflicts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-exec-'));
    const root = join(dir, 'share');
    mkdirSync(root, { recursive: true });
    const index = openIndexStore(join(dir, 'index.db'));
    const executor = createLocalExecutor(root, index, join(root, '.syncx-trash'));
    const target = join(root, 'doc.txt');
    const localContent = Buffer.from('local edit');
    writeFileSync(target, localContent);
    index.saveEntry(
      entry('doc.txt', [['dev-a', 2]], [hashBlock(localContent)], localContent.length),
    );

    // 第一次冲突:对端 dev-a 发来 remote1
    const remoteContent1 = Buffer.from('remote edit 1');
    const remote1 = entry(
      'doc.txt',
      [
        ['dev-a', 1],
        ['dev-b', 3],
      ],
      [hashBlock(remoteContent1)],
      remoteContent1.length,
    );
    await executor.applyConflict(
      'doc.txt',
      index.getEntry('doc.txt')!,
      remote1,
      { getBlocks: async (): Promise<Buffer[]> => [remoteContent1] },
      'dev-a',
    );

    // 同一秒内、同一 peer 第二次冲突:对端再次发来 remote2
    const local2 = index.getEntry('doc.txt')!;
    const remoteContent2 = Buffer.from('remote edit 2');
    const remote2 = entry(
      'doc.txt',
      [
        ['dev-a', 1],
        ['dev-b', 4],
      ],
      [hashBlock(remoteContent2)],
      remoteContent2.length,
    );
    await executor.applyConflict(
      'doc.txt',
      local2,
      remote2,
      { getBlocks: async (): Promise<Buffer[]> => [remoteContent2] },
      'dev-a',
    );

    const copies = readdirSync(root).filter((name) => name.startsWith('doc.sync-conflict-'));
    // 修复前:两次副本文件名碰撞,只保留最后一个;修复后应各有独立副本
    expect(copies).toHaveLength(2);
    expect(new Set(copies.map((n) => readFileSync(join(root, n))))).toEqual(
      new Set([localContent, remoteContent1]),
    );
    expect(readFileSync(target)).toEqual(remoteContent2);

    index.close();
    rmDir(dir);
  });

  it('keeps the local file intact when remote blocks cannot be fetched during a conflict', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-exec-'));
    const root = join(dir, 'share');
    mkdirSync(root, { recursive: true });
    const index = openIndexStore(join(dir, 'index.db'));
    const executor = createLocalExecutor(root, index, join(root, '.syncx-trash'));
    const target = join(root, 'doc.txt');
    const localContent = Buffer.from('local edit');
    writeFileSync(target, localContent);
    index.saveEntry(
      entry('doc.txt', [['dev-a', 2]], [hashBlock(localContent)], localContent.length),
    );

    const remote = entry(
      'doc.txt',
      [
        ['dev-a', 1],
        ['dev-b', 3],
      ],
      [hashBlock(Buffer.from('remote'))],
      6,
    );

    // 对端中途失联:块获取抛错。修复前本地文件已被 rename 成冲突副本,
    // 原路径变空 → 下一轮扫描产生墓碑并传播删除;修复后本地文件保持不动。
    await expect(
      executor.applyConflict(
        'doc.txt',
        index.getEntry('doc.txt')!,
        remote,
        {
          getBlocks: async (): Promise<Buffer[]> => {
            throw new Error('peer disconnected');
          },
        },
        'dev-b',
      ),
    ).rejects.toThrow('peer disconnected');

    expect(readFileSync(target)).toEqual(localContent);
    expect(readdirSync(root).filter((n) => n.includes('.sync-conflict-'))).toHaveLength(0);
    expect(index.getEntry('doc.txt')?.deleted).toBe(false);

    index.close();
    rmDir(dir);
  });
});

describe('local executor file versions', () => {
  it('snapshots the previous content before a remote overwrite', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-exec-'));
    const root = join(dir, 'share');
    mkdirSync(root, { recursive: true });
    const index = openIndexStore(join(dir, 'index.db'));
    const versionsDir = join(dir, 'versions');

    const executor = createLocalExecutor(root, index, join(dir, 'trash'), versionsDir);
    const target = join(root, 'doc.txt');
    const oldContent = Buffer.from('old content');
    writeFileSync(target, oldContent);

    const newContent = Buffer.from('new content');
    await executor.applyReceive(
      entry('doc.txt', [['dev-b', 1]], [hashBlock(newContent)], newContent.length),
      { getBlocks: async (): Promise<Buffer[]> => [newContent] },
    );

    // 原路径已是对端新内容;旧内容留存于版本目录(带 .syncx-v- 时间戳后缀)
    expect(readFileSync(target)).toEqual(newContent);
    const versions = readdirSync(versionsDir);
    expect(versions).toHaveLength(1);
    const v = versions[0]!;
    expect(v.startsWith('doc.txt.syncx-v-')).toBe(true);
    expect(readFileSync(join(versionsDir, v))).toEqual(oldContent);

    index.close();
    rmDir(dir);
  });

  it('does not snapshot when the file is brand new (nothing being overwritten)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-exec-'));
    const root = join(dir, 'share');
    mkdirSync(root, { recursive: true });
    const index = openIndexStore(join(dir, 'index.db'));
    const versionsDir = join(dir, 'versions');

    const executor = createLocalExecutor(root, index, join(dir, 'trash'), versionsDir);
    const content = Buffer.from('first arrival');
    await executor.applyReceive(
      entry('fresh.txt', [['dev-b', 1]], [hashBlock(content)], content.length),
      { getBlocks: async (): Promise<Buffer[]> => [content] },
    );

    expect(existsSync(versionsDir)).toBe(false);

    index.close();
    rmDir(dir);
  });

  it('keeps the nested relative path structure for versions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-exec-'));
    const root = join(dir, 'share');
    mkdirSync(root, { recursive: true });
    const index = openIndexStore(join(dir, 'index.db'));
    const versionsDir = join(dir, 'versions');

    const executor = createLocalExecutor(root, index, join(dir, 'trash'), versionsDir);
    const oldContent = Buffer.from('v1');
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'plan.md'), oldContent);

    const newContent = Buffer.from('v2');
    await executor.applyReceive(
      entry('docs/plan.md', [['dev-b', 1]], [hashBlock(newContent)], newContent.length),
      { getBlocks: async (): Promise<Buffer[]> => [newContent] },
    );

    const versions = readdirSync(join(versionsDir, 'docs'));
    expect(versions).toHaveLength(1);
    expect(versions[0]!.startsWith('plan.md.syncx-v-')).toBe(true);
    expect(readFileSync(join(versionsDir, 'docs', versions[0]!))).toEqual(oldContent);

    index.close();
    rmDir(dir);
  });

  it('prunes per-path versions beyond the cap, dropping the oldest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-exec-'));
    const root = join(dir, 'share');
    mkdirSync(root, { recursive: true });
    const index = openIndexStore(join(dir, 'index.db'));
    const versionsDir = join(dir, 'versions');

    const executor = createLocalExecutor(root, index, join(dir, 'trash'), versionsDir);
    const target = join(root, 'doc.txt');
    writeFileSync(target, 'seed');

    // 覆盖 12 次:每次的旧内容都会留档,超出上限的最旧版本应被清理
    for (let i = 0; i < 12; i++) {
      const content = Buffer.from(`content-${i}`);
      await executor.applyReceive(
        entry('doc.txt', [['dev-b', i + 1]], [hashBlock(content)], content.length),
        { getBlocks: async (): Promise<Buffer[]> => [content] },
      );
    }

    const versions = readdirSync(versionsDir).sort();
    expect(versions).toHaveLength(10);
    // 最早的两份(content-0、content-1 的旧内容)应已被裁掉;
    // 最新的留档是 content-11 落地前的 content-10
    expect(versions[0]!.startsWith('doc.txt.syncx-v-')).toBe(true);
    const last = versions[versions.length - 1]!;
    expect(readFileSync(join(versionsDir, last))).toEqual(Buffer.from('content-10'));
    expect(readFileSync(target)).toEqual(Buffer.from('content-11'));

    index.close();
    rmDir(dir);
  });

  it('prunes nested-path versions beyond the cap (parent dir, not just the top level)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-exec-'));
    const root = join(dir, 'share');
    mkdirSync(root, { recursive: true });
    const index = openIndexStore(join(dir, 'index.db'));
    const versionsDir = join(dir, 'versions');

    const executor = createLocalExecutor(root, index, join(dir, 'trash'), versionsDir);
    const target = join(root, 'docs', 'plan.md');
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(target, 'seed');

    // 嵌套路径的版本留档在 <versionsDir>/docs/ 子目录里,修剪必须扫到这一层
    for (let i = 0; i < 12; i++) {
      const content = Buffer.from(`content-${i}`);
      await executor.applyReceive(
        entry('docs/plan.md', [['dev-b', i + 1]], [hashBlock(content)], content.length),
        { getBlocks: async (): Promise<Buffer[]> => [content] },
      );
    }

    const versions = readdirSync(join(versionsDir, 'docs')).sort();
    expect(versions).toHaveLength(10);
    // 最新的留档是 content-11 落地前的 content-10
    const last = versions[versions.length - 1]!;
    expect(readFileSync(join(versionsDir, 'docs', last))).toEqual(Buffer.from('content-10'));
    expect(readFileSync(target)).toEqual(Buffer.from('content-11'));

    index.close();
    rmDir(dir);
  });

  it('honours a custom versionsPerPath cap (and clamps it to at least 1)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-exec-'));
    const root = join(dir, 'share');
    mkdirSync(root, { recursive: true });
    const index = openIndexStore(join(dir, 'index.db'));
    const versionsDir = join(dir, 'versions');

    // cap=2:同一路径只保留最近 2 份留档;cap=0 会被钳到 1(至少留一份)
    const capTwo = createLocalExecutor(root, index, join(dir, 'trash'), versionsDir, { versionsPerPath: 2 });
    const capZero = createLocalExecutor(root, index, join(dir, 'trash'), versionsDir, { versionsPerPath: 0 });

    for (let i = 0; i < 5; i++) {
      const content = Buffer.from(`content-${i}`);
      const blocks = [hashBlock(content)];
      await capTwo.applyReceive(entry('a.txt', [['dev-b', i + 1]], blocks, content.length), {
        getBlocks: async (): Promise<Buffer[]> => [content],
      });
      await capZero.applyReceive(entry('b.txt', [['dev-b', i + 1]], blocks, content.length), {
        getBlocks: async (): Promise<Buffer[]> => [content],
      });
    }

    const contentsOf = (names: string[]) => names.map((n) => readFileSync(join(versionsDir, n)).toString());
    const all = readdirSync(versionsDir);
    const aVersions = all.filter((n) => n.startsWith('a.txt.syncx-v-')).sort();
    const bVersions = all.filter((n) => n.startsWith('b.txt.syncx-v-')).sort();

    // cap=2:最旧的三份(content-0/1/2 落地前的留档)被裁掉,保留最近两份
    expect(aVersions).toHaveLength(2);
    expect(contentsOf(aVersions)).toEqual(['content-2', 'content-3']);
    expect(readFileSync(join(root, 'a.txt')).toString()).toBe('content-4');

    // cap=0 → 钳为 1:只留最新一份留档
    expect(bVersions).toHaveLength(1);
    expect(contentsOf(bVersions)).toEqual(['content-3']);
    expect(readFileSync(join(root, 'b.txt')).toString()).toBe('content-4');

    index.close();
    rmDir(dir);
  });

  it('does not double-snapshot during a conflict (local file already moved to a conflict copy)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-exec-'));
    const root = join(dir, 'share');
    mkdirSync(root, { recursive: true });
    const index = openIndexStore(join(dir, 'index.db'));
    const versionsDir = join(dir, 'versions');

    const executor = createLocalExecutor(root, index, join(dir, 'trash'), versionsDir);
    const localContent = Buffer.from('local edit');
    writeFileSync(join(root, 'doc.txt'), localContent);
    index.saveEntry(entry('doc.txt', [['dev-a', 2]], [hashBlock(localContent)], localContent.length));

    const remoteContent = Buffer.from('remote edit');
    await executor.applyConflict(
      'doc.txt',
      index.getEntry('doc.txt')!,
      entry('doc.txt', [['dev-a', 1], ['dev-b', 2]], [hashBlock(remoteContent)], remoteContent.length),
      { getBlocks: async (): Promise<Buffer[]> => [remoteContent] },
      'dev-b',
    );

    // 冲突副本已保留本地内容,版本目录不应重复留档
    expect(existsSync(versionsDir)).toBe(false);
    expect(readdirSync(root).filter((n) => n.startsWith('doc.sync-conflict-'))).toHaveLength(1);

    index.close();
    rmDir(dir);
  });
});

describe('preserveLocalAsConflict', () => {
  it('renames an existing un-indexed local file to a .sync-conflict copy and frees the original path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-exec-'));
    const root = join(dir, 'share');
    mkdirSync(root, { recursive: true });
    const index = openIndexStore(join(dir, 'index.db'));

    const target = join(root, 'doc.txt');
    const localContent = Buffer.from('my local work');
    writeFileSync(target, localContent);

    // 冷启动场景:磁盘有文件、但本机索引里还没有该路径
    expect(preserveLocalAsConflict(root, 'doc.txt', 'DEV-B')).toBe(true);

    // 原路径让出、内容保留为冲突副本
    expect(existsSync(target)).toBe(false);
    const copies = readdirSync(root).filter((n) => n.startsWith('doc.sync-conflict-'));
    expect(copies).toHaveLength(1);
    expect(readFileSync(join(root, copies[0]!))).toEqual(localContent);

    index.close();
    rmDir(dir);
  });

  it('returns false when no local file exists (nothing to preserve)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-exec-'));
    const root = join(dir, 'share');
    mkdirSync(root, { recursive: true });
    const index = openIndexStore(join(dir, 'index.db'));

    expect(preserveLocalAsConflict(root, 'ghost.txt', 'DEV-B')).toBe(false);
    expect(readdirSync(root).filter((n) => n.includes('.sync-conflict-'))).toHaveLength(0);

    index.close();
    rmDir(dir);
  });
});

describe('local executor send', () => {
  it('indexes a local file with block hashes and an incremented version', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-exec-'));
    const root = join(dir, 'share');
    mkdirSync(root, { recursive: true });
    const index = openIndexStore(join(dir, 'index.db'));

    const executor = createLocalExecutor(root, index, join(root, '.syncx-trash'));
    const content = Buffer.from('hello world');
    writeFileSync(join(root, 'doc.txt'), content);
    index.saveEntry(entry('doc.txt', [['dev-a', 1]], [hashBlock(content)], content.length));

    const sent = await executor.applySend('doc.txt', 'dev-a');

    expect(sent.size).toBe(content.length);
    expect(sent.blocks).toEqual([hashBlock(content)]);
    expect(sent.version.get('dev-a')).toBe(2);
    expect(index.getEntry('doc.txt')).toEqual(sent);

    index.close();
    rmDir(dir);
  });
});
