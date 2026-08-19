import { describe, expect, it, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  createWriteStream,
  renameSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { loadOrCreateIdentity } from '../../src/identity.js';
import { openIndexStore } from '../../src/indexstore.js';
import { hashBlock } from '../../src/blockstore.js';
import { folderIdFor, folderIndexPath } from '../../src/config.js';
import { allocatePort } from './ports.js';

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
      blocks: [hashBlock(file.content)],
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

function startDaemon(setup: DaemonSetup, peers: string[], peerDeviceIds: string[]): void {
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
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  // 捕获 daemon 输出,失败时可读日志定位
  child.stdout?.pipe(createWriteStream(join(setup.dir, 'daemon.out.log')));
  child.stderr?.pipe(createWriteStream(join(setup.dir, 'daemon.err.log')));
  children.push(child);
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
      rmSync(a.dir, { recursive: true, force: true });
      rmSync(b.dir, { recursive: true, force: true });
    },
    90000,
  );

  it(
    'propagates files created while the daemons are running',
    async () => {
      const a = await setupDaemon('a', []);
      const b = await setupDaemon('b', []);

      startDaemon(a, [`ws://127.0.0.1:${b.peerPort}`], [b.deviceId]);
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
      rmSync(a.dir, { recursive: true, force: true });
      rmSync(b.dir, { recursive: true, force: true });
    },
    45000,
  );

  it(
    'rejects a peer that is not in the devices whitelist',
    async () => {
      const a = await setupDaemon('a', [{ path: 'secret.txt', content: Buffer.from('top secret') }]);
      const b = await setupDaemon('b', []);

      // B 的白名单不含 A → A 连接 B 时(加密握手后)应被拒绝,文件不应到达 B
      startDaemon(a, [`ws://127.0.0.1:${b.peerPort}`], [b.deviceId]);
      startDaemon(b, [`ws://127.0.0.1:${a.peerPort}`], []);

      // 留足时间:握手 + A 侧扫描(5s) + B 侧拒绝
      await new Promise((r) => setTimeout(r, 6000));

      expect(existsSync(join(b.share, 'secret.txt'))).toBe(false);

      const bLog = readFileSync(join(b.dir, 'daemon.out.log'), 'utf8');
      expect(bLog).toContain('rejected unauthorized peer');

      await stopChildren();
      rmSync(a.dir, { recursive: true, force: true });
      rmSync(b.dir, { recursive: true, force: true });
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
      startDaemon(b, [`ws://127.0.0.1:${a.peerPort}`], [a.deviceId]);

      // B 先收到 temp.txt
      await waitFor(() => existsSync(join(b.share, 'temp.txt')));
      expect(readFileSync(join(b.share, 'temp.txt'))).toEqual(Buffer.from('delete me'));

      // A 侧删除文件,等待墓碑传播到 B
      rmSync(join(a.share, 'temp.txt'));
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

      rmSync(a.dir, { recursive: true, force: true });
      rmSync(b.dir, { recursive: true, force: true });
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

      await stopChildren();
      rmSync(a.dir, { recursive: true, force: true });
    },
    45000,
  );
});
