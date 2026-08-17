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

function toRegex(pattern: string): RegExp {
  let body = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] ?? '';
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        body += '.*';
        i++;
      } else {
        body += '[^/]*';
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
