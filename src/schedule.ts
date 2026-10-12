/**
 * 同步时段模型(全局 + 目录级共用一份)。
 *
 * 形态:若干条**规则**,规则之间「满足任一即可」(OR);每条规则 = 日期条件「且」
 * 若干个时间窗口(窗口之间也是 OR)。这足以表达日常要用的两类约束:
 *   - 「仅工作日 9:00–23:00」→ 一条规则 {days: workday, windows: [9:00-23:00]}
 *   - 「工作日全天,或周末 10:00–20:00」→ 两条规则
 * 刻意不做任意布尔嵌套:那需要一棵条件树编辑器,而 DNF 已覆盖实际诉求。
 *
 * 三条不变的既有哲学(与旧版 `HH:MM-HH:MM` 一致):
 *  1. **空/缺省 = 全天同步** —— 时段是节流手段,不是安全边界;
 *  2. **解析失败 = 全天同步** —— 绝不为一个配置笔误把目录永久锁死;
 *  3. 窗口 `from === to` 按「这一条不设限」处理,而不是零长度窗口。
 * 按本机时区的墙上时间解释(用户填的就是自己钟表上看到的时间)。
 *
 * 「今天是否工作日」不在本模块判定:由调用方注入 `isWorkday`(见 holidays.ts),
 * 本模块保持纯函数、可脱离文件系统与网络测试。
 */

/** 日期条件。 */
export type DayPredicate =
  | { kind: 'any' }
  /** 工作日:查节假日日历(调休补班的周末算工作日);无日历数据时退化为周一~周五。 */
  | { kind: 'workday' }
  /** 休息日:与 workday 互补(周末与法定休,且排除补班)。 */
  | { kind: 'offday' }
  /** 指定星期几。`days` 用 JS Date.getDay() 口径:0=周日 … 6=周六。 */
  | { kind: 'dow'; days: number[] };

/** 一个时间窗口,单位是「当天第几分钟」;`from > to` 表示跨午夜。 */
export interface ScheduleWindow {
  from: number;
  to: number;
}

export interface ScheduleRule {
  days: DayPredicate;
  windows: ScheduleWindow[];
}

export type Schedule = ScheduleRule[];

/** 规则与窗口的上限:防 UI 误操作刷出巨型配置(每次判定都要扫一遍)。 */
export const SCHEDULE_MAX_RULES = 8;
export const SCHEDULE_MAX_WINDOWS = 8;
const MINUTES_PER_DAY = 1440;

/** 「工作日」判定的注入点(见 holidays.ts 的 createHolidayStore().isWorkday)。 */
export type IsWorkday = (date: Date) => boolean;

/** 周一~周五 —— 仅在完全没有节假日数据可用时的退化口径。 */
export function isWeekdayByClock(date: Date): boolean {
  const d = date.getDay();
  return d >= 1 && d <= 5;
}

function matchesDay(days: DayPredicate, date: Date, isWorkday: IsWorkday): boolean {
  switch (days.kind) {
    case 'any':
      return true;
    case 'workday':
      return isWorkday(date);
    case 'offday':
      return !isWorkday(date);
    case 'dow':
      return days.days.includes(date.getDay());
  }
}

/**
 * 某时刻是否落在窗口内。`from === to` = 不设限(见文件头的哲学第 3 条);
 * `from > to` 跨午夜,拆成「今晚 from 到午夜」与「零点要到」两段。
 */
export function withinWindow(w: ScheduleWindow, minutesOfDay: number): boolean {
  if (w.from === w.to) return true;
  if (w.from < w.to) return minutesOfDay >= w.from && minutesOfDay < w.to;
  return minutesOfDay >= w.from || minutesOfDay < w.to;
}

function minutesOf(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

/** 没有任何有效约束(整体为空、或每条规则都没有有效窗口)= 全天同步。 */
export function scheduleIsUnbounded(schedule: Schedule | undefined): boolean {
  if (!schedule || schedule.length === 0) return true;
  return schedule.every((r) => r.windows.length === 0 || r.windows.some((w) => w.from === w.to));
}

/** 此刻是否允许同步。空/缺省/非法(已在 normalize 里清洗)= 允许。 */
export function withinSchedule(
  schedule: Schedule | undefined,
  date: Date,
  isWorkday: IsWorkday = isWeekdayByClock,
): boolean {
  if (scheduleIsUnbounded(schedule)) return true;
  const mins = minutesOf(date);
  return (schedule ?? []).some(
    (rule) => matchesDay(rule.days, date, isWorkday) && rule.windows.some((w) => withinWindow(w, mins)),
  );
}

/** 次日零点的 Date(按本机时区);`from` 当天 23:59 也算今天,故 +1 天再取零点。 */
function nextMidnight(from: Date): Date {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1, 0, 0, 0, 0);
  return d;
}

/**
 * 下一次「时段状态可能翻转」的时刻(毫秒时间戳),用于文案与准点唤醒:
 * 收集今天/明天凌晨的所有窗口边界 + 次日零点(日期条件会变),按时间升序取
 * **第一个判定结果确实与现在不同**的候选。返回 undefined = 全天无约束。
 *
 * 候选数量有界(规则 ≤8 × 窗口 ≤8 × 2 端点 + 零点),不做分钟级扫描。
 */
