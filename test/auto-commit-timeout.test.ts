import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autoCommit, getLastCommitHash } from '../src/git-monitor.js';

/** 用 post-commit hook 睡 15s 模拟「提交已落盘但进程卡住」:超过 autoCommit 的 10s 超时。 */
function installSlowPostCommitHook(repo: string): void {
  execFileSync('mkdir', ['-p', join(repo, '.git', 'hooks')]);
  writeFileSync(join(repo, '.git', 'hooks', 'post-commit'), '#!/bin/sh\nsleep 15\n', { mode: 0o755 });
}

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'syncx-autocommit-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'probe@local'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'probe'], { cwd: repo });
  return repo;
}

describe('autoCommit 超时探测', () => {
  it('提交实际成功但进程超时:按成功结算,不产生第二条同名提交', () => {
    const repo = initRepo();
    try {
      writeFileSync(join(repo, 'a.txt'), 'first snapshot\n');
      execFileSync('git', ['add', '-A'], { cwd: repo });
      execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: repo });
      installSlowPostCommitHook(repo);

      // post-commit hook 卡 15s > 10s 超时:进程被杀,但提交对象已落盘
      const result = autoCommit(repo, '镜像提交 from DEV-A');
      expect(result.success).toBe(true);
      expect(result.hash).toBe(getLastCommitHash(repo));

      // 只有一笔镜像提交 —— 不再发生「重试又吞一笔」
      const subjects = execFileSync('git', ['log', '--format=%s'], { cwd: repo, encoding: 'utf8' }).trim().split('\n');
      expect(subjects.filter((s) => s === '镜像提交 from DEV-A')).toHaveLength(1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 60_000);

  it('确定性失败(index.lock 残留):仍按失败上报,HEAD 不动', () => {
    const repo = initRepo();
    try {
      writeFileSync(join(repo, 'a.txt'), 'content\n');
      const before = getLastCommitHash(repo);
      writeFileSync(join(repo, '.git', 'index.lock'), '');
      try {
        const result = autoCommit(repo, '镜像提交 from DEV-B');
        expect(result.success).toBe(false);
        expect(result.error).toBeTruthy();
        expect(getLastCommitHash(repo)).toBe(before);
      } finally {
        rmSync(join(repo, '.git', 'index.lock'), { force: true });
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
