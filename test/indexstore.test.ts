import { describe, expect, it } from 'vitest';
import { mkdtempSync, chmodSync } from 'node:fs';
import { rmDir } from './helpers.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openIndexStore } from '../src/indexstore.js';

function entry(path: string, version: Array<[string, number]>, size = 100, deleted = false) {
  return {
    path,
    version: new Map(version),
    size,
    deleted,
    blocks: [],
  };
}

describe('index store', () => {
  it('round-trips a saved entry with its version vector', () => {
    const store = openIndexStore(':memory:');

    store.saveEntry(entry('docs/plan.md', [['dev-a', 2], ['dev-b', 1]]));

    expect(store.getEntry('docs/plan.md')).toEqual(
      entry('docs/plan.md', [['dev-a', 2], ['dev-b', 1]]),
    );

    store.close();
  });

  it('returns undefined for a missing path', () => {
    const store = openIndexStore(':memory:');
    expect(store.getEntry('nope.txt')).toBeUndefined();
    store.close();
  });

  it('overwrites an existing entry on save', () => {
    const store = openIndexStore(':memory:');
    store.saveEntry(entry('docs/plan.md', [['dev-a', 1]]));
    store.saveEntry(entry('docs/plan.md', [['dev-a', 2]], 200, true));

    expect(store.getEntry('docs/plan.md')).toEqual(entry('docs/plan.md', [['dev-a', 2]], 200, true));
    store.close();
  });

  it('lists all saved entries', () => {
    const store = openIndexStore(':memory:');
    store.saveEntry(entry('a.txt', [['dev-a', 1]]));
    store.saveEntry(entry('b.txt', [['dev-b', 2]]));

    expect(store.listEntries()).toEqual([
      entry('a.txt', [['dev-a', 1]]),
      entry('b.txt', [['dev-b', 2]]),
    ]);
    store.close();
  });

  it('removes an entry', () => {
    const store = openIndexStore(':memory:');
    store.saveEntry(entry('a.txt', [['dev-a', 1]]));
    store.removeEntry('a.txt');

    expect(store.getEntry('a.txt')).toBeUndefined();
    store.close();
  });

  it('persists entries across reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-index-'));
    const dbPath = join(dir, 'index.db');

    const store = openIndexStore(dbPath);
    store.saveEntry(entry('persisted.txt', [['dev-a', 5]]));
    store.close();

    const reopened = openIndexStore(dbPath);
    expect(reopened.getEntry('persisted.txt')).toEqual(entry('persisted.txt', [['dev-a', 5]]));
    reopened.close();

    rmDir(dir);
  });

  it('rethrows ALTER TABLE errors that are not a duplicate mtime column', () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-index-'));
    const dbPath = join(dir, 'index.db');

    // 建一个缺 mtime 列的 entries 表,再把文件置为只读:
    // CREATE TABLE IF NOT EXISTS 成功(no-op),ALTER TABLE 抛
    // "attempt to write a readonly database"(非 duplicate column)。
    // 修复前:该错误被吞掉,store 构造继续走到 prepare,抛出的是下游的
    // "no column named mtime";修复后:ALTER 的迁移错误直接向上抛出。
    // 断言错误信息,确保冒出来的是迁移错误本身。
    const raw = new DatabaseSync(dbPath);
    raw.exec('CREATE TABLE entries (path TEXT PRIMARY KEY, version TEXT NOT NULL, size INTEGER NOT NULL, deleted INTEGER NOT NULL, blocks TEXT NOT NULL)');
    raw.close();
    chmodSync(dbPath, 0o444);

    expect(() => openIndexStore(`file:${dbPath}?mode=ro`)).toThrow(/readonly/i);

    rmDir(dir);
  });
});
