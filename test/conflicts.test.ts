import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { rmDir } from './helpers.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConflictCopy, listConflictCopies, resolveConflictCopy } from '../src/conflicts.js';

// 副本命名与 executor.preserveLocalAsConflict 一致:
//   <base>.sync-conflict-<ts36>[-<seq36>]-<10位base32设备ID><ext>
const DEV = 'ABCDEFGH23';

describe('conflict copy name parsing', () => {
  it('parses the original path and source device', () => {
    const r = parseConflictCopy(`plan.sync-conflict-lxq8ab-${DEV}.md`);
    expect(r).not.toBeNull();
    expect(r!.originalPath).toBe('plan.md');
    expect(r!.deviceId).toBe(DEV);
  });

  it('parses the collision sequence variant', () => {
    const r = parseConflictCopy(`a.sync-conflict-lxq8ab-1f-${DEV}.txt`);
    expect(r!.originalPath).toBe('a.txt');
  });

  it('parses extensionless originals', () => {
    const r = parseConflictCopy(`LICENSE.sync-conflict-lxq8ab-${DEV}`);
    expect(r!.originalPath).toBe('LICENSE');
  });

  it('rejects ordinary names and bad device segments', () => {
    expect(parseConflictCopy('notes.txt')).toBeNull();
    expect(parseConflictCopy('a.sync-conflict-lxq8-loose.md')).toBeNull();
    expect(parseConflictCopy('a.sync-conflict-lxq8-abcd!e.md')).toBeNull();
  });
});

function tmpRoot(): { dir: string; root: string } {
  const dir = mkdtempSync(join(tmpdir(), 'syncx-conf-'));
  const root = join(dir, 'share');
  mkdirSync(root, { recursive: true });
  return { dir, root };
}

describe('listConflictCopies', () => {
  it('finds copies (nested included) and skips hard-ignored dirs', () => {
    const { dir, root } = tmpRoot();
    writeFileSync(join(root, 'a.txt'), 'remote-a');
    writeFileSync(join(root, `a.sync-conflict-lxq8-${DEV}.txt`), 'local-a');
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'plan.md'), 'p2');
    writeFileSync(join(root, 'docs', `plan.sync-conflict-lxq9-${DEV}.md`), 'p1');
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, '.git', `x.sync-conflict-lxaa-${DEV}.txt`), 'nope');

    const { conflicts, truncated } = listConflictCopies(root);
    expect(truncated).toBe(false);
    expect(conflicts.map((c) => c.copyPath).sort()).toEqual([
      'a.sync-conflict-lxq8-ABCDEFGH23.txt',
      'docs/plan.sync-conflict-lxq9-ABCDEFGH23.md',
    ]);
    const nested = conflicts.find((c) => c.copyPath.startsWith('docs/'))!;
    expect(nested.originalPath).toBe('docs/plan.md');
    expect(nested.deviceId).toBe(DEV);
    expect(nested.size).toBe(2);
    rmDir(dir);
  });

  it('returns empty for a clean tree', () => {
    const { dir, root } = tmpRoot();
    writeFileSync(join(root, 'ok.txt'), 'x');
    expect(listConflictCopies(root).conflicts).toEqual([]);
    rmDir(dir);
  });
});

describe('resolveConflictCopy', () => {
  it('keep-local: copies content back, archives the overwritten one, trashes the copy', () => {
    const { dir, root } = tmpRoot();
    const trash = join(dir, 'trash');
    const versions = join(dir, 'versions');
    writeFileSync(join(root, 'a.txt'), 'peer-version');
    writeFileSync(join(root, `a.sync-conflict-lxq8-${DEV}.txt`), 'my-version');

    resolveConflictCopy(root, trash, versions, `a.sync-conflict-lxq8-${DEV}.txt`, 'keep-local');

    // 原路径内容 = 本地副本
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('my-version');
    // 被覆盖的对端内容进了版本目录(命名可被版本弹窗认领)
    const backed = readdirSync(versions);
    expect(backed.length).toBe(1);
    expect(backed[0]!.startsWith('a.txt.syncx-v-')).toBe(true);
    expect(readFileSync(join(versions, backed[0]!), 'utf8')).toBe('peer-version');
    // 副本进了回收站,共享目录里不再残留
    expect(existsSync(join(root, `a.sync-conflict-lxq8-${DEV}.txt`))).toBe(false);
    expect(readdirSync(trash).length).toBe(1);
    rmDir(dir);
  });

  it('keep-local restores a missing original without needing a version backup', () => {
    const { dir, root } = tmpRoot();
    const trash = join(dir, 'trash');
    const versions = join(dir, 'versions');
    // 原文件已被对端删除的场景:只把副本内容写回,不留版本
    writeFileSync(join(root, `a.sync-conflict-lxq8-${DEV}.txt`), 'my-version');

    resolveConflictCopy(root, trash, versions, `a.sync-conflict-lxq8-${DEV}.txt`, 'keep-local');
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('my-version');
    expect(existsSync(versions)).toBe(false);
    rmDir(dir);
  });

  it('discard: original untouched, copy goes to trash', () => {
    const { dir, root } = tmpRoot();
    const trash = join(dir, 'trash');
    writeFileSync(join(root, 'a.txt'), 'peer-version');
    writeFileSync(join(root, `a.sync-conflict-lxq8-${DEV}.txt`), 'my-version');

    resolveConflictCopy(root, trash, undefined, `a.sync-conflict-lxq8-${DEV}.txt`, 'discard');
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('peer-version');
    expect(existsSync(join(root, `a.sync-conflict-lxq8-${DEV}.txt`))).toBe(false);
    expect(readdirSync(trash).length).toBe(1);
    rmDir(dir);
  });

  it('rejects non-conflict names and missing copies', () => {
    const { dir, root } = tmpRoot();
    const trash = join(dir, 'trash');
    expect(() => resolveConflictCopy(root, trash, undefined, 'a.txt', 'discard')).toThrow('不是冲突副本命名');
    expect(() =>
      resolveConflictCopy(root, trash, undefined, `ghost.sync-conflict-lxq8-${DEV}.txt`, 'discard'),
    ).toThrow('已不存在');
    rmDir(dir);
  });
});
