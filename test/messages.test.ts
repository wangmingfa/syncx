import { describe, expect, it } from 'vitest';
import { encodeIndex, decodeIndex } from '../src/messages.js';

function entry(
  path: string,
  version: Array<[string, number]>,
  blocks: string[],
  size = 100,
  deleted = false,
) {
  return {
    path,
    version: new Map(version),
    size,
    deleted,
    blocks,
  };
}

describe('index message codec', () => {
  it('round-trips an entry list including tombstones and blocks', () => {
    const entries = [
      entry('docs/plan.md', [['dev-a', 2], ['dev-b', 1]], ['abc', 'def'], 200),
      entry('gone.txt', [['dev-b', 5]], [], 0, true),
    ];

    expect(decodeIndex(encodeIndex(entries))).toEqual(entries);
  });

  it('handles an empty index', () => {
    expect(decodeIndex(encodeIndex([]))).toEqual([]);
  });

  it('round-trips version vectors as maps, not arrays', () => {
    const entries = [entry('a.txt', [['dev-a', 3]], ['123'])];
    const decoded = decodeIndex(encodeIndex(entries));

    expect(decoded[0]!.version).toBeInstanceOf(Map);
    expect(decoded[0]!.version.get('dev-a')).toBe(3);
  });
});
