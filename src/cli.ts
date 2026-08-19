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
}

const COMMANDS = new Set(['start', 'status', 'install', 'invite', 'join', 'revoke']);

/** 控制 API 可安全绑定的回环地址;非回环地址必须显式 --expose-control。 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;

  const result: ParsedArgs = {
    command: command as ParsedArgs['command'],
    positionals: [],
  };
  if (!COMMANDS.has(result.command)) {
    throw new Error(`unknown command: ${String(command)}`);
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
import { loadConfig } from './config.js';
import { openIndexStore, type IndexStore } from './indexstore.js';
import { createLocalExecutor, type LocalExecutor } from './executor.js';
import { filterIndexedEntries, parseIgnoreRules } from './ignore.js';
import { createSyncPeer, type PeerTransport, type SyncPeer } from './peer.js';
import { scanFolder } from './scanner.js';
import type { IndexEntry } from './index.js';
import { splitIntoBlocks } from './blockstore.js';
import { broadcastFolderUpdates } from './broadcast.js';
import { readFileSync, existsSync, writeFileSync, watch } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ControlServerDeps } from './api.js';

/** Vite SSR bundle location; resolved at runtime so tsx dev can import it. */
const SSR_ENTRY = new URL('../dist/ui/server.js', import.meta.url);

async function controlRenderSsr(
  data: { status?: unknown; error?: string; message?: string },
): Promise<string> {
  try {
    const { render } = await import(SSR_ENTRY.href);
    return render(data.status ? 'status' : 'login', data);
  } catch {
    // SSR 包缺失(未执行 npm run build)时,回退到内置渲染器,保证控制页可用
    return renderControlFallback(data);
  }
}

import { startPeerServer } from './net/server.js';
import { connectPeer } from './net/client.js';
import { startDiscovery } from './net/discovery.js';
import { makePeerTransport, attachPeerMessages } from './net/wire.js';
import { RateLimiter } from './ratelimit.js';
import { createControlServer } from './api.js';
import { buildStatus, type PeerStatus, type SyncProgress } from './status.js';
import { addSharedFolder, removeSharedFolder, isPeerAllowed } from './devices.js';
import { createInviteCode, parseInviteCode, revokeInviteCode } from './invite.js';
import { folderIdFor, folderIndexPath, type SharedFolderConfig } from './config.js';
import { getLanAddresses, formatHost } from './net/addresses.js';
import { renderSystemdUnit, renderLaunchdPlist, renderWindowsService } from './install.js';
import { renderControlFallback } from './ui-fallback.js';
import type { WebSocket } from 'ws';
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
}

