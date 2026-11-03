import { spawn } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isBundledRuntime, looksLikeSourceCheckout, selfPackageDir } from './selfupdate.js';

/**
 * 跨后端换入(backend swap):
 *
 *   Web UI 拖入 `pack:local --backend rust/moonbit` 产出的安装包
 *   (syncx-rs-v{version}-{target}.tar.gz / syncx-mbt-v*-{target}.tar.gz,
 *   顶层目录内含 syncx-rs / syncx-mb 单二进制),把当前 Node daemon 换成包里的后端。
 *
 *   与 npm tgz 的「整包替换安装目录」不同,这里不动安装目录:
 *     解包校验 → 二进制装进 <configDir>/bin/ → detached swapper 等旧进程退出 →
 *     拉起新二进制(原样透传 --config-dir/--port 等启动参数)→ 轮询 /health 健康标记 →
 *     超时未健康则杀掉新进程并按「备份的运行方式」拉回原 node 进程(回滚)。
 *
 *   三后端共享同一数据目录与同一套启动参数面(ADR-0026),因此换入不需要改配置。
 */

/** 已知原生目标三元组(与 pack-local.mjs / 各 release workflow 的矩阵对齐)。 */
export const KNOWN_TARGET_TRIPLES = [
  'x86_64-unknown-linux-gnu',
  'aarch64-unknown-linux-gnu',
  'x86_64-apple-darwin',
  'aarch64-apple-darwin',
  'x86_64-pc-windows-msvc',
  'aarch64-pc-windows-msvc',
] as const;

/** 后端安装包大小下界:单二进制再小也是 MB 级,低于此值视为损坏(测试可注入调小)。 */
export const MIN_BACKEND_PACKAGE_BYTES = 4096;
/** 上界与 npm 自更新管线同口径:防脏数据撑爆临时目录。 */
const MAX_BACKEND_PACKAGE_BYTES = 128 * 1024 * 1024;
/** swapper 等待旧进程退出的时限(与 updater 同口径)。 */
const OLD_EXIT_WAIT_MS = 120_000;
/** 换入后等待新后端通过 /health 健康检查的时限。 */
const HEALTH_TIMEOUT_MS = 20_000;
/** 控制端口缺省值(与 cli.ts 的缺省一致)。 */
export const DEFAULT_CONTROL_PORT = 8384;

export type BackendKind = 'rust' | 'moonbit';
/** 上传包的三种身份:Node npm tgz / Rust 后端包 / MoonBit 后端包。 */
export type UploadedBackend = 'node' | BackendKind;

export interface BackendStageInfo {
  backend: BackendKind;
  version: string;
  target: string;
}

export interface BackendPackage extends BackendStageInfo {
  /** 解包出的顶层目录(含二进制,调用方负责清理 workDir)。 */
  root: string;
  /** 本次解包的临时工作目录。 */
  workDir: string;
  /** 包内二进制的绝对路径。 */
  binaryPath: string;
}

/** dev/源码运行态下拒绝跨后端换入的指引文案(与路由层文案同义,面向 CLI 日志)。 */
export const DEV_SWAP_REJECT_MESSAGE =
  '当前 daemon 以源码 dev 态运行(tsx watch / 源码仓库里的 node dist),不支持跨后端换入。' +
  '请先 npm run build 打出 dist/syncx.js,并在独立目录以打包形态启动 daemon 后,再上传后端安装包。';

/**
 * 解析资产顶层目录名:`syncx-rs-v<version>-<target>` / `syncx-mbt-v<version>-<target>`。
 * 版本可带 semver 预发布横杠,与 target 的横杠无法从中间切开 —— 按已知三元组从尾部截取,
 * 余下部分作版本号再做 semver 校验,两头都验不上才算不认识。
 */
export function parseBackendStageName(name: string): BackendStageInfo | null {
  const m = /^syncx-(rs|mbt)-v(.+)$/.exec(name);
  if (!m) return null;
  const rest = m[2]!;
  for (const triple of KNOWN_TARGET_TRIPLES) {
    if (!rest.endsWith(`-${triple}`)) continue;
    const version = rest.slice(0, rest.length - triple.length - 1);
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) return null;
    return { backend: m[1] === 'rs' ? 'rust' : 'moonbit', version, target: triple };
  }
  return null;
}

