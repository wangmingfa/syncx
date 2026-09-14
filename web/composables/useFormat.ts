import { type Ref } from 'vue';
import type { DeviceInfo, FolderErrorItem, FolderInfo, StatusData, SyncProgressItem } from '../types';
import type { DeviceTagStatus } from './statusContext';
import { folderKey } from '../utils/format';

/**
 * 依赖 status 的展示函数(其余纯函数见 web/utils/format.ts)。
 * 用闭包持有 status ref,子组件 inject 上下文后随 status 刷新自动更新。
 */
export function useFormat(status: Ref<StatusData>) {
  /** 某设备被指派到的目录数量。 */
  function deviceFolderCount(deviceId: string): number {
    return status.value.folders.filter((f) => f.devices.includes(deviceId)).length;
  }

  /** 该目录的同步进度(按 folderId 匹配)。 */
  function progressOf(f: { id?: string; path: string }): SyncProgressItem | undefined {
    const key = folderKey(f);
    return status.value.syncProgress.find((p) => p.folder === key);
  }

  /** 该目录最近一次同步错误(目录卡上的红色横幅;下一轮扫描干净后自动消失)。 */
  function folderErrorOf(f: { id?: string; path: string }): FolderErrorItem | undefined {
    const key = folderKey(f);
    return status.value.folderErrors?.find((e) => e.folder === key);
  }

  /**
   * 依据设备在线状态与其宣告的目录清单(folder-sync-list)判定标签状态:
   * - 离线:设备连接断开;
   * - 待对方确认:设备在线,其宣告的清单里没有本目录,但它的待确认项里有本目录(共享邀请已送达、尚未确认);
   * - 已停止:设备在线,清单里没有本目录且无待确认(旧版本对端无清单,退化为「同步中」);
   * - 同步中:设备在线且清单包含本目录。
   */
  function deviceTagStatus(f: FolderInfo, deviceId: string): { key: DeviceTagStatus; label: string } {
    const dev = status.value.devices.find((x) => x.deviceId === deviceId);
    if (!dev?.online) return { key: 'offline', label: '离线' };
    const fid = f.id ?? f.path;
    if (dev.remoteFolders === undefined) return { key: 'syncing', label: '同步中' };
    if (dev.remoteFolders.includes(fid)) return { key: 'syncing', label: '同步中' };
    return (dev.remotePendingFolders ?? []).includes(fid)
      ? { key: 'pending', label: '待对方确认' }
      : { key: 'stopped', label: '对方已停止共享' };
  }

  /** 悬停设备标签时的 tooltip 文案:一句话说清当前状态与接下来会发生什么。 */
  function deviceTagTip(f: FolderInfo, deviceId: string): string {
    const s = deviceTagStatus(f, deviceId);
    switch (s.key) {
      case 'syncing':
        return '同步中:对方已接受共享且在线,变更会双向同步';
      case 'pending':
        return '待对方确认:共享邀请已送达,对方确认后开始同步';
      case 'stopped':
        return '对方未共享此目录:可能拒绝了邀请或已停止共享';
      case 'offline':
        return '设备离线:对方上线后会自动继续同步';
    }
  }

  return { deviceFolderCount, progressOf, folderErrorOf, deviceTagStatus, deviceTagTip };
}
