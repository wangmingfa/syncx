import { describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readdirSync,
  symlinkSync,
} from 'node:fs';
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

    const executor = createLocalExecutor(root, index);
    const content = Buffer.from('hello world');
    const remote = entry('docs/plan.md', [['dev-a', 1]], [hashBlock(content)], content.length);
    const provider = {
      getBlocks: async (): Promise<Buffer[]> => [content],
    };

    await executor.applyReceive(remote, provider);

    expect(readFileSync(join(root, 'docs/plan.md'))).toEqual(content);
    expect(index.getEntry('docs/plan.md')).toMatchObject(remote);

    index.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('replaces an existing file atomically on receive', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-exec-'));
    const root = join(dir, 'share');
    mkdirSync(root, { recursive: true });
    const index = openIndexStore(join(dir, 'index.db'));

    const executor = createLocalExecutor(root, index);
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
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects blocks that do not match the entry hashes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-exec-'));
    const root = join(dir, 'share');
    mkdirSync(root, { recursive: true });
    const index = openIndexStore(join(dir, 'index.db'));

    const executor = createLocalExecutor(root, index);
    const remote = entry('doc.txt', [['dev-a', 1]], [hashBlock(Buffer.from('expected'))]);
    const provider = {
      getBlocks: async (): Promise<Buffer[]> => [Buffer.from('corrupted')],
    };

    await expect(executor.applyReceive(remote, provider)).rejects.toThrow(/hash mismatch/);
    expect(index.getEntry('doc.txt')).toBeUndefined();

    index.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects a receive that would write outside the shared folder via a symlink', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-exec-'));
    const root = join(dir, 'share');
    const escape = join(dir, 'escape'); // 共享目录之外的敏感目录
    mkdirSync(root, { recursive: true });
    mkdirSync(escape, { recursive: true });
    writeFileSync(join(escape, 'secret.txt'), 'top secret');
    const index = openIndexStore(join(dir, 'index.db'));

    // 共享目录内一个指向目录外的符号链接
    symlinkSync(escape, join(root, 'escape'));

    const executor = createLocalExecutor(root, index);
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
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolveSharePath rejects paths escaping through a symlink (read-side guard)', () => {
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

    rmSync(dir, { recursive: true, force: true });
  });
});

describe('local executor delete', () => {
  it('removes an existing file and records the tombstone in the index', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-exec-'));
    const root = join(dir, 'share');
    mkdirSync(root, { recursive: true });
    const index = openIndexStore(join(dir, 'index.db'));

    const executor = createLocalExecutor(root, index);
    const target = join(root, 'doc.txt');
    writeFileSync(target, 'bye');
    index.saveEntry(entry('doc.txt', [['dev-a', 1]], [hashBlock(Buffer.from('bye'))], 3));

    const tombstone = entry('doc.txt', [['dev-a', 2]], [], 0, true);
    await executor.applyDelete('doc.txt', tombstone);

    expect(existsSync(target)).toBe(false);
    expect(index.getEntry('doc.txt')).toEqual(tombstone);

    index.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('records a tombstone even when the file does not exist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-exec-'));
    const root = join(dir, 'share');
    mkdirSync(root, { recursive: true });
    const index = openIndexStore(join(dir, 'index.db'));

    const executor = createLocalExecutor(root, index);
    const tombstone = entry('ghost.txt', [['dev-a', 1]], [], 0, true);
    await executor.applyDelete('ghost.txt', tombstone);

    expect(existsSync(join(root, 'ghost.txt'))).toBe(false);
    expect(index.getEntry('ghost.txt')).toEqual(tombstone);

    index.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('local executor conflict', () => {
  it('preserves the local file as a conflict copy and lands the remote version', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-exec-'));
    const root = join(dir, 'share');
    mkdirSync(root, { recursive: true });
    const index = openIndexStore(join(dir, 'index.db'));

    const executor = createLocalExecutor(root, index);
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
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not land a file when both sides are tombstones (concurrent deletes)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-exec-'));
    const root = join(dir, 'share');
    mkdirSync(root, { recursive: true });
    const index = openIndexStore(join(dir, 'index.db'));

    const executor = createLocalExecutor(root, index);
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
    rmSync(dir, { recursive: true, force: true });
  });

  it('produces distinct conflict copies for two same-second conflicts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-exec-'));
    const root = join(dir, 'share');
    mkdirSync(root, { recursive: true });
    const index = openIndexStore(join(dir, 'index.db'));
    const executor = createLocalExecutor(root, index);
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
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the local file intact when remote blocks cannot be fetched during a conflict', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-exec-'));
    const root = join(dir, 'share');
    mkdirSync(root, { recursive: true });
    const index = openIndexStore(join(dir, 'index.db'));
    const executor = createLocalExecutor(root, index);
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
    rmSync(dir, { recursive: true, force: true });
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
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns false when no local file exists (nothing to preserve)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-exec-'));
    const root = join(dir, 'share');
    mkdirSync(root, { recursive: true });
    const index = openIndexStore(join(dir, 'index.db'));

    expect(preserveLocalAsConflict(root, 'ghost.txt', 'DEV-B')).toBe(false);
    expect(readdirSync(root).filter((n) => n.includes('.sync-conflict-'))).toHaveLength(0);

    index.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('local executor send', () => {
  it('indexes a local file with block hashes and an incremented version', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-exec-'));
    const root = join(dir, 'share');
    mkdirSync(root, { recursive: true });
    const index = openIndexStore(join(dir, 'index.db'));

    const executor = createLocalExecutor(root, index);
    const content = Buffer.from('hello world');
    writeFileSync(join(root, 'doc.txt'), content);
    index.saveEntry(entry('doc.txt', [['dev-a', 1]], [hashBlock(content)], content.length));

    const sent = await executor.applySend('doc.txt', 'dev-a');

    expect(sent.size).toBe(content.length);
    expect(sent.blocks).toEqual([hashBlock(content)]);
    expect(sent.version.get('dev-a')).toBe(2);
    expect(index.getEntry('doc.txt')).toEqual(sent);

    index.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
