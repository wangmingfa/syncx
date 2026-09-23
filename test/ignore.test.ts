import { describe, expect, it } from 'vitest';
import { parseIgnoreRules, isIgnored, isHardIgnored, isIgnoredPath } from '../src/ignore.js';

describe('ignore rules', () => {
  it('parses patterns, comments and blank lines', () => {
    const rules = parseIgnoreRules([
      '# comment',
      '',
      'node_modules/',
      '*.log',
      '!keep.log',
      'build/**',
      'docs/*.tmp',
    ]);

    expect(rules.length).toBe(5);
    expect(rules[0]).toEqual({ pattern: 'node_modules/', negated: false });
    expect(rules[1]).toEqual({ pattern: '*.log', negated: false });
    expect(rules[2]).toEqual({ pattern: 'keep.log', negated: true });
    expect(rules[3]).toEqual({ pattern: 'build/**', negated: false });
    expect(rules[4]).toEqual({ pattern: 'docs/*.tmp', negated: false });
  });

  it('ignores a plain filename pattern', () => {
    const rules = parseIgnoreRules(['*.log']);
    expect(isIgnored(rules, 'app.log', false)).toBe(true);
    expect(isIgnored(rules, 'app.txt', false)).toBe(false);
  });

  it('matches patterns at any depth unless anchored', () => {
    const rules = parseIgnoreRules(['*.log']);
    expect(isIgnored(rules, 'a/b/c/deep.log', false)).toBe(true);
  });

  it('anchors a leading-slash pattern to the root', () => {
    const rules = parseIgnoreRules(['/root.txt']);
    expect(isIgnored(rules, 'root.txt', false)).toBe(true);
    expect(isIgnored(rules, 'sub/root.txt', false)).toBe(false);
  });

  it('ignores everything under a trailing-slash directory rule', () => {
    const rules = parseIgnoreRules(['node_modules/']);
    expect(isIgnored(rules, 'node_modules', true)).toBe(true);
    expect(isIgnored(rules, 'node_modules/pkg/index.js', false)).toBe(true);
    expect(isIgnored(rules, 'src/index.js', false)).toBe(false);
  });

  /**
   * 回归(2026-09-21 用户实测):.gitignore 里写了 `node_modules/`,子目录里的
   * node_modules 照旧被同步。根因:目录规则分支用的是字面量前缀比较
   * (`relPath === pattern || relPath.startsWith(pattern + '/')`),只认**根级**目录。
   * gitignore 里「无斜杠模式匹配任意层级」对目录规则同样成立 —— 期望值经
   * `git check-ignore` 逐条核对。
   */
  it('applies a trailing-slash directory rule at any depth', () => {
    const rules = parseIgnoreRules(['node_modules/']);

    // 嵌套目录自身与它下面的一切
    expect(isIgnored(rules, 'admin/node_modules', true)).toBe(true);
    expect(isIgnored(rules, 'admin/node_modules/estree-walker/package.json', false)).toBe(true);
    expect(isIgnored(rules, 'admin/node_modules/.vite/deps/vue.js', false)).toBe(true);
    expect(isIgnored(rules, 'a/b/c/node_modules/pkg/index.js', false)).toBe(true);

    // 目录规则不匹配同名**文件**(git:`node_modules/` 只匹配目录)
    expect(isIgnored(rules, 'admin/node_modules', false)).toBe(false);

    // 邻名不受牵连:段比较而非子串比较
    expect(isIgnored(rules, 'admin/node_modules_backup/x.js', false)).toBe(false);
    expect(isIgnored(rules, 'src/index.js', false)).toBe(false);
  });

  it('anchors a directory rule containing an internal slash to the shared root', () => {
    // 含斜杠 ⇒ 相对 .gitignore 所在目录(共享根)定位,更深的同名目录不受影响
    const rules = parseIgnoreRules(['admin/dist/']);
    expect(isIgnored(rules, 'admin/dist', true)).toBe(true);
    expect(isIgnored(rules, 'admin/dist/index.html', false)).toBe(true);
    expect(isIgnored(rules, 'a/b/admin/dist/x.js', false)).toBe(false);
  });

  it('supports wildcards inside a directory rule', () => {
    // 回归:目录分支此前做字面量比较,`**/tmp/` 这类模式永远匹配不上(死路径)
    const anyTmp = parseIgnoreRules(['**/tmp/']);
    expect(isIgnored(anyTmp, 'tmp', true)).toBe(true);
    expect(isIgnored(anyTmp, 'tmp/b.js', false)).toBe(true);
    expect(isIgnored(anyTmp, 'a/pkg/tmp/b.js', false)).toBe(true);
    expect(isIgnored(anyTmp, 'a/pkg/tmpfile/b.js', false)).toBe(false);

    const nodePrefix = parseIgnoreRules(['node_*/']);
    expect(isIgnored(nodePrefix, 'node_tools/x.js', false)).toBe(true);
    expect(isIgnored(nodePrefix, 'admin/node_tools/y.js', false)).toBe(true);
    expect(isIgnored(nodePrefix, 'admin/other/y.js', false)).toBe(false);
  });

  it('supports ** across directories', () => {
    const rules = parseIgnoreRules(['build/**']);
    expect(isIgnored(rules, 'build/out/app.js', false)).toBe(true);
    expect(isIgnored(rules, 'src/build/app.js', false)).toBe(false);
  });

  it('matches a/**/b against a/b (zero-level) and deeper paths', () => {
    const rules = parseIgnoreRules(['a/**/b']);
    // gitignore: **/ 可匹配零个或多个层级,a/**/b 应同时匹配 a/b 和 a/x/b
    expect(isIgnored(rules, 'a/b', false)).toBe(true);
    expect(isIgnored(rules, 'a/x/b', false)).toBe(true);
    expect(isIgnored(rules, 'a/x/y/b', false)).toBe(true);
    expect(isIgnored(rules, 'c/b', false)).toBe(false);
  });

  it('lets a negation rule un-ignore a path', () => {
    const rules = parseIgnoreRules(['*.log', '!keep.log']);
    expect(isIgnored(rules, 'keep.log', false)).toBe(false);
    expect(isIgnored(rules, 'other.log', false)).toBe(true);
  });

  it('ignores nothing for an empty rule set', () => {
    expect(isIgnored([], 'anything.txt', false)).toBe(false);
  });
});

