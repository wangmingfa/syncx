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
  /** 同步时段(HH:MM-HH:MM,支持跨午夜):仅该时段内同步;空/缺省 = 全天。 */
  schedule?: string;
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
  /** 错误分类:identity-changed / identity-remounted / identity-missing = 目录身份校验失败。 */
  kind?: string;
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
  /** 每目录残留冲突副本数(键 = 目录 id ?? path);缺省/空 = 都没有冲突。 */
  conflictCounts?: Record<string, number>;
  /** 传输统计:累计字节 + 最近 24h 逐 5 分钟采样(daemon 重启清零);旧后端缺省。 */
  traffic?: TrafficData;
  /** daemon 所在机器的操作系统主机名(顶栏本机 chip);旧后端缺省。 */
  hostname?: string;
  /** daemon 所在机器的局域网 IPv4 列表(顶栏本机 chip;多网卡则多条)。 */
  localAddresses?: string[];
  /** 全局同步设置当前值(设置弹窗预填;旧后端缺省)。 */
  settings?: GlobalSettingsData;
}

/** 全局同步设置(与后端 config 顶层字段同形;undefined = 未配置,走默认)。 */
export interface GlobalSettingsData {
  /** 发送带宽上限 KB/s(目录未配置时的兜底);undefined = 不限速。 */
  maxSendKbps?: number;
  /** 每路径版本份数;undefined = 默认 10。 */
  versionsPerPath?: number;
  /** 每目录同步记录保留条数;undefined = 默认 2000。 */
  historyMaxEvents?: number;
}

/** 一个采样窗口的流量增量。 */
export interface TrafficSampleItem {
  /** 窗口结束时刻(毫秒时间戳)。 */
  at: number;
  sent: number;
  received: number;
}

/** 传输统计载荷(与 src/status.ts 的 TrafficStats 同形)。 */
export interface TrafficData {
  sent: number;
  received: number;
  samples: TrafficSampleItem[];
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
  /** 所属目录的共享路径(仅全局时间线 /api/history 补;单目录查询无此字段)。 */
  folderPath?: string;
}

/**
 * GET /api/folders/history 的响应:当前筛选下窗口内的事件 + 统计口径。
 * 「共 N 条 / 最早记录 / 加载更多」都取自这里的 total/matched/oldestTs/maxRetention,
 * 前端不再靠"加载到的条数"去猜(默认只拉 200 条时,事件数组撑死 200,窗口全貌看不见)。
 */
export interface SyncHistoryData {
  events: SyncEventItem[];
  /** 保留窗口内的全部记录条数(筛选前)。 */
  total: number;
  /** 命中当前筛选条件的条数(截断前);> events.length 时出现「加载更多」。 */
  matched: number;
  /** 保留窗口内最早一条记录的时间戳;无记录为 null。 */
  oldestTs: number | null;
  /** 后端保留上限(= HISTORY_MAX_EVENTS),提示文案用它,不硬编码。 */
  maxRetention: number;
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

/**
 * GET /api/folders/diff 的响应(目录级差异弹窗 useFolderDiff/FolderDiffModal 用)。
 * 与 compare 载荷同形;Mac 端功能先行落地,若其 types.ts 原版稍后同步过来有出入,以并集校准。
 */
export type FolderDiffData = FolderCompareData;

/**
 * 通用差异弹窗「一侧」的配置。FileDiffModal 已抽象为纯展示引擎 ——
 * 「两侧是什么、能做什么」全由调用方(对比页 / 冲突收件箱)定义,组件不再内置
 * 本机/对端语义。role 是组句用的角色短名(如「用{role}覆盖…」),缺省取 label。
 */
export interface DiffPaneData {
  /** 列名:出现在图例与表头(本机 / 对端 / 原文件 / 冲突副本 …)。 */
  label: string;
  /** 组句角色名(降级说明、按钮 tooltip 里的短称);缺省 = label。 */
  role?: string;
  /** 列名后的补充说明(目录路径 / 设备 ID / 「本机旧版」注记),可选。 */
  note?: string;
  side: FileSideData;
}

/** 弹窗据两侧实况算出的动作可用性上下文,传给 footerActions 的判定函数。 */
export interface DiffActionCtx {
  /** 两侧内容是否真的逐字节一致(文本原文比/图片字节比,降级态恒 false)。 */
  identical: boolean;
  leftExists: boolean;
  rightExists: boolean;
}

/** 通用差异弹窗的 footer 动作:组件只负责渲染、禁用、二次确认条,语义由调用方解释。 */
export interface DiffFooterAction {
  id: string;
  label: string;
  tone?: 'default' | 'primary' | 'error';
  disabled?: (ctx: DiffActionCtx) => boolean;
  /** tooltip:禁用讲「为什么不能点」,可用讲「这一下做什么」。与 disabled 同源计算。 */
  hint?: (ctx: DiffActionCtx) => string;
  /** 给了就先进入内联二次确认(文案由调用方写全),确认后才 emit('action', id)。 */
  confirm?: string;
}

/** 逐块应用按钮配置:哪个方向出按钮、tooltip 写什么;省略 = 该方向无按钮。 */
export interface DiffHunkApply {
  /** 把「右」块应用到「左」侧(← 按钮)的 tooltip;undefined 不出按钮。 */
  toLeft?: string;
  /** 把「左」块应用到「右」侧(→ 按钮)的 tooltip。 */
  toRight?: string;
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
