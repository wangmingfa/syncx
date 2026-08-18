import type { VersionVector } from './version.js';
import { compareVersions } from './version.js';

export interface IndexEntry {
  path: string;
  version: VersionVector;
  size: number;
  deleted: boolean;
  /** SHA-256 hashes of the 1MB blocks that make up the file content. */
  blocks: string[];
  /**
   * 本地文件的修改时间(毫秒),由扫描/落盘时记录,用于免哈希快速跳过未变更文件。
   * 可选:跨设备的索引(线上协议)不带此字段,旧数据缺省为 undefined。
   */
  mtime?: number;
}

export type FileStateRelation = 'equal' | 'local-newer' | 'remote-newer' | 'conflict';

/**
 * Compare the state of one path between the local and remote indexes.
 * `undefined` means the index has no entry for this path.
 */
export function compareFileState(
  local: IndexEntry | undefined,
  remote: IndexEntry | undefined,
): FileStateRelation {
  if (local === undefined && remote === undefined) return 'equal';
  if (local === undefined) return 'remote-newer';
  if (remote === undefined) return 'local-newer';

  const relation = compareVersions(local.version, remote.version);
  switch (relation) {
    case 'equal':
      return 'equal';
    case 'a-newer':
      return 'local-newer';
    case 'b-newer':
      return 'remote-newer';
    case 'concurrent':
      return 'conflict';
  }
}
