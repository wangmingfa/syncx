import type { DeviceIdentity } from './identity.js';
import type { Config, SharedFolderConfig } from './config.js';

export interface IndexStats {
  entries: number;
  tombstones: number;
}

export interface StatusPayload {
  deviceId: string;
  folders: SharedFolderConfig[];
  entries: number;
  tombstones: number;
}

export function buildStatus(
  identity: DeviceIdentity,
  config: Config,
  stats: IndexStats,
): StatusPayload {
  return {
    deviceId: identity.deviceId,
    folders: config.sharedFolders,
    entries: stats.entries,
    tombstones: stats.tombstones,
  };
}
