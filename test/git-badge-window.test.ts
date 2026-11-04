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
 * 目录卡「改动 N / 未推送 N」徽标的刷新架构(2026-11-05 徽标整排消失的回归防线)。
 *
 * 徽标与扫描**彻底解耦**:独立 30s 循环(refreshGitBadges)对全部目录现查,与
 * Rust 侧 spawn_git_counts_loop 同构。此前挂在扫描体里,三个口子都能让徽标长期
 * 停在旧值 —— 收窄轮(只扫脏目录)刷不到别的目录、时段外/暂停整轮跳过、自更新
 * 重启清零后要等下一次全扫。远端实测:四次自更新重启 + 提交流触发的收窄轮连绵,
 * 六个目录的徽标整排消失 11 分钟没恢复。
 *
 * 三条口径这里钉死:扫描不刷徽标(解耦)、时段外照刷(解耦时段)、手动暂停照刷
 * (徽标是目录卡的事实陈述,连手动暂停的目录也说真话;同步归同步,徽标归徽标)。
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

/** 测试视角的内部接口:按结构类型触达 private 成员。 */
interface Internals {
  scanOnce(): Promise<void>;
  refreshGitBadges(): Promise<void>;
}

function internalsOf(manager: SyncSessionManager): Internals {
  return manager as unknown as Internals;
}

/** 「永远在窗口外」的目录时段:dow 空数组 = 没有任何一天命中。 */
const NEVER_SCHEDULE: Schedule = [{ days: { kind: 'dow', days: [] }, windows: [{ from: 1, to: 2 }] }];

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    rmDir(dir);
  }
});

describe('目录卡 git 徽标刷新架构', () => {
  it.skipIf(!HAS_GIT)(
    '徽标与扫描解耦:扫描不刷徽标,独立循环一次现查到真值(徽标全消失的回归防线)',
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
        const internals = internalsOf(manager);
        // 一轮全扫跑完,徽标仍是初值 —— 扫描不再顺带刷徽标(职责已拆出)
        await internals.scanOnce();
        expect(folder.gitUnpushedCount).toBe(0);
        expect(folder.gitChangeCount).toBe(0);
        // 独立循环一次现查,徽标立刻是真值;状态映射同步可取
        await internals.refreshGitBadges();
        expect(folder.gitUnpushedCount).toBe(2);
        expect(folder.gitChangeCount).toBeGreaterThanOrEqual(1);
        expect(manager.folderGitUnpushedCounts()).toMatchObject({ main: 2 });
      } finally {
        await shutdown(manager);
      }
    },
  );

  it.skipIf(!HAS_GIT)(
    '时段外照刷:窗口关闭不再冻结徽标',
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
        folder.config.schedule = NEVER_SCHEDULE;
        await internalsOf(manager).refreshGitBadges();
        expect(folder.gitUnpushedCount).toBe(1);
        expect(folder.gitChangeCount).toBeGreaterThanOrEqual(1);
      } finally {
        await shutdown(manager);
      }
    },
  );

  it.skipIf(!HAS_GIT)(
    '手动暂停也照刷:徽标说真话,同步归同步',
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
        await internalsOf(manager).refreshGitBadges();
        expect(folder.gitUnpushedCount).toBe(1);
        expect(folder.gitChangeCount).toBeGreaterThanOrEqual(1);
      } finally {
        await shutdown(manager);
      }
    },
  );
});
