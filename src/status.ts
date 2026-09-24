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
  /** 对端经 hello 宣告的主机名(node:os hostname);用于设备卡展示来源主机。
   *  undefined = 对端旧版本未发 hello,UI 不展示主机名。 */
  hostname?: string;
  /** 对端经 hello 宣告的运行平台(process.platform);用于设备卡画操作系统图标。
   *  undefined = 对端旧版本未发,UI 退回字母头像。 */
  platform?: string;
  /** 本机配置里该设备被指派到的目录 id 列表(用于界面展示「共享 N 个目录」)。 */
  folders: string[];
  /** 对端经 folder-sync-list 宣告的「它与本机在同步的目录 id 集合」。
   *  undefined = 对端为旧版本,UI 无法区分「已停止共享」。 */
  remoteFolders?: string[];
  /** 对端宣告的「仍待确认的、来自本机的目录邀请 id 集合」(folder-sync-list)。
   *  UI 据此把「在线但清单里没有本目录」细分为 待对方确认 / 已停止共享。 */
  remotePendingFolders?: string[];
  /** 对端会话建立时经 hello 宣告的运行版本;dev 态为 'dev'。
   *  undefined = 对端是旧版本(未发 hello),UI 显示「未知」且不给升级入口。 */
  version?: string;
  /** 本机(打包态)版本是否低于该对端:为 true 时 UI 提供「从对方升级」入口。
   *  dev↔build 混跑时恒为 false(dev 无产物,不做跨形态更新)。 */
  canUpgrade?: boolean;
}

export interface TransferFile {
  /** 正在传输的文件相对路径。 */
  path: string;
  /** 'receive' = 本机正从对端拉取;'send' = 本机正供块给对端。 */
  direction: 'send' | 'receive';
  /** 已传字节数(估算,最后一块可能偏小)。 */
  bytesDone: number;
  /** 文件总字节数。 */
  bytesTotal: number;
}

export interface ProgressCounts {
  pending: number;
  sending: number;
  receiving: number;
  /**
   * 瞬时发送速率(字节/秒):本机向该对端供块的实测平均值,按最近的滚动窗口计算。
   * 窗口内没有字节发出时不带该字段(空闲快照保持最小,差异驱动推送也不会多推帧)。
   */
  sendRate?: number;
  /** 瞬时接收速率(字节/秒):本机从该对端收块的实测平均值。窗口内没有收块时不带。 */
  receiveRate?: number;
  /** 文件级进度(可选):每个正在传输的文件一条。无传输时不带,避免状态快照凭空变大。 */
  files?: TransferFile[];
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
  /**
   * 错误分类(供 UI 精准给恢复动作):identity-changed / identity-remounted /
   * identity-missing = 目录身份校验失败(前两者可「重新采集身份」);缺省 = 普通错误。
   */
  kind?: string;
}

/** 一次中转活动(ADR-0014):本机作为枢纽,把来源设备收到的目录索引条目转发给目标设备。
 *  同目录会话内单跳;from/to 均为对端设备 id。at 为发生时刻(毫秒)。 */
export interface RelayActivity {
  /** 发生中转的目录 id。 */
  folder: string;
  /** 变更的原始来源设备(本机是从它那里收到条目的)。 */
  from: string;
  /** 中转的目标设备(本机把条目转发给了它)。 */
  to: string;
  /** 发生时刻(毫秒时间戳)。 */
  at: number;
}

