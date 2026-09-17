import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  buildFolderDiff,
  checkDiffAgainstDisk,
  contentDigest,
  diffTotal,
  toSnapshotEntry,
  type DiffItem,
  type SnapshotEntry,
} from '../src/diff.js';
import type { IndexEntry } from '../src/index.js';
import { parseIgnoreRules } from '../src/ignore.js';
import { decodeSnapshot, encodeSnapshot } from '../src/messages.js';
import { rmDir } from './helpers.js';

/** 本地索引条目(version 用 Map)。blocks 由 seed 派生,便于让「内容一致」可控。 */
function local(
  path: string,
  version: Array<[string, number]>,
  opts: { size?: number; deleted?: boolean; seed?: string; mtime?: number } = {},
): IndexEntry {
  const blocks = opts.deleted ? [] : [opts.seed ?? path];
  return {
    path,
    version: new Map(version),
    size: opts.size ?? 100,
    deleted: opts.deleted ?? false,
    blocks,
    ...(opts.mtime === undefined ? {} : { mtime: opts.mtime }),
  };
}

/**
 * 对端快照条目。刻意要求显式给 seed:摘要算错是这类功能最隐蔽的失败模式
 * (两边算法不同 → 全部条目都报「内容错位」),让用例看得见这块。
 */
function snap(
  path: string,
  version: Array<[string, number]>,
  opts: { size?: number; deleted?: boolean; seed?: string; digest?: string } = {},
): SnapshotEntry {
  return {
    path,
    version,
    size: opts.size ?? 100,
    deleted: opts.deleted ?? false,
    digest: opts.digest ?? (opts.deleted ? '' : contentDigest([opts.seed ?? path])),
  };
}

function localMap(...entries: IndexEntry[]): Map<string, IndexEntry> {
  return new Map(entries.map((e) => [e.path, e]));
}

describe('contentDigest', () => {
  it('collapses a block list into one fixed-length digest', () => {
    const one = contentDigest(['a'.repeat(64)]);
    const many = contentDigest(['a'.repeat(64), 'b'.repeat(64)]);
    expect(one).toHaveLength(64);
    // 块数再多也是 64 字符 —— 这正是快照体积不随文件大小膨胀的原因
    expect(many).toHaveLength(64);
    expect(one).not.toBe(many);
  });

  it('returns an empty digest for no blocks (tombstones, empty files)', () => {
    expect(contentDigest([])).toBe('');
  });

  it('is insensitive to how the same block list was rebuilt', () => {
    expect(contentDigest(['h1', 'h2'])).toBe(contentDigest(['h1', 'h2']));
  });
});

