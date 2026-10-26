/** Web UI 共享类型:status 载荷与各弹窗组件的 Props 形状。 */

/** 单个正在传输的文件(文件级进度);bytesTotal 为 0 时表示大小未知。 */
export interface TransferFile {
  path: string;
  /** 'receive' = 本机正从对端拉取;'send' = 本机正供块给对端。 */
  direction: 'send' | 'receive';
  bytesDone: number;
  bytesTotal: number;
  /** 已被「优先同步」点名插队(仅接收方向);缺省 = 未提队。 */
  priority?: boolean;
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
  /** 同步时段:规则列表(见 src/schedule.ts),规则间满足任一即可;空/缺省 = 全天。
   *  与全局时段取**交集**(全局是硬闸门,目录只能在其内再收窄)。 */
  schedule?: Schedule;
  /** 该目录此刻的时段结论(后端算好下发;前端只渲染,不再自己判定)。 */
  scheduleState?: ScheduleState;
  /** git 提交同步模式;缺省 = 'off'(未启用)。仅当目录本身是 git 仓库时才有实际作用。 */
  gitSync?: GitSyncMode;
  /** 该目录当前是否为 git 仓库(daemon 每轮状态实时探测,与同步闸门同口径);
   *  缺省 = 旧后端未提供,前端不展示「不会生效」警告。 */
  gitRepo?: boolean;
  /** 冲突自动处理策略;缺省 = 'keep-both'(保留双方:拉回对端 + 本地留冲突副本)。 */
  conflictPolicy?: ConflictPolicy;
  /** 按需同步(稀疏文件):对端非空文件先只记占位不落盘,点「下载」才拉。缺省 = 关闭。 */
  onDemand?: boolean;
  /** 选择性同步:这些子目录前缀下的对端新文件按占位接收(与 onDemand 是「或」关系)。 */
  onDemandDirs?: string[];
  /** 该目录是否已设置端到端口令(密钥本体绝不出 daemon,状态只回显此标志)。 */
  e2eKeySet?: boolean;
  /** 被标记为「不可信」的设备 id 列表:对这些设备只发密文视图,永不回源明文。 */
  e2eUntrusted?: string[];
}

/** 与后端 SharedFolderConfig.gitSync 取值保持一致。 */
export type GitSyncMode = 'off' | 'send' | 'receive' | 'full';

/** 与后端 SharedFolderConfig.conflictPolicy 取值保持一致。 */
export type ConflictPolicy = 'keep-both' | 'newest-wins' | 'local-wins';

export interface DeviceInfo {
  deviceId: string;
  online: boolean;
  url?: string;
  /** 对端主机名(hello 宣告);undefined=旧版本对端未发,不展示。 */
  hostname?: string;
  /** 对端运行平台(hello 宣告的 process.platform);undefined=旧版本对端未发,头像退回字母。 */
  platform?: string;
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
  /** 身份校验失败时的指纹对照(记录值 vs 当前值),渲染高亮对照行;missing 时只有 recorded。 */
  identityChange?: { recorded?: { dev: string; ino: string }; current?: { dev: string; ino: string } };
}

/** 日期条件(与 src/schedule.ts 的 DayPredicate 一致)。 */
export type DayPredicate =
  | { kind: 'any' }
  | { kind: 'workday' }
  | { kind: 'offday' }
  | { kind: 'dow'; days: number[] };

/** 时间窗口,单位「当天第几分钟」;from > to 表示跨午夜,from === to 视为不设限。 */
export interface ScheduleWindow {
  from: number;
  to: number;
}

/** 一条规则 = 日期条件 且 若干窗口;规则之间「满足任一即可」。 */
export interface ScheduleRule {
  days: DayPredicate;
  windows: ScheduleWindow[];
}

export type Schedule = ScheduleRule[];

/** 单个目录此刻的时段结论(后端算好下发)。 */
export interface ScheduleState {
  inside: boolean;
  overridden?: boolean;
  blockedBy?: 'global' | 'folder';
  nextChangeAt?: number;
  summary?: string;
}

/** 顶部横幅状态:是否该提示「当前不在同步时段」+ 何时恢复。 */
export interface ScheduleBanner {
  visible: boolean;
  blockedBySchedule: number;
  total: number;
  nextChangeAt?: number;
  overrideUntil?: number;
}

