import type { IndexEntry } from './index.js';
import { buildPlan } from './plan.js';
import type { LocalExecutor, BlockProvider } from './executor.js';

/**
 * From the local perspective, return the entries that should be sent
 * to the remote: entries the local side is newer on, plus newer local
 * tombstones that must propagate.
 */
export function planOutgoing(
  local: Map<string, IndexEntry>,
  remote: Map<string, IndexEntry>,
): IndexEntry[] {
  const actions = buildPlan(local, remote);
  const outgoing: IndexEntry[] = [];

  for (const action of actions) {
    if (action.kind === 'send') {
      outgoing.push(action.entry);
    } else if (action.kind === 'delete') {
      const localEntry = local.get(action.path);
      if (localEntry?.deleted) {
        outgoing.push(localEntry);
      }
    }
  }

  return outgoing;
}

/**
 * Apply the remote index to the local side: land receives, deletions and
 * conflict copies. Uses buildPlan + LocalExecutor; no real socket involved.
 */
export async function handleIncoming(
  local: Map<string, IndexEntry>,
  remote: Map<string, IndexEntry>,
  executor: LocalExecutor,
  provider: BlockProvider,
  remoteDeviceId: string,
): Promise<void> {
  const actions = buildPlan(local, remote);

  for (const action of actions) {
    switch (action.kind) {
      case 'receive':
        await executor.applyReceive(action.entry, provider);
        break;
      case 'delete': {
        const remoteEntry = remote.get(action.path);
        if (remoteEntry?.deleted) {
          await executor.applyDelete(action.path, remoteEntry);
        }
        break;
      }
      case 'conflict':
        await executor.applyConflict(
          action.path,
          action.local,
          action.remote,
          provider,
          remoteDeviceId,
        );
        break;
      case 'send':
        break;
    }
  }
}
