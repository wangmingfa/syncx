import type { IndexEntry } from './index.js';
import { compareFileState } from './index.js';

export type PlanAction =
  | { kind: 'send'; path: string; entry: IndexEntry }
  | { kind: 'receive'; path: string; entry: IndexEntry }
  | { kind: 'delete'; path: string }
  | { kind: 'conflict'; path: string; local: IndexEntry; remote: IndexEntry };

/**
 * Compare the local and remote indexes and produce the actions
 * that would bring them into agreement.
 */
export function buildPlan(
  local: Map<string, IndexEntry>,
  remote: Map<string, IndexEntry>,
): PlanAction[] {
  const actions: PlanAction[] = [];
  const paths = new Set([...local.keys(), ...remote.keys()]);

  for (const path of paths) {
    const localEntry = local.get(path);
    const remoteEntry = remote.get(path);
    const relation = compareFileState(localEntry, remoteEntry);

    switch (relation) {
      case 'equal':
        break;
      case 'local-newer':
        if (localEntry!.deleted) {
          actions.push({ kind: 'delete', path });
        } else {
          actions.push({ kind: 'send', path, entry: localEntry! });
        }
        break;
      case 'remote-newer':
        if (remoteEntry!.deleted) {
          actions.push({ kind: 'delete', path });
        } else {
          actions.push({ kind: 'receive', path, entry: remoteEntry! });
        }
        break;
      case 'conflict':
        actions.push({ kind: 'conflict', path, local: localEntry!, remote: remoteEntry! });
        break;
    }
  }

  return actions;
}
