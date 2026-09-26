import { inject } from 'vue';
import type { InjectionKey, Ref, ComputedRef } from 'vue';
import type {
  ConfirmState,
  DeviceInfo,
  DiscoveredDevice,
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
 * 目录级差异弹窗的一整套状态(diffOpen/runDiff/…)经 FolderDiffApi 并入,
 * 由 StatusPage 把 useFolderDiff() 的返回展开进 provide。
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
  /** 一键添加「附近发现的设备」:直接带 mDNS 学到的直连地址配对。 */
  addDiscovered: (d: DiscoveredDevice) => Promise<void>;
  hoverDevices: Ref<string[]>;
  /** 反向拓扑联动:悬停设备卡时该设备 id(非空 = 设备→目录高亮进行中)。 */
  hoverDeviceId: Ref<string>;
  onDeviceEnter: (deviceId: string) => void;
  onDeviceLeave: () => void;

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
  /** 打开全局时间线(跨目录同步记录归并视图;与 openHistory 共用弹窗,互斥打开)。 */
  openGlobalHistory: () => void;
  /** 打开某目录的冲突收件箱(残留 .sync-conflict-* 副本的列表面板)。 */
  openConflicts: (f: FolderInfo) => void;
  /** 非空 = 打开该目录的冲突收件箱(StatusPage 挂 ConflictModal 用)。 */
  conflictsFolder: Ref<FolderInfo | null>;
  /** 打开某目录的文件版本弹窗(拉取与展示在 VersionsModal 内)。 */
  openVersions: (f: FolderInfo) => void;
  /** 打开某目录的忽略规则编辑器(编辑 .syncxignore + 实时测试器,IgnoreModal 内)。 */
  openIgnoreEditor: (f: FolderInfo) => void;
  /** 打开某目录的端到端加密设置弹窗(口令 + 不可信节点勾选,E2EModal 内)。 */
  openE2E: (f: FolderInfo) => void;
  /** 打开某目录的浏览器内文件管理器(独立路由页 /files,新开标签页;浏览/下载仅需登录,删除需提权)。 */
  openFiles: (f: FolderInfo) => void;
  /** 打开某目录的 Web 回收站(独立路由页 /trash,新开标签页;还原/彻底删除在页内过提权门)。 */
  openTrash: (f: FolderInfo) => void;
  copy: (text: string) => Promise<void>;
  hoverFolderKey: Ref<string>;
  onFolderEnter: (f: { id?: string; path: string; devices: string[] }) => void;
  onFolderLeave: () => void;
  /** 暂停/恢复单个目录的同步(目录卡开关);全局开关见 toggleGlobalPaused。 */
  toggleFolderPaused: (f: FolderInfo, paused: boolean) => Promise<void>;
  /** 「目录不可信」横幅上的重新采集身份(仅更新指纹,索引不动)。 */
  reAdoptIdentity: (f: FolderInfo) => Promise<void>;
  /** 「优先同步」:把该目录某个在收文件的块请求插到对端发送队列最前(幂等)。 */
  prioritizeFile: (f: FolderInfo, path: string) => Promise<void>;
  /** 全局暂停/恢复同步:所有目录一起停摆,各目录自己的暂停状态独立保留。 */
  toggleGlobalPaused: (paused: boolean) => Promise<void>;

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
  topoOpen: Ref<boolean>;
  /** 传输统计弹窗开关(顶栏「流量」按钮触发)。 */
  trafficOpen: Ref<boolean>;
  /** 全局设置弹窗开关(顶栏本机 chip 菜单「全局设置」触发)。 */
  settingsOpen: Ref<boolean>;
  openGuide: () => void;
  openLogs: () => void;
  openTopology: () => void;
  openTraffic: () => void;
  openSettings: () => void;
  /** 浏览器内终端(独立全屏页 /terminal):顶栏本机 chip 菜单「终端」触发。 */
  openTerminal: () => void;
  /** 多实例集中管理(独立页 /fleet):顶栏 chip 菜单「多实例」触发。 */
  openFleet: () => void;
  /** 桌面通知:浏览器偏好(localStorage),开关在顶栏铃铛。 */
  notifSupported: boolean;
  notifEnabled: Ref<boolean>;
  toggleNotifications: () => Promise<void>;
  openAuth: () => void;
}

/** 各业务 composable 共享的核心依赖,由 StatusPage 注入后下传。 */
export interface CoreDeps {
  status: Ref<StatusData>;
  busy: Ref<boolean>;
  /** 是否源码 dev 运行态:部分功能(自更新)在 dev 下不可用,需入口处拦截并提示。 */
  isDev: boolean;
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
