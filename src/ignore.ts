import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
function toRegex(pattern: string): RegExp {
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
 * Decide whether a relative path is ignored. Later rules override earlier
 * ones; a matching negation rule un-ignores the path. `isDir` follows the
 * gitignore convention for trailing-slash directory rules.
 */
export function isIgnored(rules: IgnoreRule[], relPath: string, isDir: boolean): boolean {
  let ignored = false;

  for (const rule of rules) {
    const dirOnly = rule.pattern.endsWith('/');
    const anchored = rule.pattern.startsWith('/');
    let pattern = rule.pattern;
    if (dirOnly) pattern = pattern.slice(0, -1);
    if (anchored) pattern = pattern.slice(1);

    const hasSlash = pattern.includes('/');
    const re = toRegex(pattern);
    let match: boolean;

    if (dirOnly) {
      // 目录规则:匹配目录本身及其下所有内容
      match = relPath === pattern || relPath.startsWith(`${pattern}/`);
    } else if (anchored || hasSlash) {
      // 含斜杠或锚定的模式匹配完整相对路径
      match = re.test(relPath);
    } else {
      // 无斜杠模式匹配任意层级的该文件名
      match = relPath.split('/').some((segment) => re.test(segment));
    }

    if (match) ignored = !rule.negated;
  }

  return ignored;
}

import type { IndexEntry } from './index.js';

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
 * 相对路径中任一段命中硬忽略名单(大小写不敏感,兼容 '\' 分隔符)。
 * 路径段比较而非子串比较:`.github` / `.svnignore` 这类前缀相同但段不同的名字不受影响。
 */
export function isHardIgnored(relPath: string): boolean {
  for (const segment of relPath.split(/[\\/]/)) {
    if (segment !== '' && HARD_IGNORE_SET.has(segment.toLowerCase())) return true;
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
  const lines: string[] = [...BUILTIN_IGNORE_LINES];
  if (useGitignore) {
    try {
      lines.push(...readFileSync(join(folderPath, '.gitignore'), 'utf8').split('\n'));
    } catch {
      // 无 .gitignore
    }
  }
  try {
    lines.push(...readFileSync(join(folderPath, '.syncxignore'), 'utf8').split('\n'));
  } catch {
    // 无 .syncxignore
  }
  return lines;
}
