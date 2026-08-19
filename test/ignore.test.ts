import { describe, expect, it } from 'vitest';
import { parseIgnoreRules, isIgnored } from '../src/ignore.js';

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
