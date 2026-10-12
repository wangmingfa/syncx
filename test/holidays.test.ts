import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { rmDir } from './helpers.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createHolidayStore,
  parseHolidayPayload,
  DEFAULT_HOLIDAY_SOURCE,
  type HolidayStore,
} from '../src/holidays.js';
import type { CalendarOverrides } from '../src/holidays.js';

/** 2026-10-10 是周六:补班则算工作日,无数据则按周六算休息。 */
const SAT = new Date(2026, 9, 10, 12, 0);
const MON = new Date(2026, 9, 12, 12, 0);

type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

function makeStore(opts: {
  body?: unknown;
  fetchImpl?: FetchLike;
  autoFetch?: boolean;
  overrides?: CalendarOverrides;
  configDir?: string;
  now?: () => Date;
} = {}): { store: HolidayStore; dir: string; urls: string[] } {
  const dir = opts.configDir ?? mkdtempSync(join(tmpdir(), 'syncx-hol-'));
  const urls: string[] = [];
  const fetchImpl: FetchLike =
    opts.fetchImpl ??
    ((url: string) => {
      urls.push(url);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(opts.body) });
    });
  const store = createHolidayStore({
    configDir: dir,
    autoFetch: () => opts.autoFetch !== false,
    sourceTemplate: () => DEFAULT_HOLIDAY_SOURCE,
    overrides: () => opts.overrides ?? {},
    fetchImpl,
    now: opts.now,
  });
  return { store, dir, urls };
}

describe('parseHolidayPayload', () => {
  it('reads holiday-cn days with isOffDay (false = 调休补班)', () => {
    const parsed = parseHolidayPayload({
      year: 2026,
      days: [
        { name: '国庆节', date: '2026-10-01', isOffDay: true },
        { name: '国庆节', date: '2026-10-10', isOffDay: false },
        { name: '坏数据', date: '2026-13-99', isOffDay: true },
        { name: '缺字段', date: '2026-10-05' },
      ],
    });
    expect(parsed).toEqual({ '2026-10-01': 'holiday', '2026-10-10': 'workday' });
  });

  it('accepts a flat date→boolean map and ignores junk payloads', () => {
    expect(parseHolidayPayload({ '2026-05-01': true, '2026-05-09': false, junk: 'x' })).toEqual({
      '2026-05-01': 'holiday',
      '2026-05-09': 'workday',
    });
    expect(parseHolidayPayload(null)).toEqual({});
    expect(parseHolidayPayload('nope')).toEqual({});
    expect(parseHolidayPayload({ days: 'nope' })).toEqual({});
  });
});

