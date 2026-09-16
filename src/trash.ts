import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * 旧版本写在共享根里的回收站目录名。**不再创建**,只用于启动时把其中已有的可恢复数据
 * 搬到共享目录之外——留在原处会以未跟踪文件的形式污染用户的 `git status`。
 *
 * 这个名字仍然保留在内置忽略与硬忽略名单里:旧版本的对端可能还带着它,而它出现在共享
 * 目录里必须永远不被同步。
 */
export const LEGACY_TRASH_DIR = '.syncx-trash';

/**
 * 把旧版回收站里的内容整体搬到新的回收站目录(共享目录之外)。
 *
 * 逐文件搬:同文件系统走 rename(瞬时),跨文件系统 / 文件被占用时退化为拷贝后删
 * (与 executor.moveToTrash 同样的策略)。**任何单个文件搬运失败就保留原目录**,
 * 绝不因为「搬不动」而丢掉可恢复的数据。
 *
 * @returns moved = 成功搬运的文件数,failed = 失败数(>0 时原目录被保留)。
 */
export function migrateLegacyTrash(root: string, destDir: string): { moved: number; failed: number } {
  const from = join(root, LEGACY_TRASH_DIR);
  if (!existsSync(from)) return { moved: 0, failed: 0 };

  let moved = 0;
  let failed = 0;

  function walk(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      failed += 1;
      return;
    }
    for (const dirent of entries) {
      const src = join(dir, dirent.name);
      if (dirent.isDirectory()) {
        walk(src);
        continue;
      }
      // 相对路径由「父级相对目录 + 文件名」以 '/' 拼接:与同步路径同构,避免 Windows 的 '\'
      const rel = src.slice(from.length + 1).split(/[\\/]/).join('/');
      const dest = join(destDir, rel);
      try {
        mkdirSync(dirname(dest), { recursive: true });
        try {
          renameSync(src, dest);
        } catch {
          copyFileSync(src, dest);
          rmSync(src);
        }
        moved += 1;
      } catch {
        failed += 1;
      }
    }
  }
  walk(from);

  // 只在全部搬完时移除原目录:有任何失败就原样保留,交给用户/下次启动处理
  if (failed === 0) {
    try {
      rmSync(from, { recursive: true, force: true });
    } catch {
      // 删不掉只影响观感(用户目录里多一个空目录),数据已经安全搬到新位置
    }
  }
  return { moved, failed };
}
