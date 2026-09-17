import { inject } from 'vue';
import type { InjectionKey, Ref, ComputedRef } from 'vue';
import type {
  ConfirmState,
  DeviceInfo,
  FolderErrorItem,
  FolderInfo,
  OfferInfo,
  StatusData,
  SyncProgressItem,
  UploadPackageInfo,
} from '../types';
import type { ToastKind } from './useToast';
import type { FolderDiffApi } from './useFolderDiff';

/** 目录卡设备标签的四态:同步中 / 待对方确认 / 对方已停止共享 / 设备离线。 */
export type DeviceTagStatus = 'syncing' | 'pending' | 'stopped' | 'offline';

/**
 * StatusPage 向子组件注入的共享上下文。子组件通过 useStatusContext() 取用,
 * 无需层层 props 透传。status 与各 action(刷新/确认/业务操作)共享同一实例。
 *
 * 内容对比那一组(diffOpen / diffData / openDiff …)直接继承 useFolderDiff 的返回类型,
 * 免得同一份形状在两处各写一遍、改一处忘一处。
 */
export interface StatusContext extends FolderDiffApi {
  // 核心
  status: Ref<StatusData>;
  busy: Ref<boolean>;
  isDev: boolean;
  controlPort: string;
  refreshStatus: () => Promise<void>;
  post: (action: string, body?: Record<string, string>) => Promise<void>;
  showToast: (msg: string, kind?: ToastKind) => void;
  askConfirm: (state: ConfirmState) => void;

  // 设备
  rescan: () => void;
  reconnect: (deviceId: string) => void;
  addDeviceOpen: Ref<boolean>;
  toggleAddDevice: () => void;
  addDevice: () => Promise<void>;
  newDeviceId: Ref<string>;
  newDeviceHost: Ref<string>;
  newDevicePort: Ref<string>;
  askRemoveDevice: (deviceId: string) => void;
  askUpgrade: (p: DeviceInfo) => void;
  hoverDevices: Ref<string[]>;

  // 文件夹
  addFolderOpen: Ref<boolean>;
  toggleAddFolder: () => void;
  addFolder: () => Promise<void>;
  newPath: Ref<string>;
  newFolderId: Ref<string>;
  newFolderDevices: Ref<string[]>;
  newFolderReceiveOnly: Ref<boolean>;
  askRemoveFolder: (path: string) => void;
  openEditDevices: (f: FolderInfo) => void;
  openHistory: (f: FolderInfo) => void;
  copy: (text: string) => Promise<void>;
  hoverFolderKey: Ref<string>;
  onFolderEnter: (f: { id?: string; path: string; devices: string[] }) => void;
  onFolderLeave: () => void;

  // 邀请
  offerPaths: Record<string, string>;
  offerReceiveOnly: Record<string, boolean>;
  reusedFolderPath: (offer: OfferInfo) => string | undefined;
  acceptOffer: (offer: OfferInfo) => Promise<void>;
  declineOffer: (offer: OfferInfo) => Promise<void>;
  restoreOffer: (offer: OfferInfo) => Promise<void>;
  pendingOffers: ComputedRef<OfferInfo[]>;
  declinedOffers: ComputedRef<OfferInfo[]>;
  declinedOpen: Ref<boolean>;

  // 自更新 / 鉴权
  upgrading: Ref<boolean>;
  askSelfUpdate: (u: { latest: string; current: string }) => void;
  checkForUpdate: () => Promise<void>;
  /** 上传本地安装包升级:弹窗由 StatusPage 挂载,入口在顶栏与页面级拖入。 */
  uploadOpen: Ref<boolean>;
  openUpload: () => void;
  closeUpload: () => void;
  /** 选包与预检状态:页面级拖入(DropOverlay)与弹窗内点选共用同一份。 */
  uploadFile: Ref<File | null>;
  uploadInfo: Ref<UploadPackageInfo | null>;
  uploadInspecting: Ref<boolean>;
  uploadError: Ref<string>;
  selectUploadFile: (file: File) => Promise<void>;
  resetUpload: () => void;
  applyUpload: (file: File) => Promise<void>;
  authOpen: Ref<boolean>;
  logout: () => Promise<void>;

  // 展示工具(纯函数 + 依赖 status)
  folderKey: (f: { id?: string; path: string }) => string;
  monogram: (id: string) => string;
  fmtTime: (ts: number) => string;
  stripWs: (url: string) => string;
  progressPercent: (p: SyncProgressItem) => number;
  isActive: (p: SyncProgressItem) => boolean;
  progressText: (p: SyncProgressItem) => string;
  deviceAddrLine: (p: DeviceInfo) => string;
  deviceFolderCount: (deviceId: string) => number;
  progressOf: (f: { id?: string; path: string }) => SyncProgressItem | undefined;
  folderErrorOf: (f: { id?: string; path: string }) => FolderErrorItem | undefined;
  deviceTagStatus: (f: FolderInfo, deviceId: string) => { key: DeviceTagStatus; label: string };
  deviceTagTip: (f: FolderInfo, deviceId: string) => string;

  // 模态开关(本页 overlay 渲染用)
  showGuide: Ref<boolean>;
  logsOpen: Ref<boolean>;
  openGuide: () => void;
  openLogs: () => void;
  openAuth: () => void;
}

/** 各业务 composable 共享的核心依赖,由 StatusPage 注入后下传。 */
export interface CoreDeps {
  status: Ref<StatusData>;
  busy: Ref<boolean>;
  refreshStatus: () => Promise<void>;
  post: (action: string, body?: Record<string, string>) => Promise<void>;
  askConfirm: (state: ConfirmState) => void;
}

export const StatusContextKey: InjectionKey<StatusContext> = Symbol('status-context');

/** 子组件取用共享上下文;必须在 StatusPage 内(或其子树)调用。 */
export function useStatusContext(): StatusContext {
  const ctx = inject(StatusContextKey);
  if (!ctx) throw new Error('useStatusContext 必须在 StatusPage 子树内使用');
  return ctx;
}
