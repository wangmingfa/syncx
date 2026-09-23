import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { folderIndexPath } from '../src/config.js';
import type { IndexEntry } from '../src/index.js';
import { loadOrCreateIdentity } from '../src/identity.js';
import { openIndexStore } from '../src/indexstore.js';
import { createLogger } from '../src/logger.js';
import { startPeerServer, type PeerServer } from '../src/net/server.js';
import { SyncSessionManager } from '../src/session-manager.js';
import { rmDir } from './helpers.js';

/** 异步轮询等待条件成立(hello / 控制消息都是异步 WS 收发的)。 */
async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

type Identity = ReturnType<typeof loadOrCreateIdentity>;

interface Device {
  dir: string;
  share: string;
  manager: SyncSessionManager;
  server: PeerServer;
}

/**
 * 起一台「设备」:真 manager + 真 peer 监听 + 真配置。
 *
 * 与 two-devices.test.ts(裸 socket + 手写 transport)的分工:那组用例验证**同步协议本身**,
 * 这组要验证的是**控制面的对比通道**(folder-index-request/snapshot 经真实 manager 往返),
 * 所以必须用真 manager —— 挂起表、分片重组、授权闸门都在它内部。
 */
function bootDevice(opts: {
  identity: Identity;
  dir: string;
  share: string;
  /** 该目录指派给哪些设备(写入配置与内存两边,isPeerAllowed 读配置文件)。 */
  shareWith: string[];
}): Device {
  const configPath = join(opts.dir, 'config.json');
  const sharedFolders = [{ id: 'main', path: opts.share, devices: opts.shareWith }];
  writeFileSync(configPath, JSON.stringify({ sharedFolders, knownDevices: [], peers: [] }));

  const manager = new SyncSessionManager(
    {
      identity: opts.identity,
      configPath,
      configDir: opts.dir,
      peerPort: 0,
      logger: createLogger(undefined),
    },
    sharedFolders,
  );
  const server = startPeerServer(
    opts.identity,
    {
      onPeerConnected(socket, remoteDeviceId, key, listenPort) {
        manager.onInboundPeer(socket, remoteDeviceId, key, listenPort);
      },
      onError() {},
    },
    0,
  );
  return { dir: opts.dir, share: opts.share, manager, server };
}

/** 直接往索引库里塞条目(必须在 manager 构造**之前**——它启动时就把库读成内存索引)。 */
function seedIndex(dir: string, entries: IndexEntry[]): void {
  const store = openIndexStore(folderIndexPath(dir, 'main'));
  // 单事务批量写:逐条 saveEntry 是逐条 autocommit(每条一次 fsync),2050 条
  // 在 CI 上能把用例拖过 vitest 的超时线
  store.saveEntries(entries);
  store.close();
}

function entry(
  path: string,
  version: Array<[string, number]>,
  opts: { size?: number } = {},
): IndexEntry {
  return {
    path,
    version: new Map(version),
    size: opts.size ?? 100,
    deleted: false,
    blocks: [`h:${path}`],
  };
}

