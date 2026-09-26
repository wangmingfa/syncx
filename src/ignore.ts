import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { IndexEntry } from './index.js';

export interface IgnoreRule {
  pattern: string;
  negated: boolean;
}

/**
 * Parse gitignore-style lines into rules. Comments (#) and blank lines are
 * skipped; a leading `!` marks a negation rule.
 */
export function parseIgnoreRules(lines: string[]): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of lines) {
    let line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;

    let negated = false;
    if (line.startsWith('!')) {
      negated = true;
      line = line.slice(1);
    }
    if (line === '') continue;

    rules.push({ pattern: line, negated });
  }
  return rules;
}

/**
 * Convert a gitignore-style pattern to a RegExp matching the FULL relative
 * path. Implements the same semantics as gitignore:
 * - `*` matches any characters except `/`
 * - `**` matches zero or more path segments but only when adjacent to `/`
 * - `?` matches a single non-`/` character
 * - otherwise characters are literal
 *
 * Example patterns (written without a literal star-slash sequence so the
 * parser does not misread the JSDoc):
 *   a/STAR-STAR/b  matches a/b, a/x/b, a/x/y/b
 *   a/STAR-STAR    matches a/foo, a/foo/bar
 *   STAR.log       matches app.log, src/app.log
 *   /root.txt      matches only root.txt at the root
 */
function buildRegex(pattern: string): RegExp {
  // 单独的 ** :匹配任意层级与文件名
  if (pattern === '**') return /^.*$/;
  let body = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] ?? '';
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // 跳过 "**" 的第二个 *
        i++;
        const next = pattern[i + 1] ?? '';
        // prev 是第一个 * 之前的字符(现在 i 指向第二个 *,前两个位置才是第一个 * 之前的字符)
        const prev = i >= 2 ? pattern[i - 2] ?? '' : '';
        // atStart:模式以 "**" 开头
        const atStart = i === 1;
        if (prev === '/' && next === '/') {
          // 中间 ** (a/**/b):匹配零个或多个中间目录;各组不含前导斜杠,
          // 因为分隔斜杠已由字面量输出(a/ 与末尾 /b)
          body += '([^\\/]+\\/)*';
          i++; // 吃掉紧跟的 /
        } else if (atStart && next === '/') {
          // 开头 ** (**/foo):匹配任意深度下的 foo,零级也匹配
          body += '([^\\/]+\\/)*';
          i++; // 吃掉紧跟的 /
        } else if (prev === '/' && i + 1 === pattern.length) {
          // 末尾 ** (a/**):前面的 / 已作为字面量输出,这里匹配任意后缀
          body += '.*';
        } else if (atStart && i + 1 === pattern.length) {
          // ** 单独出现(已在函数开头处理),此处兜底
          body += '.*';
        } else {
          // 不在分隔符旁的 **,与单 * 等价(如 a*b 这种文件名模式)
          body += '[^\\/]*';
        }
      } else {
        body += '[^\\/]*';
      }
    } else if (c === '?') {
      body += '[^/]';
    } else if ('.+()[]{}^$|\\'.includes(c)) {
      body += `\\${c}`;
    } else {
      body += c;
    }
  }
  return new RegExp(`^${body}$`);
}

/**
 * 编译结果缓存。忽略判定要对**每个**路径逐条规则试用,而 toRegex 原先每判一条
 * 规则就重新构造一次 RegExp:一个 100 行的 .gitignore 配一个几千条目的目录,
 * 一轮扫描就是几十万次正则构造。模式串的取值集合由规则文本决定(有界),缓存
 * 不会无限增长;忽略规则变更只是换一批模式串,旧条目留给 GC。
 */
const regexCache = new Map<string, RegExp>();

function toRegex(pattern: string): RegExp {
  const cached = regexCache.get(pattern);
  if (cached !== undefined) return cached;
  const built = buildRegex(pattern);
  regexCache.set(pattern, built);
  return built;
}

