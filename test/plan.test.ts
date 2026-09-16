import { describe, expect, it } from 'vitest';
import { buildPlan, buildDeltaPlan } from '../src/plan.js';

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

/**
 * 增量规划:对端发来的可能只是「本轮改动的那几条」,此时**不能**用并集语义,
 * 否则本机独有的条目会被误判成「对端缺失」而回推,两端互为回声。
 */
describe('delta plan generation (只对消息里提到的路径判定)', () => {
  it('never plans anything for local entries the delta message did not mention', () => {
    // 本机有 3 条,对端的增量消息只提到其中 1 条 —— 另 2 条是「对端这轮没说」,
    // 不是「对端没有」。并集语义会把它们判成 send,这正是回声环的起点。
    const local = new Map([
      ['a.txt', { path: 'a.txt', version: new Map([['dev-a', 1]]), size: 1, deleted: false, blocks: [] }],
      ['b.txt', { path: 'b.txt', version: new Map([['dev-a', 1]]), size: 1, deleted: false, blocks: [] }],
      ['c.txt', { path: 'c.txt', version: new Map([['dev-a', 1]]), size: 1, deleted: false, blocks: [] }],
    ]);
    const remote = new Map([
      ['a.txt', { path: 'a.txt', version: new Map([['dev-a', 2]]), size: 1, deleted: false, blocks: [] }],
    ]);

    // 对照:并集语义会把本机独有、消息里没提到的 b/c 判成需要回推
    expect(buildPlan(local, remote).map((a) => a.kind)).toEqual(['receive', 'send', 'send']);
    // 增量语义:消息里只有 a.txt,就只判定 a.txt
    expect(buildDeltaPlan(local, remote)).toEqual([
      { kind: 'receive', path: 'a.txt', entry: remote.get('a.txt') },
    ]);
  });

  it('still reconciles every path the delta message does mention', () => {
    const local = new Map([['docs/plan.md', entry([['dev-a', 2]])]]);
    const remote = new Map([['docs/plan.md', entry([['dev-a', 3]])]]);

    expect(buildDeltaPlan(local, remote)).toEqual([
      { kind: 'receive', path: 'docs/plan.md', entry: remote.get('docs/plan.md') },
    ]);
  });

  it('propagates a remote tombstone carried by a delta message', () => {
    const local = new Map([['docs/plan.md', entry([['dev-a', 2]])]]);
    const remote = new Map([['docs/plan.md', entry([['dev-a', 3]], 0, true)]]);

    expect(buildDeltaPlan(local, remote)).toEqual([{ kind: 'delete', path: 'docs/plan.md' }]);
  });

  it('plans nothing for an empty delta message (对端这轮没有改动)', () => {
    const local = new Map([['docs/plan.md', entry([['dev-a', 2]])]]);

    expect(buildDeltaPlan(local, new Map())).toEqual([]);
  });
});
