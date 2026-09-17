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
  /** 接收模式(只拉不推):本机只从对端拉取变更、应用对端删除,绝不把本地变更反灌对端。 */
  receiveOnly?: boolean;
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

/** 上传安装包的服务端只读预检结果(不改动任何状态,仅用于确认前展示)。 */
export interface UploadPackageInfo {
  /** 包内 package.json 的版本号 —— 即安装后将要运行的版本。 */
  version: string;
  /** 包名(应为 @wangmingfa/syncx / syncx)。 */
  name: string;
  /** 本机当前运行版本,用于对比展示。 */
  current: string;
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

/** 内容对比:单侧状态(版本向量保持 wire 形态)。 */
export interface FolderDiffSide {
  version: Array<[string, number]>;
  size: number;
  deleted: boolean;
  digest: string;
  mtime?: number;
}

/** 内容对比的分类(与后端 diff.ts 的 DiffKind 一一对应)。 */
export type FolderDiffKind =
  | 'content-mismatch'
  | 'conflict'
  | 'local-newer'
  | 'remote-newer'
  | 'ignored-locally'
  | 'ignored-remotely'
  | 'in-sync';

export interface FolderDiffItem {
  path: string;
  kind: FolderDiffKind;
  local?: FolderDiffSide;
  remote?: FolderDiffSide;
  /** 命中的忽略规则原文(ignored-* 才有)。 */
  rule?: string;
  /** 命中硬忽略名单(不可解除)。 */
  hard?: boolean;
  /** 本机盘上复核:missing / size-differs 说明索引陈旧,不是两端不同步。 */
  disk?: 'ok' | 'missing' | 'size-differs';
}

/** GET /api/folders/diff 的响应(与后端 FolderDiffResult 同形)。 */
export interface FolderDiffData {
  folderId: string;
  folderPath: string;
  deviceId: string;
  deviceVersion?: string;
  /** 对端快照的收齐时刻(毫秒)。 */
  remoteAt: number;
  diff: {
    items: FolderDiffItem[];
    counts: Record<FolderDiffKind, number>;
    localTotal: number;
    remoteTotal: number;
    /** 对端是否提供了忽略规则;false = 旧版本对端,「规则使然」无法区分。 */
    remoteRulesKnown: boolean;
  };
  localProgress?: { pending: number; sending: number; receiving: number };
  remoteProgress?: { pending: number; sending: number; receiving: number };
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
  /** 可选勾选项(如「同时删除索引库」);勾选状态随 action 的 checked 参数回传。 */
  checkbox?: { label: string; checked: boolean };
  confirmText: string;
  /** checked = 用户勾选项的最终状态(无 checkbox 时为 false)。 */
  action: (checked: boolean) => Promise<void>;
}
