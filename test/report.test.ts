import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { rmDir } from './helpers.js';
import { flushSyncHistory, recordSyncEvent, type SyncEvent } from '../src/history.js';
import { aggregateWeeklyReport, collectWeeklyReport, dayKey } from '../src/report.js';

/**
 * 同步周报聚合器单测:纯函数按本地日切窗,采集层走真实 history JSONL。
 * 时间全部用「本地正午」构造,避免测试在不同时区/靠近午夜时翻车。
 */

/** 相对基准日(本地)第 dayOffset 天的指定时刻。 */
function at(base: Date, dayOffset: number, hour = 12): number {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, hour);
  return d.getTime();
}

function ev(partial: Partial<SyncEvent> & Pick<SyncEvent, 'ts'>): SyncEvent {
  return { folderId: 'F1', path: 'a.txt', action: 'add', direction: 'local', ...partial };
}

describe('dayKey', () => {
  it('产出本地日期键 YYYY-MM-DD(补零)', () => {
    const d = new Date(2026, 0, 5, 3); // 2026-01-05 本地凌晨
    expect(dayKey(d.getTime())).toBe('2026-01-05');
  });
});

describe('aggregateWeeklyReport', () => {
  const now = at(new Date(2026, 8, 26), 0, 18); // 2026-09-26 18:00 本地
  const from = at(now2Date(now), -6); // 窗口起点 = 今天往前 6 天的本地 00:00

  function now2Date(ts: number): Date {
    return new Date(ts);
  }

  it('窗口:只计近 7 个自然日,逐日桶恒 7 项(旧→新)', () => {
    const r = aggregateWeeklyReport(
      [
        {
          id: 'F1',
          path: '/srv/a',
          events: [
            ev({ ts: at(new Date(2026, 8, 26), 0) }), // 今天
            ev({ ts: at(new Date(2026, 8, 26), -6) }), // 窗口首日
            ev({ ts: at(new Date(2026, 8, 26), -7) }), // 窗口外(8 天前)
          ],
        },
      ],
      now,
    );
    expect(r.days).toHaveLength(7);
    expect(r.days[0]!.day).toBe(dayKey(from));
    expect(r.days[6]!.day).toBe(dayKey(now));
    expect(r.totals.total).toBe(2);
    expect(r.days[0]!.add).toBe(1);
    expect(r.days[6]!.add).toBe(1);
  });

  it('动作分账:add/update/delete/conflict 各归各桶;冲突带明细(最新在前)', () => {
    const r = aggregateWeeklyReport(
      [
        {
          id: 'F1',
          path: '/srv/a',
          events: [
            ev({ ts: at(new Date(2026, 8, 25), 9), action: 'update' }),
            ev({ ts: at(new Date(2026, 8, 24), 9), action: 'delete' }),
            ev({ ts: at(new Date(2026, 8, 23), 9), action: 'conflict', path: 'x.md', deviceId: 'DEV2' }),
            ev({ ts: at(new Date(2026, 8, 22), 9), action: 'conflict', path: 'y.md' }),
          ],
        },
      ],
      now,
    );
    expect(r.totals).toEqual({ add: 0, update: 1, delete: 1, conflict: 2, total: 4 });
    expect(r.conflicts.map((c) => c.path)).toEqual(['x.md', 'y.md']); // 倒序
    expect(r.conflicts[0]).toMatchObject({ folderPath: '/srv/a', deviceId: 'DEV2' });
    expect(r.conflicts[1]!.deviceId).toBeUndefined();
  });

  it('目录贡献按 total 降序;对端活跃度只计 remote 且带 deviceId 的事件', () => {
    const r = aggregateWeeklyReport(
      [
        { id: 'F1', path: '/srv/quiet', events: [] },
        {
          id: 'F2',
          path: '/srv/busy',
          events: [
            ev({ folderId: 'F2', ts: now, action: 'add', direction: 'remote', deviceId: 'DEVA' }),
            ev({ folderId: 'F2', ts: now, action: 'add', direction: 'remote', deviceId: 'DEVA' }),
            ev({ folderId: 'F2', ts: now, action: 'add', direction: 'remote', deviceId: 'DEVB' }),
            ev({ folderId: 'F2', ts: now, action: 'add', direction: 'local' }),
          ],
        },
      ],
      now,
    );
    expect(r.folders.map((f) => f.path)).toEqual(['/srv/busy', '/srv/quiet']);
    expect(r.folders[0]!.total).toBe(4);
    expect(r.activeDevices).toEqual([
      { deviceId: 'DEVA', count: 2 },
      { deviceId: 'DEVB', count: 1 },
    ]);
  });

  it('截断口径:目录里存在贴着窗口起点或更早的记录 → truncated', () => {
    const insideOnly = aggregateWeeklyReport(
      [{ id: 'F1', path: '/a', events: [ev({ ts: at(new Date(2026, 8, 26), -2) })] }],
      now,
    );
    expect(insideOnly.truncated).toBe(false);
    const touching = aggregateWeeklyReport(
      [{ id: 'F1', path: '/a', events: [ev({ ts: at(new Date(2026, 8, 26), -7) })] }],
      now,
    );
    expect(touching.truncated).toBe(true);
  });
});

describe('collectWeeklyReport(真实 JSONL)', () => {
  it('读 recordSyncEvent 写入的历史(含未落盘的攒批),按目录路径归并', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-report-'));
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ sharedFolders: [], peers: [], knownDevices: [] }));
    const now = Date.now();
    recordSyncEvent(configPath, ev({ ts: now - 60_000, folderId: 'R1', action: 'add' }));
    recordSyncEvent(configPath, ev({ ts: now - 120_000, folderId: 'R1', action: 'conflict', path: 'z.bin' }));
    flushSyncHistory(configPath); // 不 flush 则依赖 200ms 攒批定时器,collect 也应自己 flush —— 双保险都测

    const r = collectWeeklyReport(configPath, [{ id: 'R1', path: join(dir, 'r1') }], now);
    expect(r.totals.total).toBe(2);
    expect(r.totals.conflict).toBe(1);
    expect(r.conflicts[0]!.folderPath).toBe(join(dir, 'r1'));
    rmDir(dirname(configPath));
  });
});
