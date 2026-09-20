import { describe, expect, it, afterEach } from 'vitest';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  createWriteStream,
  renameSync,
} from 'node:fs';
import { rmDir } from '../helpers.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { loadOrCreateIdentity } from '../../src/identity.js';
import { openIndexStore } from '../../src/indexstore.js';
import { hashBlock, splitIntoBlocks } from '../../src/blockstore.js';
import { folderIdFor, folderIndexPath } from '../../src/config.js';
import { allocatePort, cleanDaemonEnv } from './ports.js';

const children: ChildProcess[] = [];

/** 停掉所有子进程并等待退出;避免进程仍持有文件导致清理竞态(ENOTEMPTY)。 */
async function stopChildren(): Promise<void> {
  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          child.once('exit', () => resolve());
          child.kill('SIGTERM');
        }),
    ),
  );
  children.length = 0;
}

afterEach(async () => {
  // 等待子进程真正退出,避免旧 daemon 的优雅关闭与下一个测试的启动窗口
  // 重叠,导致扫描/同步被挤占而超时(间歇性 flaky 的根因)
  await stopChildren();
});

function waitFor(condition: () => boolean, timeoutMs = 30000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = (): void => {
      if (condition()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('timed out waiting for condition'));
        return;
      }
      setTimeout(check, 100);
    };
    check();
  });
}

interface DaemonSetup {
  dir: string;
  share: string;
  configPath: string;
  peerPort: number;
  controlPort: number;
  deviceId: string;
}

/** 创建 daemon 配置目录 + 预置索引条目,返回设置(不启动进程)。 */
async function setupDaemon(
  name: string,
  seedFiles: Array<{ path: string; content: Buffer }>,
): Promise<DaemonSetup> {
  const dir = mkdtempSync(join(tmpdir(), `syncx-daemon-${name}-`));
  const share = join(dir, 'share');
  mkdirSync(share, { recursive: true });

  const identity = loadOrCreateIdentity(dir);
  const index = openIndexStore(folderIndexPath(dir, 'main'));
  for (const file of seedFiles) {
    writeFileSync(join(share, file.path), file.content);
    index.saveEntry({
      path: file.path,
      version: new Map([[identity.deviceId, 1]]),
      size: file.content.length,
      deleted: false,
      // 必须按 BLOCK_SIZE 切块再算哈希:直接 hashBlock(整个文件)只在单块文件上凑巧相等,
      // 多块文件的索引会指向一个对端永远给不出的块哈希 → 传输静默卡死。
      blocks: splitIntoBlocks(file.content).map(hashBlock),
    });
  }
  index.close();

  // 并行测试文件的随机端口区间会互相碰撞,改用系统分配的临时端口
  const [peerPort, controlPort] = await Promise.all([allocatePort(), allocatePort()]);

  return {
    dir,
    share,
    configPath: join(dir, 'config.json'),
    peerPort,
    controlPort,
    deviceId: identity.deviceId,
  };
}

function startDaemon(setup: DaemonSetup, peers: string[], peerDeviceIds: string[]): ChildProcess {
  writeFileSync(
    setup.configPath,
    JSON.stringify({
      sharedFolders: [{ id: 'main', path: setup.share, devices: peerDeviceIds }],
      peers,
    }),
  );

  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      'src/main.ts',
      'start',
      '--config',
      setup.configPath,
      '--port',
      String(setup.peerPort),
      '--control-port',
      String(setup.controlPort),
    ],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: cleanDaemonEnv() },
  );
  // 捕获 daemon 输出,失败时可读日志定位
  child.stdout?.pipe(createWriteStream(join(setup.dir, 'daemon.out.log')));
  child.stderr?.pipe(createWriteStream(join(setup.dir, 'daemon.err.log')));
  children.push(child);
  return child;
}

/**
 * 编辑器式的原子保存:先写临时文件再 rename 替换目标。许多编辑器(
 * vi/vim/nvim)都这样做,会替换 config.json 的 inode。配置热重载必须
 * 在 rename 后仍能触发,否则 daemon 的热重载会静默失效。
 */
