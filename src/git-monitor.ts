/**
 * Git 仓库感知与自动提交。
 *
 * 职责:
 *  - 检测共享目录是否为 git 仓库
 *  - 读取 HEAD 提交哈希(用于检测新提交)
 *  - 收集提交信息(消息、变更文件列表、diff stat)
 *  - 读取最近提交列表(提交历史弹窗)
 *  - 执行自动提交(git add -A && git commit;syncx 的在途中间态两头都排除);调用方应先用
 *    hasUncommittedChanges 判定有无待提交内容,无变更不必提交
 *
 * 所有 git 命令通过 execFileSync 同步执行(本地仓库操作通常 <100ms),
 * 避免异步引入的竞态条件。失败时抛错,由调用方处理。
 *
 * 每一处 execFileSync 都必须带 `windowsHide: true`,这不是装饰:
 * daemon 被自更新流程 detached 拉起后**自己没有控制台**,而 git.exe 是控制台子系统
 * 程序 —— 不给这个标志,Windows 会为每次调用现开一个控制台窗口。于是每轮扫描的两笔
 * git 调用(读 HEAD + 查工作区状态)就是**两下黑框闪烁**,默认 5s 一轮,现象是
 * 「每隔几秒弹两次、两次之间隔几百毫秒」。从终端手工启动的 daemon 有控制台可继承,
 * 所以不闪 —— 这正是「升级之后才开始闪」的原因。新增调用点时别忘了它。
 */
import { existsSync, statSync, unlinkSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { SCRATCH_SUFFIXES } from './ignore.js';

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
  /**
   * 本批次**所有**提交的 subject(旧→新,含最后一笔)。一轮扫描可能攒下多笔提交,
   * 镜像侧只落一笔;把整批 subject 随通知带过去,接收方在镜像提交的 body 里保留
   * 这批变更的完整脉络(hash 两侧本就不同,消息是唯一可对上的线索)。
   */
  commitSubjects: string[];
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
      windowsHide: true,
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
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      },
    );

    // 解析输出:每个提交由 ---SYNCX-END--- 分隔
    const entries = logOutput.split('---SYNCX-END---').filter((s) => s.trim());
    if (entries.length === 0) return null;

    // 整批提交的 subject,旧→新(git log 输出为新→旧,故倒序收集)。
    // trim 不能省:分隔符之后的 entry 带前导换行,不剥掉取 [2] 会错位到父哈希
    const commitSubjects = entries
      .map((entry) => entry.trim().split('\n')[2]?.trim() ?? '')
      .filter(Boolean)
      .reverse();

    // 取第一个提交(最新的):git log 输出为新→旧,过去取「最后一个 entry」在
    // 批次只有一笔时碰巧正确,一轮攒多笔时取到的会是最旧的一笔(hash、消息、
    // 变更清单全错位)。首个 entry 无前导换行,行号从 0 起算干净。
    const lastEntry = entries[0]!.trim();

    // 取第一个提交(最新的)
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
        windowsHide: true,
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
          windowsHide: true,
          timeout: 5000,
          maxBuffer: 64 * 1024,
        },
      ).trim();
    } catch {
      // stat 获取失败不影响主流程
    }

    return { hash, parentHash, message, fullMessage, changedFiles, diffStat, commitSubjects };
  } catch {
    return null;
  }
}

/** 提交历史弹窗的一行。 */
export interface GitCommitEntry {
  /** 短哈希(7 位左右,展示与复制用)。 */
  hash: string;
  /** 提交消息首行(subject)。 */
  subject: string;
  /** 提交消息正文(不含首行);空串 = 这笔没有正文,前端据此决定是否给出「展开」。 */
  body: string;
  /** 作者名。 */
  author: string;
  /** 作者时间,ISO 8601(git 的 %aI,带时区偏移;前端自己本地化展示)。 */
  date: string;
  /** 引用装饰原样串(git 的 %D,如 `HEAD -> main, tag: v1.0`);无引用为空串。 */
  refs: string;
}

