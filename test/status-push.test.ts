import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SyncSessionManager } from '../src/session-manager.js';
import { startPeerServer } from '../src/net/server.js';
import { connectPeer } from '../src/net/client.js';
import { sendControlMessage } from '../src/net/wire.js';
import { loadOrCreateIdentity } from '../src/identity.js';
import { createLogger } from '../src/logger.js';
import { rmDir } from './helpers.js';

/** 异步轮询等待条件成立(白盒测试里 hello 是异步 WS 收发的)。 */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * 状态推送的触发点。
 *
 * 通道本身(status-hub)只是「收到通知后合并推送」,真正决定实时性的是
 * **哪一步会通知**。这些用例锁死那几个「用户一眼就会看到」的变更 ——
 * 设备上下线、对端版本学到、扫描结果 —— 必须主动通知,而不是等兜底重算。
 *
 * 注意这里只断言「通知了」,不断言「推了几帧」:合帧与去重由 status-hub 负责,
 * 已在其自身用例里覆盖。
 */
describe('status change notifications', () => {
  it('notifies on peer connect, version learning and disconnect', async () => {
    const aDir = mkdtempSync(join(tmpdir(), 'syncx-push-a-'));
    const cDir = mkdtempSync(join(tmpdir(), 'syncx-push-c-'));
    let notifications = 0;
    try {
      const aId = loadOrCreateIdentity(aDir);
      const cId = loadOrCreateIdentity(cDir);
      const configPathA = join(aDir, 'config.json');
      writeFileSync(configPathA, JSON.stringify({ sharedFolders: [], peers: [] }));

      const managerA = new SyncSessionManager(
        {
          identity: aId,
          configPath: configPathA,
          configDir: aDir,
          peerPort: 0,
          logger: createLogger(undefined),
          onStatusChanged: () => {
            notifications += 1;
          },
        },
        [],
      );

      const serverA = startPeerServer(
        aId,
        {
          onPeerConnected(socket, remoteDeviceId, key, listenPort) {
            managerA.onInboundPeer(socket, remoteDeviceId, key, listenPort);
          },
          onError() {},
        },
        0,
      );

      // 1) 对端上线 → 设备卡从离线变在线,必须立即通知
      const conn = await connectPeer(cId, `ws://127.0.0.1:${serverA.port}`);
      await waitFor(() => managerA.describeDevice(cId.deviceId).online);
      const afterConnect = notifications;
      expect(afterConnect).toBeGreaterThan(0);

      // 2) 学到对端版本 → 设备卡上的版本号与「可否从对方升级」都依赖它
      sendControlMessage(conn.socket, conn.key, {
        kind: 'hello',
        fromDeviceId: cId.deviceId,
        version: '9.9.9',
        hostname: 'hostC',
      });
      await waitFor(() => managerA.describeDevice(cId.deviceId).version === '9.9.9');
      expect(notifications).toBeGreaterThan(afterConnect);
      const afterHello = notifications;

      // 3) 掉线 → 在线标记与各目录进度都要跟着变
      conn.socket.close();
      await waitFor(() => !managerA.describeDevice(cId.deviceId).online);
      expect(notifications).toBeGreaterThan(afterHello);

      managerA.close();
      serverA.close();
    } finally {
      rmDir(aDir);
      rmDir(cDir);
    }
  });

  it('notifies after a scan round so index stats and progress follow', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-push-scan-'));
    const share = mkdtempSync(join(tmpdir(), 'syncx-push-share-'));
    let notifications = 0;
    try {
      writeFileSync(join(share, 'a.txt'), 'hello');
      const identity = loadOrCreateIdentity(dir);
      const configPath = join(dir, 'config.json');
      writeFileSync(configPath, JSON.stringify({ sharedFolders: [{ path: share, devices: [] }], peers: [] }));

      const manager = new SyncSessionManager(
        {
          identity,
          configPath,
          configDir: dir,
          peerPort: 0,
          logger: createLogger(undefined),
          onStatusChanged: () => {
            notifications += 1;
          },
        },
        [{ path: share, devices: [] }],
      );

      await manager.runScan();

      expect(notifications).toBeGreaterThan(0);
      // 扫描确实把文件收进了索引(通知的是真变化,不是空转)
      expect(manager.getIndexStats().entries).toBe(1);

      manager.close();
    } finally {
      rmDir(dir);
      rmDir(share);
    }
  });

  it('notifies when the shared folder set changes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-push-reload-'));
    const share = mkdtempSync(join(tmpdir(), 'syncx-push-share2-'));
    let notifications = 0;
    try {
      const identity = loadOrCreateIdentity(dir);
      const configPath = join(dir, 'config.json');
      writeFileSync(configPath, JSON.stringify({ sharedFolders: [], peers: [] }));

      const manager = new SyncSessionManager(
        {
          identity,
          configPath,
          configDir: dir,
          peerPort: 0,
          logger: createLogger(undefined),
          onStatusChanged: () => {
            notifications += 1;
          },
        },
        [],
      );

      writeFileSync(configPath, JSON.stringify({ sharedFolders: [{ path: share, devices: [] }], peers: [] }));
      manager.reloadConfig();

      expect(notifications).toBeGreaterThan(0);
      expect(manager.folderStates).toHaveLength(1);

      manager.close();
    } finally {
      rmDir(dir);
      rmDir(share);
    }
  });
});
