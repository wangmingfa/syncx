import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadOrCreateIdentity } from '../src/identity.js';
import { createLogger } from '../src/logger.js';
import type { ControlMessage } from '../src/net/wire.js';
import { SyncSessionManager } from '../src/session-manager.js';

/**
 * git 提交检测心跳(src/session-manager.ts 的 startGitCheckTimer)。
 *
 * 纯 git 命令产生的提交只动 .git,被文件监听硬忽略 —— 检测挂在扫描轮尾时,
 * 「本机提交 → 本机广播」这一跳只能等兜底全扫(缺省 600s)兜住。这条独立
 * 心跳每 5s 跑一轮 checkGitCommits,把检测时效拉回秒级;节拍与 Rust 端
 * GIT_COMMIT_CHECK_INTERVAL_MS、MoonBit 端 GIT_CHECK_TICKS 同节奏。
 *
 * 测试注入 SYNCX_GIT_CHECK_MS=50 的短周期,不真等 5s。
 */

function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

const HAS_GIT = gitAvailable();

function git(repoPath: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoPath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function initRepo(repoPath: string): string {
  git(repoPath, ['init', '-q']);
  git(repoPath, ['config', 'user.name', 'syncx-test']);
  git(repoPath, ['config', 'user.email', 'syncx-test@example.com']);
  git(repoPath, ['config', 'core.autocrlf', 'false']);
  writeFileSync(join(repoPath, 'README.md'), '# git-check heartbeat fixture\n');
  git(repoPath, ['add', '-A']);
  git(repoPath, ['commit', '-qm', 'chore: 初始提交']);
  return git(repoPath, ['rev-parse', 'HEAD']);
}

type NotifyMsg = Extract<ControlMessage, { kind: 'git-commit-notify' }>;

/** 测试视角的内部接口:TS 的 private 只在编译期生效,测试按结构类型触达。 */
interface Internals {
  onControl(msg: ControlMessage, hopDeviceId: string): void;
  sendControlTo(deviceId: string, msg: ControlMessage): boolean;
}

const cleanupDirs: string[] = [];

function boot(mode: 'off' | 'send'): { dir: string; share: string; manager: SyncSessionManager; base: string } {
  const dir = mkdtempSync(join(tmpdir(), 'syncx-git-heartbeat-'));
  const share = join(dir, 'share');
  mkdirSync(share, { recursive: true });
  const base = initRepo(share);
  const identity = loadOrCreateIdentity(dir);
  const configPath = join(dir, 'config.json');
  const sharedFolders = [{ id: 'main', path: share, devices: ['PEER000001'], gitSync: mode }];
  writeFileSync(configPath, JSON.stringify({ sharedFolders, knownDevices: [], peers: [] }));
  const manager = new SyncSessionManager(
    { identity, configPath, configDir: dir, peerPort: 0, logger: createLogger(undefined) },
    sharedFolders,
  );
  cleanupDirs.push(dir);
  return { dir, share, manager, base };
}

afterEach(() => {
  delete process.env.SYNCX_GIT_CHECK_MS;
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 拦住出站控制消息并记录;deliver 决定目标此刻算不算够得着。 */
function spyControls(
  manager: SyncSessionManager,
  deliver: (deviceId: string) => boolean = () => true,
): Array<{ deviceId: string; msg: ControlMessage }> {
  const sent: Array<{ deviceId: string; msg: ControlMessage }> = [];
  (manager as unknown as Internals).sendControlTo = (deviceId, msg) => {
    sent.push({ deviceId, msg });
    return deliver(deviceId);
  };
  return sent;
}

const notifies = (sent: Array<{ deviceId: string; msg: ControlMessage }>): NotifyMsg[] =>
  sent.flatMap((s) => (s.msg.kind === 'git-commit-notify' ? [s.msg] : []));

/** 接收方处理到通知后回给发送方的投递回执(它署自己的 id)。 */
function ackOf(hash: string, device: string): ControlMessage {
  return { kind: 'git-commit-ack', fromDeviceId: device, folderId: 'main', commitHash: hash };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('git 提交检测心跳', () => {
  it.skipIf(!HAS_GIT)(
    'detects a pure git commit (no worktree changes) within one beat and settles on ack',
    async () => {
      process.env.SYNCX_GIT_CHECK_MS = '50';
      const { share, manager, base } = boot('send');
      const sent = spyControls(manager);
      manager.startGitCheckTimer();

      // 首拍只建基线,不广播(「绝不重放历史提交」兜底)
      await sleep(200);
      expect(notifies(sent)).toHaveLength(0);

      // 纯 git 提交:空提交,工作树零变化,文件监听无论如何看不见
      git(share, ['commit', '--allow-empty', '-qm', 'feat: 心跳检测到的提交']);
      const hash = git(share, ['rev-parse', 'HEAD']);

      // 心跳一拍内检测到并广播(旧架构下这里要等兜底全扫,分钟级)
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && notifies(sent).length === 0) {
        await sleep(50);
      }
      expect(notifies(sent)).toHaveLength(1);
      expect(notifies(sent)[0]).toMatchObject({ kind: 'git-commit-notify', commitHash: hash, folderId: 'main' });
      expect(sent[0]?.deviceId).toBe('PEER000001');

      // 回执到达销账;后续心跳与显式扫描都不再为同一笔重发(基线已推进)
      (manager as unknown as Internals).onControl(ackOf(hash, 'PEER000001'), 'PEER000001');
      const count = sent.length;
      await sleep(250);
      await manager.runScan();
      expect(sent.length).toBe(count);
      expect(notifies(sent).map((n) => n.commitHash)).not.toContain(base);
      manager.close();
    },
  );

  it.skipIf(!HAS_GIT)('keeps silent for gitSync=off folders', async () => {
    process.env.SYNCX_GIT_CHECK_MS = '50';
    const { share, manager } = boot('off');
    const sent = spyControls(manager);
    manager.startGitCheckTimer();

    git(share, ['commit', '--allow-empty', '-qm', 'feat: off 模式的提交']);
    await sleep(250);
    expect(notifies(sent)).toHaveLength(0);
    manager.close();
  });
});
