import { describe, expect, it, afterEach } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  await stopChildren();
});

function waitFor(condition: () => boolean, timeoutMs = 45000): Promise<void> {
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

/* ==================== daemon 辅助 ==================== */

interface Node {
  dir: string;
  share: string;
  configPath: string;
  peerPort: number;
  controlPort: number;
  deviceId: string;
}

/** 建一个 daemon 的配置目录 + 已提交过一次的 git 仓库作为共享目录。 */
async function setup(name: string): Promise<Node> {
  const dir = mkdtempSync(join(tmpdir(), `syncx-gitchain-${name}-`));
  const share = join(dir, 'share');
  mkdirSync(share, { recursive: true });
  const identity = loadOrCreateIdentity(dir);
  const [peerPort, controlPort] = await Promise.all([allocatePort(), allocatePort()]);
  const node: Node = {
    dir,
    share,
    configPath: join(dir, 'config.json'),
    peerPort,
    controlPort,
    deviceId: identity.deviceId,
  };
  // 仓库级配置不依赖宿主:缺 user.name 的机器上提交会失败(看着像产品 bug),
  // 开着 autocrlf 的宿主会把 README 报成已修改,污染 status 判定。
  git(share, ['init', '-q']);
  git(share, ['config', 'user.name', 'syncx-test']);
  git(share, ['config', 'user.email', 'syncx-test@example.com']);
  git(share, ['config', 'core.autocrlf', 'false']);
  writeFileSync(join(share, 'README.md'), '# syncx git chain fixture\n');
  commitAll(share, 'chore: 初始提交');
  return node;
}

/** 起 daemon:devices 是该目录共享给哪些设备(决定广播/中继目标),peers 是连接地址。 */
function start(node: Node, devices: string[], peerUrls: string[]): void {
  writeFileSync(
    node.configPath,
    JSON.stringify({
      sharedFolders: [{ id: 'main', path: node.share, devices, gitSync: 'full' }],
      peers: peerUrls,
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
      node.configPath,
      '--port',
      String(node.peerPort),
      '--control-port',
      String(node.controlPort),
    ],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: cleanDaemonEnv() },
  );
  child.stdout?.pipe(createWriteStream(join(node.dir, 'daemon.out.log')));
  child.stderr?.pipe(createWriteStream(join(node.dir, 'daemon.err.log')));
  children.push(child);
}

function daemonText(node: Node): string {
  let text = '';
  for (const f of ['daemon.out.log', 'daemon.err.log']) {
    try {
      text += readFileSync(join(node.dir, f), 'utf8');
    } catch {
      // 日志文件尚未创建
    }
  }
  return text;
}

const count = (text: string, re: RegExp): number => (text.match(re) ?? []).length;

/** 本机把提交通知**广播**出去的条数(只统计自己的新提交,镜像提交不该出现在这里)。 */
const broadcastLines = (node: Node): number => count(daemonText(node), /git commit broadcast: /g);

/** 本机镜像提交条数。 */
const autoCommitLines = (node: Node): number => count(daemonText(node), /auto-committing: /g);

/** 本机向其余对端中继通知的条数。 */
const relayedLines = (node: Node): number => count(daemonText(node), /git commit relayed:/g);

const ready = (node: Node): boolean => daemonText(node).includes('syncx daemon started');

describe('git commit sync across a chain A—B—C', () => {
  it.skipIf(!HAS_GIT)(
    'relays the notification one hop further so the far end commits too',
    async () => {
      const a = await setup('a');
      const b = await setup('b');
      const c = await setup('c');

      // 链式拓扑:A 只认识 B,B 认识两边,C 只认识 B —— A 根本无从直接通知 C
      start(a, [b.deviceId], [`ws://127.0.0.1:${b.peerPort}`]);
      await waitFor(() => ready(a));
      start(b, [a.deviceId, c.deviceId], [`ws://127.0.0.1:${a.peerPort}`, `ws://127.0.0.1:${c.peerPort}`]);
      await waitFor(() => ready(b));
      start(c, [b.deviceId], [`ws://127.0.0.1:${b.peerPort}`]);
      await waitFor(() => ready(c));
      // 三方各完成首轮扫描(建立基线)与会话对账
      await new Promise((r) => setTimeout(r, 3_000));

      const message = 'feat: 链式提交要能传到最远端';
      writeFileSync(join(a.share, 'x.txt'), 'hello from A');
      commitAll(a.share, message);

      // 第一跳:A 广播 → B 镜像提交。日志经管道落盘会比 git 操作慢半拍,
      // 所以计数类断言一律放到 waitFor 之后,不在这里抢读。
      await waitFor(() => headSubject(b.share) === message);
      await waitFor(() => relayedLines(b) >= 1);

      // 第二跳:B 把**原始通知**中继给 C → C 也落一笔同样信息的提交
      await waitFor(() => headSubject(c.share) === message);
      expect(readFileSync(join(c.share, 'x.txt'), 'utf8')).toBe('hello from A');
      expect(git(c.share, ['status', '--porcelain'])).toBe('');

      // 环路防护:C 提交后会向除来源(A)外的对端(= B)转发,但 B 入队前按原哈希去重,
      // 所以两边都到此为止 —— 再等十几轮扫描,三方提交数一律不再增长。
      const counts = [commitCount(a.share), commitCount(b.share), commitCount(c.share)];
      await new Promise((r) => setTimeout(r, 5_000));
      expect([commitCount(a.share), commitCount(b.share), commitCount(c.share)]).toEqual(counts);
      expect(autoCommitLines(b)).toBe(1);
      expect(autoCommitLines(c)).toBe(1);
      expect(relayedLines(b)).toBe(1);
      // 镜像提交绝不会被当成「本机新提交」再广播出去:整条链只有一笔广播
      expect(broadcastLines(a)).toBe(1);
      expect(broadcastLines(b)).toBe(0);
      expect(broadcastLines(c)).toBe(0);

      await stopChildren();
      for (const node of [a, b, c]) rmDir(node.dir);
    },
    180000,
  );
});
