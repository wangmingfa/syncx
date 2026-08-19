import { mkdirSync, renameSync, writeFileSync, rmSync, existsSync, statSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, isAbsolute, extname, sep } from 'node:path';
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
  ): Promise<IndexEntry>;
  applySend(path: string, deviceId: string): Promise<IndexEntry>;
}

/**
 * 解析共享目录内的相对路径为绝对路径,并做符号链接越界校验:
 * 沿路径各段自顶向下,对**已存在**的段做 realpath 检查,任何段解析后指向
 * 共享目录之外则抛错。读写两侧共用(applyReceive/applyDelete/applyConflict
 * 与 readLocalBlock),防止对端利用目录内符号链接读写共享目录之外的文件。
 * 尚不存在的路径段(将由 mkdirSync recursive 安全创建)跳过。
 */
export function resolveSharePath(root: string, relPath: string): string {
  const rootReal = realpathSync(root);
  const abs = join(root, relPath);
  const rel = relative(root, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`unsafe path: ${relPath}`);
  }

  const parts = relPath.split(sep).filter(Boolean);
  let ancestor = root;
  for (const part of parts) {
    const candidate = join(ancestor, part);
    if (existsSync(candidate)) {
      const resolved = realpathSync(candidate);
      if (resolved !== rootReal && !resolved.startsWith(rootReal + sep)) {
        throw new Error(`unsafe path: ${relPath}`);
      }
    }
    ancestor = candidate;
  }

  return abs;
}

export function createLocalExecutor(root: string, index: IndexStore): LocalExecutor {
  /** 共享目录内相对路径解析:复用模块级守卫(含符号链接越界校验)。 */
  function resolvePath(relPath: string): string {
    return resolveSharePath(root, relPath);
  }

  /** 校验块完整性并原子落地一个条目:写临时文件 + rename,返回落盘后的 mtime。 */
  async function landRemote(entry: IndexEntry, blocks: Buffer[]): Promise<number> {
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

    return statSync(target).mtimeMs;
  }

  return {
    async applyReceive(entry: IndexEntry, provider: BlockProvider): Promise<void> {
      const blocks = await provider.getBlocks(entry);
      // 记录落盘后的 mtime,供扫描免哈希快速跳过未变更文件
      const mtime = await landRemote(entry, blocks);
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
    ): Promise<IndexEntry> {
      // 双方同时删除:只合并版本向量写墓碑,绝不落盘空文件复活删除
      if (local.deleted && remote.deleted) {
        const merged: IndexEntry = {
          path,
          version: mergeVersions(local.version, remote.version),
          size: 0,
          deleted: true,
          blocks: [],
        };
        index.saveEntry(merged);
        return merged;
      }

      const target = resolvePath(path);

      // 本地内容保留为冲突副本,绝不静默丢弃;远端版本落地
      // 时间戳精度到毫秒 + 逐次递增序号,防止同一毫秒多次冲突时副本文件名碰撞被覆盖
      const ext = extname(path);
      const base = path.slice(0, path.length - ext.length);
      if (existsSync(target)) {
        const ts = Date.now().toString(36);
        let n = 0;
        let copyName: string;
        do {
          const seq = n > 0 ? `-${n.toString(36)}` : '';
          copyName = `${base}.sync-conflict-${ts}${seq}-${remoteDeviceId}${ext}`;
          n++;
        } while (existsSync(resolvePath(copyName)) && n < 1000);
        renameSync(target, resolvePath(copyName));
      }

      const blocks = await provider.getBlocks(remote);
      const mtime = await landRemote(remote, blocks);

      // 索引记录合并版本(双方修改都保留),并写入落地后的 mtime
      const landed: IndexEntry = {
        ...remote,
        version: mergeVersions(local.version, remote.version),
        mtime,
      };
      index.saveEntry(landed);
      return landed;
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
