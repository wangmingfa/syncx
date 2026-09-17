import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadOrCreateIdentity } from '../src/identity.js';
import { createLogger } from '../src/logger.js';
import { startPeerServer } from '../src/net/server.js';
import { encryptMessage, type ControlMessage } from '../src/net/wire.js';
import { SyncSessionManager } from '../src/session-manager.js';
import { rmDir } from './helpers.js';

/** 最小 WebSocket mock:记录 send,允许手动 emit 'message'。 */
class MockSocket {
  public sent: string[] = [];
  public readyState = 1; // WebSocket.OPEN
  public terminated = false;
  private handlers: Record<string, (data?: unknown) => void> = {};
  send(data: string): void {
    this.sent.push(data);
  }
  ping(): void {}
  terminate(): void {
    this.terminated = true;
  }
  close(): void {
    this.terminated = true;
  }
  on(event: string, cb: (data?: unknown) => void): void {
    this.handlers[event] = cb;
  }
  emit(data: unknown): void {
    this.handlers['message']?.(data);
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * 优雅关闭的卫生问题。
 *
 * close() 用 terminate() 强制断开所有 peer socket(否则客户端 socket 会保持事件
 * 循环活跃,进程收不到 SIGTERM 就退不出去)——而 terminate 触发的 socket 'close'
 * 事件是**异步**到达的:那时 close() 早已清空 reconnectTimers 并返回。若不加标记,
 * 关闭路径上反而会新排一个重连定时器(首次延时为 0ms),既把正在退出的 daemon 又
 * 钉在事件循环里,还会真的向外拨号。
 *
 * 判据用「对端服务器收到几条入站连接」而不是读内部状态:重连一旦真的发生,必然
 * 在对端留下第二条连接,这是外部可观测的事实。
 */
describe('session manager shutdown', () => {
  it('does not reconnect from the close event of a socket it just terminated', async () => {
    const aDir = mkdtempSync(join(tmpdir(), 'syncx-shutdown-a-'));
    const bDir = mkdtempSync(join(tmpdir(), 'syncx-shutdown-b-'));
    let inbound = 0;
    try {
      const aId = loadOrCreateIdentity(aDir);
      const bId = loadOrCreateIdentity(bDir);
      writeFileSync(join(aDir, 'config.json'), JSON.stringify({ sharedFolders: [], peers: [] }));
      writeFileSync(join(bDir, 'config.json'), JSON.stringify({ sharedFolders: [], peers: [] }));

      const managerA = new SyncSessionManager(
        {
          identity: aId,
          configPath: join(aDir, 'config.json'),
          configDir: aDir,
          peerPort: 0,
          logger: createLogger(undefined),
        },
        [],
      );
      const managerB = new SyncSessionManager(
        {
          identity: bId,
          configPath: join(bDir, 'config.json'),
          configDir: bDir,
          peerPort: 0,
          logger: createLogger(undefined),
        },
        [],
      );
      const serverB = startPeerServer(
        bId,
        {
          onPeerConnected(socket, remoteDeviceId, key, listenPort) {
            inbound += 1;
            managerB.onInboundPeer(socket, remoteDeviceId, key, listenPort);
          },
          onError() {},
        },
        0,
      );

      const url = `ws://127.0.0.1:${serverB.port}`;
      managerA.connectTo(url);
      await waitFor(() => inbound === 1);
      // 前提:A 确实学到了对端地址(否则重连本就会被「没有地址」挡掉,用例会空过)
      expect(managerA.getLearnedUrl(bId.deviceId)).toBe(url);

      managerA.close();
      await new Promise((r) => setTimeout(r, 1000));

      expect(inbound).toBe(1);

      managerB.close();
      serverB.close();
    } finally {
      rmDir(aDir);
      rmDir(bDir);
    }
  });

  /**
   * close() 之后到达的入站控制消息必须被丢弃。
   *
   * terminate() 只断开 TCP,已排进事件循环的消息仍会走到分发回调 —— 那时索引库已关、
   * 配置锁已释放,继续处理会去碰已关闭的资源。folder-sync-list 这条尤其典型:它会触发
   * pruneRevokedOffers → mutateConfig 重写配置(生产里是多余的落盘,测试里如果目录已被
   * 清理,还会在 5s 锁重试后抛 config lock timeout,表现为随机失败的用例)。
   *
   * 判据用「配置里的待确认邀请有没有被清掉」:这是消息被处理过的外部可观测后果,
   * 不依赖任何内部状态。
   */
  it('drops inbound control messages that arrive after close', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-shutdown-msg-'));
    try {
      const id = loadOrCreateIdentity(dir);
      const configPath = join(dir, 'config.json');
      writeFileSync(
        configPath,
        JSON.stringify({
          sharedFolders: [],
          knownDevices: [],
          peers: [],
          // 来源为 DEV-X 的待确认目录邀请:对端一宣告「不再共享任何目录」就会被清掉
          pendingOffers: [
            {
              id: 'o1',
              kind: 'folder',
              fromDeviceId: 'DEV-X',
              folderId: 'gone',
              folderName: 'gone',
              status: 'pending',
              createdAt: Date.now(),
            },
          ],
        }),
      );

      const manager = new SyncSessionManager(
        {
          identity: id,
          configPath,
          configDir: dir,
          peerPort: 0,
          logger: createLogger(undefined),
        },
        [],
      );
      const socket = new MockSocket();
      const key = randomBytes(32);
      // 先建立会话(消息回调在 startSyncSession 里挂上),再关闭
      manager.onInboundPeer(socket as never, 'DEV-X', key);
      manager.close();

      const revoke = encryptMessage(key, {
        type: 'control',
        payload: {
          kind: 'folder-sync-list',
          fromDeviceId: 'DEV-X',
          folderIds: [],
        } as ControlMessage,
      });
      expect(() => socket.emit(revoke)).not.toThrow();

      const after = JSON.parse(readFileSync(configPath, 'utf8')) as { pendingOffers: unknown[] };
      expect(after.pendingOffers).toHaveLength(1);
    } finally {
      rmDir(dir);
    }
  });
});