/** 本机目标三元组(与 scripts/pack-local.mjs 的 detectTargetTriple 同一口径)。 */
export function localTargetTriple(): string {
  const plat = process.platform;
  const arch = process.arch;
  if (plat === 'darwin') return arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  if (plat === 'win32') return arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  if (plat === 'linux') return arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu';
  return `${arch}-${plat}`;
}

/** 后端包内(与安装后)的二进制文件名:syncx-rs / syncx-mb,Windows 加 .exe。 */
export function backendBinaryName(backend: BackendKind): string {
  const base = backend === 'rust' ? 'syncx-rs' : 'syncx-mb';
  return process.platform === 'win32' ? `${base}.exe` : base;
}

/** 识别载荷格式:gzip(tar.gz)/ zip(Windows 资产)/ 其它。 */
export function detectArchiveType(data: Buffer): 'gzip' | 'zip' | 'unknown' {
  if (data.length >= 4 && data[0] === 0x1f && data[1] === 0x8b) return 'gzip';
  if (data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04) return 'zip';
  return 'unknown';
}

/** tar 子进程封装:非零退出/启动失败/超时均 reject(与 selfupdate.ts 的 runProcess 同口径)。 */
function runTar(cwd: string, args: readonly string[], timeoutMs: number, what: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', [...args], { stdio: ['ignore', 'pipe', 'pipe'], cwd });
    let out = '';
    let stderr = '';
    child.stdout?.on('data', (c: Buffer) => {
      out += c.toString('utf8');
    });
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
      if (code === 0) resolve(out);
      else reject(new Error(`${what} 失败(code ${code}): ${stderr.trim().slice(0, 200)}`));
    });
  });
}

/**
 * 嗅探安装包是不是后端二进制包:tar -t 列出归档首条目,取顶层目录名解析。
 * 只列目录不解压,成本可忽略;npm tgz(顶层 package/)返回 null,交由既有 Node 管线处理。
 * Windows 资产是 .zip,直接抛错给出明确指引(而不是让后续 tar 报一堆莫名的错)。
 */