/** 不含通配符的模式:可以走字符串相等,省掉正则调用(目录规则命中率高的常见情形)。 */
const LITERAL_PATTERN = /^[^*?[\]\\]+$/;

/** 相对路径的目录层:一律以 '/' 与 '\' 双分隔符切分,兼容对端可能传来的反斜杠。 */
function splitSegments(relPath: string): string[] {
  return relPath.split(/[\\/]/);
}

/**
 * 单条规则是否命中该相对路径(判定细节与 gitignore 一致,见上方 toRegex 注释)。
 *
 * `isDir` 只在目录规则下起作用:它决定相对路径的**最后一段**能否被当作
 * 「被忽略的目录自身」(`node_modules/` 不匹配名为 node_modules 的文件)。
 */
function ruleMatches(rule: IgnoreRule, relPath: string, isDir: boolean): boolean {
  const dirOnly = rule.pattern.endsWith('/');
  const anchored = rule.pattern.startsWith('/');
  let pattern = rule.pattern;
  if (dirOnly) pattern = pattern.slice(0, -1);
  if (anchored) pattern = pattern.slice(1);
  if (pattern === '') return false;

  const hasSlash = pattern.includes('/');
  const re = toRegex(pattern);
  // 含斜杠或锚定的模式相对 .gitignore 所在目录定位,匹配**完整**相对路径;
  // 无斜杠模式可以匹配**任意层级**的同名条目(这两条是 gitignore 的核心差异)
  const fullPathMode = anchored || hasSlash;
  const matchFull = (p: string): boolean =>
    fullPathMode ? re.test(p) : splitSegments(p).some((segment) => re.test(segment));

  if (!dirOnly) return matchFull(relPath);

  /**
   * 目录规则:gitignore 里「忽略一个目录」等价于「忽略它下面的全部内容」,
   * 而这里拿到的是**文件**的相对路径,所以必须逐级回溯目录前缀才能对上 ——
   * `admin/node_modules/pkg/index.js` 被 `node_modules/` 命中,靠的是前缀
   * `admin/node_modules`。
   *
   * 之前这个分支用的是字面量前缀比较(`relPath === pattern ||
   * relPath.startsWith(pattern + '/')`),它只认**根级**目录,于是
   * `node_modules/` 挡不住 `admin/node_modules/**`(2026-09-21 实测:
   * .gitignore 里明明有 node_modules/,子目录里的 node_modules 照旧被同步),
   * 顺带也让目录规则里的通配符(如 `**` 加 `/dist/`、`node_` 打头的模式)永远不生效。
   */
  const segments = splitSegments(relPath);
  // 是目录才算「目录自身」;是文件时最后一段不能参与(见函数注释)
  const dirDepth = isDir ? segments.length : segments.length - 1;

  if (fullPathMode) {
    for (let i = 1; i <= dirDepth; i++) {
      if (re.test(segments.slice(0, i).join('/'))) return true;
    }
    return false;
  }
  if (LITERAL_PATTERN.test(pattern)) {
    for (let i = 0; i < dirDepth; i++) {
      if (segments[i] === pattern) return true;
    }
    return false;
  }
  for (let i = 0; i < dirDepth; i++) {
    if (re.test(segments[i] ?? '')) return true;
  }
  return false;
}

/**
 * Decide whether a relative path is ignored. Later rules override earlier
 * ones; a matching negation rule un-ignores the path.
 *
 * `isDir` 表示该相对路径指向的是目录还是文件:目录规则(以 `/` 结尾的模式)
 * 只在「目标确实是目录」时匹配最后一段 —— 即 `node_modules/` 不匹配名为
 * node_modules 的**文件**,但匹配任意层级名为 node_modules 的**目录**及其下全部内容。
 * 调用方必须传对(`scanner` 按 dirent 判定、`peer`/索引类入口按文件传 false)。
 */
