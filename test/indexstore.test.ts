import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openIndexStore } from '../src/indexstore.js';

function entry(path: string, version: Array<[string, number]>, size = 100, deleted = false) {
  return {
    path,
    version: new Map(version),
    size,
    deleted,
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

    rmSync(dir, { recursive: true, force: true });
  });
});
