import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadOrCreateIdentity } from '../src/identity.js';
import { createLogger } from '../src/logger.js';
import type { Schedule } from '../src/schedule.js';
import { SyncSessionManager } from '../src/session-manager.js';
import { rmDir } from './helpers.js';

/**
 * 目录卡「改动 N / 未推送 N」徽标的刷新节奏(2026-11-05 徽标消失回归防线)。
 *
 * 两条口径:
 *  - 窗口内:每轮扫描顺带现查,一轮后就必须是真值 —— 这是「徽标全消失」的
 *    回归防线(异步化后扫描链路任何一环断掉,这里第一个红);
 *  - 只被时段挡住:数据面不扫,但徽标是目录卡的事实陈述,每 6 拍(~30s,
 *    与 Rust 侧 git 计数循环同节奏)低频现查 —— 窗口外用户自己改文件/手动
 *    git 提交后,徽标不能永远挂着旧数;
 *  - 手动暂停:连徽标也不刷(保持旧值),与数据面意图一致。
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

/** 工作仓库 + 本地 bare 远程:push 建立上游,之后再加未推送提交。 */
function repoWithUpstream(dir: string, name: string): string {
  const remote = join(dir, `${name}-remote.git`);
  execFileSync('git', ['init', '-q', '--bare', remote], { stdio: 'ignore' });
  const repo = join(dir, name);
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q']);
  git(repo, ['remote', 'add', 'origin', remote]);
  git(repo, ['config', 'user.name', 'syncx-test']);
  git(repo, ['config', 'user.email', 'syncx-test@example.com']);
  writeFileSync(join(repo, 'base.txt'), 'base');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', '基线']);
  git(repo, ['push', '-u', '-q', 'origin', 'HEAD']);
  return repo;
}

const cleanupDirs: string[] = [];

interface BootResult {
  dir: string;
  manager: SyncSessionManager;
  folder: NonNullable<SyncSessionManager['folderStates'][number]>;
}

function boot(repo: string, id: string): BootResult {
  const dir = mkdtempSync(join(tmpdir(), 'syncx-badge-'));
  cleanupDirs.push(dir);
  const identity = loadOrCreateIdentity(dir);
  const configPath = join(dir, 'config.json');
  const sharedFolders = [{ id, path: repo, devices: [] as string[], gitSync: 'off' as const }];
  writeFileSync(configPath, JSON.stringify({ sharedFolders, knownDevices: [], peers: [] }));
  const manager = new SyncSessionManager(
    { identity, configPath, configDir: dir, peerPort: 0, logger: createLogger(undefined) },
    sharedFolders,
  );
  const folder = manager.folderStates[0];
  if (!folder) throw new Error('folder state missing');
  return { dir, manager, folder };
}

async function shutdown(manager: SyncSessionManager): Promise<void> {
  await new Promise((r) => setTimeout(r, 250));
  await manager.runScan();
  manager.close();
}

/** 测试视角的内部接口:scanOnce 是 private,按结构类型触达。 */
async function scanOnce(manager: SyncSessionManager): Promise<void> {
  await (manager as unknown as { scanOnce(): Promise<void> }).scanOnce();
}

/** 「永远在窗口外」的目录时段:dow 空数组 = 没有任何一天命中。 */
const NEVER_SCHEDULE: Schedule = [{ days: { kind: 'dow', days: [] }, windows: [{ from: 1, to: 2 }] }];

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    rmDir(dir);
  }
});

describe('目录卡 git 徽标刷新节奏', () => {
  it.skipIf(!HAS_GIT)(
    '窗口内:一轮扫描后改动/未推送徽标就是真值(徽标全消失的回归防线)',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'syncx-badge-fixture-'));
      cleanupDirs.push(dir);
      const repo = repoWithUpstream(dir, 'repo');
      // 未推送 2 笔 + 工作区 1 个未跟踪文件
      writeFileSync(join(repo, 'a.txt'), 'v1');
      git(repo, ['add', '-A']);
      git(repo, ['commit', '-qm', '第二笔']);
      git(repo, ['commit', '-qm', '第三笔', '--allow-empty']);
      writeFileSync(join(repo, 'dirty.txt'), '未跟踪');

      const { manager, folder } = boot(repo, 'main');
      try {
        await scanOnce(manager);
        expect(folder.gitUnpushedCount).toBe(2);
        expect(folder.gitChangeCount).toBeGreaterThanOrEqual(1);
        expect(manager.folderGitUnpushedCounts()).toMatchObject({ main: 2 });
      } finally {
        await shutdown(manager);
      }
    },
  );

  it.skipIf(!HAS_GIT)(
    '时段外:数据面不扫,徽标按 6 拍节奏低频追上真值',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'syncx-badge-fixture-'));
      cleanupDirs.push(dir);
      const repo = repoWithUpstream(dir, 'repo');
      writeFileSync(join(repo, 'a.txt'), 'v1');
      git(repo, ['add', '-A']);
      git(repo, ['commit', '-qm', '第二笔']);
      writeFileSync(join(repo, 'dirty.txt'), '未跟踪');

      const { manager, folder } = boot(repo, 'main');
      try {
        // 时段判定读的是内存里的 folder.config.schedule,直接置「永不命中」
        folder.config.schedule = NEVER_SCHEDULE;
        const internals = manager as unknown as { scanBeat: number };
        // 前 5 拍:尚未到刷新拍,徽标保持初值(数据面确实没扫)
        await scanOnce(manager);
        expect(internals.scanBeat).toBe(1);
        expect(folder.gitUnpushedCount).toBe(0);
        for (let i = 2; i <= 5; i++) await scanOnce(manager);
        expect(folder.gitUnpushedCount).toBe(0);
        // 第 6 拍:低频现查命中,徽标追上真值
        await scanOnce(manager);
        expect(folder.gitUnpushedCount).toBe(1);
        expect(folder.gitChangeCount).toBeGreaterThanOrEqual(1);
        expect(manager.folderGitUnpushedCounts()).toMatchObject({ main: 1 });
      } finally {
        await shutdown(manager);
      }
    },
  );

  it.skipIf(!HAS_GIT)(
    '手动暂停:徽标连低频现查也不跑(保持旧值)',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'syncx-badge-fixture-'));
      cleanupDirs.push(dir);
      const repo = repoWithUpstream(dir, 'repo');
      writeFileSync(join(repo, 'a.txt'), 'v1');
      git(repo, ['add', '-A']);
      git(repo, ['commit', '-qm', '第二笔']);
      writeFileSync(join(repo, 'dirty.txt'), '未跟踪');

      const { manager, folder } = boot(repo, 'main');
      try {
        folder.config.paused = true;
        for (let i = 0; i < 7; i++) await scanOnce(manager);
        expect(folder.gitUnpushedCount).toBe(0);
        expect(folder.gitChangeCount).toBe(0);
      } finally {
        await shutdown(manager);
      }
    },
  );
});
