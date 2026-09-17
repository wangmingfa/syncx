/**
 * 两个设备「同一目录 id」的内容对比(诊断用)。
 *
 * 目的:排查「同步是否出问题」时,用户需要的是**结论**而不是两份索引 ——
 * 「这 3 个文件本机较新、待推送」「这 1 个两边版本相同但内容摘要不同(异常)」
 * 「这 7 条只有对端声明,因为本机 .gitignore 第 43 行挡住了(不是 bug)」。
 *
 * 因此这里不新造比较逻辑:`compareFileState`(见 index.ts)已经是同步规划器
 * 每天在用的「两边差在哪」判定,本模块只做三件事 ——
 *   1. 在它之上补两类规划器不关心的分类:版本相同但内容不一致(强异常信号)、
 *      以及「差异是忽略规则使然」(不是故障);
 *   2. 把结论翻译成可读的差异项(带上命中的规则原文、是否硬忽略、盘上复核);
 *   3. 全程只读:不落盘、不发索引、不改版本向量,诊断工具绝不能扰动被观察的系统。
 *
 * 对端的索引由 session-manager 经控制通道按需索取(见 wire.ts 的
 * folder-index-request / folder-index-snapshot),不依赖会话建立时那份全量索引 ——
 * 那份只在 attach 时刻准确,对端之后改忽略规则或只发增量都会让它悄悄过期,
 * 而「给出过期结论」比「不给结论」更糟。
 */

import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import { isHardIgnored, matchIgnoreRule, type IgnoreRule } from './ignore.js';
import { compareFileState, type IndexEntry } from './index.js';
import type { VersionVector } from './version.js';

/**
 * 对端快照里的一条索引。与 IndexEntry 的唯一区别是 `blocks` 被折叠成一个摘要:
 * 线上原样的 blocks 是每块一个 64 位十六进制串,1MB 一个文件、几十 GB 的目录
 * 条目体积会随文件大小线性膨胀,几千个文件就能撑爆一帧。摘要数组由**双方用
 * 同一个函数**算(见 contentDigest),因此可直接比对。
 */
export interface SnapshotEntry {
  path: string;
  /** wire 形态的版本向量(数组而非 Map:JSON 无 Map)。 */
  version: Array<[string, number]>;
  size: number;
  deleted: boolean;
  /** contentDigest(blocks);墓碑为空串。 */
  digest: string;
  /** 对端文件 mtime(毫秒)。仅用于展示,不参与任何判定。 */
  mtime?: number;
}

export type DiffKind =
  /** 版本向量相等,但大小或内容摘要不同 —— 正常绝不该出现,最强异常信号。 */
  | 'content-mismatch'
  /** 版本向量交叉:两边都改过(取决于版本号,见 version.ts)。 */
  | 'conflict'
  /** 本机较新(含「本机已删除、待对端删除」):本机该推给对端。 */
  | 'local-newer'
  /** 对端较新(含「对端已删除、待本机删除」):本机该拉回来。 */
  | 'remote-newer'
  /** 只有对端声明,且命中**本机**忽略规则:本机按规则不收它,不是同步故障。 */
  | 'ignored-locally'
  /** 只有本机声明,且命中**对端**规则:对端按它自己的规则不参与,不是同步故障。 */
  | 'ignored-remotely'
  /** 双方一致(折叠展示,不进 items)。 */
  | 'in-sync';

/** 差异项的排序权重:越靠前越可能是真问题。 */
export const DIFF_KIND_ORDER: DiffKind[] = [
  'content-mismatch',
  'conflict',
  'local-newer',
  'remote-newer',
  'ignored-locally',
  'ignored-remotely',
  'in-sync',
];

/** 展示用的单侧状态(version 保持 wire 形态,便于直接塞进 JSON 响应)。 */
export interface DiffSide {
  version: Array<[string, number]>;
  size: number;
  deleted: boolean;
  digest: string;
  mtime?: number;
}

/**
 * 本机盘上复核结果。索引与磁盘可能不一致(daemon 离线期间的改动尚未扫到、
 * 或文件被外部删除),而「索引说有、盘上没了」和「两边内容不同」是完全不同的
 * 结论,必须分开报。
 */
export type DiskState = 'ok' | 'missing' | 'size-differs';