export function nextScheduleChangeAt(
  schedule: Schedule | undefined,
  now: Date,
  isWorkday: IsWorkday = isWeekdayByClock,
): number | undefined {
  if (scheduleIsUnbounded(schedule)) return undefined;
  const nowMs = now.getTime();
  const candidates = new Set<number>();
  const addAt = (date: Date, minutes: number): void => {
    const ms = new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      Math.floor(minutes / 60),
      minutes % 60,
      0,
      0,
    ).getTime();
    if (ms > nowMs) candidates.add(ms);
  };
  const tomorrow = nextMidnight(now);
  for (const rule of schedule ?? []) {
    for (const w of rule.windows) {
      if (w.from === w.to) continue;
      // 窗口端点在「日期条件成立的那天」才有意义;不过滤也无妨 —— 后面用真实
      // 判定验证候选,假边界只会被跳过,不会给出错误答案。
      addAt(now, w.from);
      addAt(now, w.to);
      addAt(tomorrow, w.from);
      addAt(tomorrow, w.to);
    }
  }
  candidates.add(tomorrow.getTime()); // 零点:星期/节假日身份切换

  const nowInside = withinSchedule(schedule, now, isWorkday);
  const ordered = [...candidates].sort((a, b) => a - b);
  for (const ms of ordered) {
    if (withinSchedule(schedule, new Date(ms), isWorkday) !== nowInside) return ms;
  }
  return undefined;
}

/* ==================== 解析 / 归一化(含旧格式迁移) ==================== */

const LEGACY_RE = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/;

function parseClock(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw < MINUTES_PER_DAY) {
    return Math.floor(raw);
  }
  if (typeof raw !== 'string') return undefined;
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return undefined;
  return h * 60 + min;
}

function normalizeDays(raw: unknown): DayPredicate {
  if (raw && typeof raw === 'object') {
    const d = raw as { kind?: unknown; days?: unknown };
    switch (d.kind) {
      case 'workday':
      case 'offday':
        return { kind: d.kind };
      case 'dow': {
        const days = Array.isArray(d.days)
          ? [...new Set(d.days.filter((x): x is number => Number.isInteger(x) && x >= 0 && x <= 6))]
          : [];
        // 选了 7 天等于「不限」,归一成 any 免得界面上留一条看起来更严实则等价的规则
        if (days.length === 7) return { kind: 'any' };
        // 空选没有意义(那条规则永不命中),按不设限处理而不是静默锁死
        if (days.length === 0) return { kind: 'any' };
        return { kind: 'dow', days: days.sort((a, b) => a - b) };
      }
      default:
        return { kind: 'any' };
    }
  }
  if (typeof raw === 'string') {
    if (raw === 'workday' || raw === 'offday') return { kind: raw };
  }
  return { kind: 'any' };
}

/**
 * 清洗任意来源(旧配置文件、设置弹窗、手改 JSON)的时段配置。
 * 返回 undefined = 不设限。规则与窗口都去重并截断到上限;任何解析不出来的片段
 * 一律丢弃而不是报错 —— 时段是节流手段,坏数据必须退化成「不设限」,绝不锁死。
 */
export function normalizeSchedule(raw: unknown): Schedule | undefined {
  if (raw == null || raw === '') return undefined;

  // 旧格式:`HH:MM-HH:MM` 字符串(含跨午夜)。迁移成一条「不限日期」的规则。
  if (typeof raw === 'string') {
    const m = LEGACY_RE.exec(raw.trim());
    if (!m) return undefined;
    const from = parseClock(`${m[1]}:${m[2]}`);
    const to = parseClock(`${m[3]}:${m[4]}`);
    if (from === undefined || to === undefined || from === to) return undefined;
    return [{ days: { kind: 'any' }, windows: [{ from, to }] }];
  }

  if (!Array.isArray(raw)) return undefined;
  const rules: ScheduleRule[] = [];
  for (const item of raw.slice(0, SCHEDULE_MAX_RULES)) {
    if (!item || typeof item !== 'object') continue;
    const r = item as { days?: unknown; windows?: unknown; from?: unknown; to?: unknown };
    // 兼容「一条规则只有一个窗口」的简化写法(前端表单的直接产物)
    const rawWindows = Array.isArray(r.windows)
      ? r.windows
      : r.from !== undefined || r.to !== undefined
        ? [{ from: r.from, to: r.to }]
        : [];
    const windows: ScheduleWindow[] = [];
    const seen = new Set<string>();
    for (const w of rawWindows.slice(0, SCHEDULE_MAX_WINDOWS)) {
      if (!w || typeof w !== 'object') continue;
      const pair = w as { from?: unknown; to?: unknown };
      const from = parseClock(pair.from);
      const to = parseClock(pair.to);
      if (from === undefined || to === undefined) continue;
      const key = `${from}-${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      windows.push({ from, to });
    }
    if (windows.length === 0) continue;
    rules.push({ days: normalizeDays(r.days), windows });
  }
  return rules.length > 0 ? rules : undefined;
}

/** 一条规则的界面摘要文案(供徽标 tooltip / 列表行):「工作日 09:00–23:00」。 */
export function formatScheduleSummary(schedule: Schedule | undefined): string {
  if (scheduleIsUnbounded(schedule)) return '全天同步';
  const dayLabel = (d: DayPredicate): string => {
    switch (d.kind) {
      case 'any':
        return '每天';
      case 'workday':
        return '工作日';
      case 'offday':
        return '休息日';
      case 'dow': {
        const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
        return d.days.map((x) => names[x] ?? '?').join('、');
      }
    }
  };
  const clock = (mins: number): string =>
    `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  return (schedule ?? [])
    .map((r) => `${dayLabel(r.days)} ${r.windows.map((w) => `${clock(w.from)}–${clock(w.to)}`).join('、')}`)
    .join('；');
}
