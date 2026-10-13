import { describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rmDir } from './helpers.js';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseIgnoreRules } from '../src/ignore.js';
import { removeEmptyDirs, scanEmptyDirs } from '../src/empty-dirs.js';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'syncx-empty-'));
}

function mkDirs(root: string, ...rels: string[]): void {
  for (const rel of rels) mkdirSync(join(root, rel), { recursive: true });
}

function mkFile(root: string, rel: string, content = 'x'): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

/** chmod 000 在 Windows 上拦不住读取;root 身份跑测试时也拦不住 Unix(权限位对 root 无效)。 */
const LOCK_UNSUPPORTED = process.platform === 'win32' || (process.getuid?.() ?? -1) === 0;

describe('empty dir scan', () => {
  it('lists leaf and parent of an empty chain, beside a file-bearing sibling', () => {
    const root = tempRoot();
    try {
      mkDirs(root, 'a/b/c', 'empty2');
      mkFile(root, 'full/thing.txt');

      const res = scanEmptyDirs(root, []);
      expect(res.truncated).toBe(false);
      // 叶子 A 与「只装着 A」的父级 B 都要出现(需求原话:嵌套空文件夹全部列出)
      expect(res.dirs).toEqual(['a', 'a/b', 'a/b/c', 'empty2']);
    } finally {
      rmDir(root);
    }
  });

  it('a file anywhere in the subtree keeps the whole ancestor chain off the list', () => {
    const root = tempRoot();
    try {
      mkDirs(root, 'a/b/c', 'other');
      mkFile(root, 'a/b/c/deep.txt');

      expect(scanEmptyDirs(root, []).dirs).toEqual(['other']);
    } finally {
      rmDir(root);
    }
  });

  it('files inside ignored subtrees still count as content (node_modules reverse control)', () => {
    const root = tempRoot();
    try {
      const rules = parseIgnoreRules(['node_modules/']);
      // 反向对照:目录里只有 node_modules,而它装着文件 —— 不是空目录,不许列出,
      // 否则删除侧会去删一个塞满东西的目录
      mkFile(root, 'only-ignored/node_modules/index.js');
      // 忽略区为空:忽略目录自身不列出,父级仍是确凿的「无内容」
      mkDirs(root, 'ignored-empty/node_modules');

      expect(scanEmptyDirs(root, rules).dirs).toEqual(['ignored-empty']);
    } finally {
      rmDir(root);
    }
  });

  it('ignored directories are not reported themselves, even when empty', () => {
    const root = tempRoot();
    try {
      mkDirs(root, 'build/dist');

      // 命中忽略规则:整棵不列(不同步的东西不提示清理)
      expect(scanEmptyDirs(root, parseIgnoreRules(['build/'])).dirs).toEqual([]);
      // 对照:同一形状、未命中忽略规则时必须列出(证明上一条是规则起作用,不是形状)
      expect(scanEmptyDirs(root, parseIgnoreRules(['unrelated/'])).dirs).toEqual(['build', 'build/dist']);
    } finally {
      rmDir(root);
    }
  });

  it('nested shared roots are barriers: never entered, never listed, counted as content', () => {
    const root = tempRoot();
    try {
      mkDirs(root, 'wrap/sub-share/emptychild', 'plain');
      const nested = [join(root, 'wrap/sub-share')];

      // sub-share 是别的共享目录的地盘:它的空子目录不列;wrap 只装着它,也不列
      // (免得删 wrap 时动到别人的目录)
      expect(scanEmptyDirs(root, [], nested).dirs).toEqual(['plain']);

      // 外层共享根(本目录夹在别人的共享里)必须先被滤掉:它不约束本目录内部,
      // 不过滤的话 startsWith(外层根 + /) 会把每个子路径都判成「属于别的共享」,
      // 整次扫描瘫痪。传它进来应与无屏障扫描完全一致。
      expect(scanEmptyDirs(root, [], [dirname(root)]).dirs).toEqual([
        'plain',
        'wrap',
        'wrap/sub-share',
        'wrap/sub-share/emptychild',
      ]);
    } finally {
      rmDir(root);
    }
  });

  it.skipIf(LOCK_UNSUPPORTED)('treats an unreadable directory as content, conservatively', () => {
    const root = tempRoot();
    try {
      mkDirs(root, 'locked/inside', 'open');
      chmodSync(join(root, 'locked'), 0o000);

      // 读不动就无法证明为空 → 自身与整条祖先链都不列,只有确证为空的 open 列出
      expect(scanEmptyDirs(root, []).dirs).toEqual(['open']);
    } finally {
      chmodSync(join(root, 'locked'), 0o755);
      rmDir(root);
    }
  });

  it('truncates at the limit and flags it', () => {
    const root = tempRoot();
    try {
      mkDirs(root, 'e1/e2/e3');

      const res = scanEmptyDirs(root, [], [], 2);
      expect(res.dirs).toHaveLength(2);
      expect(res.truncated).toBe(true);

      const full = scanEmptyDirs(root, [], [], 10);
      expect(full.truncated).toBe(false);
    } finally {
      rmDir(root);
    }
  });
});

