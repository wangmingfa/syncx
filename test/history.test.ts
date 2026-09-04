import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordSyncEvent, listSyncHistory, flushSyncHistory, type SyncEvent } from '../src/history.js';

function tmpConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), 'syncx-hist-'));
  return join(dir, 'config.json');
}

const created: string[] = [];
afterEach(() => {
  for (const d of created) rmSync(d, { recursive: true, force: true });
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
