import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { getUpstreamCommitHash, listRawCommitMessages, rewriteCommitMessages } from '../src/git-monitor.js';
import { stripCoAuthoredBy } from '../src/session-manager.js';
import { SyncSessionManager } from '../src/session-manager.js';
import { loadOrCreateIdentity } from '../src/identity.js';
import { createLogger } from '../src/logger.js';
import { rmDir } from './helpers.js';

/**
 * 未推送提交的 Co-Authored-By 一键剔除(git 历史重写):
 *  - git-monitor 层:区间原始消息读取、上游解析、filter-branch 重写(真 git 真仓库);
 *  - session-manager 层:stripGitCoAuthoredUnpushed 的计数口径、空区间短路、
 *    工作区不干净拒绝、与推送共用的重入闸。
 *
 * 剔除规则必须与 daemon 侧镜像提交的 stripCoAuthoredBy 同一条 —— 这里直接拿它
 * 当期望值算「剔除后应有的消息」,两套实现(纯函数 vs shell 管道)口径一旦分叉就红。
 */

/** 探测本机是否有可用的 git:没有则整组用例优雅 skip(与 git-monitor.test.ts 同一条件)。 */
function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

const HAS_GIT = gitAvailable();

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

/** 某笔提交的原始完整消息(%B,存储原文;带 -z 剥掉格式附加的换行)。 */
function rawMessage(cwd: string, hash: string): string {
  return git(cwd, ['log', '-1', '-z', '--format=%B', hash]).replace(/\0$/, '');
}

/**
 * 建一个「远端 + 克隆」组合:repo 的当前分支自动带着上游(origin/…),
 * `@{upstream}..HEAD` 从此有非空语义。刻意写死仓库级 user.name/email,
 * 不依赖跑测试这台机器的全局 git 身份。
 */
function upstreamRepo(): { base: string; remote: string; repo: string } {
  const base = mkdtempSync(join(tmpdir(), 'syncx-strip-'));
  const remote = join(base, 'remote');
  const repo = join(base, 'repo');
  execFileSync('git', ['init', '-q', remote]);
  git(remote, ['config', 'user.name', 'syncx-test']);
  git(remote, ['config', 'user.email', 'syncx-test@example.com']);
  writeFileSync(join(remote, 'base.txt'), 'base');
  git(remote, ['add', '-A']);
  git(remote, ['commit', '-qm', 'base']);
  execFileSync('git', ['clone', '-q', remote, repo]);
  git(repo, ['config', 'user.name', 'syncx-test']);
  git(repo, ['config', 'user.email', 'syncx-test@example.com']);
  return { base, remote, repo };
}

/** 提交当前全部改动;每个 body 段落是一个 -m(段落间空行分隔,与真实提交信息同构)。 */
function commit(cwd: string, subject: string, ...body: string[]): string {
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-qm', subject, ...body.flatMap((b) => ['-m', b])]);
  return git(cwd, ['rev-parse', 'HEAD']).trim();
}

/** 未推送区间(旧→新)的提交哈希列表。 */
function unpushedOldToNew(cwd: string): string[] {
  return git(cwd, ['rev-list', '--reverse', '@{upstream}..HEAD']).trim().split('\n');
}

/** 用真 manager 装载一个共享目录(路径即上面的 repo),不打扫描心跳之外的东西。 */
function bootWithRepo(repoPath: string): { manager: SyncSessionManager; base: string; configPath: string } {
  const base = mkdtempSync(join(tmpdir(), 'syncx-strip-mgr-'));
  const dir = join(base, 'config');
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, 'config.json');
  const sharedFolders = [{ id: 'main', path: repoPath, devices: [] }];
  writeFileSync(configPath, JSON.stringify({ sharedFolders, knownDevices: [], peers: [] }));
  const manager = new SyncSessionManager(
    {
      identity: loadOrCreateIdentity(dir),
      configPath,
      configDir: dir,
      peerPort: 0,
      logger: createLogger(undefined),
    },
    sharedFolders,
  );
  return { manager, base, configPath };
}

