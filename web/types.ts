/** Web UI 共享类型:status 载荷与各弹窗组件的 Props 形状。 */

/** 单个正在传输的文件(文件级进度);bytesTotal 为 0 时表示大小未知。 */
export interface TransferFile {
  path: string;
  /** 'receive' = 本机正从对端拉取;'send' = 本机正供块给对端。 */
  direction: 'send' | 'receive';
  bytesDone: number;
  bytesTotal: number;
}

export interface SyncProgressItem {
  folder: string;
  pending: number;
  sending: number;
  receiving: number;
  /** 瞬时发送速率(字节/秒,滚动窗口平均);窗口内没有发送字节时缺省。 */
  sendRate?: number;
  /** 瞬时接收速率(字节/秒,滚动窗口平均);窗口内没有接收字节时缺省。 */
  receiveRate?: number;
  /** 文件级进度(可选):每个正在传输的文件一条。 */
  files?: TransferFile[];
}

export interface FolderInfo {
  id?: string;
  path: string;
  devices: string[];
  /** 是否遵循 .gitignore 忽略规则;后端缺省 true(未显式关闭都视为开启)。 */
  useGitignore?: boolean;
  /** 接收模式(只拉不推):本机只从对端拉取变更、应用对端删除,绝不把本地变更反灌对端。 */
  receiveOnly?: boolean;
  /** 该目录是否暂停同步:数据面停摆(不扫描/不广播/不接收),连接与配对照常。 */
  paused?: boolean;
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
  /** daemon 所在平台(process.platform)。用于按平台给出「本机目录」路径示例;
   *  undefined = 后端为旧版本未提供,退回 POSIX 示例。 */
  platform?: string;
  entries: number;
  tombstones: number;
  folders: FolderInfo[];
  /** 全局暂停同步:为 true 时所有目录的数据面停摆(各目录自己的 paused 独立生效)。 */
  paused?: boolean;
  devices: DeviceInfo[];
  syncProgress: SyncProgressItem[];
  offers: OfferInfo[];
  folderErrors?: FolderErrorItem[];
  /** npm 检查到的可用更新(打包态且发现更高版本时才有值)。 */
  updateAvailable?: { latest: string; current: string } | null;
  /** 最近的中转活动(ADR-0014):本机把来源设备的目录变更转发给其他对端时记录。无中转则缺省。 */
  relayActivity?: RelayActivity[];
}

/** 一次中转活动(与后端 RelayActivity 同形):本机作为枢纽,把 from 的变更中转给 to。 */
export interface RelayActivity {
  /** 发生中转的目录 id。 */
  folder: string;
  /** 变更的原始来源设备 id。 */
  from: string;
  /** 中转目标设备 id。 */
  to: string;
  /** 发生时刻(毫秒时间戳)。 */
  at: number;
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

/** 双栏对比:一侧的一条索引条目(与后端 SnapshotEntry 同形)。 */
export interface CompareEntry {
  path: string;
  version: Array<[string, number]>;
  size: number;
  deleted: boolean;
  /** 内容摘要;墓碑为空串。 */
  digest: string;
  mtime?: number;
}

/** GET /api/folders/compare 的响应:两侧条目清单 + 既有差异分类。 */
export interface FolderCompareData {
  folderId: string;
  folderPath: string;
  deviceId: string;
  deviceVersion?: string;
  deviceHostname?: string;
  deviceUrl?: string;
  localHostname: string;
  localAddresses: string[];
  remoteAt: number;
  local: CompareEntry[];
  remote: CompareEntry[];
  diff: {
    items: FolderDiffItem[];
    counts: Record<FolderDiffKind, number>;
    localTotal: number;
    remoteTotal: number;
    remoteRulesKnown: boolean;
  };
  localProgress?: { pending: number; sending: number; receiving: number };
  remoteProgress?: { pending: number; sending: number; receiving: number };
}

/** 文件内容对比:某一侧的状态。 */
export interface FileSideData {
  exists: boolean;
  /** 文本内容;二进制 / 过大 / 取不到时为 undefined。 */
  text?: string;
  size?: number;
  binary?: boolean;
  /**
   * 图片预览:该侧是可解码的图片且未超上限时给出(data 为 base64,mime 由后端按后缀判定)。
   * 与 text 不互斥 —— `.svg` 两者都有,弹窗据此给出「预览 / 逐行」切换。
   */
  image?: { mime: string; data: string };
  /** 超过体积上限:只给大小不回传内容。 */
  tooLarge?: boolean;
  version?: Array<[string, number]>;
  /** 取不到内容的原因(对端离线 / 未共享 / 不存在)。 */
  error?: string;
}

/** GET /api/folders/file 的响应:同一个文件在本机与对端的两侧状态。 */
export interface FileCompareData {
  folderId: string;
  folderPath: string;
  deviceId: string;
  path: string;
  local: FileSideData;
  remote: FileSideData;
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
