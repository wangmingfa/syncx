import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageVersion } from './usage.js';

/**
 * 自更新(B 方案,整包替换):
 *
 *   来源 A(P2P):对端把自己的安装目录打成 tgz,经加密控制通道整体传过来;
 *   来源 B(npm):定时查询 registry,用户在 Web UI 确认后直接下载官方 tgz。
 *
 *   两条路径汇入同一条管线:
 *     tgz → 解压到 temp → 结构/版本/实跑校验 → 写入独立 updater 脚本并
 *     detached 拉起 → 本进程优雅关闭 → updater 等旧进程退出 → 把新包拷到
 *     目标目录同卷 → 目录级原子换入(失败回滚) → 拉起新 daemon →
 *     新 daemon 验证存活(立即退出则回滚旧包并拉回)。
 */

/** tgz 大小上界:自包含 bundle ~620KB 压缩后 ~220KB,超界视为脏数据(ws 通道上限 64MB)。 */
const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
/** tgz 大小下界:低于此值几乎必是损坏/截断的传输结果。 */
export const MIN_PACKAGE_BYTES = 16 * 1024;
/** updater 等待旧进程退出的时限(优雅关闭通常 <1s,留大余量)。 */
const OLD_EXIT_WAIT_MS = 120_000;
/** 换入后观察新进程是否立即退出的时长(毫秒),过期视为启动成功。 */
const NEW_ALIVE_VERIFY_MS = 2_500;

/**
 * 本机是否以打包产物(dist/syncx.js 或 npm 全局安装的单文件)运行。
 * 判据:模块自身路径以 .ts/.tsx 结尾 = 源码 dev 态(tsx / vitest 下运行)。
 * esbuild ESM 输出会原样保留 import.meta.url,指向 bundle 文件本身,故可靠。
 */
export function isBundledRuntime(): boolean {
  return !/\.tsx?$/.test(fileURLToPath(import.meta.url));
}

/**
 * 本机运行版本:打包态读 package.json 的真实版本号;
 * dev 态(dev-vite / tsx / 测试)统一显示 'dev',不暴露具体版本号,
 * 同时作为「不可自更新」的标记(源码态没有产物可替换)。
 */
export function runtimeVersion(): string {
  return isBundledRuntime() ? packageVersion() : 'dev';
}

/** 自身单文件产物路径;dev 态(或文件已消失)返回 undefined。 */
export function selfBundlePath(): string | undefined {
  if (!isBundledRuntime()) return undefined;
  const p = fileURLToPath(import.meta.url);
  return existsSync(p) ? p : undefined;
}

/** 当前安装的包目录(= <prefix>/node_modules/@wangmingfa/syncx);dev 态返回 undefined。 */
export function selfPackageDir(): string | undefined {
  const b = selfBundlePath();
  // <pkg>/dist/syncx.js → <pkg>
  return b ? dirname(dirname(b)) : undefined;
}

/** 任意载荷的 sha256 指纹(hex)。发送方随消息携带,接收方落地前重算比对:
 *  GCM 保证「收到的 = 发出的」,指纹把「发出的」与「发送方实际打包的内容」绑定。 */
export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 带 timeout 的 spawn,非零退出/启动失败/超时均 reject。 */
function runProcess(
  exe: string,
  args: readonly string[],
  timeoutMs: number,
  what: string,
  cwd?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args as string[], { stdio: ['ignore', 'ignore', 'pipe'], cwd });
    let stderr = '';
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
      if (stderr.length > 2000) stderr = stderr.slice(0, 2000);
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${what} 超时(${timeoutMs}ms)`));
    }, timeoutMs);
    child.on('error', (e: Error) => {
      clearTimeout(timer);
      reject(new Error(`${what} 失败: ${e.message}`));
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${what} 失败(code ${code}): ${stderr.trim().slice(0, 200)}`));
    });
  });
}

/**
 * tar 调用统一走 cwd + 相对归档名:GNU tar(Git Bash 自带)会把 `-f C:\...`
 * 里的 `C:` 解析成远程主机名,绝对路径归档名在 Windows 下不可靠。
 */

/** 在 cwd 下打包目录为 tgz(args 形如 ['-czf','out.tgz','-C',dir,'.'])。 */
async function tarRun(cwd: string, args: readonly string[]): Promise<void> {
  await runProcess('tar', args, 30_000, 'tar', cwd);
}

/**
 * 打包本机安装目录为 tgz(P2P 升级的发送侧载荷)。
 * dev 态返回 undefined(没有可打包的安装目录)。
 */