describe('git-monitor:区间原始消息与上游解析', () => {
  it.skipIf(!HAS_GIT)('listRawCommitMessages 逐字节取回 %B 原文(新→旧)', () => {
    const h = upstreamRepo();
    try {
      writeFileSync(join(h.repo, 'a.txt'), 'A');
      commit(h.repo, 'fix: a', 'body line', 'Co-Authored-By: MOSS <m@x>');
      writeFileSync(join(h.repo, 'b.txt'), 'B');
      commit(h.repo, 'fix: b', 'plain body');

      const msgs = listRawCommitMessages(h.repo, '@{upstream}..HEAD');
      expect(msgs).not.toBeNull();
      // git log 新→旧;记录以 NUL 分隔,消息原文含尾部换行
      expect(msgs).toEqual(['fix: b\n\nplain body\n', 'fix: a\n\nbody line\n\nCo-Authored-By: MOSS <m@x>\n']);
    } finally {
      rmDir(h.base);
    }
  });

  it.skipIf(!HAS_GIT)('空区间回 []、非仓库回 null;上游解析同理', () => {
    const h = upstreamRepo();
    const plain = mkdtempSync(join(tmpdir(), 'syncx-strip-plain-'));
    const noUpstream = mkdtempSync(join(tmpdir(), 'syncx-strip-norel-'));
    try {
      git(noUpstream, ['init', '-q']);
      git(noUpstream, ['config', 'user.name', 'syncx-test']);
      git(noUpstream, ['config', 'user.email', 'syncx-test@example.com']);
      writeFileSync(join(noUpstream, 'x.txt'), 'x');
      git(noUpstream, ['add', '-A']);
      git(noUpstream, ['commit', '-qm', 'only']);

      expect(listRawCommitMessages(h.repo, '@{upstream}..HEAD')).toEqual([]);
      expect(listRawCommitMessages(plain, '@{upstream}..HEAD')).toBeNull();
      expect(getUpstreamCommitHash(h.repo)).toBe(git(h.repo, ['rev-parse', '@{upstream}']).trim());
      expect(getUpstreamCommitHash(noUpstream)).toBeNull();
      expect(getUpstreamCommitHash(plain)).toBeNull();
    } finally {
      rmDir(h.base);
      rmDir(plain);
      rmDir(noUpstream);
    }
  });
});

describe('git-monitor:filter-branch 重写', () => {
  it.skipIf(!HAS_GIT)('剔除尾注、其余逐字节保留、作者时间保留、上游不动、留 refs/original 备份', async () => {
    const h = upstreamRepo();
    try {
      writeFileSync(join(h.repo, 'a.txt'), 'A');
      commit(h.repo, 'fix: a', 'body line', 'Co-Authored-By: MOSS <m@x>');
      writeFileSync(join(h.repo, 'b.txt'), 'B');
      commit(h.repo, 'fix: b', 'plain body');
      writeFileSync(join(h.repo, 'c.txt'), 'C');
      commit(h.repo, 'fix: c', 'Co-authored-by: X <x@x>', 'tail');

      const upstreamBefore = git(h.repo, ['rev-parse', '@{upstream}']).trim();
      const hashesOldToNew = unpushedOldToNew(h.repo);
      const preOldToNew = hashesOldToNew.map((hash) => rawMessage(h.repo, hash));
      const datesBefore = hashesOldToNew.map((hash) => git(h.repo, ['log', '-1', '--format=%aI', hash]));

      const r = await rewriteCommitMessages(h.repo, '@{upstream}..HEAD');
      expect(r).toEqual({ ok: true });

      const newHashes = unpushedOldToNew(h.repo);
      expect(newHashes).toHaveLength(preOldToNew.length);
      // 提交全部换了哈希(消息变了),但每笔的期望值 = 纯函数 strip 的结果(尾部换行归一)
      expect(newHashes).not.toEqual(hashesOldToNew);
      for (let i = 0; i < newHashes.length; i++) {
        const after = rawMessage(h.repo, newHashes[i]!);
        // 两侧都归一掉尾部换行再逐字节比:git 存储的消息恒带尾 \n,
        // 无命中时纯函数原样返回它,有命中时纯函数收掉尾巴
        expect(after.replace(/\n+$/, '')).toBe(stripCoAuthoredBy(preOldToNew[i]!).replace(/\n+$/, ''));
      }
      // 作者时间逐笔保留(只有消息走过滤器)
      expect(newHashes.map((hash) => git(h.repo, ['log', '-1', '--format=%aI', hash]))).toEqual(datesBefore);
      // 上游引用原样不动;原链有 refs/original 备份(filter-branch 自带,失败自恢复)
      expect(git(h.repo, ['rev-parse', '@{upstream}']).trim()).toBe(upstreamBefore);
      expect(git(h.repo, ['for-each-ref', 'refs/original']).trim()).not.toBe('');
    } finally {
      rmDir(h.base);
    }
  });

  it.skipIf(!HAS_GIT)('整条消息只有尾注时剔成空提交消息,不中断重写', async () => {
    const h = upstreamRepo();
    try {
      writeFileSync(join(h.repo, 'a.txt'), 'A');
      commit(h.repo, 'fix: a', 'keep me');
      writeFileSync(join(h.repo, 'b.txt'), 'B');
      commit(h.repo, 'Co-Authored-By: ONLY <o@o>');

      const r = await rewriteCommitMessages(h.repo, '@{upstream}..HEAD');
      expect(r).toEqual({ ok: true });

      const newHashes = unpushedOldToNew(h.repo);
      expect(newHashes).toHaveLength(2);
      expect(rawMessage(h.repo, newHashes[0]!).replace(/\n+$/, '')).toBe('fix: a\n\nkeep me');
      expect(rawMessage(h.repo, newHashes[1]!).replace(/\n+$/, '')).toBe('');
    } finally {
      rmDir(h.base);
    }
  });

  it.skipIf(!HAS_GIT)('非仓库目录重写失败,error 透出 stderr 首行', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'syncx-strip-plain-'));
    try {
      const r = await rewriteCommitMessages(plain, '@{upstream}..HEAD');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/not a git repository|不是一个 git 仓库/);
    } finally {
      rmDir(plain);
    }
  });
});

