/**
 * 会话与目录运行期状态管理(daemon 核心)。
 *
 * 从 cli.ts 的 run() 拆出:此前约 30 个闭包函数共享 folderStates /
 * activeSessions / peerSessions 等可变状态,现在收敛为一个显式管理器类,
 * 依赖(identity / configPath / logger / peerPort)经构造器注入。
 *
 * 职责:
 *  - 共享目录运行期状态(folderStates:索引/执行器/本地索引/忽略规则)与目录级错误采集
 *  - 对端连接:去重书签(peerSessions)、备份会话、断线指数重连、mDNS/配置/入站三路连接入口
 *  - 同步通道生命周期:按目录 devices 指派对账(attach/detach/reconcile)
 *  - 控制面消息:配对/目录邀请/回执/安装包请求,目录清单宣告(folder-sync-list)
 *  - 本地变更扫描(5s 周期由 cli 的定时器驱动)与配置热重载(reloadConfig)
 *  - P2P 自更新(upgradeFromPeer:请求对端 tgz → sha256 校验 → updater 接管)
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Logger } from 'pino';
import { WebSocket } from 'ws';

import { loadConfig, mutateConfig, folderIdFor, folderIndexKey, folderIndexPath, folderTrashPath, folderVersionsPath, purgeFolderIndex, type SharedFolderConfig } from './config.js';
import { checkFolderIdentity, readFolderIdentity } from './folder-identity.js';
import { openIndexStore, type IndexStore } from './indexstore.js';
import { createLocalExecutor, resolveSharePath, type LocalExecutor } from './executor.js';
import { filterIndexedEntries, HARD_IGNORE_NAMES, isHardIgnored, parseIgnoreRules, readFolderIgnoreLines } from './ignore.js';
import { createSyncPeer, type PeerTransport, type SyncPeer } from './peer.js';
import { scanFolder } from './scanner.js';
import type { IndexEntry } from './index.js';
import { hashBlock, splitIntoBlocks, readBlockAt } from './blockstore.js';
import { createVersionVector, incrementVersion, mergeVersions, type VersionVector } from './version.js';
import { recordSyncEvent } from './history.js';
import { parseConflictCopy } from './conflicts.js';
import { TrafficLedger } from './traffic.js';
import type { TrafficStats } from './status.js';
import { encodeSnapshot, decodeSnapshot } from './messages.js';
import { buildFolderDiff, checkDiffAgainstDisk, toSnapshotEntry, type FolderDiff, type SnapshotEntry } from './diff.js';
import { broadcastFolderUpdates } from './broadcast.js';
import { relayToSiblings } from './relay.js';
import { compareContentLimit, imageMimeOf, TEXT_COMPARE_MAX_BYTES } from './file-kind.js';
import { connectPeer } from './net/client.js';
import { makePeerTransport, attachPeerMessages, sendControlMessage, type ControlMessage } from './net/wire.js';
import { learnPeerUrl, learnPeerIp, getLanAddresses } from './net/addresses.js';
import { hostname as osHostname } from 'node:os';
import { RateLimiter } from './ratelimit.js';
import { isPeerAllowed, addPeer, setFolderPaused, setGlobalPaused } from './devices.js';
import { receiveOffer, makeOfferId, pruneRevokedOffers } from './offers.js';
import type { DeviceIdentity } from './identity.js';
import type { ProgressCounts, RelayActivity, TransferFile } from './status.js';
import { isBundledRuntime, packSelfTgz, runSelfUpdate, runtimeVersion, sha256Hex } from './selfupdate.js';
import { compareVersions } from './upgrade.js';
import { reconnectDelayMs } from './args.js';

/** 一个共享目录的运行期状态:索引、执行器与本地索引,随配置热重载增删。 */
export interface FolderState {
  id: string;
  /**
   * 索引库命名 key(instanceId ?? folderId)。与 wire 身份 id 刻意解耦:
   * wire 用 id 路由,索引按本机实例 key 命名,使「目录实例」与「索引寿命」绑定。
   */
  indexKey: string;
  path: string;
  index: IndexStore;
  executor: LocalExecutor;
  localIndex: Map<string, IndexEntry>;
  ignoreLines: string[];
  transports: PeerTransport[];
  peers: Map<string, SyncPeer>;
  /** transport → 对端设备 id 的映射(attach 时写入,detach 时清理);
   *  仅用于中转遥测记录(把中继目标的对端 id 解析出来),不影响同步逻辑。 */
  transportDevice: Map<PeerTransport, string>;
  config: SharedFolderConfig;
  /**
   * 首轮扫描是否只建基线(不写同步记录):索引为空(新目录)时为 true,
   * 存量文件视为基线避免刷屏;索引从盘上恢复(有存量条目)时为 false,
   * 首扫的 diff 是 daemon 离线期间的真实改动,必须记录。首扫完成后清除。
   */
  baselinePending: boolean;
}

/** 一条存活的对端会话:配置热重载新增/移除目录时,对现有连接补建或摘除对应 peer。 */
export interface ActiveSession {
  socket: WebSocket;
  key: Buffer;
  remoteDeviceId: string;
  peers: Map<string, SyncPeer>;
  transports: Array<{ folder: FolderState; transport: PeerTransport }>;
  /** 对端宣告的「它与本机在同步的目录 id 集合」(folder-sync-list 消息)。
   *  undefined = 对端是旧版本(未发送该消息),UI 无法区分「已停止共享」。 */
  remoteFolders?: Set<string>;
  /** 对端宣告的「仍待确认的、来自本机的目录邀请 id 集合」(folder-sync-list)。
   *  空/缺失时 UI 退回「已停止共享」的旧判断。 */
  remotePendingFolders?: Set<string>;
}

export interface DeviceLinkInfo {
  online: boolean;
  url?: string;
  remoteFolders?: string[];
  remotePendingFolders: string[];
  version?: string;
  /** 对端主机名(hello 宣告);undefined=旧版本对端未发。 */
  hostname?: string;
}

/** 内容对比时对端返回的目录索引快照(见 folder-index-request)。 */
export interface PeerSnapshot {
  entries: SnapshotEntry[];
  /**
   * 对端该目录生效的忽略规则行(含内置默认行)。
   * undefined = 对端未提供(旧版本):此时无法判定「差异是规则使然」,
   * 报告会退化为把这类条目一律当成待同步差异。
   */
  ignoreLines?: string[];
  /** 对端此刻的传输进度,用于在报告里提示「可能含传输中的中间态」。 */
  progress?: ProgressCounts;
  /** 本机收齐快照的时刻(毫秒)。 */
  at: number;
}

/** 从对端取回的单个文件内容(只读,见 file-content-request)。 */
export interface PeerFileResult {
  data: Buffer;
  size: number;
  /** 对端该条目的版本向量;同步后据此算两端都认可的新版本。 */
  version?: Array<[string, number]>;
}

/** 一次目录对比的完整结果(Web 弹窗与 CLI 共用同一份 JSON)。 */
export interface FolderDiffResult {
  folderId: string;
  /** 本机该目录的落地路径。 */
  folderPath: string;
  deviceId: string;
  /** 对端版本(来自 hello);undefined = 未知。 */
  deviceVersion?: string;
  /** 对端主机名(hello 宣告);undefined = 旧版本对端未宣告。 */
  deviceHostname?: string;
  /**
   * 本机记录的该对端可达地址(ws://ip:port,手动填写或反向发现学到)。
   * undefined = 尚未学到(只有入站连接且对方未广播端口时)。
   */
  deviceUrl?: string;
  /** 本机主机名:报告里「本机」一栏,便于确认这份报告出自哪台机器。 */
  localHostname: string;
  /** 本机 LAN 地址(IPv4,多网卡时多个);空数组 = 没有非环回地址。 */
  localAddresses: string[];
  /** 对端快照的收齐时刻,报告上标注「数据取自 …」。 */
  remoteAt: number;
  diff: FolderDiff;
  /** 本机此刻的传输进度(全为 0 时不给)。非零说明报告可能含传输中的中间态。 */
  localProgress?: PeerSnapshot['progress'];
  /** 对端快照里带回的它此刻的传输进度。 */
  remoteProgress?: PeerSnapshot['progress'];
}

/**
 * 双栏对比页一次请求的完整结果:在差异分类之外,额外给出**两侧的条目清单**。
 *
 * 差异分类(ADR-0013)刻意不返回 in-sync 的条目 —— 报告里它们没有信息量;
 * 但目录结构视图必须看到「两边都一样的那些文件」,否则用户无法相信「对齐」是完整的。
 * 两侧清单 + 分类结果一起给,前端按路径合并成行即可,不必再猜哪条被折叠了。
 */
export interface FolderCompareResult extends FolderDiffResult {
  /** 本机索引条目(含墓碑:UI 按 deleted 决定是否展示)。 */
  local: SnapshotEntry[];
  /** 对端快照条目。 */
  remote: SnapshotEntry[];
}

/** 单个文件某一侧的状态(内容对比弹窗用)。 */
export interface FileSideState {
  exists: boolean;
  /** 文本内容;二进制 / 过大 / 不存在时为 undefined。 */
  text?: string;
  size?: number;
  binary?: boolean;
  /**
   * 图片预览:该侧是浏览器能解码的图片后缀、且没超图片上限时给出(data 为 base64)。
   *
   * 与 text 并不互斥 —— `.svg` 既是图片又是可读文本,两侧都给,前端在「预览 / 逐行」
   * 之间切换。raster 图片只给 image(`binary` 同时为 true,那是事实)。
   */
  image?: { mime: string; data: string };
  /** 超过体积上限:不回传内容,只给大小(弹窗降级为整文件覆盖)。 */
  tooLarge?: boolean;
  /** 该侧条目的版本向量。 */
  version?: Array<[string, number]>;
  /** 取不到内容的原因(对端离线 / 未共享 / 文件不存在 / 读取失败)。 */
  error?: string;
}

/** GET /api/folders/file 的响应:同一个文件在本机与对端的两侧状态。 */
export interface FileCompareResult {
  folderId: string;
  folderPath: string;
  deviceId: string;
  path: string;
  local: FileSideState;
  remote: FileSideState;
}

/** 对比请求等待对端快照的上限。目录很大时对端要现算摘要 + 分片发送,给足余量。 */
const SNAPSHOT_TIMEOUT_MS = 20_000;
/** 一片多少条:2000 条约几百 KB,远低于单帧上限,又不会把大目录拆成几十片。 */
const SNAPSHOT_CHUNK_ENTRIES = 2000;
/** 片数上限(仅用于校验对端声明的 total,挡异常/恶意消息造成内存膨胀)。 */
const MAX_SNAPSHOT_CHUNKS = 500;

/**
 * 单文件内容对比的体积上限(2 MiB)。
 *
 * 内容要经控制通道以 base64 回传(体积 ×4/3),再进 JSON 交给浏览器做行级差异;
 * 再大既撑爆单帧(chunk 上限 64MB,但大文件会让 UI 卡死),也没有可读性 ——
 * 超限时弹窗降级为「整文件覆盖」,不回传内容。
 */
const FILE_COMPARE_MAX_BYTES = 2 * 1024 * 1024;
/** 等待对端回文件内容 / 写入回执的上限。 */
const FILE_REQUEST_TIMEOUT_MS = 20_000;

/**
 * 进度是否表示「此刻真的有传输在跑」。
 *
 * 目录卡的进度是常态存在的(每个共享目录都有一条,空闲时为 0/0/0),所以判断
 * 「要不要提醒用户报告可能含中间态」不能只看字段有没有,必须看数值。
 */
function isTransferring(p: { pending: number; sending: number; receiving: number }): boolean {
  return p.pending + p.sending + p.receiving > 0;
}

/**
 * Buffer → 文本;二进制返回 undefined。
 *
 * 判据不只是「含 NUL」:UTF-16 / 部分单字节编码的文件不含 NUL 却也不是可读文本,
 * 故再补一道 UTF-8 往返校验(解码后重新编码必须与原文逐字节相同)。
 */
function decodeText(data: Buffer): string | undefined {
  if (data.length === 0) return '';
  if (data.subarray(0, Math.min(data.length, 8192)).includes(0)) return undefined;
  const text = data.toString('utf8');
  return Buffer.compare(Buffer.from(text, 'utf8'), data) === 0 ? text : undefined;
}

export interface SessionManagerDeps {
  identity: DeviceIdentity;
  configPath: string;
  /** 配置目录(索引库/pid 等落盘位置)。 */
  configDir: string;
  /** 本机 peer 监听端口(出站拨号时对端会回校,这里仅作为 connectPeer 参数)。 */
  peerPort: number;
  logger: Logger;
  /**
   * 对外可见状态可能已变(设备上下线、对端版本/目录清单、邀请与错误增删、
   * 扫描结果、接收落地)。控制面的状态推送通道据此实时刷新 Web UI。
   *
   * 这是「低延迟」入口,不是「唯一」入口:状态推送另有兜底重算,所以这里漏打一个
   * 通知点只表现为「该变化晚几秒到界面」,不会永久不刷新。多个通知点合并在一个
   * 窗口内也只推一帧,因此宁可多打不可漏打。
   */
  onStatusChanged?: () => void;
}

export class SyncSessionManager {
  /** 每个共享目录独立的索引/执行器/本地索引状态(可变:配置热重载可新增/移除目录)。 */
  folderStates: FolderState[];

  private readonly identity: DeviceIdentity;
  private readonly configPath: string;
  private readonly configDir: string;
  private readonly peerPort: number;
  private readonly logger: Logger;
  /** 状态变更通知(见 SessionManagerDeps.onStatusChanged);缺省为空操作。 */
  private readonly notifyStatus: () => void;

  // --- 目录级同步错误采集(Web UI 目录卡上的错误提示) ---
  // 记录每个目录最近一次同步失败的错误信息(内存态,不落盘);同一目录再次出错覆盖,
  // 一轮完整扫描无新错误则清除(问题自愈后提示自动消失)。
  private readonly folderErrorsState = new Map<string, { message: string; ts: number; kind?: string }>();
  // --- 传输流量统计(流量面板:累计字节 + 5min 窗口采样环,内存态、重启清零)---
  private readonly traffic = new TrafficLedger();
  // 待清理索引库:removeFolder 时登记「目录实例 key」,等配置热重载关闭该目录的
  // 索引连接后再删文件,规避 Windows 下 unlink 打开中的库报 EBUSY。
  // 注:这只是「尽早清理」的优化,正确性不依赖它 —— 目录实例化(instanceId)保证新实例
  // 永远打开新文件名的空库,残留的旧库即便没删掉也不会被复用;启动时的孤儿回收会兜底清掉。
  private readonly pendingIndexPurge = new Set<string>();

