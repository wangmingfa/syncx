import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { HARD_IGNORE_NAMES } from './ignore.js';
import type { SyncAction } from './history.js';

/**
 * 文件时间机器 —— 整目录回滚的规划器 + 执行器。
 *
 * 依据三类持久化证据重建「目标时刻 T 的目录视图」:
 *  - 版本留档 `<relPath>.syncx-v-<base36 ts>[.<n>]`:每次被对端覆盖**前**的旧内容快照。
 *    快照的**命名时间**是覆盖发生的时刻,快照**内容**是覆盖前的文件状态 —— 因此
 *    「T 时刻的内容」= 该路径**最早的、stamp > T** 的快照(它捕获的正是 T 那代内容);
 *  - 回收站 `<relPath>.<base36 ts>[.<n>]`:删除时的内容副本;
 *  - 同步记录(history JSONL,有保留上限):add/delete 事件补足「T 之后新增/删除」的口径。
 *
 * 全部是启发式(快照只在远端覆盖时生成、历史有裁剪),所以计划先于执行、
 * 执行时当前内容一律先进版本/回收站 —— 回滚本身可逆。
 */

export interface VersionRef {
  /** 相对 versionsDir 的文件路径(保留原目录层级)。 */
  file: string;
  relPath: string;
  /** 快照落盘时刻(毫秒)。 */
  ts: number;
}

export interface TrashRef {
  file: string;
  relPath: string;
  ts: number;
}

export interface HistoryRef {
  ts: number;
  path: string;
  action: SyncAction;
}

export interface RollbackPlan {
  targetTs: number;
  /** 用版本快照覆盖/补回当前文件。 */
  restores: Array<{ relPath: string; versionFile: string; versionTs: number }>;
  /** 当前文件是「T 之后新增」,移入回收站(不是硬删,可再反悔)。 */
  trashCurrent: Array<{ relPath: string }>;
  /** T 之后被删、回收站里还有内容 → 移回目录。 */
  fromTrash: Array<{ relPath: string; trashFile: string }>;
  /** 证据显示 T 后内容有变,但没有任何可用快照(被轮转裁掉/纯本地编辑)。 */
  noSnapshot: string[];
  /** T 之后被删且回收站也没有副本(无处可取)。 */
  lostDeletes: string[];
  counts: { restores: number; trashCurrent: number; fromTrash: number; noSnapshot: number; lostDeletes: number };
}

/** 版本文件名解析:`<relPath>.syncx-v-<base36>[.<n>]` → { relPath, ts }。 */
export function parseVersionName(file: string): { relPath: string; ts: number } | null {
  const m = /^(.*)\.syncx-v-([0-9a-z]+)(\.[0-9]+)?$/.exec(file);
  if (!m) return null;
  const ts = Number.parseInt(m[2]!, 36);
  if (!Number.isFinite(ts)) return null;
  return { relPath: m[1]!, ts };
}

/** 回收站文件名解析:`<relPath>.<base36>[.<n>]`(时间戳 8–13 位,排除日期后缀误判)。 */
export function parseTrashName(file: string): { relPath: string; ts: number } | null {
  const m = /^(.*)\.([0-9a-z]{8,13})(\.[0-9]+)?$/.exec(file);
  if (!m) return null;
  if (m[1]!.endsWith('.syncx-v-'.slice(0, -1))) return null; // 版本文件不误认
  const ts = Number.parseInt(m[2]!, 36);
  if (!Number.isFinite(ts) || ts < 1e11) return null; // base36 毫秒级时间戳下限(≈2001 年)
  return { relPath: m[1]!, ts };
}

export interface RollbackInputs {
  versions: VersionRef[];
  trash: TrashRef[];
  history: HistoryRef[];
  /** 当前目录实况:relPath → mtime(毫秒)。 */
  current: Map<string, number>;
}

