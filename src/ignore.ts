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
 */
export function filterIndexedEntries(rules: IgnoreRule[], entries: IndexEntry[]): IndexEntry[] {
  return entries.filter((entry) => entry.deleted || !isIgnored(rules, entry.path, false));
}