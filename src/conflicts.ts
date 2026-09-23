import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveSharePath } from './executor.js';
import { CONFLICT_COPY_RE, HARD_IGNORE_NAMES } from './ignore.js';

/**
 * 冲突副本的识别与处理(冲突收件箱的后端半边)。
 *
 * 冲突在盘上的实体是版本向量判撞时生成的 `.sync-conflict-*` 副本
 * (命名见 executor 的 preserveLocalAsConflict / applyConflict):
 *   <原路径去扩展名>.sync-conflict-<ts36>[-<seq36>]-<对端设备ID><扩展名>
 * 设备 ID 是 10 位 base32(A-Z2-7,无连字符),因此命名可以无歧义反解:
 * 去掉 `.sync-conflict-…-<设备ID>` 段即原文件路径,设备 ID 即冲突来源。
 *
 * 本模块只做纯文件操作(root 由调用方解析好传入),不碰索引与会话 ——
 * 处理完由调用方触发一轮扫描,让结果沿正常同步路径传播给对端。
 */

/** 一条冲突副本(收件箱列表项)。 */
export interface ConflictCopy {
  /** 冲突副本相对共享根的路径(用 / 分隔)。 */
  copyPath: string;
  /** 被让位的原文件相对路径。 */
  originalPath: string;
  /** 冲突来源的对端设备 ID。 */
  deviceId: string;
  size: number;
  mtime: number;
  /**
   * 副本与原文件是否逐字节一致(收件箱据此支持「一键清理无差异副本」):
   *  - true:大小相同且内容比对相同;
   *  - false:大小不同(免读直接判),或大小相同但内容不同;
   *  - null:无法判定 —— 原文件已不存在,或超过比对上限(大文件不做同步读盘)。
   */
  identical: boolean | null;
}

/** 冲突处理动作:keep-local=用副本覆盖回原路径;discard=副本进回收站。 */
export type ConflictChoice = 'keep-local' | 'discard';

/** 副本命名反解:命中返回 { originalPath, deviceId },非冲突命名返回 null。
 *  正则与 ignore.ts 的硬忽略判定同源(CONFLICT_COPY_RE),两处不会漂移。 */
export function parseConflictCopy(
  relPath: string,
): { originalPath: string; deviceId: string } | null {
  const m = CONFLICT_COPY_RE.exec(relPath);
  if (!m) return null;
  return { originalPath: m[1]! + (m[3] ?? ''), deviceId: m[2]! };
}

/** 递归列目录的熔断上限:共享根可能是整个数据盘,扫爆不如截断(UI 提示可见条目数)。 */
const MAX_SCAN_ENTRIES = 20_000;
const MAX_RESULTS = 500;
/** 内容比对上限:更大的副本不判(返回 null),避免列接口为超大文件成对读盘。 */
const IDENTICAL_MAX_BYTES = 32 * 1024 * 1024;

/** 副本与原文件是否逐字节一致;原文件缺失或超过上限返回 null(无法判定)。 */
function compareWithOriginal(copyAbs: string, originalAbs: string, size: number): boolean | null {
  let origStat;
  try {
    origStat = statSync(originalAbs);
  } catch {
    return null; // 原文件已被删除/移走:无从比对
  }
  if (!origStat.isFile()) return null;
  if (origStat.size !== size) return false; // 大小不同免读直判,多数「有差异」不走 IO
  if (size > IDENTICAL_MAX_BYTES) return null;
  try {
    return Buffer.compare(readFileSync(copyAbs), readFileSync(originalAbs)) === 0;
  } catch {
    return null;
  }
}

/** 实时扫描共享根内的冲突副本残留(权威口径:副本被用户手动删了就不会误报)。 */
export function listConflictCopies(root: string): { conflicts: ConflictCopy[]; truncated: boolean } {
  const conflicts: ConflictCopy[] = [];
  let scanned = 0;
  let truncated = false;

  function walk(relDir: string): void {
    if (truncated) return;
    let names: Dirent[];
    try {
      names = readdirSync(join(root, relDir), { withFileTypes: true });
    } catch {
      return; // 目录不可读(权限/竞态删除):跳过,不算失败
    }
    for (const ent of names) {
      if (truncated) return;
      const rel = relDir === '' ? ent.name : `${relDir}/${ent.name}`;
      if (ent.isDirectory()) {
        // 硬忽略目录(.git/.hg/.svn/回收站残留等)整棵跳过
        if (HARD_IGNORE_NAMES.includes(ent.name)) continue;
        walk(rel);
        continue;
      }
      if (!ent.isFile()) continue;
      scanned += 1;
      if (scanned > MAX_SCAN_ENTRIES || conflicts.length >= MAX_RESULTS) {
        truncated = true;
        return;
      }
      const parsed = parseConflictCopy(ent.name);
      if (!parsed) continue;
      // 注意:反解用 basename(副本与原文件同目录),originalPath 要拼回目录前缀
      const abs = join(root, rel);
      let size = 0;
      let mtime = 0;
      try {
        const st = statSync(abs);
        size = st.size;
        mtime = st.mtimeMs;
      } catch {
        continue; // stat 竞态(刚被删):跳过
      }
      conflicts.push({
        copyPath: rel,
        originalPath: relDir === '' ? parsed.originalPath : `${relDir}/${parsed.originalPath}`,
        deviceId: parsed.deviceId,
        size,
        mtime,
        identical: compareWithOriginal(abs, join(root, relDir === '' ? parsed.originalPath : `${relDir}/${parsed.originalPath}`), size),
      });
    }
  }

  walk('');
  conflicts.sort((a, b) => b.mtime - a.mtime);
  return { conflicts, truncated };
}

