/**
 * Git 仓库感知与自动提交。
 *
 * 职责:
 *  - 检测共享目录是否为 git 仓库
 *  - 读取 HEAD 提交哈希(用于检测新提交)
 *  - 收集提交信息(消息、变更文件列表、diff stat)
 *  - 执行自动提交(git add -A && git commit)
 *
 * 所有 git 命令通过 execFileSync 同步执行(本地仓库操作通常 <100ms),
 * 避免异步引入的竞态条件。失败时抛错,由调用方处理。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export interface CommitInfo {
  /** 新提交的完整哈希 */
  hash: string;
  /** 父提交哈希(用于检测 rebase) */
  parentHash: string;
  /** 提交消息(首行 subject) */
  message: string;
  /** 完整提交消息(含 body) */
  fullMessage: string;
  /** 变更文件列表(相对路径) */
  changedFiles: string[];
  /** diff stat 输出(可选,信息展示用) */
  diffStat?: string;
}

/** 检测目录是否为 git 仓库(.git 存在,可以是目录或文件(worktree)) */
export function isGitRepo(folderPath: string): boolean {
  return existsSync(join(folderPath, '.git'));
}

/** 获取 HEAD 当前的提交哈希;无提交(空仓库)返回 null */
export function getLastCommitHash(folderPath: string): string | null {
  try {
    const hash = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: folderPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    return hash.trim() || null;
  } catch {
    return null;
  }
}

/**
 * 收集两个提交之间的信息。
 * @param fromHash 起始提交(不含)
 * @param toHash 结束提交(含)
 */
export function getCommitInfo(folderPath: string, fromHash: string, toHash: string): CommitInfo | null {
  try {
    // 获取提交消息:首行 subject + body
    const logOutput = execFileSync(
      'git',
      ['log', '--format=%H%n%P%n%s%n%b%n---SYNCX-END---', `${fromHash}..${toHash}`],
      {
        cwd: folderPath,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      },
    );

    // 解析输出:每个提交由 ---SYNCX-END--- 分隔
    const entries = logOutput.split('---SYNCX-END---').filter((s) => s.trim());
    if (entries.length === 0) return null;

    // 取最后一个提交(最新的)
    const lastEntry = entries[entries.length - 1]!.trim();
    const lines = lastEntry.split('\n');
    if (lines.length < 3) return null;

    const hash = lines[0]!.trim();
    const parentHash = lines[1]!.trim().split(/\s+/)[0] || '';
    const message = lines[2]!.trim();
    const fullMessage = lines.slice(2).join('\n').trim();

    // 获取变更文件列表
    const diffNameOnly = execFileSync(
      'git',
      ['diff', '--name-only', `${fromHash}..${toHash}`],
      {
        cwd: folderPath,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      },
    );
    const changedFiles = diffNameOnly.split('\n').filter((s) => s.trim());

    // 获取 diff stat(可选,信息展示用)
    let diffStat: string | undefined;
    try {
      diffStat = execFileSync(
        'git',
        ['diff', '--stat', `${fromHash}..${toHash}`],
        {
          cwd: folderPath,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 5000,
          maxBuffer: 64 * 1024,
        },
      ).trim();
    } catch {
      // stat 获取失败不影响主流程
    }

    return { hash, parentHash, message, fullMessage, changedFiles, diffStat };
  } catch {
    return null;
  }
}

/**
 * 检查工作区是否有未提交的变更(含未跟踪文件)。
 * 返回 true 表示有变更可以提交。
 */
export function hasUncommittedChanges(folderPath: string): boolean {
  try {
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: folderPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    return status.trim().length > 0;
  } catch {
    return false;
  }
}

export interface AutoCommitResult {
  success: boolean;
  /** 新提交的哈希(成功时) */
  hash?: string;
  /** 失败原因(失败时) */
  error?: string;
}

/**
 * 执行自动提交:git add -A && git commit -m <message>。
 * 使用 --allow-empty 确保即使没有变更也能记录提交(保持提交链完整)。
 */
export function autoCommit(folderPath: string, message: string): AutoCommitResult {
  try {
    // 先 stage 所有变更(含删除、新增)
    execFileSync('git', ['add', '-A'], {
      cwd: folderPath,
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 10000,
    });

    // 提交:使用参数数组形式避免 shell 注入
    execFileSync('git', ['commit', '-m', message, '--allow-empty'], {
      cwd: folderPath,
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 10000,
    });

    // 获取新提交哈希
    const hash = getLastCommitHash(folderPath);
    return { success: true, hash: hash ?? undefined };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}
