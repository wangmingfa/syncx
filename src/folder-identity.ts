import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { FolderIdentity } from './config.js';

/**
 * 旧版本写在共享根里的挂载标记文件名。**不再创建**,只用于启动时清理用户目录里的遗留
 * 文件——它会以未跟踪文件的形式一直出现在 `git status` 里。
 */
export const LEGACY_FOLDER_MARKER = '.syncx-folder';

/** 旧版标记文件的内容前缀(用于确认「这个文件确实是 syncx 写的」再删)。 */
const LEGACY_MARKER_BANNER = '此文件由 syncx 生成';

/** 旧版标记文件在共享根下的绝对路径。 */
export function legacyFolderMarkerPath(root: string): string {
  return join(root, LEGACY_FOLDER_MARKER);
}

/**
 * 采集共享根的**身份指纹**(dev + ino)。
 *
 * 返回 null 表示「拿不到可信身份」,有三种情形,调用方**不得**当成「目录正常」:
 *   - 路径不存在或不是目录(盘符卸载 / 目录被删);
 *   - stat 失败(权限、I/O 错误);
 *   - 平台/文件系统不提供 inode(部分网络文件系统返回 0)。
 *
 * 用 bigint stat 并把结果转成十进制字符串:一是 JSON 无法序列化 BigInt,二是部分文件系统
 * 的 inode 超过 2^53,用 number 会丢精度、可能把两个不同目录算成同一个身份。
 */
export function readFolderIdentity(root: string): FolderIdentity | null {
  try {
    if (!existsSync(root)) return null;
    const st = statSync(root, { bigint: true });
    if (!st.isDirectory()) return null;
    if (st.ino === 0n) return null;
    return { dev: String(st.dev), ino: String(st.ino) };
  } catch {
    return null;
  }
}

/** 共享目录身份的校验结论。 */
export type FolderIdentityVerdict =
  /** 指纹一致:目录就是当初纳入同步的那个。 */
  | 'ok'
  /** 路径不存在或不可读:盘未挂载 / 目录被删。 */
  | 'missing'
  /** 指纹变化:换盘、重新挂载、或目录被删掉后重建。 */
  | 'changed'
  /** 无法校验:尚未采集指纹,或平台不提供 inode。 */
  | 'unknown';

/**
 * 比对共享根当前身份与已记录的指纹。
 *
 * 这是「盘不见了/目录被换掉了」与「用户真的把文件删光了」之间唯一可靠的区分点——
 * 后者根目录身份不变,前者一定会变(卸载后路径要么消失,要么变回承载文件系统上的
 * 那个目录,dev/ino 随之改变)。参照 Syncthing 的 `.stfolder`,但不往用户目录写文件。
 *
 * 未记录指纹时返回 'unknown' 而不是 'ok':宁可退化到结构守卫,也不凭空信任。
 */
export function checkFolderIdentity(
  root: string,
  recorded: FolderIdentity | undefined,
): FolderIdentityVerdict {
  const current = readFolderIdentity(root);
  if (current === null) return 'missing';
  if (recorded === undefined) return 'unknown';
  return current.dev === recorded.dev && current.ino === recorded.ino ? 'ok' : 'changed';
}

/**
 * 这个遗留标记文件是否确实是 syncx 写的(而非用户自己的同名文件)。
 * 只认两种:syncx 写的说明文本,或 0 字节空文件(旧版本某些路径下会留下)。
 */
function isOurLegacyMarker(path: string): boolean {
  try {
    const st = statSync(path);
    if (!st.isFile()) return false;
    if (st.size === 0) return true;
    if (st.size > 4096) return false;
    return readFileSync(path, 'utf8').startsWith(LEGACY_MARKER_BANNER);
  } catch {
    return false;
  }
}

/**
 * 删除共享根里遗留的旧版标记文件。
 * 只删「确实是 syncx 生成的」那一个:同名但内容不符的文件保持不动(绝不误删用户文件)。
 * @returns 是否真的删除了文件。
 */
export function removeLegacyFolderMarker(root: string): boolean {
  const path = legacyFolderMarkerPath(root);
  if (!existsSync(path)) return false;
  if (!isOurLegacyMarker(path)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}
