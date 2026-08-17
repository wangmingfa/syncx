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
});