describe('empty dir delete', () => {
  it('deletes a selected chain bottom-up in one request', () => {
    const root = tempRoot();
    try {
      mkDirs(root, 'a/b/c');

      // 父子都被勾选:深层先删,父级复核自然放行
      const results = removeEmptyDirs(root, ['a', 'a/b'], []);
      expect(results).toEqual([
        { path: 'a/b', ok: true },
        { path: 'a', ok: true },
      ]);
      expect(existsSync(join(root, 'a'))).toBe(false);
    } finally {
      rmDir(root);
    }
  });

  it('refuses a directory that gained a file after the scan, deleting nothing', () => {
    const root = tempRoot();
    try {
      mkDirs(root, 'a/b');
      expect(scanEmptyDirs(root, []).dirs).toEqual(['a', 'a/b']);

      // 扫描与删除之间外面塞进文件(用户在别的窗口操作之类)
      writeFileSync(join(root, 'a/b/hello.txt'), 'hi');

      const results = removeEmptyDirs(root, ['a'], []);
      expect(results).toEqual([{ path: 'a', ok: false, reason: '目录内现在有文件,跳过' }]);
      // 文件原封不动、目录也还在 —— 只 rmdir、从不 unlink
      expect(existsSync(join(root, 'a/b/hello.txt'))).toBe(true);
    } finally {
      rmDir(root);
    }
  });

  it('deletes exactly what the scan listed, leaving ignored subtrees alone', () => {
    const root = tempRoot();
    try {
      mkDirs(root, 'x/y', 'z', 'vendor/pkg');
      mkFile(root, 'has/content.txt');
      const rules = parseIgnoreRules(['vendor/']);

      const scan = scanEmptyDirs(root, rules);
      expect(scan).toEqual({ dirs: ['x', 'x/y', 'z'], truncated: false });

      const results = removeEmptyDirs(root, [...scan.dirs], rules);
      expect(results.every((r) => r.ok)).toBe(true);
      expect(existsSync(join(root, 'x'))).toBe(false);
      expect(existsSync(join(root, 'z'))).toBe(false);
      // 忽略区与含文件的目录都不在删除范围
      expect(existsSync(join(root, 'vendor/pkg'))).toBe(true);
      expect(existsSync(join(root, 'has/content.txt'))).toBe(true);
    } finally {
      rmDir(root);
    }
  });

  it('refuses escaping and absolute paths per entry without poisoning the rest', () => {
    const root = tempRoot();
    try {
      mkDirs(root, 'good1', 'good2');

      const results = removeEmptyDirs(root, ['good1', '../evil', '/etc', 'good2'], []);
      const byPath = new Map(results.map((r) => [r.path, r]));
      expect(byPath.get('../evil')).toMatchObject({ ok: false, reason: '路径越出共享目录' });
      expect(byPath.get('/etc')).toMatchObject({ ok: false, reason: '必须是共享目录内的相对路径' });
      expect(byPath.get('good1')?.ok).toBe(true);
      expect(byPath.get('good2')?.ok).toBe(true);
      expect(existsSync(join(root, 'good1'))).toBe(false);
      expect(existsSync(join(root, 'good2'))).toBe(false);
    } finally {
      rmDir(root);
    }
  });

  it('treats already-gone paths as done (idempotent)', () => {
    const root = tempRoot();
    try {
      expect(removeEmptyDirs(root, ['not-there'], [])).toEqual([{ path: 'not-there', ok: true }]);
    } finally {
      rmDir(root);
    }
  });

  it('refuses the shared root itself', () => {
    const root = tempRoot();
    try {
      const results = removeEmptyDirs(root, [''], []);
      expect(results).toEqual([{ path: '', ok: false, reason: '不能删除共享目录本身' }]);
      expect(existsSync(root)).toBe(true);
    } finally {
      rmDir(root);
    }
  });

  it('refuses ignored paths and nested shared roots', () => {
    const root = tempRoot();
    try {
      mkDirs(root, 'build/dist', '.git', 'wrap/other');
      const rules = parseIgnoreRules(['build/', '!.git', '!.git/', '!.git/**']);
      const BLOCKED = '已不在同步范围内(被忽略规则命中),跳过';

      // 忽略规则命中(含硬忽略的 .git):结构上就不是清理工具的管辖范围
      expect(removeEmptyDirs(root, ['build'], rules, [])).toEqual([{ path: 'build', ok: false, reason: BLOCKED }]);
      expect(removeEmptyDirs(root, ['.git'], rules, [])).toEqual([{ path: '.git', ok: false, reason: BLOCKED }]);

      // 别的共享根:本身拒;只包着它的父目录也被复核挡住(不能连别人的地盘一起删)
      const nested = [join(root, 'wrap/other')];
      expect(removeEmptyDirs(root, ['wrap/other'], [], nested)).toEqual([
        { path: 'wrap/other', ok: false, reason: '属于其它共享目录,跳过' },
      ]);
      expect(removeEmptyDirs(root, ['wrap'], [], nested)).toEqual([
        { path: 'wrap', ok: false, reason: '目录内还有其它共享目录,跳过' },
      ]);
      expect(existsSync(join(root, 'wrap/other'))).toBe(true);
    } finally {
      rmDir(root);
    }
  });

  it('fails every path with a reason when the shared root is gone', () => {
    const root = tempRoot();
    mkDirs(root, 'a');
    rmDir(root);

    expect(removeEmptyDirs(root, ['a', 'b'], [])).toEqual([
      { path: 'a', ok: false, reason: '共享目录不存在或不可读' },
      { path: 'b', ok: false, reason: '共享目录不存在或不可读' },
    ]);
  });
});
