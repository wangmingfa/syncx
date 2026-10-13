/**
 * 空目录盘点与清理(目录卡「空文件夹」工具)。
 *
 * 背景:目录不是同步实体 —— 扫描器只索引文件(IndexEntry 没有目录类型),删除一个空
 * 目录不会产生墓碑、也不会广播给对端。于是共享目录里会慢慢攒下「两边都没有文件、
 * 却谁也不会清」的空壳,而且**永远不会自己消失**。本模块提供「找出它们 + 用户在
 * 弹窗里确认后删掉」,全程只碰本机磁盘,不碰索引、不触发扫描。
 *
 * 两个函数对「空」的定义必须严格一致(扫描列出的就是删除愿意删的):
 *  - 子树里**物理上没有任何文件**才算空;文件计内容,符号链接/其它特殊条目也计内容
 *    (删除侧绝不 remove 它们,列出来就成了「列出但删不掉」的谎);
 *  - 忽略规则只决定**报告范围**:被忽略的目录自己不列出(不同步的东西不提示清理,
 *    这是需求原话),但被忽略目录里的文件照旧算它父级的内容 —— 仅装着 node_modules
 *    的目录不可报告为空(反向对照),否则删除侧会去删一个塞满东西的目录;
 *  - 嵌套共享根是**屏障**:属于别的共享目录的地盘,既不进入、也不列出,且一律计为
 *    内容(它的清理归那个共享自己管;包含它的父目录因此也不列出,免得删父目录时
 *    动到别人);
 *  - 共享根自身永不列出(根为空属于「移除目录」流程的语义,不是清理工具管的)。
 *
 * 删除的安全不变式(任何一条被破坏都构成数据丢失风险):
 *  1. 只 rmdir、从不 unlink —— 结构上不可能删掉文件,真碰上有文件的目录只会失败;
 *  2. 每个请求路径先过 resolveFolderSubpath(目录穿越/软链逃逸闸)与嵌套根判定;
 *  3. 扫描与删除之间目录可能被塞进东西:删除前 verifyEmpty 复核,rmdir 前逐层再看一遍,
 *     任何文件出现即中止该条(结果如实带原因);
 *  4. 不触发 runScan、不写索引 —— 目录不是同步实体,删除不产生任何需要广播的东西。
 */
import { readdirSync, realpathSync, rmdirSync } from 'node:fs';
import { join, resolve as resolvePath, sep } from 'node:path';
import type { IgnoreRule } from './ignore.js';
import { isIgnoredPath } from './ignore.js';
import { PathUnsafeError, resolveFolderSubpath } from './filebrowser.js';

/** 单次盘点的空目录条数上限:弹窗是给人看的,几千条之外先给数字不给列表。 */
export const EMPTY_DIRS_MAX = 2000;

export interface EmptyDirScanResult {
  /** 空目录(相对共享根的 POSIX 路径),字典序。 */
  dirs: string[];
  /** 超出上限被截断时为 true。 */
  truncated: boolean;
}

/** 删除单条路径的结果;ok=false 时 reason 直接展示给用户解释为什么没删。 */
export interface EmptyDirDeleteResult {
  path: string;
  ok: boolean;
  reason?: string;
}

/**
 * 把其它共享根的路径整理成「严格含于 rootAbs 之内」的比较集合,
 * 供嵌套屏障判定。两级形式都收:字面 resolve 形式(与配置一致)与 realpath 形式
 * (配置路径经软链时也能对上真实位置);目录已不存在则只留字面形式。
 *
 * 必须滤掉 rootAbs 自己与**祖先/外层的**共享根:外层共享根本就把本目录整棵跳过,
 * 不约束本目录内部的删除 —— 不滤掉的话 `startsWith(nr + sep)` 会把本目录下所有
 * 路径都判成「属于别的共享」,整个工具直接瘫痪。
 */