/** 弹窗默认展示的提交条数:20 条足够扫一眼最近动向,再多用户也不会读。 */
export const GIT_LOG_LIMIT = 20;

/**
 * git log 的机器可读记录格式:字段以 0x1f 分隔,记录以 NUL 分隔(配 -z)。
 * 「最近提交」与「未推送提交」两处共用 —— 解析规则(含正文兜底并回)见 listRecentCommits 注释,
 * 格式一旦分叉,两处的解析器就会各自悄悄漂移。
 */
const GIT_LOG_FORMAT = '%h%x1f%an%x1f%aI%x1f%D%x1f%s%x1f%b';

/** NUL 记录 + 0x1f 字段 → GitCommitEntry[];各字段的容错语义见 listRecentCommits 注释。 */
function parseCommitRecords(out: string): GitCommitEntry[] {
  return out
    .split('\0')
    .filter((rec) => rec !== '')
    .map((rec) => {
      const f = rec.split('\x1f');
      return {
        hash: f[0] ?? '',
        author: f[1] ?? '',
        date: f[2] ?? '',
        refs: f[3] ?? '',
        subject: f[4] ?? '',
        // 正文是最后一个字段:消息里混入 \x1f 时并回正文而不是丢内容
        body: f
          .slice(5)
          .join('\x1f')
          .trim(),
      };
    });
}

/**
 * 读取最近 N 条提交(默认 20)。返回 null = 不是 git 仓库,调用方据此隐藏入口。
 *
 * 为什么不用行解析:提交**正文是多行的**,`--format` 逐行读会在正文第二行处错位
 * (getCommitInfo 靠 ---SYNCX-END--- 哨兵绕开这个,是因为正文里理论上可能出现哨兵字符串;
 * 这里用 git 自己保证的手段)。改为 `-z`(记录以 NUL 分隔)+ `%x1f` 字段分隔:
 * 提交对象里不可能出现 NUL(对象格式以 NUL 结尾语义存在),`%x1f` 是用户几乎不可能
 * 敲进消息的 ASCII 单元分隔符;且**正文放在最后一个字段**,即使消息里真混入 `%x1f`,
 * 也只是把多余分隔符并回正文(slice(5).join),不会挪动其它字段。
 *
 * 实测(--no-show-signature / -z / --format 组合,git 2.x):
 *  - 记录以 NUL 结尾,记录之间无附加换行;空仓库 git log 以 128 退出(stderr 为
 *    "does not have any commits yet" 一类),据此回 [] 而不是抛错 —— 空仓库是常态不是故障。
 *  - `%b` 尾部自带换行(如正文两段为 "a\n\nb\n"),读回后 trim。
 *  - 用户配置 log.decorate=full 会把 %D 渲染成 `HEAD -> refs/heads/main`:只是文案更啰嗦,
 *    不破坏解析;`--no-color` 与 `--no-show-signature` 抵御 color.ui=always / log.showSignature
 *    两个会往输出里插入 ANSI 转义或验签信息(混进字段里就是脏数据)的配置。
 */
