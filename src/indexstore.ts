import { DatabaseSync } from 'node:sqlite';
import type { IndexEntry } from './index.js';
import type { VersionVector } from './version.js';

export interface IndexStore {
  saveEntry(entry: IndexEntry): void;
  getEntry(path: string): IndexEntry | undefined;
  listEntries(): IndexEntry[];
  removeEntry(path: string): void;
  close(): void;
}

function serializeVersion(version: VersionVector): string {
  return JSON.stringify([...version.entries()]);
}

function deserializeVersion(raw: string): VersionVector {
  return new Map(JSON.parse(raw) as Array<[string, number]>);
}

function rowToEntry(row: Record<string, unknown>): IndexEntry {
  return {
    path: row.path as string,
    version: deserializeVersion(row.version as string),
    size: row.size as number,
    deleted: (row.deleted as number) === 1,
    blocks: JSON.parse(row.blocks as string) as string[],
    mtime: row.mtime !== undefined && row.mtime !== null && row.mtime !== 0
      ? (row.mtime as number)
      : undefined,
  };
}

export function openIndexStore(dbPath: string): IndexStore {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      path TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      size INTEGER NOT NULL,
      deleted INTEGER NOT NULL,
      blocks TEXT NOT NULL
    );
  `);
  // 旧库可能没有 mtime 列,安全追加(已存在则忽略)
  try {
    db.exec('ALTER TABLE entries ADD COLUMN mtime INTEGER NOT NULL DEFAULT 0');
  } catch (error) {
    // 仅容忍 duplicate column(旧库已带 mtime 列);其它错误(只读库、锁、
    // schema 损坏等)必须向上抛出,避免带坏 schema 继续运行、保存时才炸
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('duplicate column name')) {
      throw error;
    }
  }

  const saveEntry = db.prepare(
    'INSERT OR REPLACE INTO entries (path, version, size, deleted, blocks, mtime) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const getEntry = db.prepare('SELECT path, version, size, deleted, blocks, mtime FROM entries WHERE path = ?');
  const listEntries = db.prepare('SELECT path, version, size, deleted, blocks, mtime FROM entries');
  const removeEntry = db.prepare('DELETE FROM entries WHERE path = ?');

  return {
    saveEntry(entry: IndexEntry): void {
      saveEntry.run(
        entry.path,
        serializeVersion(entry.version),
        entry.size,
        entry.deleted ? 1 : 0,
        JSON.stringify(entry.blocks),
        entry.mtime ?? 0,
      );
    },
    getEntry(path: string): IndexEntry | undefined {
      const row = getEntry.get(path) as Record<string, unknown> | undefined;
      return row === undefined ? undefined : rowToEntry(row);
    },
    listEntries(): IndexEntry[] {
      return (listEntries.all() as Array<Record<string, unknown>>).map(rowToEntry);
    },
    removeEntry(path: string): void {
      removeEntry.run(path);
    },
    close(): void {
      db.close();
    },
  };
}