function saveConfigAtomically(
  setup: DaemonSetup,
  newSharedFolders: Array<{ id: string; path: string; devices: string[] }>,
): void {
  const tmpPath = `${setup.configPath}.tmp`;
  writeFileSync(
    tmpPath,
    JSON.stringify({
      sharedFolders: newSharedFolders,
      peers: [],
    }),
  );
  renameSync(tmpPath, setup.configPath);
}

/** 失败时打印 daemon 日志与目录内容,辅助定位。 */
function dumpLogs(...setups: DaemonSetup[]): void {
  for (const s of setups) {
    console.log(`--- ${s.dir} share:`, readdirSync(s.share));
    for (const f of ['daemon.out.log', 'daemon.err.log']) {
      try {
        console.log(`--- ${s.dir}/${f} ---`);
        console.log(readFileSync(join(s.dir, f), 'utf8'));
      } catch {
        // no log yet
      }
    }
  }
}

/** 等待 daemon 就绪:日志出现 "syncx daemon started" 时 peer 服务已监听。 */
async function waitForDaemonReady(setup: DaemonSetup): Promise<void> {
  await waitFor(() => {
    try {
      return readFileSync(join(setup.dir, 'daemon.out.log'), 'utf8').includes(
        'syncx daemon started',
      );
    } catch {
      return false;
    }
  });
}

