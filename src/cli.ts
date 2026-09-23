import type { ParsedArgs } from './args.js';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir, hostname as osHostname } from 'node:os';
import { loadOrCreateIdentity } from './identity.js';
import { loadConfig, saveConfig, mutateConfig, folderTrashPath, folderVersionsPath } from './config.js';
import { readFolderIdentity, removeLegacyFolderMarker } from './folder-identity.js';
import { migrateLegacyTrash } from './trash.js';
import { openIndexStore } from './indexstore.js';

import { getSyncHistory, getGlobalSyncHistory, clearSyncHistory, getHistoryMaxEvents } from './history.js';
import { listConflictCopies, resolveConflictCopy, applyConflictMerge } from './conflicts.js';
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync, watch, unlinkSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPeerServer } from './net/server.js';

import { startDiscovery } from './net/discovery.js';
import { getLanAddresses, formatHost } from './net/addresses.js';
import { createControlServer, type ControlServerDeps } from './api.js';
import { createStatusHub } from './status-hub.js';
import { buildStatus, type DeviceStatus, type SyncProgress, type FolderErrorStatus } from './status.js';
import { addSharedFolder, removeSharedFolder, isPeerAllowed, addKnownDevice, removeKnownDevice, addPeer, removePeer, setFolderDevices, setFolderGitignore, setGlobalSettings, acceptFolderInvitation } from './devices.js';
import { markOfferAccepted, markOfferDeclined, restoreDeclinedOffer, listOpenOffers, findPendingOffer } from './offers.js';
import { createInviteCode, parseInviteCode, revokeInviteCode } from './invite.js';
import { folderIdFor, folderIndexKey, folderIndexPath, purgeOrphanIndexFiles, type SharedFolderConfig } from './config.js';
import { resolveSharePath } from './executor.js';
import { renderSystemdUnit, renderLaunchdPlist, renderWindowsService } from './install.js';
import { createLogger } from './logger.js';
import { runUpgrade } from './upgrade.js';
import { compareVersions } from './upgrade.js';
import { consumeUpdateDoneFile, inspectPackage, isBundledRuntime, runSelfUpdate, runtimeVersion } from './selfupdate.js';
import { createUpdateChecker, downloadTarball } from './update-check.js';
import { loadOrCreateToken, daemonStatusLines, stopDaemon, listenControl, pauseDaemon, pidFilePath, type PidRecord } from './daemon.js';
import { SyncSessionManager, type FolderDiffResult } from './session-manager.js';
import { formatFolderDiff } from './diff-text.js';

/**
 * 目录索引里是否存在「活条目」(非墓碑)。用于启动收养标记前判断该目录是否曾同步过真实文件:
 * 有活条目 + 目录顶层为空,是「盘未挂载 / 目录被整体清空」的典型形态,此时不能贸然补标记。
 * 任何读取异常都按 false(无活条目)处理,不因诊断失败阻塞启动。
 */
function indexHasLiveEntries(configDir: string, folder: SharedFolderConfig): boolean {
  try {
    const store = openIndexStore(folderIndexPath(configDir, folderIndexKey(folder)));
    try {
      return store.listEntries().some((e) => !e.deleted);
    } finally {
      store.close();
    }
  } catch {
    return false;
  }
}

/**
 * 文件版本控制(控制 API 侧):版本目录由 executor 写入(见 snapshotVersion),
 * 这里提供列表 / 恢复 / 删除。版本文件命名 `<relPath>.syncx-v-<stamp>[.<n>]`,
 * 后缀是显式标记,恢复时据此无歧义反推原始相对路径。
 */

/** 版本文件名 → 原始共享目录内相对路径。 */
function versionOriginalPath(versionFile: string): string {
  return versionFile.replace(/\.syncx-v-[0-9a-z]+(\.[0-9]+)?$/, '');
}

/** 按 folderId 在配置里找目录条目;找不到抛错(路由层转 400)。 */
function findConfigFolder(configPath: string, folderId: string): SharedFolderConfig {
  const folder = loadConfig(configPath).sharedFolders.find((f) => folderIdFor(f) === folderId);
  if (!folder) throw new Error('folder not found');
  return folder;
}

