import { describe, expect, it } from 'vitest';
import { compareFileState } from '../src/index.js';

function entry(version: Array<[string, number]>, size = 100, deleted = false) {
  return {
    path: 'docs/plan.md',
    version: new Map(version),
    size,
    deleted,
    blocks: [],
  };
}

describe('index conflict determination', () => {
  it('reports equal for identical versions', () => {
    const local = entry([
      ['dev-a', 2],
      ['dev-b', 1],
    ]);
    const remote = entry([
      ['dev-a', 2],
      ['dev-b', 1],
    ]);

    expect(compareFileState(local, remote)).toBe('equal');
  });

  it('reports local-newer when local dominates', () => {
    const local = entry([
      ['dev-a', 3],
      ['dev-b', 1],
    ]);
    const remote = entry([
      ['dev-a', 2],
      ['dev-b', 1],
    ]);

    expect(compareFileState(local, remote)).toBe('local-newer');
  });

  it('reports remote-newer when remote dominates', () => {
    const local = entry([
      ['dev-a', 2],
      ['dev-b', 1],
    ]);
    const remote = entry([
      ['dev-a', 2],
      ['dev-b', 2],
    ]);

    expect(compareFileState(local, remote)).toBe('remote-newer');
  });

  it('reports conflict for concurrent versions', () => {
    const local = entry([
      ['dev-a', 3],
      ['dev-b', 1],
    ]);
    const remote = entry([
      ['dev-a', 2],
      ['dev-b', 2],
    ]);

    expect(compareFileState(local, remote)).toBe('conflict');
  });

  it('treats a path absent locally as remote-newer (needs creation)', () => {
    const remote = entry([
      ['dev-a', 1],
    ]);

    expect(compareFileState(undefined, remote)).toBe('remote-newer');
  });

  it('treats a path absent remotely as local-newer (needs deletion)', () => {
    const local = entry([
      ['dev-a', 1],
    ]);

    expect(compareFileState(local, undefined)).toBe('local-newer');
  });
});
