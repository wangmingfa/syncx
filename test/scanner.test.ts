import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, rmSync as rm } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanFolder } from '../src/scanner.js';
import { openIndexStore } from '../src/indexstore.js';
import { parseIgnoreRules } from '../src/ignore.js';
import { hashBlock } from '../src/blockstore.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'syncx-scanner-'));
  const root = join(dir, 'share');
  mkdirSync(root, { recursive: true });
  const index = openIndexStore(join(dir, 'index.db'));
  return { dir, root, index };
}

function seed(root: string, index: ReturnType<typeof openIndexStore>, rel: string, content: string, deviceId = 'DEV-A') {
  writeFileSync(join(root, rel), content);
  index.saveEntry({
    path: rel,
    version: new Map([[deviceId, 1]]),
    size: content.length,
    deleted: false,
    blocks: [hashBlock(Buffer.from(content))],
  });
}

describe('scanFolder', () => {
  it('reports new and modified files as changed, untouched files as clean', () => {
    const { dir, root, index } = setup();
    seed(root, index, 'keep.txt', 'same');

    writeFileSync(join(root, 'new.txt'), 'new file');
    seed(root, index, 'mod.txt', 'old');
    writeFileSync(join(root, 'mod.txt'), 'new content');

    const { changed, tombstones } = scanFolder(root, index, [], 'DEV-A');

    expect(changed.sort()).toEqual(['mod.txt', 'new.txt']);
    expect(tombstones).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('detects deletion as a tombstone with an incremented version', () => {
    const { dir, root, index } = setup();
    seed(root, index, 'gone.txt', 'data');

    rm(join(root, 'gone.txt'));

    const { changed, tombstones } = scanFolder(root, index, [], 'DEV-A');

    expect(changed).toEqual([]);
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]!.path).toBe('gone.txt');
    expect(tombstones[0]!.deleted).toBe(true);
    expect(tombstones[0]!.version.get('DEV-A')).toBe(2);
    expect(tombstones[0]!.blocks).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('scans subdirectories recursively and ignores .syncx-tmp files', () => {
    const { dir, root, index } = setup();
    mkdirSync(join(root, 'sub', 'deep'), { recursive: true });
    writeFileSync(join(root, 'sub', 'deep', 'nested.txt'), 'nested');
    writeFileSync(join(root, 'part.syncx-tmp'), 'transient');

    const { changed } = scanFolder(root, index, [], 'DEV-A');

    expect(changed).toEqual(['sub/deep/nested.txt']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('skips files matched by ignore rules, including their deletions', () => {
    const { dir, root, index } = setup();
    seed(root, index, 'keep.txt', 'data');
    seed(root, index, 'skip.log', 'logs');
    writeFileSync(join(root, 'skip.log'), 'still logs');
    rm(join(root, 'skip.log'));

    const rules = parseIgnoreRules(['*.log']);
    const { changed, tombstones } = scanFolder(root, index, rules, 'DEV-A');

    expect(changed).toEqual([]);
    expect(tombstones).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});
