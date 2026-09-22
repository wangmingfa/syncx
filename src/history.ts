import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 同步记录的变更动作。 */
export type SyncAction = 'add' | 'update' | 'delete' | 'conflict';

/** 变更方向:local=本机扫描发现,remote=对端推送过来。 */
export type SyncDirection = 'local' | 'remote';

/** 一条同步记录:某目录内某文件的某次变更。 */
export interface SyncEvent {
  ts: number;
  folderId: string;
  path: string;
  action: SyncAction;
  direction: SyncDirection;
  /** 对端设备 ID(仅 remote 方向有值)。 */
  deviceId?: string;
}

/** 单个目录保留的最大记录条数(超出后整文件轮转,仅保留最近 MAX_EVENTS 条)。 */
const MAX_EVENTS = 2000;

/** 对外导出的保留上限:API 层用它 clamp limit、响应里回填 maxRetention,避免 2000 散落两处。 */
export const HISTORY_MAX_EVENTS = MAX_EVENTS;

/** 同步记录读取的筛选条件(服务端筛选;缺省字段 = 该维度不筛)。 */
export interface SyncHistoryFilter {
  /** 变更方向。 */
  direction?: SyncDirection;
  /** 对端设备 ID:事件必须携带相同 deviceId(local 事件没有 deviceId,自然被排除)。 */
  deviceId?: string;
  /** 变更动作。 */
  action?: SyncAction;
  /** 路径关键词(不区分大小写的子串匹配)。 */
  query?: string;
}

/** 一次历史查询的完整结果:展示窗口内的事件 + 前端统计所需口径。 */
export interface SyncHistoryResult {
  /** 命中筛选、按 limit 截断后的事件,倒序(最新在前)。 */
  events: SyncEvent[];
  /** 保留窗口内的全部记录条数(筛选前)。 */
  total: number;
  /** 命中筛选条件的条数(截断前);前端据此决定「加载更多」是否出现。 */
  matched: number;
  /** 保留窗口内最早一条记录的时间戳;无记录为 null。 */
  oldestTs: number | null;
  /** 保留上限(= HISTORY_MAX_EVENTS)。 */
  maxRetention: number;
}

// 内存缓存:键为历史文件路径,事件在内存累积、攒批落盘,
// 避免大批量同步时每条变更都触发一次同步文件 IO(慢设备上会明显拖慢同步)。
interface HistoryState {
  events: SyncEvent[];
  /** 已落盘的事件条数(文件中已有的行数),用于增量追加。 */
  persisted: number;
  timer?: NodeJS.Timeout;
}

const cache = new Map<string, HistoryState>();

/** 攒批落盘延迟:合并短时间内的连续变更,减少 IO 次数。 */
const FLUSH_DELAY_MS = 200;

/** 已确保存在的历史目录,避免每条记录都做一次 mkdir 系统调用。 */
const ensuredDirs = new Set<string>();
/** (configPath, folderId) → 历史文件路径的缓存,避免重复拼接与正则转义。 */
const fileCache = new Map<string, string>();

/** 由 config 路径与目录 ID 推导该目录的历史文件路径(存于 config 同级的 history/ 目录)。 */
function historyFileFor(configPath: string, folderId: string): string {
  const cacheKey = `${configPath}\u0000${folderId}`;
  const hit = fileCache.get(cacheKey);
  if (hit) return hit;
  const histDir = join(dirname(configPath), 'history');
  // 目录 ID 可能含非文件名安全字符(如路径分隔),统一转义为下划线
  const safe = folderId.replace(/[^A-Za-z0-9._-]/g, '_');
  const file = join(histDir, `${safe}.jsonl`);
  if (!ensuredDirs.has(histDir)) {
    mkdirSync(histDir, { recursive: true });
    ensuredDirs.add(histDir);
  }
  fileCache.set(cacheKey, file);
  return file;
}

function loadHistory(file: string): HistoryState {
  if (!existsSync(file)) return { events: [], persisted: 0 };
  try {
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const events = lines.map((l) => JSON.parse(l) as SyncEvent).slice(-MAX_EVENTS);
    return { events, persisted: events.length };
  } catch {
    // 损坏则视为空,下次落盘会整文件重写
    return { events: [], persisted: 0 };
  }
}

/**
 * 将内存态写入磁盘。超过 MAX_EVENTS 时先轮转(仅保留最近 MAX_EVENTS 条并整文件重写),
 * 否则只增量追加未落盘的部分。
 */
function flushHistory(file: string, state: HistoryState): void {
  if (state.events.length > MAX_EVENTS) {
    state.events = state.events.slice(-MAX_EVENTS);
    // 尾部虽连续但已裁剪,文件与内存不再对应,标记整文件重写
    state.persisted = 0;
  }
  try {
    if (state.persisted === 0) {
      const body = state.events.map((e) => JSON.stringify(e)).join('\n');
      writeFileSync(file, state.events.length > 0 ? body + '\n' : '');
    } else if (state.events.length > state.persisted) {
      const pending = state.events.slice(state.persisted).map((e) => JSON.stringify(e));
      appendFileSync(file, pending.join('\n') + '\n');
    }
    state.persisted = state.events.length;
  } catch {
    // 磁盘不可写:保留内存态,下次落盘重试
  }
}