export interface DiffItem {
  path: string;
  kind: DiffKind;
  local?: DiffSide;
  remote?: DiffSide;
  /** 命中的忽略规则原文(ignored-locally 用本机规则,ignored-remotely 用对端规则)。 */
  rule?: string;
  /** 该路径命中硬忽略名单(任何配置都解不开,见 ignore.ts 的 HARD_IGNORE_NAMES)。 */
  hard?: boolean;
  /** 本机盘上复核(仅对本机索引声明存在的活条目做;其余保持 undefined)。 */
  disk?: DiskState;
}

export interface FolderDiff {
  /** 逐条差异(**不含** in-sync)。已按 DIFF_KIND_ORDER + 路径排序。 */
  items: DiffItem[];
  /** 各分类计数(含 in-sync)。 */
  counts: Record<DiffKind, number>;
  /** 本机索引条目数(含墓碑)。 */
  localTotal: number;
  /** 对端快照条目数(含墓碑)。 */
  remoteTotal: number;
  /**
   * 对端是否带回了它该目录的忽略规则行。旧版本对端不回 → 为 false,
   * 此时 ignored-remotely 无法判定,「只有本机声明」的条目会一律报成 local-newer。
   */
  remoteRulesKnown: boolean;
}

export interface FolderDiffInput {
  /** 本机内存索引(已按本机忽略规则过滤,用户级忽略的墓碑仍保留)。 */
  local: Map<string, IndexEntry>;
  /** 对端快照。 */
  remote: SnapshotEntry[];
  /** 本机该目录生效的忽略规则(含内置默认行,见 readFolderIgnoreLines)。 */
  localRules: IgnoreRule[];
  /** 对端随快照带回的规则行解析结果;旧对端不返回时为 undefined。 */
  remoteRules?: IgnoreRule[];
}

/**
 * 内容摘要:把逐块哈希折叠成一个定长 sha256。
 * 空 blocks(墓碑、空文件)返回空串 —— 两者无需区分,摘要只用于「内容是否同一份」。
 */
export function contentDigest(blocks: string[]): string {
  if (blocks.length === 0) return '';
  return createHash('sha256').update(blocks.join('\n')).digest('hex');
}

/** 本地索引条目 → 快照条目(供服务端回快照;双方用同一函数保证摘要可比)。 */
export function toSnapshotEntry(entry: IndexEntry): SnapshotEntry {
  return {
    path: entry.path,
    version: [...entry.version.entries()],
    size: entry.size,
    deleted: entry.deleted,
    digest: contentDigest(entry.blocks),
    mtime: entry.mtime,
  };
}

/** 快照条目 → 仅够 compareFileState 使用的索引条目(blocks 不参与版本比较)。 */
function asIndexEntry(entry: SnapshotEntry): IndexEntry {
  return {
    path: entry.path,
    version: new Map(entry.version) as VersionVector,
    size: entry.size,
    deleted: entry.deleted,
    blocks: [],
  };
}

function localSide(entry: IndexEntry): DiffSide {
  return {
    version: [...entry.version.entries()],
    size: entry.size,
    deleted: entry.deleted,
    digest: contentDigest(entry.blocks),
    mtime: entry.mtime,
  };
}

function remoteSide(entry: SnapshotEntry): DiffSide {
  return {
    version: entry.version,
    size: entry.size,
    deleted: entry.deleted,
    digest: entry.digest,
    mtime: entry.mtime,
  };
}

