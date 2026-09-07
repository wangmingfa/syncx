export interface ParsedArgs {
  command: 'start' | 'status' | 'install' | 'invite' | 'join' | 'revoke';
  /** 位置参数(如 invite/join 的参数)。 */
  positionals: string[];
  configPath?: string;
  port?: number;
  controlPort?: number;
  /** Control API/Web UI bind host; default 127.0.0.1 (localhost only). */
  host?: string;
  /** 日志文件路径;不指定则仅输出到 stdout。 */
  logFile?: string;
  /** dev 模式:vite dev server 基址(如 http://127.0.0.1:5173)。设置后 8384 的 web 页面请求会 302 重定向过去,由 vite 提供 HMR;不设置则 8384 直接提供页面(生产/打包形态)。 */
  devViteUrl?: string;
}

const COMMANDS = new Set(['start', 'status', 'install', 'invite', 'join', 'revoke']);

/** 控制 API 可安全绑定的回环地址;非回环地址必须显式 --expose-control。 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/** 断线重连退避基数与上限(指数退避 1s、2s、4s…,封顶 30s)。 */
export const RECONNECT_BASE_MS = 1000;
export const RECONNECT_MAX_MS = 30000;

/**
 * 断线重连退避延迟:attempts 为已连续失败次数。
 * 第 0 次(首连失败)立即重试(0ms),之后按指数退避 —— 避免双 daemon
 * 同时启动时互相 ECONNREFUSED,连接建立被推后到 30s 边缘。
 */
export function reconnectDelayMs(attempts: number): number {
  if (attempts <= 0) return 0;
  return Math.min(RECONNECT_BASE_MS * 2 ** (attempts - 1), RECONNECT_MAX_MS);
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [rawCommand, ...rest] = argv;

  const result: ParsedArgs = {
    command: (rawCommand ?? 'start') as ParsedArgs['command'],
    positionals: [],
  };
  if (!COMMANDS.has(result.command)) {
    throw new Error(`unknown command: ${String(rawCommand)}`);
  }

  let exposeControl = false;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === undefined) break;
    const value = rest[i + 1];
    if (flag === '--config') {
      result.configPath = value;
      i++;
    } else if (flag === '--port') {
      result.port = Number(value);
      i++;
    } else if (flag === '--control-port') {
      result.controlPort = Number(value);
      i++;
    } else if (flag === '--host') {
      result.host = value;
      i++;
    } else if (flag === '--log-file') {
      result.logFile = value;
      i++;
    } else if (flag === '--dev-vite') {
      // 用 URL 构造器校验:非法基址在此处就报错,而不是等某次请求代理时才炸。
      new URL(String(value));
      result.devViteUrl = value;
      i++;
    } else if (flag === '--expose-control') {
      exposeControl = true;
    } else if (flag.startsWith('-')) {
      throw new Error(`unknown option: ${flag}`);
    } else {
      result.positionals.push(flag);
    }
  }

  // 控制 API 暴露防护:非回环地址把控制端点以明文 HTTP 暴露到 LAN,token 可被
  // 嗅探。必须显式 --expose-control 才允许,否则拒绝启动。
  if (result.host !== undefined && !LOOPBACK_HOSTS.has(result.host) && !exposeControl) {
    throw new Error(
      `--host ${result.host} exposes the control API over plain HTTP on the LAN; pass --expose-control to allow it`,
    );
  }

  return result;
}

import { dirname, join, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { loadOrCreateIdentity } from './identity.js';
import { loadConfig, saveConfig } from './config.js';
import { openIndexStore, type IndexStore } from './indexstore.js';
import { createLocalExecutor, resolveSharePath, type LocalExecutor } from './executor.js';
import { filterIndexedEntries, parseIgnoreRules } from './ignore.js';
import { createSyncPeer, type PeerTransport, type SyncPeer } from './peer.js';
import { scanFolder } from './scanner.js';
import type { IndexEntry } from './index.js';
import { splitIntoBlocks } from './blockstore.js';
import { recordSyncEvent, listSyncHistory } from './history.js';
import { broadcastFolderUpdates } from './broadcast.js';
import { readFileSync, existsSync, writeFileSync, watch } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ControlServerDeps } from './api.js';

import { startPeerServer } from './net/server.js';
import { connectPeer } from './net/client.js';
import { startDiscovery } from './net/discovery.js';
import { makePeerTransport, attachPeerMessages, sendControlMessage, type ControlMessage } from './net/wire.js';
import { RateLimiter } from './ratelimit.js';
import { createControlServer } from './api.js';
import { buildStatus, type DeviceStatus, type SyncProgress } from './status.js';
import { addSharedFolder, removeSharedFolder, isPeerAllowed, addKnownDevice, removeKnownDevice, addPeer, removePeer, setFolderDevices } from './devices.js';
import { receiveOffer, markOfferAccepted, markOfferDeclined, restoreDeclinedOffer, listOpenOffers, makeOfferId } from './offers.js';
import { createInviteCode, parseInviteCode, revokeInviteCode } from './invite.js';
import { folderIdFor, folderIndexPath, type SharedFolderConfig } from './config.js';
import { getLanAddresses, formatHost } from './net/addresses.js';
import { renderSystemdUnit, renderLaunchdPlist, renderWindowsService } from './install.js';
import { WebSocket } from 'ws';
import { createLogger } from './logger.js';