/**
 * 递归列出版本目录下的全部版本文件(相对 versionsDir,协议 '/' 分隔)。
 * 版本文件保留了原相对路径的目录结构,所以必须递归;目录不存在视为无版本。
 */
function listVersionFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) out.push(...listVersionFiles(join(dir, e.name), rel));
      else if (e.isFile()) out.push(rel);
    }
  } catch {
    // 目录不存在(尚无任何版本留档):视为空列表
  }
  return out;
}

/** 版本文件的定位与越界校验(join 后必须仍在 versionsDir 内)。返回绝对路径。 */
function locateVersionFile(versionsDir: string, versionFile: string): string {
  if (typeof versionFile !== 'string' || versionFile === '' || !versionFile.includes('.syncx-v-')) {
    throw new Error('invalid version file');
  }
  const abs = join(versionsDir, versionFile);
  const rel = relative(versionsDir, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('unsafe version file');
  return abs;
}

/**
 * diff 命令:对比本机某共享目录与对端**同一个目录 id** 的内容(诊断用)。
 *
 * 走控制 API 而不是直接读本机索引库:对比需要的是**对端的**索引,只有活着的
 * daemon 才持有那条已建立的会话,索引库只说明本机自己。
 *
 * 不指定 --device 时对比该目录指派的全部设备(逐个一段报告)。
 */
async function runDiffCommand(
  args: ParsedArgs,
  configDir: string,
  config: { sharedFolders: SharedFolderConfig[] },
  selfDeviceId: string,
): Promise<void> {
  const target = args.positionals[0];
  if (!target) throw new Error('usage: syncx diff <folder-path> [--device <id>]');
  const folder = config.sharedFolders.find((f) => resolve(f.path) === resolve(target));
  if (!folder) throw new Error(`不是已配置的共享目录: ${target}`);
  const devices = args.device ? [args.device] : (folder.devices ?? []);
  if (devices.length === 0) throw new Error('该目录还没有指派任何设备,无从对比');

  // 令牌只读不建:诊断命令不该在没有 daemon 的机器上凭空创建文件
  const tokenFile = join(configDir, 'control.token');
  if (!existsSync(tokenFile)) {
    throw new Error('找不到控制令牌,syncx 似乎从未在这台机器上启动过');
  }
  const token = readFileSync(tokenFile, 'utf8').trim();
  let record: PidRecord = {};
  try {
    record = JSON.parse(readFileSync(pidFilePath(configDir), 'utf8')) as PidRecord;
  } catch {
    // pid 文件缺失/损坏:仍按默认端口试一次,连不上时下面给出可操作的提示
  }
  const port = args.controlPort ?? record.controlPort ?? 8384;

  for (const device of devices) {
    if (devices.length > 1) console.log(`===== 对端 ${device} =====`);
    const url =
      `http://127.0.0.1:${port}/api/folders/diff` +
      `?folderId=${encodeURIComponent(folderIdFor(folder))}&device=${encodeURIComponent(device)}`;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        // 比 daemon 等对端快照的 20s 上限再宽一点,让 daemon 自己的超时先报出来
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error(`连不上本机 daemon(控制端口 ${port});先执行 syncx status 确认它在运行`);
    }
    const body = (await res.json()) as FolderDiffResult | { error?: string };
    if (!res.ok) {
      throw new Error(('error' in body && body.error) || `对比失败(HTTP ${res.status})`);
    }
    for (const line of formatFolderDiff(body as FolderDiffResult, { localDeviceId: selfDeviceId })) {
      console.log(line);
    }
  }
}

/**
 * Run a command against the daemon's data directory. The lifecycle is kept
 * thin on purpose: real daemon integration tests are a later batch.
 */