/** 记录一条同步变更:内存追加 + 延迟攒批落盘。 */
export function recordSyncEvent(configPath: string, ev: SyncEvent): void {
  const file = historyFileFor(configPath, ev.folderId);
  let state = cache.get(file);
  if (!state) {
    state = loadHistory(file);
    cache.set(file, state);
  }
  state.events.push(ev);
  if (state.timer) return;
  const timer = setTimeout(() => {
    state!.timer = undefined;
    flushHistory(file, state!);
  }, FLUSH_DELAY_MS);
  // 不阻止进程退出
  timer.unref?.();
  state.timer = timer;
}

/** 立即把待落盘的记录写盘(查询前调用,保证读到最新)。 */
export function flushSyncHistory(configPath: string, folderId?: string): void {
  if (folderId) {
    const state = cache.get(historyFileFor(configPath, folderId));
    if (state) flushHistory(historyFileFor(configPath, folderId), state);
    return;
  }
  for (const [file, state] of cache) flushHistory(file, state);
}

/** 取某目录的历史内存态(冷启动则从盘加载;有未落盘变更先写盘,保证读到的内容一致)。 */
function stateForRead(configPath: string, folderId: string): HistoryState {
  const file = historyFileFor(configPath, folderId);
  let state = cache.get(file);
  if (!state) {
    state = loadHistory(file);
    cache.set(file, state);
  } else {
    // 有未落盘的变更时先写盘,使外部读取者(如 tail 文件)看到一致内容
    if (state.events.length !== state.persisted) flushHistory(file, state);
  }
  return state;
}

/** 一条事件是否命中筛选条件(缺省维度一律放行)。 */
function matchesFilter(ev: SyncEvent, f: SyncHistoryFilter): boolean {
  if (f.direction && ev.direction !== f.direction) return false;
  if (f.deviceId && ev.deviceId !== f.deviceId) return false;
  if (f.action && ev.action !== f.action) return false;
  if (f.query && !ev.path.toLowerCase().includes(f.query.toLowerCase())) return false;
  return true;
}

/** 读取某目录的同步记录 + 统计(供 API 层:筛选、共 N 条、最早记录、加载更多都靠这个口径)。 */
export function getSyncHistory(
  configPath: string,
  folderId: string,
  limit = 200,
  filter?: SyncHistoryFilter,
): SyncHistoryResult {
  const all = stateForRead(configPath, folderId).events;
  const filtered = filter && (filter.direction || filter.deviceId || filter.action || filter.query)
    ? all.filter((ev) => matchesFilter(ev, filter))
    : all;
  return {
    events: filtered.slice(-limit).reverse(),
    total: all.length,
    matched: filtered.length,
    oldestTs: all.length > 0 ? all[0]!.ts : null,
    maxRetention: MAX_EVENTS,
  };
}

/** 读取某目录的同步记录,默认最近 200 条,倒序(最新在前)。 */
export function listSyncHistory(configPath: string, folderId: string, limit = 200): SyncEvent[] {
  return getSyncHistory(configPath, folderId, limit).events;
}

/** 全局时间线里的一条记录:事件 + 所属目录的展示路径(聚合层补,不落盘)。 */
export interface GlobalSyncHistoryEntry extends SyncEvent {
  folderPath: string;
}

/** 全局时间线聚合结果(与单目录同口径;total/matched 为各目录之和)。 */
export interface GlobalSyncHistoryResult {
  events: GlobalSyncHistoryEntry[];
  total: number;
  matched: number;
  oldestTs: number | null;
  /** 每目录各自的保留上限(全局视图是「各目录分别保留 M 条」的并集)。 */
  maxRetention: number;
}

/**
 * 汇总各目录的同步记录,按时间归并(全局时间线)。
 *
 * 每目录各取筛选后的前 `limit` 条再归并 —— 这是正确而非取巧的截断:
 * 某条事件若要进入全局前 limit,它在自己目录里必然也位于前 limit
 * (目录内若已有 ≥limit 条更新,全局只会更多)。所以单目录截掉的部分
 * 永远不可能挤进全局结果,归并后取前 limit 即精确的全局前 limit。
 */
export function getGlobalSyncHistory(
  configPath: string,
  folders: Array<{ id: string; path: string }>,
  limit = 200,
  filter?: SyncHistoryFilter,
): GlobalSyncHistoryResult {
  let total = 0;
  let matched = 0;
  let oldestTs: number | null = null;
  const merged: GlobalSyncHistoryEntry[] = [];
  for (const f of folders) {
    const r = getSyncHistory(configPath, f.id, limit, filter);
    total += r.total;
    matched += r.matched;
    if (r.oldestTs !== null) oldestTs = oldestTs === null ? r.oldestTs : Math.min(oldestTs, r.oldestTs);
    for (const ev of r.events) merged.push({ ...ev, folderPath: f.path });
  }
  merged.sort((a, b) => b.ts - a.ts);
  return { events: merged.slice(0, limit), total, matched, oldestTs, maxRetention: MAX_EVENTS };
}

/** 清空某目录的同步记录:移除内存态、取消未落盘的攒批定时器,并截断磁盘文件。 */
export function clearSyncHistory(configPath: string, folderId: string): void {
  const file = historyFileFor(configPath, folderId);
  const state = cache.get(file);
  if (state?.timer) {
    // 取消未落盘定时器,否则清空后它仍会把旧事件写回磁盘
    clearTimeout(state.timer);
    state.timer = undefined;
  }
  cache.delete(file);
  if (existsSync(file)) {
    try {
      writeFileSync(file, '');
    } catch {
      // 磁盘不可写:内存态已清,后续任何重读都会得到空记录
    }
  }
}