export async function packSelfTgz(): Promise<Buffer | undefined> {
  const dir = selfPackageDir();
  if (!dir) return undefined;
  const work = mkdtempSync(join(tmpdir(), 'syncx-selfpack-'));
  try {
    await tarRun(work, ['-czf', 'self.tgz', '-C', dirname(dir), basename(dir)]);
    const st = statSync(join(work, 'self.tgz'));
    if (st.size < MIN_PACKAGE_BYTES || st.size > MAX_PACKAGE_BYTES) return undefined;
    return readFileSync(join(work, 'self.tgz'));
  } catch {
    return undefined;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export interface ExtractOptions {
  /** 校验时使用的 node 可执行文件(测试注入);缺省 process.execPath。 */
  nodeExe?: string;
  /** 是否实跑 `node dist/syncx.js -v` 校验版本(测试可关)。默认 true。 */
  verify?: boolean;
  /** -v 输出捕获超时(毫秒)。 */
  verifyTimeoutMs?: number;
  /** tgz 大小下界(测试注入小包时调低);缺省 MIN_PACKAGE_BYTES。 */
  minBytes?: number;
}

/**
 * 解压 tgz 到临时目录并做四道校验:大小 → 包结构(package.json + dist/syncx.js)
 * → 包名/版本与宣告一致 → 实跑 `node dist/syncx.js -v`,输出必须等于宣告版本
 * (temp 里产物旁边就是新 package.json,-v 输出的就是新包自己的版本)。
 *
 * @returns root:staging 目录(解压出的包根);workDir:本次更新的临时工作目录。
 */
export async function extractAndValidate(
  tgz: Buffer,
  expectedVersion: string,
  opts: ExtractOptions = {},
): Promise<{ root: string; workDir: string }> {
  const minBytes = opts.minBytes ?? MIN_PACKAGE_BYTES;
  if (tgz.length < minBytes) throw new Error(`更新包仅 ${tgz.length} 字节,疑似损坏,已放弃升级`);
  if (tgz.length > MAX_PACKAGE_BYTES) throw new Error(`更新包 ${tgz.length} 字节超出上限,疑似损坏,已放弃升级`);

  const work = mkdtempSync(join(tmpdir(), 'syncx-update-'));
  writeFileSync(join(work, 'pkg.tgz'), tgz);
  mkdirSync(join(work, 'extract'));
  try {
    await tarRun(work, ['-xzf', 'pkg.tgz', '-C', 'extract']);
  } catch (err) {
    rmSync(work, { recursive: true, force: true });
    throw new Error(`tar 解压失败: ${err instanceof Error ? err.message : String(err)}`);
  }

  // npm tgz 顶层是 package/,P2P 打包顶层是包目录名:取唯一顶层目录为包根
  const extractDir = join(work, 'extract');
  const entries = readdirSync(extractDir);
  const top = entries[0];
  const root =
    entries.length === 1 && statSync(join(extractDir, top as string)).isDirectory()
      ? join(extractDir, top as string)
      : extractDir;

  const fail = (msg: string): Error => {
    rmSync(work, { recursive: true, force: true });
    return new Error(msg);
  };

  const pkgPath = join(root, 'package.json');
  if (!existsSync(pkgPath)) throw fail('更新包缺少 package.json,结构异常,已放弃升级');
  let pkg: { name?: unknown; version?: unknown };
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: unknown; version?: unknown };
  } catch {
    throw fail('更新包 package.json 无法解析,已放弃升级');
  }
  if (pkg.name !== '@wangmingfa/syncx' && pkg.name !== 'syncx') {
    throw fail(`更新包包名异常(${String(pkg.name)}),已放弃升级`);
  }
  if (pkg.version !== expectedVersion) {
    throw fail(`更新包版本(${String(pkg.version)})与宣告(${expectedVersion})不一致,已放弃升级`);
  }
  const bundle = join(root, 'dist', 'syncx.js');
  if (!existsSync(bundle)) throw fail('更新包缺少 dist/syncx.js,结构异常,已放弃升级');
  if (statSync(bundle).size < 64) throw fail('更新包产物异常小,疑似损坏,已放弃升级');
  if (readFileSync(bundle).subarray(0, 2).toString('utf8') !== '#!') {
    throw fail('更新包产物缺少 shebang,疑似非 syncx 单文件,已放弃升级');
  }
  if (opts.verify !== false) {
    // 实跑校验:temp 中产物旁边就是新 package.json,-v 输出的就是新包自己的版本
    const printed = await printVersion(opts.nodeExe ?? process.execPath, bundle, opts.verifyTimeoutMs ?? 15_000);
    if (printed !== expectedVersion) {
      rmSync(work, { recursive: true, force: true });
      throw new Error(
        `更新包自校验失败:期望版本 ${expectedVersion},实际输出 ${printed || '(无输出)'},已放弃升级`,
      );
    }
  }
  return { root, workDir: work };
}