export function isIgnored(rules: IgnoreRule[], relPath: string, isDir: boolean): boolean {
  let ignored = false;

  for (const rule of rules) {
    if (ruleMatches(rule, relPath, isDir)) ignored = !rule.negated;
  }

  return ignored;
}

/**
 * 找出决定该路径「被忽略」的那条规则(最后一条命中的非负向规则),未命中返回
 * undefined。语义与 isIgnored 严格等价(返回 undefined ⟺ isIgnored 为 false),
 * 存在的意义是**能说出是哪一行挡住了** —— 内容对比功能据此把「对端没有这个文件」
 * 与「本机按规则不收它」区分开,否则用户会把规则使然的差异当成同步故障去查。
 *
 * 注意:此函数只覆盖 .gitignore/.syncxignore 语义,硬忽略(见 isHardIgnored)
 * 是独立的、不可解除的闸门,调用方需要时另行判定。
 */
export function matchIgnoreRule(rules: IgnoreRule[], relPath: string, isDir = false): IgnoreRule | undefined {
  let matched: IgnoreRule | undefined;
  for (const rule of rules) {
    if (ruleMatches(rule, relPath, isDir)) matched = rule;
  }
  return matched && !matched.negated ? matched : undefined;
}

/**
 * Drop ignored entries from an index before it is exchanged or scanned.
 * Tombstones are always kept so that deletions of previously-synced files
 * still propagate even after an ignore rule was added.
 *
 * 例外:硬忽略路径(见 HARD_IGNORE_NAMES)**连墓碑一起丢**。墓碑是删除的载体,
 * 让硬忽略路径的墓碑外推会反过来伤到自己——对端收到墓碑后会把本机索引里的同名
 * 条目判为「已删除」并执行删除,于是对端的 `.git` 被移进回收站。一旦双方都残留过
 * 这类墓碑,删除就会在两端之间来回传播,伤疤传染(2026-09-15 事故即此形态)。
 * 用户级规则的墓碑语义保持不变(见上方注释),两者刻意区别对待。
 */
export function filterIndexedEntries(rules: IgnoreRule[], entries: IndexEntry[]): IndexEntry[] {
  return entries.filter((entry) => {
    if (isHardIgnored(entry.path)) return false;
    return entry.deleted || !isIgnored(rules, entry.path, false);
  });
}
/**
 * 内置默认忽略:版本控制与同步自身元数据目录。优先级最低(在 .gitignore /
 * .syncxignore 之前并入),用户可用 .syncxignore 的负向规则(如 `!.git`)覆盖
 * —— 注意「可覆盖」只对**普通内置行**成立:这些名字同时还在硬忽略名单里
 * (HARD_IGNORE_NAMES),实际同步时仍会被硬闸门挡住。保留本行是为了让忽略规则
 * 自解释、并让 .gitignore 这类外部语义保持直观。
 *
 * 目的:避免把 .git 等 VCS 内部当成普通目录同步——双向同步下,残缺端(目录内容
 * 不完整的一方)会把缺失的 .git 文件生成墓碑广播给完整端,把完整端的 .git 搅坏/
 * 删空(2026-09-15 真实事故:A 的 mvm .git 被双向同步删成空目录,git 仓库报废)。
 * `.syncx-trash` 是删除回收站目录,必须忽略,否则会被当成待同步内容无限循环。
 * `.syncx-folder` 是共享根的挂载标记(见 marker.ts),同样必须忽略,否则标记文件
 * 本身会被同步/生成墓碑,反而破坏「标记存在 = 目录可信」的判定。
 */
export const BUILTIN_IGNORE_LINES = ['.git', '.hg', '.svn', '.syncx-trash', '.syncx-folder'];

