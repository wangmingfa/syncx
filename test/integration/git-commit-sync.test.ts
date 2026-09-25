import { describe, expect, it, afterEach } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { rmDir } from '../helpers.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateIdentity } from '../../src/identity.js';
import { allocatePort, cleanDaemonEnv } from './ports.js';

/** 本机没有可用 git 时整组优雅 skip(与 test/git-monitor.test.ts 同一套路)。 */
function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

const HAS_GIT = gitAvailable();

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
  // 等子进程真正退出:旧 daemon 的优雅关闭与下一个测试的启动窗口重叠会带来间歇性 flaky
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

/* ==================== git 辅助 ==================== */

function git(repoPath: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoPath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commitAll(repoPath: string, message: string): string {
  git(repoPath, ['add', '-A']);
  git(repoPath, ['commit', '-qm', message]);
  return git(repoPath, ['rev-parse', 'HEAD']);
}

function commitCount(repoPath: string): number {
  return Number(git(repoPath, ['rev-list', '--count', 'HEAD']));
}

function headSubject(repoPath: string): string {
  return git(repoPath, ['log', '-1', '--format=%s']);
}

function trackedFiles(repoPath: string): string[] {
  return git(repoPath, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').filter(Boolean);
}

/**
 * 就地初始化一个 git 仓库并提交一条 README,返回初始提交哈希。
 *
 * 两处刻意配置都不依赖宿主:仓库级 user.name/email(换一台没配过 git 的机器,
 * 提交会失败,且看起来像产品 bug)、core.autocrlf=false(宿主开着 autocrlf 时,
 * README 会被报成「已修改」,把 autoCommit 的 status 判定掺进无关内容)。
 */
function initRepo(repoPath: string): string {
  git(repoPath, ['init', '-q']);
  git(repoPath, ['config', 'user.name', 'syncx-test']);
  git(repoPath, ['config', 'user.email', 'syncx-test@example.com']);
  git(repoPath, ['config', 'core.autocrlf', 'false']);
  writeFileSync(join(repoPath, 'README.md'), '# syncx git sync fixture\n');
  return commitAll(repoPath, 'chore: 初始提交');
}

/* ==================== daemon 辅助 ==================== */

interface DaemonSetup {
  dir: string;
  share: string;
  configPath: string;
  peerPort: number;
  controlPort: number;
  deviceId: string;
}

/** 建 daemon 配置目录 + 一个已提交过一次的 git 仓库作为共享目录(不启动进程)。 */
async function setupGitDaemon(name: string): Promise<DaemonSetup> {
  const dir = mkdtempSync(join(tmpdir(), `syncx-gitsync-${name}-`));
  const share = join(dir, 'share');
  mkdirSync(share, { recursive: true });
  const identity = loadOrCreateIdentity(dir);
  // 并行测试文件的随机端口区间会互相碰撞,用系统分配的临时端口
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

/** 首次写配置并以 gitSync='full' 启动。 */
function startDaemon(setup: DaemonSetup, peerUrl: string, peerDeviceId: string): ChildProcess {
  writeFileSync(
    setup.configPath,
    JSON.stringify({
      sharedFolders: [{ id: 'main', path: setup.share, devices: [peerDeviceId], gitSync: 'full' }],
      peers: [peerUrl],
    }),
  );
  return spawnDaemon(setup);
}

/** 重启 daemon:**不碰配置** —— 沿用磁盘上已落盘的 gitLastCommitHash 基线。 */
function restartDaemon(setup: DaemonSetup): ChildProcess {
  return spawnDaemon(setup);
}

function spawnDaemon(setup: DaemonSetup): ChildProcess {
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

function daemonText(setup: DaemonSetup): string {
  let text = '';
  for (const f of ['daemon.out.log', 'daemon.err.log']) {
    try {
      text += readFileSync(join(setup.dir, f), 'utf8');
    } catch {
      // 日志文件尚未创建
    }
  }
  return text;
}

/** 成功送达对端的提交通知条数(只数广播成功行;未送达时的 deferred 行不计)。 */
function broadcastLines(setup: DaemonSetup): number {
  return (daemonText(setup).match(/git commit broadcast: /g) ?? []).length;
}

/** 收到对端通知后执行自动提交的条数。 */
function autoCommitLines(setup: DaemonSetup): number {
  return (daemonText(setup).match(/auto-committing: /g) ?? []).length;
}

/** 磁盘上该目录已落盘的 git 基线哈希(重启后补广播的依据)。 */
function persistedBaseline(setup: DaemonSetup): string | undefined {
  const config = JSON.parse(readFileSync(setup.configPath, 'utf8')) as {
    sharedFolders?: Array<{ id?: string; gitLastCommitHash?: string }>;
  };
  return config.sharedFolders?.find((f) => f.id === 'main')?.gitLastCommitHash;
}

async function waitForDaemonReady(setup: DaemonSetup): Promise<void> {
  await waitFor(() => daemonText(setup).includes('syncx daemon started'));
}

/** 等两台 daemon 都完成首轮扫描并把基线写进配置(= 已接管目录,且尚未广播任何提交)。 */
async function waitForBaselines(...setups: DaemonSetup[]): Promise<void> {
  await waitFor(() => setups.every((s) => persistedBaseline(s) !== undefined), 45000);
}

describe('git commit sync between two real daemons', () => {
  it.skipIf(!HAS_GIT)(
    'auto-commits the peer notification without ever echoing the commit back',
    async () => {
      const a = await setupGitDaemon('a');
      const b = await setupGitDaemon('b');
      const aBase = initRepo(a.share);
      const bBase = initRepo(b.share);

      startDaemon(a, `ws://127.0.0.1:${b.peerPort}`, b.deviceId);
      // 错开启动:先等 A 就绪再起 B,避免双方同时启动互相 ECONNREFUSED 后走退避
      await waitForDaemonReady(a);
      startDaemon(b, `ws://127.0.0.1:${a.peerPort}`, a.deviceId);

      // 首次启用:两边各自把自己的 HEAD 记成基线,一笔存量历史都不该被推出去
      await waitForBaselines(a, b);
      expect(persistedBaseline(a)).toBe(aBase);
      expect(persistedBaseline(b)).toBe(bBase);
      expect(broadcastLines(a)).toBe(0);
      expect(broadcastLines(b)).toBe(0);

      // 先让文件内容按正常同步路径过去,再由 A 提交:两套机制各自可判定
      writeFileSync(join(a.share, 'a.txt'), 'from A');
      await waitFor(() => existsSync(join(b.share, 'a.txt')), 45000);

      const message = 'feat: 新增 a.txt 用于验证提交同步';
      const aCommit = commitAll(a.share, message);

      // A 广播这笔提交 → B 自动提交,提交信息就是 A 写的那条
      try {
        await waitFor(() => headSubject(b.share) === message, 45000);
      } catch (error) {
        console.log('[test] auto-commit not observed\n', daemonText(a), '\n--- B ---\n', daemonText(b));
        throw error;
      }
      expect(broadcastLines(a)).toBe(1);
      expect(autoCommitLines(b)).toBe(1);
      // 「不管本机有哪些改动,一次性全部提交」:B 的 HEAD 里应带上 a.txt,工作树干净
      expect(trackedFiles(b.share)).toContain('a.txt');
      expect(git(b.share, ['status', '--porcelain'])).toBe('');

      // ---- 死循环防护:本用例的核心不变式 ----
      // B 的自动提交产生的是**另一个**哈希。若它被 B 的扫描当成「又有一次新提交」广播回
      // A,A 又会自动提交……两台设备互相触发无限的 commit。整条链只靠「自动提交后把新
      // 哈希写回基线」这一行撑着,所以再等十几轮扫描,钉死双方提交数都不再涨。
      const aCount = commitCount(a.share);
      const bCount = commitCount(b.share);
      await new Promise((r) => setTimeout(r, 3000));
      expect(broadcastLines(b)).toBe(0);
      expect(autoCommitLines(a)).toBe(0);
      expect(commitCount(a.share)).toBe(aCount);
      expect(commitCount(b.share)).toBe(bCount);
      expect(persistedBaseline(a)).toBe(aCommit);
      expect(git(a.share, ['status', '--porcelain'])).toBe('');

      await stopChildren();
      rmDir(a.dir);
      rmDir(b.dir);
    },
    120000,
  );

  it.skipIf(!HAS_GIT)(
    'broadcasts a commit made while the daemon was down after it restarts',
    async () => {
      const a = await setupGitDaemon('a');
      const b = await setupGitDaemon('b');
      initRepo(a.share);
      initRepo(b.share);

      startDaemon(a, `ws://127.0.0.1:${b.peerPort}`, b.deviceId);
      await waitForDaemonReady(a);
      startDaemon(b, `ws://127.0.0.1:${a.peerPort}`, a.deviceId);
      await waitForBaselines(a, b);

      writeFileSync(join(a.share, 'late.txt'), 'committed after restart');
      await waitFor(() => existsSync(join(b.share, 'late.txt')), 45000);

      // 停掉 A,趁停机在 A 的仓库里提交一笔:基线仍留在配置文件里没动
      const aChild = children[0];
      if (!aChild) throw new Error('expected a running A daemon');
      aChild.kill('SIGTERM');
      await new Promise<void>((r) => aChild.once('exit', () => r()));
      const staleBaseline = persistedBaseline(a);
      const message = 'fix: 停机期间完成的提交';
      const lateCommit = commitAll(a.share, message);
      expect(lateCommit).not.toBe(staleBaseline);

      // 重启 A:读回落盘基线 → 认出这笔漏掉的提交 → 补广播给一直在线的 B
      restartDaemon(a);
      try {
        await waitFor(() => headSubject(b.share) === message, 45000);
      } catch (error) {
        console.log('[test] catch-up commit not observed\n', daemonText(a), '\n--- B ---\n', daemonText(b));
        throw error;
      }
      expect(persistedBaseline(a)).toBe(lateCommit);
      // 补广播只发生一次,且 B 的自动提交没有再弹回 A
      expect(broadcastLines(a)).toBe(1);
      expect(autoCommitLines(b)).toBe(1);
      expect(autoCommitLines(a)).toBe(0);
      expect(trackedFiles(b.share)).toContain('late.txt');

      await stopChildren();
      rmDir(a.dir);
      rmDir(b.dir);
    },
    120000,
  );
});
