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

describe('autoCommit 超时探测', async () => {
  it('提交实际成功但进程超时:按成功结算,不产生第二条同名提交', async () => {
    const repo = initRepo();
    try {
      writeFileSync(join(repo, 'a.txt'), 'first snapshot\n');
      execFileSync('git', ['add', '-A'], { cwd: repo });
      execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: repo });
      installSlowPostCommitHook(repo);
      // 镜像提交要有真实内容:空提交防护会拦下纯 --allow-empty 的提交
      writeFileSync(join(repo, 'a.txt'), 'changed by peer\n');

      // post-commit hook 卡 15s > 10s 超时:进程被杀,但提交对象已落盘
      const result = await autoCommit(repo, '镜像提交 from DEV-A');
      expect(result.success).toBe(true);
      expect(result.hash).toBe(await getLastCommitHash(repo));

      // 只有一笔镜像提交 —— 不再发生「重试又吞一笔」
      const subjects = execFileSync('git', ['log', '--format=%s'], { cwd: repo, encoding: 'utf8' }).trim().split('\n');
      expect(subjects.filter((s) => s === '镜像提交 from DEV-A')).toHaveLength(1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 60_000);

  it('确定性失败(index.lock 残留):仍按失败上报,HEAD 不动', async () => {
    const repo = initRepo();
    try {
      writeFileSync(join(repo, 'a.txt'), 'content\n');
      const before = await getLastCommitHash(repo);
      writeFileSync(join(repo, '.git', 'index.lock'), '');
      try {
        const result = await autoCommit(repo, '镜像提交 from DEV-B');
        expect(result.success).toBe(false);
        expect(result.error).toBeTruthy();
        expect(await getLastCommitHash(repo)).toBe(before);
      } finally {
        rmSync(join(repo, '.git', 'index.lock'), { force: true });
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('范围收敛:只 stage 通知清单文件,用户并发的未提交改动不被吞', async () => {
    const repo = initRepo();
    try {
      writeFileSync(join(repo, 'a.txt'), 'base\n');
      execFileSync('git', ['add', '-A'], { cwd: repo });
      execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: repo });
      // 同步落盘:a.txt 收到对端新内容;同时用户改了 b.txt 还没提交
      writeFileSync(join(repo, 'a.txt'), 'changed by peer\n');
      writeFileSync(join(repo, 'b.txt'), 'user work in progress\n');

      const result = await autoCommit(repo, '镜像提交 from DEV-A', ['a.txt']);
      expect(result.success).toBe(true);

      // a.txt 进了镜像提交;b.txt 完好留在工作树等用户自己提交
      const files = execFileSync('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim().split('\n');
      expect(files).toEqual(['a.txt']);
      expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' })).toContain(' b.txt');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);

  it('回声场景:内容已在 HEAD 落链对齐空提交,用户并发改动不被吞', async () => {
    const repo = initRepo();
    try {
      // base 提交里 a.txt 就是通知宣称的内容 —— 典型回声:对端把本机提交镜像回来
      writeFileSync(join(repo, 'a.txt'), 'already here\n');
      execFileSync('git', ['add', '-A'], { cwd: repo });
      execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: repo });
      const before = await getLastCommitHash(repo);
      // 用户并发改了 b.txt(不在通知清单里)
      writeFileSync(join(repo, 'b.txt'), 'user work in progress\n');

      const result = await autoCommit(repo, '镜像提交 from DEV-A(回声)', ['a.txt']);
      expect(result.success).toBe(true);
      // 空提交落地保持两端提交链对齐(既有契约),消息落在链上
      expect(await getLastCommitHash(repo)).not.toBe(before);
      expect(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: repo, encoding: 'utf8' }).trim())
        .toBe('镜像提交 from DEV-A(回声)');
      // 用户的 b.txt 不被吞
      expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' })).toContain(' b.txt');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);
});
