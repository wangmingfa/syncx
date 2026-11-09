import { readdirSync, statSync, existsSync, type Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { IndexEntry } from './index.js';
import type { IndexStore } from './indexstore.js';
import type { IgnoreRule } from './ignore.js';
import { isIgnoredPath, isConflictCopyName, isScratchSegment } from './ignore.js';
import { pruneScratchFile } from './partial-store.js';
import { blocksMatchOnDisk } from './blockstore.js';
import { incrementVersion } from './version.js';

/** FAT32 mtime 精度为 2 秒;容忍窗口内的 mtime 抖动走内容哈希确认,不直接免检。 */
const MTIME_TOLERANCE_MS = 2000;

/**
 * 免哈希快速路径:大小相同**且 mtime 完全一致**才视为未改动,跳过整文件重算。
 *
 * 曾经的实现是「mtime 差在 2 秒容忍窗口内即免检」——那把窗口内的**真实改动**也
 * 永久吞掉了:扫描若恰落在一次写入完成前(读到中间态,size 恰好与最终一致),
 * 之后每一轮 |mtime 差| ≈ 80ms 都在窗口内,这条目就再也不重哈希 —— 本机索引
 * 永远宣告旧哈希,对端按旧哈希索块、本机供出新内容被接收端哈希闸门拒收,
 * 传输死锁(2026-11-09 MoonUI 两文件实测)。现在只有 mtime 完全一致才免检;
 * 窗口内的抖动(FAT32 粒度、touch、写入完成前的竞态)落到调用方的「内容哈希
 * 对比 + 写回新 mtime」路径 —— 一次整文件哈希后 diff 归零,不会每轮重复付。
 *
 * 导出它不只是为了复用那 2 秒的容忍窗口,而是为了**共用同一条口径**:「这条目的块哈希
 * 还代表不代表盘上的字节」。drift 哨兵(见 drift.ts 的检查 B)只审 isUnchanged 成立的
 * 条目 —— 正在被本机编辑的文件,盘上内容与旧宣告不符是预期,不是漂移。两边各写一遍
 * 迟早会漂:一边认 2 秒容忍、另一边不认,哨兵就开始报假案。
 */
export function isUnchanged(entry: IndexEntry, stat: { size: number; mtimeMs: number }): boolean {
  if (stat.size !== entry.size) return false;
  if (entry.mtime === undefined) return false;
  return stat.mtimeMs === entry.mtime;
}

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
  /**
   * 盘上残留的冲突副本数(它们被硬忽略、不进索引,但目录卡徽标要报数)。
   * 扫描本就要遍历目录树,顺手计数零成本;嵌套共享根/硬忽略目录内的副本不计
   * (与冲突收件箱的扫盘口径一致)。
   */
  conflictCount: number;
}

/**
 * 内容变了没:逐块读盘比对哈希,首处不符即返回。
 * 以前是 readFileSync 整读再算块 —— 扫描每轮对**每个**已索引文件都问一次,一个超大
 * 文件就是一次整读(峰值 = 文件大小,且受 ~2GiB 上限约束),而绝大多数答案在
 * 第一块就能短出去。
 */
function contentChanged(entry: IndexEntry, absPath: string): boolean {
  try {
    return !blocksMatchOnDisk(absPath, entry.blocks);
  } catch {
    return true; // 读不到按变化处理,由调用方 try/catch 兜底
  }
}

/** 两条路径(同步 / 异步)共用的空 diff:根不存在、或目录树里什么都没有。 */
function emptyDiff(): ScanDiff {
  return { changed: [], tombstones: [], filesSeen: 0, conflictCount: 0 };
}

/**
 * 相对路径一律由父级相对目录 + 文件名以 '/' 拼接,**不使用 path.relative/join 生成**:
 * 同步协议与索引一律使用 POSIX 分隔符,而 Windows 上 path.relative 返回的是 '\'。
 * 一旦把 '\' 路径当成索引 key,就会出现「索引里有 utils/x.mbt、扫描却得到 utils\x.mbt」
 * 的错配:每个子目录文件既进 changed(误报修改)又被判为「索引有、盘上无」→ 生成墓碑
 * 广播给对端,把对端整棵子目录删掉(2026-09-15 Windows 端 251 个文件被误删的根因;
 * 顶层文件不含分隔符故不受影响,恰好解释了「只删子目录、不删顶层」的形态)。
 * 以字符串拼接代替平台 API 后,该问题在结构上不可能再出现。
 * 同步版与异步版共用此实现,保证两版的路径口径永远一致。
 */
function relOf(relDir: string, name: string): string {
  return relDir === '' ? name : `${relDir}/${name}`;
}

/**
 * 墓碑推导(扫描收尾,纯内存逻辑):索引中有、本地文件已不存在的非墓碑条目 → 墓碑。
 * 同步版与异步版**逐字共用**这一段 —— 它是历史上出过事故的部分(嵌套共享根前缀守卫、
 * 硬忽略条目墓碑),两份拷贝迟早漂移,这里从结构上杜绝。
 */