/** 节假日日历健康状况。 */
export interface CalendarStatus {
  year: number;
  fetched: boolean;
  fetchedAt?: number;
  overrideCount: number;
  lastError?: string;
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
  /** 每目录工作区未提交变更条数(键 = 目录 id ?? path;目录卡「Git 改动 N」徽标);缺省 = 旧后端。 */
  gitChangeCounts?: Record<string, number>;
  /** 每目录尚未推送到上游的提交数(键 = 目录 id ?? path;目录卡「未推送 N」徽标);
   *  未设置上游的目录不入表;缺省 = 旧后端。 */
  gitUnpushedCounts?: Record<string, number>;
  /** 传输统计:累计字节 + 最近 24h 逐 5 分钟采样(daemon 重启清零);旧后端缺省。 */
  traffic?: TrafficData;
  /** daemon 所在机器的操作系统主机名(顶栏本机 chip);旧后端缺省。 */
  hostname?: string;
  /** daemon 所在机器的局域网 IPv4 列表(顶栏本机 chip;多网卡则多条)。 */
  localAddresses?: string[];
  /** 数据目录(--config-dir / --config 解析结果;旧后端缺省)。
   *  路径提示(control.token、--log-file 示例)据此动态生成,不写死 ~/.syncx。 */
  configDir?: string;
  /** 全局同步设置当前值(设置弹窗预填;旧后端缺省)。 */
  settings?: GlobalSettingsData;
  /** 电源守卫挂起原因(计费网络/低电量;非空时所有目录数据面被自动挂起;旧后端缺省 = null)。 */
  powerGuard?: string | null;
  /** 是否在网(无非回环可用接口 = 离线;无网时重连退避拉长、mDNS 暂停;旧后端缺省 = 在线)。 */
  networkOnline?: boolean;
  /** 每目录此刻的时段结论(key = folderId ?? path;旧后端缺省)。 */
  scheduleStates?: Record<string, ScheduleState>;
  /** 顶部横幅:此刻是否该提示「因时段而不同步」。 */
  scheduleBanner?: ScheduleBanner;
  /** 节假日日历健康状况(设置页与横幅文案用)。 */
  calendarStatus?: CalendarStatus;
  /** 局域网内 mDNS 发现、但尚未配对的设备(设备栏「附近发现的设备」;旧后端缺省)。 */
  discovered?: DiscoveredDevice[];
}

/** 局域网内发现、尚未配对的设备(一键添加后升格为设备卡)。 */
export interface DiscoveredDevice {
  deviceId: string;
  /** 对端机器的 mDNS 主机名。 */
  host: string;
  /** 对端数据面(ws)端口。 */
  port: number;
  /** 收到该设备 mDNS 包的源 IP(它此刻实际 reachable 的地址);旧后端缺省。 */
  address?: string;
  /** 最近一次被发现的时刻(毫秒)。 */
  lastSeen: number;
}

/** GET /api/paircode 的响应:本机配对信息(配对二维码用)。 */
export interface PairCodeData {
  deviceId: string;
  /** 数据面(ws)端口;后端未就绪时不会返回(503)。 */
  port: number;
  /** 本机局域网 IPv4 地址列表。 */
  addresses: string[];
}

/** 文件管理器的单条目录项(GET /api/folder-files)。 */
export interface FolderDirEntry {
  /** 相对共享目录根的路径(POSIX 分隔),列表/下载/删除统一寻址。 */
  path: string;
  name: string;
  dir: boolean;
  /** 字节数(目录恒为 0)。 */
  size: number;
  /** 修改时间(毫秒)。 */
  mtime: number;
  /** true = 按需同步的占位文件(盘上无实体,「未下载」):只能拉取,不能直接打开。 */
  placeholder?: boolean;
  /** true = 该文件已「单文件暂停」(双向冻结):UI 提供「继续同步」而非暂停。 */
  paused?: boolean;
  /** true = 该目录已「选择性同步」(子目录按需):新到文件只记占位,UI 提供「恢复同步」。 */
  onDemandDir?: boolean;
}

/** 回收站的一条删除副本(GET /api/trash):由文件名反解,不落额外元数据。 */
export interface TrashEntry {
  /** 回收站内相对文件名(含目录层级);还原/彻底删除按此寻址。 */
  file: string;
  /** 还原回共享目录的相对路径(原路径,'/' 分隔)。 */
  path: string;
  /** 删除时刻(毫秒,从文件名反解)。 */
  ts: number;
  /** 副本字节数;stat 失败为 0。 */
  size: number;
}

/** GET /api/trash 的响应。 */
export interface TrashListing {
  entries: TrashEntry[];
}

/** GET /api/folder-files 的响应。 */
export interface FolderDirListing {
  entries: FolderDirEntry[];
  /** 条目数超上限被截断时为 true。 */
  truncated: boolean;
}

