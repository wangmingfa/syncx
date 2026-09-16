import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { IndexEntry } from './index.js';
import type { IndexStore } from './indexstore.js';
import type { IgnoreRule } from './ignore.js';
import { isIgnoredPath } from './ignore.js';
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
  /**
   * 本轮**实际看到**的文件数(已排除忽略/硬忽略/临时件,不含嵌套共享根内的文件)。
   * 供上层做结构性守卫:无法校验目录身份时,「一个文件都没看到、却要删东西」是
   * 目录未挂载或被换掉的典型形态,此时必须拒绝执行这批删除。
   */
  filesSeen: number;
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
 * 被忽略规则命中的文件不参与(其删除也不传播);硬忽略路径(见 HARD_IGNORE_NAMES)
 * 无论规则怎么写都不参与——这是「.git 绝不被同步出去」的第一道闸门。
 *
 * @param nestedRoots 其它共享目录的(归一化)绝对根路径集合。本目录树中若某子目录命中其中
 *   任一路径,则视为「嵌套共享根」:其文件由那个共享自行负责同步,本题目录(父/外层)既不递归
 *   进去索引、也不为其中文件产生墓碑——从而避免同一批文件被两个共享重复扫描/重复同步,以及
 *   因跳过而误把对方已同步的文件墓碑删除(迁移期数据丢失)。缺省为空,即不做嵌套跳过。
 */
export function scanFolder(
  root: string,
  index: IndexStore,
  rules: IgnoreRule[],
  deviceId: string,
  nestedRoots: string[] = [],
): ScanDiff {
  // 共享目录根不存在(盘符卸载 / 权限丢失 / 未挂载):不做墓碑推断,避免
  // 把整个目录误判为已删除而批量传播墓碑给对端
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return { changed: [], tombstones: [], filesSeen: 0 };
  }

  const changed: string[] = [];
  const seen = new Set<string>();

  /**
   * 相对路径一律由父级相对目录 + 文件名以 '/' 拼接,**不使用 path.relative/join 生成**:
   * 同步协议与索引一律使用 POSIX 分隔符,而 Windows 上 path.relative 返回的是 '\'。
   * 一旦把 '\' 路径当成索引 key,就会出现「索引里有 utils/x.mbt、扫描却得到 utils\x.mbt」
   * 的错配:每个子目录文件既进 changed(误报修改)又被判为「索引有、盘上无」→ 生成墓碑
   * 广播给对端,把对端整棵子目录删掉(2026-09-15 Windows 端 251 个文件被误删的根因;
   * 顶层文件不含分隔符故不受影响,恰好解释了「只删子目录、不删顶层」的形态)。
   * 以字符串拼接代替平台 API 后,该问题在结构上不可能再出现。
   */
  function relOf(relDir: string, name: string): string {
    return relDir === '' ? name : `${relDir}/${name}`;
  }

  function walk(dir: string, relDir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 目录已被删除
    }
    for (const dirent of entries) {
      const abs = join(dir, dirent.name);
      const rel = relOf(relDir, dirent.name);
      if (dirent.isDirectory()) {
        // 嵌套共享根:本目录树(父/外层)不递归进去,其中文件交由那个共享自行同步
        const absNorm = resolve(abs);
        if (nestedRoots.some((nr) => absNorm === resolve(nr))) continue;
        if (!isIgnoredPath(rules, rel, true)) walk(abs, rel);
        continue;
      }
      if (!dirent.isFile() || rel.endsWith(TMP_SUFFIX)) continue;
      if (isIgnoredPath(rules, rel, false)) continue;

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
        if (stat && stat.size === prev.size && !contentChanged(prev, abs)) {
          // 内容未变仅 mtime 变化:写回新 mtime,避免下次扫描重复整文件哈希。
          // mtime 不在同步协议内,不递增版本、不触发广播。
          if (prev.mtime === undefined || Math.abs(stat.mtimeMs - prev.mtime) > MTIME_TOLERANCE_MS) {
            index.saveEntry({ ...prev, mtime: stat.mtimeMs });
          }
          continue;
        }
      }
      changed.push(rel);
    }
  }
  walk(root, '');

  // 索引中有、本地文件已不存在的非墓碑条目 → 墓碑
  const tombstones: IndexEntry[] = [];
  for (const entry of index.listEntries()) {
    if (entry.deleted || seen.has(entry.path)) continue;
    // 硬忽略路径(如 .git/**)绝不生成墓碑:墓碑会把「对端也有这份内容」变成
    // 对端的一次真实删除。历史遗留的硬忽略条目由 createFolderState 从库里清掉
    if (isIgnoredPath(rules, entry.path, false)) continue;
    // 嵌套共享根内的既有条目:本次扫描既不重扫也不墓碑,交由那个共享自行管理,
    // 避免迁移期把对方已同步的文件误删(例如父共享曾索引过子目录文件,启用跳过后被当成已删除)
    const absEntry = resolve(join(root, entry.path));
    // 仅当被保护的根 nr 是当前扫描根的后代(物理含于当前目录树)时,才由当前(父/外层)
    // 目录跳过其文件墓碑,避免误删迁移期文件。若 nr 是当前根的祖先/同级共享根,则该根自己的
    // 删除必须由它自己的扫描负责,不能在此被前缀命中误抑制——否则会把整棵子树的删除全部吞掉
    // (P2 子目录删除 / 接收映射倒置嵌套两类回归:此前父/外层根的 nestedRoots 含一个祖先根,
    // 子树所有条目路径都以该祖先前缀开头,导致 deletions 全被跳过、无法向上游传播)。
    const rootNorm = resolve(root);
    const rootPrefix = rootNorm + sep;
    if (
      nestedRoots.some((nr) => {
        const nrNorm = resolve(nr);
        if (!nrNorm.startsWith(rootPrefix)) return false;
        return absEntry === nrNorm || absEntry.startsWith(nrNorm + sep);
      })
    ) continue;
    tombstones.push({
      ...entry,
      version: incrementVersion(entry.version, deviceId),
      deleted: true,
      blocks: [],
    });
  }

  return { changed, tombstones, filesSeen: seen.size };
}
