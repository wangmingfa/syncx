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
  /** 对端宣告的「仍待确认的、来自本机的目录邀请 id 集合」(folder-sync-list)。
   *  UI 据此把「在线但清单里没有本目录」细分为 待对方确认 / 已停止共享。 */
  remotePendingFolders?: string[];
}

export interface ProgressCounts {
  pending: number;
  sending: number;
  receiving: number;
}

export interface SyncProgress extends ProgressCounts {
  folder: string;
}

/** 某共享目录最近一次同步错误(错误展示到对应目录卡上)。 */
export interface FolderErrorStatus {
  /** 目录 id(folderIdFor 口径)。 */
  folder: string;
  /** 错误信息(用户可读)。 */
  message: string;
  /** 发生时间(毫秒时间戳)。 */
  ts: number;
}

export interface StatusPayload {
  deviceId: string;
  folders: SharedFolderConfig[];
  entries: number;
  tombstones: number;
  devices: DeviceStatus[];
  syncProgress: SyncProgress[];
  /** 各共享目录最近一次同步错误(无错误时为空数组)。 */
  folderErrors: FolderErrorStatus[];
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
  folderErrors: FolderErrorStatus[] = [],
): StatusPayload {
  return {
    deviceId: identity.deviceId,
    folders: config.sharedFolders,
    entries: stats.entries,
    tombstones: stats.tombstones,
    devices,
    syncProgress,
    offers,
    folderErrors,
  };
}