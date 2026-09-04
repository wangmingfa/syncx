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

/** 读取某目录的同步记录,默认最近 200 条,倒序(最新在前)。 */
export function listSyncHistory(configPath: string, folderId: string, limit = 200): SyncEvent[] {
  const file = historyFileFor(configPath, folderId);
  let state = cache.get(file);
  if (!state) {
    state = loadHistory(file);
    cache.set(file, state);
  } else {
    // 有未落盘的变更时先写盘,使外部读取者(如 tail 文件)看到一致内容
    if (state.events.length !== state.persisted) flushHistory(file, state);
  }
  return state.events.slice(-limit).reverse();
}