/** 全局同步设置(与后端 config 顶层字段同形;undefined = 未配置,走默认)。 */
export interface GlobalSettingsData {
  /** 发送带宽上限 KB/s(目录未配置时的兜底);undefined = 不限速。 */
  maxSendKbps?: number;
  /** 每路径版本份数;undefined = 默认 10。 */
  versionsPerPath?: number;
  /** 每目录同步记录保留条数;undefined = 默认 2000。 */
  historyMaxEvents?: number;
  /** 同步事件 Webhook 地址;undefined = 未配置(关闭通知)。 */
  webhookUrl?: string;
  /** 是否已设置 Webhook 签名密钥(密钥本身不回传)。 */
  webhookSecretSet?: boolean;
  /** 计费网络自动挂起(仅 Windows 探测启用)。 */
  pauseOnMeteredNetwork?: boolean;
  /** 低电量自动挂起(仅 Windows 探测启用)。 */
  pauseOnLowBattery?: boolean;
  /** 低电量挂起阈值(%);undefined = 默认 20。 */
  batteryPauseThreshold?: number;
  /** 分享链接总开关(默认关;开才允许创建免登录限时下载链接)。 */
  shareEnabled?: boolean;
  /** 全局同步时段(硬闸门,与目录时段取交集);undefined = 全天。 */
  syncSchedule?: Schedule;
  /** 临时放行到期时刻(ms);undefined = 未放行。 */
  scheduleOverrideUntil?: number;
  /** 节假日自动拉取是否开启(undefined = 开)。 */
  holidayAutoFetch?: boolean;
  /** 当前生效的节假日源地址(含 {year} 占位)。 */
  holidaySourceUrl?: string;
  /** 默认节假日源地址(「恢复默认」用)。 */
  holidaySourceDefault?: string;
  /** 手动日历覆盖(日期 → workday/holiday)。 */
  calendarOverrides?: Record<string, 'workday' | 'holiday'>;
}

/** GET /api/report/weekly 的响应(与后端 report.ts WeeklyReport 同形)。 */
export interface WeeklyReportData {
  fromTs: number;
  toTs: number;
  /** 近 7 天逐日计数,旧→新,恒 7 项。 */
  days: Array<{ day: string; add: number; update: number; delete: number; conflict: number }>;
  totals: { add: number; update: number; delete: number; conflict: number; total: number };
  /** 各目录汇总,按 total 降序。 */
  folders: Array<{ id: string; path: string; add: number; update: number; delete: number; conflict: number; total: number }>;
  activeDevices: Array<{ deviceId: string; count: number }>;
  /** 窗口内冲突明细(最新在前,后端封顶 50 条)。 */
  conflicts: Array<{ ts: number; folderPath: string; path: string; deviceId?: string }>;
  /** 保留上限可能截断过窗口内数据时为 true(展示口径提示)。 */
  truncated: boolean;
}

