import { describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalExecutor } from '../src/executor.js';
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
    expect(index.getEntry('docs/plan.md')).toEqual(remote);

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
    expect(index.getEntry('doc.txt')).toEqual(remote);

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
