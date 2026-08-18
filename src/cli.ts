export interface ParsedArgs {
  command: 'start' | 'status' | 'install' | 'invite' | 'join';
  /** 位置参数(如 invite/join 的参数)。 */
  positionals: string[];
  configPath?: string;
  port?: number;
  controlPort?: number;
  /** Control API/Web UI bind host; default 127.0.0.1 (localhost only). */
  host?: string;
}

const COMMANDS = new Set(['start', 'status', 'install', 'invite', 'join']);

export function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;

  const result: ParsedArgs = {
    command: command as ParsedArgs['command'],
    positionals: [],
  };
  if (!COMMANDS.has(result.command)) {
    throw new Error(`unknown command: ${String(command)}`);
  }

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
    } else if (flag.startsWith('-')) {
      throw new Error(`unknown option: ${flag}`);
    } else {
      result.positionals.push(flag);
    }
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
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
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
import { createControlServer } from './api.js';
import { buildStatus } from './status.js';
import { addSharedFolder, removeSharedFolder, isPeerAllowed } from './devices.js';
import { createInviteCode, parseInviteCode } from './invite.js';
import { folderIdFor, folderIndexPath } from './config.js';
import { getLanAddresses, formatHost } from './net/addresses.js';
import { renderSystemdUnit, renderLaunchdPlist, renderWindowsService } from './install.js';
import { renderControlFallback } from './ui-fallback.js';
import type { WebSocket } from 'ws';

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
    const invite = parseInviteCode(code);
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

  // 本地控制 API 先启动(无论是否有共享目录),让用户能在 Web UI 里添加第一个目录
  const token = loadOrCreateToken(configDir);
  const control = createControlServer({
    token,
    renderSsr: controlRenderSsr,
    addFolder: (path, devices) => {
      addSharedFolder(configPath, path, devices);
      console.log(`shared folder added: ${path}`);
    },
    removeFolder: (path) => {
      removeSharedFolder(configPath, path);
      console.log(`shared folder removed: ${path}`);
    },
    // 实时读取配置,Web UI 添加/移除目录后刷新可见
    getStatus: () =>
      buildStatus(
        identity,
        loadConfig(configPath),
        (() => {
          let entries = 0;
          let tombstones = 0;
          for (const folder of folderStates) {
            const all = folder.index.listEntries();
            entries += all.filter((e) => !e.deleted).length;
            tombstones += all.filter((e) => e.deleted).length;
          }
          return { entries, tombstones };
        })(),
      ),
  });
  const controlPort = args.controlPort ?? 8384;
  const controlHost = args.host ?? '127.0.0.1';
  control.listen(controlPort, controlHost);

  const lanAddresses = getLanAddresses();
  console.log(`control UI (token in ${join(configDir, 'control.token')}):`);
  console.log(`  http://${controlHost === '0.0.0.0' ? 'localhost' : controlHost}:${controlPort}`);
  if (controlHost === '0.0.0.0') {
    for (const lan of lanAddresses) {
      console.log(`  http://${formatHost(lan.address, lan.family)}:${controlPort}`);
    }
  }

  // 每个共享目录独立的索引/执行器/本地索引状态
  const folderStates = config.sharedFolders.map((f) => {
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
    return { id, path: f.path, index, executor, localIndex, ignoreLines, transports: [] as PeerTransport[] };
  });

  if (folderStates.length === 0) {
    console.log('no shared folders configured yet; add one via the web UI, then restart the daemon');
    await new Promise<void>((resolve) => {
      const shutdown = (): void => {
        control.close();
        resolve();
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    });
    return;
  }

  /** 校验对端设备是否被任一共享目录授权;未授权则关闭 socket 并打日志。 */
  function acceptPeer(socket: WebSocket, remoteDeviceId: string): boolean {
    const allowed = isPeerAllowed(remoteDeviceId, loadConfig(configPath).sharedFolders);
    if (!allowed) {
      console.log(`rejected unauthorized peer ${remoteDeviceId}`);
      socket.close();
    }
    return allowed;
  }

  /** 在一个 socket 上建立同步会话:为每个共享目录建 peer,按 folder 路由。 */
  function startSyncSession(socket: WebSocket, remoteDeviceId: string, key: Buffer): void {
    const peers = new Map<string, SyncPeer>();
    // 记录本次会话为各目录创建的 transport,便于 socket 断开时从对应目录中清理
    const sessionTransports: Array<{ folder: (typeof folderStates)[number]; transport: PeerTransport }> = [];
    for (const folder of folderStates) {
      const transport = makePeerTransport(socket, key, folder.id);
      folder.transports.push(transport);
      sessionTransports.push({ folder, transport });
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
        remoteDeviceId,
      });
      peers.set(folder.id, peer);
      transport.sendEntries([...folder.localIndex.values()]);
    }
    attachPeerMessages(peers, socket, key);
    socket.on('close', () => {
      for (const { folder, transport } of sessionTransports) {
        const idx = folder.transports.indexOf(transport);
        if (idx >= 0) folder.transports.splice(idx, 1);
      }
    });
  }

  const server = startPeerServer(
    identity,
    {
      onPeerConnected(socket, remoteDeviceId, key) {
        if (acceptPeer(socket, remoteDeviceId)) {
          startSyncSession(socket, remoteDeviceId, key);
        }
      },
      onError(error) {
        console.error(error.message);
      },
    },
    args.port ?? 22000,
  );

  // mDNS 自动发现:发现对端后自动发起连接并建立会话
  const discovery = startDiscovery(identity, server.port, (peer) => {
    void connectPeer(identity, `ws://${peer.host}:${peer.port}`)
      .then(({ socket, remoteDeviceId, key }) => {
        if (acceptPeer(socket, remoteDeviceId)) {
          startSyncSession(socket, remoteDeviceId, key);
        }
      })
      .catch((error) => console.error(`connect to ${peer.deviceId} failed: ${error.message}`));
  });

  // 手动配置的对端(mDNS 不可用时的回退):启动时主动连接,失败仅日志
  for (const peerUrl of config.peers) {
    void connectPeer(identity, peerUrl)
      .then(({ socket, remoteDeviceId, key }) => {
        console.log(`connected to configured peer ${remoteDeviceId} (${peerUrl})`);
        if (acceptPeer(socket, remoteDeviceId)) {
          startSyncSession(socket, remoteDeviceId, key);
        }
      })
      .catch((error) => console.error(`connect to configured peer ${peerUrl} failed: ${error.message}`));
  }

  console.log(`syncx daemon started (device ${identity.deviceId}, peer port ${server.port})`);
  console.log('peer sync (ws://ip:port):');
  console.log(`  ws://localhost:${server.port}`);
  for (const lan of lanAddresses) {
    console.log(`  ws://${formatHost(lan.address, lan.family)}:${server.port}`);
  }

  // 本地变更检测:周期扫描所有共享目录,把变化(新增/修改/删除)传播给已连接对端
  const SCAN_INTERVAL_MS = 5000;
  const scanTimer = setInterval(() => {
    void (async () => {
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
        // 本地删除 → 持久化墓碑(修复:之前只广播不落库,重启后重复广播)并同步内存索引
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
            // 同步内存索引,保证会话内规划不再基于过期快照
            folder.localIndex.set(path, updated);
            sends.push(updated);
          } catch {
            // 文件在扫描后被删除/重命名,下一轮扫描处理
          }
        }
        if (sends.length > 0) {
          // 仅向同目录的 transport 广播,避免把目录 A 的增量错发到目录 B 的对等端
          broadcastFolderUpdates(folder, sends);
        }
      }
    })();
  }, SCAN_INTERVAL_MS);

  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      clearInterval(scanTimer);
      control.close();
      discovery.close();
      server.close();
      for (const folder of folderStates) {
        folder.index.close();
      }
      resolve();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}
