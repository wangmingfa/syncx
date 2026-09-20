/**
 * 把两侧的索引条目合成**逐行对齐**的目录结构。
 *
 * 「对齐」是这个视图的全部意义:同一个相对路径只占一行,哪一侧没有就留空行占位 ——
 * 这样左右两列天然逐行对应,扫一眼就能看出「这边多了什么、那边少了什么」,
 * 而不是两份各自排序的清单让人用眼睛去配对。
 *
 * 目录也要成行:文件夹同样参与对齐,且「目录内有差异」会被标记出来 ——
 * 折叠状态下看不到里面的文件,目录名本身必须能提示「这里面有东西不一样」。
 */
import type { CompareEntry, FolderDiffKind } from '../types.js';

export type RowStatus = 'same' | 'diff' | 'only-local' | 'only-remote';

export interface TreeRow {
  /** 相对路径(协议统一用 '/')。 */
  path: string;
  name: string;
  /** 缩进层级,顶层为 0。 */
  depth: number;
  isDir: boolean;
  left?: CompareEntry;
  right?: CompareEntry;
  status: RowStatus;
  /** 文件的差异分类(来自后端 diff);目录无分类。 */
  kind?: FolderDiffKind;
  /** 目录内(含子目录)存在任何差异:用于给目录名着色。 */
  subtreeChanged?: boolean;
}

interface Node {
  name: string;
  path: string;
  isDir: boolean;
  dirs: Map<string, Node>;
  files: Map<string, Node>;
  left?: CompareEntry;
  right?: CompareEntry;
}

function newNode(name: string, path: string, isDir: boolean): Node {
  return { name, path, isDir, dirs: new Map(), files: new Map() };
}

/** 该行是否值得展示:两侧都是墓碑(都已删除)时,文件在两边都不存在,不必占位。 */
function live(n: Node): boolean {
  return (!!n.left && !n.left.deleted) || (!!n.right && !n.right.deleted);
}

function statusOf(n: Node, kindByPath: Map<string, FolderDiffKind>): RowStatus {
  const { left: l, right: r } = n;
  if (l && !r) return 'only-local';
  if (!l && r) return 'only-remote';
  if (!l || !r) return 'same';
  // 一侧是墓碑:删除还没在另一侧生效,是实打实的差异
  if (l.deleted !== r.deleted) return 'diff';
  const kind = kindByPath.get(n.path);
  if (kind && kind !== 'in-sync') return 'diff';
  // 后端分类里没有(多为被折叠的 in-sync):再按大小 + 内容摘要兜底判一次
  return l.size === r.size && l.digest === r.digest ? 'same' : 'diff';
}

/**
 * 合成对齐行。
 *
 * @param kindByPath 后端 diff 的分类(path → kind);未收录的路径按 in-sync 处理。
 */
export function buildTreeRows(
  local: CompareEntry[],
  remote: CompareEntry[],
  kindByPath: Map<string, FolderDiffKind>,
): TreeRow[] {
  const root = newNode('', '', true);

  const insert = (entry: CompareEntry, side: 'left' | 'right'): void => {
    // 协议路径一律 '/';空路径(理论上不该出现)直接丢弃
    const parts = entry.path.split('/').filter(Boolean);
    if (parts.length === 0) return;
    let cur = root;
    let acc = '';
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      acc = acc === '' ? part : `${acc}/${part}`;
      const isDir = i < parts.length - 1;
      const bucket = isDir ? cur.dirs : cur.files;
      let next = bucket.get(part);
      if (!next) {
        next = newNode(part, acc, isDir);
        bucket.set(part, next);
      }
      cur = next;
    }
    cur[side] = entry;
  };

  for (const e of local) insert(e, 'left');
  for (const e of remote) insert(e, 'right');

  /**
   * 深度优先展开,返回该层的行(含子层)与该层是否有差异。
   *
   * 目录排在文件之前(与常见文件管理器一致),且**目录行必须排在它的子项之前** ——
   * 因此子层要先算完(才知道要不要标「里面有差异」),再拼在目录行后面。
   */
  const walk = (node: Node, depth: number): { rows: TreeRow[]; changed: boolean } => {
    const out: TreeRow[] = [];
    let changed = false;
    const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
    const files = [...node.files.values()].sort((a, b) => a.name.localeCompare(b.name));

    for (const dir of dirs) {
      const child = walk(dir, depth + 1);
      // 只要目录里有任何条目(哪怕全是 in-sync)就成行,让目录结构本身可见;
      // 真正空的目录(两侧都没任何条目)才不占位。这样「文件夹」不再只在有差异时才冒出来,
      // 用户要的「完整的目录结构、树形展示」才有意义。
      if (child.rows.length === 0) continue;
      out.push({
        path: dir.path,
        name: dir.name,
        depth,
        isDir: true,
        ...(dir.left ? { left: dir.left } : {}),
        ...(dir.right ? { right: dir.right } : {}),
        status: child.changed ? 'diff' : 'same',
        subtreeChanged: child.changed,
      });
      out.push(...child.rows);
      if (child.changed) changed = true;
    }

    for (const file of files) {
      if (!live(file)) continue;
      const status = statusOf(file, kindByPath);
      out.push({
        path: file.path,
        name: file.name,
        depth,
        isDir: false,
        ...(file.left ? { left: file.left } : {}),
        ...(file.right ? { right: file.right } : {}),
        status,
        ...(kindByPath.has(file.path) ? { kind: kindByPath.get(file.path) } : {}),
      });
      if (status !== 'same') changed = true;
    }

    return { rows: out, changed };
  };

  return walk(root, 0).rows;
}

/** 各状态的行数统计(供页头概览)。 */
export function countRows(rows: TreeRow[]): Record<RowStatus, number> {
  const counts: Record<RowStatus, number> = { same: 0, diff: 0, 'only-local': 0, 'only-remote': 0 };
  for (const r of rows) counts[r.status] += 1;
  return counts;
}
