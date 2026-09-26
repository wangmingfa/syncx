import { mkdirSync, renameSync, writeFileSync, rmSync, existsSync, statSync, readFileSync, realpathSync, copyFileSync, readdirSync } from 'node:fs';
import { dirname, basename, join, relative, isAbsolute, extname, sep } from 'node:path';
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
  /**
   * 冲突自动策略 local-wins / newest-wins(本机 mtime 更新)的落地:内容不动、
   * 不生成冲突副本,只把版本向量合并进本地条目并持久化。
   *
   * 合并结果支配对端版本(mergeVersions 取逐设备最大值),对端下一轮规划会判
   * 「本地较新」并主动来拉本机内容 —— 收敛由协议自然完成,这里无需额外推送。
   */
  applyConflictKeepLocal(local: IndexEntry, remote: IndexEntry): Promise<IndexEntry>;
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
 * `.syncx-folder`,以及冲突副本命名)。这是硬忽略的**最后一道、也是唯一一道文件系统级闸门**:
 * 即使上游某个调用方漏了过滤,同步也无法把对端内容写进本机 `.git`,更无法把本机的 `.git`
 * 移进回收站。放在这里而不是只放在 peer/scanner 里,是因为「不碰这些路径」最终要由
 * 真正动文件的那一层保证,而这一层是全部读写操作的必经之路。
 *
 * `allowHardIgnored`:仅供冲突处理链路(生成副本 / 收件箱合并 / 丢弃)使用 —— 冲突副本
 * 本身就是硬忽略对象,这些操作天然要碰它;符号链接越界守卫**不受该选项影响**,永远生效。
 */
