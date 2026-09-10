import type { ParsedArgs } from './args.js';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { loadOrCreateIdentity } from './identity.js';
import { loadConfig, saveConfig } from './config.js';
import { openIndexStore } from './indexstore.js';

import { listSyncHistory } from './history.js';
import { readFileSync, existsSync, writeFileSync, watch, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startPeerServer } from './net/server.js';

import { startDiscovery } from './net/discovery.js';
import { getLanAddresses, formatHost } from './net/addresses.js';
import { createControlServer } from './api.js';
import { buildStatus, type DeviceStatus, type SyncProgress, type FolderErrorStatus } from './status.js';
import { addSharedFolder, removeSharedFolder, isPeerAllowed, addKnownDevice, removeKnownDevice, addPeer, removePeer, setFolderDevices, setFolderGitignore } from './devices.js';
import { markOfferAccepted, markOfferDeclined, restoreDeclinedOffer, listOpenOffers } from './offers.js';
import { createInviteCode, parseInviteCode, revokeInviteCode } from './invite.js';
import { folderIdFor, folderIndexPath } from './config.js';
import { renderSystemdUnit, renderLaunchdPlist, renderWindowsService } from './install.js';
import { createLogger } from './logger.js';
import { runUpgrade } from './upgrade.js';
import { compareVersions } from './upgrade.js';
import { consumeUpdateDoneFile, isBundledRuntime, runSelfUpdate, runtimeVersion } from './selfupdate.js';
import { createUpdateChecker, downloadTarball } from './update-check.js';
import { loadOrCreateToken, daemonStatusLines, stopDaemon, listenControl, pidFilePath, type PidRecord } from './daemon.js';
import { SyncSessionManager } from './session-manager.js';

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

  // stop 必须在身份/配置初始化之前处理:对一台没跑过 syncx 的机器执行 stop
  // 不应该凭空创建身份文件、默认配置等任何东西。
  if (args.command === 'stop') {
    await stopDaemon(configDir, args.controlPort);
    return;
  }

  // upgrade 同样不依赖本地身份/配置:自升级 npm 包,与 ~/.syncx 数据无关
  if (args.command === 'upgrade') {
    await runUpgrade(args.positionals[0]);
    return;
  }

  const identity = loadOrCreateIdentity(configDir);
  const config = loadConfig(configPath);
  // 首次运行(如 dev 未指定 --config,默认 ~/.syncx/config.json):若配置文件不存在,
  // 先写出默认配置,否则下方 fs.watch 在 Windows 上对不存在的路径会同步抛出 ENOENT,
  // 未捕获将导致 daemon 进程崩溃(control server 无法监听,Web UI 代理 502/ECONNREFUSED)。
  if (!existsSync(configPath)) {
    saveConfig(configPath, config);
  }
  if (args.command === 'status') {
    for (const line of await daemonStatusLines(configDir, args.controlPort)) {
      console.log(line);
    }
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
    if (!config.sharedFolders.some((f) => resolve(f.path) === resolve(folderPath))) {
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
    // join 是接受对端邀请的接收映射,标记 remote=true 以启用接收映射间的嵌套约束
    addSharedFolder(configPath, localPath, [invite.deviceId], undefined, true);
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
  // stop 命令经控制 API 触发的优雅关闭。shutdown 在下方资源全部就绪后才被赋值;
  // 就绪前收到调用(API 时机上不可能)是无操作,保证不会关到半初始化的资源。
  let triggerShutdown: () => void = () => {};

  // npm 更新检查(仅打包态):定时查 registry,发现新版本经 status 下发,Web UI 弹升级提示
  const updateChecker = isBundledRuntime() ? createUpdateChecker(runtimeVersion()) : undefined;
  updateChecker?.start();
  // 自更新结果上报:updater 在观察期(默认 2.5s)后才写结果文件,这里延时读取并记日志
  if (process.env.SYNCX_UPDATE_DONE) {
    setTimeout(() => consumeUpdateDoneFile(logger), 5_000).unref();
  }

  // 启动信息(control UI 地址 / dev 模式 / daemon started 等)统一在控制端口绑定成功后输出:
  // 绑定失败(EACCES/EADDRINUSE)时进程直接退出,不会出现 fatal 淹没在正常启动日志里的情况。
  const lanAddresses = getLanAddresses();

  // 会话/目录运行期状态管理器:连接、同步通道、扫描、配置热重载、P2P 自更新全部内聚于此
  const manager = new SyncSessionManager(
    { identity, configPath, configDir, peerPort: args.port ?? 22000, logger },
    config.sharedFolders,
  );
  // 无目录提示也延迟到端口绑定成功后输出(与其它启动日志同批)
  const noFoldersAtBoot = manager.folderStates.length === 0;

  // 控制 API:在 peer 状态和同步进度可用后创建
  const control = createControlServer({
    token,
    // 账号密码落盘位置:与 control.token 同一目录,0600。文件不存在即「仅令牌登录」。
    authFile: join(configDir, 'auth.json'),
    devViteUrl: args.devViteUrl,
    // stop 命令经 POST /api/shutdown 触发:与 SIGTERM 走同一条优雅关闭链路
    shutdown: () => triggerShutdown(),
    // Web UI「从对端升级」:拉取对端安装包并整包替换;重启由 api 路由响应后触发
    selfUpdate: (deviceId) => manager.upgradeFromPeer(deviceId),
    // Web UI「检查更新」:立即查一次 npm registry,返回是否有可用更新
    checkForUpdate: async () => {
      await updateChecker?.check();
      const avail = updateChecker?.available();
      return avail ? { latest: avail.latest, current: avail.current } : undefined;
    },
    // Web UI 确认后的 npm 自升级:下载官方 tgz → 校验 → updater 接管换入
    selfUpdateNpm: async () => {
      if (!isBundledRuntime()) throw new Error('本机为 dev 运行态,不支持自更新');
      let avail = updateChecker?.available();
      if (!avail) {
        // 没有缓存的可用更新时再查一次(可能刚发了新版)
        await updateChecker?.check();
        avail = updateChecker?.available();
      }
      if (!avail) throw new Error(`当前已是最新版本 ${runtimeVersion()},无需升级`);
      const tgz = await downloadTarball(avail.tarballUrl);
      await runSelfUpdate(tgz, avail.latest);
      logger.info(`self-update staged: ${runtimeVersion()} → ${avail.latest} (npm), shutting down for swap`);
      return { version: avail.latest };
    },
    // Web UI「日志」弹窗经 GET /api/logs 读取日志尾部;未设置时端点返回 ok:false
    logFile: args.logFile,
    addFolder: (path, devices, id) => {
      const created = addSharedFolder(configPath, path, devices, id);
      logger.info(`shared folder added: ${path}${created ? ' (auto-created)' : ''}`);
      // 新建目录时即指派的对端,若当前在线立即推送共享邀请,免去对方再建一次目录
      const folder = loadConfig(configPath).sharedFolders.find((f) => resolve(f.path) === resolve(path));
      const fid = folder?.id ?? '';
      for (const d of devices ?? []) {
        manager.pushFolderInvitation(d, fid, fid || path);
        manager.pushFolderSyncList(d);
      }
      return created;
    },
    removeFolder: (path) => {
      // 移除前先记下原指派设备:移除后要向它们重推目录清单(它们 UI 上应显示「已停止共享」)
      const affected = new Set(loadConfig(configPath).sharedFolders.find((f) => resolve(f.path) === resolve(path))?.devices ?? []);
      removeSharedFolder(configPath, path);
      logger.info(`shared folder removed: ${path}`);
      for (const d of affected) manager.pushFolderSyncList(d);
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
      // 自更新资格只认打包态 + 双方都是具体 semver:dev↔build 混跑不做跨形态更新
      const selfVersion = runtimeVersion();
      const isRealVersion = (v: string | undefined): v is string =>
        !!v && v !== 'dev' && /^\d+\.\d+\.\d+/.test(v);
      const devices: DeviceStatus[] = [];
      for (const deviceId of deviceIds) {
        const link = manager.describeDevice(deviceId);
        devices.push({
          deviceId,
          online: link.online,
          url: link.url,
          folders: folderDevices.get(deviceId) ?? [],
          // 对端宣告的目录清单:undefined=旧版本对端(无法判断「已停止共享」)
          remoteFolders: link.remoteFolders,
          // 对端宣告的仍待确认的目录邀请:仅对端为新版本时非空
          remotePendingFolders: link.remotePendingFolders,
          version: link.version,
          canUpgrade:
            isRealVersion(selfVersion) &&
            isRealVersion(link.version) &&
            compareVersions(selfVersion, link.version) < 0,
        });
      }
      const syncProgress = manager.getSyncProgress();
      const { entries, tombstones } = manager.getIndexStats();
      // 目录级同步错误:按发生时间倒序,前端展示到对应目录卡上
      const folderErrors = manager.getFolderErrors();
      return buildStatus(
        identity,
        config,
        { entries, tombstones },
        devices,
        syncProgress,
        // status.offers 下发 pending + declined:已忽略项在 UI 灰显供「恢复」
        listOpenOffers(configPath),
        folderErrors,
        selfVersion,
        // npm 检查到的可用更新:仅打包态有检查器,发现更高版本才非空
        updateChecker?.available(),
      );
    },
    rescan: () => {
      void manager.runScan();
    },
    reconnect: (deviceId) => manager.forceReconnect(deviceId),
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
        manager.connectTo(address, {
          onRejected: (error) =>
            logger.error(`connect to ${address} failed: ${error instanceof Error ? error.message : String(error)}`),
        });
      }
      // 若对端当前已连,立即推送配对请求与既有目录共享邀请(无需等下次重连);
      // notifyPairingIntent 覆盖本机所有已把该对端列入 devices 的目录,使"先加目录后加设备"
      // 或"修复前遗留目录"也能在添加设备这一步即刻送达,不必等掉线重连。
      manager.notifyPairingIntent(deviceId);
    },
    removeDevice: (deviceId) => {
      removeKnownDevice(configPath, deviceId);
      // 连同清理持久化的对端地址(手动填的或反向发现学来的),否则移除后盘上残留、重启仍会去连
      const learnedUrl = manager.getLearnedUrl(deviceId);
      if (learnedUrl) {
        removePeer(configPath, learnedUrl);
      }
      // 断开与该设备的所有会话连接。close 回调会拆掉目录 peer;当前会话的 close 会清书签并
      // 尝试排定重连,但此时 outboundPeerUrls 已清空,scheduleReconnect 直接返回,不会重连。
      const closed = manager.forgetAndCloseSessions(deviceId);
      logger.info(
        `known device removed: ${deviceId}${closed > 0 ? ` (${closed} connection(s) closed)` : ''}`,
      );
    },
    setFolderDevices: (path, devices) => {
      const before = loadConfig(configPath).sharedFolders.find((f) => resolve(f.path) === resolve(path));
      const beforeDevices = new Set(before?.devices ?? []);
      setFolderDevices(configPath, path, devices);
      logger.info(`folder devices updated: ${path}`);
      // 对本次新加入的对端,若当前在线立即推送目录共享邀请(无需等下次重连;离线由重连补推)
      const folder = manager.folderStates.find((f) => resolve(f.path) === resolve(path));
      const fid = folder ? folder.id : before?.id ?? '';
      for (const d of devices) {
        if (!beforeDevices.has(d)) {
          manager.pushFolderInvitation(d, fid, fid || path);
        }
      }
      // 指派变化(新增或摘除)都会改变本机的目录清单,向前后两批设备重推
      for (const d of new Set([...beforeDevices, ...devices])) {
        manager.pushFolderSyncList(d);
      }
    },
    setFolderUseGitignore: (path, enabled) => {
      setFolderGitignore(configPath, path, enabled);
      logger.info(`folder gitignore ${enabled ? 'enabled' : 'disabled'}: ${path}`);
      // 立即生效:重读忽略行并重建本地索引(开关切换会增减被忽略的文件集合)。
      // 配置 watcher 随后也会热重载,这里是让下一次扫描前就生效。
      manager.refreshFolderIgnoreRules(path);
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
        // acceptOffer 是接受对端文件夹邀请的接收映射,标记 remote=true 以启用接收映射间的嵌套约束
        addSharedFolder(configPath, localPath, [offer.fromDeviceId], offer.folderId, true);
        manager.sendControlTo(offer.fromDeviceId, {
          kind: 'folder-invitation-ack',
          offerId: offer.id,
          fromDeviceId: identity.deviceId,
          accepted: true,
        });
        logger.info(`accepted folder invitation ${offer.folderId} from ${offer.fromDeviceId}`);
      } else {
        addKnownDevice(configPath, offer.fromDeviceId);
        manager.sendControlTo(offer.fromDeviceId, {
          kind: 'pairing-ack',
          offerId: offer.id,
          fromDeviceId: identity.deviceId,
          accepted: true,
        });
        logger.info(`accepted pairing request from ${offer.fromDeviceId}`);
      }
      // 确认后本机已信任该对端:升级已有会话(补建目录 peer 并反推本机共享意图),无需等重连
      manager.promoteSession(offer.fromDeviceId);
    },
    declineOffer: (offerId) => {
      const offer = markOfferDeclined(configPath, offerId);
      if (!offer) throw new Error('offer not found');
      // 通知对方本端已忽略;不影响其后续重推(本端按去重键不再弹)
      manager.sendControlTo(offer.fromDeviceId, {
        kind: offer.kind === 'folder' ? 'folder-invitation-ack' : 'pairing-ack',
        offerId: offer.id,
        fromDeviceId: identity.deviceId,
        accepted: false,
      });
      // 待确认项已消失,立即反推目录清单,让对方设备标签从「待对方确认」切回「已停止共享」
      if (offer.kind === 'folder') manager.pushFolderSyncList(offer.fromDeviceId);
      logger.info(`declined offer from ${offer.fromDeviceId}`);
    },
    restoreOffer: (offerId) => {
      const offer = restoreDeclinedOffer(configPath, offerId);
      if (!offer) throw new Error('offer not found or not declined');
      // 恢复后立即反推目录清单,让对方设备标签从「已停止共享」切回「待对方确认」
      if (offer.kind === 'folder') manager.pushFolderSyncList(offer.fromDeviceId);
      logger.info(`restored declined offer from ${offer.fromDeviceId}`);
    },
  });
  // 绑定控制端口:失败(EACCES/EADDRINUSE 等)在 listenControl 内打印根因与修复指引后
  // 直接退出进程;成功才继续往下走,启动日志见下批输出
  await listenControl(control, controlPort, controlHost, (msg) => logger.error(msg));

  // --- 端口绑定成功,输出启动信息 ---
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
  if (noFoldersAtBoot) {
    // 无目录时 daemon 保持运行,通过 Web UI 添加目录后由热重载生效,无需重启
    logger.info('no shared folders configured; the daemon stays up and picks up folders added via the web UI');
  }

  // 记录 pid 与控制端口,供 syncx stop 定位目标(优雅关闭时删除)
  try {
    const pidRecord: PidRecord = { pid: process.pid, controlPort };
    writeFileSync(pidFilePath(configDir), JSON.stringify(pidRecord), { mode: 0o600 });
  } catch (e) {
    logger.warn(`cannot write pid file (syncx stop will fall back to signal): ${String(e)}`);
  }

  const server = startPeerServer(
    identity,
    {
      onPeerConnected(socket, remoteDeviceId, key, listenPort) {
        manager.onInboundPeer(socket, remoteDeviceId, key, listenPort);
      },
      onError(error) {
        logger.error(error.message);
      },
    },
    args.port ?? 22000,
  );

  // mDNS 自动发现:发现对端后自动发起连接并建立会话
  const discovery = startDiscovery(identity, server.port, (peer) => {
    if (manager.isPeerConnected(peer.deviceId)) return;
    // 未授权的对端(已移除,或从未添加)不主动连接。否则移除设备后 mDNS 会把它重新连回来,
    // 握手能过但 startSyncSession 判定未授权,只建控制面会话:界面显示「在线」却不同步数据,
    // 比显示离线更误导。顺带的效果:本机不再主动连接任何未添加的设备。
    const cfg = loadConfig(configPath);
    if (!isPeerAllowed(peer.deviceId, cfg.sharedFolders, cfg.knownDevices)) return;
    const url = `ws://${peer.host}:${peer.port}`;
    manager.connectTo(url, {
      onRejected: (error) =>
        logger.error(`connect to ${peer.deviceId} failed: ${error instanceof Error ? error.message : String(error)}`),
    });
  });

  // 手动配置的对端(mDNS 不可用时的回退):启动时主动连接,失败仅日志
  // 去重由服务端 onPeerConnected 负责:若对端已连,服务端会关闭重复 socket
  for (const peerUrl of config.peers) {
    manager.connectTo(peerUrl, {
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
    void manager.runScan();
  }, SCAN_INTERVAL_MS);

  // 配置热重载:监听 config.json 变更(目录/设备指派对账、重推清单在 manager 内完成),
  // 对端列表新增时本机主动连接;无需重启 daemon
  let configWatcher: import('node:fs').FSWatcher | undefined;
  try {
    configWatcher = watch(configPath, () => {
    try {
      const newConfig = manager.reloadConfig();
      if (!newConfig) return;
      // 对端列表变更:新增对端主动连接
      const oldPeers = new Set(config.peers);
      for (const peerUrl of newConfig.peers) {
        if (!oldPeers.has(peerUrl)) {
          logger.info(`config updated: connecting to new peer ${peerUrl}`);
          manager.connectTo(peerUrl, {
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
  } catch (err) {
    // Windows 上对不存在/不可达路径 fs.watch 会同步抛错;上游已确保配置文件存在,
    // 此处仅作兜底,避免热重载初始化失败拖垮整个 daemon(control server 仍可正常服务)。
    logger.warn(`config hot-reload disabled (cannot watch ${configPath}): ${String(err)}`);
  }

  await new Promise<void>((resolve) => {
const shutdown = (): void => {
    clearInterval(scanTimer);
    updateChecker?.stop();
    configWatcher?.close();
    // 重连定时器、peer socket、目录索引库的清理在 manager 内完成
    manager.close();
    control.close();
    discovery.close();
    server.close();
    // pid 文件:优雅退出即移除,残留的 pid 文件会让 syncx stop 走「stale」分支
    try {
      unlinkSync(pidFilePath(configDir));
    } catch {
      // 已不存在或删除失败:stop 侧有 stale 检测兜底
    }
    // 显式退出,确保所有 handle 关闭后进程立即结束
    process.exit(0);
  };
    // 资源全部就绪,stop 命令经控制 API 触发的关闭从这里开始生效
    triggerShutdown = shutdown;
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}
