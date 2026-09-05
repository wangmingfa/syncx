import type { DeviceIdentity } from './identity.js';
import type { Config, SharedFolderConfig, PendingOffer } from './config.js';

export interface IndexStats {
  entries: number;
  tombstones: number;
}

export interface DeviceStatus {
  deviceId: string;
  online: boolean;
  url?: string;
  /** 本机配置里该设备被指派到的目录 id 列表(用于界面展示「共享 N 个目录」)。 */
  folders: string[];
  /** 对端经 folder-sync-list 宣告的「它与本机在同步的目录 id 集合」。
   *  undefined = 对端为旧版本,UI 无法区分「已停止共享」。 */
  remoteFolders?: string[];
}

export interface ProgressCounts {
  pending: number;
  sending: number;
  receiving: number;
}

export interface SyncProgress extends ProgressCounts {
  folder: string;
}

export interface StatusPayload {
  deviceId: string;
  folders: SharedFolderConfig[];
  entries: number;
  tombstones: number;
  devices: DeviceStatus[];
  syncProgress: SyncProgress[];
  /** 对方推送过来的待确认项(配对 / 目录共享),供 Web UI 弹「待确认」。 */
  offers: PendingOffer[];
}

export function buildStatus(
  identity: DeviceIdentity,
  config: Config,
  stats: IndexStats,
  devices: DeviceStatus[] = [],
  syncProgress: SyncProgress[] = [],
  offers: PendingOffer[] = [],
): StatusPayload {
  return {
    deviceId: identity.deviceId,
    folders: config.sharedFolders,
    entries: stats.entries,
    tombstones: stats.tombstones,
    devices,
    syncProgress,
    offers,
  };
}