describe('two real daemons sync over peers config', () => {
  it(
    'propagates files in both directions between two processes',
    async () => {
      const a = await setupDaemon('a', [
        { path: 'a.txt', content: Buffer.from('content from A') },
      ]);
      const b = await setupDaemon('b', [
        { path: 'b.txt', content: Buffer.from('content from B') },
      ]);

      // 两个 daemon 互相把对方配为手动对端,并互相加入 devices 白名单
      startDaemon(a, [`ws://127.0.0.1:${b.peerPort}`], [b.deviceId]);
      // 错开启动:先等 A 就绪再起 B,避免双方同时启动互相 ECONNREFUSED
      // 后走指数退避把连接建立推到 30s 边缘(daemon 侧另有首连立即重试兜底)
      await waitForDaemonReady(a);
      startDaemon(b, [`ws://127.0.0.1:${a.peerPort}`], [a.deviceId]);

      // 双向同步:B 应收到 a.txt,A 应收到 b.txt。
      // 两个 daemon 同时启动时互相 ECONNREFUSED 后走指数退避(1s→2s→4s→8s→16s),
      // 负载高时连接建立可能被推到 30s 边缘,预算放宽到 45s
      await waitFor(() => existsSync(join(b.share, 'a.txt')), 45000);
      await waitFor(() => existsSync(join(a.share, 'b.txt')), 45000);

      expect(readFileSync(join(b.share, 'a.txt'))).toEqual(Buffer.from('content from A'));
      expect(readFileSync(join(a.share, 'b.txt'))).toEqual(Buffer.from('content from B'));

      // 先停掉 daemon 再清理临时目录,避免进程写文件导致 ENOTEMPTY
      await stopChildren();
      rmDir(a.dir);
      rmDir(b.dir);
    },
    90000,
  );

  it(
    'propagates files created while the daemons are running',
    async () => {
      const a = await setupDaemon('a', []);
      const b = await setupDaemon('b', []);

      startDaemon(a, [`ws://127.0.0.1:${b.peerPort}`], [b.deviceId]);
      // 错开启动:先等 A 就绪再起 B,避免双方同时启动互相 ECONNREFUSED
      // 后走指数退避把连接建立推到 30s 边缘(daemon 侧另有首连立即重试兜底)
      await waitForDaemonReady(a);
      startDaemon(b, [`ws://127.0.0.1:${a.peerPort}`], [a.deviceId]);

      // 等连接建立(握手 + 加密会话 + 初始索引交换)
      await new Promise((r) => setTimeout(r, 2000));
      console.log('[test] after initial wait, writing live.txt');

      // daemon 运行中在 A 侧新建文件:周期扫描应发现并传播到 B
      writeFileSync(join(a.share, 'live.txt'), 'created while running');
      console.log('[test] live.txt written, entering waitFor');

      try {
        await waitFor(() => existsSync(join(b.share, 'live.txt')), 20000);
        console.log('[test] live.txt synced');
      } catch (error) {
        console.log('[test] waitFor failed, dumping logs');
        dumpLogs(a, b);
        throw error;
      }
      expect(readFileSync(join(b.share, 'live.txt'))).toEqual(
        Buffer.from('created while running'),
      );

      await stopChildren();
      rmDir(a.dir);
      rmDir(b.dir);
    },
    45000,
  );

  it(
    'returns to「已同步」after a local change instead of echoing indexes forever',
    async () => {
      // 2026-09-16 事故的真进程回归。双方各有对方没有的存量文件 —— 这正是回声环的
      // 燃料:任何一条增量广播里的「本机独有」都会被对端按并集语义判成「它没有」而回推。
      const a = await setupDaemon('a', [{ path: 'a-only.txt', content: Buffer.from('A v1') }]);
      const b = await setupDaemon('b', [{ path: 'b-only.txt', content: Buffer.from('B v1') }]);

      startDaemon(a, [`ws://127.0.0.1:${b.peerPort}`], [b.deviceId]);
      await waitForDaemonReady(a);
      startDaemon(b, [`ws://127.0.0.1:${a.peerPort}`], [a.deviceId]);

      // 首次全量交换:双方都拿到对方的存量文件(全量走并集语义,这一步本就该收敛)
      await waitFor(() => existsSync(join(b.share, 'a-only.txt')), 45000);
      await waitFor(() => existsSync(join(a.share, 'b-only.txt')), 45000);

      // A 侧产生一次真实改动 → 扫描器广播**增量**(生产路径:scanner → broadcastFolderUpdates)
      const changed = Buffer.from('A v2 changed');
      writeFileSync(join(a.share, 'a-only.txt'), changed);
      await waitFor(
        () =>
          existsSync(join(b.share, 'a-only.txt')) &&
          readFileSync(join(b.share, 'a-only.txt')).equals(changed),
        45000,
      );

      // 修复前:两端永久互推「对方没提到的条目」,status 里始终挂着「传输中 · 发送 N」。
      // 修复后:对端停止拉块 → 15s 租约到期 → 该目录的进度行消失,卡片回到「已同步」。
      const deadline = Date.now() + 40000;
      let aStatus: StatusResponse = { devices: [] };
      let bStatus: StatusResponse = { devices: [] };
      for (;;) {
        aStatus = await getStatus(a);
        bStatus = await getStatus(b);
        const idle =
          (aStatus.syncProgress ?? []).length === 0 && (bStatus.syncProgress ?? []).length === 0;
        if (idle || Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(aStatus.syncProgress ?? []).toEqual([]);
      expect(bStatus.syncProgress ?? []).toEqual([]);

      await stopChildren();
      rmDir(a.dir);
      rmDir(b.dir);
    },
    90000,
  );

  it(
    'pushes status over /api/events without any polling',
    async () => {
      const a = await setupDaemon('a', [{ path: 'a.txt', content: Buffer.from('hello') }]);
      startDaemon(a, [], []);
      await waitForDaemonReady(a);

      // 浏览器无法给 WebSocket 设请求头,真实 Web UI 走同源 cookie;非浏览器客户端
      // 走 Bearer —— 这里用后者(前者已由 test/api-events.test.ts 覆盖)。
      const token = readFileSync(join(a.dir, 'control.token'), 'utf8').trim();
      const socket = new WebSocket(`ws://127.0.0.1:${a.controlPort}/api/events`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      type Frame = { type: string; status?: { deviceId: string; entries: number } };
      const frames: Frame[] = [];
      socket.on('message', (raw) => frames.push(JSON.parse(raw.toString('utf8')) as Frame));
      const statuses = (): Array<{ deviceId: string; entries: number }> =>
        frames.filter((f) => f.type === 'status' && f.status !== undefined).map((f) => f.status as { deviceId: string; entries: number });

      await once(socket, 'open');
      // 握手后立即收到一帧全量:界面不必等任何一次轮询就能画出来
      await waitFor(() => statuses().length > 0, 10000);
      expect(statuses()[0]?.deviceId).toBe(a.deviceId);
      expect(statuses()[0]?.entries).toBe(1);

      // 运行中新增文件 → 下一轮扫描触发通知 → 推送。
      // 全程没有任何 HTTP 请求:这就是「不再轮询」的端到端证据。
      writeFileSync(join(a.share, 'b.txt'), 'written while running');
      await waitFor(() => statuses().some((s) => s.entries === 2), 25000);

      socket.close();
      await stopChildren();
      rmDir(a.dir);
    },
    60000,
  );

  it(
    'does not sync files with a peer that is not in the devices whitelist',
    async () => {
      const a = await setupDaemon('a', [{ path: 'secret.txt', content: Buffer.from('top secret') }]);
      const b = await setupDaemon('b', []);

      // B 的白名单(devices)不含 A,且 A 不在 B 的 knownDevices → 信任模型下 A 连上 B 后
      // 不断连(否则 B 收不到 A 的配对请求、弹不出「待确认」),但文件同步被 allowed 闸门
      // 挡住,secret.txt 不应到达 B。日志应标明「已连上但未授权任何共享目录」。
      startDaemon(a, [`ws://127.0.0.1:${b.peerPort}`], [b.deviceId]);
      startDaemon(b, [`ws://127.0.0.1:${a.peerPort}`], []);

      // 留足时间:握手 + A 侧扫描(5s) + B 侧处理连接
      await new Promise((r) => setTimeout(r, 6000));

      // 核心不变量:未授权对端拿不到任何文件内容
      expect(existsSync(join(b.share, 'secret.txt'))).toBe(false);

      const bLog = readFileSync(join(b.dir, 'daemon.out.log'), 'utf8');
      expect(bLog).toContain('not authorized for any shared folder');

      await stopChildren();
      rmDir(a.dir);
      rmDir(b.dir);
    },
    30000,
  );

  it(
    'propagates a deletion to the peer and persists the local tombstone',
    async () => {
      const a = await setupDaemon('a', [
        { path: 'temp.txt', content: Buffer.from('delete me') },
      ]);
      const b = await setupDaemon('b', []);

      startDaemon(a, [`ws://127.0.0.1:${b.peerPort}`], [b.deviceId]);
      // 错开启动:先等 A 就绪再起 B,避免双方同时启动互相 ECONNREFUSED
      // 后走指数退避把连接建立推到 30s 边缘(daemon 侧另有首连立即重试兜底)
      await waitForDaemonReady(a);
      startDaemon(b, [`ws://127.0.0.1:${a.peerPort}`], [a.deviceId]);

      // B 先收到 temp.txt
      await waitFor(() => existsSync(join(b.share, 'temp.txt')));
      expect(readFileSync(join(b.share, 'temp.txt'))).toEqual(Buffer.from('delete me'));

      // A 侧删除文件,等待墓碑传播到 B
      rmDir(join(a.share, 'temp.txt'));
      try {
        await waitFor(() => !existsSync(join(b.share, 'temp.txt')), 30000);
      } catch (error) {
        console.log('[test] deletion waitFor failed, dumping logs');
        dumpLogs(a, b);
        throw error;
      }

      // 停掉 daemon 后读取 A 的本地索引库,确认删除已持久化为墓碑
      // (修复前:删除只广播不落库,本地库仍记录存活条目)
      await stopChildren();
      const aIndex = openIndexStore(folderIndexPath(a.dir, 'main'));
      expect(aIndex.getEntry('temp.txt')?.deleted).toBe(true);
      aIndex.close();

      rmDir(a.dir);
      rmDir(b.dir);
    },
    45000,
  );

  it(
    'picks up a new shared folder when config.json is replaced atomically (rename-save)',
    async () => {
      const a = await setupDaemon('a', []);
      const shareB = join(a.dir, 'share-b');
      mkdirSync(shareB, { recursive: true });

      // 启动时只配 main 一个共享目录
      startDaemon(a, [], []);

      // 用编辑器式的原子保存(vi/vim/nvim 行为):先写临时文件再 rename 替换
      // 等待 daemon 就绪(日志出现 "syncx daemon started" 后 watcher 已同步注册),
      // 避免 watcher 尚未建立时 rename 事件被错过导致热重载静默失效;
      // 日志文件可能尚未创建,读取失败按未就绪处理
      await waitFor(() => {
        try {
          return readFileSync(join(a.dir, 'daemon.out.log'), 'utf8').includes(
            'syncx daemon started',
          );
        } catch {
          return false;
        }
      });
      saveConfigAtomically(a, [
        { id: 'main', path: a.share, devices: [] },
        { id: 'secondary', path: shareB, devices: [] },
      ]);

      // 热重载应触发,日志出现 "config updated: adding shared folder",并打开新索引库
      await waitFor(
        () =>
          readFileSync(join(a.dir, 'daemon.out.log'), 'utf8')
            .includes('config updated: adding shared folder'),
        25000,
      );

      // 新增目录的索引库文件被创建,说明目录已被 daemon 接管
      const configContent = JSON.parse(readFileSync(a.configPath, 'utf8')) as {
        sharedFolders: Array<{ id: string; path: string }>;
      };
      const secondaryId = configContent.sharedFolders.find((f) => f.id === 'secondary')!.path;
      const idx = openIndexStore(folderIndexPath(a.dir, folderIdFor({ id: 'secondary', path: secondaryId, devices: [] })));
      expect(idx.listEntries()).toEqual([]);
      idx.close();
      // 手改 config.json 热重载新增的目录也会被采集身份指纹:否则新目录会因「无法校验身份」
      // 退化为结构守卫(新实例索引为空,采集指纹不可能产生墓碑,是安全的)。
      // 注意指纹落在配置里,**不往共享目录写任何文件**。
      await waitFor(
        () =>
          (
            JSON.parse(readFileSync(a.configPath, 'utf8')) as {
              sharedFolders: Array<{ id: string; folderIdentity?: unknown }>;
            }
          ).sharedFolders.some((f) => f.id === 'secondary' && f.folderIdentity !== undefined),
        5000,
      );
      expect(existsSync(join(secondaryId, '.syncx-folder'))).toBe(false);

      await stopChildren();
      rmDir(a.dir);
    },
    45000,
  );
});

/* ==================== 对端版本可见性回归(peerInfo 解耦书签会话) ==================== */

interface StatusDevice {
  deviceId: string;
  online: boolean;
  version?: string;
  hostname?: string;
}
interface StatusResponse {
  devices: StatusDevice[];
  /** 仅含非零进度的目录(卡片据此显示「传输中」);全部静置时为空数组。 */
  syncProgress?: Array<{ folder: string; pending: number; sending: number; receiving: number }>;
}

/** 携带落盘令牌读取 daemon 控制 API 的 /api/status(dev 运行态 version 为 'dev')。 */
async function getStatus(setup: DaemonSetup): Promise<StatusResponse> {
  const token = readFileSync(join(setup.dir, 'control.token'), 'utf8').trim();
  const res = await fetch(`http://127.0.0.1:${setup.controlPort}/api/status`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`GET /api/status returned ${res.status}: ${await res.text()}`);
  return (await res.json()) as StatusResponse;
}

function findDevice(status: StatusResponse, deviceId: string): StatusDevice | undefined {
  return status.devices.find((d) => d.deviceId === deviceId);
}

/** 等待某 daemon 的 status 中,目标对端既在线又带上了版本(握手 hello 已抵达)。 */
async function waitForPeerVersionReady(
  observer: DaemonSetup,
  peerDeviceId: string,
  timeoutMs = 45000,
): Promise<StatusDevice> {
  const start = Date.now();
  let last: StatusDevice | undefined;
  for (;;) {
    try {
      const status = await getStatus(observer);
      last = findDevice(status, peerDeviceId);
      if (last && last.online && typeof last.version === 'string' && last.version.length > 0) {
        return last;
      }
    } catch {
      // daemon 尚未就绪 / 临时错误:继续等
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `timed out waiting for ${peerDeviceId} version on ${observer.dir}; last=${JSON.stringify(last)}`,
      );
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

describe('peer version visibility under dual connections (peerInfo regression)', () => {
  it(
    'shows the peer version on BOTH sides after a mutual (dual) connection',
    async () => {
      // A 与 C 互为手动对端(devices 互列):双方各主动拨号对方 → 双连接(每条方向 2 个会话)。
      // 回归点:对端版本按 deviceId 存于 peerInfo,而非按「书签会话」;双连接 / 重连 /
      // 书签迁移等拓扑抖动下,设备卡的对端版本不应偶发「未知」。
      const a = await setupDaemon('a', []);
      const c = await setupDaemon('c', []);

      startDaemon(a, [`ws://127.0.0.1:${c.peerPort}`], [c.deviceId]);
      await waitForDaemonReady(a);
      startDaemon(c, [`ws://127.0.0.1:${a.peerPort}`], [a.deviceId]);

      const aSeesC = await waitForPeerVersionReady(a, c.deviceId);
      const cSeesA = await waitForPeerVersionReady(c, a.deviceId);

      // 核心不变量:双连接下,两侧都能看到对方的运行版本(不再「版本未知」)
      expect(typeof aSeesC.version).toBe('string');
      expect(aSeesC.version!.length).toBeGreaterThan(0);
      expect(typeof cSeesA.version).toBe('string');
      expect(cSeesA.version!.length).toBeGreaterThan(0);
      // 主机名也应随 hello 一起可靠下发
      expect(typeof aSeesC.hostname).toBe('string');

      await stopChildren();
      rmDir(a.dir);
      rmDir(c.dir);
    },
    90000,
  );

  it(
    'keeps showing the peer version after the peer is restarted (reconnect + bookmark migration)',
    async () => {
      // 更贴近用户报告的三设备拓扑:A 同时与 B、C 配对(A 是观察者,老版本里只有它偶发
      // 「版本未知」)。本用例断言:即便 C 重启导致 A 与 C 之间的书签会话迁移 / 重连,
      // A 仍能稳定看到 B 与 C 的版本,不再退化成「未知」。
      const a = await setupDaemon('a', []);
      const b = await setupDaemon('b', []);
      const c = await setupDaemon('c', []);

      startDaemon(a, [`ws://127.0.0.1:${b.peerPort}`, `ws://127.0.0.1:${c.peerPort}`], [b.deviceId, c.deviceId]);
      await waitForDaemonReady(a);
      startDaemon(b, [`ws://127.0.0.1:${a.peerPort}`], [a.deviceId]);
      startDaemon(c, [`ws://127.0.0.1:${a.peerPort}`], [a.deviceId]);

      const aSeesB = await waitForPeerVersionReady(a, b.deviceId);
      const aSeesC = await waitForPeerVersionReady(a, c.deviceId);
      expect(aSeesB.version!.length).toBeGreaterThan(0);
      expect(aSeesC.version!.length).toBeGreaterThan(0);

      // 让 C 重启:A 与 C 的会话断开 → 书签迁移 / 出站重连,C 重新上线后 hello 重发。
      // 重启后 A 仍应稳定看到 C 的版本(peerInfo 按 deviceId 缓存,与书签会话解耦)。
      const cChild = children[children.length - 1];
      if (!cChild) throw new Error('expected a running C daemon');
      cChild.kill('SIGTERM');
      await new Promise((r) => cChild.once('exit', () => r(null)));

      // 重新配置并启动 C(沿用同一身份目录,deviceId 不变)
      startDaemon(c, [`ws://127.0.0.1:${a.peerPort}`], [a.deviceId]);
      const aSeesCAgain = await waitForPeerVersionReady(a, c.deviceId);
      expect(aSeesCAgain.online).toBe(true);
      expect(aSeesCAgain.version!.length).toBeGreaterThan(0);
      // B 全程未动,A 看到 B 的版本应始终稳定
      const aSeesBStill = await getStatus(a);
      expect(findDevice(aSeesBStill, b.deviceId)?.version?.length).toBeGreaterThan(0);

      await stopChildren();
      rmDir(a.dir);
      rmDir(b.dir);
      rmDir(c.dir);
    },
    120000,
  );
});

/* ==================== 对比弹窗:图片预览 ==================== */

/** 真实可解码的 1×1 纯色 PNG(测试只关心字节能原样往返,不关心画面)。 */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mO4o6HxHwAFPAIs0Zo91QAAAABJRU5ErkJggg==',
  'base64',
);

interface CompareSide {
  exists: boolean;
  text?: string;
  size?: number;
  binary?: boolean;
  tooLarge?: boolean;
  image?: { mime: string; data: string };
  error?: string;
}

interface ComparePair {
  local: CompareSide;
  remote: CompareSide;
}

/** 携带落盘令牌索取「同一个文件的两侧状态」(对比弹窗的数据源)。 */
async function getFilePair(
  setup: DaemonSetup,
  folderId: string,
  deviceId: string,
  filePath: string,
): Promise<ComparePair> {
  const token = readFileSync(join(setup.dir, 'control.token'), 'utf8').trim();
  const res = await fetch(
    `http://127.0.0.1:${setup.controlPort}/api/folders/file?folderId=${folderId}` +
      `&device=${encodeURIComponent(deviceId)}&path=${encodeURIComponent(filePath)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    throw new Error(`GET /api/folders/file returned ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as ComparePair;
}

describe('file compare:图片预览', () => {
  it(
    '图片两侧都带回 MIME 与 base64;体积上限按类型分档(3 MiB 的图可预览,同样大的非图片降级)',
    async () => {
      // 两个同名不同后缀、同为 3 MiB 的文件,用来把「按类型分档」这条规则钉住:
      // 文本上限 2 MiB 会让它们都读不了,图片上限 8 MiB 只放行 .png 那个。
      const bigPng = Buffer.concat([PNG_1PX, Buffer.alloc(3 * 1024 * 1024, 0x41)]);
      const bigBin = Buffer.alloc(3 * 1024 * 1024, 0x42);

      const a = await setupDaemon('a', [
        { path: 'pic.png', content: PNG_1PX },
        { path: 'big.png', content: bigPng },
        { path: 'big.bin', content: bigBin },
      ]);
      const b = await setupDaemon('b', []);

      startDaemon(a, [`ws://127.0.0.1:${b.peerPort}`], [b.deviceId]);
      await waitForDaemonReady(a);
      startDaemon(b, [`ws://127.0.0.1:${a.peerPort}`], [a.deviceId]);

      // 先让 B 真拿到这三个文件:对端必须「索引里有、盘上也有」才给得出内容
      try {
        await waitFor(
          () =>
            ['pic.png', 'big.png', 'big.bin'].every((f) => existsSync(join(b.share, f))),
          60000,
        );
      } catch (error) {
        dumpLogs(a, b);
        throw error;
      }

      // ---- 小图:两侧都给 MIME + base64,且 base64 解回来就是原字节 ----
      const pic = await getFilePair(a, 'main', b.deviceId, 'pic.png');
      expect(pic.local.image?.mime).toBe('image/png');
      expect(pic.remote.image?.mime).toBe('image/png');
      expect(Buffer.from(pic.local.image!.data, 'base64').equals(PNG_1PX)).toBe(true);
      expect(Buffer.from(pic.remote.image!.data, 'base64').equals(PNG_1PX)).toBe(true);
      // 图片就是二进制:text 不给(前端据此走「看图」而不是「逐行」)
      expect(pic.local.binary).toBe(true);
      expect(pic.local.text).toBeUndefined();
      expect(pic.local.tooLarge).toBeUndefined();
      expect(pic.local.size).toBe(PNG_1PX.length);

      // 反方向也成立:B 读 A 的图片
      const picFromB = await getFilePair(b, 'main', a.deviceId, 'pic.png');
      expect(picFromB.local.image?.mime).toBe('image/png');
      expect(picFromB.remote.image?.mime).toBe('image/png');

      // ---- 3 MiB 的 png:超过文本上限、仍在图片上限内 → 照样预览(本 ADR 的行为变更点) ----
      const big = await getFilePair(a, 'main', b.deviceId, 'big.png');
      expect(big.local.size).toBe(bigPng.length);
      expect(big.local.size!).toBeGreaterThan(2 * 1024 * 1024);
      expect(big.local.tooLarge).toBeUndefined();
      expect(big.local.image?.mime).toBe('image/png');
      expect(big.remote.image?.mime).toBe('image/png');
      expect(big.remote.size).toBe(bigPng.length);
      // 对端回传的字节与来源侧一致(3 MiB 的 base64 也一路带回来了,没被上限截断)
      expect(big.remote.image?.data).toBe(big.local.image?.data);

      // ---- 同样大的非图片:仍按文本上限降级为「整文件覆盖」,一个字节都不回传 ----
      const bin = await getFilePair(a, 'main', b.deviceId, 'big.bin');
      expect(bin.local.size).toBe(bigBin.length);
      expect(bin.local.tooLarge).toBe(true);
      expect(bin.local.image).toBeUndefined();
      expect(bin.local.text).toBeUndefined();

      await stopChildren();
      rmDir(a.dir);
      rmDir(b.dir);
    },
    120000,
  );
});

