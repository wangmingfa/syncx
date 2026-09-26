import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { rmDir } from './helpers.js';
import {
  applyRollback,
  listTrashRefs,
  listVersionRefs,
  parseTrashName,
  parseVersionName,
  planRollback,
  walkCurrentFiles,
  type RollbackInputs,
} from '../src/rollback.js';

/**
 * 文件时间机器单测:命名解析、纯规划器各分支、执行器的可逆性(覆盖前留档 /
 * 删除进回收站)、目录遍历对硬忽略名的排除。
 */

const T = Date.parse('2026-09-20T12:00:00Z'); // 目标时刻
const before = (ms: number) => T - ms;
const after = (ms: number) => T + ms;

function stamp(ts: number): string {
  return ts.toString(36);
}

describe('版本/回收站命名解析', () => {
  it('版本文件:剥出相对路径与毫秒时间戳(含碰撞序号)', () => {
    const v = parseVersionName(`docs/a.txt.syncx-v-${stamp(after(1000))}`);
    expect(v).not.toBe(null);
    expect(v!.relPath).toBe('docs/a.txt');
    expect(v!.ts).toBe(after(1000));
    expect(parseVersionName(`a.bin.syncx-v-${stamp(T)}.2`)!.ts).toBe(T);
    expect(parseVersionName('plain.txt')).toBe(null);
  });

  it('回收站文件:base36 毫秒戳识别;普通文件不误认', () => {
    const t = parseTrashName(`dir/f.md.${stamp(after(5000))}`);
    expect(t!.relPath).toBe('dir/f.md');
    expect(t!.ts).toBe(after(5000));
    expect(parseTrashName('readme.md')).toBe(null); // 「.md」不是长 base36 段
    expect(parseTrashName('v1.2026')).toBe(null); // 太短的段不算时间戳
  });
});

describe('planRollback', () => {
  function inputs(partial: Partial<RollbackInputs>): RollbackInputs {
    return { versions: [], trash: [], history: [], current: new Map(), ...partial };
  }

  it('T 后发生过覆盖:取「最早的 stamp > T」快照恢复(T 那代内容)', () => {
    const p = planRollback(
      inputs({
        versions: [
          { file: `a.txt.syncx-v-${stamp(before(9000))}`, relPath: 'a.txt', ts: before(9000) },
          { file: `a.txt.syncx-v-${stamp(after(100))}`, relPath: 'a.txt', ts: after(100) },
          { file: `a.txt.syncx-v-${stamp(after(800))}`, relPath: 'a.txt', ts: after(800) },
        ],
        current: new Map([['a.txt', after(900)]]),
      }),
      T,
    );
    expect(p.restores).toEqual([
      { relPath: 'a.txt', versionFile: `a.txt.syncx-v-${stamp(after(100))}`, versionTs: after(100) },
    ]);
  });

  it('文件当前 mtime 早于 T 且无 T 后快照:不动', () => {
    const p = planRollback(
      inputs({
        versions: [{ file: `a.txt.syncx-v-${stamp(before(5000))}`, relPath: 'a.txt', ts: before(5000) }],
        current: new Map([['a.txt', before(100)]]),
      }),
      T,
    );
    expect(p.restores).toHaveLength(0);
    expect(p.counts.restores).toBe(0);
  });

  it('T 后被删(有回收站副本):移回;副本也没有:进 lostDeletes', () => {
    const p = planRollback(
      inputs({
        trash: [{ file: `gone.txt.${stamp(after(200))}`, relPath: 'gone.txt', ts: after(200) }],
        history: [
          { ts: before(99_000), path: 'gone.txt', action: 'add' },
          { ts: after(200), path: 'gone.txt', action: 'delete' },
          { ts: after(300), path: 'lost.txt', action: 'delete' },
        ],
      }),
      T,
    );
    expect(p.fromTrash).toEqual([{ relPath: 'gone.txt', trashFile: `gone.txt.${stamp(after(200))}` }]);
    expect(p.lostDeletes).toEqual(['lost.txt']);
  });

  it('T 之后新增的文件:移入回收站(要求版本证据为空,防误伤老文件)', () => {
    const p = planRollback(
      inputs({
        history: [
          { ts: after(50), path: 'new.txt', action: 'add' },
          { ts: after(60), path: 'new.txt', action: 'update' },
        ],
        current: new Map([['new.txt', after(60)]]),
      }),
      T,
    );
    expect(p.trashCurrent).toEqual([{ relPath: 'new.txt' }]);
    // 有 T 前快照 → 不是新文件,不删(走恢复分支)
    const p2 = planRollback(
      inputs({
        versions: [{ file: `x.syncx-v-${stamp(before(10))}`, relPath: 'x', ts: before(10) }],
        history: [{ ts: after(50), path: 'x', action: 'add' }],
        current: new Map([['x', after(50)]]),
      }),
      T,
    );
    expect(p2.trashCurrent).toHaveLength(0);
  });

  it('T 后有更新事件但无任何快照/副本:记入 noSnapshot(不可恢复的诚实口径)', () => {
    const p = planRollback(
      inputs({
        history: [
          { ts: before(50), path: 'y.md', action: 'update' },
          { ts: after(70), path: 'y.md', action: 'update' },
        ],
        current: new Map([['y.md', after(70)]]),
      }),
      T,
    );
    expect(p.noSnapshot).toEqual(['y.md']);
  });
});

