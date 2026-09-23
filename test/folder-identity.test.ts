import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rmDir } from './helpers.js';
import {
  LEGACY_FOLDER_MARKER,
  checkFolderIdentity,
  compareIdentity,
  readFolderIdentity,
  removeLegacyFolderMarker,
} from '../src/folder-identity.js';

/**
 * 共享目录身份指纹(dev + ino)。
 *
 * 这层替代了旧版写在共享根里的 `.syncx-folder` 标记文件:标记文件直观,却会在用户的
 * 共享目录里留下常驻痕迹(被 git status 报成未跟踪文件)。指纹的作用不变——区分
 * 「盘未挂载 / 目录被整体清空」与「用户确实删光了文件」——而且还更强:换盘、重新挂载、
 * 目录被删了重建都会改变 dev/ino,而「同一个路径上换了另一块盘」标记文件认不出。
 */
function tempDir(prefix = 'syncx-fid-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('readFolderIdentity', () => {
  it('returns dev + ino for an existing directory', () => {
    const dir = tempDir();
    const identity = readFolderIdentity(dir);
    expect(identity).not.toBeNull();
    // 十进制字符串:JSON 无法序列化 BigInt,且部分文件系统的 inode 超过 2^53
    expect(identity?.dev).toMatch(/^\d+$/);
    expect(identity?.ino).toMatch(/^\d+$/);
    rmDir(dir);
  });

  it('is stable across calls for the same directory', () => {
    const dir = tempDir();
    const sub = join(dir, 'share');
    mkdirSync(sub);
    expect(readFolderIdentity(sub)).toEqual(readFolderIdentity(sub));
    rmDir(dir);
  });

  it('returns null for a missing path or a non-directory', () => {
    const dir = tempDir();
    const file = join(dir, 'a.txt');
    writeFileSync(file, 'x');
    expect(readFolderIdentity(join(dir, 'does-not-exist'))).toBeNull();
    expect(readFolderIdentity(file)).toBeNull();
    rmDir(dir);
  });
});

describe('checkFolderIdentity', () => {
  it('reports ok when the recorded identity matches', () => {
    const dir = tempDir();
    expect(checkFolderIdentity(dir, readFolderIdentity(dir) ?? undefined)).toBe('ok');
    rmDir(dir);
  });

  it('reports changed when dev/ino differ (换盘 / 重新挂载 / 目录被重建)', () => {
    const dir = tempDir();
    expect(checkFolderIdentity(dir, { dev: '1', ino: '2' })).toBe('changed');
    rmDir(dir);
  });

  it('reports missing when the path is gone', () => {
    const dir = tempDir();
    const gone = join(dir, 'unmounted');
    expect(checkFolderIdentity(gone, { dev: '1', ino: '2' })).toBe('missing');
    rmDir(dir);
  });

  it('reports unknown (never ok) when nothing was recorded', () => {
    const dir = tempDir();
    // 未记录指纹时宁可退化到结构守卫,也不凭空信任
    expect(checkFolderIdentity(dir, undefined)).toBe('unknown');
    rmDir(dir);
  });
});

describe('compareIdentity (纯比对,重挂 vs 换盘)', () => {
  it('ok when both dev and ino match', () => {
    expect(compareIdentity({ dev: '65115', ino: '210052' }, { dev: '65115', ino: '210052' })).toBe('ok');
  });

  it('remounted when only dev changed (同一磁盘重新挂载的典型指纹)', () => {
    // 真实现场:Linux 设备重启后磁盘重枚举,dev 65114→65115 而 ino 不变
    expect(compareIdentity({ dev: '65115', ino: '210052' }, { dev: '65114', ino: '210052' })).toBe('remounted');
  });

  it('changed when ino differs (目录被重建 / 换了别的盘)', () => {
    expect(compareIdentity({ dev: '65115', ino: '999' }, { dev: '65114', ino: '210052' })).toBe('changed');
    expect(compareIdentity({ dev: '65115', ino: '999' }, { dev: '65115', ino: '210052' })).toBe('changed');
  });
});

describe('removeLegacyFolderMarker', () => {
  it('deletes the marker syncx wrote', () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, LEGACY_FOLDER_MARKER),
      '此文件由 syncx 生成,用于确认该共享目录已正确挂载/内容可信。\n',
    );
    expect(removeLegacyFolderMarker(dir)).toBe(true);
    expect(existsSync(join(dir, LEGACY_FOLDER_MARKER))).toBe(false);
    rmDir(dir);
  });

  it('deletes a zero-byte leftover', () => {
    const dir = tempDir();
    writeFileSync(join(dir, LEGACY_FOLDER_MARKER), '');
    expect(removeLegacyFolderMarker(dir)).toBe(true);
    rmDir(dir);
  });

  it('leaves a user file with the same name but unrelated content alone', () => {
    const dir = tempDir();
    const path = join(dir, LEGACY_FOLDER_MARKER);
    writeFileSync(path, '我自己放的文件,别动它\n');
    expect(removeLegacyFolderMarker(dir)).toBe(false);
    expect(existsSync(path)).toBe(true);
    rmDir(dir);
  });

  it('reports false when there is nothing to remove', () => {
    const dir = tempDir();
    expect(removeLegacyFolderMarker(dir)).toBe(false);
    rmDir(dir);
  });
});
