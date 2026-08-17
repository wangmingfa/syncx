import { describe, expect, it } from 'vitest';
import { createVersionVector, incrementVersion, compareVersions, mergeVersions } from '../src/version.js';

describe('version vector', () => {
  it('starts empty and counts per-device increments', () => {
    let v = createVersionVector();
    expect([...v.entries()]).toEqual([]);

    v = incrementVersion(v, 'dev-a');
    v = incrementVersion(v, 'dev-a');
    v = incrementVersion(v, 'dev-b');

    expect(v.get('dev-a')).toBe(2);
    expect(v.get('dev-b')).toBe(1);
  });

  it('orders vectors where one dominates the other', () => {
    const a = new Map([
      ['dev-a', 2],
      ['dev-b', 1],
    ]);
    const older = new Map([
      ['dev-a', 1],
      ['dev-b', 1],
    ]);

    expect(compareVersions(a, older)).toBe('a-newer');
    expect(compareVersions(older, a)).toBe('b-newer');
  });

  it('reports concurrent vectors that neither dominates', () => {
    const left = new Map([
      ['dev-a', 2],
      ['dev-b', 1],
    ]);
    const right = new Map([
      ['dev-a', 1],
      ['dev-b', 2],
    ]);

    expect(compareVersions(left, right)).toBe('concurrent');
  });

  it('treats identical vectors as equal', () => {
    const v = new Map([
      ['dev-a', 2],
      ['dev-b', 1],
    ]);
    expect(compareVersions(v, new Map(v))).toBe('equal');
  });

  it('merges to per-device maxima', () => {
    const left = new Map([
      ['dev-a', 2],
      ['dev-b', 1],
    ]);
    const right = new Map([
      ['dev-a', 1],
      ['dev-b', 3],
      ['dev-c', 1],
    ]);

    const merged = mergeVersions(left, right);
    expect(merged.get('dev-a')).toBe(2);
    expect(merged.get('dev-b')).toBe(3);
    expect(merged.get('dev-c')).toBe(1);
    expect(merged).not.toBe(left);
    expect(merged).not.toBe(right);
  });
});