function computeTombstones(
  root: string,
  index: IndexStore,
  rules: IgnoreRule[],
  deviceId: string,
  nestedRoots: string[],
  seen: Set<string>,
): IndexEntry[] {
  const tombstones: IndexEntry[] = [];
  for (const entry of index.listEntries()) {
    if (entry.deleted || seen.has(entry.path)) continue;
    // 按需同步的占位条目(见 IndexEntry.placeholder):盘上本就没有实体文件,
    // 这不是「本地删除」——生成墓碑会把对端的真文件删进回收站(数据丢失级)。
    if (entry.placeholder) continue;
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
      // 墓碑不指向任何内容:CDC 视图与块长一并清掉(留着只会白白撑大索引与线路)
      cdh: undefined,
      clens: undefined,
    });
  }
  return tombstones;
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
    return emptyDiff();
  }

  const changed: string[] = [];
  const seen = new Set<string>();
  // 盘上冲突副本计数(硬忽略、不进索引,但目录卡徽标要报数)
  let conflictCount = 0;

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
      if (!dirent.isFile()) continue;
      // 接收中间态(在途 tmp + 位图 sidecar):不参与索引/宣告,顺带回收过期残骸
      // (断点续传让半截 tmp 能在盘上躺很久,没人续的那些必须有人收)。
      // 非中间态的目录项不付这个 stat:pruneScratchFile 自己按后缀短路。
      if (isScratchSegment(dirent.name)) {
        pruneScratchFile(dir, dirent.name);
        continue;
      }
      // 冲突副本被硬忽略跳过,但先计数供目录卡徽标(它们不参与同步/索引/墓碑)
      if (isConflictCopyName(dirent.name)) conflictCount += 1;
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
        // 免哈希快速路径:大小与 mtime 完全一致才视为未改动;容忍窗口内的 mtime
        // 抖动落到下面的内容哈希确认(FAT32 粒度、写入竞态都只付一次哈希)
        if (stat && isUnchanged(prev, stat)) {
          continue;
        }
        // 大小相同但 mtime 变化(或旧数据无 mtime)才做内容哈希对比
        if (stat && stat.size === prev.size && !contentChanged(prev, abs)) {
          // 内容未变仅 mtime 变化:写回新 mtime,把 diff 归零 —— 否则容忍窗口内
          // 的抖动会每轮重复整文件哈希。mtime 不在同步协议内,不递增版本、不触发广播。
          if (prev.mtime === undefined || stat.mtimeMs !== prev.mtime) {
            index.saveEntry({ ...prev, mtime: stat.mtimeMs });
          }
          continue;
        }
      }
      changed.push(rel);
    }
  }
  walk(root, '');

  // 墓碑推导是纯内存逻辑,与异步版共用同一实现(见 computeTombstones 注释)
  const tombstones = computeTombstones(root, index, rules, deviceId, nestedRoots, seen);

  return { changed, tombstones, filesSeen: seen.size, conflictCount };
}

/* ==================== 异步形态(scanFolderAsync):让出主线程 ==================== */

/** setImmediate 让出:把控制权交还事件循环一个回合,期间定时器 / IO / API 请求都能插进来。 */
function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** 异步扫描的让出节奏缺省值:目标是单次连续阻塞 ≤ 100ms 量级(见 scanFolderAsync)。 */
const YIELD_EVERY_ENTRIES = 64;
const YIELD_EVERY_MS = 50;

/** scanFolderAsync 的可选参数:让出节奏可调 + 测试观测钩子。 */
export interface ScanFolderAsyncOptions {
  /** 每处理 N 个目录项让出一次主线程(缺省 64)。 */
  yieldEveryEntries?: number;
  /** 距上次让出超过 M ms 也强制让出(缺省 50)。慢存储上单个条目的 IO 就可能几十 ms,光数条目会让得太疏。 */
  yieldEveryMs?: number;
  /** 每次实际让出时回调一次(测试数让出次数用;生产不传,零成本)。 */
  onYield?: () => void;
}

/**
 * scanFolder 的异步形态:遍历逻辑逐行镜像同步版(语义必须完全一致 —— 忽略判定、
 * 嵌套共享根、墓碑、mtime 写回、conflictCount、大文件分块策略全部同口径),差异只有两点:
 *
 * 1. readdir/stat 走 fs.promises,不再长时间霸占主线程;
 * 2. 每个目录项前经过 pacing() 让出点 —— 条目计数(快盘上 64 项通常亚毫秒到几 ms,
 *    保证「无论如何」定期让出)与时间(慢盘上单个 stat 就可能几十 ms,靠计数会让得太疏,
 *    50ms 计时兜住单次连续阻塞 ≤ 100ms 量级)两条触发线取先到者。计数对**每个**被遍历的
 *    目录项 +1(含被忽略跳过的 —— readdir 已为它们付过账),递归子目录共享同一计数器,
 *    让出频率只看整棵树的总量。
 *
 * 为什么 Termux(Android)需要异步版:Android 存储单个 statSync 可达 5ms 量级,几百个
 * 文件的目录就是秒级同步阻塞,期间所有 API 请求排队、网页全部卡顿(生产日志实证:
 * 每 ~6s 一次 ~5s 的事件循环卡顿,根因正是 scanOnce 的同步遍历)。readdir 的结果
 * (Dirent 数组)拿到后逐项 stat 本来就是天然的异步边界,让出只是把控制权还给循环。
 *
 * 竞态等价性:让出窗口比同步版宽,「条目中途消失」的防护必须等价保留 —— stat 失败
 * continue、readdir 失败整目录放弃、seen.add 先于 stat(已看到就不产生墓碑),三处与
 * 同步版逐字一致。让出期间索引可能被入站同步推进,但扫描所有读取点(getEntry/stat)
 * 都取当次最新值,判定路径不变,语义仍自洽。
 */
