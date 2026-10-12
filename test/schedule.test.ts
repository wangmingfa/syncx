import { describe, expect, it } from 'vitest';
import {
  formatScheduleSummary,
  isWeekdayByClock,
  nextScheduleChangeAt,
  normalizeSchedule,
  scheduleIsUnbounded,
  withinSchedule,
  SCHEDULE_MAX_RULES,
  type Schedule,
} from '../src/schedule.js';

/** 固定时刻用本地时间构造,与判定用的 getHours/getMinutes 口径一致。 */
function at(hour: number, minute: number, day = 15): Date {
  // 2026-01-15 是周四;day=17 是周六
  return new Date(2026, 0, day, hour, minute);
}
const ALWAYS_WORKDAY = (): boolean => true;
const NEVER_WORKDAY = (): boolean => false;

describe('normalizeSchedule(含旧形态迁移与清洗)', () => {
  it('migrates legacy "HH:MM-HH:MM" strings, including cross-midnight', () => {
    expect(normalizeSchedule('09:00-18:00')).toEqual([{ days: { kind: 'any' }, windows: [{ from: 540, to: 1080 }] }]);
    expect(normalizeSchedule('22:00-08:00')).toEqual([{ days: { kind: 'any' }, windows: [{ from: 1320, to: 480 }] }]);
    expect(normalizeSchedule(' 8:05-9:30 ')).toEqual([{ days: { kind: 'any' }, windows: [{ from: 485, to: 570 }] }]);
  });

  it('treats empty, malformed and zero-length windows as "no constraint"', () => {
    for (const bad of [undefined, null, '', '   ', 'nonsense', '25:00-08:00', '12:60-13:00', '22:00', '12:00-12:00']) {
      expect(normalizeSchedule(bad)).toBeUndefined();
    }
  });

  it('accepts clock strings or raw minute numbers in rules, dedupes windows', () => {
    const s = normalizeSchedule([
      { days: { kind: 'workday' }, windows: [{ from: '09:00', to: '18:00' }, { from: 540, to: 1080 }, { from: 0, to: 60 }] },
    ]);
    expect(s).toEqual([
      { days: { kind: 'workday' }, windows: [{ from: 540, to: 1080 }, { from: 0, to: 60 }] },
    ]);
  });

  it('drops rules without any usable window, and collapses 7-day / empty dow to any', () => {
    expect(normalizeSchedule([{ days: { kind: 'any' }, windows: [{ from: 'x', to: 'y' }] }])).toBeUndefined();
    const s = normalizeSchedule([{ days: { kind: 'dow', days: [0, 1, 2, 3, 4, 5, 6] }, windows: [{ from: 0, to: 60 }] }]);
    expect(s?.[0]?.days).toEqual({ kind: 'any' });
    // 空选星期 = 那条日期条件不设限(而不是永不命中)
    const empty = normalizeSchedule([{ days: { kind: 'dow', days: [] }, windows: [{ from: 0, to: 60 }] }]);
    expect(empty?.[0]?.days).toEqual({ kind: 'any' });
  });

  it('clamps rule count to the ceiling and tolerates junk entries', () => {
    const many = Array.from({ length: SCHEDULE_MAX_RULES + 6 }, (_, i) => ({
      days: { kind: 'any' },
      windows: [{ from: i * 60, to: i * 60 + 30 }],
    }));
    const s = normalizeSchedule(many) as Schedule;
    expect(s).toHaveLength(SCHEDULE_MAX_RULES);
    expect(normalizeSchedule([{ nope: 1 }, null, 'x', { days: 'workday', windows: [{ from: 0, to: 30 }] }])).toEqual([
      { days: { kind: 'workday' }, windows: [{ from: 0, to: 30 }] },
    ]);
  });

  it('accepts the single-window shorthand the settings form may emit', () => {
    expect(normalizeSchedule([{ days: { kind: 'offday' }, from: '10:00', to: '20:00' }])).toEqual([
      { days: { kind: 'offday' }, windows: [{ from: 600, to: 1200 }] },
    ]);
  });
});