/** 一个共享目录的运行期状态:索引、执行器与本地索引,随配置热重载增删。 */
interface FolderState {
  id: string;
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
interface ActiveSession {
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

function loadOrCreateToken(configDir: string): string {
  const file = join(configDir, 'control.token');
  if (existsSync(file)) {
    return readFileSync(file, 'utf8').trim();
  }
  const token = randomBytes(24).toString('hex');
  writeFileSync(file, token, { mode: 0o600 });
  return token;
}

/**
 * 由入站 socket 的对端源 IP + 握手 kx 中广播的监听端口,拼出可反向连接的
 * ws:// 地址。@types/ws 未暴露 remoteAddress,故对 ws 实例做防御性读取
 * (优先 socket.remoteAddress,回退底层 _socket.remoteAddress)。IPv6 自动加方括号。
 * 端口非法或缺失时返回 undefined(旧版对端不广播端口,则无法反向发现)。
 *
 * 地址规范化:剥离 IPv4-mapped IPv6 前缀(::ffff:a.b.c.d → a.b.c.d)。
 * peer server 默认双栈监听(::),IPv4 对端连入时 OS 会套这层壳,
 * 否则会存成 ws://[::ffff:a.b.c.d]:port —— 既丑又无法与手动填的纯 IPv4
 * (ws://a.b.c.d:port) 去重,污染 config.peers。
 */
export function learnPeerUrl(socket: WebSocket, listenPort?: number): string | undefined {
  if (typeof listenPort !== 'number' || listenPort <= 0 || listenPort > 65535) return undefined;
  const anySock = socket as unknown as {
    remoteAddress?: string;
    _socket?: { remoteAddress?: string };
  };
  let addr = anySock.remoteAddress ?? anySock._socket?.remoteAddress;
  if (!addr) return undefined;
  // 去方括号
  if (addr.startsWith('[') && addr.endsWith(']')) addr = addr.slice(1, -1);
  // 还原 IPv4-mapped IPv6 地址(::ffff:a.b.c.d → a.b.c.d)
  if (addr.startsWith('::ffff:')) addr = addr.slice('::ffff:'.length);
  // 仅真正的 IPv6(仍含冒号)才加方括号
  const host = addr.includes(':') && !addr.startsWith('[') ? `[${addr}]` : addr;
  return `ws://${host}:${listenPort}`;
}

/**
 * Run a command against the daemon's data directory. The lifecycle is kept
 * thin on purpose: real daemon integration tests are a later batch.
 */
export async function run(args: ParsedArgs): Promise<void> {
  // --config 指向完整配置文件路径;默认 ~/.syncx/config.json。
  // 身份/索引/token 等数据仍存放在配置文件所在目录。
  const configPath = args.configPath ?? join(homedir(), '.syncx', 'config.json');
  const configDir = dirname(configPath);
  // 日志实例在身份/配置加载后初始化,CLI 一次性命令(status/install/invite/join)
  // 仍用 console.log 直接打印给用户;仅 daemon 运行期用 logger 持久化。
  const logger = createLogger(args.logFile);

  const identity = loadOrCreateIdentity(configDir);
  const config = loadConfig(configPath);
  // 首次运行(如 dev 未指定 --config,默认 ~/.syncx/config.json):若配置文件不存在,
  // 先写出默认配置,否则下方 fs.watch 在 Windows 上对不存在的路径会同步抛出 ENOENT,
  // 未捕获将导致 daemon 进程崩溃(control server 无法监听,Web UI 代理 502/ECONNREFUSED)。
  if (!existsSync(configPath)) {
    saveConfig(configPath, config);
  }
  if (args.command === 'status') {
    console.log(`device: ${identity.deviceId}`);
    console.log(`shared folders: ${config.sharedFolders.length}`);
    for (const f of config.sharedFolders) {
      const idx = openIndexStore(folderIndexPath(configDir, folderIdFor(f)));
      const all = idx.listEntries();
      console.log(
        `  ${f.path}: ${all.filter((e) => !e.deleted).length} files, ${all.filter((e) => e.deleted).length} tombstones`,
      );
      idx.close();
    }
    return;
  }

  if (args.command === 'install') {
    // 生成系统服务模板:systemd(linux)/launchd(macOS)/sc(Windows)
    const mainPath = fileURLToPath(new URL('./syncx.js', import.meta.url));
    const target = {
      executable: `${process.execPath} ${mainPath}`,
      configPath,
    };
    const template =
      process.platform === 'darwin'
        ? renderLaunchdPlist(target)
        : process.platform === 'win32'
          ? renderWindowsService(target)
          : renderSystemdUnit(target);
    console.log(template);
    return;
  }

  if (args.command === 'invite') {
    // 为已配置的共享目录生成一次性配对邀请码(对端 syncx join 使用)
    const folderPath = args.positionals[0];
    if (!folderPath) {
      throw new Error('usage: syncx invite <folder-path>');
    }
    if (!config.sharedFolders.some((f) => f.path === folderPath)) {
      throw new Error(`folder not configured: ${folderPath}`);
    }
    console.log(createInviteCode(identity, folderPath));
    return;
  }

  if (args.command === 'join') {
    // 接受邀请:验签 + 有效期,然后把邀请方加入共享目录白名单
    const [code, localPath] = args.positionals;
    if (!code || !localPath) {
      throw new Error('usage: syncx join <invite-code> <local-path>');
    }
    const invite = parseInviteCode(code, configDir);
    addSharedFolder(configPath, localPath, [invite.deviceId]);
    console.log(`paired with device ${invite.deviceId} (invited folder ${invite.folder})`);
    console.log(`shared folder added: ${localPath}`);
    // 关系是双向的:本机已信任对方,但对方尚未把本机加入白名单,
    // 必须也让对方 join 本机生成的邀请码,否则对方会拒绝本机连接。
    const reciprocal = createInviteCode(identity, localPath);
    console.log('');
    console.log(`share this code with ${invite.deviceId} so they can whitelist you:`);
    console.log(reciprocal);
    return;
  }

  if (args.command === 'revoke') {
    // 吊销一个邀请码:加入吊销列表,已吊销的邀请码在 parseInviteCode 时会被拒绝
    const code = args.positionals[0];
    if (!code) {
      throw new Error('usage: syncx revoke <invite-code>');
    }
    revokeInviteCode(configDir, code);
    console.log(`invitation code revoked: ${code}`);
    return;
  }

  // 本地控制 API 先启动(无论是否有共享目录),让用户能在 Web UI 里添加第一个目录
  const token = loadOrCreateToken(configDir);
  const controlPort = args.controlPort ?? 8384;
  const controlHost = args.host ?? '127.0.0.1';

  const lanAddresses = getLanAddresses();
  logger.info(`control UI (token in ${join(configDir, 'control.token')}):`);
  logger.info(`  http://${controlHost === '0.0.0.0' ? 'localhost' : controlHost}:${controlPort}`);
  if (controlHost === '0.0.0.0') {
    for (const lan of lanAddresses) {
      logger.info(`  http://${formatHost(lan.address, lan.family)}:${controlPort}`);
    }
  }
  if (args.devViteUrl) {
    logger.info(
      `dev mode: 访问 ${controlPort} 端口的页面会自动重定向到 vite dev server ${args.devViteUrl}(HMR 已启用)`,
    );
    logger.info(
      `  请用 ${args.devViteUrl} 打开 Web UI;生产构建(不带 --dev-vite)才由 ${controlPort} 端口直接提供页面`,
    );
  }

  /** 为一个共享目录创建运行期状态(索引/执行器/本地索引/忽略规则)。 */
  function createFolderState(f: SharedFolderConfig): FolderState {
    const id = folderIdFor(f);
    const index = openIndexStore(folderIndexPath(configDir, id));
    const executor = createLocalExecutor(f.path, index);
    // 忽略规则每设备本地,从共享目录的 .syncxignore 读取(不存在则为空)
    let ignoreLines: string[] = [];
    try {
      ignoreLines = readFileSync(join(f.path, '.syncxignore'), 'utf8').split('\n');
    } catch {
      // no ignore file
    }
    const localIndex = new Map(
      filterIndexedEntries(parseIgnoreRules(ignoreLines), index.listEntries()).map((e) => [e.path, e]),
    );
    // 索引为空 → 首扫是建基线(存量文件不算新增);索引有存量 → 首扫 diff 是
    // daemon 离线期间的真实改动,要写同步记录
    const baselinePending = index.listEntries().length === 0;
    return { id, path: f.path, index, executor, localIndex, ignoreLines, transports: [], peers: new Map(), config: f, baselinePending };
  }

  // 每个共享目录独立的索引/执行器/本地索引状态(可变:配置热重载可新增/移除目录)
  let folderStates: FolderState[] = config.sharedFolders.map(createFolderState);
  if (folderStates.length === 0) {
    // 无目录时 daemon 保持运行,通过 Web UI 添加目录后由热重载生效,无需重启
    logger.info('no shared folders configured; the daemon stays up and picks up folders added via the web UI');
  }

  /**
   * 入站连接授权:握手阶段已用 Ed25519 签名校验对端身份(verifyKxMessage),
   * 此处不再因「未互相信任」而拒连。否则一方添加另一方时,对方收不到配对请求
   * (连接被拒 → 控制面消息到不了 → 不弹「待确认」)。未确认前的会话仅开放控制面,
   * 不交换文件索引(见 startSyncSession 对 allowed 的判断),信任在「待确认」弹窗确认后建立。
   */
  function acceptPeer(): boolean {
    return true;
  }

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
  const outboundPeerUrls = new Map<string, string>();
  const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const reconnectAttempts = new Map<string, number>();
  // 跟踪所有 peer socket(入站 + 出站),关闭时统一断开,避免客户端 socket
  // 保持事件循环活跃导致进程无法退出。
  const peerSockets = new Set<WebSocket>();

  /** 与某对端的当前会话是否存在且 socket 仍处于 OPEN 状态。 */
  function isPeerConnected(deviceId: string): boolean {
    const session = peerSessions.get(deviceId);
    return !!session && session.socket.readyState === WebSocket.OPEN;
  }

  /** 会话是否仍然可用:socket 处于 OPEN 状态。 */
  function sessionAlive(session: ActiveSession): boolean {
    return session.socket.readyState === WebSocket.OPEN;
  }

  function registerPeer(deviceId: string, url?: string): void {
    if (url) {
      outboundPeerUrls.set(deviceId, url);
    }
    // 连接已建立:作废挂起的重连定时器与退避计数
    const timer = reconnectTimers.get(deviceId);
    if (timer) {
      clearTimeout(timer);
      reconnectTimers.delete(deviceId);
    }
    reconnectAttempts.delete(deviceId);
  }

  /**
   * 连接到指定对端并建立同步会话;失败时按调用方策略处理(默认记日志)。
   * 注意:不要在这里「发现已有会话就关闭新拨号」——对端可能已把这条连接
   * 登记为书签(它视角里没有存活会话),单方面关闭会杀掉对端唯一的活连接,
   * 双向同时拨号时会形成互相杀连接的重连风暴。重复连接一律照常注册为
   * 备份会话(startSyncSession 的书签策略保证书签永远指向存活连接)。
   */
  function connectTo(
    url: string,
    opts: {
      onConnected?: (remoteDeviceId: string) => void;
      onRejected?: (error: unknown) => void;
    } = {},
  ): void {
    void connectPeer(identity, url, args.port ?? 22000)
      .then(({ socket, remoteDeviceId, key }) => {
        opts.onConnected?.(remoteDeviceId);
        if (acceptPeer()) {
          startSyncSession(socket, remoteDeviceId, key, url);
        }
      })
      .catch((error) => {
        if (opts.onRejected) {
          opts.onRejected(error);
        } else {
          logger.error(`connect to ${url} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
  }

  function scheduleReconnect(deviceId: string): void {
    const url = outboundPeerUrls.get(deviceId);
    if (!url) return;
    // attempts = 已连续失败次数:首连失败(0)立即重试,之后指数退避
    const attempts = reconnectAttempts.get(deviceId) ?? 0;
    reconnectAttempts.set(deviceId, attempts + 1);
    const delay = reconnectDelayMs(attempts);
    logger.info(`peer ${deviceId} disconnected, reconnecting in ${delay}ms`);
    const timer = setTimeout(() => {
      reconnectTimers.delete(deviceId);
      connectTo(url, { onRejected: () => scheduleReconnect(deviceId) });
    }, delay);
    reconnectTimers.set(deviceId, timer);
  }

  /**
   * 扫描重入保护:慢设备上大目录的单轮扫描可能超过 5s 定时间隔,
   * 若允许并发重入,两轮 scanFolder 会在对方 applySend 写回索引**之前**
   * 各自对同一文件检出变更 → 同一次编辑产生两条记录 + 两次版本递增 + 两次广播
   * (对端也会重复接收)。因此同一时刻只允许一轮扫描在跑。
   */
  let scanning = false;

  /** 手动触发一轮扫描:与定时扫描逻辑一致。 */
  async function runScan(): Promise<void> {
    if (scanning) return;
    scanning = true;
    try {
      await scanOnce();
    } finally {
      scanning = false;
    }
  }

  async function scanOnce(): Promise<void> {
    for (const folder of folderStates) {
      try {
        folder.ignoreLines = readFileSync(join(folder.path, '.syncxignore'), 'utf8').split('\n');
      } catch {
        // no ignore file
      }
      const diff = scanFolder(
        folder.path,
        folder.index,
        parseIgnoreRules(folder.ignoreLines),
        identity.deviceId,
      );
      // 建基线的目录(空索引首扫)不写记录,避免把存量文件当成"新增"刷屏;
      // 索引从盘上恢复的目录,首扫 diff 是离线期间的真实改动,要记录
      const recordEvents = !folder.baselinePending;
      for (const tomb of diff.tombstones) {
        try {
          await folder.executor.applyDelete(tomb.path, tomb);
          folder.localIndex.set(tomb.path, tomb);
          if (recordEvents) {
            recordSyncEvent(configPath, {
              ts: Date.now(),
              folderId: folder.id,
              path: tomb.path,
              action: 'delete',
              direction: 'local',
            });
          }
        } catch {
          // 索引写入失败,下一轮扫描重试
        }
      }
      const sends: IndexEntry[] = [...diff.tombstones];
      for (const path of diff.changed) {
        const isNew = !folder.localIndex.has(path);
        try {
          const updated = await folder.executor.applySend(path, identity.deviceId);
          folder.localIndex.set(path, updated);
          sends.push(updated);
          if (recordEvents) {
            recordSyncEvent(configPath, {
              ts: Date.now(),
              folderId: folder.id,
              path,
              action: isNew ? 'add' : 'update',
              direction: 'local',
            });
          }
        } catch {
          // 文件在扫描后被删除/重命名,下一轮扫描处理
        }
      }
      if (sends.length > 0) {
        broadcastFolderUpdates(folder, sends);
      }
      folder.baselinePending = false;
    }
  }

  /** 手动强制重连:立即尝试连接,不走指数退避;失败后回退到正常重连调度。 */
  function forceReconnect(deviceId: string): void {
    if (isPeerConnected(deviceId)) return;
    const url = outboundPeerUrls.get(deviceId);
    if (!url) return;
    const timer = reconnectTimers.get(deviceId);
    if (timer) {
      clearTimeout(timer);
      reconnectTimers.delete(deviceId);
    }
    reconnectAttempts.delete(deviceId);
    logger.info(`manually reconnecting to peer ${deviceId}`);
    connectTo(url, { onRejected: () => scheduleReconnect(deviceId) });
  }

  // 存活会话注册表:配置热重载新增/移除目录时,对现有连接补建或摘除对应目录的 peer
  const activeSessions: ActiveSession[] = [];
  // 按对端 deviceId 索引的存活会话:用于向已连接对端推送 control 控制面消息
  // (配对请求 / 目录共享邀请 / 确认回执)。离线对端查不到即跳过(连接建立时会自动补发)。
  const peerSessions = new Map<string, ActiveSession>();

  /** 在一个存活会话上为指定目录补建 transport/peer,并发送该目录的索引。 */
  function attachFolderToSession(session: ActiveSession, folder: FolderState): void {
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
      deviceId: identity.deviceId,
      remoteDeviceId: session.remoteDeviceId,
      // 块请求服务侧路径校验(经符号链接逃逸的路径不响应)
      root: folder.path,
      folderId: folder.id,
      // 远端推送的变更(新增/修改/删除/冲突)落盘为同步记录
      onEvent: (ev) => recordSyncEvent(configPath, { ...ev, folderId: folder.id }),
    });
    session.peers.set(folder.id, peer);
    folder.peers.set(session.remoteDeviceId, peer);
    transport.sendEntries([...folder.localIndex.values()]);
  }

  /** 向已连接对端推送一条 control 控制面消息;对端离线(无存活会话)则忽略。 */
  function sendControlTo(deviceId: string, message: ControlMessage): boolean {
    const session = peerSessions.get(deviceId);
    if (!session) return false;
    try {
      sendControlMessage(session.socket, session.key, message);
      return true;
    } catch (error) {
      logger.warn(`failed to send control to ${deviceId}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /** 收到对端 control 消息:把配对 / 目录共享邀请落成待确认项;确认回执仅记录。 */
  function onControl(message: ControlMessage): void {
    switch (message.kind) {
      case 'pairing-request':
        receiveOffer(configPath, {
          id: message.offerId,
          kind: 'pairing',
          fromDeviceId: message.fromDeviceId,
        });
        logger.info(`pairing request received from ${message.fromDeviceId}`);
        break;
      case 'folder-invitation': {
        const offer = receiveOffer(configPath, {
          id: message.offerId,
          kind: 'folder',
          fromDeviceId: message.fromDeviceId,
          folderId: message.folderId,
          folderName: message.folderName,
        });
        // 新落成一个待确认项后立即向对方反推目录清单(带 pendingFolderIds),
        // 让对方设备标签马上从「已停止共享」切到「待对方确认」,不等下次会话事件
        if (offer) pushFolderSyncList(message.fromDeviceId);
        logger.info(`folder invitation received from ${message.fromDeviceId}: ${message.folderId}`);
        break;
      }
      case 'pairing-ack':
        logger.info(`pairing ${message.accepted ? 'accepted' : 'declined'} by ${message.fromDeviceId}`);
        break;
      case 'folder-invitation-ack':
        logger.info(`folder invitation ${message.accepted ? 'accepted' : 'declined'} by ${message.fromDeviceId}`);
        break;
    }
  }

  /**
   * 连接建立后,把本机「共享意图」推送给对端:
   * - 每个把对端列入 devices 的共享目录 → 发目录共享邀请(对端去重,已 mutual 则跳过)
   * - 对端在 knownDevices → 发配对请求
   * 这样无论谁先上线,对方上线并互连后都会收到待确认项;离线期间累积的意图在重连时自动补发。
   */
  function pushSharesTo(session: ActiveSession): void {
    const current = loadConfig(configPath);
    for (const f of current.sharedFolders) {
      if ((f.devices ?? []).includes(session.remoteDeviceId)) {
        sendControlTo(session.remoteDeviceId, {
          kind: 'folder-invitation',
          offerId: makeOfferId('folder', session.remoteDeviceId, folderIdFor(f)),
          fromDeviceId: identity.deviceId,
          folderId: folderIdFor(f),
          folderName: folderIdFor(f),
        });
      }
    }
    if (current.knownDevices.some((d) => d.id === session.remoteDeviceId)) {
      sendControlTo(session.remoteDeviceId, {
        kind: 'pairing-request',
        offerId: makeOfferId('pair', session.remoteDeviceId),
        fromDeviceId: identity.deviceId,
      });
    }
  }

  /**
   * 确认配对 / 目录共享后,本机已信任该对端:在其已有会话上补建目录 peer 并推送本机共享意图,
   * 使离线期间建立的「仅控制面」会话升级为可同步。无存活会话(对端尚未连)时静默跳过,
   * 连接建立时 startSyncSession 会按 allowed 自动附加目录。
   */
  function promoteSession(remoteDeviceId: string): void {
    const session = peerSessions.get(remoteDeviceId);
    if (!session) return;
    const config = loadConfig(configPath);
    for (const folder of folderStates) {
      if ((folder.config.devices ?? []).includes(remoteDeviceId) && !session.peers.has(folder.id)) {
        attachFolderToSession(session, folder);
      }
    }
    pushSharesTo(session);
    // 共享意图变化(如刚接受邀请新建目录)后,同步重推目录清单
    pushFolderSyncList(session.remoteDeviceId);
  }

  /** 在一个 socket 上建立同步会话:为每个共享目录建 peer,按 folder 路由;并推送本机共享意图。 */
  function startSyncSession(socket: WebSocket, remoteDeviceId: string, key: Buffer, url?: string): void {
    registerPeer(remoteDeviceId, url);
    peerSockets.add(socket);
    const session: ActiveSession = {
      socket,
      key,
      remoteDeviceId,
      peers: new Map<string, SyncPeer>(),
      transports: [],
    };
    activeSessions.push(session);
    // 书签策略:仅当当前书签缺失或其 socket 已死时才移交给新会话。
    // 健康的当前会话保持不动(重复连接照常注册为备份,handlers 可收消息);
    // 若此处覆盖了健康书签,而这条新连接随即被对端关闭,书签就会孤儿化。
    const current = peerSessions.get(remoteDeviceId);
    if (!current || !sessionAlive(current)) {
      peerSessions.set(remoteDeviceId, session);
    }
    // 仅对「已互相信任」(在 knownDevices 或某共享目录 devices 中)的对端附加目录 peer 并交换索引;
    // 未确认的对端此时仅建立控制面会话,用于接收配对 / 目录共享邀请并弹「待确认」,不泄漏文件索引。
    const allowed = isPeerAllowed(remoteDeviceId, loadConfig(configPath).sharedFolders, loadConfig(configPath).knownDevices);
    if (allowed) {
      for (const folder of folderStates) {
        if ((folder.config.devices ?? []).includes(remoteDeviceId)) {
          attachFolderToSession(session, folder);
        }
      }
      // 连接就绪后把本机当前的配对 / 目录共享意图推送给对端(对方会弹「待确认」)
      pushSharesTo(session);
      // 同时宣告本机当前与其同步的目录清单,供对端 UI 区分 同步中 / 已停止共享
      pushFolderSyncList(remoteDeviceId);
    }
    attachPeerMessages(session.peers, socket, key, (message) => {
      if (message.kind === 'folder-sync-list') {
        session.remoteFolders = new Set(message.folderIds);
        // 新字段可选:旧版本对端不发送 → 记为空集,UI 退回「已停止共享」旧判断
        session.remotePendingFolders = new Set(message.pendingFolderIds ?? []);
        logger.info(`folder sync list from ${remoteDeviceId}: ${message.folderIds.length} folder(s)`);
        return;
      }
      onControl(message);
    });
    socket.on('error', (error) => logger.debug(`socket error for peer ${remoteDeviceId}: ${error.message}`));
    socket.on('close', (code, reason) => {
      logger.debug(`socket closed for peer ${remoteDeviceId}, code=${code}, reason=${reason?.toString('utf8') ?? '(empty)'}`);
      peerSockets.delete(socket);
      const sessionIdx = activeSessions.indexOf(session);
      if (sessionIdx >= 0) activeSessions.splice(sessionIdx, 1);
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
      if (peerSessions.get(remoteDeviceId) === session) {
        const backup = activeSessions.find(
          (s) => s.remoteDeviceId === remoteDeviceId && sessionAlive(s),
        );
        if (backup) {
          peerSessions.set(remoteDeviceId, backup);
        } else {
          peerSessions.delete(remoteDeviceId);
          scheduleReconnect(remoteDeviceId);
        }
      }
    });
  }

  /**
   * 本机当前与某对端同步的目录 id 列表(folderIdFor 口径,与 invitations 一致)。
   * 会话建立与共享关系变更时经 folder-sync-list 宣告给对端。
   */
  function syncFolderIdsFor(deviceId: string): string[] {
    return loadConfig(configPath)
      .sharedFolders.filter((f) => (f.devices ?? []).includes(deviceId))
      .map((f) => folderIdFor(f));
  }

  /** 本机仍待确认的、来自某对端的目录邀请 id 列表(pendingOffers 口径)。
   *  宣告给对端后,对方据此把设备标签显示为「待对方确认」而非「已停止共享」。 */
  function pendingFolderIdsFor(deviceId: string): string[] {
    return loadConfig(configPath)
      .pendingOffers.filter((o) => o.status === 'pending' && o.kind === 'folder' && o.fromDeviceId === deviceId)
      .map((o) => o.folderId)
      .filter((id): id is string => id !== undefined);
  }

  /** 向对端宣告本机当前与其同步的目录清单;对端离线则忽略(重连时会话建立时重发)。 */
  function pushFolderSyncList(deviceId: string): void {
    sendControlTo(deviceId, {
      kind: 'folder-sync-list',
      fromDeviceId: identity.deviceId,
      folderIds: syncFolderIdsFor(deviceId),
      pendingFolderIds: pendingFolderIdsFor(deviceId),
    });
  }

  /**
   * 向指定对端推送目录共享邀请(控制面 folder-invitation)。
   * 仅对当前在线的对端推送;离线对端由 pushSharesTo 在重连时补推,
   * 接收侧按 (from, kind, folderId) 去重,幂等安全。
   */
  function pushFolderInvitation(deviceId: string, folderId: string, folderName: string): void {
    if (!isPeerConnected(deviceId)) {
      logger.info(`folder invitation deferred: ${deviceId} offline (will push on reconnect)`);
      return;
    }
    const ok = sendControlTo(deviceId, {
      kind: 'folder-invitation',
      offerId: makeOfferId('folder', deviceId, folderId),
      fromDeviceId: identity.deviceId,
      folderId,
      folderName,
    });
    if (!ok) logger.warn(`folder invitation to ${deviceId} could not be delivered (no live session)`);
  }

  // 控制 API:在 peer 状态和同步进度可用后创建
  const control = createControlServer({
    token,
    devViteUrl: args.devViteUrl,
    addFolder: (path, devices, id) => {
      addSharedFolder(configPath, path, devices, id);
      logger.info(`shared folder added: ${path}`);
      // 新建目录时即指派的对端,若当前在线立即推送共享邀请,免去对方再建一次目录
      const folder = loadConfig(configPath).sharedFolders.find((f) => f.path === path);
      const fid = folder?.id ?? '';
      for (const d of devices ?? []) {
        pushFolderInvitation(d, fid, fid || path);
        pushFolderSyncList(d);
      }
    },
    removeFolder: (path) => {
      // 移除前先记下原指派设备:移除后要向它们重推目录清单(它们 UI 上应显示「已停止共享」)
      const affected = new Set(loadConfig(configPath).sharedFolders.find((f) => f.path === path)?.devices ?? []);
      removeSharedFolder(configPath, path);
      logger.info(`shared folder removed: ${path}`);
      for (const d of affected) pushFolderSyncList(d);
    },
    getStatus: () => {
      // 收集已知设备 + 各目录指派,构建设备状态(含在线与所属目录)
      const config = loadConfig(configPath);
      const folderDevices = new Map<string, string[]>();
      for (const f of config.sharedFolders) {
        const fid = folderIdFor(f);
        for (const d of f.devices ?? []) {
          const list = folderDevices.get(d) ?? [];
          list.push(fid);
          folderDevices.set(d, list);
        }
      }
      const deviceIds = new Set<string>([
        ...config.knownDevices.map((d) => d.id),
        ...folderDevices.keys(),
      ]);
      const devices: DeviceStatus[] = [];
      for (const deviceId of deviceIds) {
        const session = peerSessions.get(deviceId);
        devices.push({
          deviceId,
          online: isPeerConnected(deviceId),
          url: outboundPeerUrls.get(deviceId),
          folders: folderDevices.get(deviceId) ?? [],
          // 对端宣告的目录清单:undefined=旧版本对端(无法判断「已停止共享」)
          remoteFolders: session?.remoteFolders ? [...session.remoteFolders] : undefined,
          // 对端宣告的仍待确认的目录邀请:仅对端为新版本时非空
          remotePendingFolders: session?.remotePendingFolders ? [...session.remotePendingFolders] : [],
        });
      }
      // 收集各目录同步进度
      const syncProgress: SyncProgress[] = [];
      for (const folder of folderStates) {
        for (const peer of folder.peers.values()) {
          const progress = peer.getSyncProgress();
          if (progress.pending > 0 || progress.sending > 0 || progress.receiving > 0) {
            syncProgress.push({
              folder: folder.id,
              ...progress,
            });
          }
        }
      }
      let entries = 0;
      let tombstones = 0;
      for (const folder of folderStates) {
        const all = folder.index.listEntries();
        entries += all.filter((e) => !e.deleted).length;
        tombstones += all.filter((e) => e.deleted).length;
      }
      return buildStatus(
        identity,
        config,
        { entries, tombstones },
        devices,
        syncProgress,
        // status.offers 下发 pending + declined:已忽略项在 UI 灰显供「恢复」
        listOpenOffers(configPath),
      );
    },
    rescan: () => {
      void runScan();
    },
    reconnect: (deviceId) => forceReconnect(deviceId),
    addDevice: (deviceId, address) => {
      addKnownDevice(configPath, deviceId);
      logger.info(`known device added: ${deviceId}`);
      // 跨网段/无 mDNS 时手动指定对方 ws:// 地址:写入 config.peers 并立即直连
      if (address) {
        try {
          addPeer(configPath, address);
        } catch (e) {
          logger.warn(`invalid peer address ignored: ${e instanceof Error ? e.message : String(e)}`);
        }
        connectTo(address, {
          onRejected: (error) =>
            logger.error(`connect to ${address} failed: ${error instanceof Error ? error.message : String(error)}`),
        });
      }
      // 若对端当前已连,立即推送配对请求与既有目录共享邀请(无需等下次重连);
      // pushSharesTo 覆盖本机所有已把该对端列入 devices 的目录,使"先加目录后加设备"
      // 或"修复前遗留目录"也能在添加设备这一步即刻送达,不必等掉线重连。
      if (isPeerConnected(deviceId)) {
        sendControlTo(deviceId, {
          kind: 'pairing-request',
          offerId: makeOfferId('pair', deviceId),
          fromDeviceId: identity.deviceId,
        });
        const session = peerSessions.get(deviceId);
        if (session) pushSharesTo(session);
      }
    },
    removeDevice: (deviceId) => {
      removeKnownDevice(configPath, deviceId);
      // 连同清理持久化的对端地址(手动填的或反向发现学来的),否则移除后盘上残留、重启仍会去连
      const learnedUrl = outboundPeerUrls.get(deviceId);
      if (learnedUrl) {
        removePeer(configPath, learnedUrl);
      }
      outboundPeerUrls.delete(deviceId);
      // 断开与该设备的所有会话连接(遍历 activeSessions 而非只取 peerSessions 里的
      // 当前一条)。close 回调会拆掉目录 peer;当前会话的 close 会清书签并尝试排定
      // 重连,但此时 outboundPeerUrls 已清空,scheduleReconnect 直接返回,不会重连。
      const sessions = activeSessions.filter((s) => s.remoteDeviceId === deviceId);
      for (const s of sessions) s.socket.close();
      logger.info(
        `known device removed: ${deviceId}${sessions.length > 0 ? ` (${sessions.length} connection(s) closed)` : ''}`,
      );
    },
    setFolderDevices: (path, devices) => {
      const before = loadConfig(configPath).sharedFolders.find((f) => f.path === path);
      const beforeDevices = new Set(before?.devices ?? []);
      setFolderDevices(configPath, path, devices);
      logger.info(`folder devices updated: ${path}`);
      // 对本次新加入的对端,若当前在线立即推送目录共享邀请(无需等下次重连;离线由重连补推)
      const folder = folderStates.find((f) => f.path === path);
      const fid = folder ? folder.id : before?.id ?? '';
      for (const d of devices) {
        if (!beforeDevices.has(d)) {
          pushFolderInvitation(d, fid, fid || path);
        }
      }
      // 指派变化(新增或摘除)都会改变本机的目录清单,向前后两批设备重推
      for (const d of new Set([...beforeDevices, ...devices])) {
        pushFolderSyncList(d);
      }
    },
    // 待确认区下发 pending + declined:已忽略项灰显供「恢复」,兜住手误忽略
    getOffers: () => listOpenOffers(configPath),
    getFolderHistory: (folderId) => listSyncHistory(configPath, folderId),
    acceptOffer: (offerId, localPath) => {
      const offer = markOfferAccepted(configPath, offerId);
      if (!offer) throw new Error('offer not found');
      if (offer.kind === 'folder') {
        if (!localPath || localPath.trim() === '') {
          throw new Error('local path is required to accept a folder invitation');
        }
        addSharedFolder(configPath, localPath, [offer.fromDeviceId], offer.folderId);
        sendControlTo(offer.fromDeviceId, {
          kind: 'folder-invitation-ack',
          offerId: offer.id,
          fromDeviceId: identity.deviceId,
          accepted: true,
        });
        logger.info(`accepted folder invitation ${offer.folderId} from ${offer.fromDeviceId}`);
      } else {
        addKnownDevice(configPath, offer.fromDeviceId);
        sendControlTo(offer.fromDeviceId, {
          kind: 'pairing-ack',
          offerId: offer.id,
          fromDeviceId: identity.deviceId,
          accepted: true,
        });
        logger.info(`accepted pairing request from ${offer.fromDeviceId}`);
      }
      // 确认后本机已信任该对端:升级已有会话(补建目录 peer 并反推本机共享意图),无需等重连
      promoteSession(offer.fromDeviceId);
    },
    declineOffer: (offerId) => {
      const offer = markOfferDeclined(configPath, offerId);
      if (!offer) throw new Error('offer not found');
      // 通知对方本端已忽略;不影响其后续重推(本端按去重键不再弹)
      sendControlTo(offer.fromDeviceId, {
        kind: offer.kind === 'folder' ? 'folder-invitation-ack' : 'pairing-ack',
        offerId: offer.id,
        fromDeviceId: identity.deviceId,
        accepted: false,
      });
      // 待确认项已消失,立即反推目录清单,让对方设备标签从「待对方确认」切回「已停止共享」
      if (offer.kind === 'folder') pushFolderSyncList(offer.fromDeviceId);
      logger.info(`declined offer from ${offer.fromDeviceId}`);
    },
    restoreOffer: (offerId) => {
      const offer = restoreDeclinedOffer(configPath, offerId);
      if (!offer) throw new Error('offer not found or not declined');
      // 恢复后立即反推目录清单,让对方设备标签从「已停止共享」切回「待对方确认」
      if (offer.kind === 'folder') pushFolderSyncList(offer.fromDeviceId);
      logger.info(`restored declined offer from ${offer.fromDeviceId}`);
    },
  });
  control.listen(controlPort, controlHost);

  const server = startPeerServer(
    identity,
    {
      onPeerConnected(socket, remoteDeviceId, key, listenPort) {
        logger.debug(`inbound peer connected: ${remoteDeviceId}`);
        if (acceptPeer()) {
          // 连接方在握手 kx 中广播了监听端口:结合源 IP 拼出反向地址并交给 startSyncSession
          // 记录到 outboundPeerUrls,使本机也能主动重连对端(只填一方地址即可双向重连)
          const learnedUrl = learnPeerUrl(socket, listenPort);
          if (learnedUrl) {
            logger.info(`learned peer ${remoteDeviceId} reachable at ${learnedUrl} (reverse discovery)`);
            // 持久化反向发现的地址:重启 daemon 后本机也能主动重连对方,不依赖对方先连过来
            // (原仅存内存 outboundPeerUrls,重启即丢)。addPeer 幂等去重,且 learnedUrl 已保证 ws:// 格式
            try {
              addPeer(configPath, learnedUrl);
            } catch {
              // learnedUrl 必为 ws://,正常情况下不会抛
            }
          }
          startSyncSession(socket, remoteDeviceId, key, learnedUrl);
        }
      },
      onError(error) {
        logger.error(error.message);
      },
    },
    args.port ?? 22000,
  );

  // mDNS 自动发现:发现对端后自动发起连接并建立会话
  const discovery = startDiscovery(identity, server.port, (peer) => {
    if (isPeerConnected(peer.deviceId)) return;
    // 未授权的对端(已移除,或从未添加)不主动连接。否则移除设备后 mDNS 会把它重新连回来,
    // 握手能过但 startSyncSession 判定未授权,只建控制面会话:界面显示「在线」却不同步数据,
    // 比显示离线更误导。顺带的效果:本机不再主动连接任何未添加的设备。
    const cfg = loadConfig(configPath);
    if (!isPeerAllowed(peer.deviceId, cfg.sharedFolders, cfg.knownDevices)) return;
    const url = `ws://${peer.host}:${peer.port}`;
    connectTo(url, {
      onRejected: (error) =>
        logger.error(`connect to ${peer.deviceId} failed: ${error instanceof Error ? error.message : String(error)}`),
    });
  });

  // 手动配置的对端(mDNS 不可用时的回退):启动时主动连接,失败仅日志
  // 去重由服务端 onPeerConnected 负责:若对端已连,服务端会关闭重复 socket
  for (const peerUrl of config.peers) {
    connectTo(peerUrl, {
      onConnected: (remoteDeviceId) => {
        logger.debug(`outbound connected to ${remoteDeviceId} at ${peerUrl}`);
        logger.info(`connected to configured peer ${remoteDeviceId} (${peerUrl})`);
      },
      onRejected: (error) =>
        logger.error(`connect to configured peer ${peerUrl} failed: ${error instanceof Error ? error.message : String(error)}`),
    });
  }

  logger.info(`syncx daemon started (device ${identity.deviceId}, peer port ${server.port})`);
  logger.info('peer sync (ws://ip:port):');
  logger.info(`  ws://localhost:${server.port}`);
  for (const lan of lanAddresses) {
    logger.info(`  ws://${formatHost(lan.address, lan.family)}:${server.port}`);
  }

  // 本地变更检测:周期扫描所有共享目录,把变化(新增/修改/删除)传播给已连接对端
  const SCAN_INTERVAL_MS = 5000;
  const scanTimer = setInterval(() => {
    void runScan();
  }, SCAN_INTERVAL_MS);

  // 配置热重载:监听 config.json 变更,增量应用共享目录与对端列表变更,无需重启 daemon
  let configWatcher: import('node:fs').FSWatcher | undefined;
  try {
    configWatcher = watch(configPath, (_eventType, _filename) => {
    try {
      const newConfig = loadConfig(configPath);

      // 共享目录变更:新增/移除/更新
      const oldFolderIds = new Set(folderStates.map((f) => f.id));
      const newFolderById = new Map(newConfig.sharedFolders.map((f) => [folderIdFor(f), f]));
      // 移除已删除的目录:关闭索引库,并从所有存活会话的路由表中摘除该目录
      for (const folder of folderStates) {
        if (!newFolderById.has(folder.id)) {
          logger.info(`config updated: removing shared folder ${folder.path}`);
          for (const session of activeSessions) {
            session.peers.delete(folder.id);
            session.transports = session.transports.filter((t) => t.folder.id !== folder.id);
          }
          folder.peers.clear();
          folder.index.close();
        }
      }
      folderStates = folderStates.filter((f) => newFolderById.has(f.id));
      // 新增目录:创建运行期状态,并补建到所有存活会话;已存在目录则应用最新配置
      for (const f of newConfig.sharedFolders) {
        const id = folderIdFor(f);
        const existing = folderStates.find((s) => s.id === id);
        if (!existing) {
          logger.info(`config updated: adding shared folder ${f.path}`);
          const folder = createFolderState(f);
          folderStates.push(folder);
          for (const session of activeSessions) {
            attachFolderToSession(session, folder);
          }
        } else {
          if (existing.path !== f.path) {
            // 路径变更:以新路径重建执行器与本地索引(索引库按 id 复用)
            existing.path = f.path;
            existing.executor = createLocalExecutor(f.path, existing.index);
            existing.localIndex = new Map(
              filterIndexedEntries(parseIgnoreRules(existing.ignoreLines), existing.index.listEntries()).map((e) => [e.path, e]),
            );
          }
          existing.config = f;
        }
      }

      // 对端列表变更:新增对端主动连接
      const newPeers = new Set(newConfig.peers);
      const oldPeers = new Set(config.peers);
      for (const peerUrl of newConfig.peers) {
        if (!oldPeers.has(peerUrl)) {
          logger.info(`config updated: connecting to new peer ${peerUrl}`);
          connectTo(peerUrl, {
            onRejected: (error) =>
              logger.error(`connect to new peer ${peerUrl} failed: ${error instanceof Error ? error.message : String(error)}`),
          });
        }
      }
      // 更新内存中的配置
      config.peers = newConfig.peers;
      config.sharedFolders = newConfig.sharedFolders;
      // 共享关系可能变化(手动改配置文件):向所有存活会话重推目录清单
      for (const session of activeSessions) {
        pushFolderSyncList(session.remoteDeviceId);
      }
    } catch (error) {
      logger.error(`config reload failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  } catch (err) {
    // Windows 上对不存在/不可达路径 fs.watch 会同步抛错;上游已确保配置文件存在,
    // 此处仅作兜底,避免热重载初始化失败拖垮整个 daemon(control server 仍可正常服务)。
    logger.warn(`config hot-reload disabled (cannot watch ${configPath}): ${String(err)}`);
  }

  await new Promise<void>((resolve) => {
const shutdown = (): void => {
    clearInterval(scanTimer);
    configWatcher?.close();
    for (const timer of reconnectTimers.values()) clearTimeout(timer);
    reconnectTimers.clear();
    // 关闭所有 peer socket(入站 + 出站),否则客户端 socket 保持事件循环活跃
    // 导致进程收到 SIGTERM 后无法退出。用 terminate() 强制断开 TCP 连接,
    // 避免 close 握手在对端同时关闭时挂起。
    for (const socket of peerSockets) {
      try {
        socket.terminate();
      } catch {
        // socket 可能已关闭
      }
    }
    peerSockets.clear();
    control.close();
    discovery.close();
    server.close();
    for (const folder of folderStates) {
      folder.index.close();
    }
    // 显式退出,确保所有 handle 关闭后进程立即结束
    process.exit(0);
  };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}