/** 一个采样窗口的流量增量。 */export interface TrafficSampleItem {
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
  /**
   * 本次同步耗时(毫秒)。**缺省 = 这条记录没有"传输起止"可测**(本机扫描出的改动、
   * 或本次改动之前写入的旧记录),不是"耗时为 0"。两者必须分开渲染,否则旧记录会
   * 整片显示成"小于1秒"。
   */
  durationMs?: number;
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

/** 工作区一条未提交变更(与 src/git-monitor.ts 的 GitChangeEntry 同形)。 */
export interface GitChangeEntry {
  /** 相对仓库根的路径(POSIX 分隔);git 折叠的未跟踪目录已去尾斜杠,见 dir。 */
  path: string;
  /** true = git 把整棵未跟踪目录折叠成的这一条记录:没有单文件可对比,不做双击。 */
  dir?: boolean;
  status: 'modified' | 'added' | 'deleted' | 'renamed';
  /** renamed 的原路径。 */
  origPath?: string;
  /** 已进暂存区。 */
  staged?: boolean;
}

/** GET /api/folders/git-changes 的响应;非 git 仓库时只有 gitRepo: false。 */
export interface GitChangesData {
  entries: GitChangeEntry[];
  /** 条目数超上限被截断时为 true。 */
  truncated: boolean;
  /** false = 目录不是 git 仓库(弹窗给出解释而不是空列表)。 */
  gitRepo?: boolean;
}

/** GET /api/folders/git-diff 的响应:HEAD 版 vs 工作区当前,复用通用差异弹窗的侧形状。 */
export interface GitDiffData {
  path: string;
  head: FileSideData;
  worktree: FileSideData;
}

/** 提交历史一条记录(与 src/git-monitor.ts 的 GitCommitEntry 同形)。 */
export interface GitCommitEntry {
  /** 短哈希。 */
  hash: string;
  /** 提交消息首行。 */
  subject: string;
  /** 提交消息正文(不含首行);空串 = 没有正文。 */
  body: string;
  author: string;
  /** 作者时间,ISO 8601 原样(前端本地化展示)。 */
  date: string;
  /** 引用装饰原样串(如 `HEAD -> main, tag: v1.0`);无引用为空串。 */
  refs: string;
}

/** GET /api/folders/git-log 的响应;非 git 仓库时 gitRepo: false。 */
export interface GitLogData {
  commits: GitCommitEntry[];
  /** false = 目录不是 git 仓库(弹窗给出解释而不是空列表)。 */
  gitRepo?: boolean;
}

/** 提交展开里的一行:该笔提交动了哪个文件、怎么动的(与 src/git-monitor.ts 同形)。 */
export interface GitCommitFileEntry {
  /** git name-status 状态字母(M/A/D/R/C/T 等),前端翻成 改/增/删/移/复 胶囊。 */
  status: string;
  /** 提交后的路径(改名/复制时为新路径)。 */
  path: string;
  /** 改名/复制时的原路径(status 为 R/C 开头时存在)。 */
  origPath?: string;
}

/** GET /api/folders/git-commit-files 的响应;非 git 仓库时 gitRepo: false。 */
export interface GitCommitFilesData {
  files: GitCommitFileEntry[];
  /** false = 目录不是 git 仓库。 */
  gitRepo?: boolean;
}

/** GET /api/folders/git-commit-diff 的响应:父提交版 vs 该提交版,复用通用差异弹窗的侧形状。 */
export interface GitCommitDiffData {
  path: string;
  parent: FileSideData;
  commit: FileSideData;
}

/** 「Git 推送」弹窗每目录一行(与 src/session-manager.ts 的 UnpushedFolderEntry 同形)。 */
export interface GitUnpushedFolder {
  folderId: string;
  path: string;
  /** 未推送提交总数(列表截断时依然准确)。 */
  total: number;
  /** 新→旧,最多 50 条。 */
  commits: GitCommitEntry[];
  /** 列表被 50 条上限截断(total 超出)。 */
  truncated: boolean;
}

/** GET /api/folders/git-unpushed 的响应:只含此刻有未推送提交的目录。 */
export interface GitUnpushedData {
  folders: GitUnpushedFolder[];
}

/** 残留 index.lock 的现况(与 src/git-monitor.ts 的 GitIndexLockInfo 同形)。 */
export interface GitIndexLockInfo {
  path: string;
  size: number;
  /** 最后修改时刻(ms);文件系统不给时可能是 0。 */
  mtimeMs: number;
}

/** GET /api/folders/git-commit-status 的响应(「自动提交失败」弹窗数据源)。 */
export interface GitAutoCommitStatus {
  /** 还有一笔提交通知等着结算(放弃自动重试后仍保留)。 */
  pending: boolean;
  /** 待结算通知的提交信息首行。 */
  commitMessage?: string;
  changedFiles: string[];
  attempts: number;
  maxAttempts: number;
  /** 下一次自动重试的时刻(ms);缺省 = 没有排定的重试。 */
  retryAt?: number;
  /** 自动重试已放弃,等手动重试或下一条通知。 */
  givenUp: boolean;
  error?: { message: string; ts: number };
  lock: GitIndexLockInfo | null;
}

/** POST /api/folders/git-index-lock/delete 的响应。 */
export interface GitIndexLockDeleteData {
  ok: boolean;
  path?: string;
  /** false = 调用时锁已不存在(目的已达成)。 */
  removed?: boolean;
  error?: string;
}

/** POST /api/folders/git-commit-retry 的响应。 */
export interface GitAutoCommitRetryData {
  ok: boolean;
  hash?: string;
  error?: string;
  attempts: number;
}

/** GET /api/folders/empty-dirs 的响应:盘点到空文件夹清单。 */
export interface EmptyDirsData {
  /** 空目录(相对共享根的 POSIX 路径),字典序。 */
  dirs: string[];
  /** 超出上限被截断时为 true。 */
  truncated: boolean;
}

/** 删除单条空文件夹的结果。 */
export interface EmptyDirDeleteResult {
  path: string;
  ok: boolean;
  /** ok=false 的原因(直接展示给用户)。 */
  reason?: string;
}

/** POST /api/folders/empty-dirs/delete 的响应:逐条结果。 */
export interface EmptyDirsDeleteData {
  results: EmptyDirDeleteResult[];
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
