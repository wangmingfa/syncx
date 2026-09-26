import { flushSyncHistory, getSyncHistory } from './history.js';
import type { SyncEvent } from './history.js';

/**
 * 同步周报:把各目录的历史记录(JSONL,已持久化)聚合成「近 7 天」的汇总,
 * 供 Web UI 的周报卡片一次取回。纯读路径、无副作用;流量字节不在此列
 * (TrafficLedger 是内存态,重启即清零,拿不到可信的 7 天累计 —— 口径只到条数)。
 */

/** 报告统计窗口:自然日粒度、含今天的最近 7 天。 */
export const REPORT_WINDOW_DAYS = 7;

/** 冲突明细最多回传条数(周报看趋势,明细只是入口;完整列表在冲突页)。 */
const MAX_CONFLICT_ITEMS = 50;

export interface WeeklyReportDay {
  /** 本地日期键 YYYY-MM-DD。 */
  day: string;
  add: number;
  update: number;
  delete: number;
  conflict: number;
}

export interface WeeklyReportFolder {
  id: string;
  path: string;
  add: number;
  update: number;
  delete: number;
  conflict: number;
  total: number;
}

export interface WeeklyReportConflictItem {
  ts: number;
  folderPath: string;
  path: string;
  deviceId?: string;
}

export interface WeeklyReport {
  /** 窗口起点(今天往前 6 个自然日的 00:00:00,毫秒)。 */
  fromTs: number;
  toTs: number;
  /** 逐日趋势,旧→新,恒为 7 项(没有事件的日期也占位,前端直接画柱)。 */
  days: WeeklyReportDay[];
  totals: { add: number; update: number; delete: number; conflict: number; total: number };
  /** 各目录汇总,按 total 降序(0 条的目录也在列,便于看出「谁没动」)。 */
  folders: WeeklyReportFolder[];
  /** 对端贡献排名(仅 remote 事件按 deviceId 计),降序。 */
  activeDevices: Array<{ deviceId: string; count: number }>;
  /** 窗口内冲突明细,最新在前,最多 MAX_CONFLICT_ITEMS 条。 */
  conflicts: WeeklyReportConflictItem[];
  /** 窗口内是否有目录记录被保留上限截断(oldestTs 落在窗口内说明可能还有更早的没看到)。 */
  truncated: boolean;
}

/** 毫秒时间戳 → 本地日期键 YYYY-MM-DD。 */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function emptyDay(day: string): WeeklyReportDay {
  return { day, add: 0, update: 0, delete: 0, conflict: 0 };
}

/**
 * 纯聚合:给定「目录 → 该目录全部保留事件」与基准时刻,产出周报。
 * 拆成纯函数是为了可测:IO 采集(collectWeeklyReport)只负责喂数据。
 */
export function aggregateWeeklyReport(
  folders: Array<{ id: string; path: string; events: SyncEvent[] }>,
  now: number,
): WeeklyReport {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const fromTs = startOfToday.getTime() - (REPORT_WINDOW_DAYS - 1) * 86_400_000;

  // 先铺 7 个空格子(旧→新),再往里累加
  const days: WeeklyReportDay[] = [];
  for (let i = 0; i < REPORT_WINDOW_DAYS; i += 1) {
    days.push(emptyDay(dayKey(fromTs + i * 86_400_000)));
  }
  const dayIndex = new Map(days.map((d, i) => [d.day, i]));

  const reportFolders: WeeklyReportFolder[] = [];
  const deviceCount = new Map<string, number>();
  const conflicts: WeeklyReportConflictItem[] = [];
  let add = 0;
  let update = 0;
  let del = 0;
  let conflict = 0;
  let truncated = false;

  for (const f of folders) {
    const row: WeeklyReportFolder = { id: f.id, path: f.path, add: 0, update: 0, delete: 0, conflict: 0, total: 0 };
    // 事件按写入顺序追加,理论升序;不信任存储顺序,统一取最早时间判断截断
    let oldestIn = Number.POSITIVE_INFINITY;
    for (const ev of f.events) {
      if (ev.ts < oldestIn) oldestIn = ev.ts;
      if (ev.ts < fromTs) continue;
      row[ev.action] += 1;
      row.total += 1;
      const di = dayIndex.get(dayKey(ev.ts));
      if (di !== undefined) days[di]![ev.action] += 1;
      if (ev.action === 'conflict') {
        conflicts.push({ ts: ev.ts, folderPath: f.path, path: ev.path, ...(ev.deviceId ? { deviceId: ev.deviceId } : {}) });
      }
      if (ev.direction === 'remote' && ev.deviceId) {
        deviceCount.set(ev.deviceId, (deviceCount.get(ev.deviceId) ?? 0) + 1);
      }
    }
    // 保留窗口最早记录已贴着窗口起点 → 窗口内的量可能已被上限裁掉过
    if (oldestIn !== Number.POSITIVE_INFINITY && oldestIn <= fromTs + 86_400_000) truncated = true;
    add += row.add;
    update += row.update;
    del += row.delete;
    conflict += row.conflict;
    reportFolders.push(row);
  }

  conflicts.sort((a, b) => b.ts - a.ts);
  return {
    fromTs,
    toTs: now,
    days,
    totals: { add, update, delete: del, conflict, total: add + update + del + conflict },
    folders: reportFolders.sort((a, b) => b.total - a.total),
    activeDevices: [...deviceCount.entries()]
      .map(([deviceId, count]) => ({ deviceId, count }))
      .sort((a, b) => b.count - a.count),
    conflicts: conflicts.slice(0, MAX_CONFLICT_ITEMS),
    truncated,
  };
}

/** 采集入口:先把攒批中的新事件落盘,再逐目录读全量保留记录,交给纯聚合器。 */
export function collectWeeklyReport(
  configPath: string,
  folders: Array<{ id: string; path: string }>,
  now = Date.now(),
): WeeklyReport {
  flushSyncHistory(configPath);
  const all = Number.MAX_SAFE_INTEGER;
  return aggregateWeeklyReport(
    folders.map((f) => ({ id: f.id, path: f.path, events: getSyncHistory(configPath, f.id, all).events })),
    now,
  );
}