describe('holiday store 判定优先级', () => {
  it('覆盖 > 拉取数据 > 按星期几退化', async () => {
    const { store, dir } = makeStore({
      body: { days: [{ date: '2026-10-10', isOffDay: false }] }, // 补班周六
      overrides: { '2026-10-12': 'holiday' }, // 周一被公司改成休息
    });
    await store.refresh();
    expect(store.isWorkday(SAT)).toBe(true); // 数据说补班
    expect(store.isWorkday(MON)).toBe(false); // 覆盖说休息
    rmDir(dir);
  });

  it('无任何数据时按星期几判,且周一算工作日', () => {
    const { store, dir } = makeStore({ autoFetch: false });
    expect(store.isWorkday(SAT)).toBe(false);
    expect(store.isWorkday(MON)).toBe(true);
    expect(store.status().fetched).toBe(false);
    rmDir(dir);
  });

  it('把缓存写成独立文件,重启后仍生效;autoFetch=false 时不发请求', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-hol-'));
    const first = makeStore({ configDir: dir, body: { days: [{ date: '2026-10-01', isOffDay: true }] } });
    await first.store.refresh();
    expect(existsSync(join(dir, 'holidays-2026.json'))).toBe(true);
    expect(first.urls).toEqual([DEFAULT_HOLIDAY_SOURCE.replace('{year}', '2026')]);

    // 重新构造(模拟 daemon 重启):不配任何 fetch 也应从盘上读出缓存
    const second = createHolidayStore({
      configDir: dir,
      autoFetch: () => false,
      sourceTemplate: () => DEFAULT_HOLIDAY_SOURCE,
      overrides: () => ({}),
      fetchImpl: vi.fn(() => Promise.reject(new Error('不该发请求'))) as never,
    });
    expect(second.isWorkday(new Date(2026, 9, 1, 12, 0))).toBe(false);
    expect(second.status().fetched).toBe(true);
    rmDir(dir);
  });

  it('拉取失败 / 空数据都不影响判定,只留诊断', async () => {
    const { store, dir } = makeStore({
      fetchImpl: (async () => {
        throw new Error('ENETUNREACH');
      }) as never,
    });
    await expect(store.refresh()).resolves.toBeUndefined(); // 绝不抛
    expect(store.isWorkday(MON)).toBe(true); // 退化成按星期几
    expect(store.status().fetched).toBe(false);
    expect(store.status().lastError).toContain('ENETUNREACH');
    rmDir(dir);
  });

  it('已有当年缓存就不再发请求,缓存继续供判定;无缓存 + 非 2xx 则只留诊断', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-hol-'));
    writeFileSync(join(dir, 'holidays-2026.json'), JSON.stringify({ year: 2026, fetchedAt: 1, days: { '2026-10-01': 'holiday' } }));
    let calls = 0;
    const store = createHolidayStore({
      configDir: dir,
      autoFetch: () => true,
      sourceTemplate: () => DEFAULT_HOLIDAY_SOURCE,
      overrides: () => ({}),
      fetchImpl: (async () => {
        calls++;
        return { ok: false, status: 503, json: () => Promise.resolve(null) };
      }) as never,
    });
    await store.refresh();
    expect(calls).toBe(0); // 缓存已覆盖当年 → 不重复拉取
    expect(store.status().fetched).toBe(true);
    expect(store.isWorkday(new Date(2026, 9, 1, 12, 0))).toBe(false);

    // 换到没有缓存的一年:非 2xx 只记失败,判定退化成按星期几(周四 → 工作日)
    writeFileSync(join(dir, 'holidays-2027.json'), 'not json');
    unlinkSync(join(dir, 'holidays-2027.json'));
    const nextYear = createHolidayStore({
      configDir: dir,
      autoFetch: () => true,
      sourceTemplate: () => DEFAULT_HOLIDAY_SOURCE,
      overrides: () => ({}),
      now: () => new Date(2027, 9, 1, 12, 0),
      fetchImpl: (async () => {
        calls++;
        return { ok: false, status: 503, json: () => Promise.resolve(null) };
      }) as never,
    });
    await nextYear.refresh();
    expect(calls).toBe(1);
    expect(nextYear.status().fetched).toBe(false);
    expect(nextYear.isWorkday(new Date(2027, 9, 14, 12, 0))).toBe(true); // 周四,无数据按星期几
    rmDir(dir);
  });

  it('缓存文件坏了也当没有,不抛异常', () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-hol-'));
    writeFileSync(join(dir, 'holidays-2026.json'), '{ not json');
    const store = createHolidayStore({
      configDir: dir,
      autoFetch: () => false,
      sourceTemplate: () => DEFAULT_HOLIDAY_SOURCE,
      overrides: () => ({}),
    });
    expect(store.yearDays(2026)).toBeUndefined();
    expect(store.isWorkday(new Date(2026, 9, 1, 12, 0))).toBe(true); // 周四
    rmDir(dir);
  });

  it('12 月会预备下一年数据', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-hol-'));
    const urls: string[] = [];
    const store = createHolidayStore({
      configDir: dir,
      autoFetch: () => true,
      sourceTemplate: () => DEFAULT_HOLIDAY_SOURCE,
      overrides: () => ({}),
      now: () => new Date(2026, 11, 5, 10, 0),
      fetchImpl: (async (url: string) => {
        urls.push(url);
        return { ok: true, status: 200, json: () => Promise.resolve({ days: [{ date: '2027-01-01', isOffDay: true }] }) };
      }) as never,
    });
    await store.refresh();
    expect(urls.some((u) => u.includes('2026'))).toBe(true);
    expect(urls.some((u) => u.includes('2027'))).toBe(true);
    rmDir(dir);
  });
});
