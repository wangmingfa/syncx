export interface ParsedArgs {
  command: 'start' | 'status';
  configPath?: string;
  port?: number;
  controlPort?: number;
  /** Control API/Web UI bind host; default 127.0.0.1 (localhost only). */
  host?: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;

  const result: ParsedArgs = { command: command as 'start' | 'status' };
  if (result.command !== 'start' && result.command !== 'status') {
    throw new Error(`unknown command: ${String(command)}`);
  }

  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
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
    } else {
      throw new Error(`unknown option: ${flag}`);
    }
  }

  return result;
}

import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { loadOrCreateIdentity } from './identity.js';
import { loadConfig } from './config.js';
import { openIndexStore } from './indexstore.js';
import { createLocalExecutor } from './executor.js';
import { filterIndexedEntries, parseIgnoreRules } from './ignore.js';
import { createSyncPeer } from './peer.js';
import { splitIntoBlocks } from './blockstore.js';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { startPeerServer } from './net/server.js';
import { connectPeer } from './net/client.js';
import { startDiscovery } from './net/discovery.js';
import { makePeerTransport, attachPeerMessages } from './net/wire.js';
import { createControlServer } from './api.js';
import { buildStatus } from './status.js';
import { addSharedFolder, removeSharedFolder } from './devices.js';
import { getLanAddresses, formatHost } from './net/addresses.js';
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
  const configDir = args.configPath ? dirname(args.configPath) : join(homedir(), '.syncx');

  const identity = loadOrCreateIdentity(configDir);
  const config = loadConfig(join(configDir, 'config.json'));
  const index = openIndexStore(join(configDir, 'index.db'));

  if (args.command === 'status') {
    console.log(`device: ${identity.deviceId}`);
    console.log(`shared folders: ${config.sharedFolders.length}`);
    index.close();
    return;
  }

  // 本地控制 API 先启动(无论是否有共享目录),让用户能在 Web UI 里添加第一个目录
  const token = loadOrCreateToken(configDir);
  const configPath = join(configDir, 'config.json');
  const uiHtml = readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');
  const control = createControlServer({
    token,
    uiHtml,
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
          const all = index.listEntries();
          return {
            entries: all.filter((e) => !e.deleted).length,
            tombstones: all.filter((e) => e.deleted).length,
          };
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

  const folder = config.sharedFolders[0];
  if (!folder) {
    console.log('no shared folders configured yet; add one via the web UI, then restart the daemon');
    await new Promise<void>((resolve) => {
      const shutdown = (): void => {
        control.close();
        index.close();
        resolve();
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    });
    return;
  }

  const folderPath = folder.path;
  const executor = createLocalExecutor(folder.path, index);
  // 忽略规则每设备本地,从共享目录的 .syncxignore 读取(不存在则为空)
  let ignoreLines: string[] = [];
  try {
    ignoreLines = readFileSync(join(folderPath, '.syncxignore'), 'utf8').split('\n');
  } catch {
    // no ignore file
  }
  const localIndex = new Map(
    filterIndexedEntries(parseIgnoreRules(ignoreLines), index.listEntries()).map((e) => [e.path, e]),
  );

  /** 在一个 socket 上建立同步会话:peer 接线 + 主动发送本地索引。 */
  function startSyncSession(socket: WebSocket, remoteDeviceId: string): void {
    const transport = makePeerTransport(socket);
    const peer = createSyncPeer({
      transport,
      localIndex,
      executor,
      readLocalBlock: (path, blockIndex) => {
        const blocks = splitIntoBlocks(readFileSync(join(folderPath, path)));
        return blocks[blockIndex]!;
      },
      deviceId: identity.deviceId,
      remoteDeviceId,
    });
    attachPeerMessages(peer, socket);
    transport.sendEntries([...localIndex.values()]);
  }

  const server = startPeerServer(
    identity,
    {
      onPeerConnected(socket, remoteDeviceId) {
        startSyncSession(socket, remoteDeviceId);
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
      .then(({ socket, remoteDeviceId }) => startSyncSession(socket, remoteDeviceId))
      .catch((error) => console.error(`connect to ${peer.deviceId} failed: ${error.message}`));
  });

  // 手动配置的对端(mDNS 不可用时的回退):启动时主动连接,失败仅日志
  for (const peerUrl of config.peers) {
    void connectPeer(identity, peerUrl)
      .then(({ socket, remoteDeviceId }) => {
        console.log(`connected to configured peer ${remoteDeviceId} (${peerUrl})`);
        startSyncSession(socket, remoteDeviceId);
      })
      .catch((error) => console.error(`connect to configured peer ${peerUrl} failed: ${error.message}`));
  }

  console.log(`syncx daemon started (device ${identity.deviceId}, peer port ${server.port})`);
  console.log('peer sync (ws://ip:port):');
  console.log(`  ws://localhost:${server.port}`);
  for (const lan of lanAddresses) {
    console.log(`  ws://${formatHost(lan.address, lan.family)}:${server.port}`);
  }
  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      control.close();
      discovery.close();
      server.close();
      index.close();
      resolve();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}