/** 与 executor 的回收站落盘同式:保留相对结构 + base36 时间戳后缀,碰撞加序号。 */
function moveToTrashFile(root: string, trashDir: string, relPath: string): void {
  // 移入回收站的正是冲突副本(硬忽略对象)→ 绕过硬忽略闸门,越界守卫仍在
  const src = resolveSharePath(root, relPath, { allowHardIgnored: true });
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
    renameSync(src, dest);
  } catch {
    // 跨文件系统 / 文件被占用(Windows):拷贝后删原,绝不静默丢弃
    copyFileSync(src, dest);
    renameSync(src, dest + '.orig');
  }
}

/** 覆盖前把原文件当前内容留档进版本目录(命名与 executor.snapshotVersion 对齐,版本弹窗可认领)。 */
function backupToVersions(versionsDir: string | undefined, originalRel: string, origAbs: string): void {
  if (versionsDir === undefined) return;
  if (!existsSync(origAbs) || !statSync(origAbs).isFile()) return;
  mkdirSync(versionsDir, { recursive: true });
  const stamp = Date.now().toString(36);
  let backup = join(versionsDir, `${originalRel}.syncx-v-${stamp}`);
  let n = 0;
  while (existsSync(backup)) {
    n += 1;
    backup = join(versionsDir, `${originalRel}.syncx-v-${stamp}.${n}`);
  }
  mkdirSync(dirname(backup), { recursive: true });
  copyFileSync(origAbs, backup);
}

/** 副本路径拆成 { 目录前缀, 文件名 }(无 '/' 时目录前缀为空串)。 */
function splitRel(relPath: string): { dir: string; name: string } {
  const cut = relPath.lastIndexOf('/') + 1;
  return { dir: relPath.slice(0, cut), name: relPath.slice(cut) };
}

/**
 * 处理一条冲突副本。
 * - keep-local:副本内容覆盖回原路径(当前内容先快照进版本目录,动作可逆);
 * - discard:副本移入回收站(软删,与「删除文件」同一保护语义);
 * 两种收尾都把副本本身移进回收站 —— 绝不 rm,也让下次扫描不再报同一条。
 */
export function resolveConflictCopy(
  root: string,
  trashDir: string,
  versionsDir: string | undefined,
  copyPath: string,
  choice: ConflictChoice,
): void {
  const { dir, name } = splitRel(copyPath);
  const parsed = parseConflictCopy(name);
  if (!parsed) throw new Error('不是冲突副本命名');
  const copyAbs = resolveSharePath(root, copyPath, { allowHardIgnored: true });
  if (!existsSync(copyAbs) || !statSync(copyAbs).isFile()) throw new Error('冲突副本已不存在');

  const originalRel = dir + parsed.originalPath;
  const origAbs = resolveSharePath(root, originalRel);
  if (choice === 'keep-local') {
    backupToVersions(versionsDir, originalRel, origAbs);
    mkdirSync(dirname(origAbs), { recursive: true });
    copyFileSync(copyAbs, origAbs);
  } else if (choice !== 'discard') {
    throw new Error('未知处理方式');
  }
  moveToTrashFile(root, trashDir, copyPath);
}

/**
 * 把逐块合并后的内容写回原文件(冲突收件箱「查看对比」里点 ← 应用差异块)。
 * 与 keep-local 同一安全网:当前内容先留档;副本**不动** —— 合并可能只做一半,
 * 副本要留到用户显式「丢弃/完成」才进回收站。写回后由调用方触发扫描广播。
 */
export function applyConflictMerge(
  root: string,
  versionsDir: string | undefined,
  copyPath: string,
  content: string,
): void {
  const { dir, name } = splitRel(copyPath);
  const parsed = parseConflictCopy(name);
  if (!parsed) throw new Error('不是冲突副本命名');
  // 校验副本还在(路径合法性由 resolveSharePath 兜底):避免对不存在的冲突写"合并"
  const copyAbs = resolveSharePath(root, copyPath, { allowHardIgnored: true });
  if (!existsSync(copyAbs) || !statSync(copyAbs).isFile()) throw new Error('冲突副本已不存在');
  const originalRel = dir + parsed.originalPath;
  const origAbs = resolveSharePath(root, originalRel);
  backupToVersions(versionsDir, originalRel, origAbs);
  mkdirSync(dirname(origAbs), { recursive: true });
  writeFileSync(origAbs, content, 'utf8');
}