export function listRecentCommits(folderPath: string, limit = GIT_LOG_LIMIT): GitCommitEntry[] | null {
  if (!isGitRepo(folderPath)) return null;

  let out: string;
  try {
    out = execFileSync('git', ['log', '-n', String(limit), '-z', '--no-color', '--no-show-signature', `--format=${GIT_LOG_FORMAT}`], {
      cwd: folderPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (e) {
    // 空仓库(还没有任何提交)时 git log 退出码 128:是「没有提交」而非「读取失败」,
    // 回空列表让弹窗显示空态。用 rev-parse 复核而不是解析 stderr 文案:
    // stderr 文案随 git 版本/语言(locale)变化,不可靠。
    if (getLastCommitHash(folderPath) === null) return [];
    const stderr =
      e instanceof Error && (e as { stderr?: Buffer | string }).stderr
        ? (e as { stderr?: Buffer | string }).stderr!.toString()
        : '';
    throw new Error(stderr.trim().split('\n')[0] || (e instanceof Error ? e.message : 'git log 读取失败'));
  }

  return parseCommitRecords(out);
}

/* ==================== 提交文件清单(展开某笔提交看改了哪些文件) ==================== */

/** 「提交展开」里的一行:该笔提交动了哪个文件、怎么动的。 */
export interface GitCommitFileEntry {
  /** git name-status 状态字母(M/A/D/R/C/T 等),前端翻成 改/增/删/移/复 胶囊。 */
  status: string;
  /** 提交后的路径(改名/复制时为新路径)。 */
  path: string;
  /** 改名/复制时的原路径(status 为 R/C 开头时存在)。 */
  origPath?: string;
}

/**
 * 提交哈希的形状闸:git 的对象名只可能是 7–40 位十六进制(短/全长 SHA-1)。
 * 从源头挡掉两类输入 —— 以 `-` 开头的字符串会被 git 当成**选项**解析(选项注入),
 * 以及任意把 rev 表达式当哈希传进来的调用方失误。
 */
export function isCommitHash(hash: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(hash);
}

/**
 * 某笔提交动了哪些文件(`git show --format= --name-status -z -M`)。
 * git 失败(提交不存在/对象损坏等)抛 Error(首行 stderr),与 listRecentCommits 同款;
 * 空数组 = 这笔提交没有文件改动(典型:干净的合并提交)。
 *
 * 实测口径(git 2.x,校准脚本验证):
 *  - **必须 -z**:文本模式会把非 ASCII 路径转成 `"\344\270\255..."` 八进制转义,没法用;
 *    -z 下记录为 `status\0path\0` 两段一组,改名/复制是三段一组 `R100\0old\0new\0`。
 *  - 干净的合并提交输出为空且退出码 0(git 合并差异只列与**所有**父提交都不同的文件),
 *    回 [] 不是失败。
 *  - 根提交的全部文件都是 A(没有更早的版本可比)。
 */
export function listCommitFiles(folderPath: string, hash: string): GitCommitFileEntry[] {
  if (!isCommitHash(hash)) throw new Error('非法的提交哈希');

  const out = execFileSync(
    'git',
    ['show', '--format=', '--name-status', '-z', '-M', '--no-color', hash],
    {
      cwd: folderPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );

  const fields = out.split('\0');
  const entries: GitCommitFileEntry[] = [];
  for (let i = 0; i < fields.length; ) {
    const status = fields[i];
    // 尾部:最后一个记录以 \0 结尾,split 后残留一个空串,直接收尾。
    if (status === undefined || status === '') break;
    const path = fields[i + 1] ?? '';
    if (path === '') break;
    // 改名/复制状态带相似度后缀(R100/C75),语义按首字母;-z 三段为
    // `R100\0旧路径\0新路径`(实测旧路径在前):path 取提交后的新路径。
    if (/^[RC]/.test(status)) {
      const origPath = fields[i + 1] ?? '';
      const newPath = fields[i + 2] ?? '';
      if (newPath === '') break;
      entries.push({ status, path: newPath, origPath });
      i += 3;
    } else {
      entries.push({ status, path });
      i += 2;
    }
  }
  return entries;
}

/**
 * 某笔提交的父提交列表(`git rev-list --parents -n 1`)。
 * git 失败(哈希不存在/非仓库等)抛 Error;空数组 = 根提交(没有父)。
 * 合并提交会有两个以上父 —— 「上一版」的语义取**首父**(主干侧),调用方自行决定。
 */
export function getCommitParents(folderPath: string, hash: string): string[] {
  if (!isCommitHash(hash)) throw new Error('非法的提交哈希');

  const out = execFileSync('git', ['rev-list', '--parents', '-n', '1', hash], {
    cwd: folderPath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    timeout: 10_000,
  });
  // 输出形如 `<hash> <parent1> [parent2 ...]`,首段是提交自己。
  const parts = out.trim().split(/\s+/).filter((p) => p !== '');
  return parts.slice(1);
}

/**
 * 把 syncx 的在途中间态从 git 的视野里排除:`<目标>.syncx-tmp`(在途内容)与
 * `<目标>.syncx-partial`(它的块位图 sidecar)。
 *
 * 断点续传之后,这两个文件会在目标文件旁边躺上**一整个传输过程**(大文件按分钟计),
 * 而原先它们只存在于落地的那一瞬间。放任 `git add -A` 把它们收进去,代价是几百 MB 的
 * 半截内容进仓库历史(共享目录本身是 git 仓库时),并经 git 提交同步镜像给对端 —— 那正是
 * 「同步侧的残骸不该进版本库」的边界。后缀取自 ignore.ts 的 SCRATCH_SUFFIXES,两处共用一份
 * 事实,免得将来加第三个后缀时忘了这里。
 *
 * 只给负向 pathspec 不改变其余语义:实测在仓库的**子目录**里执行
 * `git add -A -- ':(exclude)*.syncx-tmp'`,仓库里该子目录**之外**的新文件照样被 stage,
 * 与不带 pathspec 的 `git add -A` 一致(负向 pattern 通配跨 `/`,故任意深度命中)。
 */
const SCRATCH_PATHSPECS = SCRATCH_SUFFIXES.flatMap((suffix) => [`:(exclude)*${suffix}`]);

/**
 * 检查工作区是否有未提交的变更(含未跟踪文件)。
 * 返回 true 表示有变更可以提交。
 */
export function hasUncommittedChanges(folderPath: string): boolean {
  try {
    const status = execFileSync('git', ['status', '--porcelain', '--', ...SCRATCH_PATHSPECS], {
      cwd: folderPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 5000,
    });
    return status.trim().length > 0;
  } catch {
    return false;
  }
}

/** 工作区一条未提交变更(目录卡「Git 改动」徽标与详情弹窗的条目)。 */
export interface GitChangeEntry {
  /** 相对仓库根的路径(POSIX 分隔);git 折叠的未跟踪目录已去尾斜杠,见 dir。 */
  path: string;
  /**
   * true = git 把「整棵未跟踪目录」折叠成的这一条记录(默认 -unormal,如
   * `?? backends/native-common/`)。目录没有 HEAD 版本、也没有单文件可对比,
   * 前端据此不做双击对比;路径已在解析时去掉尾斜杠。
   */
  dir?: boolean;
  /** 变更类别:modified(内容改动)/ added(新增或未跟踪)/ deleted(已删除)/ renamed(重命名)。 */
  status: 'modified' | 'added' | 'deleted' | 'renamed';
  /** renamed 的原路径。 */
  origPath?: string;
  /** 已 staged(git status 第一列非空/非 ?)。用于弹窗里区分「已暂存 / 未暂存」。 */
  staged?: boolean;
}

/** 条目数封顶:弹窗树分批渲染受不了几十万条,node_modules 误跟踪时先保命。 */
export const GIT_CHANGES_MAX = 2000;

/**
 * 盘点工作区的未提交变更(含未跟踪文件;syncx 在途中间态照旧排除)。
 * 返回 null = 不是 git 仓库 / git 不可用,调用方据此不显示徽标。
 *
 * 用 `-z`(NUL 分隔)解析:路径里的空格/引号/Unicode 不会被引号转义坑到;
 * rename 条目跟两个记录(新路径 + 原路径),porcelain 的既有约定。
 * git 把「整棵未跟踪目录」折叠成一条尾部带 '/' 的记录,这里统一去斜杠并打 dir 标记。
 */
export function getUncommittedChanges(folderPath: string): { entries: GitChangeEntry[]; truncated: boolean } | null {
  if (!isGitRepo(folderPath)) return null;
  try {
    const out = execFileSync('git', ['status', '--porcelain', '-z', '--', ...SCRATCH_PATHSPECS], {
      cwd: folderPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const records = out.split('\0').filter((s) => s !== '');
    const entries: GitChangeEntry[] = [];
    for (let i = 0; i < records.length; i++) {
      const rec = records[i]!;
      // 每条记录:XY<空格>path(X=暂存区列,Y=工作区列,?? = 未跟踪)
      const xy = rec.slice(0, 2);
      let path = rec.slice(3);
      if (path === '') continue;
      // 尾斜杠必须在这里去掉:留着的话前端按 '/' 切段建树会切出一个空名字的行。
      const dir = path.endsWith('/');
      if (dir) path = path.slice(0, -1);
      let origPath: string | undefined;
      if (xy.includes('R') || xy.includes('C')) {
        origPath = records[++i];
      }
      // 归类优先级:删除 > 重命名/复制 > 新增 > 修改 —— 一个「先删再加回来」的
      // 条目按删除理解更贴近用户直觉;?? 恒为 added。
      const status: GitChangeEntry['status'] = xy.includes('D')
        ? 'deleted'
        : origPath !== undefined
          ? 'renamed'
          : xy.includes('A') || xy === '??'
            ? 'added'
            : 'modified';
      const entry: GitChangeEntry = { path, status, origPath, staged: xy[0] !== ' ' && xy[0] !== '?' };
      if (dir) entry.dir = true;
      entries.push(entry);
      if (entries.length >= GIT_CHANGES_MAX) {
        return { entries, truncated: true };
      }
    }
    return { entries, truncated: false };
  } catch {
    return null;
  }
}

/**
 * 读取某文件在任意 rev(HEAD 或某个提交哈希)里的字节。
 * relPath 必须是仓库相对路径且不含目录穿越 —— 由调用方(路由层)保证。
 *
 * 三种结果必须分清,不能糊成「取不到」:
 * - bytes:  该 rev 里有这个文件,拿到内容。
 * - absent: 文件确实不在该 rev(新文件 / 根提交里没有的东西)。git 会明确说
 *           "does not exist in '<rev>'";目录形态则是 "exists on disk, but not in
 *           '<rev>'"。两种都是「路径不在那个版本里」,都归 absent。
 * - error:  读取失败(对象损坏 / 超时 / 权限等)。典型是 .git 对象 zlib 头损坏,
 *           git 报 "inflate: data stream error"。这种**不能**谎报成「没有这个文件」,
 *           否则会把人支去查一个不存在的问题(文件明明在盘上)。
 */
export type HeadReadResult =
  | { kind: 'bytes'; bytes: Buffer }
  | { kind: 'absent' }
  | { kind: 'error'; error: string };

export function readFileAt(folderPath: string, rev: string, relPath: string): HeadReadResult {
  try {
    return {
      kind: 'bytes',
      bytes: execFileSync('git', ['show', `${rev}:${relPath}`], {
        cwd: folderPath,
        encoding: 'buffer',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 32 * 1024 * 1024,
      }),
    };
  } catch (e) {
    const stderr =
      e instanceof Error && (e as { stderr?: Buffer | string }).stderr
        ? (e as { stderr?: Buffer | string }).stderr!.toString()
        : '';
    if (/does not exist in|exists on disk, but not in/.test(stderr)) return { kind: 'absent' };
    // 取第一行:多行 inflate 错误里第一行已能说明「读取失败」,整段塞进弹窗太长。
    const firstLine = stderr.trim().split('\n')[0];
    return { kind: 'error', error: firstLine || 'git 读取失败' };
  }
}

/** 读取某文件在 HEAD 提交里的字节(工作区改动的「改前」一侧)。 */
export function readFileAtHead(folderPath: string, relPath: string): HeadReadResult {
  return readFileAt(folderPath, 'HEAD', relPath);
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
 * 使用 --allow-empty 兜底:判定有无变更与 add 之间工作树可能被他程序改回,
 * 保证提交命令本身不因竞态失败。
 */
export function autoCommit(folderPath: string, message: string): AutoCommitResult {
  try {
    // 先 stage 所有变更(含删除、新增),但把 syncx 的在途中间态挡在外面(见 SCRATCH_PATHSPECS)
    execFileSync('git', ['add', '-A', '--', ...SCRATCH_PATHSPECS], {
      cwd: folderPath,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      timeout: 10000,
    });

    // 提交:使用参数数组形式避免 shell 注入
    execFileSync('git', ['commit', '-m', message, '--allow-empty'], {
      cwd: folderPath,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
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

/* ==================== index.lock 残留 ==================== */

/**
 * 仓库 index.lock 的现况。`path` 是 git 自己算出来的实际位置:
 * 普通仓库是 `<root>/.git/index.lock`,linked worktree / submodule 的 gitdir 在别处,
 * 只有 `git rev-parse --git-path` 答得准。
 */
export interface GitIndexLockInfo {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface GitIndexLockRemoveResult {
  ok: boolean;
  path?: string;
  /** false = 调用时锁已不存在(幂等:目的已达成)。 */
  removed?: boolean;
  error?: string;
}

/** 向 git 要 index.lock 的绝对路径(worktree 的 .git 是文件,不能拼 join(folder, '.git')）。 */
function gitIndexLockPath(folderPath: string): string {
  const out = execFileSync('git', ['rev-parse', '--git-path', 'index.lock'], {
    cwd: folderPath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
    timeout: 5000,
  }).trim();
  return resolve(folderPath, out);
}

/** 读 index.lock 的现况;不存在 / 不是仓库 / git 答不上来时返回 null。只读。 */
export function findGitIndexLock(folderPath: string): GitIndexLockInfo | null {
  if (!isGitRepo(folderPath)) return null;
  let lockPath: string;
  try {
    lockPath = gitIndexLockPath(folderPath);
  } catch {
    return null;
  }
  // 路径虽然由 git 给出,仍校验文件名 —— 这个函数只该碰 index.lock
  if (basename(lockPath) !== 'index.lock') return null;
  try {
    const st = statSync(lockPath);
    if (!st.isFile()) return null;
    return { path: lockPath, size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * 删除残留的 index.lock(不接收调用方给的路径,只删 git 指认的那一个)。
 * 调用方负责确认没有其它 git 进程正在操作 —— 本函数无法跨平台判断锁的持有者。
 */
export function removeGitIndexLock(folderPath: string): GitIndexLockRemoveResult {
  if (!isGitRepo(folderPath)) return { ok: false, error: '该目录不是 git 仓库' };
  let lockPath: string;
  try {
    lockPath = gitIndexLockPath(folderPath);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '无法定位 git 锁文件' };
  }
  if (basename(lockPath) !== 'index.lock') {
    return { ok: false, error: 'git 返回的锁路径异常,已中止删除' };
  }
  try {
    unlinkSync(lockPath);
    return { ok: true, path: lockPath, removed: true };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, path: lockPath, removed: false };
    return { ok: false, path: lockPath, error: e instanceof Error ? e.message : '删除锁文件失败' };
  }
}

/* ==================== 推送(未推送计数 + git push) ==================== */

/**
 * 统计当前分支尚未推送的提交数(与本机记录的**上游分支**比较,
 * `git rev-list --count '@{upstream}..HEAD'`)。
 * 返回 null = 不是 git 仓库 / 未设置上游(远程未配置,或从未 push 过) / 读取失败 ——
 * 调用方(目录卡「未推送 N」徽标)据此不挂徽标。
 *
 * 只与本地远程跟踪引用比较,**绝不 fetch**:不产生网络请求、不改动任何引用。
 * 上游是否落后于远端由用户自己的 fetch/push 更新,这是 git 的常规口径。
 */
export function countUnpushedCommits(folderPath: string): number | null {
  // 非仓库直查 .git(与 listRecentCommits 同款):不闸的话,嵌在别的仓库内的 plain 目录
  // 会让 git 向上回溯、数到外层仓库的提交 —— 那与本函数「非仓库回 null」的契约不符。
  if (!isGitRepo(folderPath)) return null;
  try {
    const out = execFileSync('git', ['rev-list', '--count', '@{upstream}..HEAD'], {
      cwd: folderPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 5000,
    });
    const n = Number.parseInt(out.trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** 「推送弹窗」每目录最多列出的提交条数:再长的列表没人读,完整条数由 rev-list --count 一并给出。 */
export const GIT_UNPUSHED_LIMIT = 50;

/**
 * 读取当前分支尚未推送的提交(`@{upstream}..HEAD`,新→旧,最多 limit 条)。
 * 返回 null = **不可列**:不是 git 仓库 / 未设置上游 / 读取失败 —— 调用方(推送弹窗)
 * 据此把该目录整行跳过,与 countUnpushedCommits 的 null 同为「徽标不出现」的口径。
 * 空范围(没有未推送提交)是正常状态,回 [](rev-list/log 对空范围都正常退出)。
 *
 * 必须与 countUnpushedCommits 出入一致地对非仓库先过 isGitRepo 闸:plain 目录嵌在
 * 别的仓库内时 git 会向上回溯,不闸会把外层仓库的提交列进来(scratch 实测踩到过)。
 * 记录解析与 listRecentCommits 完全同构(共用 GIT_LOG_FORMAT/parseCommitRecords)。
 */
export function listUnpushedCommits(folderPath: string, limit = GIT_UNPUSHED_LIMIT): GitCommitEntry[] | null {
  if (!isGitRepo(folderPath)) return null;
  let out: string;
  try {
    out = execFileSync(
      'git',
      ['log', '-n', String(limit), '-z', '--no-color', '--no-show-signature', `--format=${GIT_LOG_FORMAT}`, '@{upstream}..HEAD'],
      {
        cwd: folderPath,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
  } catch {
    // 无上游(rc=128 'fatal: no upstream configured')与读取失败都归「不可列」:
    // 弹窗只负责列出可推送的,列不出来就不进列表,不在这里区分错误种类。
    return null;
  }
  return parseCommitRecords(out);
}

/** 单目录 `git push` 的结果;失败时 error 为 stderr 首行(如 no upstream branch / auth 失败)。 */
export type GitPushResult = { ok: true } | { ok: false; error: string };

/** push 是网络操作,给足超时但必须有封顶:凭据缺失 / 网络黑洞不能让整批「一键推送」挂死。 */
export const GIT_PUSH_TIMEOUT_MS = 120_000;

/**
 * 对目录执行 `git push`:推当前分支到它配置的上游,不带 -u、不 fetch、不改变其余语义。
 *
 * 与本地仓库操作的 execFileSync 不同,**必须异步**:push 要走网络,同步执行会把 daemon
 * 的事件循环整个卡住(同步与接收全停),那不该是一个 UI 按钮的代价。回调式 execFile 包
 * Promise,与 powerguard 的探针同一写法。
 *
 * GIT_TERMINAL_PROMPT=0:daemon 没有控制台,缺凭据时让 git 立刻报错,而不是等一个
 * 永远不会出现的终端输入(干等到超时才失败)。
 */
export function gitPush(folderPath: string, timeoutMs = GIT_PUSH_TIMEOUT_MS): Promise<GitPushResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['push'],
      {
        cwd: folderPath,
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (err, _stdout, stderr) => {
        if (!err) {
          resolve({ ok: true });
          return;
        }
        const firstLine = stderr.toString().trim().split('\n')[0];
        // 超时被杀时 stderr 可能是空的,不能只交个空串;退回错误消息(含命令名)已足够定位
        resolve({
          ok: false,
          error: firstLine || (err.killed ? `超时(>${Math.round(timeoutMs / 1000)}s)` : err.message),
        });
      },
    );
  });
}