describe('stripGitCoAuthoredUnpushed(端点语义,真 manager + 真仓库)', () => {
  it.skipIf(!HAS_GIT)('计数正确、重写后尾注消失、基线推进并落盘', async () => {
    const h = upstreamRepo();
    try {
      writeFileSync(join(h.repo, 'a.txt'), 'A');
      commit(h.repo, 'fix: a', 'body line', 'Co-Authored-By: MOSS <m@x>');
      writeFileSync(join(h.repo, 'b.txt'), 'B');
      commit(h.repo, 'fix: b', 'plain body');
      writeFileSync(join(h.repo, 'c.txt'), 'C');
      commit(h.repo, 'fix: c', 'Co-authored-by: X <x@x>', 'tail');

      const preOldToNew = unpushedOldToNew(h.repo).map((hash) => rawMessage(h.repo, hash));
      const upstreamBefore = git(h.repo, ['rev-parse', '@{upstream}']).trim();
      const { manager, base, configPath } = bootWithRepo(h.repo);
      try {
        const r = await manager.stripGitCoAuthoredUnpushed('main');
        // 3 笔未推送,其中 2 笔命中剔除规则
        expect(r).toEqual({ ok: true, stripped: 2, rewritten: 3 });

        // 盘上事实:尾注全部消失、其余逐字节保留
        const newHashes = unpushedOldToNew(h.repo);
        for (let i = 0; i < newHashes.length; i++) {
          const after = rawMessage(h.repo, newHashes[i]!);
          // 同上:两侧归一掉 git 恒带的尾 \n,其余必须逐字节相同
          expect(after.replace(/\n+$/, '')).toBe(stripCoAuthoredBy(preOldToNew[i]!).replace(/\n+$/, ''));
        }
        expect(git(h.repo, ['log', '--format=%B', '@{upstream}..HEAD'])).not.toMatch(/co-?authored-by/i);

        // 上游没动,未推送计数不变(重写只改消息);扫描缓存同步到现查值
        expect(git(h.repo, ['rev-parse', '@{upstream}']).trim()).toBe(upstreamBefore);
        expect(manager.folderStates[0]!.gitUnpushedCount).toBe(3);
        // git 基线推进到重写后的 HEAD 并落盘:滞留旧哈希会让下一轮扫描误判广播
        const newHead = git(h.repo, ['rev-parse', 'HEAD']).trim();
        const persisted = JSON.parse(readFileSync(configPath, 'utf8')) as { sharedFolders: Array<{ gitLastCommitHash?: string }> };
        expect(persisted.sharedFolders[0]!.gitLastCommitHash).toBe(newHead);
      } finally {
        manager.close();
        rmDir(base);
      }
    } finally {
      rmDir(h.base);
    }
  });

  it.skipIf(!HAS_GIT)('区间为空:ok 且 0/0,不执行任何重写', async () => {
    const h = upstreamRepo();
    try {
      // 克隆后原地不动:HEAD 与上游一致,未推送区间为空
      const head = git(h.repo, ['rev-parse', 'HEAD']).trim();
      const { manager, base } = bootWithRepo(h.repo);
      try {
        const r = await manager.stripGitCoAuthoredUnpushed('main');
        expect(r).toEqual({ ok: true, stripped: 0, rewritten: 0 });
        // HEAD 纹丝不动,也没有 refs/original 备份(filter-branch 根本没跑)
        expect(git(h.repo, ['rev-parse', 'HEAD']).trim()).toBe(head);
        expect(git(h.repo, ['for-each-ref', 'refs/original']).trim()).toBe('');
      } finally {
        manager.close();
        rmDir(base);
      }
    } finally {
      rmDir(h.base);
    }
  });

  it.skipIf(!HAS_GIT)('工作区有未提交改动:拒绝且历史原样', async () => {
    const h = upstreamRepo();
    try {
      writeFileSync(join(h.repo, 'a.txt'), 'A');
      commit(h.repo, 'fix: a', 'Co-Authored-By: MOSS <m@x>');
      writeFileSync(join(h.repo, 'a.txt'), 'A-modified'); // 未提交改动

      const { manager, base } = bootWithRepo(h.repo);
      try {
        await expect(manager.stripGitCoAuthoredUnpushed('main')).rejects.toThrow('工作区有未提交的变更');
        // 拒绝后历史未被触碰:尾注还在
        expect(rawMessage(h.repo, git(h.repo, ['rev-parse', 'HEAD']).trim())).toMatch(/Co-Authored-By/);
      } finally {
        manager.close();
        rmDir(base);
      }
    } finally {
      rmDir(h.base);
    }
  });

  it.skipIf(!HAS_GIT)('未设置上游 / 不是仓库 / 目录不存在:400 带原因', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'syncx-strip-plain-'));
    const noUpstream = mkdtempSync(join(tmpdir(), 'syncx-strip-norel-'));
    const h = upstreamRepo();
    try {
      git(noUpstream, ['init', '-q']);
      git(noUpstream, ['config', 'user.name', 'syncx-test']);
      git(noUpstream, ['config', 'user.email', 'syncx-test@example.com']);
      writeFileSync(join(noUpstream, 'x.txt'), 'x');
      git(noUpstream, ['add', '-A']);
      git(noUpstream, ['commit', '-qm', 'only']);

      const { manager, base } = bootWithRepo(h.repo);
      try {
        await expect(manager.stripGitCoAuthoredUnpushed('no-such')).rejects.toThrow('共享目录不存在');
        // 目录存在但没有上游:结构性不可用,必须带出原因而不是静默 0/0
        const other = bootWithRepo(noUpstream);
        try {
          await expect(other.manager.stripGitCoAuthoredUnpushed('main')).rejects.toThrow('未设置上游分支');
        } finally {
          other.manager.close();
          rmDir(other.base);
        }
        const plainBoot = bootWithRepo(plain);
        try {
          await expect(plainBoot.manager.stripGitCoAuthoredUnpushed('main')).rejects.toThrow('该目录不是 git 仓库');
        } finally {
          plainBoot.manager.close();
          rmDir(plainBoot.base);
        }
      } finally {
        manager.close();
        rmDir(base);
      }
    } finally {
      rmDir(h.base);
      rmDir(plain);
      rmDir(noUpstream);
    }
  });

  it.skipIf(!HAS_GIT)('重入闸:重写进行中再调剔除/推送都被拒,首个调用照常完成', async () => {
    const h = upstreamRepo();
    try {
      writeFileSync(join(h.repo, 'a.txt'), 'A');
      commit(h.repo, 'fix: a', 'Co-Authored-By: MOSS <m@x>');
      const { manager, base } = bootWithRepo(h.repo);
      try {
        const first = manager.stripGitCoAuthoredUnpushed('main');
        // 首个调用在 await 重写前就把闸置位:并发第二发剔除被拒
        await expect(manager.stripGitCoAuthoredUnpushed('main')).rejects.toThrow('已有提交信息剔除正在进行');
        // 与 git-push 互斥:重写期间推送同样被拒(手感与「已有推送正在进行」一致)
        await expect(manager.pushGitFolder('main')).rejects.toThrow('已有提交信息剔除正在进行');
        const r = await first;
        expect(r).toEqual({ ok: true, stripped: 1, rewritten: 1 });
      } finally {
        manager.close();
        rmDir(base);
      }
    } finally {
      rmDir(h.base);
    }
  });
});
