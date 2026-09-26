import { readdirSync, rmSync, statSync, realpathSync } from 'node:fs';
import { resolve as resolvePath, sep } from 'node:path';

/**
 * 浏览器内文件管理器的文件系统层:路径越界防护 + 目录列举 + 删除。
 * 与控制路由(src/api/routes/files.ts)分离,便于对「路径安全」做单元测试。
 */

/** 目录列举的单次条目上限:超过则截断并置 truncated,避免巨型目录拖垮 UI。 */
export const DIR_LIST_LIMIT = 2000;

export interface DirEntry {
  /** 相对共享目录根的路径(POSIX 分隔符),列表/下载/删除统一用它寻址。 */
  path: string;
  /** 文件或目录名(不含路径)。 */
  name: string;
  /** true = 目录。 */
  dir: boolean;
  /** 字节数(目录恒为 0)。stat 失败时为 0。 */
  size: number;
  /** 修改时间(毫秒);stat 失败时为 0。 */
  mtime: number;
  /**
   * true = 按需同步的占位文件(盘上无实体,行由索引补入):UI 标「未下载」,
   * 提供「下载」而非直接打开。普通盘面条目缺省(不写该字段)。
   */
  placeholder?: boolean;
}

export interface DirListing {
  entries: DirEntry[];
  /** 条目数超过 DIR_LIST_LIMIT 被截断时为 true。 */
  truncated: boolean;
}

/** 路径含 NUL 字节或形同越界时抛出的统一错误,路由层转 400。 */
export class PathUnsafeError extends Error {
  constructor(message = 'unsafe path') {
    super(message);
    this.name = 'PathUnsafeError';
  }
}

/**
 * 把相对路径解析到共享目录根下的绝对路径,并做两级防越界:
 * 1. 字面校验 —— 拒绝 NUL、反斜杠归一为正斜杠后不得以盘符/根开头;
 * 2. 归一校验 —— resolve 后必须仍落在根内(处理 ../ 等);
 * 3. 软链校验 —— realpath 后必须仍落在根的 realpath 内(处理目录内部软链指到外面)。
 * 根自身返回根的 realpath;根不存在时由调用方(findConfigFolder/路由)先行兜错。
 */
export function resolveFolderSubpath(root: string, relPath: string): string {
  if (relPath.includes('\0')) throw new PathUnsafeError('路径包含非法字符');
  const normalized = relPath.replace(/\\/g, '/');
  if (/^[a-zA-Z]:/.test(normalized) || normalized.startsWith('/')) {
    throw new PathUnsafeError('必须是共享目录内的相对路径');
  }
  const rootReal = realpathSync(root);
  const abs = normalized === '' || normalized === '.' ? rootReal : resolvePath(rootReal, normalized);
  if (abs !== rootReal && !abs.startsWith(rootReal + sep)) {
    throw new PathUnsafeError('路径越出共享目录');
  }
  const real = realpathSync(abs);
  if (real !== rootReal && !real.startsWith(rootReal + sep)) {
    throw new PathUnsafeError('路径经软链越出共享目录');
  }
  return real;
}

/** 把绝对路径转回相对共享目录根的 POSIX 相对路径(列举条目用)。 */
function toRel(rootReal: string, abs: string): string {
  const rel = abs.slice(rootReal.length).replace(/\\/g, '/');
  return rel.startsWith('/') ? rel.slice(1) : rel;
}

/**
 * 列举共享目录下某个子目录:目录在前、名称次序(与资源管理器习惯一致)。
 * 每条 stat 单独容错(并发删除/权限不足的单条不影响整页)。
 */
export function listDirectory(root: string, relPath: string, limit = DIR_LIST_LIMIT): DirListing {
  const rootReal = realpathSync(root);
  const absDir = resolveFolderSubpath(rootReal, relPath);
  const names = readdirSync(absDir).sort((a, b) => a.localeCompare(b));
  const stats = names.map((name) => {
    const abs = resolvePath(absDir, name);
    try {
      const st = statSync(abs); // 用 stat 而非 lstat:软链指向目录时按目标类型展示
      return { name, abs, dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs };
    } catch {
      return { name, abs, dir: false, size: 0, mtime: 0 };
    }
  });
  // 目录在前,组内按名称次序(与上面 readdir 的 localeCompare 一致)
  stats.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  const truncated = stats.length > limit;
  const kept = truncated ? stats.slice(0, limit) : stats;
  return {
    entries: kept.map((s) => ({
      path: toRel(rootReal, s.abs),
      name: s.name,
      dir: s.dir,
      size: s.size,
      mtime: s.mtime,
    })),
    truncated,
  };
}

/** 删除共享目录内单个文件或整个子目录(递归)。不存在时抛错由路由转 400。 */
export function deleteFolderEntry(root: string, relPath: string): void {
  const rootReal = realpathSync(root);
  const abs = resolveFolderSubpath(rootReal, relPath);
  if (abs === rootReal) throw new PathUnsafeError('不能删除共享目录本身');
  statSync(abs); // 先确认存在,让「不存在」成为明确错误而不是静默成功
  rmSync(abs, { recursive: true });
}