export async function sniffBackendPackage(tgz: Buffer): Promise<BackendStageInfo | null> {
  if (detectArchiveType(tgz) === 'zip') {
    throw new Error('收到 .zip 安装包:Windows 目标的包暂不支持换入,请在目标平台打 tar.gz 资产(pack:local --backend 在 Windows 之外的平台产物)');
  }
  if (detectArchiveType(tgz) !== 'gzip') return null;
  const work = mkdtempSync(join(tmpdir(), 'syncx-sniff-'));
  try {
    writeFileSync(join(work, 'pkg.tgz'), tgz);
    const listing = await runTar(work, ['-tzf', 'pkg.tgz'], 30_000, 'tar -t');
    for (const raw of listing.split('\n')) {
      // `tar -C dir .` 打出来的条目带 ./ 前缀,先剥掉再取顶层名
      const rel = raw.trim().replace(/^\.\//, '');
      const first = rel.split('/')[0]!;
      if (!first || first === '.') continue;
      return parseBackendStageName(first.replace(/\/$/, ''));
    }
    return null;
  } catch (err) {
    // 列不出来(损坏/截断)不是「非后端包」:让上层如实报错,而不是悄悄走 Node 管线
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * 解包并校验后端安装包:结构(顶层目录名可解析 + 二进制存在且不小)+ 目标平台匹配。
 * 只读不改数据目录;workDir 由调用方清理(成功换入时由 swapper 的 finally 清)。
 */
export async function extractBackendPackage(
  tgz: Buffer,
  opts: { minBytes?: number; expectTarget?: string } = {},
): Promise<BackendPackage> {
  const minBytes = opts.minBytes ?? MIN_BACKEND_PACKAGE_BYTES;
  if (tgz.length < minBytes) throw new Error(`安装包仅 ${tgz.length} 字节,疑似损坏,已放弃换入`);
  if (tgz.length > MAX_BACKEND_PACKAGE_BYTES) throw new Error(`安装包 ${tgz.length} 字节超出上限,疑似损坏,已放弃换入`);

  const work = mkdtempSync(join(tmpdir(), 'syncx-backend-swap-'));
  const fail = (msg: string): Error => {
    rmSync(work, { recursive: true, force: true });
    return new Error(msg);
  };
  mkdirSync(join(work, 'extract'));
  writeFileSync(join(work, 'pkg.tgz'), tgz);
  try {
    await runTar(work, ['-xzf', 'pkg.tgz', '-C', 'extract'], 60_000, 'tar 解压');
  } catch (err) {
    throw fail(`tar 解压失败: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 顶层必须是唯一的资产目录(与 GitHub Release 资产结构一致)
  const extractDir = join(work, 'extract');
  const entries = readdirSync(extractDir);
  const top = entries[0];
  if (entries.length !== 1 || !top || !statSync(join(extractDir, top)).isDirectory()) {
    throw fail('后端安装包结构异常(顶层应为唯一资产目录),已放弃换入');
  }
  const stage = parseBackendStageName(top);
  if (!stage) throw fail(`无法识别的安装包资产目录名(${top}),不是 syncx 后端安装包`);
  if (opts.expectTarget !== undefined && stage.target !== opts.expectTarget) {
    throw fail(`安装包目标平台(${stage.target})与本机(${opts.expectTarget})不符,请上传本机平台的资产`);
  }
  const binName = backendBinaryName(stage.backend);
  const binaryPath = join(extractDir, top, binName);
  if (!existsSync(binaryPath)) throw fail(`后端安装包缺少二进制(${binName}),结构异常,已放弃换入`);
  if (statSync(binaryPath).size < 1024) throw fail('后端二进制异常小,疑似损坏,已放弃换入');
  return { ...stage, root: join(extractDir, top), workDir: work, binaryPath };
}

export interface SwapDecisionInput {
  /** 上传包的身份(嗅探结果):node npm tgz 或 rust/moonbit 后端包。 */
  packageBackend: UploadedBackend;
  /** 当前 Node daemon 是否「可被换走」的运行形态:打包产物且不在源码仓库里跑。 */
  runningBundled: boolean;
  /** 后端包的目标三元组(node 包为 undefined)。 */
  packageTarget?: string;
  /** 本机三元组(缺省 localTargetTriple())。 */
  localTriple?: string;
}

export type SwapDecision =
  | { action: 'node-update' }
  | { action: 'backend-swap'; backend: BackendKind }
  | { action: 'reject'; reason: string };

/**
 * 换入决策(纯逻辑,便于测试):决定上传包走哪条管线、或在何种情况下拒绝。
 * dev 态(tsx watch)与「源码仓库里跑 node dist」都算不可换走 —— 前者没有可运行
 * 的产物链,后者换走后源码目录的调试工作流会被打断,且拿不回来同样的启动方式。
 */
export function decideSwapAction(input: SwapDecisionInput): SwapDecision {
  if (input.packageBackend === 'node') {
    if (!input.runningBundled) {
      return { action: 'reject', reason: '本机为 dev 运行态,不支持自更新(请以打包形态运行后再升级)' };
    }
    return { action: 'node-update' };
  }
  if (!input.runningBundled) return { action: 'reject', reason: DEV_SWAP_REJECT_MESSAGE };
  const triple = input.localTriple ?? localTargetTriple();
  if (input.packageTarget !== undefined && input.packageTarget !== triple) {
    return {
      action: 'reject',
      reason: `安装包目标平台(${input.packageTarget})与本机(${triple})不符,请上传本机平台的资产`,
    };
  }
  return { action: 'backend-swap', backend: input.packageBackend };
}

/** 当前进程是否「可被换走」:打包产物运行,且安装目录不是源码仓库(与 npm 管线护栏同判据)。 */
export function isSwappableRuntime(): boolean {
  if (!isBundledRuntime()) return false;
  const pkgDir = selfPackageDir();
  return !!pkgDir && !looksLikeSourceCheckout(pkgDir);
}

/** 从启动参数里取控制端口(args.ts 只认 `--control-port <value>` 空格形式)。 */
export function controlPortFromArgs(args: readonly string[], fallback = DEFAULT_CONTROL_PORT): number {
  const idx = args.indexOf('--control-port');
  const raw = idx >= 0 ? args[idx + 1] : undefined;
  const n = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** swapper 独立脚本源码:等旧进程退出 → 拉起新二进制 → 健康标记轮询 → 超时回滚。 */
function swapperSource(): string {
  return [
    '// syncx backend swapper(自动生成,勿手改)。用法: node swapper.mjs <job.json>',
    "import { openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';",
    "import { spawn } from 'node:child_process';",
    "import { join } from 'node:path';",
    "const job = JSON.parse(readFileSync(process.argv[2], 'utf8'));",
    "const sleep = (ms) => new Promise((r) => setTimeout(r, ms));",
    "const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };",
    // 与 updater 同款:新进程的 stdout/stderr 落到 --log-file,启动期错误不至于进黑洞
    "const daemonStdio = () => {",
    "  if (!job.logFile) return 'ignore';",
    "  try { const fd = openSync(job.logFile, 'a'); return ['ignore', fd, fd]; } catch { return 'ignore'; }",
    "};",
    "const spawnDetached = (exe, args) => {",
    "  const c = spawn(exe, args, { detached: true, stdio: daemonStdio(), windowsHide: true,",
    "    env: { ...process.env, SYNCX_UPDATE_DONE: job.doneFile } });",
    "  c.unref();",
    "  return c;",
    "};",
    "const done = (result) => writeFileSync(job.doneFile, JSON.stringify(result));",
    "(async () => {",
    "  let child;",
    "  try {",
    "    const deadline = Date.now() + job.waitMs;",
    "    while (alive(job.pid) && Date.now() < deadline) await sleep(300);",
    "    if (alive(job.pid)) throw new Error('旧进程未在时限内退出,放弃换入');",
    // 拉起新后端:透传原 --config-dir/--port 等全部启动参数,三后端参数面对齐(ADR-0026)
    "    child = spawnDetached(job.binPath, job.daemonArgs);",
    // 健康标记:轮询本机控制端口的 /health(免认证探活),超时即视为换入失败
    "    const healthDeadline = Date.now() + job.healthTimeoutMs;",
    "    let healthy = false;",
    "    while (Date.now() < healthDeadline) {",
    "      if (!alive(child.pid)) throw new Error('新后端进程启动后立即退出');",
    "      try {",
    "        const res = await fetch(`http://127.0.0.1:${job.controlPort}/health`, { signal: AbortSignal.timeout(2000) });",
    "        if (res.ok) { healthy = true; break; }",
    "      } catch { /* 尚未就绪,继续等 */ }",
    "      await sleep(300);",
    "    }",
    "    if (!healthy) throw new Error(`新后端在 ${job.healthTimeoutMs}ms 内未通过健康检查(/health)`);",
    "    done({ ok: true, pid: child.pid, backend: job.backend, version: job.version });",
    "  } catch (err) {",
    "    const message = String((err && err.message) || err);",
    "    try { if (child && child.pid && alive(child.pid)) child.kill('SIGKILL'); } catch {}",
    "    try {",
    // 回滚:按备份的运行方式(nodeExe + 原启动参数)拉回原 Node daemon,端口与配置不变
    "      spawnDetached(job.nodeExe, job.restartArgs);",
    "      done({ ok: false, rolledBack: true, error: message, backend: job.backend, version: job.version });",
    "    } catch (e2) {",
    "      done({ ok: false, rolledBack: false, error: message + ';回滚拉起失败: ' + String((e2 && e2.message) || e2) });",
    "    }",
    "    process.exit(1);",
    "  } finally {",
    "    try { rmSync(join(job.workDir, 'extract'), { recursive: true, force: true }); } catch {}",
    "    try { rmSync(join(job.workDir, 'pkg.tgz'), { force: true }); } catch {}",
    "  }",
    "})();",
  ].join('\n');
}

export interface BackendSwapOptions {
  /** 数据目录:二进制装到 <configDir>/bin(与索引/配置同目录,便于三后端共用)。 */
  configDir: string;
  /** 健康检查端口;缺省从启动参数解析,再缺省 8384。 */
  controlPort?: number;
  /** 等待退出的旧进程 pid(测试注入);缺省 process.pid。 */
  oldPid?: number;
  /** 回滚时拉回原 Node 进程的完整命令(node <这些参数>);缺省 process.argv.slice(1)。 */
  restartArgs?: readonly string[];
  /** 新后端的启动参数(不含二进制路径);缺省 process.argv.slice(2)(start --config …)。 */
  daemonArgs?: readonly string[];
  /** 回滚用的 node 可执行文件;缺省 process.execPath。 */
  nodeExe?: string;
  /** 旧进程退出等待时限(测试注入调小)。 */
  waitMs?: number;
  /** 新后端健康检查时限(测试注入调小)。 */
  healthTimeoutMs?: number;
  /** tgz 大小下界(测试注入)。 */
  minBytes?: number;
  /** 期望的目标平台(测试注入);缺省本机三元组。 */
  expectTarget?: string;
  /** 二进制安装目录(测试注入);缺省 <configDir>/bin。 */
  installDir?: string;
  /** 跳过「运行形态可换走」判定(仅供测试在 dev 态下跑通换入冒烟;生产恒不传)。 */
  allowDevRuntime?: boolean;
}

/**
 * 跨后端换入主入口:校验安装包 → 二进制装进数据目录 → 写 swapper 并 detached 拉起
 * → 立即返回。调用方(API 路由)响应完 HTTP 后触发优雅关闭;swapper 检测到旧进程
 * 退出后拉起新后端并做健康检查,超时未健康自动回滚(重新拉起原 node 进程)。
 *
 * @returns backend/version/target:实际换入的后端与版本;doneFile:swapper 结果文件路径
 *   ({ok, pid}|{ok:false, rolledBack, error}),与 npm 管线的 SYNCX_UPDATE_DONE 同一消费方式。
 */
export async function runBackendSwap(
  tgz: Buffer,
  opts: BackendSwapOptions,
): Promise<{ backend: BackendKind; version: string; target: string; doneFile: string }> {
  const stage = await sniffBackendPackage(tgz);
  if (!stage) throw new Error('不是后端二进制安装包(顶层目录应为 syncx-rs-v* / syncx-mbt-v*),如要升级 Node 后端请上传 npm tgz');
  const decision = decideSwapAction({
    packageBackend: stage.backend,
    runningBundled: opts.allowDevRuntime === true ? true : isSwappableRuntime(),
    packageTarget: stage.target,
    localTriple: opts.expectTarget,
  });
  if (decision.action === 'reject') throw new Error(decision.reason);

  const pkg = await extractBackendPackage(tgz, { minBytes: opts.minBytes, expectTarget: opts.expectTarget ?? localTargetTriple() });

  // 安装二进制到数据目录:三后端共享数据目录(ADR-0026),bin/ 里的就是当前生效的后端
  const binDir = opts.installDir ?? join(opts.configDir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const dest = join(binDir, backendBinaryName(pkg.backend));
  copyFileSync(pkg.binaryPath, dest);
  try {
    chmodSync(dest, 0o755); // tar 提取可能丢执行位,补上,否则拉起即 Permission denied
  } catch {
    /* Windows 上无对应语义,忽略 */
  }

  const restartArgs = [...(opts.restartArgs ?? process.argv.slice(1))]; // 备份的运行方式(回滚用)
  const daemonArgs = [...(opts.daemonArgs ?? process.argv.slice(2))]; // 传给新后端的启动参数
  const logIdx = daemonArgs.indexOf('--log-file');
  const logFile = logIdx >= 0 ? daemonArgs[logIdx + 1] : undefined;
  const controlPort = opts.controlPort ?? controlPortFromArgs(restartArgs);
  const doneFile = join(pkg.workDir, 'swap-done.json');
  const job = {
    pid: opts.oldPid ?? process.pid,
    binPath: dest,
    daemonArgs,
    nodeExe: opts.nodeExe ?? process.execPath,
    restartArgs,
    controlPort,
    doneFile,
    waitMs: opts.waitMs ?? OLD_EXIT_WAIT_MS,
    healthTimeoutMs: opts.healthTimeoutMs ?? HEALTH_TIMEOUT_MS,
    backend: pkg.backend,
    version: pkg.version,
    logFile,
    workDir: pkg.workDir,
  };
  const swapperFile = join(pkg.workDir, 'swapper.mjs');
  const jobFile = join(pkg.workDir, 'job.json');
  writeFileSync(jobFile, JSON.stringify(job));
  writeFileSync(swapperFile, swapperSource());

  const child = spawn(job.nodeExe, [swapperFile, jobFile], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return { backend: pkg.backend, version: pkg.version, target: pkg.target, doneFile };
}
