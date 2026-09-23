import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { rmDir } from './helpers.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordSyncEvent, listSyncHistory, getSyncHistory, getGlobalSyncHistory, flushSyncHistory, setHistoryMaxEvents, getHistoryMaxEvents, HISTORY_MAX_EVENTS, type SyncEvent } from '../src/history.js';

function tmpConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), 'syncx-hist-'));
  return join(dir, 'config.json');
}

const created: string[] = [];
afterEach(() => {
  for (const d of created) rmDir(d);
  created.length = 0;
});

function ev(over: Partial<SyncEvent>): SyncEvent {
  return { ts: Date.now(), folderId: 'main', path: 'a.txt', action: 'add', direction: 'local', ...over };
}

describe('sync history', () => {
  it('records and lists events newest-first', () => {
    const config = tmpConfig();
    created.push(join(config, '..'));
    recordSyncEvent(config, ev({ path: 'a.txt', action: 'add' }));
    recordSyncEvent(config, ev({ path: 'b.txt', action: 'update', direction: 'remote', deviceId: 'devX' }));

    const list = listSyncHistory(config, 'main');
    expect(list).toHaveLength(2);
    // 倒序:后记录的 b.txt 在前
    expect(list[0]!.path).toBe('b.txt');
    expect(list[0]!.direction).toBe('remote');
    expect(list[0]!.deviceId).toBe('devX');
    expect(list[1]!.path).toBe('a.txt');
    expect(list[1]!.action).toBe('add');
  });

  it('persists to a jsonl file under configDir/history', () => {
    const config = tmpConfig();
    created.push(join(config, '..'));
    recordSyncEvent(config, ev({ path: 'a.txt' }));
    // 记录默认攒批延迟落盘,查询/显式 flush 时才写盘
    flushSyncHistory(config);
    const file = join(join(config, '..'), 'history', 'main.jsonl');
    expect(existsSync(file)).toBe(true);
  });

  it('respects the limit param', () => {
    const config = tmpConfig();
    created.push(join(config, '..'));
    for (let i = 0; i < 5; i++) recordSyncEvent(config, ev({ ts: 1000 + i, path: `f${i}.txt` }));
    const list = listSyncHistory(config, 'main', 3);
    expect(list).toHaveLength(3);
    expect(list[0]!.path).toBe('f4.txt');
    expect(list[2]!.path).toBe('f2.txt');
  });

  it('trims to the most recent MAX_EVENTS on overflow', () => {
    const config = tmpConfig();
    created.push(join(config, '..'));
    const N = 2005;
    for (let i = 0; i < N; i++) recordSyncEvent(config, ev({ ts: i, path: `f${i}.txt` }));
    const list = listSyncHistory(config, 'main');
    expect(list.length).toBeLessThanOrEqual(2000);
    // 最旧的事件已被轮转丢弃,最新保留
    expect(list[0]!.path).toBe(`f${N - 1}.txt`);
    expect(list.some((e) => e.path === 'f0.txt')).toBe(false);
  });
});

describe('history retention cap (historyMaxEvents)', () => {
  // 上限是模块级单值:无论用例怎么改,组内收尾一律恢复默认,避免污染其它用例的 2000 断言
  afterEach(() => {
    setHistoryMaxEvents(HISTORY_MAX_EVENTS);
  });

  it('applies a custom cap to new events immediately', () => {
    setHistoryMaxEvents(3);
    const config = tmpConfig();
    created.push(join(config, '..'));
    for (let i = 0; i < 5; i++) recordSyncEvent(config, ev({ ts: i, path: `f${i}.txt` }));

    const list = listSyncHistory(config, 'main');
    expect(list).toHaveLength(3);
    // 最旧的 f0/f1 已被轮转丢弃,最新在前
    expect(list.map((e) => e.path)).toEqual(['f4.txt', 'f3.txt', 'f2.txt']);
    // 查询口径的 maxRetention 跟随当前生效上限(前端「共 N」提示用)
    expect(getSyncHistory(config, 'main').maxRetention).toBe(3);
  });

  it('ignores non-positive values and restores the default', () => {
    setHistoryMaxEvents(3);
    setHistoryMaxEvents(0);
    setHistoryMaxEvents(-5);
    expect(getHistoryMaxEvents()).toBe(3);

    setHistoryMaxEvents(undefined);
    expect(getHistoryMaxEvents()).toBe(3);

    setHistoryMaxEvents(HISTORY_MAX_EVENTS);
    expect(getHistoryMaxEvents()).toBe(2000);
  });
});

