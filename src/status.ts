import type { DeviceIdentity } from './identity.js';
import type { Config, SharedFolderConfig } from './config.js';

export interface IndexStats {
  entries: number;
  tombstones: number;
}

export interface PeerStatus {
  deviceId: string;
  online: boolean;
  url?: string;
}

export interface SyncProgress {
  folder: string;
  pending: number;
  sending: number;
  receiving: number;
}

export interface StatusPayload {
  deviceId: string;
  folders: SharedFolderConfig[];
  entries: number;
  tombstones: number;
  peers: PeerStatus[];
  syncProgress: SyncProgress[];
}

export function buildStatus(
  identity: DeviceIdentity,
  config: Config,
  stats: IndexStats,
  peers: PeerStatus[] = [],
  syncProgress: SyncProgress[] = [],
): StatusPayload {
  return {
    deviceId: identity.deviceId,
    folders: config.sharedFolders,
    entries: stats.entries,
    tombstones: stats.tombstones,
    peers,
    syncProgress,
  };
}