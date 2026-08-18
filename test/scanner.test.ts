import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, rmSync as rm, statSync } from 'node:fs';
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

  it('skips re-hashing when size and mtime are unchanged (fast path)', () => {
    const { dir, root, index } = setup();
    writeFileSync(join(root, 'a.txt'), 'content');
    const s = statSync(join(root, 'a.txt'));
    // 已落盘状态:索引记录了正确的 mtime,但块哈希故意写错以验证快速路径
    index.saveEntry({
      path: 'a.txt',
      version: new Map([['DEV-A', 1]]),
      size: s.size,
      deleted: false,
      blocks: ['stale-hash'],
      mtime: s.mtimeMs,
    });

    const { changed } = scanFolder(root, index, [], 'DEV-A');

    // mtime 命中快速路径,不再重算哈希,因此即便块哈希过期也判定为未变更
    expect(changed).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('tolerates mtime drift within 2s for FAT32 compatibility', () => {
    const { dir, root, index } = setup();
    writeFileSync(join(root, 'a.txt'), 'content');
    const s = statSync(join(root, 'a.txt'));
    // 索引记录的 mtime 与文件实际 mtime 相差 1.5s(FAT32 2s 精度场景)
    index.saveEntry({
      path: 'a.txt',
      version: new Map([['DEV-A', 1]]),
      size: s.size,
      deleted: false,
      blocks: ['stale-hash'],
      mtime: s.mtimeMs - 1500,
    });

    const { changed } = scanFolder(root, index, [], 'DEV-A');

    // 在容忍窗口内,不重算哈希
    expect(changed).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('detects change when mtime drift exceeds 2s tolerance', () => {
    const { dir, root, index } = setup();
    writeFileSync(join(root, 'a.txt'), 'content');
    const s = statSync(join(root, 'a.txt'));
    // 索引记录的 mtime 与文件实际 mtime 相差 3s,超出容忍窗口
    index.saveEntry({
      path: 'a.txt',
      version: new Map([['DEV-A', 1]]),
      size: s.size,
      deleted: false,
      blocks: ['stale-hash'],
      mtime: s.mtimeMs - 3000,
    });

    const { changed } = scanFolder(root, index, [], 'DEV-A');

    // 超出容忍窗口,进入哈希对比路径,块哈希不匹配 → 判定为变更
    expect(changed).toEqual(['a.txt']);
    rmSync(dir, { recursive: true, force: true });
  });
});
