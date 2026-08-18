import { mkdirSync, renameSync, writeFileSync, rmSync, existsSync, statSync, readFileSync } from 'node:fs';
import { dirname, join, relative, isAbsolute, extname } from 'node:path';
import type { IndexEntry } from './index.js';
import type { IndexStore } from './indexstore.js';
import { verifyBlock, splitIntoBlocks, hashBlock } from './blockstore.js';
import { mergeVersions, incrementVersion, createVersionVector } from './version.js';

export interface BlockProvider {
  getBlocks(entry: IndexEntry): Promise<Buffer[]>;
}

export interface LocalExecutor {
  applyReceive(entry: IndexEntry, provider: BlockProvider): Promise<void>;
  applyDelete(path: string, tombstone: IndexEntry): Promise<void>;
  applyConflict(
    path: string,
    local: IndexEntry,
    remote: IndexEntry,
    provider: BlockProvider,
    remoteDeviceId: string,
    conflictPolicy?: 'keep-conflict-copy' | 'keep-newest' | 'keep-larger' | 'keep-local',
  ): Promise<void>;
  applySend(path: string, deviceId: string): Promise<IndexEntry>;
}

export function createLocalExecutor(root: string, index: IndexStore): LocalExecutor {
  function resolvePath(relPath: string): string {
    const abs = join(root, relPath);
    const rel = relative(root, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`unsafe path: ${relPath}`);
    }
    return abs;
  }

  return {
    async applyReceive(entry: IndexEntry, provider: BlockProvider): Promise<void> {
      const blocks = await provider.getBlocks(entry);
      if (blocks.length !== entry.blocks.length) {
        throw new Error(`block count mismatch for ${entry.path}`);
      }
      for (let i = 0; i < blocks.length; i++) {
        if (!verifyBlock(blocks[i]!, entry.blocks[i]!)) {
          throw new Error(`block ${i} hash mismatch for ${entry.path}`);
        }
      }

      const target = resolvePath(entry.path);
      mkdirSync(dirname(target), { recursive: true });

      const tmp = `${target}.syncx-tmp`;
      writeFileSync(tmp, Buffer.concat(blocks));
      renameSync(tmp, target);

      // 记录落盘后的 mtime,供扫描免哈希快速跳过未变更文件
      const mtime = statSync(target).mtimeMs;
      index.saveEntry({ ...entry, mtime });
    },
    async applyDelete(path: string, tombstone: IndexEntry): Promise<void> {
      const target = resolvePath(path);
      if (existsSync(target) && statSync(target).isFile()) {
        rmSync(target);
      }
      index.saveEntry(tombstone);
    },
    async applyConflict(
      path: string,
      local: IndexEntry,
      remote: IndexEntry,
      provider: BlockProvider,
      remoteDeviceId: string,
      conflictPolicy = 'keep-conflict-copy',
    ): Promise<void> {
      const target = resolvePath(path);

      switch (conflictPolicy) {
        case 'keep-local':
          // 保留本地版本,不落地远端,索引保留本地版本
          return;

        case 'keep-newest': {
          // 保留 mtime 较新的版本(本地无 mtime 时用远端)
          if (local.mtime !== undefined && remote.mtime !== undefined) {
            if (local.mtime >= remote.mtime) return; // 本地较新,保留本地
          }
          // 远端较新或无法比较,落地远端版本
          break;
        }

        case 'keep-larger': {
          // 保留文件较大的版本
          if (local.size >= remote.size) return; // 本地较大或相等,保留本地
          // 远端较大,落地远端版本
          break;
        }

        case 'keep-conflict-copy':
        default:
          // 本地内容保留为冲突副本,绝不静默丢弃
          const ext = extname(path);
          const base = path.slice(0, path.length - ext.length);
          const ts = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
          if (existsSync(target)) {
            renameSync(target, resolvePath(`${base}.sync-conflict-${ts}-${remoteDeviceId}${ext}`));
          }
          break;
      }

      // 远端版本落地(临时文件 + rename 原子写)
      const blocks = await provider.getBlocks(remote);
      if (blocks.length !== remote.blocks.length) {
        throw new Error(`block count mismatch for ${remote.path}`);
      }
      for (let i = 0; i < blocks.length; i++) {
        if (!verifyBlock(blocks[i]!, remote.blocks[i]!)) {
          throw new Error(`block ${i} hash mismatch for ${remote.path}`);
        }
      }
      mkdirSync(dirname(target), { recursive: true });
      const tmp = `${target}.syncx-tmp`;
      writeFileSync(tmp, Buffer.concat(blocks));
      renameSync(tmp, target);

      // 索引记录合并版本(双方修改都保留),并写入落地后的 mtime
      const mtime = statSync(target).mtimeMs;
      index.saveEntry({ ...remote, version: mergeVersions(local.version, remote.version), mtime });
    },
    async applySend(path: string, deviceId: string): Promise<IndexEntry> {
      const target = resolvePath(path);
      if (!existsSync(target) || !statSync(target).isFile()) {
        throw new Error(`file not found: ${path}`);
      }

      const data = readFileSync(target);
      const blocks = splitIntoBlocks(data).map(hashBlock);
      const previous = index.getEntry(path);
      const version = incrementVersion(previous?.version ?? createVersionVector(), deviceId);

      const updated: IndexEntry = {
        path,
        version,
        size: data.length,
        deleted: false,
        blocks,
        mtime: statSync(target).mtimeMs,
      };
      index.saveEntry(updated);
      return updated;
    },
  };
}