/** 纯规划:输入证据集 + 目标时刻,产出回滚计划(不落盘、可随时 dryRun)。 */
export function planRollback(input: RollbackInputs, targetTs: number): RollbackPlan {
  const byPath = new Map<
    string,
    { versions: VersionRef[]; trash: TrashRef[]; events: HistoryRef[]; currentMtime?: number }
  >();
  const ensure = (p: string) => {
    let e = byPath.get(p);
    if (!e) {
      e = { versions: [], trash: [], events: [] };
      byPath.set(p, e);
    }
    return e;
  };
  for (const v of input.versions) ensure(v.relPath).versions.push(v);
  for (const t of input.trash) ensure(t.relPath).trash.push(t);
  for (const h of input.history) ensure(h.path).events.push(h);
  for (const [p, mtime] of input.current) ensure(p).currentMtime = mtime;

  const plan: RollbackPlan = {
    targetTs,
    restores: [],
    trashCurrent: [],
    fromTrash: [],
    noSnapshot: [],
    lostDeletes: [],
    counts: { restores: 0, trashCurrent: 0, fromTrash: 0, noSnapshot: 0, lostDeletes: 0 },
  };

  for (const [relPath, e] of byPath) {
    e.versions.sort((a, b) => a.ts - b.ts);
    e.trash.sort((a, b) => a.ts - b.ts);
    e.events.sort((a, b) => a.ts - b.ts);

    const cur = e.currentMtime;
    const hasCurrent = cur !== undefined;
    // T 时刻内容的最佳快照:最早的 stamp > T(捕获的是 T 那代内容);退而求其次:最晚的 ≤ T
    const afterT = e.versions.find((v) => v.ts > targetTs);
    const beforeT = [...e.versions].reverse().find((v) => v.ts <= targetTs);
    const bestAtT = afterT ?? beforeT;

    // 「T 之后新增」判定:记录里该路径第一条事件就是 add 且晚于 T
    const firstEvent = e.events[0];
    const addedAfterT = !!firstEvent && firstEvent.action === 'add' && firstEvent.ts > targetTs && e.versions.length === 0;

    if (hasCurrent) {
      if (addedAfterT) {
        plan.trashCurrent.push({ relPath });
        plan.counts.trashCurrent += 1;
        continue;
      }
      const changedSinceT = cur! > targetTs;
      // 需要恢复的两种证据:mtime 越过了目标时刻,或存在「T 后覆盖时抓的快照」
      // (afterT 快照的存在本身就说明 T 与现在之间发生过覆盖,当前内容不是 T 时刻的)
      if (bestAtT && (changedSinceT || afterT)) {
        plan.restores.push({ relPath, versionFile: bestAtT.file, versionTs: bestAtT.ts });
        plan.counts.restores += 1;
        continue;
      }
      if (changedSinceT && !bestAtT && e.events.length > 0) {
        plan.noSnapshot.push(relPath);
        plan.counts.noSnapshot += 1;
      }
      continue;
    }

    // 当前不存在:可能是「T 后有删除」或「T 后新增又删掉」
    if (bestAtT) {
      // 有快照证据说明文件在 T 时已存在:直接补回(典型:更新后又被对端删掉)
      plan.restores.push({ relPath, versionFile: bestAtT.file, versionTs: bestAtT.ts });
      plan.counts.restores += 1;
      continue;
    }
    const deletedAfterT = e.events.some((ev) => ev.action === 'delete' && ev.ts > targetTs);
    if (deletedAfterT) {
      const tr = e.trash.find((x) => x.ts > targetTs) ?? e.trash[e.trash.length - 1];
      if (tr) {
        plan.fromTrash.push({ relPath, trashFile: tr.file });
        plan.counts.fromTrash += 1;
      } else {
        plan.lostDeletes.push(relPath);
        plan.counts.lostDeletes += 1;
      }
    }
    // 无当前 + 无版本 + 无删除记录:要么从未存在,要么证据不足 —— 保持不动
  }

  plan.restores.sort((a, b) => a.relPath.localeCompare(b.relPath));
  plan.trashCurrent.sort((a, b) => a.relPath.localeCompare(b.relPath));
  plan.fromTrash.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return plan;
}

/**
 * 执行计划:一切破坏性动作先把现状归档(覆盖前进版本、删除前进回收站),
 * 返回各项计数。IO 失败逐条吞掉并计入 failed,不留半截状态。
 */
export interface RollbackApplyResult {
  restored: number;
  trashed: number;
  fromTrash: number;
  failed: number;
}

