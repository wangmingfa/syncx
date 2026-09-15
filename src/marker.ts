import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 共享目录标记文件名(位于共享根)。
 *
 * 参照 Syncthing 的 `.stfolder`:标记存在 = 「这个目录确实已正确挂载、内容可信」。
 * 标记缺失时该目录的扫描会被跳过、绝不推断删除 —— 用于区分这两种完全不同的情况:
 *   - 「U 盘拔了 / 文件系统没挂载 / 目录被整体清空」→ 根路径可能仍存在但内容为空;
 *   - 「用户确实把文件都删了,想同步删除」→ 标记仍在。
 * 没有这层区分,前者会被当成后者,把对端文件成批删掉。
 *
 * 注意已知盲区(与 Syncthing 相同):标记只建在共享根,子目录若是独立挂载点则救不了。
 */
export const FOLDER_MARKER = '.syncx-folder';

/** 标记文件在共享根下的绝对路径。 */
export function folderMarkerPath(root: string): string {
  return join(root, FOLDER_MARKER);
}

/** 共享根是否带有标记(目录可信的信号)。任何读取异常都按「缺失」处理。 */
export function hasFolderMarker(root: string): boolean {
  try {
    return existsSync(folderMarkerPath(root));
  } catch {
    return false;
  }
}

/**
 * 建立标记文件(幂等)。
 * 目录不存在或不可写时返回 false(不抛错,也不代为创建目录)。
 * @returns 是否**新建**了标记(已存在返回 false)。
 */
export function ensureFolderMarker(root: string): boolean {
  const marker = folderMarkerPath(root);
  if (existsSync(marker)) return false;
  try {
    writeFileSync(
      marker,
      '此文件由 syncx 生成,用于确认该共享目录已正确挂载/内容可信。\n' +
        '删除它会使 syncx 暂停该目录的同步(以防把「目录不可用」误判为「文件被删光」)。\n',
    );
    return true;
  } catch {
    return false;
  }
}
