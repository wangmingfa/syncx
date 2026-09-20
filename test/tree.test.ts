import { describe, expect, it } from 'vitest';
import { buildTreeRows, countRows } from '../web/utils/tree.js';
import type { CompareEntry, FolderDiffKind } from '../web/types.js';

function entry(path: string, digest: string, deleted = false): CompareEntry {
  return { path, version: [], size: digest.length, deleted, digest };
}

/**
 * 「同一路径只占一行、缺失的一侧留空行」是这个视图的全部契约:
 * 一旦对齐错位,左右两列的内容就不再一一对应,页面上看到的差异全是假的。
 */
describe('buildTreeRows', () => {
  const local = [entry('a.txt', 'same'), entry('b.txt', 'left'), entry('sub/c.txt', 'left')];
  const remote = [entry('a.txt', 'same'), entry('b.txt', 'right'), entry('sub/d.txt', 'right')];
  const kinds = new Map<string, FolderDiffKind>([
    ['b.txt', 'local-newer'],
    ['sub/c.txt', 'local-newer'],
    ['sub/d.txt', 'remote-newer'],
  ]);

  it('同路径对齐在一行,缺失的一侧留空', () => {
    const rows = buildTreeRows(local, remote, kinds);
    // 目录在前(与常见文件管理器一致),其下子项紧随其后
    expect(rows.map((r) => r.path)).toEqual(['sub', 'sub/c.txt', 'sub/d.txt', 'a.txt', 'b.txt']);

    const c = rows.find((r) => r.path === 'sub/c.txt')!;
    expect(c.left).toBeDefined();
    expect(c.right).toBeUndefined();
    expect(c.status).toBe('only-local');

    const d = rows.find((r) => r.path === 'sub/d.txt')!;
    expect(d.left).toBeUndefined();
    expect(d.right).toBeDefined();
    expect(d.status).toBe('only-remote');
  });

  it('两侧都有时:一致判 same,分类非 in-sync 判 diff', () => {
    const rows = buildTreeRows(local, remote, kinds);
    expect(rows.find((r) => r.path === 'a.txt')!.status).toBe('same');
    expect(rows.find((r) => r.path === 'b.txt')!.status).toBe('diff');
  });

  it('目录以 subtreeChanged 标记「里面有差异」,折叠时也能看见', () => {
    const rows = buildTreeRows(local, remote, kinds);
    const sub = rows.find((r) => r.path === 'sub')!;
    expect(sub.isDir).toBe(true);
    expect(sub.subtreeChanged).toBe(true);
  });

  it('两侧都是墓碑的行不占位(文件在两边都不存在)', () => {
    const rows = buildTreeRows(
      [entry('a.txt', 'same'), entry('gone.txt', '', true)],
      [entry('a.txt', 'same'), entry('gone.txt', '', true)],
      new Map(),
    );
    expect(rows.map((r) => r.path)).toEqual(['a.txt']);
  });

  it('一侧墓碑、另一侧仍在:算差异(删除还没生效)', () => {
    const rows = buildTreeRows(
      [entry('gone.txt', 'x')],
      [entry('gone.txt', '', true)],
      new Map(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('diff');
  });

  it('缩进层级从 0 开始逐层递增', () => {
    const rows = buildTreeRows(local, remote, kinds);
    expect(rows.find((r) => r.path === 'sub')!.depth).toBe(0);
    expect(rows.find((r) => r.path === 'sub/c.txt')!.depth).toBe(1);
  });

  it('countRows 按状态汇总', () => {
    const counts = countRows(buildTreeRows(local, remote, kinds));
    expect(counts).toEqual({ same: 1, diff: 2, 'only-local': 1, 'only-remote': 1 });
  });
});