describe('buildFolderDiff', () => {
  it('folds identical entries into the in-sync count', () => {
    const diff = buildFolderDiff({
      local: localMap(local('a.txt', [['A', 1]]), local('b.txt', [['A', 1]])),
      remote: [snap('a.txt', [['A', 1]]), snap('b.txt', [['A', 1]])],
      localRules: [],
      remoteRules: [],
    });

    expect(diff.items).toEqual([]);
    expect(diff.counts['in-sync']).toBe(2);
    expect(diffTotal(diff.counts)).toBe(0);
  });

  it('flags equal versions with a different body as content-mismatch', () => {
    const diff = buildFolderDiff({
      local: localMap(local('a.txt', [['A', 1]], { seed: 'mine' })),
      remote: [snap('a.txt', [['A', 1]], { seed: 'theirs' })],
      localRules: [],
      remoteRules: [],
    });

    expect(diff.items).toHaveLength(1);
    expect(diff.items[0]!.kind).toBe('content-mismatch');
    expect(diff.items[0]!.local?.digest).not.toBe(diff.items[0]!.remote?.digest);
  });

  it('flags equal versions with a different size as content-mismatch', () => {
    const diff = buildFolderDiff({
      local: localMap(local('a.txt', [['A', 1]], { size: 10 })),
      remote: [snap('a.txt', [['A', 1]], { size: 20 })],
      localRules: [],
      remoteRules: [],
    });

    expect(diff.items[0]!.kind).toBe('content-mismatch');
  });

  it('flags one-sided deleted state with equal versions as content-mismatch', () => {
    // 版本向量相等却「一边墓碑一边活条目」:索引被错写的信号,不能当成一致
    const diff = buildFolderDiff({
      local: localMap(local('a.txt', [['A', 1]], { deleted: true })),
      remote: [snap('a.txt', [['A', 1]])],
      localRules: [],
      remoteRules: [],
    });

    expect(diff.items[0]!.kind).toBe('content-mismatch');
  });

  it('reports one-sided live entries as pending push / pull', () => {
    const diff = buildFolderDiff({
      local: localMap(local('mine.txt', [['A', 1]])),
      remote: [snap('theirs.txt', [['B', 1]])],
      localRules: [],
      remoteRules: [],
    });

    expect(diff.items.map((i) => [i.path, i.kind])).toEqual([
      ['mine.txt', 'local-newer'],
      ['theirs.txt', 'remote-newer'],
    ]);
  });

  it('does not report a one-sided tombstone as a difference', () => {
    // 一方删过、另一方从未见过它:墓碑推过去也无事可做,不该长期挂在报告里
    const diff = buildFolderDiff({
      local: localMap(local('gone.txt', [['A', 2]], { deleted: true })),
      remote: [snap('never-seen.txt', [['B', 1]], { deleted: true })],
      localRules: [],
      remoteRules: [],
    });

    expect(diff.items).toEqual([]);
    expect(diff.counts['in-sync']).toBe(2);
  });

  it('reports local deletion against a live peer copy as a pending push', () => {
    const diff = buildFolderDiff({
      local: localMap(local('gone.txt', [['A', 2]], { deleted: true })),
      remote: [snap('gone.txt', [['A', 1]])],
      localRules: [],
      remoteRules: [],
    });

    expect(diff.items[0]!.kind).toBe('local-newer');
    expect(diff.items[0]!.local?.deleted).toBe(true);
    expect(diff.items[0]!.remote?.deleted).toBe(false);
  });

  it('reports concurrent versions as a conflict', () => {
    const diff = buildFolderDiff({
      local: localMap(local('a.txt', [['A', 2], ['B', 1]])),
      remote: [snap('a.txt', [['A', 1], ['B', 2]])],
      localRules: [],
      remoteRules: [],
    });

    expect(diff.items[0]!.kind).toBe('conflict');
  });

  it('explains a peer-only path by the local ignore rule that matched', () => {
    // 本机内存索引已被忽略规则过滤 → 本机忽略的活条目正是「对端有、本机没有」。
    // 不消歧的话会被报成 remote-newer(「该拉回来」),用户会去修一个不存在的问题。
    const diff = buildFolderDiff({
      local: localMap(local('keep.txt', [['A', 1]])),
      remote: [snap('keep.txt', [['A', 1]]), snap('.workbuddy/memory/2026-09-16.md', [['B', 1]])],
      localRules: parseIgnoreRules(['.git', '.workbuddy/']),
      remoteRules: [],
    });

    expect(diff.items).toHaveLength(1);
    expect(diff.items[0]!.kind).toBe('ignored-locally');
    expect(diff.items[0]!.rule).toBe('.workbuddy/');
  });

  it('explains a local-only path by the peer rule that matched', () => {
    const diff = buildFolderDiff({
      local: localMap(local('keep.txt', [['A', 1]]), local('build/out.js', [['A', 1]])),
      remote: [snap('keep.txt', [['A', 1]])],
      localRules: [],
      remoteRules: parseIgnoreRules(['build/']),
    });

    expect(diff.items).toHaveLength(1);
    expect(diff.items[0]!.kind).toBe('ignored-remotely');
    expect(diff.items[0]!.rule).toBe('build/');
  });

  it('marks hard-ignored paths so the report can say the rule cannot be lifted', () => {
    const diff = buildFolderDiff({
      local: localMap(),
      remote: [snap('.git/config', [['B', 1]])],
      localRules: parseIgnoreRules(['.git']),
      remoteRules: [],
    });

    expect(diff.items[0]!.kind).toBe('ignored-locally');
    expect(diff.items[0]!.hard).toBe(true);
  });

  it('degrades to plain differences when the peer sent no rules', () => {
    // 旧版本对端不带回规则行 → 无法判定「差异是规则使然」,如实降级并标注出来
    const diff = buildFolderDiff({
      local: localMap(local('keep.txt', [['A', 1]])),
      remote: [snap('keep.txt', [['A', 1]])],
      localRules: [],
    });

    expect(diff.remoteRulesKnown).toBe(false);
    expect(diff.items).toEqual([]);
  });

  it('does not use the peer rule set to explain a path the peer did mention', () => {
    // 对端明确声明了这条(说明它没忽略),此时命中「对端规则」不能拿来当解释
    const diff = buildFolderDiff({
      local: localMap(local('a.txt', [['A', 2]])),
      remote: [snap('a.txt', [['A', 1]])],
      localRules: [],
      remoteRules: parseIgnoreRules(['a.txt']),
    });

    expect(diff.items[0]!.kind).toBe('local-newer');
  });

  it('sorts the most suspicious kinds first', () => {
    const diff = buildFolderDiff({
      local: localMap(
        local('z-local.txt', [['A', 1]]),
        local('a-half.txt', [['A', 1]], { seed: 'mine' }),
        local('b-only-local.txt', [['A', 1]]),
      ),
      remote: [
        snap('a-half.txt', [['A', 1]]),
        snap('c-only-remote.txt', [['B', 1]]),
      ],
      localRules: [],
      remoteRules: [],
    });

    expect(diff.items.map((i) => i.kind)).toEqual([
      'content-mismatch',
      'local-newer',
      'local-newer',
      'remote-newer',
    ]);
    // 同分类内按路径排序
    expect(diff.items.slice(1, 3).map((i) => i.path)).toEqual(['b-only-local.txt', 'z-local.txt']);
  });

  it('counts both sides so the report can state the index size', () => {
    const diff = buildFolderDiff({
      local: localMap(local('a.txt', [['A', 1]]), local('b.txt', [['A', 2]], { deleted: true })),
      remote: [snap('a.txt', [['A', 1]])],
      localRules: [],
      remoteRules: [],
    });

    expect(diff.localTotal).toBe(2);
    expect(diff.remoteTotal).toBe(1);
  });
});