/** 一条存活的对端会话:配置热重载新增/移除目录时,对现有连接补建或摘除对应 peer。 */
interface ActiveSession {
  socket: WebSocket;
  key: Buffer;
  remoteDeviceId: string;
  peers: Map<string, SyncPeer>;
  transports: Array<{ folder: FolderState; transport: PeerTransport }>;
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
    const mainPath = fileURLToPath(new URL('./main.js', import.meta.url));
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
    return { id, path: f.path, index, executor, localIndex, ignoreLines, transports: [], peers: new Map(), config: f };
  }

  // 每个共享目录独立的索引/执行器/本地索引状态(可变:配置热重载可新增/移除目录)
  let folderStates: FolderState[] = config.sharedFolders.map(createFolderState);
  if (folderStates.length === 0) {
    // 无目录时 daemon 保持运行,通过 Web UI 添加目录后由热重载生效,无需重启
    logger.info('no shared folders configured; the daemon stays up and picks up folders added via the web UI');
  }

  /** 校验对端设备是否被任一共享目录授权;未授权则关闭 socket 并打日志。 */
  function acceptPeer(socket: WebSocket, remoteDeviceId: string): boolean {
    const allowed = isPeerAllowed(remoteDeviceId, loadConfig(configPath).sharedFolders);
    if (!allowed) {
      logger.warn(`rejected unauthorized peer ${remoteDeviceId}`);
      socket.close();
    }
    return allowed;
  }

  // --- 对端连接去重与断线重连 ---
  // mDNS 重播 + config.peers 主动连接可能在同一对端上建立多条连接;
  // 按 deviceId 计数,保证每个对端最多保留两条连接(入站 + 出站各一)。
  // 双方同时主动连接时两条都保留,任一断开后另一条仍可用。
  const peerConnectionCount = new Map<string, number>();
  // 记录由本机主动发起(outbound)的连接的 URL,断线后可按 URL 重连;
  // 入站连接(url 未知)依赖对端重连。
  const outboundPeerUrls = new Map<string, string>();
  const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const reconnectAttempts = new Map<string, number>();
  // 跟踪所有 peer socket(入站 + 出站),关闭时统一断开,避免客户端 socket
  // 保持事件循环活跃导致进程无法退出。
  const peerSockets = new Set<WebSocket>();
  const RECONNECT_BASE_MS = 1000;
  const RECONNECT_MAX_MS = 30000;
  const MAX_CONNECTIONS_PER_PEER = 2;

  function isPeerConnected(deviceId: string): boolean {
    return (peerConnectionCount.get(deviceId) ?? 0) > 0;
  }

  function registerPeer(deviceId: string, url?: string): void {
    peerConnectionCount.set(deviceId, (peerConnectionCount.get(deviceId) ?? 0) + 1);
    if (url) {
      outboundPeerUrls.set(deviceId, url);
      reconnectAttempts.delete(deviceId);
    }
  }

  function unregisterPeer(deviceId: string): void {
    const count = (peerConnectionCount.get(deviceId) ?? 1) - 1;
    if (count <= 0) {
      peerConnectionCount.delete(deviceId);
    } else {
      peerConnectionCount.set(deviceId, count);
    }
    const timer = reconnectTimers.get(deviceId);
    if (timer) {
      clearTimeout(timer);
      reconnectTimers.delete(deviceId);
    }
    // 仅当该对端所有连接都断开时才重连
    if (count <= 0) {
      scheduleReconnect(deviceId);
    }
  }

  /**
   * 连接到指定对端并建立同步会话:对端已有连接时关闭重复 socket,
   * 未授权则拒绝;失败时按调用方策略处理(默认记日志)。
   */
  function connectTo(
    url: string,
    opts: {
      onConnected?: (remoteDeviceId: string) => void;
      onRejected?: (error: unknown) => void;
    } = {},
  ): void {
    void connectPeer(identity, url)
      .then(({ socket, remoteDeviceId, key }) => {
        if (isPeerConnected(remoteDeviceId)) {
          // 对端已有连接(入站或出站),关闭重复的 socket
          socket.close();
          return;
        }
        opts.onConnected?.(remoteDeviceId);
        if (acceptPeer(socket, remoteDeviceId)) {
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
    const attempts = (reconnectAttempts.get(deviceId) ?? 0) + 1;
    reconnectAttempts.set(deviceId, attempts);
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (attempts - 1), RECONNECT_MAX_MS);
    logger.info(`peer ${deviceId} disconnected, reconnecting in ${delay}ms`);
    const timer = setTimeout(() => {
      reconnectTimers.delete(deviceId);
      connectTo(url, { onRejected: () => scheduleReconnect(deviceId) });
    }, delay);
    reconnectTimers.set(deviceId, timer);
  }

  /** 手动触发一轮扫描:与定时扫描逻辑一致。 */
  async function runScan(): Promise<void> {
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
      for (const tomb of diff.tombstones) {
        try {
          await folder.executor.applyDelete(tomb.path, tomb);
          folder.localIndex.set(tomb.path, tomb);
        } catch {
          // 索引写入失败,下一轮扫描重试
        }
      }
      const sends: IndexEntry[] = [...diff.tombstones];
      for (const path of diff.changed) {
        try {
          const updated = await folder.executor.applySend(path, identity.deviceId);
          folder.localIndex.set(path, updated);
          sends.push(updated);
        } catch {
          // 文件在扫描后被删除/重命名,下一轮扫描处理
        }
      }
      if (sends.length > 0) {
        broadcastFolderUpdates(folder, sends);
      }
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
        // 防止对端用 ../ 等路径穿越读取共享目录外的文件
        const abs = join(folder.path, path);
        const rel = relative(folder.path, abs);
        if (rel.startsWith('..') || isAbsolute(rel)) {
          throw new Error(`unsafe path: ${path}`);
        }
        const blocks = splitIntoBlocks(readFileSync(abs));
        const block = blocks[blockIndex];
        if (!block) {
          throw new Error(`block ${blockIndex} out of range for ${path}`);
        }
        return block;
      },
      deviceId: identity.deviceId,
      remoteDeviceId: session.remoteDeviceId,
    });
    session.peers.set(folder.id, peer);
    folder.peers.set(session.remoteDeviceId, peer);
    transport.sendEntries([...folder.localIndex.values()]);
  }

  /** 在一个 socket 上建立同步会话:为每个共享目录建 peer,按 folder 路由。 */
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
    for (const folder of folderStates) {
      attachFolderToSession(session, folder);
    }
    attachPeerMessages(session.peers, socket, key);
    socket.on('error', (error) => logger.debug(`socket error for peer ${remoteDeviceId}: ${error.message}`));
    socket.on('close', (code, reason) => {
      logger.debug(`socket closed for peer ${remoteDeviceId}, code=${code}, reason=${reason?.toString('utf8') ?? '(empty)'}`);
      peerSockets.delete(socket);
      const sessionIdx = activeSessions.indexOf(session);
      if (sessionIdx >= 0) activeSessions.splice(sessionIdx, 1);
      for (const { folder, transport } of session.transports) {
        const idx = folder.transports.indexOf(transport);
        if (idx >= 0) folder.transports.splice(idx, 1);
        folder.peers.delete(remoteDeviceId);
      }
      unregisterPeer(remoteDeviceId);
    });
  }

  // 控制 API:在 peer 状态和同步进度可用后创建
  const control = createControlServer({
    token,
    renderSsr: controlRenderSsr,
    addFolder: (path, devices) => {
      addSharedFolder(configPath, path, devices);
      logger.info(`shared folder added: ${path}`);
    },
    removeFolder: (path) => {
      removeSharedFolder(configPath, path);
      logger.info(`shared folder removed: ${path}`);
    },
    getStatus: () => {
      // 收集所有已配置对端的在线状态
      const allDeviceIds = new Set<string>();
      for (const f of loadConfig(configPath).sharedFolders) {
        for (const d of f.devices ?? []) {
          allDeviceIds.add(d);
        }
      }
      const peers: PeerStatus[] = [];
      for (const deviceId of allDeviceIds) {
        peers.push({
          deviceId,
          online: isPeerConnected(deviceId),
          url: outboundPeerUrls.get(deviceId),
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
        loadConfig(configPath),
        { entries, tombstones },
        peers,
        syncProgress,
      );
    },
    rescan: () => {
      void runScan();
    },
    reconnect: (deviceId) => forceReconnect(deviceId),
  });
  control.listen(controlPort, controlHost);

  const server = startPeerServer(
    identity,
    {
      onPeerConnected(socket, remoteDeviceId, key) {
        logger.debug(`inbound peer connected: ${remoteDeviceId}, count=${peerConnectionCount.get(remoteDeviceId) ?? 0}`);
        if (peerConnectionCount.get(remoteDeviceId) ?? 0 >= MAX_CONNECTIONS_PER_PEER) {
          socket.close();
          return;
        }
        if (acceptPeer(socket, remoteDeviceId)) {
          startSyncSession(socket, remoteDeviceId, key);
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
  const configWatcher = watch(configPath, (_eventType, _filename) => {
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
    } catch (error) {
      logger.error(`config reload failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  await new Promise<void>((resolve) => {
const shutdown = (): void => {
    clearInterval(scanTimer);
    configWatcher.close();
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
