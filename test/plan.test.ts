import { describe, expect, it } from 'vitest';
import { buildPlan } from '../src/plan.js';

function entry(version: Array<[string, number]>, size = 100, deleted = false) {
  return {
    path: 'docs/plan.md',
    version: new Map(version),
    size,
    deleted,
    blocks: [],
  };
}

describe('sync plan generation', () => {
  it('produces no actions when indexes are identical', () => {
    const entryMap = new Map([['docs/plan.md', entry([['dev-a', 2]])]]);

    expect(buildPlan(entryMap, new Map(entryMap))).toEqual([]);
  });

  it('emits a send action when the local entry is newer', () => {
    const local = new Map([['docs/plan.md', entry([['dev-a', 3]])]]);
    const remote = new Map([['docs/plan.md', entry([['dev-a', 2]])]]);

    expect(buildPlan(local, remote)).toEqual([
      { kind: 'send', path: 'docs/plan.md', entry: local.get('docs/plan.md') },
    ]);
  });

  it('emits a receive action when the remote entry is newer', () => {
    const local = new Map([['docs/plan.md', entry([['dev-a', 2]])]]);
    const remote = new Map([['docs/plan.md', entry([['dev-a', 3]])]]);

    expect(buildPlan(local, remote)).toEqual([
      { kind: 'receive', path: 'docs/plan.md', entry: remote.get('docs/plan.md') },
    ]);
  });

  it('emits a conflict action for concurrent versions', () => {
    const local = new Map([['docs/plan.md', entry([['dev-a', 3]])]]);
    const remote = new Map([['docs/plan.md', entry([['dev-a', 2], ['dev-b', 1]])]]);

    expect(buildPlan(local, remote)).toEqual([
      {
        kind: 'conflict',
        path: 'docs/plan.md',
        local: local.get('docs/plan.md'),
        remote: remote.get('docs/plan.md'),
      },
    ]);
  });

  it('emits a delete action when a newer tombstone arrives from remote', () => {
    const local = new Map([['docs/plan.md', entry([['dev-a', 2]])]]);
    const remote = new Map([['docs/plan.md', entry([['dev-a', 3]], 0, true)]]);

    expect(buildPlan(local, remote)).toEqual([{ kind: 'delete', path: 'docs/plan.md' }]);
  });

  it('emits a delete action when a newer local tombstone must propagate', () => {
    const local = new Map([['docs/plan.md', entry([['dev-a', 3]], 0, true)]]);
    const remote = new Map([['docs/plan.md', entry([['dev-a', 2]])]]);

    expect(buildPlan(local, remote)).toEqual([{ kind: 'delete', path: 'docs/plan.md' }]);
  });
});
