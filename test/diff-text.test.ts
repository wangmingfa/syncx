import { describe, expect, it } from 'vitest';

import { formatFolderDiff } from '../src/diff-text.js';
import type { FolderDiffResult } from '../src/session-manager.js';
import type { DiffItem, DiffKind } from '../src/diff.js';

const LOCAL = 'DEV-A';
const REMOTE = 'DEV-B';

const side = (
  version: Array<[string, number]>,
  size: number,
  digest: string,
  deleted = false,
): DiffItem['local'] => ({ version, size, digest, deleted });

function item(kind: DiffKind, path: string, extra: Partial<DiffItem> = {}): DiffItem {
  return {
    path,
    kind,
    local: side([[LOCAL, 1]], 100, 'aaaa1111'),
    remote: side([[REMOTE, 1]], 100, 'bbbb2222'),
    ...extra,
  };
}

function result(
  items: DiffItem[],
  opts: {
    progress?: FolderDiffResult['localProgress'];
    remoteProgress?: FolderDiffResult['remoteProgress'];
    remoteRulesKnown?: boolean;
  } = {},
): FolderDiffResult {
  const counts = {
    'content-mismatch': 0,
    conflict: 0,
    'local-newer': 0,
    'remote-newer': 0,
    'ignored-locally': 0,
    'ignored-remotely': 0,
    'in-sync': 10,
  } as Record<DiffKind, number>;
  for (const i of items) counts[i.kind] += 1;
  return {
    folderId: 'fid',
    folderPath: '/share/dir',
    deviceId: REMOTE,
    remoteAt: Date.now(),
    diff: {
      items,
      counts,
      localTotal: 10 + items.length,
      remoteTotal: 10 + items.length,
      remoteRulesKnown: opts.remoteRulesKnown ?? true,
    },
    ...(opts.progress ? { localProgress: opts.progress } : {}),
    ...(opts.remoteProgress ? { remoteProgress: opts.remoteProgress } : {}),
  };
}

const run = (r: FolderDiffResult, maxPerGroup?: number): string =>
  formatFolderDiff(r, maxPerGroup === undefined ? { localDeviceId: LOCAL } : { localDeviceId: LOCAL, maxPerGroup }).join('\n');

describe('formatFolderDiff', () => {
  it('says so plainly when nothing differs', () => {
    const out = run(result([]));
    expect(out).toContain('没有差异');
    // 没有差异时不该列任何分组
    expect(out).not.toContain('内容错位');
    expect(out).not.toContain('规则使然');
  });

  it('orders groups by how much they matter (rule-caused noise last)', () => {
    const out = run(
      result([
        item('ignored-locally', 'node_modules/a.js', { rule: 'node_modules/' }),
        item('remote-newer', 'b.txt'),
        item('local-newer', 'c.txt'),
        item('content-mismatch', 'd.txt'),
        item('conflict', 'e.txt'),
      ]),
    );
    const at = (s: string): number => out.indexOf(s);
    expect(at('内容错位')).toBeLessThan(at('冲突'));
    expect(at('冲突')).toBeLessThan(at('待推送'));
    expect(at('待推送')).toBeLessThan(at('待拉取'));
    // 「规则使然」不是故障,必须排在所有真差异之后
    expect(at('待拉取')).toBeLessThan(at('规则使然的差异'));
  });

  it('explains rule-caused entries with the matched rule instead of listing versions', () => {
    const out = run(
      result([
        item('ignored-locally', '.git/config', { rule: '.git', hard: true, remote: side([[REMOTE, 1]], 300, 'cccc3333') }),
      ]),
    );
    expect(out).toContain('规则 `.git`');
    expect(out).toContain('硬忽略,不可解除');
    // 规则使然的条目不该再展示两侧版本(看了也没用,只会干扰)
    expect(out).not.toContain('本机 100B');
  });

  it('never claims a transfer is in flight when every counter is zero', () => {
    const idle = run(result([item('local-newer', 'a.txt')], { progress: { pending: 0, sending: 0, receiving: 0 } }));
    expect(idle).not.toContain('此刻在传输');

    const busy = run(result([item('local-newer', 'a.txt')], { progress: { pending: 0, sending: 2, receiving: 0 } }));
    expect(busy).toContain('本机此刻在传输(发送 2');
    expect(busy).toContain('中间态');
  });

  it('marks index-vs-disk mismatches as stale index, not as a two-sided difference', () => {
    const out = run(result([item('remote-newer', 'gone.txt', { disk: 'missing' })]));
    expect(out).toContain('索引陈旧');
    expect(out).toContain('两端不同步');
  });

  it('warns that rule-caused differences cannot be told apart with an old peer', () => {
    const out = run(result([item('local-newer', 'a.txt')], { remoteRulesKnown: false }));
    expect(out).toContain('对端未提供忽略规则');
  });

  it('caps each group and reports how many are left', () => {
    const many = Array.from({ length: 25 }, (_, i) => item('local-newer', `f${i}.txt`));
    const out = run(result(many), 5);
    expect(out).toContain('还有 20 条');
    // 只列前 5 条
    expect(out).toContain('f0.txt');
    expect(out).not.toContain('f9.txt');
  });

  it('names the two sides so a pasted report is readable without context', () => {
    const out = run(result([item('local-newer', 'a.txt')]));
    expect(out).toContain(LOCAL);
    expect(out).toContain(REMOTE);
    expect(out).toContain('/share/dir');
    expect(out).toContain('目录 id fid');
  });
});
