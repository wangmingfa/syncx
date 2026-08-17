import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planOutgoing, handleIncoming } from '../src/session.js';
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

describe('session planOutgoing', () => {
  it('returns entries the local side is newer on', () => {
    const local = new Map([
      ['a.txt', entry('a.txt', [['dev-a', 2]])],
      ['same.txt', entry('same.txt', [['dev-a', 1]])],
      ['stale.txt', entry('stale.txt', [['dev-a', 1]])],
    ]);
    const remote = new Map([
      ['a.txt', entry('a.txt', [['dev-a', 1]])],
      ['same.txt', entry('same.txt', [['dev-a', 1]])],
      ['stale.txt', entry('stale.txt', [['dev-a', 3]])],
    ]);

    expect(planOutgoing(local, remote)).toEqual([entry('a.txt', [['dev-a', 2]])]);
  });

  it('includes a newer local tombstone', () => {
    const local = new Map([['gone.txt', entry('gone.txt', [['dev-a', 2]], [], 0, true)]]);
    const remote = new Map([['gone.txt', entry('gone.txt', [['dev-a', 1]])]]);

    expect(planOutgoing(local, remote)).toEqual([
      entry('gone.txt', [['dev-a', 2]], [], 0, true),
    ]);
  });

  it('returns nothing when identical', () => {
    const local = new Map([['a.txt', entry('a.txt', [['dev-a', 1]])]]);

    expect(planOutgoing(local, new Map(local))).toEqual([]);
  });
});

describe('session handleIncoming', () => {
  it('applies a remote new file via receive', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-session-'));
    const root = join(dir, 'share');
    mkdirSync(root, { recursive: true });
    const index = openIndexStore(join(dir, 'index.db'));
    const executor = createLocalExecutor(root, index);

    const content = Buffer.from('remote hello');
    const remote = new Map([
      ['a.txt', entry('a.txt', [['dev-b', 1]], [hashBlock(content)], content.length)],
    ]);
    const provider = {
      getBlocks: async (): Promise<Buffer[]> => [content],
    };

    await handleIncoming(new Map(), remote, executor, provider, 'dev-b');

    expect(readFileSync(join(root, 'a.txt'))).toEqual(content);
    expect(index.getEntry('a.txt')?.version.get('dev-b')).toBe(1);

    index.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('deletes a local file when the remote tombstone is newer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-session-'));
    const root = join(dir, 'share');
    mkdirSync(root, { recursive: true });
    const index = openIndexStore(join(dir, 'index.db'));
    const executor = createLocalExecutor(root, index);

    const localContent = Buffer.from('local');
    writeFileSync(join(root, 'gone.txt'), localContent);
    const local = new Map([
      [
        'gone.txt',
        entry('gone.txt', [['dev-a', 1], ['dev-b', 1]], [hashBlock(localContent)], 5),
      ],
    ]);
    const remote = new Map([
      ['gone.txt', entry('gone.txt', [['dev-a', 1], ['dev-b', 2]], [], 0, true)],
    ]);
    const provider = {
      getBlocks: async (): Promise<Buffer[]> => [],
    };

    await handleIncoming(local, remote, executor, provider, 'dev-b');

    expect(existsSync(join(root, 'gone.txt'))).toBe(false);
    expect(index.getEntry('gone.txt')?.deleted).toBe(true);

    index.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lands a conflict copy when versions are concurrent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-session-'));
    const root = join(dir, 'share');
    mkdirSync(root, { recursive: true });
    const index = openIndexStore(join(dir, 'index.db'));
    const executor = createLocalExecutor(root, index);

    const localContent = Buffer.from('local edit');
    writeFileSync(join(root, 'doc.txt'), localContent);
    const local = new Map([
      ['doc.txt', entry('doc.txt', [['dev-a', 2]], [hashBlock(localContent)], localContent.length)],
    ]);
    const remoteContent = Buffer.from('remote edit');
    const remote = new Map([
      [
        'doc.txt',
        entry(
          'doc.txt',
          [
            ['dev-a', 1],
            ['dev-b', 2],
          ],
          [hashBlock(remoteContent)],
          remoteContent.length,
        ),
      ],
    ]);
    const provider = {
      getBlocks: async (): Promise<Buffer[]> => [remoteContent],
    };

    await handleIncoming(local, remote, executor, provider, 'dev-b');

    expect(readFileSync(join(root, 'doc.txt'))).toEqual(remoteContent);
    expect(index.getEntry('doc.txt')?.version.get('dev-a')).toBe(2);
    expect(index.getEntry('doc.txt')?.version.get('dev-b')).toBe(2);

    index.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