/**
 * 硬忽略名单:**任何配置都无法解除**的路径(目录或文件名)。与 BUILTIN_IGNORE_LINES
 * 内容重合但语义不同——那一组是「默认值」,可被 `.syncxignore` 的负向规则覆盖;
 * 这一组是「硬闸门」,`.gitignore` / `.syncxignore` 里写 `!.git` 也解不开。
 *
 * 判定按**路径段**做,不分大小写:`'.git/config'`、`'src/.git/x'` 命中,而
 * `'.github/workflows/ci.yml'` 不命中(段是 `.github`,不是 `.git`)。大小写不敏感是
 * 刻意的:Windows 与 macOS 默认文件系统大小写不敏感,`.GIT` 与 `.git` 是同一个目录,
 * 只按小写匹配会被对端用 `.GIT/config` 绕过。
 *
 * 四处独立闸门共用它(见各自注释):scanner 不扫、filterIndexedEntries 不进内存索引、
 * peer 不收不发、executor 不落盘。任何一处单独失效都还有其余三道兜底。
 */
export const HARD_IGNORE_NAMES = ['.git', '.hg', '.svn', '.syncx-trash', '.syncx-folder'];

const HARD_IGNORE_SET = new Set(HARD_IGNORE_NAMES);

/**
 * syncx 冲突副本的命名(生成逻辑见 executor 的 preserveLocalAsConflict / applyConflict):
 *   <原名去扩展名>.sync-conflict-<ts36>[-<seq36>]-<10位base32设备ID>[.扩展名]
 * 设备 ID 是纯 base32(A-Z2-7)不含连字符,所以该模式可以无歧义匹配/反解。
 *
 * 冲突副本是「本机当时输掉的那份内容」——设备本机的恢复残骸,对别的机器没有意义。
 * 让它参与同步会在多设备间互相流传、副本撞副本生成双层套娃(2026-09-23 实测
 * 三台设备风暴出 934 个副本、467 个双层命名),故列为硬忽略:不进索引、不同步、
 * 不可被用户规则解除。收件箱/清理走磁盘直扫(conflicts.ts),不受此影响。
 */
export const CONFLICT_COPY_RE = /^(.+)\.sync-conflict-[0-9a-z]+(?:-[0-9a-z]+)?-([A-Z2-7]{10})(\.[^./]*)?$/;

/** 文件名是否为 syncx 冲突副本(按单段 basename 判定)。 */
export function isConflictCopyName(name: string): boolean {
  return CONFLICT_COPY_RE.test(name);
}

/**
 * 相对路径中任一段命中硬忽略名单(大小写不敏感,兼容 '\' 分隔符),
 * 或 basename 符合冲突副本命名。
 * 路径段比较而非子串比较:`.github` / `.svnignore` 这类前缀相同但段不同的名字不受影响。
 */
export function isHardIgnored(relPath: string): boolean {
  for (const segment of relPath.split(/[\\/]/)) {
    if (segment === '') continue;
    if (HARD_IGNORE_SET.has(segment.toLowerCase())) return true;
    if (isConflictCopyName(segment)) return true;
  }
  return false;
}

/**
 * 同步闸门:硬忽略优先且不可解除,其余按 gitignore 语义(后读规则覆盖先读)。
 * scanner 与 peer 判定「这个路径参不参与同步」一律走这里,不要直接用 isIgnored——
 * 后者是纯 gitignore 语义,负向规则能把它翻转,拿来做同步决策就等于给硬忽略开后门。
 */
export function isIgnoredPath(rules: IgnoreRule[], relPath: string, isDir: boolean): boolean {
  return isHardIgnored(relPath) || isIgnored(rules, relPath, isDir);
}

/**
 * 读取一个共享目录的忽略规则行(按优先级从低到高排列,后读的规则可覆盖先读的):
 * 0. 内置默认忽略(见 BUILTIN_IGNORE_LINES,永不抛错、始终并入)
 * 1. `.gitignore` — 仅当 useGitignore 为 true(目录配置缺省即开启)时并入
 * 2. `.syncxignore` — syncx 自己的忽略文件,优先级最高,可用 `!` 负向规则覆盖前两者
 * 两个文件都不存在或不可读时仅返回内置默认忽略,不抛错(目录可能刚创建)。
 *
 * 注意:这里返回的只是**规则文本**,负向规则在文本层面确实能覆盖内置行;真正参与
 * 同步判定时必须走 isIgnoredPath(含硬忽略闸门),否则 `!.git` 会把 .git 重新放开。
 */
