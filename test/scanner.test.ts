import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync as rm, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { scanFolder } from '../src/scanner.js';
import { openIndexStore } from '../src/indexstore.js';
import { parseIgnoreRules } from '../src/ignore.js';
import { hashBlock } from '../src/blockstore.js';
import { rmDir } from './helpers.js';

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
    index.close();
    rmDir(dir);
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
    index.close();
    rmDir(dir);
  });

  it('scans subdirectories recursively and ignores .syncx-tmp files', () => {
    const { dir, root, index } = setup();
    mkdirSync(join(root, 'sub', 'deep'), { recursive: true });
    writeFileSync(join(root, 'sub', 'deep', 'nested.txt'), 'nested');
    writeFileSync(join(root, 'part.syncx-tmp'), 'transient');

    const { changed } = scanFolder(root, index, [], 'DEV-A');

    // scanner 返回 OS 原生分隔符(Windows 为反斜杠),断言需与平台一致
    expect(changed).toEqual([join('sub', 'deep', 'nested.txt')]);
    index.close();
    rmDir(dir);
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
    index.close();
    rmDir(dir);
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
    index.close();
    rmDir(dir);
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
    index.close();
    rmDir(dir);
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
    index.close();
    rmDir(dir);
  });

  it('returns an empty diff when the shared folder root does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-scanner-'));
    const index = openIndexStore(join(dir, 'index.db'));
    // 索引里已有条目,但共享目录根不存在(盘符卸载 / 权限丢失)
    index.saveEntry({
      path: 'kept.txt',
      version: new Map([['DEV-A', 1]]),
      size: 8,
      deleted: false,
      blocks: [hashBlock(Buffer.from('hello'))],
    });

    const { changed, tombstones } = scanFolder(join(dir, 'does-not-exist'), index, [], 'DEV-A');

    expect(changed).toEqual([]);
    expect(tombstones).toEqual([]);
    index.close();
    rmDir(dir);
  });

  it('writes back a newer mtime when content is unchanged', () => {
    const { dir, root, index } = setup();
    const content = 'stable content';
    writeFileSync(join(root, 'a.txt'), content);
    // 索引记录旧 mtime(超出 2s 容忍窗口),内容未变
    index.saveEntry({
      path: 'a.txt',
      version: new Map([['DEV-A', 1]]),
      size: content.length,
      deleted: false,
      blocks: [hashBlock(Buffer.from(content))],
      mtime: Date.now() - 10_000,
    });

    const { changed, tombstones } = scanFolder(root, index, [], 'DEV-A');
    expect(changed).toEqual([]); // 内容未变,不触发重新发送
    expect(tombstones).toEqual([]);
    // 修复前:mtime 不写回,每次扫描重复整文件哈希;修复后写回新 mtime,
    // 下次扫描走免哈希快速路径
    expect(index.getEntry('a.txt')?.mtime).toBeGreaterThan(Date.now() - 5_000);
    // 版本不变(mtime 不在同步协议内,不递增版本、不触发广播)
    expect(index.getEntry('a.txt')?.version.get('DEV-A')).toBe(1);

    index.close();
    rmDir(dir);
  });

  it('skips nested shared roots: no double-index of child files, no tombstone on their deletion', () => {
    const { dir, root, index } = setup();
    const child = join(root, 'child');
    mkdirSync(child, { recursive: true });
    writeFileSync(join(child, 'inner.txt'), 'child content');

    // 根目录自身的新增文件仍应被检出
    writeFileSync(join(root, 'root.txt'), 'root content');

    // 模拟迁移前的历史状态:父目录索引里残留了子目录文件(曾被重复索引)
    seed(root, index, 'child/inner.txt', 'child content');

    const childRoot = resolve(child);
    const { changed, tombstones } = scanFolder(root, index, [], 'DEV-A', [childRoot]);

    // 只检出根目录自身的新增;子目录文件不重复进 changed
    expect(changed).toEqual(['root.txt']);
    expect(tombstones).toEqual([]);

    // 模拟真实运行:首扫检出的 root.txt 会被 session-manager 落库;否则二扫仍会把它当新文件
    seed(root, index, 'root.txt', 'root content');

    // 即便子目录文件在盘上被删,也不应被父目录当作"已删除"产生墓碑(避免迁移期误删)
    rm(join(child, 'inner.txt'));
    const after = scanFolder(root, index, [], 'DEV-A', [childRoot]);
    expect(after.changed).toEqual([]);
    expect(after.tombstones).toEqual([]);
    // 残留的索引条目仍在(交由子目录共享自行管理)
    expect(index.getEntry('child/inner.txt')).toBeDefined();

    index.close();
    rmDir(dir);
  });

  it('does not skip a non-shared subdir (still indexes its files)', () => {
    const { dir, root, index } = setup();
    const plain = join(root, 'plain');
    mkdirSync(plain, { recursive: true });
    writeFileSync(join(plain, 'x.txt'), 'x');

    // 不传 nestedRoots:普通子目录照常递归索引(断言用平台分隔符,Windows 为反斜杠)
    const { changed } = scanFolder(root, index, [], 'DEV-A');
    expect(changed).toContain(join('plain', 'x.txt'));

    index.close();
    rmDir(dir);
  });

  it('child folder deletions propagate even though its parent is a nested root (P2 child fix)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-p2child-'));
    const A = join(dir, 'A');
    const B = join(A, 'child'); // B ⊂ A,扫描 B 时 nestedRoots=[A]
    mkdirSync(B, { recursive: true });
    const index = openIndexStore(join(dir, 'index.db'));
    writeFileSync(join(B, 'foo.txt'), 'data');
    seed(B, index, 'foo.txt', 'data');

    rm(join(B, 'foo.txt'));

    // 修复前:parent A 是 B 路径的祖先,nestedRoots 前缀守卫会把 B 的全部删除吞掉;
    // 修复后:守卫只在「被保护根是当前扫描根的后代」时生效,所以子目录删除正常生成墓碑。
    const { changed, tombstones } = scanFolder(B, index, [], 'DEV-A', [resolve(A)]);
    expect(changed).toEqual([]);
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]!.path).toBe('foo.txt');

    index.close();
    rmDir(dir);
  });

  it('inverted-topology inner mount deletions propagate (received mapping fix)', () => {
    // 父共享挂载 C ⊂ 子共享挂载 D,扫描 folder1(C) 时 nestedRoots=[D](祖先)——
    // 修复前 C 内删除被前缀守卫全吞;修复后正常生成墓碑。
    const dir = mkdtempSync(join(tmpdir(), 'syncx-inv-'));
    const D = join(dir, 'D');
    const C = join(D, 'C');
    mkdirSync(C, { recursive: true });
    const index = openIndexStore(join(dir, 'index.db'));
    writeFileSync(join(C, 'foo.txt'), 'data');
    seed(C, index, 'foo.txt', 'data');

    rm(join(C, 'foo.txt'));

    const { changed, tombstones } = scanFolder(C, index, [], 'DEV-A', [resolve(D)]);
    expect(changed).toEqual([]);
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]!.path).toBe('foo.txt');

    index.close();
    rmDir(dir);
  });
});