/** 用 node 执行 `<file> -v`,返回 stdout(空串 = 启动失败/超时)。 */
function printVersion(nodeExe: string, file: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(nodeExe, [file, '-v'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve('');
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve('');
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out.trim());
    });
  });
}

/** updater 独立脚本源码:写入 temp 后由 detached 子进程执行,与本进程完全解耦。
 *  职责:等旧进程退出 → 新包拷到目标同卷 → 目录级原子换入(失败回滚) →
 *  拉起新 daemon → 观察存活(立即退出则回滚旧包并拉回) → 写结果文件。 */
function updaterSource(): string {
  return [
    "// syncx self-updater(自动生成,勿手改)。用法: node updater.mjs <job.json>",
    "import { cpSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';",
    "import { spawn } from 'node:child_process';",
    "import { dirname, join } from 'node:path';",
    "const job = JSON.parse(readFileSync(process.argv[2], 'utf8'));",
    "const sleep = (ms) => new Promise((r) => setTimeout(r, ms));",
    "const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };",
    "const swap = async (from, to) => {",
    "  for (let i = 0; i < 25; i++) {",
    "    try { renameSync(from, to); return; } catch (e) {",
    "      if (i === 24) throw e;",
    "      await sleep(400); // Windows: 防病毒/索引器短暂持锁,退避重试",
    "    }",
    "  }",
    "};",
    "(async () => {",
    "  const done = (result) => writeFileSync(job.doneFile, JSON.stringify(result));",
    "  const backup = join(dirname(job.targetDir), '.syncx-update-backup');",
    "  const local = join(dirname(job.targetDir), '.syncx-update-staging');",
    "  let swapped = false;",
    "  try {",
    "    const deadline = Date.now() + job.waitMs;",
    "    while (alive(job.pid) && Date.now() < deadline) await sleep(300);",
    "    if (alive(job.pid)) throw new Error('旧进程未在时限内退出,放弃替换');",
    "    // 先把新包拷到目标目录同卷(跨卷 rename 会 EXDEV),再目录级换入",
    "    rmSync(local, { recursive: true, force: true });",
    "    cpSync(job.stagingDir, local, { recursive: true });",
    "    rmSync(backup, { recursive: true, force: true });",
    "    await swap(job.targetDir, backup);",
    "    swapped = true;",
    "    try { await swap(local, job.targetDir); } catch (e) {",
    "      await swap(backup, job.targetDir); // 换入失败立即还原旧包",
    "      swapped = false;",
    "      throw e;",
    "    }",
    "    // 拉起新 daemon(env 带结果文件路径,新进程启动后上报升级结果)",
    "    const child = spawn(job.execPath, job.restartArgs, {",
    "      detached: true, stdio: 'ignore',",
    "      env: { ...process.env, SYNCX_UPDATE_DONE: job.doneFile },",
    "    });",
    "    child.unref();",
    "    await sleep(job.verifyMs);",
    "    if (!alive(child.pid)) throw new Error('新进程启动后立即退出');",
    "    rmSync(backup, { recursive: true, force: true });",
    "    done({ ok: true, pid: child.pid, version: job.version });",
    "  } catch (err) {",
    "    const message = String((err && err.message) || err);",
    "    // 回滚:换入已发生但新进程没活下来 → 还原旧包并拉回旧 daemon",
    "    if (swapped) {",
    "      try {",
    "        rmSync(job.targetDir, { recursive: true, force: true });",
    "        await swap(backup, job.targetDir);",
    "        const old = spawn(job.execPath, job.restartArgs, { detached: true, stdio: 'ignore', env: { ...process.env, SYNCX_UPDATE_DONE: job.doneFile } });",
    "        old.unref();",
    "        done({ ok: false, rolledBack: true, error: message });",
    "        process.exit(1);",
    "      } catch { /* 回滚也失败:现状保留,结果文件如实记录 */ }",
    "    }",
    "    done({ ok: false, error: message });",
    "    process.exit(1);",
    "  } finally {",
    "    // 清理解压现场;doneFile 保留给新 daemon 读取(temp 由系统定期清理)",
    "    try { rmSync(join(job.workDir, 'extract'), { recursive: true, force: true }); } catch {}",
    "    try { rmSync(join(job.workDir, 'pkg.tgz'), { force: true }); } catch {}",
    "    try { rmSync(join(job.workDir, 'job.json'), { force: true }); } catch {}",
    "  }",
    "})();",
  ].join('\n');
}

