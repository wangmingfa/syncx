import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { IndexEntry } from './index.js';
import type { IndexStore } from './indexstore.js';
import type { IgnoreRule } from './ignore.js';
import { isIgnored } from './ignore.js';
import { hashBlock, splitIntoBlocks } from './blockstore.js';
import { incrementVersion } from './version.js';

/** FAT32 mtime 精度为 2 秒,免哈希快速路径用容忍窗口避免误判。 */
const MTIME_TOLERANCE_MS = 2000;

/** 免哈希快速路径:大小与修改时间都在容忍窗口内则视为未改动,跳过整文件重算。 */
function isUnchanged(entry: IndexEntry, stat: { size: number; mtimeMs: number }): boolean {
  if (stat.size !== entry.size) return false;
  if (entry.mtime === undefined) return false;
  return Math.abs(stat.mtimeMs - entry.mtime) <= MTIME_TOLERANCE_MS;
}

/** executor 原子写用的临时文件后缀,扫描时跳过。 */
const TMP_SUFFIX = '.syncx-tmp';

export interface ScanDiff {
  /** 新增或内容变化的相对路径(需重新索引并发送)。 */
  changed: string[];
  /** 本地已删除文件的墓碑条目(需传播)。 */
  tombstones: IndexEntry[];
}

function contentChanged(entry: IndexEntry, absPath: string): boolean {
  let data: Buffer;
  try {
    data = readFileSync(absPath);
  } catch {
    return true; // 读不到按变化处理,由调用方 try/catch 兜底
  }
  const blocks = splitIntoBlocks(data).map(hashBlock);
  return (
    blocks.length !== entry.blocks.length ||
    blocks.some((h, i) => h !== entry.blocks[i])
  );
}

/**
 * 扫描共享目录树,与索引对比,产出需要重新索引/发送的路径与墓碑。
 * 被忽略规则命中的文件不参与(其删除也不传播)。
 */
export function scanFolder(
  root: string,
  index: IndexStore,
  rules: IgnoreRule[],
  deviceId: string,
): ScanDiff {
  // 共享目录根不存在(盘符卸载 / 权限丢失 / 未挂载):不做墓碑推断,避免
  // 把整个目录误判为已删除而批量传播墓碑给对端
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return { changed: [], tombstones: [] };
  }

  const changed: string[] = [];
  const seen = new Set<string>();

  function walk(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 目录已被删除
    }
    for (const dirent of entries) {
      const abs = join(dir, dirent.name);
      const rel = relative(root, abs);
      if (dirent.isDirectory()) {
        if (!isIgnored(rules, rel, true)) walk(abs);
        continue;
      }
      if (!dirent.isFile() || rel.endsWith(TMP_SUFFIX)) continue;
      if (isIgnored(rules, rel, false)) continue;

      seen.add(rel);
      const prev = index.getEntry(rel);
      if (prev && !prev.deleted) {
        let stat: { size: number; mtimeMs: number } | undefined;
        try {
          const s = statSync(abs);
          stat = { size: s.size, mtimeMs: s.mtimeMs };
        } catch {
          continue; // 文件在扫描途中被删
        }
        // 免哈希快速路径:大小与 mtime 在容忍窗口内则视为未改动(兼容 FAT32 2s 精度)
        if (stat && isUnchanged(prev, stat)) {
          continue;
        }
        // 大小相同但 mtime 变化(或旧数据无 mtime)才做内容哈希对比
        if (stat && stat.size === prev.size && !contentChanged(prev, abs)) continue;
      }
      changed.push(rel);
    }
  }
  walk(root);

  // 索引中有、本地文件已不存在的非墓碑条目 → 墓碑
  const tombstones: IndexEntry[] = [];
  for (const entry of index.listEntries()) {
    if (entry.deleted || seen.has(entry.path)) continue;
    if (isIgnored(rules, entry.path, false)) continue;
    tombstones.push({
      ...entry,
      version: incrementVersion(entry.version, deviceId),
      deleted: true,
      blocks: [],
    });
  }

  return { changed, tombstones };
}
