import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rmDir } from './helpers.js';
import { LEGACY_TRASH_DIR, migrateLegacyTrash } from '../src/trash.js';

/**
 * 旧版回收站(`<共享根>/.syncx-trash`)的搬迁。
 *
 * 回收站原本建在共享根里,会在用户目录中留下常驻痕迹(并被 git status 报成未跟踪文件)。
 * 升级时把其中已有的可恢复数据搬到共享目录之外,再移除该目录 —— 但**任何单个文件搬不动
 * 就保留原目录**,绝不因为「搬不动」而丢掉可恢复的数据。
 */
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'syncx-trash-'));
}

describe('migrateLegacyTrash', () => {
  it('moves files out preserving the relative path structure and removes the legacy dir', () => {
    const dir = tempDir();
    const root = join(dir, 'share');
    const dest = join(dir, 'config', 'trash', 'abc');
    mkdirSync(join(root, LEGACY_TRASH_DIR, 'docs'), { recursive: true });
    writeFileSync(join(root, LEGACY_TRASH_DIR, 'a.txt.1z'), 'A');
    writeFileSync(join(root, LEGACY_TRASH_DIR, 'docs', 'plan.md.1z'), 'PLAN');

    const { moved, failed } = migrateLegacyTrash(root, dest);

    expect({ moved, failed }).toEqual({ moved: 2, failed: 0 });
    expect(readFileSync(join(dest, 'a.txt.1z'), 'utf8')).toBe('A');
    // 相对路径结构保留,便于原样还原
    expect(readFileSync(join(dest, 'docs', 'plan.md.1z'), 'utf8')).toBe('PLAN');
    // 共享目录里不再有回收站
    expect(existsSync(join(root, LEGACY_TRASH_DIR))).toBe(false);
    expect(readdirSync(root)).toEqual([]);

    rmDir(dir);
  });

  it('is a no-op when there is no legacy trash', () => {
    const dir = tempDir();
    const root = join(dir, 'share');
    mkdirSync(root);
    expect(migrateLegacyTrash(root, join(dir, 'trash'))).toEqual({ moved: 0, failed: 0 });
    expect(existsSync(join(dir, 'trash'))).toBe(false); // 不白建目录
    rmDir(dir);
  });

  it('keeps the legacy dir when a file cannot be moved', () => {
    const dir = tempDir();
    const root = join(dir, 'share');
    mkdirSync(join(root, LEGACY_TRASH_DIR), { recursive: true });
    writeFileSync(join(root, LEGACY_TRASH_DIR, 'ok.txt.1z'), 'ok');
    // 目标位置被一个同名**目录**占住:拷贝/重命名都会失败,该文件搬不过去
    const dest = join(dir, 'trash');
    mkdirSync(join(dest, 'blocked.txt.1z'), { recursive: true });
    writeFileSync(join(root, LEGACY_TRASH_DIR, 'blocked.txt.1z'), 'blocked');

    const { moved, failed } = migrateLegacyTrash(root, dest);

    expect(moved).toBe(1);
    expect(failed).toBe(1);
    // 有失败就保留原目录:可恢复数据绝不因为「搬不动」而消失
    expect(existsSync(join(root, LEGACY_TRASH_DIR, 'blocked.txt.1z'))).toBe(true);

    rmDir(dir);
  });
});