export function resolveSharePath(
  root: string,
  relPath: string,
  opts?: { allowHardIgnored?: boolean },
): string {
  if (!opts?.allowHardIgnored && isHardIgnored(relPath)) {
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
  // 副本命名本身就是硬忽略对象 → allowHardIgnored(越界守卫不受影响)
  do {
    const seq = n > 0 ? `-${n.toString(36)}` : '';
    copyName = `${base}.sync-conflict-${ts}${seq}-${remoteDeviceId}${ext}`;
    n++;
  } while (existsSync(resolveSharePath(root, copyName, { allowHardIgnored: true })) && n < 1000);
  renameSync(target, resolveSharePath(root, copyName, { allowHardIgnored: true }));
  return true;
}

/**
 * 创建一个共享目录的本地执行器。
 *
 * @param trashDir 删除回收站目录的绝对路径。**刻意由调用方传入而不是在共享根下现算**:
 *   回收站放在共享目录里会在用户目录中留下常驻痕迹(并被 `git status` 报成未跟踪文件),
 *   故生产路径一律传 `<configDir>/trash/<index key>`(见 config.folderTrashPath)。
 * @param versionsDir 文件版本目录的绝对路径,生产路径传 `<configDir>/versions/<index key>`
 *   (见 config.folderVersionsPath)。本机文件被对端版本**覆盖**前,旧内容快照一份到这里:
 *   回收站保护「删除」,版本目录保护「修改」。缺省(旧调用方/测试)不做版本快照。
 * @param opts.versionsPerPath 每路径保留的版本份数上限(超出删最旧)。缺省 10;
 *   生产路径由 config.versionsPerPath 注入(设置页可调),改值后由 daemon 重建执行器生效。
 */
export function createLocalExecutor(
  root: string,
  index: IndexStore,
  trashDir: string,
  versionsDir?: string,
  opts?: { versionsPerPath?: number },
): LocalExecutor {
  /** 每个路径保留的版本份数上限:超出删最旧。版本目录是安全网而非归档,无界增长不合适。 */
  const MAX_VERSIONS_PER_PATH = Math.max(1, Math.floor(opts?.versionsPerPath ?? 10));

  /** 共享目录内相对路径解析:复用模块级守卫(含符号链接越界校验)。 */
  function resolvePath(relPath: string): string {
    return resolveSharePath(root, relPath);
  }

  /**
   * 冲突副本专用解析:副本命名属硬忽略对象,生成副本这一步必须绕过硬忽略闸门,
   * 但仍走完整的符号链接越界守卫(见 resolveSharePath 的 allowHardIgnored 说明)。
   */
  function resolveConflictCopyPath(relPath: string): string {
    return resolveSharePath(root, relPath, { allowHardIgnored: true });
  }

  /**
   * 把待删除文件移入回收站(共享目录之外),而非硬删:误删可经回收站找回,避免
   * 2026-09-15 那样的不可逆数据丢失。保留原相对路径结构(便于原样还原);
   * 同路径短时间内多次删除用自增序号避免覆盖。
   * 同文件系统走 rename(瞬时、原子);跨文件系统(共享盘与配置目录不同盘)或文件被
   * 占用(如 Windows)时退化为拷贝后删,仍保留可恢复副本。
   */
  function moveToTrash(relPath: string): void {
    const target = resolvePath(relPath);
    if (!existsSync(target) || !statSync(target).isFile()) return;
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

  /**
   * 把待覆盖文件的当前内容快照进版本目录(共享目录之外),再由 landRemote 覆盖:
   * 回收站保护「删除」,这里保护「修改」——对端推送覆盖本机现存文件时,旧内容
   * 不再直接丢失。命名 `<relPath>.syncx-v-<stamp>`(碰撞加序号):`.syncx-v-`
   * 后缀是显式标记,恢复时据此无歧义地反推原始相对路径。
   * 快照动作绝不能让原文件消失:rename 失败(跨文件系统/文件被占用)退化为
   * 拷贝,原文件保持原样,随后照常被覆盖。
   */
  function snapshotVersion(relPath: string): void {
    if (versionsDir === undefined) return;
    const target = resolvePath(relPath);
    if (!existsSync(target) || !statSync(target).isFile()) return;
    mkdirSync(versionsDir, { recursive: true });
    const stamp = Date.now().toString(36);
    let dest = join(versionsDir, `${relPath}.syncx-v-${stamp}`);
    let n = 0;
    while (existsSync(dest)) {
      n += 1;
      dest = join(versionsDir, `${relPath}.syncx-v-${stamp}.${n}`);
    }
    mkdirSync(dirname(dest), { recursive: true });
    try {
      renameSync(target, dest);
    } catch {
      copyFileSync(target, dest);
    }
  }

  /**
   * 快照后修剪:同一路径的版本超过上限时删最旧。
   * 按文件名排序近似按时间排序 —— stamp 是单调递增的 base36 时间戳,同一路径下
   * 字典序即时间序;碰撞序号(.n)也在同一文件名内,不影响比较。
   * 版本文件保留了原相对路径的目录结构(docs/plan.md 的留档在 <versionsDir>/docs/),
   * 所以必须在「relPath 的父目录」里按 basename 前缀筛——只扫顶层会漏掉所有嵌套
   * 路径,每路径上限对它们失效(无界增长)。
   */
  function pruneVersions(relPath: string): void {
    if (versionsDir === undefined) return;
    const dir = dirname(join(versionsDir, relPath));
    const prefix = `${basename(relPath)}.syncx-v-`;
    let names: string[];
    try {
      names = readdirSync(dir).filter((n) => n.startsWith(prefix));
    } catch {
      return; // 版本目录还没建等异常:修剪是 best-effort,不阻塞落地
    }
    if (names.length <= MAX_VERSIONS_PER_PATH) return;
    names.sort();
    for (const name of names.slice(0, names.length - MAX_VERSIONS_PER_PATH)) {
      try {
        rmSync(join(dir, name));
      } catch {
        // 单个删除失败(占用等):留给下一次快照再试
      }
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
    // 覆盖现存文件前先留存旧内容(全新文件接收不产生版本)。applyConflict 路径
    // 的本地文件已 rename 成 .sync-conflict- 副本让出原路径,天然不会重复快照。
    snapshotVersion(entry.path);
    pruneVersions(entry.path);
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
        // 移入回收站而非硬删:误删可经回收站找回(2026-09-15 事故前删除不可恢复)
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
        } while (existsSync(resolveConflictCopyPath(copyName)) && n < 1000);
        renameSync(target, resolveConflictCopyPath(copyName));
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
    async applyConflictKeepLocal(local: IndexEntry, remote: IndexEntry): Promise<IndexEntry> {
      // 本地内容胜出:磁盘一字不动,只在索引里采纳合并后的版本向量。
      // 保留本地 mtime(文件没变);merged 支配双方,对端自然转判「我方较新」来拉取。
      const keep: IndexEntry = {
        ...local,
        version: mergeVersions(local.version, remote.version),
      };
      index.saveEntry(keep);
      return keep;
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
