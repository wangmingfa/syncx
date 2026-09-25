import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { rmDir } from './helpers.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  autoCommit,
  getCommitInfo,
  getLastCommitHash,
  hasUncommittedChanges,
  isGitRepo,
} from '../src/git-monitor.js';

/** 探测本机是否有可用的 git:没有则整组用例优雅 skip(与 symlink 探测同一套路)。 */
function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

const HAS_GIT = gitAvailable();

/**
 * 建一个临时 git 仓库。刻意写死 user.name / user.email 到仓库级配置:
 * 不依赖运行测试这台机器的全局 git 身份 —— 换一台没配过 git 的 CI 机器,
 * 依赖全局配置的提交会直接失败,而那种失败看起来像产品 bug。
 */
function tempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'syncx-git-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.name', 'syncx-test']);
  git(dir, ['config', 'user.email', 'syncx-test@example.com']);
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function commitAll(dir: string, message: string): string {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', message]);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

describe('git repo detection', () => {
  it.skipIf(!HAS_GIT)('recognizes a git repo and a plain directory', () => {
    const repo = tempGitRepo();
    const plain = mkdtempSync(join(tmpdir(), 'syncx-norepo-'));
    try {
      expect(isGitRepo(repo)).toBe(true);
      expect(isGitRepo(plain)).toBe(false);
      // 仓库的子目录不是仓库根:检测只认根目录下的 .git
      mkdirSync(join(repo, 'sub'));
      expect(isGitRepo(join(repo, 'sub'))).toBe(false);
    } finally {
      rmDir(repo);
      rmDir(plain);
    }
  });

  it.skipIf(!HAS_GIT)('returns null HEAD for a repo without any commit', () => {
    const repo = tempGitRepo();
    try {
      expect(getLastCommitHash(repo)).toBe(null);
    } finally {
      rmDir(repo);
    }
  });

  it('returns null for a directory that is not a repo at all', () => {
    const plain = mkdtempSync(join(tmpdir(), 'syncx-norepo-'));
    try {
      expect(getLastCommitHash(plain)).toBe(null);
    } finally {
      rmDir(plain);
    }
  });
});

describe('commit info collection', () => {
  it.skipIf(!HAS_GIT)('gathers hash, parent, message and changed files of a new commit', () => {
    const repo = tempGitRepo();
    try {
      writeFileSync(join(repo, 'a.txt'), 'A');
      const first = commitAll(repo, '初始提交');

      writeFileSync(join(repo, 'b.txt'), 'B');
      writeFileSync(join(repo, 'a.txt'), 'A-modified');
      const second = commitAll(repo, '新增 b 并修改 a');

      const info = getCommitInfo(repo, first, second);
      expect(info).not.toBeNull();
      expect(info!.hash).toBe(second);
      expect(info!.parentHash).toBe(first);
      expect(info!.message).toBe('新增 b 并修改 a');
      expect([...info!.changedFiles].sort()).toEqual(['a.txt', 'b.txt']);
    } finally {
      rmDir(repo);
    }
  });

  it.skipIf(!HAS_GIT)('carries the commit body through fullMessage while message stays the subject', () => {
    const repo = tempGitRepo();
    try {
      writeFileSync(join(repo, 'a.txt'), 'A');
      const first = commitAll(repo, '只有一行');
      writeFileSync(join(repo, 'b.txt'), 'B');
      git(repo, ['add', '-A']);
      execFileSync('git', ['commit', '-qm', '标题行', '-m', '正文第一段', '-m', '正文第二段'], {
        cwd: repo,
        stdio: 'ignore',
      });
      const second = git(repo, ['rev-parse', 'HEAD']).trim();

      const info = getCommitInfo(repo, first, second)!;
      expect(info.message).toBe('标题行');
      expect(info.fullMessage).toContain('标题行');
      expect(info.fullMessage).toContain('正文第一段');
      expect(info.fullMessage).toContain('正文第二段');
    } finally {
      rmDir(repo);
    }
  });

  it.skipIf(!HAS_GIT)('reports a deleted file among changed files', () => {
    const repo = tempGitRepo();
    try {
      writeFileSync(join(repo, 'keep.txt'), 'K');
      writeFileSync(join(repo, 'gone.txt'), 'G');
      const first = commitAll(repo, '两个文件');

      rmFile(join(repo, 'gone.txt'));
      const second = commitAll(repo, '删掉一个文件');

      const info = getCommitInfo(repo, first, second)!;
      expect(info.changedFiles).toEqual(['gone.txt']);
    } finally {
      rmDir(repo);
    }
  });
});

describe('auto commit', () => {
  it.skipIf(!HAS_GIT)('stages new, modified and deleted files in one commit', () => {
    const repo = tempGitRepo();
    try {
      writeFileSync(join(repo, 'a.txt'), 'A');
      writeFileSync(join(repo, 'b.txt'), 'B');
      commitAll(repo, '基线');

      // 三种变更同时存在:自动提交必须一次性全收(需求明确要求的语义)
      writeFileSync(join(repo, 'a.txt'), 'A-changed');
      rmFile(join(repo, 'b.txt'));
      writeFileSync(join(repo, 'c.txt'), 'C');

      const result = autoCommit(repo, '来自对端的提交信息');
      expect(result.success).toBe(true);
      expect(result.hash).toBeTruthy();
      expect(result.hash).toBe(getLastCommitHash(repo));

      expect(git(repo, ['status', '--porcelain']).trim()).toBe('');
      const tracked = git(repo, ['ls-files']).trim().split(/\r?\n/).sort();
      expect(tracked).toEqual(['a.txt', 'c.txt']);
    } finally {
      rmDir(repo);
    }
  });

  it.skipIf(!HAS_GIT)('creates an empty commit when there is nothing to commit', () => {
    const repo = tempGitRepo();
    try {
      writeFileSync(join(repo, 'a.txt'), 'A');
      const baseline = commitAll(repo, '基线');
      expect(hasUncommittedChanges(repo)).toBe(false);

      // 用 --allow-empty:没有本地改动时也要让提交消息落到日志里,保持两端的提交链对齐
      const result = autoCommit(repo, '对端的提交,本机恰好无改动');
      expect(result.success).toBe(true);
      expect(result.hash).not.toBe(baseline);
      expect(git(repo, ['log', '-1', '--format=%s']).trim()).toBe('对端的提交,本机恰好无改动');
    } finally {
      rmDir(repo);
    }
  });

  it.skipIf(!HAS_GIT)('survives a message that would break shell quoting', () => {
    const repo = tempGitRepo();
    try {
      writeFileSync(join(repo, 'a.txt'), 'A');
      commitAll(repo, '基线');
      writeFileSync(join(repo, 'b.txt'), 'B');

      // 反引号 / $() / 引号混排:实现用 execFileSync 的参数数组而非 shell 字符串,
      // 这条用例就是这个选择唯一的回归防线
      const nasty = 'fix: 处理 `backtick` 与 $(whoami) 以及 "双引号" 和 \'单引号\'';
      const result = autoCommit(repo, nasty);
      expect(result.success).toBe(true);
      expect(git(repo, ['log', '-1', '--format=%s']).trim()).toBe(nasty);
    } finally {
      rmDir(repo);
    }
  });

  it.skipIf(!HAS_GIT)('reports failure instead of throwing when the directory is not a repo', () => {
    const plain = mkdtempSync(join(tmpdir(), 'syncx-norepo-'));
    try {
      const result = autoCommit(plain, '任意消息');
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    } finally {
      rmDir(plain);
    }
  });
});

describe('uncommitted changes probe', () => {
  it.skipIf(!HAS_GIT)('detects modified and untracked files', () => {
    const repo = tempGitRepo();
    try {
      writeFileSync(join(repo, 'a.txt'), 'A');
      expect(hasUncommittedChanges(repo)).toBe(true); // 尚未提交过的全新文件

      commitAll(repo, '基线');
      expect(hasUncommittedChanges(repo)).toBe(false);

      writeFileSync(join(repo, 'a.txt'), 'A2');
      expect(hasUncommittedChanges(repo)).toBe(true);
    } finally {
      rmDir(repo);
    }
  });
});

/** 跨平台删文件:Windows 上刚写过的文件偶发 EPERM/EBUSY,做有界退避。 */
function rmFile(path: string): void {
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      unlinkSync(path);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'EPERM' && code !== 'EBUSY') throw err;
      if (attempt === 11) throw err;
      const end = Date.now() + 120;
      while (Date.now() < end) {
        /* 退避等待 */
      }
    }
  }
}
