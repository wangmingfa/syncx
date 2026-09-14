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
 * 锁死「对端版本未知」回归。
 *
 * 根因历史:老版本把对端经 hello 宣告的 version / hostname 存进「会话对象」
 * (session.remoteVersion),而 describeDevice 只读「书签会话」(peerSessions.get(id))。
 * 双连接 / 重连 / 书签迁移等拓扑抖动下,书签会话可能不是实际收到 hello 的那条,
 * 于是设备卡偶发「版本未知」。修复:version / hostname 改为按 deviceId 存入
 * 独立的 peerInfo map,任意存活会话收到 hello 都更新它,与书签会话彻底解耦。
 *
 * 本测试用真实 SyncSessionManager + 真实 WebSocket + 真实 AES-GCM 握手,构造出
 * 老版本必然失败、新版本必然通过的精确状态:某对端(设备 C)与本地(A)建立了两条
 * 会话(双连接),但 C 的 hello 只送达了「备份会话」,「书签会话」从未收到 hello。
 * 此时老版本 describeDevice(C).version 为 undefined(读的是没收到 hello 的书签会话),
 * 新版本因 peerInfo 按 deviceId 缓存而仍返回 '9.9.9'。
 */
describe('peerInfo keyed by deviceId (regression: version survives non-bookmark hello)', () => {
  it('returns the peer version even when only a backup session received hello', async () => {
    const aDir = mkdtempSync(join(tmpdir(), 'syncx-peerinfo-a-'));
    const cDir = mkdtempSync(join(tmpdir(), 'syncx-peerinfo-c-'));
    try {
      const aId = loadOrCreateIdentity(aDir);
      const cId = loadOrCreateIdentity(cDir);
      const configPathA = join(aDir, 'config.json');
      writeFileSync(configPathA, JSON.stringify({ sharedFolders: [], peers: [] }));

      const managerA = new SyncSessionManager(
        { identity: aId, configPath: configPathA, configDir: aDir, peerPort: 0, logger: createLogger(undefined) },
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

      // C 拨 A 两次 → A 端得到两条入站会话:第一条成为「书签会话」,第二条为备份。
      // (与真实双连接拓扑一致:双向同时拨号会在同一对端上产生重复连接,
      //  书签策略只让第一条存活连接当书签,其余作备份。)
      const conn1 = await connectPeer(cId, `ws://127.0.0.1:${serverA.port}`);
      const conn2 = await connectPeer(cId, `ws://127.0.0.1:${serverA.port}`);

      // 仅向「备份会话」(第二条连接)回送 C 的 hello;书签会话(第一条)收不到。
      // connectPeer 只完成密钥交换、不会自动发 hello,因此这里手动、且只发一条。
      sendControlMessage(conn2.socket, conn2.key, {
        kind: 'hello',
        fromDeviceId: cId.deviceId,
        version: '9.9.9',
        hostname: 'hostC',
      });

      // 等待 hello 被处理(异步 WS 收发 + 解密)
      await waitFor(() => managerA.describeDevice(cId.deviceId).version === '9.9.9', 5000);

      const link = managerA.describeDevice(cId.deviceId);
      // 核心不变量:version 按 deviceId 缓存,不受「书签会话 ≠ 收到 hello 的会话」影响
      expect(link.version).toBe('9.9.9');
      expect(link.hostname).toBe('hostC');
      // 双连接:两条会话都应在线
      expect(link.online).toBe(true);

      managerA.close();
      serverA.close();
    } finally {
      rmDir(aDir);
      rmDir(cDir);
    }
  });
});

/**
 * 锁死「hello 丢失但版本仍应可见」回归(本次修复的核心场景)。
 *
 * 用户日志实证:某对端(folder invitation / pairing / folder-sync-list 等控制消息都到达了),
 * 唯独 hello 没到 → 设备卡永久「版本未知」。根因:版本只挂在 hello 这一条「建连时一次性
 * 发送」的消息上,一旦它在双连接 / 重连抖动中丢失即不可恢复。
 *
 * 修复:version / hostname 随每条控制消息发送(发送侧注入),接收侧对「任意带版本的控制
 * 消息」更新 peerInfo。于是只要任意一条控制消息到达,版本即可被学到,不再依赖那条
 * 可能被丢的 hello。
 *
 * 本测试精确复刻该状态:对端只发一条带版本的 folder-sync-list、绝不发 hello。
 * 老版本(版本仅从 hello 学)describeDevice(C).version 为 undefined → 失败;
 * 新版本(从任意控制消息学)返回 '9.9.9' → 通过。
 */
describe('peer version learned from non-hello control messages (regression: lost hello)', () => {
  it('learns the version from a folder-sync-list even when hello was never received', async () => {
    const aDir = mkdtempSync(join(tmpdir(), 'syncx-peerinfo-b-'));
    const cDir = mkdtempSync(join(tmpdir(), 'syncx-peerinfo-c2-'));
    try {
      const aId = loadOrCreateIdentity(aDir);
      const cId = loadOrCreateIdentity(cDir);
      const configPathA = join(aDir, 'config.json');
      writeFileSync(configPathA, JSON.stringify({ sharedFolders: [], peers: [] }));

      const managerA = new SyncSessionManager(
        { identity: aId, configPath: configPathA, configDir: aDir, peerPort: 0, logger: createLogger(undefined) },
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

      const conn = await connectPeer(cId, `ws://127.0.0.1:${serverA.port}`);

      // 刻意不发 hello(精确复刻用户日志:控制消息到了、hello 没到),只发一条带版本的控制消息。
      // 旧版本里这里版本永远学不到;新版本里这条 folder-sync-list 就足以让设备卡显示版本。
      sendControlMessage(conn.socket, conn.key, {
        kind: 'folder-sync-list',
        fromDeviceId: cId.deviceId,
        folderIds: ['f1'],
        version: '9.9.9',
        hostname: 'hostC',
      });

      await waitFor(() => managerA.describeDevice(cId.deviceId).version === '9.9.9', 5000);

      const link = managerA.describeDevice(cId.deviceId);
      expect(link.version).toBe('9.9.9');
      expect(link.hostname).toBe('hostC');
      expect(link.online).toBe(true);

      managerA.close();
      serverA.close();
    } finally {
      rmDir(aDir);
      rmDir(cDir);
    }
  });
});
