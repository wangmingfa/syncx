import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { rmDir } from './helpers.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  autoCommit,
  countUnpushedCommits,
  getCommitInfo,
  getCommitParents,
  getLastCommitHash,
  getUncommittedChanges,
  gitPush,
  hasUncommittedChanges,
  isGitRepo,
  listCommitFiles,
  listRecentCommits,
  listUnpushedCommits,
  readFileAt,
  readFileAtHead,
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

  it.skipIf(!HAS_GIT)('collects the subjects of every commit in the batch, oldest first', () => {
    const repo = tempGitRepo();
    try {
      writeFileSync(join(repo, 'a.txt'), 'A');
      const first = commitAll(repo, '第一步:初始化');
      writeFileSync(join(repo, 'b.txt'), 'B');
      const second = commitAll(repo, '第二步:加文件');
      writeFileSync(join(repo, 'c.txt'), 'C');
      const third = commitAll(repo, '第三步:收尾');

      // 一轮扫描攒下多笔:subjects 按旧→新收集,最后一笔就是 commitMessage 的来源。
      // 范围不含 fromHash(与 git 的 first..third 语义一致)
      const info = getCommitInfo(repo, first, third)!;
      expect(info.commitSubjects).toEqual(['第二步:加文件', '第三步:收尾']);
      expect(info.message).toBe('第三步:收尾');

      // 单笔批次:subjects 只有这一笔,不附加任何东西
      const single = getCommitInfo(repo, second, third)!;
      expect(single.commitSubjects).toEqual(['第三步:收尾']);
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

  /**
   * 断点续传的中间态必须留在版本库之外:它现在会躺上一整个传输过程(大文件按分钟计),
   * 而自动提交常在**别的文件**落地时被触发 —— 放任 `git add -A` 就等于把几百 MB 的半截
   * 内容写进历史,还会经 git 提交同步镜像给对端。
   */
  it.skipIf(!HAS_GIT)('leaves syncx 在途中间态 out of the commit, at any depth, while staging real changes', () => {
    const repo = tempGitRepo();
    try {
      writeFileSync(join(repo, 'a.txt'), 'A');
      commitAll(repo, '基线');

      writeFileSync(join(repo, 'big.bin.syncx-tmp'), '半截内容');
      writeFileSync(join(repo, 'big.bin.syncx-partial'), '{"v":1,"bitmap":"gA=="}');
      mkdirSync(join(repo, 'sub'), { recursive: true });
      writeFileSync(join(repo, 'sub', 'nested.bin.syncx-tmp'), '半截内容');
      writeFileSync(join(repo, 'b.txt'), 'B');

      const result = autoCommit(repo, '来自对端的提交信息');
      expect(result.success).toBe(true);
      expect(git(repo, ['ls-files']).trim().split(/\r?\n/).sort()).toEqual(['a.txt', 'b.txt']);

      // 中间态还在盘上(它是续传的载体),只是不被 track
      expect(existsSync(join(repo, 'big.bin.syncx-tmp'))).toBe(true);
      expect(existsSync(join(repo, 'sub', 'nested.bin.syncx-tmp'))).toBe(true);
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

  /**
   * 断点续传让中间态在目标旁边躺上一整个传输过程,而自动提交是**接收别的文件**时触发的:
   * 若工作树里只剩这一对在途文件就判「有变更」,--allow-empty 会为它造一笔空提交并广播出去。
   */
  it.skipIf(!HAS_GIT)('treats a worktree holding only syncx 在途中间态 as clean', () => {
    const repo = tempGitRepo();
    try {
      writeFileSync(join(repo, 'a.txt'), 'A');
      commitAll(repo, '基线');

      writeFileSync(join(repo, 'big.bin.syncx-tmp'), '半截内容');
      writeFileSync(join(repo, 'big.bin.syncx-partial'), '{"v":1,"bitmap":"gA=="}');
      expect(hasUncommittedChanges(repo)).toBe(false);

      // 排除规则不能把闸门糊住:真改动来了必须照样看得见
      writeFileSync(join(repo, 'c.txt'), 'C');
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

describe('uncommitted changes inventory', () => {
  it('classifies modified / added / deleted / untracked entries and excludes scratch files', () => {
    const repo = tempGitRepo();
    writeFileSync(join(repo, 'a.txt'), 'one');
    writeFileSync(join(repo, 'b.txt'), 'two');
    commitAll(repo, 'init');
    // 改动 + 新增(未跟踪)+ 删除 + syncx 在途中间态
    writeFileSync(join(repo, 'a.txt'), 'one changed');
    unlinkSync(join(repo, 'b.txt'));
    writeFileSync(join(repo, 'new.txt'), 'fresh');
    writeFileSync(join(repo, 'a.txt.syncx-tmp'), 'in-flight');
    const out = getUncommittedChanges(repo);
    expect(out).not.toBeNull();
    expect(out!.truncated).toBe(false);
    const byPath = new Map(out!.entries.map((e) => [e.path, e]));
    expect(byPath.get('a.txt')?.status).toBe('modified');
    expect(byPath.get('b.txt')?.status).toBe('deleted');
    expect(byPath.get('new.txt')?.status).toBe('added');
    // 普通文件不带折叠目录标记(拼写钉死:dir 只在整棵未跟踪目录的折叠条上出现)
    expect(byPath.get('new.txt')?.dir).toBeUndefined();
    // 在途中间态是 syncx 自己的残骸,不进清单
    expect(byPath.has('a.txt.syncx-tmp')).toBe(false);
    rmDir(repo);
  });

  it('returns null outside a repo and reports rename with origPath', () => {
    const plain = mkdtempSync(join(tmpdir(), 'syncx-nogit-'));
    expect(getUncommittedChanges(plain)).toBeNull();
    rmDir(plain);

    const repo = tempGitRepo();
    writeFileSync(join(repo, 'old.txt'), 'v');
    commitAll(repo, 'init');
    mkdirSync(join(repo, 'sub'), { recursive: true });
    writeFileSync(join(repo, 'sub', 'old.txt'), 'v');
    unlinkSync(join(repo, 'old.txt'));
    // rename 只有在暂存之后才会被 git status 识别为 R(纯工作区的「删+增」是两条)
    git(repo, ['add', '-A']);
    const out = getUncommittedChanges(repo)!;
    const renamed = out.entries.find((e) => e.status === 'renamed');
    expect(renamed?.origPath).toBe('old.txt');
    expect(renamed?.path).toBe('sub/old.txt');
    rmDir(repo);
  });

  it('collapses a fully-untracked directory into one dir-marked entry without trailing slash', () => {
    const repo = tempGitRepo();
    mkdirSync(join(repo, 'backends'), { recursive: true });
    writeFileSync(join(repo, 'backends', 'tracked.rs'), '// t');
    commitAll(repo, 'init');
    // 整个 native-common/ 都未跟踪:git 折叠成 `?? backends/native-common/` 一条,
    // 端到端必须去尾斜杠并带 dir 标记 —— 尾斜杠原样透传会让前端按 '/' 切段时
    // 切出一个空名字的行(真机「增」徽标孤行的根因)。
    mkdirSync(join(repo, 'backends', 'native-common'), { recursive: true });
    writeFileSync(join(repo, 'backends', 'native-common', 'main.rs'), 'fn main() {}');
    const out = getUncommittedChanges(repo)!;
    expect(out.entries).toHaveLength(1);
    const entry = out.entries[0]!;
    expect(entry.path).toBe('backends/native-common');
    expect(entry.path.endsWith('/')).toBe(false);
    expect(entry.dir).toBe(true);
    expect(entry.status).toBe('added');
    rmDir(repo);
  });

  it('reads the HEAD version of a file for the diff baseline', () => {
    const repo = tempGitRepo();
    writeFileSync(join(repo, 'a.txt'), 'committed');
    commitAll(repo, 'init');
    writeFileSync(join(repo, 'a.txt'), 'dirty');
    writeFileSync(join(repo, 'untracked.txt'), 'never committed');

    const tracked = readFileAtHead(repo, 'a.txt');
    expect(tracked.kind).toBe('bytes');
    if (tracked.kind === 'bytes') expect(tracked.bytes.toString('utf8')).toBe('committed');
    // 新文件不在 HEAD:判 absent,而不是 error(不能谎报「读取失败」)。
    expect(readFileAtHead(repo, 'untracked.txt').kind).toBe('absent');
    rmDir(repo);
  });

  it('reports a corrupt HEAD object as an error, not as absent', () => {
    const repo = tempGitRepo();
    writeFileSync(join(repo, 'a.txt'), 'committed');
    commitAll(repo, 'init');
    // 破坏 a.txt 在 HEAD 里的 loose blob,模拟 .git 对象 zlib 头损坏。
    // git 把 loose object 设成只读(0444),写之前先解除,否则 EACCES。
    const blob = git(repo, ['rev-parse', 'HEAD:a.txt']).trim();
    const objPath = join(repo, '.git', 'objects', blob.slice(0, 2), blob.slice(2));
    chmodSync(objPath, 0o644);
    writeFileSync(objPath, 'GARBAGE_NOT_ZLIB');

    const res = readFileAtHead(repo, 'a.txt');
    // 关键:损坏必须判 error(文件在盘上),不能判 absent(那会谎报「HEAD 没有这个文件」)。
    expect(res.kind).toBe('error');
    if (res.kind === 'error') expect(res.error.length).toBeGreaterThan(0);
    rmDir(repo);
  });
});

describe('recent commit list', () => {
  it.skipIf(!HAS_GIT)('returns null outside a repo and an empty list for a repo without commits', () => {
    const plain = mkdtempSync(join(tmpdir(), 'syncx-norepo-'));
    try {
      expect(listRecentCommits(plain)).toBe(null);
    } finally {
      rmDir(plain);
    }

    const empty = tempGitRepo();
    try {
      // 空仓库让 git log 以 128 退出:这条路径必须由 getLastCommitHash 兜住,
      // 返回 [] 而不是把「还没有提交」当读取失败抛出去
      expect(listRecentCommits(empty)).toEqual([]);
    } finally {
      rmDir(empty);
    }
  });

  it.skipIf(!HAS_GIT)('lists at most 20 commits, newest first, matching git log itself', () => {
    const repo = tempGitRepo();
    try {
      for (let i = 0; i < 25; i += 1) {
        writeFileSync(join(repo, `f${i}.txt`), String(i));
        commitAll(repo, `提交 ${i}`);
      }
      git(repo, ['tag', 'v1']);

      const list = listRecentCommits(repo)!;
      expect(list).toHaveLength(20);

      // 用 git 自己的输出当尺子:顺序与条数都不对着实现里的常量验
      const expected = git(repo, ['log', '-n', '20', '--format=%s']).trim().split(/\r?\n/);
      expect(list.map((c) => c.subject)).toEqual(expected);
      expect(list[0]!.subject).toBe('提交 24');
      expect(list[19]!.subject).toBe('提交 5');

      // 短哈希与完整哈希对得上,作者取仓库级配置,日期是可解析的 ISO
      const fullHead = git(repo, ['rev-parse', 'HEAD']).trim();
      expect(fullHead.startsWith(list[0]!.hash)).toBe(true);
      expect(list[0]!.author).toBe('syncx-test');
      expect(Number.isNaN(new Date(list[0]!.date).getTime())).toBe(false);

      // 最新一条挂 tag 引用;更旧的一条无引用(空串,而不是缺字段)
      expect(list[0]!.refs).toContain('tag: v1');
      expect(list[19]!.refs).toBe('');
    } finally {
      rmDir(repo);
    }
  });

  it.skipIf(!HAS_GIT)('honors a custom limit and keeps multi-line bodies verbatim', () => {
    const repo = tempGitRepo();
    try {
      writeFileSync(join(repo, 'a.txt'), 'A');
      commitAll(repo, '只有主题的一笔');
      writeFileSync(join(repo, 'b.txt'), 'B');
      git(repo, ['add', '-A']);
      execFileSync('git', ['commit', '-qm', '标题行', '-m', '正文第一段', '-m', '正文第二段'], {
        cwd: repo,
        stdio: 'ignore',
      });

      const limited = listRecentCommits(repo, 1)!;
      expect(limited).toHaveLength(1);
      const head = limited[0]!;
      expect(head.subject).toBe('标题行');
      // 正文原样往返:两个 -m 段之间是 git 自己插的空行,首尾不夹多余换行
      expect(head.body).toBe('正文第一段\n\n正文第二段');

      // 没有正文的提交给空串(前端据此决定是否给出「展开」)
      const all = listRecentCommits(repo)!;
      expect(all).toHaveLength(2);
      expect(all[1]!.subject).toBe('只有主题的一笔');
      expect(all[1]!.body).toBe('');
    } finally {
      rmDir(repo);
    }
  });
});

describe('unpushed commits (count / list / push)', () => {
  /** 建一对「工作仓库 + 本地 bare 远程」:push 全程离线,不碰网络也不碰用户凭据。 */
  function tempRepoWithRemote(): { repo: string; remote: string } {
    const remote = mkdtempSync(join(tmpdir(), 'syncx-remote-'));
    execFileSync('git', ['init', '-q', '--bare', remote], { stdio: 'ignore' });
    const repo = tempGitRepo();
    git(repo, ['remote', 'add', 'origin', remote]);
    return { repo, remote };
  }

  it('returns null outside a repo', () => {
    const plain = mkdtempSync(join(tmpdir(), 'syncx-norepo-'));
    try {
      expect(countUnpushedCommits(plain)).toBe(null);
      expect(listUnpushedCommits(plain)).toBe(null);
    } finally {
      rmDir(plain);
    }
  });

  it.skipIf(!HAS_GIT)('returns null for a repo with a remote but no upstream', () => {
    const { repo, remote } = tempRepoWithRemote();
    try {
      writeFileSync(join(repo, 'a.txt'), 'A');
      commitAll(repo, '第一笔');
      // 有远程、有提交,但当前分支没有上游:计数与列表口径 = null(不猜、不 fetch)
      expect(countUnpushedCommits(repo)).toBe(null);
      expect(listUnpushedCommits(repo)).toBe(null);
    } finally {
      rmDir(repo);
      rmDir(remote);
    }
  });

  it.skipIf(!HAS_GIT)('returns null for a plain folder nested inside a repo (no upward walk)', () => {
    const { repo, remote } = tempRepoWithRemote();
    try {
      writeFileSync(join(repo, 'a.txt'), 'A');
      commitAll(repo, '第一笔');
      git(repo, ['push', '-u', '-q', 'origin', 'HEAD']);
      writeFileSync(join(repo, 'b.txt'), 'B');
      commitAll(repo, '第二笔');
      expect(countUnpushedCommits(repo)).toBe(1);

      // 嵌套的 plain 目录自己没有 .git,git 从它出发会向上回溯到外层仓库 ——
      // 计数/列表都必须先过 isGitRepo 闸回 null,而不是把外层仓库的提交算到它头上。
      const nested = join(repo, 'sub');
      mkdirSync(nested);
      expect(isGitRepo(nested)).toBe(false);
      expect(countUnpushedCommits(nested)).toBe(null);
      expect(listUnpushedCommits(nested)).toBe(null);
    } finally {
      rmDir(repo);
      rmDir(remote);
    }
  });

  it.skipIf(!HAS_GIT)('lists unpushed commits newest-first, synced range is an empty list', () => {
    const { repo, remote } = tempRepoWithRemote();
    try {
      writeFileSync(join(repo, 'a.txt'), 'A');
      const first = commitAll(repo, '第一笔');
      git(repo, ['push', '-u', '-q', 'origin', 'HEAD']);

      // 上游已同步:空范围回 [],不是错误(与「没有需要推送」的正常状态对应)
      expect(listUnpushedCommits(repo)).toEqual([]);

      writeFileSync(join(repo, 'b.txt'), 'B');
      const second = commitAll(repo, '第二笔');
      writeFileSync(join(repo, 'c.txt'), 'C');
      const third = commitAll(repo, '第三笔');

      // 新→旧;总数与 rev-list --count 互验(两把独立的尺子)
      const commits = listUnpushedCommits(repo)!;
      expect(commits.map((c) => c.subject)).toEqual(['第三笔', '第二笔']);
      expect(countUnpushedCommits(repo)).toBe(commits.length);
      // 短哈希是全哈希的前缀(解析字段没挪位)
      expect(third.startsWith(commits[0]!.hash)).toBe(true);
      expect(second.startsWith(commits[1]!.hash)).toBe(true);
      // 作者与 ISO 时间字段齐全(与 listRecentCommits 共用解析)
      expect(commits[0]!.author).toBe('syncx-test');
      expect(commits[0]!.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // 负控:列表读取没有碰远程 —— 远程仍停在第一笔
      expect(git(remote, ['rev-parse', 'HEAD']).trim()).toBe(first);
    } finally {
      rmDir(repo);
      rmDir(remote);
    }
  });

  it.skipIf(!HAS_GIT)('caps the list at limit while the count stays exact', () => {
    const { repo, remote } = tempRepoWithRemote();
    try {
      writeFileSync(join(repo, 'a.txt'), 'A');
      commitAll(repo, '第零笔');
      git(repo, ['push', '-u', '-q', 'origin', 'HEAD']);
      for (let i = 1; i <= 6; i++) {
        writeFileSync(join(repo, `f${i}.txt`), String(i));
        commitAll(repo, `第${i}笔`);
      }

      // 6 笔未推送、limit 2:列表截到 2 条(新→旧),count 仍为 6(截断互验)
      const list = listUnpushedCommits(repo, 2)!;
      expect(list).toHaveLength(2);
      expect(list.map((c) => c.subject)).toEqual(['第6笔', '第5笔']);
      expect(countUnpushedCommits(repo)).toBe(6);
      // 默认上限下不截断:6 条全量
      expect(listUnpushedCommits(repo)).toHaveLength(6);
    } finally {
      rmDir(repo);
      rmDir(remote);
    }
  });

  it.skipIf(!HAS_GIT)('counts 0 <-> 1 across push and new commit, matching the remote state', async () => {
    const { repo, remote } = tempRepoWithRemote();
    try {
      writeFileSync(join(repo, 'a.txt'), 'A');
      commitAll(repo, '第一笔');
      git(repo, ['push', '-u', '-q', 'origin', 'HEAD']);

      // 建好上游、且远程已同步:0。负控:远程此刻确有这笔(HEAD 可解析)
      const synced = git(remote, ['rev-parse', 'HEAD']).trim();
      expect(synced).toBe(git(repo, ['rev-parse', 'HEAD']).trim());
      expect(countUnpushedCommits(repo)).toBe(0);

      // 新提交一笔但还没 push:本地 HEAD 往前走,远程没动 —— 计数 1
      writeFileSync(join(repo, 'b.txt'), 'B');
      commitAll(repo, '第二笔');
      expect(git(remote, ['rev-parse', 'HEAD']).trim()).toBe(synced);
      expect(countUnpushedCommits(repo)).toBe(1);

      // push 之后归零,且远程 HEAD 与本地一致(计数与盘上事实同源)
      const r = await gitPush(repo);
      expect(r).toEqual({ ok: true });
      expect(git(remote, ['rev-parse', 'HEAD']).trim()).toBe(git(repo, ['rev-parse', 'HEAD']).trim());
      expect(countUnpushedCommits(repo)).toBe(0);
      expect(listUnpushedCommits(repo)).toEqual([]);
    } finally {
      rmDir(repo);
      rmDir(remote);
    }
  });

  it.skipIf(!HAS_GIT)('reports failure with a git stderr line for no-upstream and non-repo', async () => {
    const { repo, remote } = tempRepoWithRemote();
    try {
      writeFileSync(join(repo, 'a.txt'), 'A');
      commitAll(repo, '第一笔');

      // 无上游:不许 -u 兜底,原样失败(与目录卡口径一致),错误取 stderr 首行
      const noUpstream = await gitPush(repo);
      expect(noUpstream.ok).toBe(false);
      if (!noUpstream.ok) expect(noUpstream.error.length).toBeGreaterThan(0);

      const plain = mkdtempSync(join(tmpdir(), 'syncx-norepo-'));
      try {
        const notRepo = await gitPush(plain);
        expect(notRepo.ok).toBe(false);
        if (!notRepo.ok) expect(notRepo.error.length).toBeGreaterThan(0);
      } finally {
        rmDir(plain);
      }
    } finally {
      rmDir(repo);
      rmDir(remote);
    }
  });
});

describe('commit file list', () => {
  it.skipIf(!HAS_GIT)('lists modified / added / deleted files of a commit', () => {
    const repo = tempGitRepo();
    try {
      writeFileSync(join(repo, 'a.txt'), 'v1');
      writeFileSync(join(repo, 'b.txt'), 'v1');
      const root = commitAll(repo, 'base');
      writeFileSync(join(repo, 'a.txt'), 'v2');
      unlinkSync(join(repo, 'b.txt'));
      writeFileSync(join(repo, 'c.txt'), 'new');
      const second = commitAll(repo, '第二笔');

      const files = listCommitFiles(repo, second);
      expect(files.map((f) => [f.status, f.path]).sort())
        .toEqual([['A', 'c.txt'], ['D', 'b.txt'], ['M', 'a.txt']]);

      // 根提交:没有更早的版本可比,全部文件都是 A
      const rootFiles = listCommitFiles(repo, root);
      expect(rootFiles.map((f) => f.status[0])).toEqual(['A', 'A']);
    } finally {
      rmDir(repo);
    }
  });

  it.skipIf(!HAS_GIT)('pairs old and new paths for a rename (z-format R record)', () => {
    const repo = tempGitRepo();
    try {
      writeFileSync(join(repo, '旧文件.txt'), '内容');
      commitAll(repo, 'init');
      git(repo, ['mv', '旧文件.txt', '改名后.txt']);
      const hash = commitAll(repo, '改名');

      const files = listCommitFiles(repo, hash);
      expect(files).toHaveLength(1);
      expect(files[0]!.status[0]).toBe('R');
      expect(files[0]!.path).toBe('改名后.txt');
      expect(files[0]!.origPath).toBe('旧文件.txt');
    } finally {
      rmDir(repo);
    }
  });

  it.skipIf(!HAS_GIT)('returns an empty list for a clean merge commit', () => {
    const repo = tempGitRepo();
    try {
      writeFileSync(join(repo, 'base.txt'), 'base');
      commitAll(repo, 'base');
      const branch = git(repo, ['symbolic-ref', '--short', 'HEAD']).trim();
      git(repo, ['checkout', '-qb', 'feat']);
      writeFileSync(join(repo, 'feat.txt'), 'feat');
      const featHash = commitAll(repo, 'feat');
      git(repo, ['checkout', '-q', branch]);
      writeFileSync(join(repo, 'main.txt'), 'main');
      commitAll(repo, 'main');
      git(repo, ['merge', '-q', '--no-ff', 'feat', '-m', 'merge']);
      const mergeHash = getLastCommitHash(repo)!;

      // 合并提交各取了一侧的内容:相对**所有**父提交都没有独立变更 → git 输出为空。
      // 空清单是「干净合并」这一事实,不是读取失败。
      expect(listCommitFiles(repo, mergeHash)).toEqual([]);
      const parents = getCommitParents(repo, mergeHash);
      expect(parents).toHaveLength(2);
      expect(parents).toContain(featHash);
    } finally {
      rmDir(repo);
    }
  });

  it.skipIf(!HAS_GIT)('throws for a malformed hash and for an unknown one', () => {
    const repo = tempGitRepo();
    try {
      // 选项样式的输入在形状闸就被拒,到不了 git(git 会把它当选项解析)
      expect(() => listCommitFiles(repo, '--upload-pack=x')).toThrow('非法的提交哈希');
      expect(() => listCommitFiles(repo, '')).toThrow('非法的提交哈希');
      expect(() => listCommitFiles(repo, 'zzzzzzz')).toThrow('非法的提交哈希');
      expect(() => getCommitParents(repo, '--exec')).toThrow('非法的提交哈希');

      // 形状合法但不存在的哈希:git 失败,抛出(带 stderr 首行)
      expect(() => listCommitFiles(repo, 'a'.repeat(40))).toThrow();
      expect(() => getCommitParents(repo, 'a'.repeat(40))).toThrow();
    } finally {
      rmDir(repo);
    }
  });
});

describe('read file at an arbitrary rev', () => {
  it.skipIf(!HAS_GIT)('reads content at a given commit and reports absence in both message forms', () => {
    const repo = tempGitRepo();
    try {
      writeFileSync(join(repo, 'a.txt'), 'v1');
      const first = commitAll(repo, '第一笔');
      writeFileSync(join(repo, 'a.txt'), 'v2');
      writeFileSync(join(repo, 'later.txt'), '后来才有');
      const second = commitAll(repo, '第二笔');

      // 指定提交版本(不只是 HEAD):第一笔里 a.txt 还是 v1
      const atFirst = readFileAt(repo, first, 'a.txt');
      expect(atFirst.kind).toBe('bytes');
      if (atFirst.kind === 'bytes') expect(atFirst.bytes.toString('utf8')).toBe('v1');

      // 缺路径形态一:「后来才有」的文件不在第一笔里
      expect(readFileAt(repo, first, 'later.txt').kind).toBe('absent');
      // 缺路径形态二:git 对「盘上存在但该 rev 没有」的路径(目录)换一套说法
      expect(readFileAt(repo, first, '.').kind).toBe('absent');

      // readFileAtHead 是 HEAD 的薄壳:行为与 readFileAt(repo, 'HEAD', …) 一致
      const head = readFileAtHead(repo, 'a.txt');
      expect(head.kind).toBe('bytes');
      if (head.kind === 'bytes') expect(head.bytes.toString('utf8')).toBe('v2');

      // 未知 rev + 盘上存在的路径:git 换用「exists on disk, but not in」措辞,
      // 落在 absent 判定里 —— 这套口径只服务「提交已验证存在后的路径读取」
      // (manager 先经 rev-list 验提交再读文件),rev 不存在的形态到不了 UI。
      expect(readFileAt(repo, 'a'.repeat(40), 'a.txt').kind).toBe('absent');
    } finally {
      rmDir(repo);
    }
  });

  it.skipIf(!HAS_GIT)('maps commit parents: root → [], normal → [parent]', () => {
    const repo = tempGitRepo();
    try {
      writeFileSync(join(repo, 'a.txt'), '1');
      const root = commitAll(repo, '根');
      writeFileSync(join(repo, 'a.txt'), '2');
      const second = commitAll(repo, '第二笔');

      expect(getCommitParents(repo, root)).toEqual([]);
      expect(getCommitParents(repo, second)).toEqual([root]);
    } finally {
      rmDir(repo);
    }
  });
});
