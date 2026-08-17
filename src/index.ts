import type { VersionVector } from './version.js';
import { compareVersions } from './version.js';

export interface IndexEntry {
  path: string;
  version: VersionVector;
  size: number;
  deleted: boolean;
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
