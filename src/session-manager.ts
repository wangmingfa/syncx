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
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Logger } from 'pino';
import { WebSocket } from 'ws';

import { loadConfig, folderIdFor, folderIndexKey, folderIndexPath, purgeFolderIndex, type SharedFolderConfig } from './config.js';
import { FOLDER_MARKER, ensureFolderMarker, hasFolderMarker } from './marker.js';
import { openIndexStore, type IndexStore } from './indexstore.js';
import { createLocalExecutor, resolveSharePath, type LocalExecutor } from './executor.js';
import { filterIndexedEntries, parseIgnoreRules, readFolderIgnoreLines } from './ignore.js';
import { createSyncPeer, type PeerTransport, type SyncPeer } from './peer.js';
import { scanFolder } from './scanner.js';
import type { IndexEntry } from './index.js';
import { splitIntoBlocks } from './blockstore.js';
import { recordSyncEvent } from './history.js';
import { broadcastFolderUpdates } from './broadcast.js';
import { connectPeer } from './net/client.js';
import { makePeerTransport, attachPeerMessages, sendControlMessage, type ControlMessage } from './net/wire.js';
import { learnPeerUrl, learnPeerIp } from './net/addresses.js';
import { hostname as osHostname } from 'node:os';
import { RateLimiter } from './ratelimit.js';
import { isPeerAllowed, addPeer } from './devices.js';
import { receiveOffer, makeOfferId, pruneRevokedOffers } from './offers.js';
import type { DeviceIdentity } from './identity.js';
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

export interface SessionManagerDeps {
  identity: DeviceIdentity;
  configPath: string;
  /** 配置目录(索引库/pid 等落盘位置)。 */
  configDir: string;
  /** 本机 peer 监听端口(出站拨号时对端会回校,这里仅作为 connectPeer 参数)。 */
  peerPort: number;
  logger: Logger;
}

export class SyncSessionManager {
  /** 每个共享目录独立的索引/执行器/本地索引状态(可变:配置热重载可新增/移除目录)。 */
  folderStates: FolderState[];

  private readonly identity: DeviceIdentity;
  private readonly configPath: string;
  private readonly configDir: string;
  private readonly peerPort: number;
  private readonly logger: Logger;

  // --- 目录级同步错误采集(Web UI 目录卡上的错误提示) ---
  // 记录每个目录最近一次同步失败的错误信息(内存态,不落盘);同一目录再次出错覆盖,
  // 一轮完整扫描无新错误则清除(问题自愈后提示自动消失)。
  private readonly folderErrorsState = new Map<string, { message: string; ts: number }>();
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
  /** 等待对端 self-binary-response 的挂起请求(requestId → resolver)。 */
  private readonly pendingBinary = new Map<string, (resp: Extract<ControlMessage, { kind: 'self-binary-response' }>) => void>();
  /** 扫描重入保护(见 runScan)。 */
  private scanning = false;

  constructor(deps: SessionManagerDeps, initialFolders: SharedFolderConfig[]) {
    this.identity = deps.identity;
    this.configPath = deps.configPath;
    this.configDir = deps.configDir;
    this.peerPort = deps.peerPort;
    this.logger = deps.logger;
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
    const executor = this.captureFolderErrors(id, createLocalExecutor(f.path, index));
    // 忽略规则每设备本地:.gitignore(默认并入,可按目录关闭)+ .syncxignore(优先级更高)
    const ignoreLines = readFolderIgnoreLines(f.path, f.useGitignore !== false);
    const localIndex = new Map(
      filterIndexedEntries(parseIgnoreRules(ignoreLines), index.listEntries()).map((e) => [e.path, e]),
    );
    // 索引为空 → 首扫是建基线(存量文件不算新增);索引有存量 → 首扫 diff 是
    // daemon 离线期间的真实改动,要写同步记录
    const baselinePending = index.listEntries().length === 0;
    return { id, indexKey, path: f.path, index, executor, localIndex, ignoreLines, transports: [], peers: new Map(), config: f, baselinePending };
  }

  /** 目录级错误列表(倒序),供 status 下发到目录卡。 */
  getFolderErrors(): Array<{ folder: string; message: string; ts: number }> {
    return [...this.folderErrorsState.entries()]
      .map(([folder, e]) => ({ folder, message: e.message, ts: e.ts }))
      .sort((a, b) => b.ts - a.ts);
  }

  recordFolderError(folderId: string, error: unknown, detail?: string): void {
    const message = error instanceof Error ? error.message : String(error);
    const full = detail ? `${detail}: ${message}` : message;
    this.folderErrorsState.set(folderId, { message: full, ts: Date.now() });
    this.logger.warn(`folder ${folderId} sync error: ${full}`);
  }