function buildNestedSet(rootAbs: string, nestedRoots: string[]): Set<string> {
  const set = new Set<string>();
  for (const nr of nestedRoots) {
    const forms = [resolvePath(nr)];
    try {
      const real = realpathSync(nr);
      if (!forms.includes(real)) forms.push(real);
    } catch {
      // 共享根目录可能已不存在(盘未挂载等):仅字面形式
    }
    for (const f of forms) {
      if (f !== rootAbs && f.startsWith(rootAbs + sep)) set.add(f);
    }
  }
  return set;
}

/**
 * 盘点共享目录里的空目录。只读、不起 git、不写任何东西。
 *
 * @param nestedRoots 其它共享目录的根路径。严格含于本目录内的会作为屏障:
 *   不进入、不列出、计为内容(见模块头注释)。
 */
export function scanEmptyDirs(
  root: string,
  rules: IgnoreRule[],
  nestedRoots: string[] = [],
  limit = EMPTY_DIRS_MAX,
): EmptyDirScanResult {
  const nested = buildNestedSet(resolvePath(root), nestedRoots);
  const dirs: string[] = [];
  let truncated = false;

  /**
   * 走一棵子树,返回「是否存在内容」;顺带把发现的空目录收进 dirs。
   * inIgnored = 祖先(或自身)已被忽略规则命中:扫描器一旦进入被忽略目录就不再往下
   * 递归,和它保持一致 —— 被忽略子树里的目录一律不报告(整棵不在同步范围)。
   */
  const walk = (absDir: string, relDir: string, inIgnored: boolean): boolean => {
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      // 读不动(权限等):无法证明为空就不许被删,保守当有内容
      return true;
    }
    let hasContent = false;
    for (const entry of entries) {
      const abs = join(absDir, entry.name);
      if (!entry.isDirectory()) {
        // 文件、符号链接、其它特殊条目:都算内容。软链指向目录时 dirent 也不是
        // dir(按 lstat 语义),不会递归进去、不会被列出 —— 与 scanner 一致。
        hasContent = true;
        continue;
      }
      if (nested.has(resolvePath(abs))) {
        // 别的共享目录的地盘:屏障,不进入、计内容
        hasContent = true;
        continue;
      }
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      const ignored = inIgnored || isIgnoredPath(rules, rel, true);
      const childContent = walk(abs, rel, ignored);
      if (childContent) {
        hasContent = true;
      } else if (!ignored) {
        if (dirs.length < limit) dirs.push(rel);
        else truncated = true;
      }
    }
    return hasContent;
  };

  walk(root, '', false);
  dirs.sort();
  return { dirs, truncated };
}

/** verifyEmpty 的三态:空 / 目录刚被外部删掉(幂等成功)/ 挡住了(带原因)。 */
type EmptyProbe = { kind: 'empty' } | { kind: 'missing' } | { kind: 'blocked'; reason: string };

/**
 * 删除前的复核:递归重走一遍,确认现在仍然没有任何文件、也没有嵌套共享根。
 * 扫描快照可能已经过时(用户在别的窗口往目录里放了东西之类),这一步是删除前的
 * 最后一道感知闸;真正的防删死闸在 rmdirBottomUp(它连 rmdir 都会失败)。
 */
function verifyEmpty(absDir: string, nested: Set<string>): EmptyProbe {
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'blocked', reason: '目录不可读,跳过' };
  }
  for (const entry of entries) {
    const child = join(absDir, entry.name);
    if (!entry.isDirectory()) return { kind: 'blocked', reason: '目录内现在有文件,跳过' };
    if (nested.has(child)) return { kind: 'blocked', reason: '目录内还有其它共享目录,跳过' };
    const probe = verifyEmpty(child, nested);
    if (probe.kind !== 'empty') return probe;
  }
  return { kind: 'empty' };
}

/** rmdirBottomUp 的结果:null = 删净(或本来就没了);字符串 = 中止原因。 */
const RMDIR_FILE = '删除时目录内容有变化,未完成(未删除任何文件)';

/**
 * 自底向上删除一棵**只含目录**的树:每层先递归清子目录,子目录全清掉后 rmdir 自己。
 * 任何一个非目录条目(文件/软链)都会让该层立刻失败 —— 只 rmdir、从不 unlink,
 * 「绝不删文件」由结构保证,不靠调用方守规矩。
 *
 * 中途失败可能留下「部分空目录已删」的中间态:那些目录本来就是空的,删掉无害,
 * 且不涉及任何同步语义(目录不是同步实体);用户重扫再删一次即可。
 */