describe('applyRollback + 目录遍历(真实临时目录)', () => {
  function setup(): { dir: string; root: string; versionsDir: string; trashDir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-rollback-'));
    const root = join(dir, 'share');
    const versionsDir = join(dir, 'versions');
    const trashDir = join(dir, 'trash');
    mkdirSync(join(root, 'sub'), { recursive: true });
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, '.git', 'config'), 'x');
    mkdirSync(versionsDir, { recursive: true });
    return { dir, root, versionsDir, trashDir };
  }

  it('恢复覆盖前当前内容自动留档;恢复/回收入站全程可逆', () => {
    const { dir, root, versionsDir, trashDir } = setup();
    // 当前:sub/a.txt 是「T 后的新内容」;版本里有 T 时刻内容;gone.txt 的副本在回收站
    writeFileSync(join(root, 'sub', 'a.txt'), 'NEW');
    mkdirSync(join(versionsDir, 'sub'), { recursive: true }); // 版本目录保留原层级(executor 同规则)
    writeFileSync(join(versionsDir, `sub/a.txt.syncx-v-${stamp(after(100))}`), 'AT-T');
    mkdirSync(trashDir, { recursive: true });
    writeFileSync(join(trashDir, `gone.txt.${stamp(after(200))}`), 'WAS-HERE');

    const inputs: RollbackInputs = {
      versions: listVersionRefs(versionsDir),
      trash: listTrashRefs(trashDir),
      history: [{ ts: after(300), path: 'gone.txt', action: 'delete' }],
      current: walkCurrentFiles(root),
    };
    expect([...inputs.current.keys()]).toEqual(['sub/a.txt']); // .git 被跳过
    expect(inputs.versions).toHaveLength(1);
    expect(inputs.trash).toHaveLength(1);

    const plan = planRollback(inputs, T);
    expect(plan.restores.map((r) => r.relPath)).toEqual(['sub/a.txt']);
    expect(plan.fromTrash.map((r) => r.relPath)).toEqual(['gone.txt']);

    const r = applyRollback(plan, { root, versionsDir, trashDir }, after(999));
    expect(r).toEqual({ restored: 1, trashed: 0, fromTrash: 1, failed: 0 });
    expect(readFileSync(join(root, 'sub', 'a.txt'), 'utf8')).toBe('AT-T');
    expect(readFileSync(join(root, 'gone.txt'), 'utf8')).toBe('WAS-HERE');
    expect(existsSync(join(trashDir, `gone.txt.${stamp(after(200))}`))).toBe(false);
    // 被覆盖掉的 NEW 进了版本目录(T 后第 999ms 的 stamp)
    expect(readFileSync(join(versionsDir, `sub/a.txt.syncx-v-${stamp(after(999))}`), 'utf8')).toBe('NEW');
    rmDir(dir);
  });

  it('T 后新增文件:移入回收站而不是硬删', () => {
    const { dir, root, versionsDir, trashDir } = setup();
    writeFileSync(join(root, 'fresh.bin'), 'F');
    const plan = planRollback(
      {
        versions: [],
        trash: [],
        history: [{ ts: after(10), path: 'fresh.bin', action: 'add' }],
        current: new Map([['fresh.bin', after(10)]]),
      },
      T,
    );
    const r = applyRollback(plan, { root, versionsDir, trashDir }, after(555));
    expect(r.trashed).toBe(1);
    expect(existsSync(join(root, 'fresh.bin'))).toBe(false);
    expect(existsSync(join(trashDir, `fresh.bin.${stamp(after(555))}`))).toBe(true);
    rmDir(dir);
  });
});