describe('toSnapshotEntry', () => {
  it('round-trips through the wire codec', () => {
    const entry = local('a.txt', [['A', 3], ['B', 1]], { size: 7, mtime: 1234 });
    const wire = decodeSnapshot(encodeSnapshot([toSnapshotEntry(entry)]));

    expect(wire).toHaveLength(1);
    expect(wire[0]).toMatchObject({ path: 'a.txt', size: 7, deleted: false, mtime: 1234 });
    expect(wire[0]!.version).toEqual([['A', 3], ['B', 1]]);
    expect(wire[0]!.digest).toBe(contentDigest(entry.blocks));
  });

  it('produces the same digest as the receiver computes for the same blocks', () => {
    // 两端摘要算法必须一致,否则全部条目都会被报成「内容错位」
    const entry = local('a.txt', [['A', 1]], { seed: 'same' });
    const sent = toSnapshotEntry(entry);
    const here = contentDigest(entry.blocks);
    expect(sent.digest).toBe(here);
  });
});

describe('checkDiffAgainstDisk', () => {
  it('separates a stale index from a real difference', () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-diff-'));
    try {
      mkdirSync(join(dir, 'sub'));
      writeFileSync(join(dir, 'same.txt'), 'x'.repeat(10));
      writeFileSync(join(dir, 'shrunk.txt'), 'x'.repeat(3));
      writeFileSync(join(dir, 'sub', 'nested.txt'), 'x'.repeat(5));

      const items: DiffItem[] = [
        { path: 'same.txt', kind: 'remote-newer', local: { version: [], size: 10, deleted: false, digest: '' } },
        { path: 'shrunk.txt', kind: 'remote-newer', local: { version: [], size: 10, deleted: false, digest: '' } },
        { path: 'missing.txt', kind: 'remote-newer', local: { version: [], size: 1, deleted: false, digest: '' } },
        { path: 'sub/nested.txt', kind: 'local-newer', local: { version: [], size: 5, deleted: false, digest: '' } },
        // 墓碑:盘上本就没有文件,不做复核
        { path: 'tomb.txt', kind: 'local-newer', local: { version: [], size: 0, deleted: true, digest: '' } },
        // 只有对端声明:本机没有 local side,无从对照
        { path: 'peer-only.txt', kind: 'remote-newer', remote: { version: [], size: 1, deleted: false, digest: '' } },
      ];

      checkDiffAgainstDisk(dir, items);

      expect(items[0]!.disk).toBe('ok');
      expect(items[1]!.disk).toBe('size-differs');
      expect(items[2]!.disk).toBe('missing');
      expect(items[3]!.disk).toBe('ok');
      expect(items[4]!.disk).toBeUndefined();
      expect(items[5]!.disk).toBeUndefined();
    } finally {
      rmDir(dir);
    }
  });

  it('never follows a path outside the shared root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-diff-'));
    try {
      const items: DiffItem[] = [
        { path: '../escape.txt', kind: 'remote-newer', local: { version: [], size: 1, deleted: false, digest: '' } },
      ];
      checkDiffAgainstDisk(dir, items);
      // 越界路径既不 stat 也不谎报「盘上没了」
      expect(items[0]!.disk).toBeUndefined();
    } finally {
      rmDir(dir);
    }
  });
});
