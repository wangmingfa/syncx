import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 本文件用 win32 语义模拟 Windows 上的 `path.relative`(返回 '\' 分隔的相对路径),
 * 锁定 2026-09-15 误删事故的根因不再复现。
 *
 * 事故:Windows 端(B)扫描时用 path.relative 得到 `utils\version.mbt`,而索引与协议里的
 * 路径是 `utils/version.mbt`。两者对不上 → 每个子目录文件既被误报为「已修改」(进 changed),
 * 又被判为「索引有、盘上无」→ 生成墓碑广播出去,把对端(A)整棵子目录删掉(251 个文件)。
 * 顶层文件不含分隔符,所以恰好只有子目录遭殃 —— 正是当时观测到的形态。
 *
 * 修法:扫描器不再调用 path.relative,相对路径由父级相对目录 + 文件名以 '/' 拼接。
 * 下面的 mock 让任何把 path.relative 重新引入扫描器的改动立刻暴露。
 */
vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>();
  return { ...actual, relative: actual.win32.relative };
});

import { scanFolder } from '../src/scanner.js';
import { openIndexStore } from '../src/indexstore.js';
import { hashBlock } from '../src/blockstore.js';
import { parseIgnoreRules } from '../src/ignore.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(): { dir: string; root: string; index: ReturnType<typeof openIndexStore> } {
  const dir = mkdtempSync(join(tmpdir(), 'syncx-scanpath-'));
  dirs.push(dir);
  const root = join(dir, 'share');
  mkdirSync(root, { recursive: true });
  const index = openIndexStore(join(dir, 'index.db'));
  return { dir, root, index };
}

function seed(root: string, index: ReturnType<typeof openIndexStore>, rel: string, content: string): void {
  writeFileSync(join(root, rel), content);
  index.saveEntry({
    path: rel,
    version: new Map([['DEV-A', 1]]),
    size: content.length,
    deleted: false,
    blocks: [hashBlock(Buffer.from(content))],
  });
}

describe('扫描相对路径一律使用 POSIX 分隔符(Windows 回归)', () => {
  it('子目录文件在 win32 语义下不会被误判为已删除/已修改', () => {
    const { root, index } = setup();
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    seed(root, index, 'top.txt', 'top');
    seed(root, index, 'a/mid.txt', 'mid');
    seed(root, index, 'a/b/deep.txt', 'deep');

    const { changed, tombstones } = scanFolder(root, index, [], 'DEV-A');

    // 修复前:changed = ['a\\mid.txt','a\\b\\deep.txt'],tombstones 覆盖两个嵌套条目
    expect(changed).toEqual([]);
    expect(tombstones).toEqual([]);
    index.close();
  });

  it('嵌套文件的真实删除仍按 POSIX 路径生成墓碑', () => {
    const { root, index } = setup();
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    seed(root, index, 'a/b/deep.txt', 'deep');
    rmSync(join(root, 'a', 'b', 'deep.txt'));

    const { tombstones } = scanFolder(root, index, [], 'DEV-A');

    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]!.path).toBe('a/b/deep.txt');
    expect(tombstones[0]!.path).not.toContain('\\');
    expect(tombstones[0]!.version.get('DEV-A')).toBe(2);
    index.close();
  });

  it('嵌套目录里的新增文件按 POSIX 路径上报', () => {
    const { root, index } = setup();
    mkdirSync(join(root, 'a'), { recursive: true });
    writeFileSync(join(root, 'a', 'new.txt'), 'new');

    const { changed, tombstones } = scanFolder(root, index, [], 'DEV-A');

    expect(changed).toEqual(['a/new.txt']);
    expect(tombstones).toEqual([]);
    index.close();
  });

  it('被忽略的嵌套目录整棵跳过,其条目不被误判为删除', () => {
    const { root, index } = setup();
    mkdirSync(join(root, 'vendor', 'deep'), { recursive: true });
    seed(root, index, 'vendor/deep/lib.js', 'x');
    seed(root, index, 'keep.txt', 'k');

    const { changed, tombstones } = scanFolder(root, index, parseIgnoreRules(['vendor/']), 'DEV-A');

    expect(changed).toEqual([]);
    expect(tombstones).toEqual([]);
    index.close();
  });
});