function rmdirBottomUp(absDir: string, nested: Set<string>): string | null {
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null; // 已经不在了 = 目标达成
    return '目录不可读,跳过';
  }
  for (const entry of entries) {
    const child = join(absDir, entry.name);
    if (!entry.isDirectory()) return RMDIR_FILE;
    if (nested.has(child)) return '目录内出现其它共享目录,已中止';
    const err = rmdirBottomUp(child, nested);
    if (err !== null) return err;
  }
  try {
    rmdirSync(absDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    // ENOTEMPTY(复核后有东西被放进来了)与 EACCES 等都归这里:没删成就如实说
    return RMDIR_FILE;
  }
  return null;
}

/**
 * 删除若干空目录(弹窗里勾选的那批)。逐条独立处理并返回结果,不做整批原子 ——
 * 一条被拒不应连累其余条。
 *
 * 每条路径的闸门顺序(任一不过即 ok:false 并带上人能看懂的原因):
 *  1. resolveFolderSubpath:目录穿越 / 绝对路径 / 软链逃逸 → 抛错被拒;
 *  2. 等于共享根本身 → 拒(根本为空属于「移除目录」的事);
 *  3. 命中忽略规则/硬忽略 → 拒(已不在同步范围,扫描也不会列它);
 *  4. 属于/包含其它共享根 → 拒;
 *  5. verifyEmpty 复核 + rmdirBottomUp 自底向上删。
 * 路径已不存在(重复请求被前一条带走 / 外部已删)→ ok:true 幂等。
 *
 * 不触发 runScan:目录删除不产生墓碑,没有任何东西需要广播。
 */
export function removeEmptyDirs(
  root: string,
  relPaths: string[],
  rules: IgnoreRule[],
  nestedRoots: string[] = [],
): EmptyDirDeleteResult[] {
  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch {
    // 共享根都不在了:如实报失败,而不是逐条假称「已删除」
    return relPaths.map((p) => ({ path: p, ok: false, reason: '共享目录不存在或不可读' }));
  }
  const nested = buildNestedSet(rootReal, nestedRoots);

  // 深路径先处理:父与子都被勾选时,子先删、父的复核自然放行(整条链一次清完);
  // 同深度按字典序,保证结果顺序确定。
  const sorted = [...relPaths].sort((a, b) => {
    const da = a.split('/').length;
    const db = b.split('/').length;
    return da !== db ? db - da : a.localeCompare(b);
  });

  const results: EmptyDirDeleteResult[] = [];
  for (const rel of sorted) {
    let abs: string;
    try {
      abs = resolveFolderSubpath(rootReal, rel);
    } catch (e) {
      if (e instanceof PathUnsafeError) {
        results.push({ path: rel, ok: false, reason: e.message });
      } else if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
        results.push({ path: rel, ok: true });
      } else {
        results.push({ path: rel, ok: false, reason: e instanceof Error ? e.message : '路径不可达' });
      }
      continue;
    }
    if (abs === rootReal) {
      results.push({ path: rel, ok: false, reason: '不能删除共享目录本身' });
      continue;
    }
    if (isIgnoredPath(rules, rel, true)) {
      results.push({ path: rel, ok: false, reason: '已不在同步范围内(被忽略规则命中),跳过' });
      continue;
    }
    if (nested.has(abs)) {
      results.push({ path: rel, ok: false, reason: '属于其它共享目录,跳过' });
      continue;
    }
    const probe = verifyEmpty(abs, nested);
    if (probe.kind === 'blocked') {
      results.push({ path: rel, ok: false, reason: probe.reason });
      continue;
    }
    if (probe.kind === 'missing') {
      results.push({ path: rel, ok: true });
      continue;
    }
    const err = rmdirBottomUp(abs, nested);
    if (err === null) results.push({ path: rel, ok: true });
    else results.push({ path: rel, ok: false, reason: err });
  }
  return results;
}