export async function run(args: ParsedArgs): Promise<void> {
  // --config 指向完整配置文件路径;--config-dir 指向数据目录(取 <dir>/config.json),
  // 两者同时给出时 --config 优先;都不给则默认 ~/.syncx/config.json。
  // 身份/索引/token/回收站/版本等数据一律存放在配置文件所在目录,因此指定独立的
  // --config-dir 即可与生产实例完全隔离(dev 与生产并行跑两套,见 package.json dev 脚本)。
  const configPath =
    args.configPath ??
    (args.configDir ? join(args.configDir, 'config.json') : join(homedir(), '.syncx', 'config.json'));
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

  // pause/resume 与 stop 同理:操作运行中的 daemon,不在没跑过 syncx 的机器上创建任何文件
  if (args.command === 'pause' || args.command === 'resume') {
    await pauseDaemon(configDir, args.controlPort, args.command === 'pause');
    return;
  }

  // upgrade 不读写身份/配置数据,但「daemon 是否在跑」的探测要看 pid 文件 ——
  // 路径必须跟着 --config-dir/--config 走,数据目录隔离时提示才不会漏判。
  if (args.command === 'upgrade') {
    await runUpgrade(args.positionals[0], { log: console.log, error: console.error }, { pidFile: pidFilePath(configDir) });
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

  // 内容对比:诊断两个设备同一目录 id 的内容差异(只读,走控制 API)
  if (args.command === 'diff') {
    await runDiffCommand(args, configDir, config, identity.deviceId);
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
      throw new Error(`该目录尚未配置为共享目录:「${folderPath}」`);
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

  // --- 启动自愈(必须在 SyncSessionManager 构造之前,此时没有任何索引句柄被持有)---
  // 1) 孤儿索引回收:删掉 configDir 下不属于当前 config 期望集合的 index-*.db。索引库是
  //    可再生缓存(最坏代价只是重扫一次),删除安全。这堵死两条此前无解的残留路径:
  //      a. 关着 daemon 直接改 config.json 删目录 → 压根不会走 markIndexForPurge;
  //      b. 进程在「登记清理」与「热重载真正删除」之间重启 → 内存登记丢失、清理意图蒸发。
  //    残留旧库在索引 key 兜回来时会被复用(旧条目/旧墓碑再次参与对账 → 成批误删对端)。
  try {
    for (const p of purgeOrphanIndexFiles(configDir, config)) {
      logger.info(`orphan index removed (not referenced by config): ${p}`);
    }
  } catch (error) {
    logger.warn(`orphan index sweep failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  // 2) 目录身份指纹收养:为升级前创建的存量目录采集共享根指纹(dev + ino)并落盘。
  //    旧版本用共享根里的 `.syncx-folder` 标记文件做同一件事,但会在用户目录里留下常驻
  //    痕迹(被 git status 报成未跟踪文件)。指纹等价且更强:换盘 / 重新挂载 / 目录被删了
  //    重建都会改变 dev/ino,而「同一个路径上换了另一块盘」标记文件根本认不出。
  //    只收养一次;目录不存在则留给下次启动。危险态(索引里有活条目但目录顶层为空,疑似
  //    未挂载/被清空)不自动收养 —— 否则把坏状态记成正常身份,保护就彻底失效了。
  //    注意 mutateConfig 内部加载的是**独立副本**,而下面构造 SyncSessionManager 用的是上面
  //    第 76 行那份快照:采集到的指纹必须同步回快照,否则 daemon 本次运行仍按「未采集」处理,
  //    退化成结构守卫(「删掉目录里最后一个文件」会被误拦)。
  const startupFolders = config.sharedFolders;
  const identityAdopted = new Set<string>();
  try {
    mutateConfig(configPath, (cfg) => {
      let changed = false;
      for (const f of cfg.sharedFolders) {
        if (f.folderIdentity) continue;
        if (!existsSync(f.path) || !statSync(f.path).isDirectory()) continue;
        if (indexHasLiveEntries(configDir, f) && readdirSync(f.path).length === 0) {
          logger.warn(
            `shared folder looks empty but its index still has entries; refusing to record its ` +
              `identity automatically: ${f.path} (确认目录内容无误后,在界面移除并重新添加该目录)`,
          );
          continue;
        }
        // 平台/文件系统不提供 inode(部分网络盘)时留空:运行期退化为结构守卫,不凭空信任
        const identity = readFolderIdentity(f.path);
        if (!identity) {
          logger.warn(`shared folder identity unavailable (no inode reported by the filesystem): ${f.path}`);
          continue;
        }
        f.folderIdentity = identity;
        for (const live of startupFolders) {
          if (live.path === f.path) live.folderIdentity = identity;
        }
        identityAdopted.add(f.path);
        changed = true;
        logger.info(`shared folder identity recorded: ${f.path} (dev=${identity.dev} ino=${identity.ino})`);
      }
      return changed;
    });
  } catch (error) {
    logger.warn(`folder identity migration failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // 3) 共享目录内遗留元数据清理:删掉旧版写的 `.syncx-folder` 标记文件,并把旧版回收站
  //    `.syncx-trash` 的内容搬到共享目录之外(`<configDir>/trash/<目录实例 key>`)。这两样
  //    留在用户目录里都会以未跟踪文件的形式污染 git status —— 正是本次改造要解决的问题。
  //    只清理**已确认身份**的目录:没记下指纹就说明这个目录还没被信任,此时动它的内容
  //    (哪怕只是删一个标记文件)都不合适,留给下次启动。
  try {
    for (const f of config.sharedFolders) {
      if (!f.folderIdentity && !identityAdopted.has(f.path)) continue;
      if (!existsSync(f.path) || !statSync(f.path).isDirectory()) continue;
      if (removeLegacyFolderMarker(f.path)) {
        logger.info(`legacy mount marker removed from shared folder: ${f.path}`);
      }
      const { moved, failed } = migrateLegacyTrash(f.path, folderTrashPath(configDir, folderIndexKey(f)));
      if (moved > 0) logger.info(`legacy trash moved out of shared folder: ${f.path} (${moved} file(s))`);
      if (failed > 0) {
        logger.warn(`legacy trash migration incomplete, ${failed} file(s) left in ${f.path} (可手动搬运后删除该目录)`);
      }
    }
  } catch (error) {
    logger.warn(`legacy metadata cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // 状态推送通道:Web UI 经 WS /api/events 常连,变更时收推送而不再轮询 /api/status。
  // 取快照的实现是下方控制服务 deps 里的 getStatus —— 那里才拿得到 manager。
  // 这里经闭包延迟取用(而非提前创建 deps):hub 必须先于 manager 存在(manager 需要
  // 它的 notify),而 deps 又需要 manager,先后顺序只能这样错开。箭头函数在
  // deps 初始化完成后才可能被调用(要有人连上才取快照),不存在取值窗口。
  const statusHub = createStatusHub({
    getStatus: () => controlDeps.getStatus(),
    log: (message) => logger.debug(message),
  });

  // 会话/目录运行期状态管理器:连接、同步通道、扫描、配置热重载、P2P 自更新全部内聚于此
  const manager = new SyncSessionManager(
    {
      identity,
      configPath,
      configDir,
      peerPort: args.port ?? 22000,
      logger,
      // 会话内的状态变更(上下线/邀请/错误/扫描结果)实时喂给 Web UI 推送通道。
      // 拓扑:cli 先建 hub(hub 只持有取快照的闭包,不依赖 manager)→ 再建 manager
      // (需要 hub 的 notify)→ 最后建控制服务(hub 由它按 upgrade 挂连接)。
      onStatusChanged: () => statusHub.notify(),
    },
    config.sharedFolders,
  );
  // 无目录提示也延迟到端口绑定成功后输出(与其它启动日志同批)
  const noFoldersAtBoot = manager.folderStates.length === 0;

  // 控制 API 的依赖:在 peer 状态和同步进度可用后创建(deps 提到独立 const 是为了让
  // 上方的状态推送通道能取到同一份 getStatus 实现,避免两处各写一遍状态快照)。
  const controlDeps: ControlServerDeps = {
    token,
    // 数据目录:登录页令牌输入框的路径提示(control.token 位置)据此动态生成
    configDir,
    // 账号密码落盘位置:与 control.token 同一目录,0600。文件不存在即「仅令牌登录」。
    authFile: join(configDir, 'auth.json'),
    devViteUrl: args.devViteUrl,
    // dev 运行态(dev 子命令 / 源码启动)无单文件运行时可替换:所有自更新接口由路由层统一拒绝,
    // 与前端入口拦截互为纵深防御。打包形态 isBundledRuntime() 为 true,此标记即 false。
    devMode: !isBundledRuntime(),
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
    // Web UI「上传安装包」第一步:只读预检,读出包内版本供前端展示升级前后对比
    inspectLocalPackage: async (tgz) => {
      const info = await inspectPackage(tgz);
      return { version: info.version, name: info.name, current: runtimeVersion() };
    },
    // Web UI「上传安装包」第二步:本地打好的包没有「宣告版本」,目标版本以包内 package.json 为准
    selfUpdateUpload: async (tgz) => {
      if (!isBundledRuntime()) throw new Error('本机为 dev 运行态,不支持自更新');
      const { version } = await runSelfUpdate(tgz, undefined);
      logger.info(`self-update staged: ${runtimeVersion()} → ${version} (uploaded package), shutting down for swap`);
      return { version };
    },
    // Web UI「日志」弹窗经 GET /api/logs 读取日志尾部;未设置时端点返回 ok:false
    logFile: args.logFile,
    addFolder: (path, devices, id, receiveOnly) => {
      // 参数顺序务必对齐:addSharedFolder(configPath, path, devices, id, remote, receiveOnly)。
      // 第 5 位是 remote(Web UI 添加的是本机自有目录,恒为 undefined/false),receiveOnly 在第 6 位。
      // 传错位置的后果是「接收模式」被写成 remote,而真正的 receiveOnly 永远是 false(静默失效)。
      const created = addSharedFolder(configPath, path, devices, id, undefined, receiveOnly);
      logger.info(`shared folder added: ${path}${created ? ' (auto-created)' : ''}${receiveOnly ? ' (receive-only)' : ''}`);
      // 配置已落盘:显式热重载,把新目录的同步通道立即挂载到存活会话,免去手动重启
      manager.reloadConfig();
      // 新建目录时即指派的对端,若当前在线立即推送共享邀请,免去对方再建一次目录
      const folder = loadConfig(configPath).sharedFolders.find((f) => resolve(f.path) === resolve(path));
      const fid = folder?.id ?? '';
      for (const d of devices ?? []) {
        manager.pushFolderInvitation(d, fid, fid || path);
        manager.pushFolderSyncList(d);
      }
      return created;
    },
    removeFolder: (path, opts) => {
      // 移除前先记下原指派设备:移除后要向它们重推目录清单(它们 UI 上应显示「已停止共享」)
      const folder = loadConfig(configPath).sharedFolders.find((f) => resolve(f.path) === resolve(path));
      const affected = new Set(folder?.devices ?? []);
      const purgeIndex = opts?.purgeIndex === true;
      removeSharedFolder(configPath, path, purgeIndex);
      // 索引库按「目录实例 key」(instanceId ?? folderId)命名,登记/核对都用同一口径
      const purgeKey = folder ? folderIndexKey(folder) : undefined;
      if (purgeIndex && purgeKey) {
        // daemon 仍持有索引连接时(尤其 Windows)直接 unlink 会失败,登记待热重载关闭后再删
        manager.markIndexForPurge(purgeKey);
      }
      // 显式热重载:关闭该目录的索引连接,并在此之后真正 unlink 索引库。
      // 不能只依赖 fs watcher —— daemon 持有 .db 句柄时即时删除必然失败(Windows EBUSY),
      // 唯一可靠的删除时机是 reloadConfig 里 close() 之后;少了这一步,索引库就会残留,
      // 同一 folderId 再次添加时复用旧条目/旧墓碑,把对端文件成批删掉(2026-09-15 事故根因)。
      manager.reloadConfig();
      if (purgeIndex && purgeKey) {
        // 如实汇报清理结果:残留必须能被发现,而不是打印一句「已清理」就了事
        // (残留本身已不再致命:目录实例化保证新实例打开新文件名的空库,启动孤儿回收兜底清理)
        const dbPath = folderIndexPath(configDir, purgeKey);
        if (existsSync(dbPath)) logger.warn(`index purge failed (still exists): ${dbPath}`);
        else logger.info(`index purged: ${dbPath}`);
      }
      logger.info(`shared folder removed: ${path}${purgeIndex ? ' (purge index requested)' : ''}`);
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
          hostname: link.hostname,
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
      // 最近中转活动(ADR-0014 遥测):本机作为枢纽转发来源设备变更给其他对端的记录
      const relayActivity = manager.getRelayActivity();
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
        relayActivity,
        // 扩展口径:目录卡冲突徽标计数 + 传输统计(采样环在 manager 内维护)
        // + 本机主机名/局域网地址(顶栏 chip;地址每次现取,网卡热插拔也能跟上)
        {
          conflictCounts: manager.folderConflictCounts(),
          traffic: manager.getTrafficStats(),
          hostname: osHostname(),
          localAddresses: getLanAddresses().map((a) => a.address),
          // 全局设置当前值:设置弹窗预填(historyMaxEvents 取运行期生效值,含默认兜底)
          settings: {
            maxSendKbps: config.maxSendKbps,
            versionsPerPath: config.versionsPerPath,
            historyMaxEvents: getHistoryMaxEvents(),
          },
          // 数据目录:日志弹窗等处的示例命令要跟真实目录走(--config-dir 隔离时不误导)
          configDir,
        },
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
      // knownDevices 直接改配置文件,不经过 manager 的热重载路径 —— 手动通知一次,
      // 否则新设备要等兜底重算才出现在设备卡片上
      statusHub.notify();
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
      statusHub.notify();
    },
    setFolderDevices: (path, devices) => {
      const before = loadConfig(configPath).sharedFolders.find((f) => resolve(f.path) === resolve(path));
      const beforeDevices = new Set(before?.devices ?? []);
      setFolderDevices(configPath, path, devices);
      // 配置已落盘:显式热重载,把「指派变化」立即对账到存活会话(新增设备补挂通道、摘除设备摘通道)。
      // 不显式调用则只依赖 config watcher —— watcher 未触发/被禁用(见下方 config hot-reload disabled
      // 分支)或 fs.watch 的 filename 为 null 时,指派变更要等重连才生效(与 addFolder 同款处理)。
      manager.reloadConfig();
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
      // 目录的 devices 列表直接下发在 status 里,改完立即刷新
      statusHub.notify();
    },
    setFolderUseGitignore: (path, enabled) => {
      setFolderGitignore(configPath, path, enabled);
      logger.info(`folder gitignore ${enabled ? 'enabled' : 'disabled'}: ${path}`);
      // 立即生效:重读忽略行并重建本地索引(开关切换会增减被忽略的文件集合)。
      // 配置 watcher 随后也会热重载,这里是让下一次扫描前就生效。
      manager.refreshFolderIgnoreRules(path);
      statusHub.notify();
    },
    setFolderPaused: (folderId, paused) => {
      // 落盘 + 对账存活会话 + notifyStatus 都在 manager 内完成
      manager.setFolderPaused(folderId, paused);
    },
    setFolderSchedule: (folderId, schedule) => {
      // 校验(非法格式 400)+ 落盘 + 立即对账都在 manager 内完成
      manager.setFolderSchedule(folderId, schedule);
    },
    setGlobalSettings: (patch) => {
      // 落盘 + 按需热生效(重建通道/执行器/历史上限)都在 manager 内完成
      manager.setGlobalSettings(patch);
    },
    setGlobalPaused: (paused) => {
      manager.setGlobalPaused(paused);
    },
    reAdoptFolderIdentity: (folderId) => {
      // 采集 + 写回 config + 清错误 + 补扫都在 manager 内完成;不可读时抛错由路由转 400
      manager.reAdoptFolderIdentity(folderId);
    },
    // 待确认区下发 pending + declined:已忽略项灰显供「恢复」,兜住手误忽略
    getOffers: () => listOpenOffers(configPath),
    getFolderHistory: (folderId, limit, filter) => getSyncHistory(configPath, folderId, limit, filter),
    // 全局时间线:遍历配置里的目录(wire id 兜 path),逐目录取前 limit 条归并
    getGlobalHistory: (limit, filter) =>
      getGlobalSyncHistory(
        configPath,
        loadConfig(configPath).sharedFolders.map((f) => ({ id: folderIdFor(f), path: f.path })),
        limit,
        filter,
      ),
    clearFolderHistory: (folderId) => clearSyncHistory(configPath, folderId),
    // 冲突收件箱:列举走实时扫盘(权威口径,手动删掉的副本不会误报);处理做完
    // 追一轮扫描 —— 「保留本地版」写回原路径、两版收尾移入回收站,都改变了盘面,
    // 要沿正常同步路径广播给对端收敛。
    listFolderConflicts: (folderId) => {
      const folder = findConfigFolder(configPath, folderId);
      return listConflictCopies(folder.path);
    },
    resolveFolderConflict: (folderId, copyPath, choice) => {
      const folder = findConfigFolder(configPath, folderId);
      const key = folderIndexKey(folder);
      resolveConflictCopy(folder.path, folderTrashPath(configDir, key), folderVersionsPath(configDir, key), copyPath, choice);
      void manager.runScan();
    },
    // 冲突「查看对比」:两个本机侧(原文件 vs 副本)交给 manager 复用同一套读取/降级逻辑
    conflictFilePair: (folderId, copyPath) => manager.readConflictPair(folderId, copyPath),
    // 逐块合并写回:内容进原文件(当前内容留档),副本不动;随后触发扫描广播收敛对端
    applyConflictMerge: (folderId, copyPath, content) => {
      const folder = findConfigFolder(configPath, folderId);
      applyConflictMerge(folder.path, folderVersionsPath(configDir, folderIndexKey(folder)), copyPath, content);
      void manager.runScan();
    },
    // 一键清理:把逐字节无差异的副本移入回收站(有差异/无法判定的不碰),最后统一扫一轮
    cleanIdenticalConflicts: (folderId) => {
      const folder = findConfigFolder(configPath, folderId);
      const key = folderIndexKey(folder);
      const trash = folderTrashPath(configDir, key);
      const { conflicts } = listConflictCopies(folder.path);
      let removed = 0;
      for (const c of conflicts) {
        if (c.identical !== true) continue;
        try {
          resolveConflictCopy(folder.path, trash, undefined, c.copyPath, 'discard');
          removed += 1;
        } catch {
          /* 单条失败(竞态删除等)不影响其余,计数如实 */
        }
      }
      if (removed > 0) void manager.runScan();
      return { removed };
    },
    // 文件版本:列出 / 恢复 / 删除。恢复 = 把旧版本拷回共享目录原路径,
    // 恢复前把当前内容也拷一份进版本目录(操作可逆),随后触发一轮扫描让恢复
    // 产生的「本地修改」尽快广播给对端。
    listFolderVersions: (folderId) => {
      const folder = findConfigFolder(configPath, folderId);
      const versionsDir = folderVersionsPath(configDir, folderIndexKey(folder));
      const versions = listVersionFiles(versionsDir)
        .map((file) => {
          const st = statSync(join(versionsDir, file));
          return { file, path: versionOriginalPath(file), size: st.size, mtime: st.mtimeMs };
        })
        .sort((a, b) => a.path.localeCompare(b.path) || a.file.localeCompare(b.file));
      return { versions };
    },
    restoreFolderVersion: (folderId, file) => {
      const folder = findConfigFolder(configPath, folderId);
      const versionsDir = folderVersionsPath(configDir, folderIndexKey(folder));
      const src = locateVersionFile(versionsDir, file);
      if (!existsSync(src) || !statSync(src).isFile()) throw new Error('version not found');
      const relPath = versionOriginalPath(file);
      const dest = resolveSharePath(folder.path, relPath);
      if (existsSync(dest) && statSync(dest).isFile()) {
        // 当前内容留档,恢复动作本身可逆
        mkdirSync(versionsDir, { recursive: true });
        const stamp = Date.now().toString(36);
        let backup = join(versionsDir, `${relPath}.syncx-v-${stamp}`);
        let n = 0;
        while (existsSync(backup)) {
          n += 1;
          backup = join(versionsDir, `${relPath}.syncx-v-${stamp}.${n}`);
        }
        copyFileSync(dest, backup);
      }
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
      void manager.runScan();
    },
    deleteFolderVersion: (folderId, file) => {
      const folder = findConfigFolder(configPath, folderId);
      const versionsDir = folderVersionsPath(configDir, folderIndexKey(folder));
      rmSync(locateVersionFile(versionsDir, file));
    },
    // 内容对比(诊断,只读):向对端索取同一目录 id 的索引快照并分类差异
    diffFolder: (folderId, deviceId) => manager.diffFolder(folderId, deviceId),
    // 双栏对比页:同一份只读数据再带上两侧条目清单
    compareFolder: (folderId, deviceId) => manager.compareFolder(folderId, deviceId),
    // 文件内容对比弹窗(只读)与其同步动作
    readFilePair: (folderId, deviceId, path) => manager.readFilePair(folderId, deviceId, path),
    applyFileSync: (opts) => manager.applyFileSync(opts),
    acceptOffer: (offerId, localPath, receiveOnly) => {
      // 先查再落状态:校验失败时不能把邀请标成 accepted,否则目录没建起来、
      // 卡片却已从「待确认」消失,用户失去重试入口。
      const offer = findPendingOffer(configPath, offerId);
      if (!offer) throw new Error('offer not found');
      if (offer.kind === 'folder') {
        // 接受目录邀请:把对端的 folderId 落到本机目录。
        // acceptFolderInvitation 会按 id 复用 / 按路径对齐 id / 或新建,确保接受后本机目录的
        // folderId 与对端一致,否则对端按 folderId 推送会路由不到(静默不同步)。
        if (!offer.folderId) throw new Error('folder offer missing folder id');
        acceptFolderInvitation(configPath, offer.folderId, offer.fromDeviceId, localPath, receiveOnly);
        markOfferAccepted(configPath, offerId);
        manager.sendControlTo(offer.fromDeviceId, {
          kind: 'folder-invitation-ack',
          offerId: offer.id,
          fromDeviceId: identity.deviceId,
          accepted: true,
        });
        logger.info(`accepted folder invitation ${offer.folderId} from ${offer.fromDeviceId}`);
        // 接受后目录已写入配置:显式热重载挂载同步通道,免去手动重启
        manager.reloadConfig();
      } else {
        markOfferAccepted(configPath, offerId);
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
      // 待确认卡片消失 + (配对接受时)knownDevices 变化;目录分支的 reloadConfig
      // 虽已通知,但配对分支不经过它,这里统一收口
      statusHub.notify();
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
      statusHub.notify();
    },
    restoreOffer: (offerId) => {
      const offer = restoreDeclinedOffer(configPath, offerId);
      if (!offer) throw new Error('offer not found or not declined');
      // 恢复后立即反推目录清单,让对方设备标签从「已停止共享」切回「待对方确认」
      if (offer.kind === 'folder') manager.pushFolderSyncList(offer.fromDeviceId);
      logger.info(`restored declined offer from ${offer.fromDeviceId}`);
      statusHub.notify();
    },
    // 状态推送通道:控制服务在 WS upgrade 阶段完成鉴权后把连接交给它
    statusHub,
  };
  const control = createControlServer(controlDeps);
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

  // 本地变更检测:周期扫描所有共享目录,把变化(新增/修改/删除)传播给已连接对端。
  // 集成测试用 SYNCX_SCAN_INTERVAL_MS 调快节奏(250ms),生产默认 5s。
  const SCAN_INTERVAL_MS = Number(process.env.SYNCX_SCAN_INTERVAL_MS) || 5000;
  const scanTimer = setInterval(() => {
    void manager.runScan();
  }, SCAN_INTERVAL_MS);

  // 配置热重载:监听配置文件所在目录,过滤文件名命中 config.json 再触发重载。
  // 注意:**不能**直接 watch(configPath) 本身——saveConfig 用 renameSync 原子写,
  // 在 Linux 上 fs.watch 跟随的是原 inode,文件被替换后 watcher 失效、热重载不再触发
  // (这正是「运行时加目录不挂载通道」的根因)。watch 目录后 rename/创建事件会带文件名,
  // 过滤后即可靠命中。对端列表新增时本机主动连接;无需重启 daemon
  let configWatcher: import('node:fs').FSWatcher | undefined;
  const configFileName = basename(configPath);
  try {
    configWatcher = watch(dirname(configPath), (_event, filename) => {
    // 只处理目标配置文件自身的变更(同目录下的索引库/日志等变更忽略),避免无谓热重载
    if (filename !== configFileName) return;
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
    // 状态推送连接先于控制端口关闭:否则浏览器会以为通道还活着,一直等推送而不重连
    statusHub.close();
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
