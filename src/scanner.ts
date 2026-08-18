import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { IndexEntry } from './index.js';
import type { IndexStore } from './indexstore.js';
import type { IgnoreRule } from './ignore.js';
import { isIgnored } from './ignore.js';
import { hashBlock, splitIntoBlocks } from './blockstore.js';
import { incrementVersion } from './version.js';

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
        let size = -1;
        try {
          size = statSync(abs).size;
        } catch {
          continue; // 文件在扫描途中被删
        }
        if (size === prev.size && !contentChanged(prev, abs)) continue;
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
