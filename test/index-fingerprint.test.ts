import { describe, expect, it } from 'vitest';
import { indexFingerprint } from '../src/index-fingerprint.js';
import type { IndexEntry } from '../src/index.js';

function entry(overrides: Partial<IndexEntry> & { path: string }): IndexEntry {
  return {
    version: new Map([['dev-a', 1]]),
    size: 100,
    deleted: false,
    blocks: ['b0'],
    ...overrides,
  };
}

describe('indexFingerprint', () => {
  it('same content in different order yields the same fingerprint', () => {
    const a = [entry({ path: 'a.txt' }), entry({ path: 'b.txt', blocks: ['b1'] })];
    const b = [entry({ path: 'b.txt', blocks: ['b1'] }), entry({ path: 'a.txt' })];
    expect(indexFingerprint(a)).toBe(indexFingerprint(b));
  });

  it('version vector key order does not matter', () => {
    const a = entry({ path: 'x', version: new Map([['dev-a', 2], ['dev-b', 5]]) });
    const b = entry({ path: 'x', version: new Map([['dev-b', 5], ['dev-a', 2]]) });
    expect(indexFingerprint([a])).toBe(indexFingerprint([b]));
  });

  it('mtime is excluded: same content with different mtimes matches', () => {
    // mtime 记的是「本机落盘时刻」,两台机器必然不同;混进指纹会让优化永不生效
    const a = entry({ path: 'x', mtime: 1000 });
    const b = entry({ path: 'x', mtime: 9999 });
    expect(indexFingerprint([a])).toBe(indexFingerprint([b]));
  });

  it('placeholder entries are excluded (same filter as encodeIndex)', () => {
    const real = entry({ path: 'x' });
    const withPlaceholder = [real, entry({ path: 'ondemand.bin', placeholder: true, blocks: ['zz'] })];
    expect(indexFingerprint(withPlaceholder)).toBe(indexFingerprint([real]));
  });

  it('content differences change the fingerprint', () => {
    const base = indexFingerprint([entry({ path: 'x' })]);
    expect(indexFingerprint([entry({ path: 'x', blocks: ['b1'] })])).not.toBe(base);
    expect(indexFingerprint([entry({ path: 'x', size: 200 })])).not.toBe(base);
    expect(indexFingerprint([entry({ path: 'x', deleted: true })])).not.toBe(base);
    expect(indexFingerprint([entry({ path: 'y' })])).not.toBe(base);
    expect(
      indexFingerprint([entry({ path: 'x', version: new Map([['dev-a', 2]]) })]),
    ).not.toBe(base);
    expect(
      indexFingerprint([entry({ path: 'x', cdh: ['c0'], clens: [100] })]),
    ).not.toBe(base);
  });

  it('cdc view presence/absence is visible, but empty index is stable', () => {
    const plain = entry({ path: 'x' });
    const withCdc = entry({ path: 'x', cdh: ['c0'], clens: [100] });
    expect(indexFingerprint([plain])).not.toBe(indexFingerprint([withCdc]));
    expect(indexFingerprint([])).toBe(indexFingerprint([]));
  });
});