export interface SelfUpdateRunOptions {
  /** 替换目标目录(测试注入);缺省为当前安装目录。 */
  targetDir?: string;
  /** 校验与 updater 使用的 node 可执行文件(测试注入);缺省 process.execPath。 */
  nodeExe?: string;
  /** updater 等待退出的旧进程 pid(测试注入);缺省 process.pid。 */
  oldPid?: number;
  /** 新 daemon 启动参数(测试注入);缺省 process.argv.slice(1)。 */
  restartArgs?: readonly string[];
  /** 旧进程退出等待时限(测试注入调小)。 */
  waitMs?: number;
  /** 新进程存活观察时长(测试注入调小)。 */
  verifyMs?: number;
  /** 跳过 tgz 内的实跑版本校验(测试用)。 */
  verify?: boolean;
  /** tgz 大小下界(测试注入)。 */
  minBytes?: number;
}

/**
 * 自更新主入口:校验 tgz → 写 updater 并 detached 拉起 → 立即返回。
 * 调用方(API 路由)响应完 HTTP 后触发优雅关闭;updater 检测到旧进程
 * 退出后完成换入与新 daemon 拉起。不阻塞当前请求,也不自行退出。
 *
 * @returns version:目标版本;doneFile:updater 结果文件路径(升级完成后写入
 *   {ok, version|rolledBack, error}),供测试轮询与新 daemon 启动后上报。
 */
export async function runSelfUpdate(
  tgz: Buffer,
  expectedVersion: string,
  opts: SelfUpdateRunOptions = {},
): Promise<{ version: string; doneFile: string }> {
  const { root: staging, workDir } = await extractAndValidate(tgz, expectedVersion, opts);
  const targetDir = opts.targetDir ?? selfPackageDir();
  if (!targetDir) throw new Error('无法定位当前安装目录,已放弃升级');

  const doneFile = join(workDir, 'update-done.json');
  const updaterFile = join(workDir, 'updater.mjs');
  const jobFile = join(workDir, 'job.json');
  const job = {
    pid: opts.oldPid ?? process.pid,
    targetDir,
    stagingDir: staging,
    execPath: opts.nodeExe ?? process.execPath,
    restartArgs: [...(opts.restartArgs ?? process.argv.slice(1))],
    doneFile,
    waitMs: opts.waitMs ?? OLD_EXIT_WAIT_MS,
    verifyMs: opts.verifyMs ?? NEW_ALIVE_VERIFY_MS,
    version: expectedVersion,
    workDir,
  };
  writeFileSync(jobFile, JSON.stringify(job));
  writeFileSync(updaterFile, updaterSource());

  const child = spawn(job.execPath, [updaterFile, jobFile], { detached: true, stdio: 'ignore' });
  child.unref();
  return { version: expectedVersion, doneFile };
}

/** 新 daemon 启动数秒后读取 updater 写下的结果文件并记日志(用后即删)。
 *  updater 在观察期(默认 2.5s)结束后才写结果,故由调用方延时调用。 */
export function consumeUpdateDoneFile(
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
  donePath?: string,
): void {
  const p = donePath ?? process.env.SYNCX_UPDATE_DONE;
  if (!p || !existsSync(p)) return;
  try {
    const result = JSON.parse(readFileSync(p, 'utf8')) as {
      ok?: boolean;
      version?: string;
      rolledBack?: boolean;
      error?: string;
    };
    if (result.ok) logger.info(`self-update 完成:已升级到 ${result.version ?? '(未知版本)'} 并重启`);
    else if (result.rolledBack) logger.warn(`self-update 失败已回滚到旧版本: ${result.error ?? '(未知原因)'}`);
    else logger.warn(`self-update 异常结束: ${result.error ?? '(未知原因)'}`);
  } catch {
    // 结果文件读不出来就算了,不影响启动
  } finally {
    try {
      unlinkSync(p);
    } catch {
      // 删不掉也无妨,在 temp 里会被系统清理
    }
  }
}