  // --- 对端连接去重与断线重连 ---
  // mDNS 重播 + config.peers 主动连接 + 双向同时拨号会在同一对端上产生重复连接。
  // 模型:peerSessions 是「与某对端的当前会话」书签,只指向 socket 存活的会话;
  // 重复连接照常注册(消息 handlers 可收数据)作为备份,但不抢书签;本机多余的
  // 出站拨号在拨号侧直接关闭。书签会话断开时先把书签移交给其余存活会话,
  // 没有才清书签并排定重连。
  // 旧实现按连接计数放行并无条件覆盖书签:书签被覆盖到一条随即被对端关闭的
  // 连接上 → 书签孤儿化,sendControlTo 永远失败,设备却显示在线,
  // 邀请/回执全部静默丢失(曾导致「添加共享目录对端收不到确认」)。
  // 记录由本机主动发起(outbound)的连接的 URL,断线后可按 URL 重连;
  // 入站连接(url 未知)依赖对端重连。
  private readonly outboundPeerUrls = new Map<string, string>();
  private readonly reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly reconnectAttempts = new Map<string, number>();
  // 跟踪所有 peer socket(入站 + 出站),关闭时统一断开,避免客户端 socket
  // 保持事件循环活跃导致进程无法退出。
  private readonly peerSockets = new Set<WebSocket>();
  // 存活会话注册表:配置热重载新增/移除目录时,对现有连接补建或摘除对应目录的 peer
  private readonly activeSessions: ActiveSession[] = [];
  // 按对端 deviceId 索引的存活会话:用于向已连接对端推送 control 控制面消息
  // (配对请求 / 目录共享邀请 / 确认回执)。离线对端查不到即跳过(连接建立时会自动补发)。
  private readonly peerSessions = new Map<string, ActiveSession>();
  /**
   * 对端经 hello 宣告的运行版本 / 主机名,按 deviceId 存储,与「书签会话」解耦。
   * 任意一条与该对端的存活会话收到 hello 都更新此 map,因此设备卡显示的对端版本 /
   * 主机名不再受「书签会话 ≠ 实际收到 hello 的会话」影响 —— 双连接 / 重连 /
   * 书签迁移等拓扑抖动下均稳定,不会再偶发「版本未知」。
   */
  private readonly peerInfo = new Map<string, { version?: string; hostname?: string }>();
  /**
   * 心跳存活探测:每个 peer socket 自最近一次 ping 起是否收到过 pong。
   * 网络分区 / 对端静默掉线时,本端 socket 仍停留在 OPEN 状态,sessionAlive 据此
   * 误判为「在线」→ 设备卡常显在线、却永远收不到数据(孤儿 peer)。靠应用层
   * ping/pong 探活,连续未回 pong 的 socket 由心跳强制 terminate,触发 close 清理
   * 并排定重连,杜绝僵尸在线。
   */
  private readonly peerLiveness = new Map<WebSocket, boolean>();
  /** 心跳定时器句柄;close() 时清除,避免阻止 daemon 退出。 */
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  /** 最近的中转活动环形缓冲(ADR-0014 遥测);上限 100,溢出丢弃最旧。仅供拓扑视图展示。 */
  private readonly relayActivity: RelayActivity[] = [];
  private static readonly RELAY_ACTIVITY_CAP = 100;
  /** 等待对端 self-binary-response 的挂起请求(requestId → resolver)。 */
  private readonly pendingBinary = new Map<string, (resp: Extract<ControlMessage, { kind: 'self-binary-response' }>) => void>();
  /**
   * 等待对端索引快照的挂起请求(requestId → 累积分片)。内容对比功能用:
   * 快照按片返回,集齐 total 片才 resolve;超时或对端明确报错则 reject。
   * 与 pendingBinary 分开存放:对比请求允许并发(多个目录/多个对端同时比),
   * 键都是随机 requestId,互不干扰。
   */
  private readonly pendingSnapshots = new Map<
    string,
    {
      folderId: string;
      total: number;
      chunks: Map<number, SnapshotEntry[]>;
      ignoreLines?: string[];
      progress?: PeerSnapshot['progress'];
      resolve: (result: PeerSnapshot) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  /**
   * 等待对端「单个文件内容」的挂起读请求(requestId → resolve/reject)。
   * 双栏对比页用:文件内容按需索取,一次响应即完成(不像快照要分片),
   * 故用最简单的 pending 形态。
   */
  private readonly pendingPeerFiles = new Map<
    string,
    {
      resolve: (result: PeerFileResult) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  /** 等待对端「已按指定内容落盘」回执的挂起写请求。 */
  private readonly pendingPeerWrites = new Map<
    string,
    {
      resolve: () => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  /** 扫描重入保护(见 runScan)。 */
  private scanning = false;
  /** 扫描进行中新收到的触发不丢弃,合并成「本轮跑完补跑一轮」(见 runScan)。 */
  private scanQueued = false;
  /**
   * 全局暂停开关(config.paused 的内存镜像):为 true 时所有目录的数据面停摆。
   * 构造时从配置读取,热重载 / setGlobalPaused 时同步;各目录自己的 paused
   * 存在 folder.config 上,两者任一生效即视为暂停(见 folderPausedNow)。
   */
  private globalPaused = false;
  /**
   * close() 之后置位:随后 socket 的 close 事件**不得再排定重连**。
   * 优雅关闭时 close() 会 terminate 所有 peer socket,而 terminate 触发的 close
   * 事件是异步到达的 —— 那时 close() 早已清空 reconnectTimers 并返回,于是关闭
   * 路径上反而会新排一个 0~30s 的重连定时器(未 unref),既把正在退出的 daemon
   * 钉在事件循环里,又可能真的向外拨号。与「peer socket 未 terminate 导致进程
   * 无法退出」同源,由本标志兜底。
   */
  private closed = false;

  constructor(deps: SessionManagerDeps, initialFolders: SharedFolderConfig[]) {
    this.identity = deps.identity;
    this.configPath = deps.configPath;
    this.configDir = deps.configDir;
    this.peerPort = deps.peerPort;
    this.logger = deps.logger;
    this.notifyStatus = deps.onStatusChanged ?? ((): void => {});
    // 全局暂停是 config.json 的顶层字段,不在 initialFolders 里:构造时读一次
    this.globalPaused = loadConfig(deps.configPath).paused === true;
    this.folderStates = initialFolders.map((f) => this.createFolderState(f));
    this.startHeartbeat();
  }

  /**
   * 启动应用层心跳:周期性向每个 peer socket 发 ping,并依据最近一次 pong 判定存活。
   * 收到 pong(由 ws 库在收到 ping 后自动回发)则标记存活;连续一轮 ping 后未回 pong,
   * 视为已死并强制 terminate → close 回调清理会话、排定重连。
   * 间隔取 20s,留给 TCP 重传与瞬时抖动余量,避免误杀健康但短暂卡顿的连接。
   */
  private startHeartbeat(): void {
    const INTERVAL_MS = 20000;
    this.heartbeatTimer = setInterval(() => {
      for (const socket of this.peerSockets) {
        const alive = this.peerLiveness.get(socket);
        if (alive === false) {
          // 上一轮 ping 后始终没收到 pong:探活失败,强制断开(close 会清理 + 重连)
          this.logger.info('peer socket failed liveness probe (no pong); terminating');
          try {
            socket.terminate();
          } catch {
            // socket 已关闭,close 回调会做清理
          }
          continue;
        }
        // 标记待探测,随后发 ping;本端 OPEN 但实际已死的对端不会回 pong,下轮即被收割
        this.peerLiveness.set(socket, false);
        try {
          socket.ping();
        } catch {
          // 已关闭,close 回调会做清理
        }
      }
    }, INTERVAL_MS);
    // 心跳定时器不应阻止 daemon 在 SIGTERM 时退出
    if (typeof this.heartbeatTimer.unref === 'function') this.heartbeatTimer.unref();
  }

  /* ==================== 目录运行期状态与错误采集 ==================== */

  /** 为一个共享目录创建运行期状态(索引/执行器/本地索引/忽略规则)。 */
  createFolderState(f: SharedFolderConfig): FolderState {
    const id = folderIdFor(f);
    const indexKey = folderIndexKey(f);
    // 索引按「目录实例 key」命名:新实例必然打开全新空库,不可能继承上一轮的旧条目/旧墓碑
    const index = openIndexStore(folderIndexPath(this.configDir, indexKey));
    // 回收站在共享目录之外:`<configDir>/trash/<index key>`。放在共享根里会在用户目录中
    // 留下常驻痕迹(并被 git status 报成未跟踪文件),见 config.folderTrashPath。
    const executor = this.captureFolderErrors(
      id,
      createLocalExecutor(
        f.path,
        index,
        folderTrashPath(this.configDir, indexKey),
        folderVersionsPath(this.configDir, indexKey),
      ),
    );
    // 索引快照只取一次:下面三处(硬忽略断根 / 本地索引 / 基线判定)都要用,
    // 而 listEntries 是全表扫描,启动时对每个目录重复调用不划算。
    const stored = index.listEntries();
    // 断根:硬忽略路径(见 HARD_IGNORE_NAMES)的历史条目直接从库里删掉。旧版本曾把
    // .git 当普通内容索引(2026-09-15 事故),这些遗留条目是删除传播的种子——把它们
    // 从库里清掉,配合 filterIndexedEntries 的过滤,本机再不可能就 .git 外推任何东西。
    const purgeable = stored.filter((entry) => isHardIgnored(entry.path));
    for (const entry of purgeable) {
      index.removeEntry(entry.path);
    }
    if (purgeable.length > 0) {
      this.logger.info(
        `folder ${f.path}: removed ${purgeable.length} legacy hard-ignored entr${purgeable.length === 1 ? 'y' : 'ies'} from the index (${HARD_IGNORE_NAMES.join('/')} are never synced)`,
      );
    }
    // 剔除后的条目才是这个目录真正的索引内容;基线判定也基于它:库里若只剩硬忽略条目,
    // 清完即视为空索引建基线,而不是把首扫的存量文件当成「新增」刷一屏同步记录。
    const usable = purgeable.length === 0 ? stored : stored.filter((entry) => !isHardIgnored(entry.path));
    // 忽略规则每设备本地:.gitignore(默认并入,可按目录关闭)+ .syncxignore(优先级更高)
    const ignoreLines = readFolderIgnoreLines(f.path, f.useGitignore !== false);
    const localIndex = new Map(
      filterIndexedEntries(parseIgnoreRules(ignoreLines), usable).map((e) => [e.path, e]),
    );
    // 索引为空 → 首扫是建基线(存量文件不算新增);索引有存量 → 首扫 diff 是
    // daemon 离线期间的真实改动,要写同步记录
    const baselinePending = usable.length === 0;
    return { id, indexKey, path: f.path, index, executor, localIndex, ignoreLines, transports: [], peers: new Map(), transportDevice: new Map(), config: f, baselinePending };
  }

  /**
   * 为尚未记录身份指纹的目录采集并持久化指纹(仅本机、不写共享目录)。
   *
   * 只在**索引为空**时采集:新实例的索引必然为空 → 扫描只可能「发送」、绝不可能产生墓碑,
   * 此时把当前根目录当作「正常身份」记下来是安全的。反过来说,既有实例的索引非空时,
   * 若目录正处于「盘未挂载 / 被换掉 / 被清空」的坏状态,贸然采集就把坏状态当成正常身份
   * 记了下来,保护彻底失效 —— 那种情况留给用户在界面上「移除并重新添加」。
   *
   * 覆盖「手改 config.json 热重载新增目录」这条不经 addSharedFolder 的路径,否则该目录会
   * 因缺指纹退化为「结构守卫」模式(能同步,但只在整棵目录清空时才拦得住)。
   */
  private adoptFolderIdentityIfSafe(f: SharedFolderConfig, index: IndexStore): void {
    if (f.folderIdentity !== undefined) return;
    if (index.listEntries().length > 0) return;
    const identity = readFolderIdentity(f.path);
    if (!identity) return;
    // 先写内存:即使持久化失败,本次运行期间也已被保护
    f.folderIdentity = identity;
    try {
      mutateConfig(this.configPath, (config) => {
        const target = config.sharedFolders.find((x) => folderIdFor(x) === folderIdFor(f));
        if (!target || target.folderIdentity !== undefined) return false;
        target.folderIdentity = identity;
        return true;
      });
      this.logger.info(`folder identity recorded: ${f.path} (dev=${identity.dev} ino=${identity.ino})`);
    } catch (error) {
      this.logger.warn(
        `folder identity persist failed: ${f.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** 目录级错误列表(倒序),供 status 下发到目录卡。 */
  getFolderErrors(): Array<{ folder: string; message: string; ts: number; kind?: string }> {
    return [...this.folderErrorsState.entries()]
      .map(([folder, e]) => ({ folder, message: e.message, ts: e.ts, ...(e.kind ? { kind: e.kind } : {}) }))
      .sort((a, b) => b.ts - a.ts);
  }

  recordFolderError(folderId: string, error: unknown, detail?: string, kind?: string): void {
    const message = error instanceof Error ? error.message : String(error);
    const full = detail ? `${detail}: ${message}` : message;
    this.folderErrorsState.set(folderId, { message: full, ts: Date.now(), ...(kind ? { kind } : {}) });
    this.logger.warn(`folder ${folderId} sync error: ${full}`);
    // 目录卡上的错误横幅属「要看就得看到」的信息,不能等兜底 tick
    this.notifyStatus();
  }

  private clearFolderError(folderId: string): void {
    // 内容未变时不打扰推送通道(clearFolderError 每轮扫描都会对每个目录调用)
    if (this.folderErrorsState.delete(folderId)) this.notifyStatus();
  }

  /**
   * 给 executor 的四个写操作包一层错误捕获:任何 apply*(本地扫描应用与对端推送
   * 接收/冲突/删除共用同一执行器)抛错都归到所属目录,失败原因原样抛出,
   * 不改变既有重试语义。
   */
  private captureFolderErrors(folderId: string, executor: LocalExecutor): LocalExecutor {
    const wrap = <A extends unknown[]>(fn: (...args: A) => Promise<unknown>) =>
      async (...args: A): Promise<unknown> => {
        try {
          return await fn(...args);
        } catch (error) {
          this.recordFolderError(folderId, error);
          throw error;
        }
      };
    return {
      applyReceive: wrap((entry, provider) => executor.applyReceive(entry, provider)) as LocalExecutor['applyReceive'],
      applyDelete: wrap((path, tombstone) => executor.applyDelete(path, tombstone)) as LocalExecutor['applyDelete'],
      applyConflict: wrap((path, local, remote, provider, deviceId) =>
        executor.applyConflict(path, local, remote, provider, deviceId),
      ) as LocalExecutor['applyConflict'],
      applySend: wrap((path, deviceId) => executor.applySend(path, deviceId)) as LocalExecutor['applySend'],
    };
  }

  /** 指派/忽略开关变化后立即使某目录的忽略规则与本地索引生效(配置 watcher 随后兜底)。 */
  refreshFolderIgnoreRules(path: string): void {
    const folder = this.folderStates.find((f) => resolve(f.path) === resolve(path));
    if (folder) {
      folder.config = loadConfig(this.configPath).sharedFolders.find((f) => resolve(f.path) === resolve(path)) ?? folder.config;
      folder.ignoreLines = readFolderIgnoreLines(folder.path, folder.config.useGitignore !== false);
      folder.localIndex = new Map(
        filterIndexedEntries(parseIgnoreRules(folder.ignoreLines), folder.index.listEntries()).map((e) => [e.path, e]),
      );
    }
  }

  /* ==================== 本地变更扫描 ==================== */

  /**
   * 手动触发一轮扫描:与定时扫描逻辑一致。
   * 慢设备上大目录的单轮扫描可能超过定时间隔,若允许并发重入,两轮 scanFolder
   * 会在对方 applySend 写回索引之前各自对同一文件检出变更 → 同一次编辑产生两条
   * 记录 + 两次版本递增 + 两次广播。因此同一时刻只允许一轮扫描在跑。
   *
   * 但「在跑就丢弃」会造成另一种丢失:冲突处理/版本恢复等动作写盘后追的这次
   * 触发若撞上定时扫描窗口,磁盘变化要等下一个定时周期才被索引看见(目录卡
   * 冲突徽标迟迟不减)。改为排队合并:扫描中收到新触发只记一次 scanQueued,
   * 本轮收尾后补跑一轮 —— 多次触发塌缩成一轮,既有界又不漏。
   */
  async runScan(): Promise<void> {
    if (this.scanning) {
      this.scanQueued = true;
      return;
    }
    this.scanning = true;
    try {
      do {
        this.scanQueued = false;
        await this.scanOnce();
      } while (this.scanQueued);
    } finally {
      this.scanning = false;
      // 一轮扫描会同时改动条目/墓碑数、传输进度与目录错误 —— 扫完统一通知一次。
      // 传输过程中的进度由兜底 tick 补齐,不必逐块推送。
      this.notifyStatus();
    }
  }

  private async scanOnce(): Promise<void> {
    // 其它共享目录的归一化根路径:扫描某目录时,命中这些路径的子目录视为嵌套共享根,不重复索引
    // (含 baselinePending 的新建目录——父目录在其基线扫描期间也不应重复索引子目录文件)
    const otherRoots = this.folderStates.map((f) => resolve(f.path));
    for (const folder of this.folderStates) {
      // 暂停的目录(目录级或全局):数据面整体停摆 —— 不扫描、不广播、不应用变更。
      // 控制面照常(连接保持在线),恢复后由下一轮扫描 / reconcile 继续同步。
      if (this.folderPausedNow(folder)) continue;
      // 一轮扫描走到这里且后续无错误即视为「干净」:清除该目录上一次的错误提示,
      // 让问题自愈后目录卡上的错误横幅自动消失
      this.clearFolderError(folder.id);
      // 目录身份门禁:共享根的 dev/ino 与首次纳入同步时记录的不一致 = 换盘 / 重新挂载 /
      // 目录被删了重建 → 跳过本轮扫描、绝不产生墓碑。这是「盘不见了 / 目录被换掉了」与
      // 「用户真的删光了文件」之间唯一可靠的区分点(后者根目录身份不变)。
      // 参照 Syncthing 的 .stfolder,但**不往共享目录写任何文件**(见 folder-identity.ts)。
      // 目录卡上给出原因与恢复方式,而不是静默不同步;同一原因不重复刷日志。
      const verdict = checkFolderIdentity(folder.path, folder.config.folderIdentity);
      if (verdict === 'missing' || verdict === 'changed' || verdict === 'remounted') {
        const reason =
          verdict === 'missing'
            ? '目录不存在或不可读(盘未挂载?)'
            : verdict === 'remounted'
              ? '仅设备号变化而 inode 未变:疑似同一磁盘被重新挂载(重启 / 磁盘重枚举 / 容器重启),目录实体大概率没变'
              : '目录身份与记录不符(换盘 / 重新挂载 / 目录被重建?)';
        const prev = this.folderErrorsState.get(folder.id);
        if (!prev || !prev.message.includes('目录身份校验失败')) {
          this.recordFolderError(
            folder.id,
            new Error(
              `目录身份校验失败:${reason}。已暂停该目录同步以防误删。` +
                (verdict === 'missing'
                  ? '挂载/放好正确的盘后,下一轮扫描会自动恢复'
                  : '确认目录内容就是要同步的数据后,点目录卡上的「重新采集身份」仅更新指纹(不动索引);拿不准就移除并重新添加该目录'),
            ),
            '目录不可信',
            verdict === 'missing' ? 'identity-missing' : verdict === 'remounted' ? 'identity-remounted' : 'identity-changed',
          );
        }
        continue;
      }
      // 每轮扫描重读忽略文件:.gitignore(按目录配置可关)+ .syncxignore,改动即生效
      let diff;
      try {
        folder.ignoreLines = readFolderIgnoreLines(folder.path, folder.config.useGitignore !== false);
        // 嵌套共享根:排除自身,其余共享根传入扫描器,使父目录不再重复索引子目录文件
        const nestedRoots = otherRoots.filter((r) => r !== resolve(folder.path));
        diff = scanFolder(
          folder.path,
          folder.index,
          parseIgnoreRules(folder.ignoreLines),
          this.identity.deviceId,
          nestedRoots,
        );
      } catch (error) {
        // 扫描本身失败(如目录读取权限异常):记录到目录卡,下一轮扫描重试
        this.recordFolderError(folder.id, error, '扫描失败');
        continue;
      }
      // 结构性守卫:目录身份无法校验时(平台不提供 inode / 配置里尚未采集指纹),把
      // 「一个文件都没看到、却要删东西」当作目录不可信的形态,拒绝执行这批删除。
      // 只有这个极端情形被挡 —— 而那正是「盘未挂载 / 目录被换掉」的样子;正常的单文件
      // 删除(扫描仍能看到别的文件)不受影响。采集到指纹的目录根本不走这条分支。
      if (verdict === 'unknown' && diff.filesSeen === 0 && diff.tombstones.length > 0) {
        const prev = this.folderErrorsState.get(folder.id);
        if (!prev || !prev.message.includes('无法校验目录身份')) {
          this.recordFolderError(
            folder.id,
            new Error(
              `无法校验目录身份(平台未提供 inode 或尚未采集指纹),且本轮扫描未发现任何文件:` +
                `已拒绝执行这 ${diff.tombstones.length} 条删除。确认目录未挂载/未被清空后,` +
                `在界面移除并重新添加该目录即可恢复`,
            ),
            '目录不可信',
          );
        }
        continue;
      }
      // 建基线的目录(空索引首扫)不写记录,避免把存量文件当成"新增"刷屏;
      // 索引从盘上恢复的目录,首扫 diff 是离线期间的真实改动,要记录
      const recordEvents = !folder.baselinePending;
      for (const tomb of diff.tombstones) {
        // 防御闸门:同步协议与索引一律使用 '/' 分隔符。若墓碑路径里出现 '\'(Windows 平台
        // 分隔符),只可能是本地路径构造与本机索引(来自协议)不一致——这正是 2026-09-15
        // 「整棵子目录被判删除并广播」事故的形态。此处宁可拒绝该条删除并在目录卡报错,
        // 也绝不执行:索引错配绝不能演变成不可逆的数据丢失。
        if (tomb.path.includes('\\')) {
          this.recordFolderError(
            folder.id,
            new Error(`拒绝执行可疑删除(路径含平台分隔符 '\\',疑似路径构造与索引不一致): ${tomb.path}`),
            '可疑删除',
          );
          continue;
        }
        try {
          await folder.executor.applyDelete(tomb.path, tomb);
          folder.localIndex.set(tomb.path, tomb);
          if (recordEvents) {
            recordSyncEvent(this.configPath, {
              ts: Date.now(),
              folderId: folder.id,
              path: tomb.path,
              action: 'delete',
              direction: 'local',
            });
          }
        } catch (error) {
          // 索引写入失败,下一轮扫描重试;错误已由 executor 包装层归到目录卡
          this.recordFolderError(folder.id, error, `删除 ${tomb.path} 失败`);
        }
      }
      const sends: IndexEntry[] = [...diff.tombstones];
      for (const path of diff.changed) {
        const isNew = !folder.localIndex.has(path);
        try {
          const updated = await folder.executor.applySend(path, this.identity.deviceId);
          folder.localIndex.set(path, updated);
          sends.push(updated);
          if (recordEvents) {
            recordSyncEvent(this.configPath, {
              ts: Date.now(),
              folderId: folder.id,
              path,
              action: isNew ? 'add' : 'update',
              direction: 'local',
            });
          }
        } catch (error) {
          // 文件在扫描后被删除/重命名,下一轮扫描处理;错误已由 executor 包装层归到目录卡
          this.recordFolderError(folder.id, error, `同步 ${path} 失败`);
        }
      }
      // 接收模式:本地扫描仍更新本地索引(供对端索引比对与自愈),但绝不把本地
      // 新增/修改/删除广播出去,从根上防止残缺端把完整端的文件误删/覆盖
      if (sends.length > 0 && !folder.config.receiveOnly) {
        broadcastFolderUpdates(folder, sends);
      }
      folder.baselinePending = false;
    }
  }

  /* ==================== 连接与会话 ==================== */

  /**
   * 入站连接授权:握手阶段已用 Ed25519 签名校验对端身份(verifyKxMessage),
   * 此处不再因「未互相信任」而拒连。否则一方添加另一方时,对方收不到配对请求
   * (连接被拒 → 控制面消息到不了 → 不弹「待确认」)。未确认前的会话仅开放控制面,
   * 不交换文件索引(见 startSyncSession 对 allowed 的判断),信任在「待确认」弹窗确认后建立。
   */
  private acceptPeer(): boolean {
    return true;
  }

  /** 与某对端的当前会话是否存在且 socket 仍处于 OPEN 状态。 */
  isPeerConnected(deviceId: string): boolean {
    const session = this.peerSessions.get(deviceId);
    return !!session && session.socket.readyState === WebSocket.OPEN;
  }

  /** 会话是否仍然可用:socket 处于 OPEN 状态。 */
  private sessionAlive(session: ActiveSession): boolean {
    return session.socket.readyState === WebSocket.OPEN;
  }

  private registerPeer(deviceId: string, url?: string): void {
    if (url) {
      this.outboundPeerUrls.set(deviceId, url);
    }
    // 连接已建立:作废挂起的重连定时器与退避计数
    const timer = this.reconnectTimers.get(deviceId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(deviceId);
    }
    this.reconnectAttempts.delete(deviceId);
  }

  /**
   * 连接到指定对端并建立同步会话;失败时按调用方策略处理(默认记日志)。
   * 注意:不要在这里「发现已有会话就关闭新拨号」——对端可能已把这条连接
   * 登记为书签(它视角里没有存活会话),单方面关闭会杀掉对端唯一的活连接,
   * 双向同时拨号时会形成互相杀连接的重连风暴。重复连接一律照常注册为
   * 备份会话(startSyncSession 的书签策略保证书签永远指向存活连接)。
   */
  connectTo(
    url: string,
    opts: {
      onConnected?: (remoteDeviceId: string) => void;
      onRejected?: (error: unknown) => void;
    } = {},
  ): void {
    // 关闭中不再发起新连接(forceReconnect 也走这里):否则退出路径上会多出一条
    // 在途拨号,与正在关闭的进程竞争。
    if (this.closed) return;
    void connectPeer(this.identity, url, this.peerPort)
      .then(({ socket, remoteDeviceId, key }) => {
        opts.onConnected?.(remoteDeviceId);
        if (this.acceptPeer()) {
          this.startSyncSession(socket, remoteDeviceId, key, url);
        }
      })
      .catch((error) => {
        if (opts.onRejected) {
          opts.onRejected(error);
        } else {
          this.logger.error(`connect to ${url} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
  }

  private scheduleReconnect(deviceId: string): void {
    if (this.closed) return;
    const url = this.outboundPeerUrls.get(deviceId);
    if (!url) return;
    // attempts = 已连续失败次数:首连失败(0)立即重试,之后指数退避
    const attempts = this.reconnectAttempts.get(deviceId) ?? 0;
    this.reconnectAttempts.set(deviceId, attempts + 1);
    const delay = reconnectDelayMs(attempts);
    this.logger.info(`peer ${deviceId} disconnected, reconnecting in ${delay}ms`);
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(deviceId);
      this.connectTo(url, { onRejected: () => this.scheduleReconnect(deviceId) });
    }, delay);
    this.reconnectTimers.set(deviceId, timer);
  }

  /** 手动强制重连:立即尝试连接,不走指数退避;失败后回退到正常重连调度。 */
  forceReconnect(deviceId: string): void {
    if (this.isPeerConnected(deviceId)) return;
    const url = this.outboundPeerUrls.get(deviceId);
    if (!url) return;
    const timer = this.reconnectTimers.get(deviceId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(deviceId);
    }
    this.reconnectAttempts.delete(deviceId);
    this.logger.info(`manually reconnecting to peer ${deviceId}`);
    this.connectTo(url, { onRejected: () => this.scheduleReconnect(deviceId) });
  }

  /** 本机记录的某对端可达地址(手动填写或反向发现学习)。 */
  getLearnedUrl(deviceId: string): string | undefined {
    return this.outboundPeerUrls.get(deviceId);
  }

  /** 忘记某对端的地址并断开其所有会话;返回关闭的会话数。 */
  forgetAndCloseSessions(deviceId: string): number {
    this.outboundPeerUrls.delete(deviceId);
    this.peerInfo.delete(deviceId); // 忘记对端时一并清除其版本 / 主机名缓存
    // 断开与该设备的所有会话连接(遍历 activeSessions 而非只取 peerSessions 里的
    // 当前一条)。close 回调会拆掉目录 peer;当前会话的 close 会清书签并尝试排定
    // 重连,但此时 outboundPeerUrls 已清空,scheduleReconnect 直接返回,不会重连。
    const sessions = this.activeSessions.filter((s) => s.remoteDeviceId === deviceId);
    for (const s of sessions) s.socket.close();
    return sessions.length;
  }

  /** 在一个存活会话上为指定目录补建 transport/peer,并发送该目录的索引。 */
  private attachFolderToSession(session: ActiveSession, folder: FolderState): void {
    const rateLimiter = folder.config?.maxBandwidthKbps
      ? new RateLimiter(folder.config.maxBandwidthKbps)
      : undefined;
    const transport = makePeerTransport(session.socket, session.key, folder.id, rateLimiter);
    folder.transports.push(transport);
    folder.transportDevice.set(transport, session.remoteDeviceId);
    session.transports.push({ folder, transport });
    const peer = createSyncPeer({
      transport,
      localIndex: folder.localIndex,
      executor: folder.executor,
      readLocalBlock: (path, blockIndex) => {
        // 与写入侧同一守卫:拒绝经符号链接/../ 越过共享目录的读取。
        // 读取必须是「按偏移只读一块」:这里是对端拉块的最热路径,整读文件再切片
        // 会让每个 1MB 块请求都付出整个文件的 IO(大文件同步时事件循环被饿死,
        // 控制面网页假死),见 readBlockAt 的注释。
        return readBlockAt(resolveSharePath(folder.path, path), blockIndex);
      },
      deviceId: this.identity.deviceId,
      remoteDeviceId: session.remoteDeviceId,
      // 块请求服务侧路径校验(经符号链接逃逸的路径不响应)
      root: folder.path,
      // 忽略规则取**函数而非快照**:scanOnce 每轮重读并整体回写 folder.ignoreLines,
      // 快照一份的话「刚写进 .gitignore 的路径」要等重连才被入向闸门挡住(见 ADR 0012)
      readIgnoreLines: () => folder.ignoreLines,
      // 对端推来 .git 之类硬忽略内容时留痕:这是保护在生效,不是错误,所以只记 info。
      // 触发通常意味着对端版本旧(内置忽略早于本次改动)或对端把忽略规则负向覆盖了
      onHardIgnoredDropped: (paths, remoteDeviceId) =>
        this.logger.info(
          `folder ${folder.id}: dropped ${paths.length} hard-ignored entr${paths.length === 1 ? 'y' : 'ies'} from ${remoteDeviceId || 'peer'} (e.g. ${paths[0]})`,
        ),
      // 远端推送的变更(新增/修改/删除/冲突)落盘为同步记录(此处补全 folderId)
      onEvent: (ev) => {
        recordSyncEvent(this.configPath, { ...ev, folderId: folder.id });
        // 远端变更落地即改变了索引统计,立即刷新(这是「对端在同步」最直观的反馈)
        this.notifyStatus();
      },
      // 网络字节喂进全局流量账本(累计 + 采样环,供流量面板)。纯内存计数,不触发推送
      // (速率刷新已随 notifyStatus/进度轮询带走,这里再加推是每块一次的风暴)。
      onTraffic: (sent, received) => {
        if (sent > 0) this.traffic.add('send', sent);
        if (received > 0) this.traffic.add('receive', received);
      },
      // 接收模式:本机只收不推(对端索引规划时跳过 send / 本地墓碑外推,
      // 冲突以对端版本覆盖本地)
      receiveOnly: folder.config.receiveOnly ?? false,
      // 中转(ADR-0014):收到并落地远程条目后,转发给同目录其它 transport(排除来源端本身)。
      // 仅增量接收触发(peer.ts 内 gate),full 交换已收敛整网,不中转。
      onLanded: (entries) => {
        // 先原样执行中转,绝不被遥测记录影响(记录失败也必须照常中转)
        relayToSiblings(folder.transports, transport, entries);
        // 遥测:把「本机作为枢纽,把 from 的变更中转给同目录其它设备」记录下来供拓扑视图展示。
        // 完全旁路、独立 try/catch,任何异常都不允许冒泡到中转路径。
        try {
          const from = session.remoteDeviceId;
          const at = Date.now();
          for (const t of folder.transports) {
            if (t === transport) continue;
            const to = folder.transportDevice.get(t);
            if (to) this.recordRelay(folder.id, from, to, at);
          }
        } catch {
          // 遥测失败不影响同步:仅记日志,不抛
          this.logger.warn(`relay telemetry recording failed for folder ${folder.id}`);
        }
      },
      // 块请求长期无响应而放弃一条待接收(对端索引声明有、内容却供不出 —— 典型是
      // 对端编辑器 tmp 中间文件进索引后随即被改名)。放弃即进度归零,必须 notifyStatus
      // 把「接收中消失」推给 UI,否则用户对着一条永不消停的传输卡;WARN 留痕便于回溯。
      onStallDrop: (path, missingBlocks) => {
        this.logger.warn(
          `folder ${folder.id}: gave up receiving ${path} from ${session.remoteDeviceId} after block retries exhausted (${missingBlocks} block(s) never arrived); waiting for peer's next index update`,
        );
        this.notifyStatus();
      },
    });
    session.peers.set(folder.id, peer);
    folder.peers.set(session.remoteDeviceId, peer);
    // 会话建立时互发的这份索引是本机索引的**完整声明**,必须标 full:对端据此
    // 按并集规划,才能发现「本机有、对端缺」的文件并把它们拉过去。标成 delta
    // 会让对端只判定这份清单里提到的路径,漏掉本机独有的存量文件。
    transport.sendEntries([...folder.localIndex.values()], 'full');
  }

  /** 从一个存活会话上摘除指定目录的 peer/transport(设备被移出目录的 devices 时)。 */
  private detachFolderFromSession(session: ActiveSession, folder: FolderState): void {
    const removed = session.transports.filter((t) => t.folder.id === folder.id).map((t) => t.transport);
    session.transports = session.transports.filter((t) => t.folder.id !== folder.id);
    for (const t of removed) {
      const i = folder.transports.indexOf(t);
      if (i !== -1) folder.transports.splice(i, 1);
      // 同步清理 transport → 设备 id 映射,避免悬挂引用
      folder.transportDevice.delete(t);
    }
    folder.peers.delete(session.remoteDeviceId);
    session.peers.delete(folder.id);
  }

  /**
   * 会话目录对账:让「会话上挂了哪些目录的同步通道」与配置严格一致——
   *   - devices 包含对端但会话缺失该目录 → 补挂(attach 会互发索引,补挂即开始同步);
   *   - devices 不再包含对端但会话仍挂着 → 摘除(否则会继续向已无权接收的设备推变更)。
   * 幂等:双向都有 has 守卫,可随时对任意会话重复调用。
   * 调用时机:邀请确认回执(promoteSession)、配置热重载(reloadConfig)、会话建立。
   */
  private reconcileSessionFolders(session: ActiveSession): void {
    for (const folder of this.folderStates) {
      // 暂停的目录视为「不参与同步」:摘除数据通道(入站变更随之被忽略),
      // 恢复后这里会自动重挂并发送全量索引(attachFolderToSession)。
      const allowed =
        (folder.config.devices ?? []).includes(session.remoteDeviceId) && !this.folderPausedNow(folder);
      if (allowed && !session.peers.has(folder.id)) {
        this.attachFolderToSession(session, folder);
      } else if (!allowed && session.peers.has(folder.id)) {
        this.detachFolderFromSession(session, folder);
      }
    }
  }

  /** 向已连接对端推送一条 control 控制面消息;对端离线(无存活会话)则忽略。 */
  sendControlTo(deviceId: string, message: ControlMessage): boolean {
    const session = this.peerSessions.get(deviceId);
    if (!session) return false;
    try {
      // 每条控制消息都携带本机版本 / 主机名:即便一次性 hello 在双连接 / 重连抖动中
      // 丢失,只要任意一条控制消息(pairing / invitation / folder-sync-list 等)到达,
      // 对端即可学到本机版本,设备卡不再偶发「版本未知」。
      sendControlMessage(session.socket, session.key, this.withSelfInfo(message));
      return true;
    } catch (error) {
      this.logger.warn(`failed to send control to ${deviceId}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /** 给一条出站控制消息注入本机运行版本与主机名(供对端设备卡展示来源 / 计算可否升级)。 */
  private withSelfInfo(message: ControlMessage): ControlMessage {
    return { ...message, version: runtimeVersion(), hostname: osHostname() };
  }

  /** 收到对端 control 消息:把配对 / 目录共享邀请落成待确认项;确认回执触发会话对账。 */
  private onControl(message: ControlMessage): void {
    // 邀请来源的网络信息(主机名 + 入站源 IP),供 UI 在配对 / 共享邀请卡上展示来源。
    // 旧版本对端未发 hello → remoteHostname 为 undefined;非入站(本机主动出站连接)
    // 收到的邀请则 socket 取不到对端源 IP → fromIp 为 undefined。两者缺省都不展示。
    const srcSession = this.peerSessions.get(message.fromDeviceId);
    const fromHostname = this.peerInfo.get(message.fromDeviceId)?.hostname;
    const fromIp = srcSession?.socket ? learnPeerIp(srcSession.socket) : undefined;
    const srcMeta = { fromIp, fromHostname };
    switch (message.kind) {
      case 'pairing-request':
        receiveOffer(this.configPath, {
          id: message.offerId,
          kind: 'pairing',
          fromDeviceId: message.fromDeviceId,
          ...srcMeta,
        });
        this.logger.info(`pairing request received from ${message.fromDeviceId}${fromHostname ? ` (host ${fromHostname})` : ''}`);
        break;
      case 'folder-invitation': {
        const offer = receiveOffer(this.configPath, {
          id: message.offerId,
          kind: 'folder',
          fromDeviceId: message.fromDeviceId,
          folderId: message.folderId,
          folderName: message.folderName,
          ...srcMeta,
        });
        // 新落成一个待确认项后立即向对方反推目录清单(带 pendingFolderIds),
        // 让对方设备标签马上从「已停止共享」切到「待对方确认」,不等下次会话事件
        if (offer) this.pushFolderSyncList(message.fromDeviceId);
        this.logger.info(`folder invitation received from ${message.fromDeviceId}: ${message.folderId}`);
        break;
      }
      case 'pairing-ack':
        this.logger.info(`pairing ${message.accepted ? 'accepted' : 'declined'} by ${message.fromDeviceId}`);
        break;
      case 'folder-invitation-ack':
        this.logger.info(`folder invitation ${message.accepted ? 'accepted' : 'declined'} by ${message.fromDeviceId}`);
        // 对端确认接受:立即对账本机会话,把 devices 含对端的目录补挂上去(互发索引,
        // 内容开始流动)。此前这里只打日志,导致「邀请发出后 A 侧会话一直没有该目录的
        // 同步通道」,B 建好了目录却收不到内容,直到重连才恢复。
        if (message.accepted) this.promoteSession(message.fromDeviceId);
        break;
      case 'self-binary-request': {
        // 对端请求本机安装包(它版本更低、想从本机升级)。会话已经握手签名校验,
        // 对端身份真实;dev 态无安装包(或打包失败),回 data:undefined。
        // 打包走系统 tar 有 IO 耗时,异步化避免阻塞控制消息循环。
        void (async () => {
          const tgz = await packSelfTgz();
          this.logger.info(`self-binary request from ${message.fromDeviceId}: ${tgz ? `serving ${tgz.length} bytes` : 'unavailable (dev runtime or pack failed)'}`);
          this.sendControlTo(message.fromDeviceId, {
            kind: 'self-binary-response',
            requestId: message.requestId,
            fromDeviceId: this.identity.deviceId,
            version: runtimeVersion(),
            // 内容指纹:接收方落地前重算比对(传输完整性由 GCM 保证,这层绑定
            // 「消息内容」与「发送方实际打包的内容」,挡序列化/重组类错位)
            sha256: tgz ? sha256Hex(tgz) : '',
            data: tgz?.toString('base64'),
          });
        })();
        break;
      }
      case 'folder-index-request':
        // 对端要做内容对比:回一份只读快照(不重扫、不改状态)
        this.serveIndexSnapshot(message.fromDeviceId, message.folderId, message.requestId);
        break;
      case 'folder-index-snapshot':
        // 我们发出的对比请求的回片
        this.onSnapshotChunk(message);
        break;
      case 'file-content-request':
        // 对端在做文件内容对比:回一份该文件的内容(只读)
        this.servePeerFile(message.fromDeviceId, message.folderId, message.path, message.requestId);
        break;
      case 'file-content-response':
        // 我们发出的文件内容请求的回包
        this.onPeerFileResponse(message);
        break;
      case 'file-content-write':
        // 对端要求本机按给定内容落盘并采纳给定版本(对比页的「推到对端」)
        void this.applyPeerFileWrite(message);
        break;
      case 'file-content-write-result':
        this.onPeerFileWriteResult(message);
        break;
    }
    // 控制面消息多会改动待确认项/共享关系(设备卡与邀请卡的内容),统一通知一次。
    // 未产生实际变化时推送端会自行比对丢弃,故不必在这里逐分支判断。
    this.notifyStatus();
  }

  /**
   * 从对端拉取其安装包(tgz)并自更新:发送请求 → 等回传(30s 超时)→
   * 指纹校验 → runSelfUpdate(temp 校验 + updater 接管换入 + 拉起新 daemon)。
   * 本进程在 API 路由响应完 HTTP 后优雅关闭,换入由独立 updater 进程完成。
   */
  async upgradeFromPeer(deviceId: string): Promise<{ version: string }> {
    const session = this.peerSessions.get(deviceId);
    if (!session || !this.sessionAlive(session)) throw new Error('设备离线,无法升级');
    const targetVersion = this.peerInfo.get(deviceId)?.version;
    if (!targetVersion) throw new Error('对方版本未知(对端 syncx 版本过旧),无法升级');
    if (targetVersion === 'dev') throw new Error('对方为 dev 运行态,没有可拉取的产物');
    if (!isBundledRuntime()) throw new Error('本机为 dev 运行态,不支持自更新');
    const mine = runtimeVersion();
    if (compareVersions(mine, targetVersion) >= 0) throw new Error(`本机 ${mine} 不低于对方 ${targetVersion},无需升级`);

    const requestId = randomBytes(8).toString('hex');
    const resp = await new Promise<Extract<ControlMessage, { kind: 'self-binary-response' }>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingBinary.delete(requestId);
        reject(new Error('对方响应超时(30s)'));
      }, 30_000);
      this.pendingBinary.set(requestId, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      if (!this.sendControlTo(deviceId, { kind: 'self-binary-request', requestId, fromDeviceId: this.identity.deviceId })) {
        clearTimeout(timer);
        this.pendingBinary.delete(requestId);
        reject(new Error('发送升级请求失败(设备可能刚离线)'));
      }
    });
    if (!resp.data) throw new Error(`对方 ${resp.version} 未能提供安装包(dev 运行态或打包失败)`);
    const tgz = Buffer.from(resp.data, 'base64');
    // 指纹校验:重算 sha256 必须与发送方宣告一致,不一致说明内容错位,拒绝升级
    const actual = sha256Hex(tgz);
    if (actual !== resp.sha256) {
      throw new Error(`安装包指纹校验失败(期望 ${resp.sha256.slice(0, 12)}…,实际 ${actual.slice(0, 12)}…),已放弃升级`);
    }
    // temp 校验 + 派发 updater:本进程响应完 HTTP 优雅关闭后,由 updater
    // 完成等退出 → 整目录换入 → 拉起新 daemon(失败自动回滚旧包)
    await runSelfUpdate(tgz, resp.version);
    this.logger.info(`self-update staged: ${mine} → ${resp.version} (from ${deviceId}), shutting down for swap`);
    return { version: resp.version };
  }

  /* ---------- 内容对比(诊断用,全程只读;见 docs/adr/0013) ---------- */

  /**
   * 向对端索取它某个共享目录的索引快照。失败一律抛错(离线 / 超时 / 旧版本不认这条
   * 消息),不拿会话建立时那份内存镜像糊弄 —— 那份只在 attach 时刻准确,对端之后改
   * 忽略规则或只发增量都会让它悄悄过期,而「给出过期结论」比「不给结论」更糟。
   */
  async fetchPeerSnapshot(deviceId: string, folderId: string): Promise<PeerSnapshot> {
    const session = this.peerSessions.get(deviceId);
    if (!session || !this.sessionAlive(session)) throw new Error('设备离线,无法对比');
    const requestId = randomBytes(8).toString('hex');
    return new Promise<PeerSnapshot>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingSnapshots.delete(requestId);
        reject(new Error('对端响应超时(20s):可能是旧版本,或对端目录过大'));
      }, SNAPSHOT_TIMEOUT_MS);
      this.pendingSnapshots.set(requestId, {
        folderId,
        total: 0,
        chunks: new Map(),
        resolve,
        reject,
        timer,
      });
      const sent = this.sendControlTo(deviceId, {
        kind: 'folder-index-request',
        requestId,
        fromDeviceId: this.identity.deviceId,
        folderId,
      });
      if (!sent) {
        clearTimeout(timer);
        this.pendingSnapshots.delete(requestId);
        reject(new Error('发送对比请求失败(设备可能刚离线)'));
      }
    });
  }

  /**
   * 客户端的对比请求打到对端时由对端执行:回传本机该目录的本地索引快照。
   * **只读** —— 取的是内存里那份索引,不重新扫描、不改版本向量、不落盘。
   */
  private serveIndexSnapshot(deviceId: string, folderId: string, requestId: string): void {
    // 与「未授权对端不附加目录 peer」同一道闸门:目录没有把对方列进 devices 就
    // 一条索引都不给,否则这条诊断通道会变成绕过共享关系的索引读取入口。
    const folder = this.folderStates.find(
      (f) => f.id === folderId && (f.config.devices ?? []).includes(deviceId),
    );
    if (!folder) {
      this.sendControlTo(deviceId, {
        kind: 'folder-index-snapshot',
        requestId,
        fromDeviceId: this.identity.deviceId,
        folderId,
        seq: 0,
        total: 1,
        error: '该目录未共享给请求方',
      });
      this.logger.info(`index snapshot denied: folder ${folderId} is not shared with ${deviceId}`);
      return;
    }
    const entries = [...folder.localIndex.values()].map(toSnapshotEntry);
    const total = Math.max(1, Math.ceil(entries.length / SNAPSHOT_CHUNK_ENTRIES));
    const progress = this.folderProgress(folder);
    for (let seq = 0; seq < total; seq++) {
      const chunk = entries.slice(seq * SNAPSHOT_CHUNK_ENTRIES, (seq + 1) * SNAPSHOT_CHUNK_ENTRIES);
      this.sendControlTo(deviceId, {
        kind: 'folder-index-snapshot',
        requestId,
        fromDeviceId: this.identity.deviceId,
        folderId,
        seq,
        total,
        entries: encodeSnapshot(chunk).toString('base64'),
        // 忽略规则与该目录此刻的进度每片都带:体量远小于条目本身,换来「不必假设首片必达」
        ignoreLines: folder.ignoreLines,
        // 只有真的有传输在跑才带上(全 0 的进度不带,免得对端凭空多一句「此刻在传输」提示)
        ...(progress && isTransferring(progress) ? { progress } : {}),
      });
    }
    this.logger.info(
      `index snapshot served to ${deviceId} for ${folderId}: ${entries.length} entries in ${total} chunk(s)`,
    );
  }

  /** 收到一片快照:累积,集齐 total 片才放行等待方。 */
  private onSnapshotChunk(message: Extract<ControlMessage, { kind: 'folder-index-snapshot' }>): void {
    const pending = this.pendingSnapshots.get(message.requestId);
    if (!pending) return; // 超时之后迟到的片:直接丢弃
    if (message.error) {
      clearTimeout(pending.timer);
      this.pendingSnapshots.delete(message.requestId);
      pending.reject(new Error(message.error));
      return;
    }
    // 畸形/异常声明一律忽略(靠超时兜底),不因一条坏消息中断或撑爆内存
    const sane =
      Number.isInteger(message.seq) &&
      Number.isInteger(message.total) &&
      message.total >= 1 &&
      message.total <= MAX_SNAPSHOT_CHUNKS &&
      message.seq >= 0 &&
      message.seq < message.total;
    if (!sane) return;
    if (pending.total === 0) pending.total = message.total;
    if (pending.total !== message.total) return; // 片间声明不一致
    if (message.ignoreLines) pending.ignoreLines = message.ignoreLines;
    if (message.progress) pending.progress = message.progress;
    if (message.entries) {
      pending.chunks.set(message.seq, decodeSnapshot(Buffer.from(message.entries, 'base64')));
    }
    if (pending.chunks.size < pending.total) return;
    clearTimeout(pending.timer);
    this.pendingSnapshots.delete(message.requestId);
    const entries: SnapshotEntry[] = [];
    for (let seq = 0; seq < pending.total; seq++) {
      entries.push(...(pending.chunks.get(seq) ?? []));
    }
    pending.resolve({
      entries,
      ...(pending.ignoreLines ? { ignoreLines: pending.ignoreLines } : {}),
      ...(pending.progress ? { progress: pending.progress } : {}),
      at: Date.now(),
    });
  }

  /**
   * 对比本机某共享目录与指定对端的同一目录 id:取对端快照 → 分类差异 → 盘上复核。
   * 全程只读,不改变任何一端的状态(诊断工具不该扰动被观察的系统)。
   */
  async diffFolder(folderId: string, deviceId: string): Promise<FolderDiffResult> {
    const folder = this.folderStates.find((f) => f.id === folderId);
    if (!folder) throw new Error('共享目录不存在(可能刚被移除)');
    if (!(folder.config.devices ?? []).includes(deviceId)) {
      throw new Error('该目录未与这台设备共享,无法对比');
    }
    const snapshot = await this.fetchPeerSnapshot(deviceId, folderId);
    const diff = buildFolderDiff({
      local: folder.localIndex,
      remote: snapshot.entries,
      localRules: parseIgnoreRules(folder.ignoreLines),
      ...(snapshot.ignoreLines ? { remoteRules: parseIgnoreRules(snapshot.ignoreLines) } : {}),
    });
    checkDiffAgainstDisk(folder.path, diff.items);
    // 设备身份(版本 / 主机名 / 可达地址)直接取 describeDevice,与设备卡同源 ——
    // 两处显示的是同一份数据,不会出现「设备卡说在某地址、对比报告说在另一处」的困扰
    const link = this.describeDevice(deviceId);
    const localProgress = this.folderProgress(folder);
    const remoteProgress = snapshot.progress;
    return {
      folderId,
      folderPath: folder.path,
      deviceId,
      ...(link.version ? { deviceVersion: link.version } : {}),
      ...(link.hostname ? { deviceHostname: link.hostname } : {}),
      ...(link.url ? { deviceUrl: link.url } : {}),
      localHostname: osHostname(),
      localAddresses: getLanAddresses().map((a) => a.address),
      remoteAt: snapshot.at,
      diff,
      // 全为 0 的进度不带:那不是「此刻在传输」,带了会让报告凭空多一句
      // 「本机此刻在传输(发送 0 · 接收 0 · 待处理 0)」,把真正的提示淹掉
      ...(localProgress && isTransferring(localProgress) ? { localProgress } : {}),
      ...(remoteProgress && isTransferring(remoteProgress) ? { remoteProgress } : {}),
    };
  }

  /** 某目录此刻的传输进度(对该目录所有对端求和);全为 0 且无在传文件时返回 undefined。 */
  private folderProgress(folder: FolderState): PeerSnapshot['progress'] {
    const sum = { pending: 0, sending: 0, receiving: 0 };
    const files: TransferFile[] = [];
    for (const peer of folder.peers.values()) {
      const p = peer.getSyncProgress();
      sum.pending += p.pending;
      sum.sending += p.sending;
      sum.receiving += p.receiving;
      if (p.files) files.push(...p.files);
    }
    if (sum.pending > 0 || sum.sending > 0 || sum.receiving > 0 || files.length > 0) {
      return { ...sum, ...(files.length ? { files } : {}) };
    }
    return undefined;
  }

  /* ---------- 双栏对比:单文件读写(ADR-0013 只读原则的唯一例外) ---------- */

  /** 从对端读取它某个共享目录里单个文件的内容。离线 / 未共享 / 不存在 / 过大一律抛错。 */
  async fetchPeerFile(deviceId: string, folderId: string, path: string): Promise<PeerFileResult> {
    const session = this.peerSessions.get(deviceId);
    if (!session || !this.sessionAlive(session)) throw new Error('设备离线,无法读取对端文件');
    const requestId = randomBytes(8).toString('hex');
    return new Promise<PeerFileResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingPeerFiles.delete(requestId);
        reject(new Error('对端响应超时(20s)'));
      }, FILE_REQUEST_TIMEOUT_MS);
      this.pendingPeerFiles.set(requestId, { resolve, reject, timer });
      const sent = this.sendControlTo(deviceId, {
        kind: 'file-content-request',
        requestId,
        fromDeviceId: this.identity.deviceId,
        folderId,
        path,
      });
      if (!sent) {
        clearTimeout(timer);
        this.pendingPeerFiles.delete(requestId);
        reject(new Error('发送文件请求失败(设备可能刚离线)'));
      }
    });
  }

  /** 让对端按给定内容落盘并采纳给定版本。 */
  async writePeerFile(
    deviceId: string,
    folderId: string,
    path: string,
    data: Buffer,
    version: VersionVector,
  ): Promise<void> {
    const session = this.peerSessions.get(deviceId);
    if (!session || !this.sessionAlive(session)) throw new Error('设备离线,无法写入对端文件');
    const requestId = randomBytes(8).toString('hex');
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingPeerWrites.delete(requestId);
        reject(new Error('对端响应超时(20s):文件可能并未写入'));
      }, FILE_REQUEST_TIMEOUT_MS);
      this.pendingPeerWrites.set(requestId, { resolve, reject, timer });
      const sent = this.sendControlTo(deviceId, {
        kind: 'file-content-write',
        requestId,
        fromDeviceId: this.identity.deviceId,
        folderId,
        path,
        data: data.toString('base64'),
        entryVersion: [...version.entries()],
      });
      if (!sent) {
        clearTimeout(timer);
        this.pendingPeerWrites.delete(requestId);
        reject(new Error('发送写入请求失败(设备可能刚离线)'));
      }
    });
  }

  /**
   * 对端索取文件内容时由本机执行:回一份只读内容。
   *
   * 与索引快照共用同一道共享关系闸门 —— 目录没把对方列进 devices 就一个字节都不给,
   * 否则这条诊断通道会变成绕过共享关系的任意文件读取入口。
   */
  private servePeerFile(deviceId: string, folderId: string, path: string, requestId: string): void {
    const reply = (extra: { data?: string; size?: number; entryVersion?: Array<[string, number]>; error?: string }): void => {
      this.sendControlTo(deviceId, {
        kind: 'file-content-response',
        requestId,
        fromDeviceId: this.identity.deviceId,
        folderId,
        path,
        ...extra,
      });
    };
    const folder = this.folderStates.find(
      (f) => f.id === folderId && (f.config.devices ?? []).includes(deviceId),
    );
    if (!folder) {
      reply({ error: '该目录未共享给请求方' });
      return;
    }
    // 只认索引里登记在册的活条目:索引之外的文件(被忽略规则排除、或刚被删除)
    // 不该经这条通道被读走 —— 它反映的是「参与同步的内容」,不是磁盘全貌
    const entry = folder.localIndex.get(path);
    if (!entry || entry.deleted) {
      reply({ error: '该文件不存在(或已删除)' });
      return;
    }
    try {
      // resolveSharePath 同时挡掉硬忽略路径与符号链接越界
      const abs = resolveSharePath(folder.path, path);
      const st = statSync(abs);
      if (!st.isFile()) {
        reply({ error: '该路径不是文件' });
        return;
      }
      if (st.size > compareContentLimit(path)) {
        const limit = Math.round(compareContentLimit(path) / 1024);
        reply({
          error: `文件过大(${Math.round(st.size / 1024)}KB,上限 ${limit}KB),不支持内容对比`,
        });
        return;
      }
      const data = readFileSync(abs);
      reply({ data: data.toString('base64'), size: data.length, entryVersion: [...entry.version.entries()] });
    } catch (e) {
      reply({ error: e instanceof Error ? e.message : '读取失败' });
    }
  }

  private onPeerFileResponse(message: Extract<ControlMessage, { kind: 'file-content-response' }>): void {
    const pending = this.pendingPeerFiles.get(message.requestId);
    if (!pending) return; // 超时之后迟到的响应:直接丢弃
    clearTimeout(pending.timer);
    this.pendingPeerFiles.delete(message.requestId);
    if (message.error || message.data === undefined) {
      pending.reject(new Error(message.error ?? '对端未提供文件内容'));
      return;
    }
    pending.resolve({
      data: Buffer.from(message.data, 'base64'),
      size: message.size ?? message.data.length,
      ...(message.entryVersion ? { version: message.entryVersion } : {}),
    });
  }

  private onPeerFileWriteResult(message: Extract<ControlMessage, { kind: 'file-content-write-result' }>): void {
    const pending = this.pendingPeerWrites.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingPeerWrites.delete(message.requestId);
    if (message.ok) pending.resolve();
    else pending.reject(new Error(message.error ?? '对端写入失败'));
  }

  /**
   * 对端要求本机按给定内容落盘(对比页的「推到对端」):校验共享关系与路径,
   * 写盘后**采纳对端给定的版本**而不是自增本机计数器 —— 自增会把这次写入判成
   * 「本机新编辑」再推回对端,一次点击变成两轮无意义传输。
   */
  private async applyPeerFileWrite(message: Extract<ControlMessage, { kind: 'file-content-write' }>): Promise<void> {
    const { fromDeviceId, folderId, path, requestId } = message;
    const fail = (error: string): void => {
      this.sendControlTo(fromDeviceId, {
        kind: 'file-content-write-result',
        requestId,
        fromDeviceId: this.identity.deviceId,
        folderId,
        path,
        ok: false,
        error,
      });
    };
    const folder = this.folderStates.find(
      (f) => f.id === folderId && (f.config.devices ?? []).includes(fromDeviceId),
    );
    if (!folder) {
      fail('该目录未共享给请求方');
      return;
    }
    try {
      const data = Buffer.from(message.data, 'base64');
      if (data.length > FILE_COMPARE_MAX_BYTES) {
        fail('内容超过体积上限');
        return;
      }
      this.writeLocalFile(folder, path, data, new Map(message.entryVersion));
      this.sendControlTo(fromDeviceId, {
        kind: 'file-content-write-result',
        requestId,
        fromDeviceId: this.identity.deviceId,
        folderId,
        path,
        ok: true,
      });
      this.logger.info(`compare sync: wrote ${folderId}/${path} (${data.length}B) requested by ${fromDeviceId}`);
      this.notifyStatus();
    } catch (e) {
      fail(e instanceof Error ? e.message : '写入失败');
    }
  }

  /**
   * 原子写文件并以**给定版本**登记索引(写临时文件 + rename,与执行器同一套落地方式)。
   * 版本由调用方给:这是「按指定内容对齐」,不是本机新编辑。
   */
  private writeLocalFile(folder: FolderState, path: string, data: Buffer, version: VersionVector): IndexEntry {
    const abs = resolveSharePath(folder.path, path);
    mkdirSync(dirname(abs), { recursive: true });
    const tmp = `${abs}.syncx-tmp`;
    writeFileSync(tmp, data);
    renameSync(tmp, abs);
    const entry: IndexEntry = {
      path,
      version,
      size: data.length,
      deleted: false,
      blocks: splitIntoBlocks(data).map(hashBlock),
      mtime: statSync(abs).mtimeMs,
    };
    folder.index.saveEntry(entry);
    folder.localIndex.set(path, entry);
    return entry;
  }

  /** 双栏对比:差异分类之外再给出两侧条目清单(见 FolderCompareResult)。全程只读。 */
  async compareFolder(folderId: string, deviceId: string): Promise<FolderCompareResult> {
    const folder = this.folderStates.find((f) => f.id === folderId);
    if (!folder) throw new Error('共享目录不存在(可能刚被移除)');
    if (!(folder.config.devices ?? []).includes(deviceId)) {
      throw new Error('该目录未与这台设备共享,无法对比');
    }
    const snapshot = await this.fetchPeerSnapshot(deviceId, folderId);
    const diff = buildFolderDiff({
      local: folder.localIndex,
      remote: snapshot.entries,
      localRules: parseIgnoreRules(folder.ignoreLines),
      ...(snapshot.ignoreLines ? { remoteRules: parseIgnoreRules(snapshot.ignoreLines) } : {}),
    });
    checkDiffAgainstDisk(folder.path, diff.items);
    const link = this.describeDevice(deviceId);
    const localProgress = this.folderProgress(folder);
    const remoteProgress = snapshot.progress;
    return {
      folderId,
      folderPath: folder.path,
      deviceId,
      ...(link.version ? { deviceVersion: link.version } : {}),
      ...(link.hostname ? { deviceHostname: link.hostname } : {}),
      ...(link.url ? { deviceUrl: link.url } : {}),
      localHostname: osHostname(),
      localAddresses: getLanAddresses().map((a) => a.address),
      remoteAt: snapshot.at,
      diff,
      local: [...folder.localIndex.values()].map(toSnapshotEntry),
      remote: snapshot.entries,
      ...(localProgress && isTransferring(localProgress) ? { localProgress } : {}),
      ...(remoteProgress && isTransferring(remoteProgress) ? { remoteProgress } : {}),
    };
  }

  /**
   * 字节 → 一侧的内容状态(本机读取与对端回传共用同一条判据,避免两侧对「能不能预览」
   * 各有一套说法)。图片给预览、文本给内容,**两者可以同时成立**:`.svg` 既是图片又是
   * 可读文本,前端在两种视图间切换;raster 图片只给 image(同时 binary=true,那是事实)。
   *
   * 文本只在文本上限内附上:一张 5 MiB 的图不该顺带跑一次 UTF-8 往返校验、再让浏览器
   * 拿它去逐行差异。空文件不给 image —— `data:` 空串只会渲染成一个坏图标。
   */
  private describeBytes(
    path: string,
    bytes: Buffer,
  ): { text?: string; binary?: boolean; image?: { mime: string; data: string } } {
    const out: { text?: string; binary?: boolean; image?: { mime: string; data: string } } = {};
    const mime = imageMimeOf(path);
    if (mime && bytes.length > 0) out.image = { mime, data: bytes.toString('base64') };
    const text = bytes.length <= TEXT_COMPARE_MAX_BYTES ? decodeText(bytes) : undefined;
    if (text === undefined) out.binary = true;
    else out.text = text;
    return out;
  }

  /** 读本机某文件在对比弹窗里的一侧状态(越界 / 缺失 / 二进制 / 过大都如实标记)。 */
  private readLocalFileForCompare(folder: FolderState, path: string): FileSideState {
    const v = folder.localIndex.get(path);
    const version = v ? [...v.version.entries()] : undefined;
    const withVersion = (state: FileSideState): FileSideState =>
      version ? { ...state, version } : state;
    try {
      const abs = resolveSharePath(folder.path, path);
      const st = statSync(abs);
      if (!st.isFile()) return withVersion({ exists: false });
      if (st.size > compareContentLimit(path)) {
        return withVersion({ exists: true, size: st.size, tooLarge: true });
      }
      return withVersion({
        exists: true,
        size: st.size,
        ...this.describeBytes(path, readFileSync(abs)),
      });
    } catch {
      return withVersion({ exists: false });
    }
  }

  /** 本机文件字节;不存在 / 越界 / 非文件 / 超过(按类型的)上限时返回 undefined。 */
  private tryReadLocalBytes(folder: FolderState, path: string): Buffer | undefined {
    try {
      const abs = resolveSharePath(folder.path, path);
      const st = statSync(abs);
      if (!st.isFile() || st.size > compareContentLimit(path)) return undefined;
      return readFileSync(abs);
    } catch {
      return undefined;
    }
  }

  /** 同一个文件在本机与对端的两侧状态(内容对比弹窗的数据源)。只读。 */
  /**
   * 冲突收件箱「查看对比」的数据源:本机侧的两个文件(原文件 vs 冲突副本)。
   * 形状与 readFilePair 完全一致(local=原文件当前内容即对端版,remote=被让位的本机旧版),
   * 前端复用同一个对比弹窗;deviceId 从副本命名反解,标出冲突来源。
   */
  readConflictPair(folderId: string, copyPath: string): FileCompareResult {
    const folder = this.folderStates.find((f) => f.id === folderId);
    if (!folder) throw new Error('共享目录不存在(可能刚被移除)');
    const cut = copyPath.lastIndexOf('/') + 1;
    const parsed = parseConflictCopy(copyPath.slice(cut));
    if (!parsed) throw new Error('不是冲突副本命名');
    const originalRel = copyPath.slice(0, cut) + parsed.originalPath;
    return {
      folderId,
      folderPath: folder.path,
      deviceId: parsed.deviceId,
      path: originalRel,
      local: this.readLocalFileForCompare(folder, originalRel),
      remote: this.readLocalFileForCompare(folder, copyPath),
    };
  }

  async readFilePair(folderId: string, deviceId: string, path: string): Promise<FileCompareResult> {
    const folder = this.folderStates.find((f) => f.id === folderId);
    if (!folder) throw new Error('共享目录不存在(可能刚被移除)');
    if (!(folder.config.devices ?? []).includes(deviceId)) {
      throw new Error('该目录未与这台设备共享,无法对比');
    }
    const local = this.readLocalFileForCompare(folder, path);
    let remote: FileSideState;
    try {
      const r = await this.fetchPeerFile(deviceId, folderId, path);
      remote = {
        exists: true,
        size: r.size,
        ...this.describeBytes(path, r.data),
        ...(r.version ? { version: r.version } : {}),
      };
    } catch (e) {
      // 对端离线 / 文件不存在 / 过大:都要如实交给弹窗,由它决定怎么提示
      remote = { exists: false, error: e instanceof Error ? e.message : '读取对端文件失败' };
    }
    return { folderId, folderPath: folder.path, deviceId, path, local, remote };
  }

  /**
   * 把一侧文件的内容同步到另一侧(对比页的「逐块应用 / 整文件覆盖」)。
   *
   * 唯一需要小心的是**版本怎么给**:
   *  - 写入后两侧内容完全一致 → 两侧都置为 merge(本地,对端):立刻收敛,不再互推;
   *  - 只应用了部分差异块(两侧仍不同) → 目标侧置为 merge 后再自增**目标设备**的
   *    计数器,即把它当作目标侧的一次真实编辑,由正常同步把它传播过去收敛。
   *
   * 第二种情况下绝不能把两侧版本设成相等 —— 那就是 ADR-0013 里最强的异常信号
   * 「版本相同但内容不同」:两端都以为一致,这份差异会永远沉下去。
   */
  async applyFileSync(opts: {
    folderId: string;
    deviceId: string;
    path: string;
    direction: 'pull' | 'push';
    /** 目标侧最终内容;省略表示「照抄来源侧整文件」。 */
    content?: string;
  }): Promise<void> {
    const { folderId, deviceId, path, direction, content } = opts;
    const folder = this.folderStates.find((f) => f.id === folderId);
    if (!folder) throw new Error('共享目录不存在(可能刚被移除)');
    if (!(folder.config.devices ?? []).includes(deviceId)) {
      throw new Error('该目录未与这台设备共享,无法同步');
    }
    const localEntry = folder.localIndex.get(path);
    const localBytes = this.tryReadLocalBytes(folder, path);

    // 即便内容由前端给定,也要读一次对端:版本向量必须来自对端索引,不能用前端传的
    let remoteData: Buffer | undefined;
    let remoteVersion: VersionVector = createVersionVector();
    try {
      const r = await this.fetchPeerFile(deviceId, folderId, path);
      remoteData = r.data;
      remoteVersion = new Map(r.version ?? []);
    } catch (e) {
      if (direction === 'pull') {
        throw new Error(`读取对端文件失败:${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const merged = mergeVersions(localEntry?.version ?? createVersionVector(), remoteVersion);

    if (direction === 'pull') {
      const target = content !== undefined ? Buffer.from(content, 'utf8') : remoteData;
      if (!target) throw new Error('对端文件内容不可用,无法拉取');
      const identical = !!remoteData && Buffer.compare(target, remoteData) === 0;
      const version = identical ? merged : incrementVersion(merged, this.identity.deviceId);
      this.writeLocalFile(folder, path, target, version);
      recordSyncEvent(this.configPath, {
        ts: Date.now(), path, action: 'update', direction: 'remote', deviceId, folderId,
      });
    } else {
      const target = content !== undefined ? Buffer.from(content, 'utf8') : localBytes;
      if (!target) throw new Error('本机文件不存在或过大,无法推送');
      const identical = !!localBytes && Buffer.compare(target, localBytes) === 0;
      const remoteTarget = identical ? merged : incrementVersion(merged, deviceId);
      await this.writePeerFile(deviceId, folderId, path, target, remoteTarget);
      // 本机内容没动,但版本要跟到 merge:否则本机仍以旧版本自居,下一轮会把
      // 同一份内容当作「本机较新」再推一次
      if (localEntry) {
        const updated: IndexEntry = { ...localEntry, version: merged };
        folder.index.saveEntry(updated);
        folder.localIndex.set(path, updated);
      }
      recordSyncEvent(this.configPath, {
        ts: Date.now(), path, action: 'update', direction: 'local', deviceId, folderId,
      });
    }
    this.notifyStatus();
  }

  /**
   * 连接建立后,把本机「共享意图」推送给对端:
   * - 每个把对端列入 devices 的共享目录 → 发目录共享邀请(对端去重,已 mutual 则跳过)
   * - 对端在 knownDevices → 发配对请求
   * 这样无论谁先上线,对方上线并互连后都会收到待确认项;离线期间累积的意图在重连时自动补发。
   */
  private pushSharesTo(session: ActiveSession): void {
    const current = loadConfig(this.configPath);
    for (const f of current.sharedFolders) {
      if ((f.devices ?? []).includes(session.remoteDeviceId)) {
        this.sendControlTo(session.remoteDeviceId, {
          kind: 'folder-invitation',
          offerId: makeOfferId('folder', session.remoteDeviceId, folderIdFor(f)),
          fromDeviceId: this.identity.deviceId,
          folderId: folderIdFor(f),
          folderName: folderIdFor(f),
        });
      }
    }
    if (current.knownDevices.some((d) => d.id === session.remoteDeviceId)) {
      this.sendControlTo(session.remoteDeviceId, {
        kind: 'pairing-request',
        offerId: makeOfferId('pair', session.remoteDeviceId),
        fromDeviceId: this.identity.deviceId,
      });
    }
  }

  /** 对端已在线时立即补发配对请求与既有目录邀请(addDevice 等信任动作后调用)。 */
  notifyPairingIntent(deviceId: string): void {
    if (!this.isPeerConnected(deviceId)) return;
    this.sendControlTo(deviceId, {
      kind: 'pairing-request',
      offerId: makeOfferId('pair', deviceId),
      fromDeviceId: this.identity.deviceId,
    });
    const session = this.peerSessions.get(deviceId);
    if (session) this.pushSharesTo(session);
  }

  /**
   * 确认配对 / 目录共享后,本机已信任该对端:在其已有会话上补建目录 peer 并推送本机共享意图,
   * 使离线期间建立的「仅控制面」会话升级为可同步。无存活会话(对端尚未连)时静默跳过,
   * 连接建立时 startSyncSession 会按 allowed 自动附加目录。
   */
  promoteSession(remoteDeviceId: string): void {
    const session = this.peerSessions.get(remoteDeviceId);
    if (!session) return;
    this.reconcileSessionFolders(session);
    this.pushSharesTo(session);
    // 共享意图变化(如刚接受邀请新建目录)后,同步重推目录清单
    this.pushFolderSyncList(session.remoteDeviceId);
  }

  /** 在一个 socket 上建立同步会话:为每个共享目录建 peer,按 folder 路由;并推送本机共享意图。 */
  private startSyncSession(socket: WebSocket, remoteDeviceId: string, key: Buffer, url?: string): void {
    this.registerPeer(remoteDeviceId, url);
    this.peerSockets.add(socket);
    // 心跳探活:初始视为存活,收到 pong 刷新为存活;心跳 tick 会先置 false 再 ping,
    // 若此后无 pong 则在下一轮被 terminate(见 startHeartbeat)。
    this.peerLiveness.set(socket, true);
    socket.on('pong', () => {
      this.peerLiveness.set(socket, true);
    });
    const session: ActiveSession = {
      socket,
      key,
      remoteDeviceId,
      peers: new Map<string, SyncPeer>(),
      transports: [],
    };
    this.activeSessions.push(session);
    // 版本握手:双方各发一次 hello,设备卡显示对端版本与主机名,并据此计算「可否从对方升级」
    sendControlMessage(socket, key, {
      kind: 'hello',
      fromDeviceId: this.identity.deviceId,
      version: runtimeVersion(),
      hostname: osHostname(),
    });
    // 书签策略:仅当当前书签缺失或其 socket 已死时才移交给新会话。
    // 健康的当前会话保持不动(重复连接照常注册为备份,handlers 可收消息);
    // 若此处覆盖了健康书签,而这条新连接随即被对端关闭,书签就会孤儿化。
    const current = this.peerSessions.get(remoteDeviceId);
    if (!current || !this.sessionAlive(current)) {
      this.peerSessions.set(remoteDeviceId, session);
    }
    // 仅对「已互相信任」(在 knownDevices 或某共享目录 devices 中)的对端附加目录 peer 并交换索引;
    // 未确认的对端此时仅建立控制面会话,用于接收配对 / 目录共享邀请并弹「待确认」,不泄漏文件索引。
    const allowed = isPeerAllowed(remoteDeviceId, loadConfig(this.configPath).sharedFolders, loadConfig(this.configPath).knownDevices);
    if (allowed) {
      this.reconcileSessionFolders(session);
      // 连接就绪后把本机当前的配对 / 目录共享意图推送给对端(对方会弹「待确认」)
      this.pushSharesTo(session);
    } else {
      // 设计:未授权对端不断连(否则对方收不到配对请求、弹不出「待确认」),
      // 但文件同步被上面 allowed 闸门挡住,不会泄漏任何目录内容。这里仅记录一条
      // 日志,便于排查「对方在线却不同步」而非「被拒」。
      this.logger.info(`peer ${remoteDeviceId} connected but not authorized for any shared folder; control-only session until trusted`);
    }
    // 无条件宣告目录清单(不再受 allowed 约束):
    // - 已授权:对端 UI 据此区分 同步中 / 已停止共享
    // - 未授权:syncFolderIdsFor 会过滤掉未指派给该对端的目录 → 列表为空,不泄漏任何目录信息;
    //   但对端若曾持有一张来自本机的目录邀请,空清单即「本机已撤销」的信号,可据此清理残留卡片
    //   (否则删掉唯一一个共享目录后,allowed 变 false,清单永远不发,对方的卡片不会消失)
    this.pushFolderSyncList(remoteDeviceId);
    attachPeerMessages(session.peers, socket, key, (message) => {
      // 已关闭:不再处理任何入站控制消息。close() 用 terminate() 硬断 socket,
      // 但已排入事件循环的消息仍会到达 —— 那时索引库已关、配置锁已释放,继续
      // 处理会去碰已关闭的资源(folder-sync-list 会触发 mutateConfig 重写配置,
      // 在测试里表现为对已删除目录重试 5s 后抛 config lock timeout)。
      if (this.closed) return;
      // 版本 / 主机名随每条控制消息携带(hello 必然带,其余控制消息也在发送侧注入)。
      // 即便一次性 hello 在双连接 / 重连抖动中丢失,只要任意一条控制消息到达,
      // 对端版本即可被学到 —— 设备卡不再偶发「版本未知」。用消息里的 fromDeviceId
      // 而非会话 remoteDeviceId,确保严格按照对端身份缓存(与书签会话解耦)。
      if (message.version || message.hostname) {
        const prev = this.peerInfo.get(message.fromDeviceId);
        this.peerInfo.set(message.fromDeviceId, {
          version: message.version ?? prev?.version,
          hostname: message.hostname ?? prev?.hostname,
        });
        // 仅当版本首次学到或发生变化时记录,避免每条控制消息都刷日志
        // (现在 pairing / invitation / folder-sync-list 都带版本)
        if (message.version && message.version !== prev?.version) {
          this.logger.info(`peer ${message.fromDeviceId} runs syncx ${message.version}${message.hostname ? ` (host ${message.hostname})` : ''}`);
          // 设备卡上的对端版本/主机名/可否升级都依赖它,首次学到时立即刷新
          this.notifyStatus();
        }
      }
      if (message.kind === 'hello') return;
      if (message.kind === 'self-binary-response') {
        this.pendingBinary.get(message.requestId)?.(message);
        this.pendingBinary.delete(message.requestId);
        return;
      }
      if (message.kind === 'folder-sync-list') {
        session.remoteFolders = new Set(message.folderIds);
        // 新字段可选:旧版本对端不发送 → 记为空集,UI 退回「已停止共享」旧判断
        session.remotePendingFolders = new Set(message.pendingFolderIds ?? []);
        // 对端宣告的 folderIds 即「它当前仍共享给本机的目录集合」:据此清理本机上
        // 来源为该对端、已被对方撤销的待确认目录邀请(对方删除共享后不再残留卡片)。
        const pruned = pruneRevokedOffers(this.configPath, remoteDeviceId, message.folderIds);
        if (pruned > 0) {
          this.logger.info(`pruned ${pruned} revoked folder invitation(s) from ${remoteDeviceId}`);
        }
        this.logger.info(`folder sync list from ${remoteDeviceId}: ${message.folderIds.length} folder(s)`);
        // 设备卡上的「已停止共享 / 待对方确认」判定完全依赖这份清单,且对方可能在
        // 本端重连后立刻重播 —— 立即通知,避免界面停留在过期的共享状态
        this.notifyStatus();
        return;
      }
      this.onControl(message);
    });
    // 会话建立即改变了在线状态与各目录的同步通道(进度会随之从 0 变成非 0)
    this.notifyStatus();
    socket.on('error', (error) => this.logger.debug(`socket error for peer ${remoteDeviceId}: ${error.message}`));
    socket.on('close', (code, reason) => {
      this.logger.debug(`socket closed for peer ${remoteDeviceId}, code=${code}, reason=${reason?.toString('utf8') ?? '(empty)'}`);
      this.peerSockets.delete(socket);
      this.peerLiveness.delete(socket);
      const sessionIdx = this.activeSessions.indexOf(session);
      if (sessionIdx >= 0) this.activeSessions.splice(sessionIdx, 1);
      for (const { folder, transport } of session.transports) {
        const idx = folder.transports.indexOf(transport);
        if (idx >= 0) folder.transports.splice(idx, 1);
        // 仅当 folder.peers 里登记的仍是本会话的 peer 时才删除:
        // 会话被新连接接管后,新会话可能已登记了自己的 peer,不能误删
        const myPeer = session.peers.get(folder.id);
        if (myPeer && folder.peers.get(remoteDeviceId) === myPeer) {
          folder.peers.delete(remoteDeviceId);
        }
      }
      // 书签会话断开:先把书签移交给该设备其余存活会话(备份连接,若有),
      // 没有才清书签并排定重连。被关掉的只是非书签备份会话时不做任何事。
      if (this.peerSessions.get(remoteDeviceId) === session) {
        const backup = this.activeSessions.find(
          (s) => s.remoteDeviceId === remoteDeviceId && this.sessionAlive(s),
        );
        if (backup) {
          this.peerSessions.set(remoteDeviceId, backup);
        } else {
          this.peerSessions.delete(remoteDeviceId);
          this.scheduleReconnect(remoteDeviceId);
        }
      }
      // 掉线会同时改变设备卡的在线标记与各目录的传输进度
      this.notifyStatus();
    });
  }

  /**
   * 入站连接入口(peer server 回调):授权恒通过;学习对端可达地址并持久化
   * (反向发现,重启后本机也能主动重连),然后建立同步会话。
   */
  onInboundPeer(socket: WebSocket, remoteDeviceId: string, key: Buffer, listenPort?: number): void {
    this.logger.debug(`inbound peer connected: ${remoteDeviceId}`);
    if (!this.acceptPeer()) return;
    // 连接方在握手 kx 中广播了监听端口:结合源 IP 拼出反向地址并交给 startSyncSession
    // 记录到 outboundPeerUrls,使本机也能主动重连对端(只填一方地址即可双向重连)
    const learnedUrl = learnPeerUrl(socket, listenPort);
    if (learnedUrl) {
      this.logger.info(`learned peer ${remoteDeviceId} reachable at ${learnedUrl} (reverse discovery)`);
      // 持久化反向发现的地址:重启 daemon 后本机也能主动重连对方,不依赖对方先连过来
      // (原仅存内存 outboundPeerUrls,重启即丢)。addPeer 幂等去重,且 learnedUrl 已保证 ws:// 格式
      try {
        addPeer(this.configPath, learnedUrl);
      } catch {
        // learnedUrl 必为 ws://,正常情况下不会抛
      }
    }
    this.startSyncSession(socket, remoteDeviceId, key, learnedUrl);
  }

  /* ==================== 目录清单宣告与状态查询 ==================== */

  /**
   * 本机当前与某对端同步的目录 id 列表(folderIdFor 口径,与 invitations 一致)。
   * 会话建立与共享关系变更时经 folder-sync-list 宣告给对端。
   */
  private syncFolderIdsFor(deviceId: string): string[] {
    return loadConfig(this.configPath)
      .sharedFolders.filter((f) => (f.devices ?? []).includes(deviceId))
      .map((f) => folderIdFor(f));
  }

  /** 本机仍待确认的、来自某对端的目录邀请 id 列表(pendingOffers 口径)。
   *  宣告给对端后,对方据此把设备标签显示为「待对方确认」而非「已停止共享」。 */
  private pendingFolderIdsFor(deviceId: string): string[] {
    return loadConfig(this.configPath)
      .pendingOffers.filter((o) => o.status === 'pending' && o.kind === 'folder' && o.fromDeviceId === deviceId)
      .map((o) => o.folderId)
      .filter((id): id is string => id !== undefined);
  }

  /** 向对端宣告本机当前与其同步的目录清单;对端离线则忽略(重连时会话建立时重发)。 */
  pushFolderSyncList(deviceId: string): void {
    this.sendControlTo(deviceId, {
      kind: 'folder-sync-list',
      fromDeviceId: this.identity.deviceId,
      folderIds: this.syncFolderIdsFor(deviceId),
      pendingFolderIds: this.pendingFolderIdsFor(deviceId),
    });
  }

  /**
   * 向指定对端推送目录共享邀请(控制面 folder-invitation)。
   * 仅对当前在线的对端推送;离线对端由 pushSharesTo 在重连时补推,
   * 接收侧按 (from, kind, folderId) 去重,幂等安全。
   */
  pushFolderInvitation(deviceId: string, folderId: string, folderName: string): void {
    if (!this.isPeerConnected(deviceId)) {
      this.logger.info(`folder invitation deferred: ${deviceId} offline (will push on reconnect)`);
      return;
    }
    const ok = this.sendControlTo(deviceId, {
      kind: 'folder-invitation',
      offerId: makeOfferId('folder', deviceId, folderId),
      fromDeviceId: this.identity.deviceId,
      folderId,
      folderName,
    });
    if (!ok) this.logger.warn(`folder invitation to ${deviceId} could not be delivered (no live session)`);
  }

  /** 某对端的连接信息(在线/地址/对端宣告的目录清单/对端版本/对端主机名),供 status 组装。 */
  describeDevice(deviceId: string): DeviceLinkInfo {
    const session = this.peerSessions.get(deviceId);
    return {
      online: this.isPeerConnected(deviceId),
      url: this.outboundPeerUrls.get(deviceId),
      remoteFolders: session?.remoteFolders ? [...session.remoteFolders] : undefined,
      remotePendingFolders: session?.remotePendingFolders ? [...session.remotePendingFolders] : [],
      version: this.peerInfo.get(deviceId)?.version,
      hostname: this.peerInfo.get(deviceId)?.hostname,
    };
  }

  /** 各目录进行中的同步进度(仅非零项),供 status 下发。 */
  getSyncProgress(): Array<{ folder: string } & ReturnType<SyncPeer['getSyncProgress']>> {
    const result: Array<{ folder: string } & ReturnType<SyncPeer['getSyncProgress']>> = [];
    for (const folder of this.folderStates) {
      for (const peer of folder.peers.values()) {
        const progress = peer.getSyncProgress();
        if (progress.pending > 0 || progress.sending > 0 || progress.receiving > 0) {
          result.push({ folder: folder.id, ...progress });
        }
      }
    }
    return result;
  }

  /** 记录一次中转活动(本机把 from 的目录变更中转给了同目录的 to);环形缓冲,溢出丢弃最旧。 */
  private recordRelay(folder: string, from: string, to: string, at: number): void {
    this.relayActivity.push({ folder, from, to, at });
    if (this.relayActivity.length > SyncSessionManager.RELAY_ACTIVITY_CAP) {
      this.relayActivity.splice(0, this.relayActivity.length - SyncSessionManager.RELAY_ACTIVITY_CAP);
    }
  }

  /** 返回最近的中转活动副本(拓扑视图用);空数组表示尚无中转。 */
  getRelayActivity(): RelayActivity[] {
    return this.relayActivity.slice();
  }

  /** 全部目录的索引统计(条目/墓碑数)。 */
  getIndexStats(): { entries: number; tombstones: number } {
    let entries = 0;
    let tombstones = 0;
    for (const folder of this.folderStates) {
      // 走 COUNT(*) 聚合而非 listEntries():后者要全表 SELECT 并逐行反序列化
      // version/blocks,而本方法被状态接口与每一帧推送调用(高频)。
      const counts = folder.index.countEntries();
      entries += counts.entries;
      tombstones += counts.tombstones;
    }
    return { entries, tombstones };
  }

  /**
   * 每目录的冲突副本残留数(目录卡「冲突 N」徽标)。
   * 走索引的 LIKE COUNT —— status 是高频推送,不能在这里扫盘或反序列化全表;
   * 徽标只是入口提示,精确列表以冲突收件箱的实时扫盘(listConflictCopies)为准。
   * 键为 wire 目录 id,与前端 folderKey(f.id ?? f.path) 对齐。
   */
  folderConflictCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const folder of this.folderStates) {
      const n = folder.index.countConflictEntries?.() ?? 0;
      if (n > 0) out[folder.id] = n;
    }
    return out;
  }

  /** 传输统计累计 + 采样序列(buildStatus extras.traffic;重启清零)。 */
  getTrafficStats(): TrafficStats {
    return this.traffic.snapshot();
  }

  /* ==================== 暂停同步 ==================== */

  /** 某目录此刻是否处于暂停:目录自己的 paused 或全局 paused,任一生效即暂停。 */
  private folderPausedNow(folder: FolderState): boolean {
    return this.globalPaused || folder.config.paused === true;
  }

  /**
   * 暂停状态变化的统一生效点:对所有存活会话重新对账目录通道 ——
   * 暂停即摘除数据通道(出站不再广播、入站被忽略),恢复即重挂并发送全量索引。
   * 控制面不受影响:连接保持在线,配对 / 邀请 / 版本宣告照常。
   */
  private applyPausedState(): void {
    for (const session of this.activeSessions) {
      this.reconcileSessionFolders(session);
    }
    this.notifyStatus();
  }

  /** 设置某目录的暂停状态:落盘 + 立即生效(对存活会话对账)。 */
  setFolderPaused(folderId: string, paused: boolean): void {
    setFolderPaused(this.configPath, folderId, paused);
    const folder = this.folderStates.find((f) => f.id === folderId);
    if (folder) folder.config.paused = paused;
    this.applyPausedState();
    this.logger.info(`folder sync ${paused ? 'paused' : 'resumed'}: ${folderId}`);
  }

  /**
   * 「目录不可信」时的轻量恢复:重新采集并写回 folderIdentity,索引与实例完全不动。
   * 比「移除并重新添加」(会开新空索引库重建基线)安全得多,替代原先只能手改
   * config.json 的自救路径。防护:
   *  - 目录当前读不到身份(不存在/未挂载/无权限)时**拒绝采集** —— 不能把空挂载点
   *    确认成合法身份,这正是本守卫要拦的事;
   *  - 是否「同一块盘/同一份数据」由前端二次确认交用户判断(重挂场景文案更明确)。
   * 写回后清错误、立即补一轮扫描让目录恢复同步。
   */
  reAdoptFolderIdentity(folderId: string): void {
    const folder = this.folderStates.find((f) => f.id === folderId);
    if (!folder) throw new Error('共享目录不存在(可能刚被移除)');
    const identity = readFolderIdentity(folder.path);
    if (identity === null) throw new Error('目录当前不可读(不存在 / 未挂载?),拒绝采集身份');
    mutateConfig(this.configPath, (config) => {
      const f = config.sharedFolders.find((x) => folderIdFor(x) === folderId);
      if (!f) throw new Error('共享目录不存在');
      f.folderIdentity = identity;
    });
    folder.config.folderIdentity = identity;
    this.clearFolderError(folder.id);
    this.logger.info(`folder identity re-adopted: ${folderId} dev=${identity.dev} ino=${identity.ino}`);
    void this.runScan();
  }

  /** 设置全局暂停:所有目录一起停摆;各目录自己的 paused 独立保留,恢复全局后仍生效。 */
  setGlobalPaused(paused: boolean): void {
    setGlobalPaused(this.configPath, paused);
    this.globalPaused = paused;
    this.applyPausedState();
    this.logger.info(`global sync ${paused ? 'paused' : 'resumed'}`);
  }

  /* ==================== 配置热重载与关闭 ==================== */

  /**
   * 配置热重载:增量应用共享目录与对端列表变更,无需重启 daemon。
   * 返回重新加载后的 config(调用方据此更新内存副本);解析失败返回 undefined(已记日志)。
   */
  reloadConfig(): ReturnType<typeof loadConfig> | undefined {
    try {
      const newConfig = loadConfig(this.configPath);
      // 全局暂停随重载同步:手改 config.json 的 paused 也能实时生效(下方 reconcile 统一摘挂)
      this.globalPaused = newConfig.paused === true;

      // 共享目录变更:新增/移除/更新
      const newFolderById = new Map(newConfig.sharedFolders.map((f) => [folderIdFor(f), f]));
      // 路径 → 新 folderId:用于识别「同一路径被重新指派了 id」(接下邀请时的 id 对齐 / 手改配置)
      const newIdByPath = new Map(newConfig.sharedFolders.map((f) => [resolve(f.path), folderIdFor(f)]));
      // 移除已删除的目录:关闭索引库,并从所有存活会话的路由表中摘除该目录
      for (const folder of this.folderStates) {
        if (!newFolderById.has(folder.id)) {
          this.logger.info(`config updated: removing shared folder ${folder.path}`);
          for (const session of this.activeSessions) {
            session.peers.delete(folder.id);
            session.transports = session.transports.filter((t) => t.folder.id !== folder.id);
          }
          folder.peers.clear();
          folder.index.close();
          // 关闭连接后再删索引库:此时文件已无持有者,Windows 下也能安全 unlink。
          // 两种情形都要删掉旧库:
          //  1) 用户移除目录并勾选「同时删除索引库」→ pendingIndexPurge 已登记;
          //  2) 同一路径的 folderId 被重新指派(id 对齐 / 手改配置)→ 旧 id 的索引库再无人
          //     引用,属于不可达垃圾;留着会在 id 兜回来时复用旧条目与旧墓碑,成批误删对端。
          const rekeyed =
            newIdByPath.has(resolve(folder.path)) && newIdByPath.get(resolve(folder.path)) !== folder.id;
          if (this.pendingIndexPurge.has(folder.indexKey) || rekeyed) {
            const purged = purgeFolderIndex(this.configDir, folder.indexKey);
            if (purged) {
              this.pendingIndexPurge.delete(folder.indexKey);
              this.logger.info(
                `index purged${rekeyed ? ' (folder re-keyed)' : ''}: ${folderIndexPath(this.configDir, folder.indexKey)}`,
              );
            } else if (!existsSync(folderIndexPath(this.configDir, folder.indexKey))) {
              // 文件本就不存在(此前已删):视为清理完成,不再反复重试
              this.pendingIndexPurge.delete(folder.indexKey);
            } else {
              // 仍被占用:保留登记,下次 reload / 重启后重试,避免静默残留
              this.logger.warn(`index purge failed, will retry: ${folderIndexPath(this.configDir, folder.indexKey)}`);
            }
          }
        }
      }
      this.folderStates = this.folderStates.filter((f) => newFolderById.has(f.id));
      // 新增目录:创建运行期状态;已存在目录则应用最新配置(路径变更重建执行器)
      for (const f of newConfig.sharedFolders) {
        const id = folderIdFor(f);
        const existing = this.folderStates.find((s) => s.id === id);
        if (!existing) {
          this.logger.info(`config updated: adding shared folder ${f.path}`);
          let folder: FolderState;
          try {
            folder = this.createFolderState(f);
          } catch (error) {
            // 热重载建状态失败(索引库打开失败等):归到该目录的错误提示,不影响其它目录
            this.recordFolderError(folderIdFor(f), error, '加载目录失败');
            continue;
          }
          // 新目录实例的索引必然为空 → 扫描只可能「发送」、绝不可能产生墓碑(墓碑只来自
          // 索引里已有的条目),此时采集身份指纹是安全的(见 adoptFolderIdentityIfSafe)。
          this.adoptFolderIdentityIfSafe(f, folder.index);
          this.folderStates.push(folder);
        } else {
          const nextIndexKey = folderIndexKey(f);
          if (existing.indexKey !== nextIndexKey) {
            // 目录实例变化(同 id 移除后重加 / 接受邀请重新指派):必须换用新实例的索引库。
            // 若继续沿用旧库,「目录实例化」就形同虚设 —— 旧条目/旧墓碑仍会参与对账,
            // 把磁盘上已不存在的旧条目当「本地删除」广播出去,成批删掉对端文件。
            // 先建新状态(失败则保留旧状态继续运行),再关旧库并替换,避免中途失败留下空档。
            let replacement: FolderState;
            try {
              replacement = this.createFolderState(f);
            } catch (error) {
              this.recordFolderError(id, error, '加载目录失败');
              continue;
            }
            this.logger.info(`config updated: folder instance changed, reloading ${f.path}`);
            for (const session of this.activeSessions) {
              if (session.peers.has(id)) this.detachFolderFromSession(session, existing);
            }
            existing.peers.clear();
            existing.index.close();
            if (purgeFolderIndex(this.configDir, existing.indexKey)) {
              this.logger.info(
                `index purged (folder instance changed): ${folderIndexPath(this.configDir, existing.indexKey)}`,
              );
            }
            const idx = this.folderStates.indexOf(existing);
            if (idx !== -1) this.folderStates[idx] = replacement;
            // 新实例的同步通道由下方 reconcile 统一挂到所有存活会话上
            continue;
          }
          if (existing.path !== f.path) {
            // 路径变更:以新路径重建执行器与本地索引(索引库按目录实例 key 复用)。
            // 注意身份指纹**不随之更新**:换了指向的目录就是换了身份,下一次扫描必然
            // 校验失败并暂停该目录(与旧的「新路径没有标记文件」等价),等用户显式
            // 「移除并重新添加」再建立新身份 —— 否则新目录里的文件会被当成「本机新增」
            // 全量推给对端,而索引里的旧路径全部变成墓碑。
            existing.path = f.path;
            existing.executor = createLocalExecutor(
              f.path,
              existing.index,
              folderTrashPath(this.configDir, existing.indexKey),
              folderVersionsPath(this.configDir, existing.indexKey),
            );
            existing.localIndex = new Map(
              filterIndexedEntries(parseIgnoreRules(existing.ignoreLines), existing.index.listEntries()).map((e) => [e.path, e]),
            );
          }
          // 接收模式变更:旧 peer 仍以旧模式运行,需从所有会话摘除后由下方 reconcile 重建
          const prevReceiveOnly = existing.config.receiveOnly ?? false;
          const nextReceiveOnly = f.receiveOnly ?? false;
          existing.config = f;
          if (prevReceiveOnly !== nextReceiveOnly) {
            for (const session of this.activeSessions) {
              if (session.peers.has(id)) this.detachFolderFromSession(session, existing);
            }
          }
        }
      }

      // 目录集合/设备指派变更后,对所有存活会话统一对账:
      // 新目录补挂、devices 新增设备补挂(修「邀请确认前通道未建」)、
      // devices 移除设备摘除通道(不再向无权接收的对端推变更)。
      for (const session of this.activeSessions) {
        this.reconcileSessionFolders(session);
      }

      // 共享关系可能变化(手动改配置文件):向所有存活会话重推目录清单
      for (const session of this.activeSessions) {
        this.pushFolderSyncList(session.remoteDeviceId);
      }
      // 目录增删/改路径/改接收模式都会改变状态接口的下发内容
      this.notifyStatus();
      return newConfig;
    } catch (error) {
      this.logger.error(`config reload failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  /**
   * 标记某目录的索引库需在下次热重载关闭连接后删除(跨平台安全清理,规避 Windows EBUSY)。
   * @param indexKey 目录实例 key(instanceId ?? folderId),与索引库文件命名口径一致。
   */
  markIndexForPurge(indexKey: string): void {
    this.pendingIndexPurge.add(indexKey);
  }

  /** daemon 优雅关闭:清重连定时器、停心跳、断开所有 peer socket、关闭索引库。 */
  close(): void {
    // 先置位再拆连接:terminate 触发的 socket 'close' 是异步的,会在 close() 返回
    // 之后才跑,届时必须已被标记为「关闭中」,否则又会排定重连(见 closed 的注释)。
    this.closed = true;
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();
    // 挂起的对比请求:拒绝掉,别让调用方(HTTP 路由)空等到超时
    for (const pending of this.pendingSnapshots.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('daemon 正在关闭,对比已取消'));
    }
    this.pendingSnapshots.clear();
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    this.peerLiveness.clear();
    // 关闭所有 peer socket(入站 + 出站),否则客户端 socket 保持事件循环活跃
    // 导致进程收到 SIGTERM 后无法退出。用 terminate() 强制断开 TCP 连接,
    // 避免 close 握手在对端同时关闭时挂起。
    for (const socket of this.peerSockets) {
      try {
        socket.terminate();
      } catch {
        // socket 可能已关闭
      }
    }
    this.peerSockets.clear();
    for (const folder of this.folderStates) {
      folder.index.close();
    }
  }
}