describe('sync history filter & stats', () => {
  // 固定样本:2 local + 2 remote(devX update / devY conflict),时间戳 100..400
  function seeded(): string {
    const config = tmpConfig();
    created.push(join(config, '..'));
    recordSyncEvent(config, ev({ ts: 100, path: 'a.txt', action: 'add', direction: 'local' }));
    recordSyncEvent(config, ev({ ts: 200, path: 'b.txt', action: 'update', direction: 'remote', deviceId: 'devX' }));
    recordSyncEvent(config, ev({ ts: 300, path: 'docs/c.TXT', action: 'conflict', direction: 'remote', deviceId: 'devY' }));
    recordSyncEvent(config, ev({ ts: 400, path: 'd.txt', action: 'delete', direction: 'local' }));
    return config;
  }

  it('returns total/matched/oldestTs/maxRetention for the UI window', () => {
    const r = getSyncHistory(seeded(), 'main');
    expect(r.total).toBe(4);
    expect(r.matched).toBe(4);
    // 最早记录 = 窗口内第一条(存储序最旧),供「最早记录 xxx」提示
    expect(r.oldestTs).toBe(100);
    expect(r.maxRetention).toBe(2000);
    expect(r.events[0]!.path).toBe('d.txt');
  });

  it('filters by direction / action / device / query', () => {
    const config = seeded();
    expect(getSyncHistory(config, 'main', 200, { direction: 'remote' }).matched).toBe(2);
    expect(getSyncHistory(config, 'main', 200, { direction: 'local' }).matched).toBe(2);
    expect(getSyncHistory(config, 'main', 200, { action: 'conflict' }).events[0]!.path).toBe('docs/c.TXT');
    const dev = getSyncHistory(config, 'main', 200, { deviceId: 'devY' });
    expect(dev.matched).toBe(1);
    expect(dev.events[0]!.deviceId).toBe('devY');
    // 关键词不区分大小写,子串匹配路径
    expect(getSyncHistory(config, 'main', 200, { query: 'c.txt' }).matched).toBe(1);
    expect(getSyncHistory(config, 'main', 200, { query: '.txt' }).matched).toBe(4);
  });

  it('matched counts before limit truncates events', () => {
    const r = getSyncHistory(seeded(), 'main', 1, { direction: 'remote' });
    expect(r.matched).toBe(2);
    expect(r.events).toHaveLength(1);
    // total 始终是筛选前的窗口全貌,前端据此显示「筛选出 X / 共 N」
    expect(r.total).toBe(4);
  });

  it('empty window reports zero counts and null oldestTs', () => {
    const config = tmpConfig();
    created.push(join(config, '..'));
    const r = getSyncHistory(config, 'main');
    expect(r.total).toBe(0);
    expect(r.matched).toBe(0);
    expect(r.oldestTs).toBeNull();
    expect(r.events).toEqual([]);
  });
});

describe('global sync history aggregation', () => {
  it('merges folders newest-first with folderPath attached', () => {
    const config = tmpConfig();
    created.push(join(config, '..'));
    recordSyncEvent(config, ev({ folderId: 'main', ts: 100, path: 'a.txt' }));
    recordSyncEvent(config, ev({ folderId: 'other', ts: 300, path: 'b.txt', action: 'delete' }));
    recordSyncEvent(config, ev({ folderId: 'main', ts: 200, path: 'c.txt', direction: 'remote', deviceId: 'devX' }));
    const folders = [
      { id: 'main', path: 'D:/share/main' },
      { id: 'other', path: 'D:/share/other' },
    ];
    const r = getGlobalSyncHistory(config, folders);
    expect(r.total).toBe(3);
    expect(r.matched).toBe(3);
    expect(r.oldestTs).toBe(100);
    expect(r.events.map((e) => e.path)).toEqual(['b.txt', 'c.txt', 'a.txt']);
    expect(r.events[0]!.folderPath).toBe('D:/share/other');
    expect(r.events[1]!.folderPath).toBe('D:/share/main');
  });

  it('per-folder top-limit truncation stays exact for the global top-limit', () => {
    const config = tmpConfig();
    created.push(join(config, '..'));
    // main 目录 5 条时间戳 500..900,other 一条 100:limit=2 的全局结果必然是 main 的两条最新
    for (let i = 0; i < 5; i++) recordSyncEvent(config, ev({ folderId: 'main', ts: 500 + i * 100, path: `m${i}.txt` }));
    recordSyncEvent(config, ev({ folderId: 'other', ts: 100, path: 'old.txt' }));
    const r = getGlobalSyncHistory(
      config,
      [
        { id: 'main', path: 'main' },
        { id: 'other', path: 'other' },
      ],
      2,
    );
    expect(r.events.map((e) => e.path)).toEqual(['m4.txt', 'm3.txt']);
    // total/matched 仍是各目录全貌之和(与截断无关)
    expect(r.total).toBe(6);
  });

  it('global view honours filters', () => {
    const config = tmpConfig();
    created.push(join(config, '..'));
    recordSyncEvent(config, ev({ folderId: 'main', ts: 100, path: 'a.txt', direction: 'remote', deviceId: 'devX' }));
    recordSyncEvent(config, ev({ folderId: 'other', ts: 200, path: 'b.txt', action: 'conflict' }));
    const folders = [
      { id: 'main', path: 'main' },
      { id: 'other', path: 'other' },
    ];
    const conflicts = getGlobalSyncHistory(config, folders, 200, { action: 'conflict' });
    expect(conflicts.matched).toBe(1);
    expect(conflicts.events[0]!.path).toBe('b.txt');
    // total 不因筛选缩水:提示行要说清「筛出 X / 共 N」
    expect(conflicts.total).toBe(2);
    const remote = getGlobalSyncHistory(config, folders, 200, { deviceId: 'devX' });
    expect(remote.matched).toBe(1);
  });
});
