import { describe, expect, it } from 'vitest';
import { filterIndexedEntries } from '../src/ignore.js';

function entry(path: string, deleted = false) {
  return {
    path,
    version: new Map([['dev-a', 1]]),
    size: 10,
    deleted,
    blocks: ['abc'],
  };
}

describe('ignore rules integration', () => {
  it('drops ignored entries from the index before sync', () => {
    const rules = [
      { pattern: 'node_modules/', negated: false },
      { pattern: '*.log', negated: false },
    ];

    const filtered = filterIndexedEntries(rules, [
      entry('src/main.ts'),
      entry('node_modules/pkg/index.js'),
      entry('app.log'),
    ]);

    expect(filtered.map((e) => e.path)).toEqual(['src/main.ts']);
  });

  it('keeps entries un-ignored by a negation rule', () => {
    const rules = [
      { pattern: '*.log', negated: false },
      { pattern: 'keep.log', negated: true },
    ];

    const filtered = filterIndexedEntries(rules, [entry('keep.log'), entry('drop.log')]);

    expect(filtered.map((e) => e.path)).toEqual(['keep.log']);
  });

  it('keeps tombstones of ignored files so deletions propagate', () => {
    const rules = [{ pattern: '*.log', negated: false }];

    const filtered = filterIndexedEntries(rules, [entry('old.log', true)]);

    expect(filtered.map((e) => e.path)).toEqual(['old.log']);
  });

  /**
   * 硬忽略路径是上面那条语义的**唯一例外**:墓碑必须一起丢。墓碑是删除的载体,
   * 让 `.git/**` 的墓碑外推,等于命令对端把它的 `.git` 移进回收站——旧库里残留的
   * 一条墓碑就会在每次重连时重演一次(2026-09-15 事故中 A 的 .git 被删空即此形态)。
   */
  it('drops hard-ignored entries together with their tombstones', () => {
    const filtered = filterIndexedEntries([], [
      entry('.git/config'),
      entry('.git/config', true),
      entry('src/.git/HEAD', true),
      entry('.syncx-trash/notes.txt.1abc'),
      entry('.syncx-folder'),
      entry('src/main.ts'),
    ]);

    expect(filtered.map((e) => e.path)).toEqual(['src/main.ts']);
  });

  it('drops hard-ignored entries even when a negation rule un-ignores them', () => {
    const rules = [
      { pattern: '.git', negated: true },
      { pattern: '.git/', negated: true },
    ];

    const filtered = filterIndexedEntries(rules, [entry('.git/config'), entry('.github/ci.yml')]);

    expect(filtered.map((e) => e.path)).toEqual(['.github/ci.yml']);
  });
});