/**
 * 硬忽略(VCS 与 syncx 自身元数据,见 docs/adr/0008)。这组用例是「不可解除」这一定性的
 * 守门人:任何一条挂掉都意味着某条路径能重新参与同步,而 2026-09-15 的 .git 损毁正是
 * 「按段匹配写漏」或「负向规则能翻转」这类小疏忽的后果。
 */
describe('hard ignore', () => {
  it('matches the reserved names as path segments, not as substrings', () => {
    // 命中:名字本身就是一段
    expect(isHardIgnored('.git')).toBe(true);
    expect(isHardIgnored('.git/config')).toBe(true);
    expect(isHardIgnored('.git/objects/ab/cdef')).toBe(true);
    expect(isHardIgnored('src/.git/index')).toBe(true); // 任意层级
    expect(isHardIgnored('.syncx-trash/a.txt.1abc')).toBe(true);
    expect(isHardIgnored('.syncx-folder')).toBe(true);
    expect(isHardIgnored('docs/.svn/entries')).toBe(true);

    // 不命中:前缀相同但**段**不同
    expect(isHardIgnored('.github/workflows/ci.yml')).toBe(false);
    expect(isHardIgnored('.syncxignore')).toBe(false);
    expect(isHardIgnored('docs/.svnignore')).toBe(false);
    expect(isHardIgnored('src/git/config')).toBe(false);
    expect(isHardIgnored('git')).toBe(false);
    expect(isHardIgnored('')).toBe(false);
  });

  it('hard-ignores syncx conflict copies (local residue never syncs/indexes)', () => {
    // 标准命名:<base>.sync-conflict-<ts36>-<10位base32设备ID><ext>
    expect(isHardIgnored('a.sync-conflict-lxq8-ABCDEFGH23.txt')).toBe(true);
    expect(isHardIgnored('docs/plan.sync-conflict-lxq9-2f-ABCDEFGH23.md')).toBe(true); // 带碰撞序号
    expect(isHardIgnored('LICENSE.sync-conflict-lxq8-ABCDEFGH23')).toBe(true); // 无扩展名
    // 不命中:设备 ID 段不合法(长度/字符集)、或缺 .sync-conflict- 标记
    expect(isHardIgnored('a.sync-conflict-lxq8-short.txt')).toBe(false);
    expect(isHardIgnored('a.sync-conflict-lxq8-lowercase1.txt')).toBe(false); // 小写非 base32
    expect(isHardIgnored('sync-conflict-notes.txt')).toBe(false);
    expect(isHardIgnored('normal.sync.txt')).toBe(false);
  });

  it('is case-insensitive, so a .GIT directory cannot sneak through', () => {
    // Windows 与 macOS 默认文件系统大小写不敏感:'.GIT' 与 '.git' 是同一个目录,
    // 只按小写匹配等于给对端留了一条「改个大小写就绕过」的路
    expect(isHardIgnored('.GIT/config')).toBe(true);
    expect(isHardIgnored('src/.Git/HEAD')).toBe(true);
    expect(isHardIgnored('.Syncx-Trash/x')).toBe(true);
  });

  it('tolerates backslash separators from Windows callers', () => {
    expect(isHardIgnored('.git\\config')).toBe(true);
    expect(isHardIgnored('src\\.git\\objects\\a')).toBe(true);
  });

  it('cannot be un-ignored by a negation rule', () => {
    // isIgnored 保持纯 gitignore 语义:负向规则确实能把它翻转……
    expect(isIgnored(parseIgnoreRules(['!.git']), '.git/config', false)).toBe(false);
    expect(isIgnored(parseIgnoreRules(['.git', '!.git']), '.git/config', false)).toBe(false);
    // ……但同步闸门必须仍然拦住:这就是硬忽略与普通内置行的区别
    expect(isIgnoredPath(parseIgnoreRules(['!.git']), '.git/config', false)).toBe(true);
    expect(isIgnoredPath(parseIgnoreRules(['.git', '!.git']), '.git/config', false)).toBe(true);
    expect(isIgnoredPath(parseIgnoreRules(['!*']), '.git', true)).toBe(true);
  });

  it('still applies ordinary gitignore semantics to everything else', () => {
    const rules = parseIgnoreRules(['*.log', '!keep.log', '.git']);
    expect(isIgnoredPath(rules, 'app.log', false)).toBe(true);
    expect(isIgnoredPath(rules, 'keep.log', false)).toBe(false);
    expect(isIgnoredPath(rules, 'src/main.ts', false)).toBe(false);
    // 内置行 + 负向覆盖:普通路径的「后读覆盖先读」不受硬忽略改动影响
    expect(isIgnoredPath(parseIgnoreRules(['built/**', '!built/keep.ts']), 'built/keep.ts', false)).toBe(false);
  });
});
