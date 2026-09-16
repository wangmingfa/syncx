import { mkdirSync, renameSync, writeFileSync, rmSync, existsSync, statSync, readFileSync, realpathSync, copyFileSync } from 'node:fs';
import { dirname, join, relative, isAbsolute, extname, sep } from 'node:path';
import type { IndexEntry } from './index.js';
import type { IndexStore } from './indexstore.js';
import { verifyBlock, splitIntoBlocks, hashBlock } from './blockstore.js';
import { isHardIgnored } from './ignore.js';
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
 *
 * 同时拒绝硬忽略路径(HARD_IGNORE_NAMES:`.git`/`.hg`/`.svn`/`.syncx-trash`/
 * `.syncx-folder`)。这是硬忽略的**最后一道、也是唯一一道文件系统级闸门**:即使上游
 * 某个调用方漏了过滤,同步也无法把对端内容写进本机 `.git`,更无法把本机的 `.git`
 * 移进回收站。放在这里而不是只放在 peer/scanner 里,是因为「不碰这些路径」最终要由
 * 真正动文件的那一层保证,而这一层是全部读写操作的必经之路。
 */
export function resolveSharePath(root: string, relPath: string): string {
  if (isHardIgnored(relPath)) {
    throw new Error(`hard-ignored path: ${relPath}`);
  }
  // 根目录可能不存在(刚配置尚未创建 / 运行中被删除):realpathSync 会抛 ENOENT。
  // 此时任何候选段也不可能存在(其祖先链断了),越界检查自然跳过;根目录恢复后恢复完整校验。
  const rootReal = existsSync(root) ? realpathSync(root) : undefined;
  const abs = join(root, relPath);
  const rel = relative(root, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`unsafe path: ${relPath}`);
  }

  // 协议路径一律以 '/' 分隔,但 Windows 本地调用方可能传来 '\'(见 scanner 的历史问题)。
  // 两种分隔符都要切分:否则在 Windows 上 '\' 路径整条被当成一个 part,中间目录段的
  // 符号链接越界校验会被静默绕过(安全弱化)。
  const parts = relPath.split(/[\\/]/).filter(Boolean);
  let ancestor = root;
  for (const part of parts) {
    const candidate = join(ancestor, part);
    if (existsSync(candidate) && rootReal !== undefined) {
      const resolved = realpathSync(candidate);
      if (resolved !== rootReal && !resolved.startsWith(rootReal + sep)) {
        throw new Error(`unsafe path: ${relPath}`);
      }
    }
    ancestor = candidate;
  }

  return abs;
}

/**
 * 接收对端文件前的冷启动保护:本机磁盘已存在同名文件、但本机索引尚未记录该路径
 * (目录刚加入 / daemon 刚启动、首扫未跑即遭“热”对端推送)时,把本机原文件保留为
 * `.sync-conflict-<ts>-<remoteDeviceId>` 副本,让出原路径给对端版本落地,避免被静默覆盖。
 * 返回 true 表示已保留副本(原路径已让出),false 表示无需保留(磁盘无该文件)。
 * 经 resolveSharePath 做符号链接越界校验;路径不安全时抛错,由调用方兜底。
 */
export function preserveLocalAsConflict(root: string, path: string, remoteDeviceId: string): boolean {
  const target = resolveSharePath(root, path);
  if (!existsSync(target) || !statSync(target).isFile()) return false;

  const ext = extname(path);
  const base = path.slice(0, path.length - ext.length);
  const ts = Date.now().toString(36);
  let n = 0;
  let copyName: string;
  do {
    const seq = n > 0 ? `-${n.toString(36)}` : '';
    copyName = `${base}.sync-conflict-${ts}${seq}-${remoteDeviceId}${ext}`;
    n++;
  } while (existsSync(resolveSharePath(root, copyName)) && n < 1000);
  renameSync(target, resolveSharePath(root, copyName));
  return true;
}

export function createLocalExecutor(root: string, index: IndexStore): LocalExecutor {
  /** 共享目录内相对路径解析:复用模块级守卫(含符号链接越界校验)。 */
  function resolvePath(relPath: string): string {
    return resolveSharePath(root, relPath);
  }

  /**
   * 把待删除文件移入共享根目录下的回收站(.syncx-trash,已在默认忽略列表中),
   * 而非硬删:误删可经回收站找回,避免 2026-09-15 那样的不可逆数据丢失。
   * 保留原相对路径结构(便于原样还原);同路径短时间内多次删除用自增序号避免覆盖。
   * 同文件系统走 rename(瞬时、原子);跨文件系统或文件被占用(如 Windows)时退化为
   * 拷贝后删,仍保留可恢复副本。
   */
  function moveToTrash(relPath: string): void {
    const target = resolvePath(relPath);
    if (!existsSync(target) || !statSync(target).isFile()) return;
    const trashDir = join(root, '.syncx-trash');
    mkdirSync(trashDir, { recursive: true });
    const stamp = Date.now().toString(36);
    let dest = join(trashDir, `${relPath}.${stamp}`);
    let n = 0;
    while (existsSync(dest)) {
      n += 1;
      dest = join(trashDir, `${relPath}.${stamp}.${n}`);
    }
    mkdirSync(dirname(dest), { recursive: true });
    try {
      renameSync(target, dest);
    } catch {
      // 跨文件系统 / 文件被占用:拷贝保留副本后再删原文件,绝不静默丢弃
      copyFileSync(target, dest);
      rmSync(target);
    }
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
        // 移入回收站而非硬删:误删可经 .syncx-trash 找回(2026-09-15 事故前删除不可恢复)
        moveToTrash(path);
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
      const ext = extname(path);
      const base = path.slice(0, path.length - ext.length);

      // 先获取并校验远端块:失败(对端失联/块校验不符)时本地文件保持不动,
      // 避免本地被 rename 成冲突副本后原路径变空,下一轮扫描产生墓碑并传播删除
      const blocks = await provider.getBlocks(remote);
      if (blocks.length !== remote.blocks.length) {
        throw new Error(`block count mismatch for ${remote.path}`);
      }
      for (let i = 0; i < blocks.length; i++) {
        if (!verifyBlock(blocks[i]!, remote.blocks[i]!)) {
          throw new Error(`block ${i} hash mismatch for ${remote.path}`);
        }
      }

      // 校验通过后才动本地文件:本地内容保留为冲突副本,绝不静默丢弃。
      // 时间戳精度到毫秒 + 逐次递增序号,防止同一毫秒多次冲突时副本文件名碰撞被覆盖
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