export function readFolderIgnoreLines(folderPath: string, useGitignore: boolean): string[] {
  return composeIgnoreLines(folderPath, useGitignore, readSyncxIgnoreLines(folderPath));
}

/**
 * 组装完整规则文本:内置默认 + `.gitignore`(按配置)+ 给定的 `.syncxignore` 行。
 * 与 readFolderIgnoreLines 同一优先级顺序(后者覆盖前者),供「忽略规则编辑器」
 * 用**未保存的草稿行**预测生效结果,而不是必须先落盘。
 */
export function composeIgnoreLines(folderPath: string, useGitignore: boolean, syncxLines: string[]): string[] {
  const lines: string[] = [...BUILTIN_IGNORE_LINES];
  if (useGitignore) {
    try {
      lines.push(...readFileSync(join(folderPath, '.gitignore'), 'utf8').split('\n'));
    } catch {
      // 无 .gitignore
    }
  }
  lines.push(...syncxLines);
  return lines;
}

/** 读 `.syncxignore` 的原始用户规则行(编辑器数据源;不含内置与 .gitignore)。 */
export function readSyncxIgnoreLines(folderPath: string): string[] {
  try {
    const text = readFileSync(join(folderPath, '.syncxignore'), 'utf8').replace(/\r\n/g, '\n');
    if (text === '') return [];
    // 去掉文件尾换行 split 出的末尾空行:编辑器回填后保存不应让行数单调增长
    if (text.endsWith('\n')) return text.slice(0, -1).split('\n');
    return text.split('\n');
  } catch {
    return [];
  }
}

/** 写 `.syncxignore`(编辑器落盘目标)。行尾统一 LF;空数组写出空文件(=清空)。 */
export function writeSyncxIgnoreLines(folderPath: string, lines: string[]): void {
  const clean = lines.map((l) => l.replace(/\r/g, '').replace(/[ \t]+$/, ''));
  writeFileSync(join(folderPath, '.syncxignore'), clean.length > 0 ? clean.join('\n') + '\n' : '', 'utf8');
}

/** 忽略判定解释(测试器返回值):是否被忽略、由谁决定。 */
export interface IgnoreVerdict {
  ignored: boolean;
  /** 命中硬忽略闸门(.git/.hg/.svn/同步元数据/冲突副本),任何规则都解不开。 */
  hard: boolean;
  /** 决定「忽略」的那条规则文本(最后命中的非负向规则)。 */
  rule?: string;
  /** 决定「放行」的那条负向规则文本(如 `!logs/`,最后命中的 `!` 规则)。 */
  negatedRule?: string;
}

/**
 * 判定路径并**解释命中来源**:与 isIgnored 的 last-match-wins 严格同序
 * (逐条扫过所有规则,记住最后命中的一条),额外给出硬忽略闸门结果。
 * 忽略规则编辑器的实时测试器用它回答「粘这条路径进来,到底哪一行挡住了它」。
 */
export function explainIgnore(rules: IgnoreRule[], relPath: string, isDir: boolean): IgnoreVerdict {
  let last: IgnoreRule | undefined;
  for (const rule of rules) {
    if (ruleMatches(rule, relPath, isDir)) last = rule;
  }
  const hard = isHardIgnored(relPath);
  const verdict: IgnoreVerdict = { ignored: hard || (last ? !last.negated : false), hard };
  if (last && !last.negated) verdict.rule = last.pattern;
  if (last && last.negated) verdict.negatedRule = last.pattern;
  return verdict;
}