/** 分类两份索引的差异。纯函数:不碰文件系统、不发消息。 */
export function buildFolderDiff(input: FolderDiffInput): FolderDiff {
  const { local, remote, localRules, remoteRules } = input;

  const remoteMap = new Map<string, SnapshotEntry>();
  for (const entry of remote) remoteMap.set(entry.path, entry);

  const items: DiffItem[] = [];
  const counts: Record<DiffKind, number> = {
    'content-mismatch': 0,
    conflict: 0,
    'local-newer': 0,
    'remote-newer': 0,
    'ignored-locally': 0,
    'ignored-remotely': 0,
    'in-sync': 0,
  };
  const push = (item: DiffItem): void => {
    counts[item.kind] += 1;
    items.push(item);
  };

  const paths = new Set<string>([...local.keys(), ...remoteMap.keys()]);
  for (const path of paths) {
    const l = local.get(path);
    const r = remoteMap.get(path);

    // --- 单边墓碑:一方删过、另一方从未见过它 ---
    // 墓碑是「删除」的载体,不是内容差异:对端压根没有这个文件,墓碑推过去也无事可做。
    // 若把这类报成差异,每个删过的文件都会长期挂在报告里,真正的差异反而被淹没。
    if (l === undefined && r !== undefined && r.deleted) {
      counts['in-sync'] += 1;
      continue;
    }
    if (l !== undefined && r === undefined && l.deleted) {
      counts['in-sync'] += 1;
      continue;
    }

    // --- 只有对端声明:先问「本机为什么没有」是不是规则使然 ---
    // 本机索引已被忽略规则过滤过,所以本机忽略的活条目在这里正是「对端有、本机没有」。
    // 不消歧的话,这些条目会被报成 remote-newer(「该拉回来」),而真相是
    // 「本机按规则不收它」—— 用户会照着报告去修一个不存在的问题(见 ADR-0012)。
    if (l === undefined && r !== undefined) {
      const rule = matchIgnoreRule(localRules, path);
      if (rule) {
        push({
          path,
          kind: 'ignored-locally',
          remote: remoteSide(r),
          rule: rule.pattern,
          ...(isHardIgnored(path) ? { hard: true } : {}),
        });
        continue;
      }
      push({ path, kind: 'remote-newer', remote: remoteSide(r) });
      continue;
    }

    // --- 只有本机声明 ---
    if (l !== undefined && r === undefined) {
      const rule = remoteRules ? matchIgnoreRule(remoteRules, path) : undefined;
      if (rule) {
        push({
          path,
          kind: 'ignored-remotely',
          local: localSide(l),
          rule: rule.pattern,
          ...(isHardIgnored(path) ? { hard: true } : {}),
        });
        continue;
      }
      push({ path, kind: 'local-newer', local: localSide(l) });
      continue;
    }

    // --- 双方都声明 ---
    if (l !== undefined && r !== undefined) {
      const relation = compareFileState(l, asIndexEntry(r));
      if (relation === 'equal') {
        // 版本相同:唯一还算「一致」的前提是内容也真的同一份。
        // 规划器看不到这一层(它只比版本向量),而「版本相同、内容不同」是数据被
        // 破坏或索引被错写的强信号,正是这个功能最该抓出来的一类。
        const sameBody =
          l.deleted === r.deleted &&
          (l.deleted || (l.size === r.size && contentDigest(l.blocks) === r.digest));
        if (sameBody) {
          counts['in-sync'] += 1;
          continue;
        }
        push({ path, kind: 'content-mismatch', local: localSide(l), remote: remoteSide(r) });
        continue;
      }
      push({ path, kind: relation, local: localSide(l), remote: remoteSide(r) });
    }
  }

  items.sort((a, b) => {
    const byKind = DIFF_KIND_ORDER.indexOf(a.kind) - DIFF_KIND_ORDER.indexOf(b.kind);
    return byKind !== 0 ? byKind : a.path.localeCompare(b.path);
  });

  return {
    items,
    counts,
    localTotal: local.size,
    remoteTotal: remote.length,
    remoteRulesKnown: remoteRules !== undefined,
  };
}

/**
 * 对本机侧的差异项做一次盘上复核:索引声明存在、但盘上没了(或大小不符)。
 * 与索引不一致说明索引陈旧(daemon 离线期间的改动未扫到),而不是两端不同步 ——
 * 这两种结论的处置方式完全不同,所以要在报告里分开。
 *
 * 只读 stat,越界路径(理论上不该出现)直接跳过而非按「盘上没有」处理,免得把
 * 一份被篡改的快照显示成「你的文件不见了」。
 */
export function checkDiffAgainstDisk(root: string, items: DiffItem[]): void {
  const base = resolve(root);
  for (const item of items) {
    const want = item.local;
    if (!want || want.deleted) continue;
    const abs = resolve(base, item.path);
    if (abs !== base && !abs.startsWith(base + sep)) continue;
    try {
      item.disk = statSync(abs).size === want.size ? 'ok' : 'size-differs';
    } catch {
      item.disk = 'missing';
    }
  }
}

/** 差异总数(不含 in-sync)。 */
export function diffTotal(counts: Record<DiffKind, number>): number {
  return DIFF_KIND_ORDER.reduce((sum, kind) => (kind === 'in-sync' ? sum : sum + counts[kind]), 0);
}