describe('withinSchedule(规则判定)', () => {
  it('keeps the old semantics: empty/invalid = all day', () => {
    expect(withinSchedule(undefined, at(12, 0))).toBe(true);
    expect(withinSchedule([], at(3, 0))).toBe(true);
    expect(scheduleIsUnbounded([{ days: { kind: 'any' }, windows: [{ from: 300, to: 300 }] }])).toBe(true);
  });

  it('gates a same-day window with inclusive from and exclusive to', () => {
    const s = normalizeSchedule('09:00-18:00');
    expect(withinSchedule(s, at(9, 0))).toBe(true);
    expect(withinSchedule(s, at(17, 59))).toBe(true);
    expect(withinSchedule(s, at(8, 59))).toBe(false);
    expect(withinSchedule(s, at(18, 0))).toBe(false);
  });

  it('gates a cross-midnight window', () => {
    const s = normalizeSchedule('22:00-08:00');
    expect(withinSchedule(s, at(22, 0))).toBe(true);
    expect(withinSchedule(s, at(0, 0))).toBe(true);
    expect(withinSchedule(s, at(7, 59))).toBe(true);
    expect(withinSchedule(s, at(8, 0))).toBe(false);
    expect(withinSchedule(s, at(21, 59))).toBe(false);
  });

  it('ORs rules and ANDs the day predicate with the window', () => {
    // 「工作日 9-18」或「周六 10-20」
    const s: Schedule = [
      { days: { kind: 'workday' }, windows: [{ from: 540, to: 1080 }] },
      { days: { kind: 'dow', days: [6] }, windows: [{ from: 600, to: 1200 }] },
    ];
    expect(withinSchedule(s, at(10, 0, 15), ALWAYS_WORKDAY)).toBe(true); // 周四且算工作日
    expect(withinSchedule(s, at(10, 0, 15), NEVER_WORKDAY)).toBe(false); // 同一天但日历说不算
    expect(withinSchedule(s, at(11, 0, 17), NEVER_WORKDAY)).toBe(true); // 周六 10-20 命中第二条
    expect(withinSchedule(s, at(21, 0, 17), NEVER_WORKDAY)).toBe(false); // 周六但超出窗口
  });

  it('"offday" is exactly the complement of the injected workday answer', () => {
    const s = normalizeSchedule([{ days: { kind: 'offday' }, windows: [{ from: 0, to: 1439 }] }]);
    expect(withinSchedule(s, at(12, 0), NEVER_WORKDAY)).toBe(true);
    expect(withinSchedule(s, at(12, 0), ALWAYS_WORKDAY)).toBe(false);
  });

  it('falls back to weekday-by-clock when no calendar is injected', () => {
    const s = normalizeSchedule([{ days: { kind: 'workday' }, windows: [{ from: 0, to: 1439 }] }]);
    expect(withinSchedule(s, at(12, 0, 15))).toBe(true); // 周四
    expect(withinSchedule(s, at(12, 0, 17))).toBe(false); // 周六
    expect(isWeekdayByClock(at(12, 0, 17))).toBe(false);
  });
});

describe('nextScheduleChangeAt(下一个边界)', () => {
  it('is undefined when unconstrained', () => {
    expect(nextScheduleChangeAt(undefined, at(12, 0))).toBeUndefined();
    expect(nextScheduleChangeAt(normalizeSchedule('00:00-23:59'), at(12, 0))).toBeTypeOf('number');
  });

  it('points at the closing edge while inside, and the opening edge while outside', () => {
    const s = normalizeSchedule('09:00-18:00')!;
    const inside = nextScheduleChangeAt(s, at(12, 0))!;
    expect(new Date(inside).getHours()).toBe(18);
    expect(new Date(inside).getMinutes()).toBe(0);
    const outside = nextScheduleChangeAt(s, at(20, 0))!;
    // 20:00 已出窗口 → 下一个边界是次日 09:00
    expect(new Date(outside).getDate()).toBe(16);
    expect(new Date(outside).getHours()).toBe(9);
  });

  it('crosses into tomorrow for a cross-midnight window', () => {
    const s = normalizeSchedule('22:00-08:00')!;
    const inside = nextScheduleChangeAt(s, at(23, 30))!;
    expect(new Date(inside).getHours()).toBe(8);
    expect(new Date(inside).getDate()).toBe(16);
  });

  it('respects a day-predicate flip at midnight', () => {
    // 「仅工作日 22:00–08:00」:周五 23:30 在窗口内,但窗口本身要到 08:00 才关,
    // 真正先发生的变化是过了零点日期变周六(不再是工作日)——日切换驱动的边界。
    const s = normalizeSchedule([{ days: { kind: 'workday' }, windows: [{ from: 1320, to: 480 }] }])!;
    const next = nextScheduleChangeAt(s, at(23, 30, 16))!; // 2026-01-16 是周五
    expect(new Date(next).getDate()).toBe(17); // 周六零点
    expect(new Date(next).getHours()).toBe(0);
  });
});

describe('formatScheduleSummary', () => {
  it('labels unbounded, single and multi-rule schedules', () => {
    expect(formatScheduleSummary(undefined)).toBe('全天同步');
    expect(formatScheduleSummary(normalizeSchedule('09:00-23:00'))).toBe('每天 09:00–23:00');
    expect(
      formatScheduleSummary([
        { days: { kind: 'workday' }, windows: [{ from: 540, to: 1380 }] },
        { days: { kind: 'dow', days: [6, 0] }, windows: [{ from: 600, to: 1200 }, { from: 0, to: 60 }] },
      ]),
    ).toBe('工作日 09:00–23:00；周六、周日 10:00–20:00、00:00–01:00');
  });
});
