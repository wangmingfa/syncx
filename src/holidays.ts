import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 节假日日历:回答「今天算不算工作日」。
 *
 * 三条硬约束(与本项目"节流手段不该变成故障源"的一贯取向一致):
 *  1. **判定路径上绝不打网络** —— 只读内存/盘上缓存;网络拉取是后台动作,失败只影响
 *     数据新鲜度,不影响同步是否放行。手机常年无网(见 powerguard 与无网挂起那条线)
 *     是常态而非异常。
 *  2. **没有任何数据时退化为「按星期几判」**(周一~周五 = 工作日),并在状态里标出来,
 *     绝不因拉不到接口就把目录判成永不同步。
 *  3. 缓存落在 `<configDir>/holidays-<year>.json`,**不进 config.json** —— 那个文件被
 *     fs.watch 盯着做热重载,把年度数据写进去会让每次刷新都触发一轮配置重载。
 *
 * 默认源 holiday-cn(逐条摘自国务院公告,含 `isOffDay:false` 的调休补班 —— 中国语境下
 * 「周六上班」必须能表达,否则「工作日」判定整年错位)。地址可在设置里改,关掉自动拉取
 * 就变成纯手动日历。
 */

export type DayType = 'workday' | 'holiday';

/** 默认源:{year} 为占位符。 */
export const DEFAULT_HOLIDAY_SOURCE =
  'https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{year}.json';

/** 单日的手动覆盖(公司放假与国家法定不一致时用)。 */
export type CalendarOverrides = Record<string, DayType>;

const FETCH_TIMEOUT_MS = 15_000;

function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 是真实存在的 `YYYY-MM-DD` 吗。只校格式会把 `2026-13-99`、`2026-02-30` 当有效日期收进
 * 缓存(它们永远匹配不上任何一天,却会长期占着数据并让「已缓存」的判断说谎),所以做一次
 * 回环校验:解析后再格式化,必须与原串逐字相等。
 */
export function isRealDateKey(key: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

/** 解析源返回的 JSON:兼容 holiday-cn 的 days[].isOffDay 与扁平的 {date: true/false} 映射。 */
export function parseHolidayPayload(body: unknown): Record<string, DayType> {
  const out: Record<string, DayType> = {};
  if (!body || typeof body !== 'object') return out;
  const days = (body as { days?: unknown }).days;
  if (Array.isArray(days)) {
    for (const item of days) {
      if (!item || typeof item !== 'object') continue;
      const d = item as { date?: unknown; isOffDay?: unknown };
      if (typeof d.date !== 'string' || !isRealDateKey(d.date)) continue;
      if (typeof d.isOffDay !== 'boolean') continue;
      out[d.date] = d.isOffDay ? 'holiday' : 'workday';
    }
    return out;
  }
  // 扁平映射:{ '2026-10-01': true(休) | false(班) }
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (isRealDateKey(k) && typeof v === 'boolean') out[k] = v ? 'holiday' : 'workday';
  }
  return out;
}

export interface HolidayStoreOptions {
  configDir: string;
  /** 是否允许自动拉取(现读设置;关掉 = 纯手动日历)。 */
  autoFetch: () => boolean;
  /** 源地址模板(现读设置,`{year}` 占位)。 */
  sourceTemplate: () => string;
  /** 手动覆盖(现读 config,改完即时生效)。 */
  overrides: () => CalendarOverrides;
  /** 注入点:测试替身。 */
  fetchImpl?: (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
  logger?: { info(m: string): void; warn(m: string): void; debug?(m: string): void };
  now?: () => Date;
}

export interface HolidayStatus {
  /** 当前关注的年份。 */
  year: number;
  /** 该年是否已有可用的自动拉取数据。 */
  fetched: boolean;
  fetchedAt?: number;
  /** 手动覆盖条数。 */
  overrideCount: number;
  /** 最近一次拉取失败的原因(仅诊断用;不影响判定)。 */
  lastError?: string;
}

export interface HolidayStore {
  /** 该日的日历身份;undefined = 该日无任何日历数据(调用方按星期几退化)。 */
  dayType(date: Date): DayType | undefined;
  /** 是否工作日:覆盖 > 拉取数据 > 周一~周五。 */
  isWorkday(date: Date): boolean;
  status(): HolidayStatus;
  /**
   * 后台刷新:缺该年数据就拉;已进入 12 月则顺带预备下一年(跨年零点不想出现空窗)。
   * 失败只记日志并保留旧数据 —— 判定路径永远可用。
   */
  refresh(): Promise<void>;
  /** 该年的日期表(供日历面板显示);无数据返回 undefined。 */
  yearDays(year: number): Record<string, DayType> | undefined;
}

export function createHolidayStore(opts: HolidayStoreOptions): HolidayStore {
  const now = opts.now ?? (() => new Date());
  const log = opts.logger;
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as NonNullable<HolidayStoreOptions['fetchImpl']>);
  /** year → 日期表;命中盘上缓存时也放进来,避免每次判定读文件 */
  const mem = new Map<number, Record<string, DayType>>();
  const meta = new Map<number, { fetchedAt: number }>();
  let lastError: string | undefined;