  private clearFolderError(folderId: string): void {
    this.folderErrorsState.delete(folderId);
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
   */
  async runScan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      await this.scanOnce();
    } finally {
      this.scanning = false;
    }
  }

  private async scanOnce(): Promise<void> {
    // 其它共享目录的归一化根路径:扫描某目录时,命中这些路径的子目录视为嵌套共享根,不重复索引
    // (含 baselinePending 的新建目录——父目录在其基线扫描期间也不应重复索引子目录文件)
    const otherRoots = this.folderStates.map((f) => resolve(f.path));
    for (const folder of this.folderStates) {
      // 一轮扫描走到这里且后续无错误即视为「干净」:清除该目录上一次的错误提示,
      // 让问题自愈后目录卡上的错误横幅自动消失
      this.clearFolderError(folder.id);
      // 挂载标记门禁:标记缺失 = 目录未挂载 / 被整体清空 → 跳过本轮扫描、绝不产生墓碑。
      // 这是「盘不见了」与「用户删光了文件」之间唯一可靠的区分点(参照 Syncthing 的 .stfolder)。
      // 目录卡上给出原因与恢复方式,而不是静默不同步;同一原因不重复刷日志。
      if (!hasFolderMarker(folder.path)) {
        const prev = this.folderErrorsState.get(folder.id);
        if (!prev || !prev.message.includes('缺少挂载标记')) {
          this.recordFolderError(
            folder.id,
            new Error(
              `缺少共享目录标记 ${FOLDER_MARKER}(目录未挂载或已被整体清空):已暂停该目录同步以防误删。` +
                `确认目录内容无误后,在界面移除并重新添加该目录即可恢复`,
            ),
            '目录不可信',
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
      // 建基线的目录(空索引首扫)不写记录,避免把存量文件当成"新增"刷屏;
      // 索引从盘上恢复的目录,首扫 diff 是离线期间的真实改动,要记录
      const recordEvents = !folder.baselinePending;
      for (const tomb of diff.tombstones) {
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
    session.transports.push({ folder, transport });
    const peer = createSyncPeer({
      transport,
      localIndex: folder.localIndex,
      executor: folder.executor,
      readLocalBlock: (path, blockIndex) => {
        // 与写入侧同一守卫:拒绝经符号链接/../ 越过共享目录的读取
        const abs = resolveSharePath(folder.path, path);
        const blocks = splitIntoBlocks(readFileSync(abs));
        const block = blocks[blockIndex];
        if (!block) {
          throw new Error(`block ${blockIndex} out of range for ${path}`);
        }
        return block;
      },
      deviceId: this.identity.deviceId,
      remoteDeviceId: session.remoteDeviceId,
      // 块请求服务侧路径校验(经符号链接逃逸的路径不响应)
      root: folder.path,
      // .syncxignore 行:接收保护据此跳过被忽略文件,避免反向同步出去
      ignoreLines: folder.ignoreLines,
      folderId: folder.id,
      // 远端推送的变更(新增/修改/删除/冲突)落盘为同步记录
      onEvent: (ev) => recordSyncEvent(this.configPath, { ...ev, folderId: folder.id }),
      // 接收模式:本机只收不推(对端索引规划时跳过 send / 本地墓碑外推,
      // 冲突以对端版本覆盖本地)
      receiveOnly: folder.config.receiveOnly ?? false,
    });
    session.peers.set(folder.id, peer);
    folder.peers.set(session.remoteDeviceId, peer);
    transport.sendEntries([...folder.localIndex.values()]);
  }

  /** 从一个存活会话上摘除指定目录的 peer/transport(设备被移出目录的 devices 时)。 */
  private detachFolderFromSession(session: ActiveSession, folder: FolderState): void {
    const removed = session.transports.filter((t) => t.folder.id === folder.id).map((t) => t.transport);
    session.transports = session.transports.filter((t) => t.folder.id !== folder.id);
    for (const t of removed) {
      const i = folder.transports.indexOf(t);
      if (i !== -1) folder.transports.splice(i, 1);
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
      const allowed = (folder.config.devices ?? []).includes(session.remoteDeviceId);
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
    }
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
        return;
      }
      this.onControl(message);
    });
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

  /** 全部目录的索引统计(条目/墓碑数)。 */
  getIndexStats(): { entries: number; tombstones: number } {
    let entries = 0;
    let tombstones = 0;
    for (const folder of this.folderStates) {
      const all = folder.index.listEntries();
      entries += all.filter((e) => !e.deleted).length;
      tombstones += all.filter((e) => e.deleted).length;
    }
    return { entries, tombstones };
  }

  /* ==================== 配置热重载与关闭 ==================== */

  /**
   * 配置热重载:增量应用共享目录与对端列表变更,无需重启 daemon。
   * 返回重新加载后的 config(调用方据此更新内存副本);解析失败返回 undefined(已记日志)。
   */
  reloadConfig(): ReturnType<typeof loadConfig> | undefined {
    try {
      const newConfig = loadConfig(this.configPath);

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
          // 索引里已有的条目),此时补挂载标记是安全的。覆盖「手改 config.json 热重载新增
          // 目录」这条不经 addSharedFolder 的路径,否则新目录会因缺标记被暂停并报错。
          if (!hasFolderMarker(f.path) && folder.index.listEntries().length === 0) {
            if (ensureFolderMarker(f.path)) this.logger.info(`mount marker established: ${f.path}`);
          }
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
            // 路径变更:以新路径重建执行器与本地索引(索引库按目录实例 key 复用)
            existing.path = f.path;
            existing.executor = createLocalExecutor(f.path, existing.index);
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
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();
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