export interface StatusPayload {
  deviceId: string;
  /** 本机运行版本(runtimeVersion 口径):打包态为具体版本号,dev 态为 'dev'。 */
  version: string;
  /** 本机运行平台(process.platform):'darwin' / 'win32' / 'linux' …
   *  Web UI 据此给出与平台相符的「本机目录」示例。必须由后端提供而不能读浏览器的
   *  navigator:控制台常被从**另一台机器**打开,浏览器平台 ≠ 目录所在机器的平台。 */
  platform: string;
  folders: SharedFolderConfig[];
  /** 全局暂停同步:为 true 时所有目录的数据面停摆(各目录自己的 paused 仍独立生效)。 */
  paused?: boolean;
  entries: number;
  tombstones: number;
  devices: DeviceStatus[];
  syncProgress: SyncProgress[];
  /** 各共享目录最近一次同步错误(无错误时为空数组)。 */
  folderErrors: FolderErrorStatus[];
  /** 对方推送过来的待确认项(配对 / 目录共享),供 Web UI 弹「待确认」。 */
  offers: PendingOffer[];
  /** npm 检查到的可用更新(打包态且发现更高版本时才有值),Web UI 据此弹升级提示。 */
  updateAvailable?: { latest: string; current: string };
  /** 最近的中转活动(ADR-0014);本机把来源设备的目录变更转发给其他对端时记录。无中转则缺省。 */
  relayActivity?: RelayActivity[];
  /** 每目录残留冲突副本数(目录卡徽标)。空/缺省 = 全都没有冲突。 */
  conflictCounts?: Record<string, number>;
  /** 传输统计:累计字节 + 采样序列(daemon 重启清零)。缺省 = 旧后端未提供。 */
  traffic?: TrafficStats;
  /** 本机主机名 / 局域网地址(顶栏 chip;旧后端缺省)。 */
  hostname?: string;
  localAddresses?: string[];
  /** 数据目录(--config-dir / --config 的解析结果;旧后端缺省)。
   *  前端示例命令/路径提示(control.token、--log-file)据此动态生成,不写死 ~/.syncx。 */
  configDir?: string;
  /** 全局同步设置当前值(设置弹窗;旧后端缺省)。 */
  settings?: GlobalSettingsStatus;
}

/** 一个采样窗口的流量增量(窗口内发/收的字节数)。 */
export interface TrafficSample {
  /** 窗口结束时刻(毫秒时间戳)。 */
  at: number;
  sent: number;
  received: number;
}

/** 传输统计:daemon 启动以来的累计字节 + 最近窗口的采样序列(流量面板画曲线用)。 */
export interface TrafficStats {
  sent: number;
  received: number;
  samples: TrafficSample[];
}

/** 全局同步设置(设置弹窗展示当前值用;与 config 顶层字段同形)。 */
export interface GlobalSettingsStatus {
  /** 发送带宽上限 KB/s(目录未配置时的兜底);undefined = 不限速。 */
  maxSendKbps?: number;
  /** 每路径版本份数;undefined = 默认 10。 */
  versionsPerPath?: number;
  /** 每目录同步记录保留条数;undefined = 默认 2000。 */
  historyMaxEvents?: number;
}

/** buildStatus 的扩展口径:新功能统计一律进这里,不再膨胀位置参数。 */
export interface StatusExtras {
  /** 每目录残留冲突副本数(目录卡徽标)。 */
  conflictCounts?: Record<string, number>;
  /** 传输统计累计 + 采样(流量面板)。 */
  traffic?: TrafficStats;
  /** daemon 所在机器的操作系统主机名(顶栏本机 chip 展示)。 */
  hostname?: string;
  /** daemon 所在机器的局域网 IPv4 地址列表(排除回环;多网卡则多条)。 */
  localAddresses?: string[];
  /** 数据目录(前端路径提示动态生成用;缺省 = 后端旧版本未提供)。 */
  configDir?: string;
  /** 全局同步设置当前值(设置弹窗;缺省 = 后端旧版本未提供)。 */
  settings?: GlobalSettingsStatus;
}

export function buildStatus(
  identity: DeviceIdentity,
  config: Config,
  stats: IndexStats,
  devices: DeviceStatus[] = [],
  syncProgress: SyncProgress[] = [],
  offers: PendingOffer[] = [],
  folderErrors: FolderErrorStatus[] = [],
  selfVersion = 'unknown',
  updateAvailable?: { latest: string; current: string },
  relayActivity?: RelayActivity[],
  extras: StatusExtras = {},
): StatusPayload {
  return {
    deviceId: identity.deviceId,
    version: selfVersion,
    platform: process.platform,
    folders: config.sharedFolders,
    paused: config.paused === true,
    entries: stats.entries,
    tombstones: stats.tombstones,
    devices,
    syncProgress,
    offers,
    folderErrors,
    updateAvailable,
    relayActivity,
    conflictCounts: extras.conflictCounts,
    traffic: extras.traffic,
    hostname: extras.hostname,
    localAddresses: extras.localAddresses,
    configDir: extras.configDir,
    settings: extras.settings,
  };
}