  const cachePath = (year: number): string => join(opts.configDir, `holidays-${year}.json`);

  function loadYear(year: number): Record<string, DayType> | undefined {
    const hit = mem.get(year);
    if (hit) return hit;
    const path = cachePath(year);
    try {
      if (!existsSync(path)) return undefined;
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { year?: number; fetchedAt?: number; days?: Record<string, DayType> };
      if (!raw.days || typeof raw.days !== 'object') return undefined;
      const days: Record<string, DayType> = {};
      for (const [k, v] of Object.entries(raw.days)) {
        if (isRealDateKey(k) && (v === 'workday' || v === 'holiday')) days[k] = v;
      }
      mem.set(year, days);
      if (typeof raw.fetchedAt === 'number') meta.set(year, { fetchedAt: raw.fetchedAt });
      return days;
    } catch {
      return undefined; // 坏缓存等同没有,不影响判定
    }
  }

  function saveYear(year: number, days: Record<string, DayType>): void {
    try {
      mkdirSync(opts.configDir, { recursive: true });
      writeFileSync(cachePath(year), JSON.stringify({ year, fetchedAt: Date.now(), days }));
      mem.set(year, days);
      meta.set(year, { fetchedAt: Date.now() });
    } catch (err) {
      log?.warn(`holiday cache write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function fetchYear(year: number): Promise<Record<string, DayType> | undefined> {
    const url = opts.sourceTemplate().replace('{year}', String(year));
    if (!/^https:\/\//i.test(url)) {
      lastError = `节假日源必须是 https 地址:${url}`;
      return undefined;
    }
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) {
        lastError = `节假日源返回 HTTP ${res.status}`;
        return undefined;
      }
      const days = parseHolidayPayload(await res.json());
      if (Object.keys(days).length === 0) {
        lastError = `节假日源数据为空或结构不认识(${year})`;
        return undefined;
      }
      lastError = undefined;
      return days;
    } catch (err) {
      // 离线是常态:这条只留 debug 级线索,不刷 warn
      lastError = err instanceof Error ? err.message : String(err);
      log?.debug?.(`holiday fetch failed (${year}): ${lastError}`);
      return undefined;
    }
  }

  const store: HolidayStore = {
    dayType(date: Date): DayType | undefined {
      const key = dateKey(date);
      const ov = opts.overrides();
      const own = ov[key];
      if (own) return own;
      return loadYear(date.getFullYear())?.[key];
    },

    isWorkday(date: Date): boolean {
      const t = store.dayType(date);
      if (t) return t === 'workday';
      const d = date.getDay(); // 无数据:周一~周五
      return d >= 1 && d <= 5;
    },

    status(): HolidayStatus {
      const year = now().getFullYear();
      const m = meta.get(year);
      return {
        year,
        fetched: m !== undefined,
        fetchedAt: m?.fetchedAt,
        overrideCount: Object.keys(opts.overrides()).length,
        lastError,
      };
    },

    async refresh(): Promise<void> {
      if (!opts.autoFetch()) return;
      const year = now().getFullYear();
      const need = new Set<number>();
      if (!loadYear(year)) need.add(year);
      // 12 月起把下一年也备好:跨年那一刻不至于退回按星期几判
      if (now().getMonth() === 11) {
        if (!loadYear(year + 1)) need.add(year + 1);
      }
      for (const y of need) {
        const days = await fetchYear(y);
        if (days) {
          saveYear(y, days);
          log?.info(`holiday calendar refreshed: ${y} (${Object.keys(days).length} day(s))`);
        }
      }
    },

    yearDays(year: number): Record<string, DayType> | undefined {
      return loadYear(year);
    },
  };

  return store;
}