describe('folder diff over real sockets', () => {
  it('reassembles a chunked peer snapshot and explains peer-only paths by our own rules', async () => {
    const aDir = mkdtempSync(join(tmpdir(), 'syncx-diff-a-'));
    const bDir = mkdtempSync(join(tmpdir(), 'syncx-diff-b-'));
    const shareA = mkdtempSync(join(tmpdir(), 'syncx-diff-sa-'));
    const shareB = mkdtempSync(join(tmpdir(), 'syncx-diff-sb-'));
    const devices: Device[] = [];
    try {
      const aId = loadOrCreateIdentity(aDir);
      const bId = loadOrCreateIdentity(bDir);

      // A 忽略 bulk/:对端声明的这 2050 条一条都不收(见 ADR-0012)。两个作用 ——
      // 一是测试里不会真去拉 2050 个不存在的文件(否则块请求失败会刷满目录错误),
      // 二是正好覆盖「差异是规则使然」这条消歧路径。
      writeFileSync(join(shareA, '.syncxignore'), 'bulk/\n');
      seedIndex(aDir, []);
      // 2050 条 > 单片上限 2000 → 对端必须分 2 片回,验证分片重组
      seedIndex(
        bDir,
        Array.from({ length: 2050 }, (_, i) =>
          entry(`bulk/f${String(i).padStart(4, '0')}.txt`, [[bId.deviceId, 1]], { size: 10 }),
        ),
      );

      const a = bootDevice({ identity: aId, dir: aDir, share: shareA, shareWith: [bId.deviceId] });
      const b = bootDevice({ identity: bId, dir: bDir, share: shareB, shareWith: [aId.deviceId] });
      devices.push(a, b);

      a.manager.connectTo(`ws://127.0.0.1:${b.server.port}`);
      await waitFor(
        () => a.manager.isPeerConnected(bId.deviceId) && b.manager.isPeerConnected(aId.deviceId),
      );

      const result = await a.manager.diffFolder('main', bId.deviceId);

      expect(result.folderId).toBe('main');
      expect(result.folderPath).toBe(shareA);
      expect(result.deviceId).toBe(bId.deviceId);
      // 分片重组:2050 条跨 2 片,少一片这个数字就不到 2050
      expect(result.diff.remoteTotal).toBe(2050);
      expect(result.diff.localTotal).toBe(0);
      // 对端把它该目录生效的规则行带回来了(不带就只能报「对端没有」)
      expect(result.diff.remoteRulesKnown).toBe(true);
      // 2050 条全是「本机按自己的规则不收」,不是同步故障
      expect(result.diff.counts['ignored-locally']).toBe(2050);
      expect(result.diff.counts['remote-newer']).toBe(0);
      expect(new Set(result.diff.items.map((i) => i.rule))).toEqual(new Set(['bulk/']));
      // 对端版本来自 hello / 控制消息(报告上要显示「与哪一版对端比的」)
      expect(result.deviceVersion).toBeTypeOf('string');
      // 设备身份:报告要能说清「哪台机器 ↔ 哪台机器」,只给设备 id 不够用
      expect(result.localHostname).toBeTypeOf('string');
      expect(result.localHostname.length).toBeGreaterThan(0);
      expect(Array.isArray(result.localAddresses)).toBe(true);
      for (const addr of result.localAddresses) {
        // 只收非环回 IPv4(与 getLanAddresses 的口径一致)
        expect(addr).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      }
      // 两端在同一个进程里跑,对端宣告的主机名就是本机主机名
      expect(result.deviceHostname).toBe(result.localHostname);
      // 地址来自本机记录的出站 URL(这里是我们自己 connectTo 填的那个)
      expect(result.deviceUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
      expect(result.remoteAt).toBeGreaterThan(0);
      // 空闲(进度全为 0)时不该给进度:否则报告会凭空多一句「本机此刻在传输
      // (发送 0 · 接收 0 · 待处理 0)」,把真正的提示淹掉
      expect(result.localProgress).toBeUndefined();
      expect(result.remoteProgress).toBeUndefined();
    } finally {
      for (const d of devices) {
        d.manager.close();
        d.server.close();
      }
      rmDir(aDir);
      rmDir(bDir);
      rmDir(shareA);
      rmDir(shareB);
    }
  });

  it('refuses when the peer does not share that folder with us', async () => {
    const aDir = mkdtempSync(join(tmpdir(), 'syncx-diff-deny-a-'));
    const bDir = mkdtempSync(join(tmpdir(), 'syncx-diff-deny-b-'));
    const shareA = mkdtempSync(join(tmpdir(), 'syncx-diff-deny-sa-'));
    const shareB = mkdtempSync(join(tmpdir(), 'syncx-diff-deny-sb-'));
    const devices: Device[] = [];
    try {
      const aId = loadOrCreateIdentity(aDir);
      const bId = loadOrCreateIdentity(bDir);

      // A 把目录共享给 B,B **没有**共享给 A:本机侧的检查全过,但服务端必须拒绝 ——
      // 否则这条诊断通道就成了绕过共享关系的索引读取入口。
      const a = bootDevice({ identity: aId, dir: aDir, share: shareA, shareWith: [bId.deviceId] });
      const b = bootDevice({ identity: bId, dir: bDir, share: shareB, shareWith: [] });
      devices.push(a, b);

      a.manager.connectTo(`ws://127.0.0.1:${b.server.port}`);
      await waitFor(() => a.manager.isPeerConnected(bId.deviceId));

      await expect(a.manager.diffFolder('main', bId.deviceId)).rejects.toThrow('未共享给请求方');
    } finally {
      for (const d of devices) {
        d.manager.close();
        d.server.close();
      }
      rmDir(aDir);
      rmDir(bDir);
      rmDir(shareA);
      rmDir(shareB);
    }
  });

  it('fails instead of answering from a stale cache when the peer is offline', async () => {
    const aDir = mkdtempSync(join(tmpdir(), 'syncx-diff-off-a-'));
    const shareA = mkdtempSync(join(tmpdir(), 'syncx-diff-off-sa-'));
    const devices: Device[] = [];
    try {
      const aId = loadOrCreateIdentity(aDir);
      const a = bootDevice({
        identity: aId,
        dir: aDir,
        share: shareA,
        shareWith: ['DEV-GHOST'],
      });
      devices.push(a);

      // 会话建立时那份「内存镜像」只在 attach 那一刻准确,拿它出结论比不出更糟
      await expect(a.manager.diffFolder('main', 'DEV-GHOST')).rejects.toThrow('设备离线');
    } finally {
      for (const d of devices) {
        d.manager.close();
        d.server.close();
      }
      rmDir(aDir);
      rmDir(shareA);
    }
  });

  it('rejects an unknown folder id and a folder not shared with that device', async () => {
    const aDir = mkdtempSync(join(tmpdir(), 'syncx-diff-bad-a-'));
    const shareA = mkdtempSync(join(tmpdir(), 'syncx-diff-bad-sa-'));
    const devices: Device[] = [];
    try {
      const aId = loadOrCreateIdentity(aDir);
      const a = bootDevice({ identity: aId, dir: aDir, share: shareA, shareWith: [] });
      devices.push(a);

      await expect(a.manager.diffFolder('nope', 'DEV-X')).rejects.toThrow('共享目录不存在');
      await expect(a.manager.diffFolder('main', 'DEV-X')).rejects.toThrow('未与这台设备共享');
    } finally {
      for (const d of devices) {
        d.manager.close();
        d.server.close();
      }
      rmDir(aDir);
      rmDir(shareA);
    }
  });
});