export async function scanFolderAsync(
  root: string,
  index: IndexStore,
  rules: IgnoreRule[],
  deviceId: string,
  nestedRoots: string[] = [],
  opts: ScanFolderAsyncOptions = {},
): Promise<ScanDiff> {
  // 与同步版同语义:根不存在(盘符卸载 / 权限丢失 / 未挂载)→ 空 diff,不做墓碑推断;
  // 根存在但 stat 失败(权限等)→ 异常向上抛,由 scanOnce 记「扫描失败」(与同步版
  // statSync 抛出的路径一致)。
  if (!existsSync(root)) return emptyDiff();
  if (!(await stat(root)).isDirectory()) return emptyDiff();

  const yieldEveryEntries = opts.yieldEveryEntries ?? YIELD_EVERY_ENTRIES;
  const yieldEveryMs = opts.yieldEveryMs ?? YIELD_EVERY_MS;
  let entriesSinceYield = 0;
  let lastYieldAt = Date.now();

  /** 让出节奏(见函数注释上的两条触发线);每次实际让出回调一次 onYield。 */
  async function pacing(): Promise<void> {
    entriesSinceYield += 1;
    const now = Date.now();
    if (entriesSinceYield >= yieldEveryEntries || now - lastYieldAt >= yieldEveryMs) {
      await yieldToLoop();
      opts.onYield?.();
      entriesSinceYield = 0;
      lastYieldAt = now;
    }
  }

  const changed: string[] = [];
  const seen = new Set<string>();
  // 盘上冲突副本计数(硬忽略、不进索引,但目录卡徽标要报数)
  let conflictCount = 0;

  async function walk(dir: string, relDir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // 目录已被删除(与同步版同防护)
    }
    for (const dirent of entries) {
      await pacing();
      const abs = join(dir, dirent.name);
      const rel = relOf(relDir, dirent.name);
      if (dirent.isDirectory()) {
        // 嵌套共享根:本目录树(父/外层)不递归进去,其中文件交由那个共享自行同步
        const absNorm = resolve(abs);
        if (nestedRoots.some((nr) => absNorm === resolve(nr))) continue;
        if (!isIgnoredPath(rules, rel, true)) await walk(abs, rel);
        continue;
      }
      if (!dirent.isFile()) continue;
      // 接收中间态(在途 tmp + 位图 sidecar):不参与索引/宣告,顺带回收过期残骸。
      // pruneScratchFile 自己按后缀短路,单个中间态的成本有界,保持同步调用。
      if (isScratchSegment(dirent.name)) {
        pruneScratchFile(dir, dirent.name);
        continue;
      }
      // 冲突副本被硬忽略跳过,但先计数供目录卡徽标(它们不参与同步/索引/墓碑)
      if (isConflictCopyName(dirent.name)) conflictCount += 1;
      if (isIgnoredPath(rules, rel, false)) continue;

      seen.add(rel);
      const prev = index.getEntry(rel);
      if (prev && !prev.deleted) {
        let statInfo: { size: number; mtimeMs: number } | undefined;
        try {
          const s = await stat(abs);
          statInfo = { size: s.size, mtimeMs: s.mtimeMs };
        } catch {
          continue; // 文件在扫描途中被删 —— 让出窗口比同步版宽,这条防护必须等价保留
        }
        // 免哈希快速路径与内容比对口径,与同步版逐字一致
        if (statInfo && isUnchanged(prev, statInfo)) {
          continue;
        }
        if (statInfo && statInfo.size === prev.size && !contentChanged(prev, abs)) {
          // 内容未变仅 mtime 变化:写回新 mtime,把 diff 归零 —— 否则容忍窗口内
          // 的抖动会每轮重复整文件哈希。mtime 不在同步协议内,不递增版本、不触发广播。
          if (prev.mtime === undefined || statInfo.mtimeMs !== prev.mtime) {
            index.saveEntry({ ...prev, mtime: statInfo.mtimeMs });
          }
          continue;
        }
      }
      changed.push(rel);
    }
  }
  await walk(root, '');

  // 墓碑推导与同步版逐字共用同一实现(computeTombstones)
  const tombstones = computeTombstones(root, index, rules, deviceId, nestedRoots, seen);

  return { changed, tombstones, filesSeen: seen.size, conflictCount };
}