export function applyRollback(
  plan: RollbackPlan,
  paths: { root: string; versionsDir: string; trashDir: string },
  now = Date.now(),
): RollbackApplyResult {
  const out: RollbackApplyResult = { restored: 0, trashed: 0, fromTrash: 0, failed: 0 };
  const uniqueStamp = (base: string): string => {
    let p = base;
    let n = 0;
    while (existsSync(p)) {
      n += 1;
      p = `${base}.${n}`;
    }
    return p;
  };

  for (const r of plan.restores) {
    try {
      const src = join(paths.versionsDir, r.versionFile);
      if (!existsSync(src)) throw new Error('version missing');
      const dest = join(paths.root, r.relPath);
      if (relative(paths.root, dest).startsWith('..')) throw new Error('unsafe path');
      if (existsSync(dest)) {
        // 当前内容进版本,回滚可逆
        mkdirSync(paths.versionsDir, { recursive: true });
        const bak = uniqueStamp(join(paths.versionsDir, `${r.relPath}.syncx-v-${now.toString(36)}`));
        mkdirSync(dirname(bak), { recursive: true });
        copyFileSync(dest, bak);
      }
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
      out.restored += 1;
    } catch {
      out.failed += 1;
    }
  }

  for (const d of plan.trashCurrent) {
    try {
      const cur = join(paths.root, d.relPath);
      if (!existsSync(cur)) continue;
      mkdirSync(paths.trashDir, { recursive: true });
      const dest = uniqueStamp(join(paths.trashDir, `${d.relPath}.${now.toString(36)}`));
      mkdirSync(dirname(dest), { recursive: true });
      renameSync(cur, dest); // 同盘移动;跨盘时 renameSync 抛错走 failed
      out.trashed += 1;
    } catch {
      out.failed += 1;
    }
  }

  for (const f of plan.fromTrash) {
    try {
      const src = join(paths.trashDir, f.trashFile);
      if (!existsSync(src)) throw new Error('trash copy missing');
      const dest = join(paths.root, f.relPath);
      if (relative(paths.root, dest).startsWith('..')) throw new Error('unsafe path');
      if (existsSync(dest)) rmSync(dest); // 计划期后新出现的同名文件:让位给恢复
      mkdirSync(dirname(dest), { recursive: true });
      renameSync(src, dest);
      out.fromTrash += 1;
    } catch {
      out.failed += 1;
    }
  }

  return out;
}

/** 递归列出目录内全部文件(relPath → mtimeMs),跳过硬忽略名与隐藏元数据目录。 */
export function walkCurrentFiles(root: string, prefix = ''): Map<string, number> {
  const out = new Map<string, number>();
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (HARD_IGNORE_NAMES.includes(e.name) || e.name.startsWith('.syncx-')) continue;
      for (const [p, m] of walkCurrentFiles(join(root, e.name), rel)) out.set(p, m);
      continue;
    }
    if (!e.isFile()) continue;
    if (HARD_IGNORE_NAMES.includes(e.name)) continue;
    try {
      out.set(rel, statSync(join(root, e.name)).mtimeMs);
    } catch {
      /* 竞态消失的文件跳过 */
    }
  }
  return out;
}

/** 递归解析版本目录为 VersionRef[](目录不存在 → 空)。 */
export function listVersionRefs(versionsDir: string, prefix = ''): VersionRef[] {
  const out: VersionRef[] = [];
  let entries;
  try {
    entries = readdirSync(versionsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      out.push(...listVersionRefs(join(versionsDir, e.name), rel));
      continue;
    }
    const parsed = parseVersionName(rel);
    if (parsed) out.push({ file: rel, relPath: parsed.relPath, ts: parsed.ts });
  }
  return out;
}

/** 递归解析回收站目录为 TrashRef[](目录不存在 → 空)。 */
export function listTrashRefs(trashDir: string, prefix = ''): TrashRef[] {
  const out: TrashRef[] = [];
  let entries;
  try {
    entries = readdirSync(trashDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      out.push(...listTrashRefs(join(trashDir, e.name), rel));
      continue;
    }
    const parsed = parseTrashName(rel);
    if (parsed) out.push({ file: rel, relPath: parsed.relPath, ts: parsed.ts });
  }
  return out;
}
