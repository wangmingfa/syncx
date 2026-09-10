/** Web UI 共享类型:status 载荷与各弹窗组件的 Props 形状。 */

export interface SyncProgressItem {
  folder: string;
  pending: number;
  sending: number;
  receiving: number;
}

export interface FolderInfo {
  id?: string;
  path: string;
  devices: string[];
  /** 是否遵循 .gitignore 忽略规则;后端缺省 true(未显式关闭都视为开启)。 */
  useGitignore?: boolean;
}

export interface DeviceInfo {
  deviceId: string;
  online: boolean;
  url?: string;
  /** 对端主机名(hello 宣告);undefined=旧版本对端未发,不展示。 */
  hostname?: string;
  /** 该设备被指派到的目录 id 列表(用于展示「共享 N 个目录」)。 */
  folders: string[];
  /** 对端宣告的「它与本机在同步的目录 id 集合」;undefined=旧版本对端,无法判断已停止共享。 */
  remoteFolders?: string[];
  /** 对端宣告的仍待确认的、来自本机的目录邀请 id 集合(区分「待对方确认」与「已停止共享」)。 */
  remotePendingFolders?: string[];
  /** 对端运行版本;dev 态为 'dev',undefined=旧版本对端未发 hello。 */
  version?: string;
  /** 本机(打包态)版本低于该对端时为 true,UI 提供「从对方升级」入口。 */
  canUpgrade?: boolean;
}

export interface OfferInfo {
  id: string;
  kind: 'pairing' | 'folder';
  fromDeviceId: string;
  folderId?: string;
  folderName?: string;
  /** 发起方主机名(hello 宣告);undefined=旧版本对端未发或不展示。 */
  fromHostname?: string;
  /** 发起方入站源 IP(本机视角);undefined=无法取到(如本机主动出站收到的邀请)。 */
  fromIp?: string;
  status: 'pending' | 'accepted' | 'declined';
  createdAt: number;
}

export interface FolderErrorItem {
  folder: string;
  message: string;
  ts: number;
}

export interface StatusData {
  deviceId: string;
  /** 本机运行版本;dev 态为 'dev'。 */
  version?: string;
  entries: number;
  tombstones: number;
  folders: FolderInfo[];
  devices: DeviceInfo[];
  syncProgress: SyncProgressItem[];
  offers: OfferInfo[];
  folderErrors?: FolderErrorItem[];
  /** npm 检查到的可用更新(打包态且发现更高版本时才有值)。 */
  updateAvailable?: { latest: string; current: string } | null;
}

/** 一条同步记录(history 弹窗)。 */
export interface SyncEventItem {
  ts: number;
  folderId: string;
  path: string;
  action: 'add' | 'update' | 'delete' | 'conflict';
  direction: 'local' | 'remote';
  deviceId?: string;
}

/** 二次确认弹窗的完整描述(移除目录 / 移除设备 / 升级共用)。 */
export interface ConfirmState {
  title: string;
  message: string;
  /** 被操作对象(目录路径 / 设备 ID),等宽展示便于核对。 */
  detail?: string;
  /** 受影响的共享目录(移除设备时列出);others = 移除后该目录还剩几个设备。 */
  folders?: Array<{ path: string; others: number }>;
  /** 补充提醒(如「对方仍需自行移除一次」)。 */
  note?: string;
  confirmText: string;
  action: () => Promise<void>;
}
