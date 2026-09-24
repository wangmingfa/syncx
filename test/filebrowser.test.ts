import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { listDirectory, deleteFolderEntry, resolveFolderSubpath, PathUnsafeError } from '../src/filebrowser.js';

/**
 * 文件管理器文件系统层:路径越界防护是安全边界,必须逐条钉死 ——
 * 浏览器端传来的 relPath 属于用户输入,任何一条越界都可能读到/删掉共享目录之外的东西。
 */

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'syncx-filebrowser-'));
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'a.txt'), 'hello');
  writeFileSync(join(root, 'sub', 'b.txt'), 'world!');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function expectUnsafe(rel: string): void {
  expect(() => resolveFolderSubpath(root, rel)).toThrow(PathUnsafeError);
}

describe('resolveFolderSubpath:防越界', () => {
  it('NUL 字节拒绝', () => {
    expectUnsafe('a\0b');
  });

  it('绝对路径(POSIX 根 / 盘符)拒绝', () => {
    expectUnsafe('/etc/passwd');
    expectUnsafe('C:\\Windows');
    expectUnsafe('C:/Windows');
  });

  it('.. 上跳拒绝(正反斜杠两种写法)', () => {
    expectUnsafe('../outside');
    expectUnsafe('..\\outside');
    expectUnsafe('sub/../../outside');
  });

  it('合法相对路径返回根内绝对路径;空串与 . 返回根本身', () => {
    // 用函数自己的根结果做基准(Windows 上 tmpdir 可能含 8.3 短名,realpath 后会展开)
    const rootReal = resolveFolderSubpath(root, '');
    expect(rootReal).toBe(resolve(rootReal));
    expect(resolveFolderSubpath(root, 'sub/b.txt')).toBe(join(rootReal, 'sub', 'b.txt'));
    // Windows 反斜杠输入归一为正斜杠语义
    expect(resolveFolderSubpath(root, 'sub\\b.txt')).toBe(join(rootReal, 'sub', 'b.txt'));
  });

  it('目录内部软链指向外面时拒绝(绕过归一校验的最后一条路)', () => {
    let link = '';
    try {
      link = join(root, 'evil-link');
      symlinkSync(tmpdir(), link, 'dir');
    } catch {
      // Windows 无开发者模式/管理员权限时建软链会失败:环境不支持就跳过
      return;
    }
    try {
      expect(() => resolveFolderSubpath(root, 'evil-link')).toThrow(PathUnsafeError);
    } finally {
      rmSync(link, { force: true });
    }
  });
});

describe('listDirectory', () => {
  it('目录排前、文件排后,组内按名称次序;path 是 POSIX 相对路径', () => {
    mkdirSync(join(root, 'zz-dir'));
    writeFileSync(join(root, 'aa.txt'), 'x');
    const listing = listDirectory(root, '');
    const names = listing.entries.map((e) => e.name);
    const firstFile = names.findIndex((n) => n === 'aa.txt');
    const lastDir = names.lastIndexOf('zz-dir');
    expect(lastDir).toBeLessThan(firstFile);
    expect(listing.entries.find((e) => e.name === 'a.txt')).toMatchObject({
      path: 'a.txt',
      dir: false,
      size: 5,
    });
    expect(listing.entries.find((e) => e.name === 'sub')).toMatchObject({ path: 'sub', dir: true, size: 0 });
    expect(listing.truncated).toBe(false);
  });

  it('子目录列举返回相对根的路径(含父目录前缀)', () => {
    const listing = listDirectory(root, 'sub');
    expect(listing.entries.map((e) => e.path)).toEqual(['sub/b.txt']);
  });

  it('越界 relPath 直接抛错', () => {
    expect(() => listDirectory(root, '..')).toThrow(PathUnsafeError);
  });

  it('超过上限截断并置 truncated', () => {
    const big = mkdtempSync(join(tmpdir(), 'syncx-filebrowser-big-'));
    try {
      for (let i = 0; i < 12; i++) writeFileSync(join(big, `f${i}.txt`), 'x');
      const listing = listDirectory(big, '', 10);
      expect(listing.entries).toHaveLength(10);
      expect(listing.truncated).toBe(true);
    } finally {
      rmSync(big, { recursive: true, force: true });
    }
  });
});

describe('deleteFolderEntry', () => {
  it('删除文件与嵌套子目录(递归)', () => {
    writeFileSync(join(root, 'del.txt'), 'bye');
    deleteFolderEntry(root, 'del.txt');
    expect(existsSync(join(root, 'del.txt'))).toBe(false);

    mkdirSync(join(root, 'del-dir', 'nested'), { recursive: true });
    writeFileSync(join(root, 'del-dir', 'nested', 'c.txt'), 'x');
    deleteFolderEntry(root, 'del-dir');
    expect(existsSync(join(root, 'del-dir'))).toBe(false);
  });

  it('共享目录本身拒绝删除', () => {
    expect(() => deleteFolderEntry(root, '')).toThrow(PathUnsafeError);
    expect(() => deleteFolderEntry(root, '.')).toThrow(PathUnsafeError);
  });

  it('不存在的条目报错(不允许静默成功)', () => {
    expect(() => deleteFolderEntry(root, 'nope.txt')).toThrow();
    expect(() => deleteFolderEntry(root, '../outside.txt')).toThrow(PathUnsafeError);
  });
});
