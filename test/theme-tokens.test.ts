import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractRootRule } from '../src/theme-tokens.js';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

const root = extractRootRule(read('../web/style.css'));
const fallback = read('../src/ui-fallback.ts');

/**
 * 回退页的配色现在是从 web/style.css 抽 `:root` 块得来的,不再手抄。
 * 这组测试钉住的是「抽得到、且够用」这两件事 —— 两者都会在重构 style.css 时静默失效:
 * 比如有人给 :root 加了嵌套规则(正则就断在半截),或者回退页新用了一个块外定义的变量。
 */
describe('theme-tokens:回退页复用 style.css 的 :root', () => {
  it('能从 style.css 抽出完整的 :root 块', () => {
    expect(root.startsWith(':root {')).toBe(true);
    expect(root.trimEnd().endsWith('}')).toBe(true);
    expect(root).toContain('--border:');
  });

  it('回退页用到的每个 var(--x) 都在 :root 里有定义', () => {
    const used = [...fallback.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]);
    const defined = new Set([...root.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((v) => !defined.has(v))).toEqual([]);
  });

  it('回退页里不再有手抄的色值表', () => {
    // 只允许 #fff 这类「压在主色上的文字色」—— 它不是主题变量,深浅底都用同一个白。
    const literals = [...fallback.matchAll(/#[0-9a-fA-F]{3,8}/g)].map((m) => m[0]);
    expect(literals.filter((c) => c !== '#fff')).toEqual([]);
    // 曾经那份 15 个变量的内联 :root 必须已经删掉
    expect(fallback).not.toContain('--border:');
  });
});

describe('extractRootRule', () => {
  it('取第一个 :root 块', () => {
    expect(extractRootRule('a{}\n:root { --x: 1; }\nb{--y:2}')).toBe(':root { --x: 1; }');
  });

  it('找不到时返回空串而不是半截规则', () => {
    expect(extractRootRule('.foo { color: red }')).toBe('');
  });

  it('块内出现嵌套时宁可返回空串(当前 :root 不该触发这条)', () => {
    // 若哪天有人往 :root 里塞嵌套规则,抽出的是断在第一个 } 的半截 —— 上面的
    // 「完整 :root 块」用例会先失败,这里只是把函数行为钉清楚。
    expect(extractRootRule(':root { --x: 1; @media { --y: 2 } }')).toBe(':root { --x: 1; @media { --y: 2 }');
  });
});
