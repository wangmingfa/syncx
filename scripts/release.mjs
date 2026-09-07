#!/usr/bin/env node
/**
 * syncx npm 发布脚本。
 *
 * 流程(真实发布):网络预检 → 检查(可选)→ 构建 → 冒烟 → 递增版本号 →
 *       打包预览 → 临时全局安装验证 → 确认登录 → 真正 publish → 自动 commit。
 *
 * 参考 D:/code/model-gate/scripts/release.ts 移植的健壮性能力:
 *   - 发布前校验「目标版本号是否已被 npm 占用」(防止 403/409 撞车)
 *   - 网络查询(版本占用/登录态)临时失败自动重试,并区分「真 404(首发)」与「查询出错」
 *   - 非 TTY 环境(沙箱/CI)下长网络查询有持续进度反馈,不会看起来像卡死
 *   - 发布前确认 npm 登录态(防止 ENEEDAUTH 中途失败)
 *   - 发布成功后自动 commit 版本变更(package.json + package-lock.json)
 *
 * 用法:
 *   npm run release [patch|minor|major|<semver>] [options]
 *
 * 版本号:
 *   缺省或 patch/minor/major 时基于 package.json 当前版本自动递增;
 *   也可直接给完整版本号(如 1.2.3)。--dry-run 下不修改版本号。
 *
 * Options:
 *   --otp <code>       npm 一次性密码(2FA)。不传则优先读环境变量 SYNCX_NPM_OTP,
 *                      再退化为交互式隐藏输入。
 *   --tag <tag>        发布到指定 dist-tag(默认 latest)。例如 --tag beta。
 *   --registry <url>   发布到指定 registry(默认沿用当前 npm 配置;若当前不是
 *                      registry.npmjs.org 且未指定本项,会拒绝执行以避免误发镜像源)。
 *   --no-check         跳过 typecheck + vitest。
 *   --no-build         跳过 npm run build(产物 dist/syncx.js 必须已存在)。
 *   --no-smoke         跳过「打包 → 临时 --prefix 全局安装 → syncx status」验证。
 *   --no-git           发布成功后不自动 commit 版本变更(默认会自动 commit,不 push)。
 *   --dry-run          只做网络预检/校验/构建/冒烟/打包预览,不发布、不递增版本号、不 commit。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import process from 'node:process';

const ROOT = fileURLToPath(new URL('..', import.meta.url).href).replace(/[\\/]$/, '');
const PKG_PATH = join(ROOT, 'package.json');
const DIST = join(ROOT, 'dist', 'syncx.js');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const GIT = process.platform === 'win32' ? 'git.cmd' : 'git';
const IS_WIN = process.platform === 'win32';

const log = (msg) => console.log(`[release] ${msg}`);
const warn = (msg) => console.warn(`[release][warn] ${msg}`);
const fail = (msg) => {
  console.error(`[release][error] ${msg}`);
  process.exit(1);
};

/** 收集到的临时路径,结束时统一清理。 */
const cleanup = [];
process.on('exit', () => {
  for (const p of cleanup) {
    try { rmSync(p, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }
  }
});
const track = (p) => { cleanup.push(p); return p; };

class ExecError extends Error {
  constructor(cmd, code, stderrTail) {
    super(`command failed (exit ${code}): ${cmd}${stderrTail ? `\n${stderrTail}` : ''}`);
    this.exitCode = code;
    this.stderrTail = stderrTail ?? '';
  }
}

/** 执行命令:inherit=true 直接透传;否则捕获输出(可转发),非零退出抛 ExecError。 */
function exec(cmd, args, { inherit = false, forward = true, cwd = ROOT, shell = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      shell,
      stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    if (inherit) {
      child.on('exit', (code) => (code === 0 ? resolve({ stdout: '', stderr: '' }) : reject(new ExecError(`${cmd} ${args.join(' ')}`, code ?? -1, ''))));
      child.on('error', reject);
      return;
    }
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; if (forward) process.stdout.write(d); });
    child.stderr.on('data', (d) => { err += d; if (forward) process.stderr.write(d); });
    child.on('exit', (code) => {
      if (code === 0) resolve({ stdout: out, stderr: err });
      else reject(new ExecError(`${cmd} ${args.join(' ')}`, code ?? -1, err.trim().split('\n').slice(-8).join('\n')));
    });
    child.on('error', reject);
  });
}

// Windows 上 npm/git 是 .cmd,直接 spawn 会 EINVAL,须经 shell 执行。
const npm = (args, opts) => exec(NPM, args, { ...opts, shell: IS_WIN });
const git = (args, opts) => exec(GIT, args, { ...opts, shell: IS_WIN });

/**
 * 底层 npm 探测:不抛错,返回 { code, stdout, stderr }。
 * 用于「版本是否占用」「是否登录」这类需要区分 404 与查询错误的场景。
 */
function npmRaw(args) {
  return new Promise((resolve) => {
    const child = spawn(NPM, args, {
      cwd: ROOT,
      shell: IS_WIN,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('exit', (code) => resolve({ code: code ?? -1, stdout: out, stderr: err }));
    child.on('error', (e) => resolve({ code: -1, stdout: out, stderr: err + String(e) }));
  });
}

/** 轻量终端 spinner:任务期间显示旋转动画 + 耗时;非 TTY 环境改用周期性「仍在等待」提示,
 *  避免 npm 网络查询较慢时整段静默、看起来像卡死。借鉴 model-gate 的 withSpinner。 */
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
async function withSpinner(text, fn) {
  const start = Date.now();
  const elapsed = () => Math.floor((Date.now() - start) / 1000);
  if (!process.stdout.isTTY) {
    process.stdout.write(`⏳ ${text}...\n`);
    const timer = setInterval(() => process.stdout.write(`   ⏳ 仍在等待... (已 ${elapsed()}s)\n`), 3000);
    try {
      const r = await fn();
      clearInterval(timer);
      process.stdout.write(`✔ ${text} (${elapsed()}s)\n`);
      return r;
    } catch (e) {
      clearInterval(timer);
      process.stdout.write(`✗ ${text}\n`);
      throw e;
    }
  }
  let frame = 0;
  const timer = setInterval(() => {
    process.stdout.write(`\r${SPINNER_FRAMES[frame++ % SPINNER_FRAMES.length]} ${text}... (${elapsed()}s)`);
  }, 100);
  try {
    const r = await fn();
    clearInterval(timer);
    process.stdout.write(`\r✔ ${text} (${elapsed()}s)\n`);
    return r;
  } catch (e) {
    clearInterval(timer);
    process.stdout.write(`\r✗ ${text}\n`);
    throw e;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 通用重试:task 抛错时重试,直到成功或重试次数耗尽;耗尽后抛出最后一次错误。 */
async function withRetry(task, { retries, delayMs, onRetry }) {
  let lastErr;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      return await task();
    } catch (e) {
      lastErr = e;
      if (attempt <= retries) {
        onRetry?.(attempt, e);
        await sleep(delayMs);
      }
    }
  }
  throw lastErr;
}

/**
 * 该版本号是否已在 npm 上发布过(占用)。
 *   - true                          已发布(占用)
 *   - false                         包/版本不存在(404,视为可发布)
 *   - 抛错                          传输 / 网络等临时性错误(会重试;重试耗尽仍失败则向上抛错,
 *                                   避免把「查询失败」误判为「未占用」而覆盖已发布版本)
 */
async function versionExists(name, version) {
  return await withRetry(
    async () => {
      const r = await npmRaw(['view', `${name}@${version}`, 'version']);
      if (r.code === 0) return true;
      if (/E?404|Not Found/i.test(r.stderr)) return false;
      throw new Error(`npm view 查询失败 (exit ${r.code}): ${(r.stderr.trim() || r.stdout.trim()).slice(0, 300)}`);
    },
    {
      retries: 3,
      delayMs: 1000,
      onRetry: (attempt, e) => warn(`第 ${attempt} 次查询 npm 失败,1s 后重试:${e.message}`),
    },
  );
}

/** 发布前确保已登录 npm:未登录/登录态失效时,交互终端引导 npm login,非交互环境明确提示。
 *  登录成功后再次校验,确保后续 publish 不会因 ENEEDAUTH 而中途失败。 */
async function ensureNpmLogin() {
  const who = await npmRaw(['whoami']);
  if (who.code === 0) {
    log(`npm 已登录: ${who.stdout.trim()}`);
    return;
  }
  warn('未检测到 npm 登录态(或登录已失效)');
  if (process.stdin.isTTY) {
    const ok = await confirmPrompt('是否现在执行 npm login?(否则发布可能报 ENEEDAUTH)');
    if (ok) {
      await npm(['login'], { inherit: true });
      const re = await npmRaw(['whoami']);
      if (re.code !== 0) fail('npm login 未完成或失败,请检查登录状态后重试。');
      log(`npm 登录成功: ${re.stdout.trim()}`);
      return;
    }
  }
  warn('未登录。若发布报 ENEEDAUTH,请先 `npm login` 再重试。');
}

/** TTY 下的 y/N 确认提示。 */
function confirmPrompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} [y/N] `, (ans) => {
      rl.close();
      resolve(/^y(es)?$/i.test(ans.trim()));
    });
  });
}

/* ---------- 参数解析 ---------- */
const argv = process.argv.slice(2);
const opts = {
  versionArg: 'patch',
  otp: process.env.SYNCX_NPM_OTP,
  registry: undefined,
  tag: 'latest',
  doCheck: true,
  doBuild: true,
  doSmoke: true,
  doGit: true,
  dryRun: false,
};
for (const a of argv) {
  if (a === '--no-check') opts.doCheck = false;
  else if (a === '--no-build') opts.doBuild = false;
  else if (a === '--no-smoke') opts.doSmoke = false;
  else if (a === '--no-git') opts.doGit = false;
  else if (a === '--dry-run') opts.dryRun = true;
  else if (a.startsWith('--otp=')) opts.otp = a.slice('--otp='.length);
  else if (a.startsWith('--registry=')) opts.registry = a.slice('--registry='.length);
  else if (a.startsWith('--tag=')) opts.tag = a.slice('--tag='.length);
  else if (a.startsWith('--otp') || a.startsWith('--registry') || a.startsWith('--tag')) fail(`用法错误:${a} 需以 --x=value 形式传参`);
  else if (a === 'patch' || a === 'minor' || a === 'major') opts.versionArg = a;
  else if (/^\d+\.\d+\.\d+$/.test(a)) opts.versionArg = a;
  else fail(`无法识别的参数:${a}(版本号应为 patch/minor/major 或如 1.2.3)`);
}

/* ---------- 解析/递增版本号 ---------- */
const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'));
const pkgName = pkg.name;
const cur = pkg.version;
const parse = (v) => v.split('.').map(Number);

function nextVersion(arg, current) {
  if (/^\d+\.\d+\.\d+$/.test(arg)) return arg;
  const [M, m, p] = parse(current);
  if (arg === 'major') return `${M + 1}.0.0`;
  if (arg === 'minor') return `${M}.${m + 1}.0`;
  return `${M}.${m}.${p + 1}`; // patch(默认)
}

const target = nextVersion(opts.versionArg, cur);
const cmp = (a, b) => { const [x, y, z] = parse(a); const [u, v, w] = parse(b); return x - u || y - v || z - w; };
if (!opts.dryRun && target === cur) fail(`版本已是 ${cur},无需发布。请给更高版本号。`);
if (opts.dryRun) {
  log(`dry-run:版本保持 ${cur}(本次不递增)`);
} else if (cmp(target, cur) < 0) {
  fail(`目标版本 ${target} 低于当前 ${cur},已中止(如需强行覆盖请先手动改 package.json)。`);
}

/* ---------- 网络预检 1:目标版本号是否已被 npm 占用 ---------- */
await withSpinner(`校验 ${pkgName}@${target} 是否已被 npm 占用`, async () => {
  const occupied = await versionExists(pkgName, target);
  if (occupied) {
    fail(`版本 ${pkgName}@${target} 已被发布过,不能重复发布。请换一个未占用的版本号(如 bump 更高版本)。`);
  }
  log(`版本 ${target} 未被占用,可发布`);
});

/* ---------- registry 预检(仅真正发布时) ---------- */
if (!opts.dryRun) {
  const reg = (await npm(['config', 'get', 'registry'])).stdout.trim();
  if (!reg.includes('registry.npmjs.org') && !opts.registry) {
    fail(
      `当前 registry 为 ${reg},不是 npmjs 官方源。` +
      '镜像源不接受 publish;确需发布请加 --registry=https://registry.npmjs.org 或在 ~/.npmrc 配置官方源。',
    );
  }
  const publisher = opts.registry ?? reg;
  log(`将发布到 ${publisher} (dist-tag: ${opts.tag})`);
}

/* ---------- 网络预检 2:登录态(仅真正发布时,提前失败避免构建白做) ---------- */
if (!opts.dryRun) {
  await withSpinner('确认 npm 登录态', async () => { await ensureNpmLogin(); });
}

/* ---------- 1. 类型检查 + 测试 ---------- */
if (opts.doCheck) {
  log('运行 typecheck…');
  await npm(['run', 'typecheck'], { inherit: true });
  log('运行测试(vitest)…');
  await npm(['test'], { inherit: true });
}

/* ---------- 2. 构建 ---------- */
if (opts.doBuild) {
  log('运行 npm run build…');
  await npm(['run', 'build'], { inherit: true });
}
if (!existsSync(DIST)) fail(`构建产物不存在:${DIST}(请先 npm run build,或确认 --no-build 用法)`);

/* ---------- 3. 本地冒烟:单文件可执行 ---------- */
{
  const tmp = track(mkdtempSync(join(tmpdir(), 'syncx-release-')));
  const cfg = join(tmp, 'config.json');
  log('本地冒烟:node dist/syncx.js status --config <tmp>/config.json');
  const r = await exec(process.execPath, [DIST, 'status', '--config', cfg]);
  if (!r.stdout.includes('device:')) fail('本地冒烟失败:status 输出缺少 device: 行');
  log('本地冒烟通过(单文件 bundle 可正常启动 CLI)');
}

/* ---------- 4. 递增版本号(置于检查/构建/冒烟之后,中途失败时不污染版本号) ---------- */
if (!opts.dryRun) {
  await npm(['version', target, '--no-git-tag-version'], { inherit: true });
  log(`版本号已更新为 ${target}(package.json + package-lock.json)`);
}

/* ---------- 5. 打包预览 + 临时全局安装验证 ---------- */
const packPreview = await npm(['pack', '--dry-run', '--json'], { forward: false });
const preview = JSON.parse(packPreview.stdout)[0];
log(`发布内容预览:${preview.entryCount} 个文件,tarball ${(preview.size / 1024).toFixed(0)} KB`);
for (const f of preview.files.map((x) => x.path)) log(`  · ${f}`);
if (!preview.files.some((f) => f.path === 'dist/syncx.js')) fail('打包结果缺少 dist/syncx.js,请检查 package.json 的 files/bin');
// dist/web 是 vite 构建中间产物,已被 build-single.mjs 内联进 dist/syncx.js,运行时无需磁盘文件。
// 一旦被误打包进发布物(如 files 又改回 ["dist"]),体积翻倍且属多余,直接拦截。
if (preview.files.some((f) => f.path.startsWith('dist/web'))) {
  fail('打包结果包含 dist/web/ (构建中间产物,已内联进 dist/syncx.js,不应发布)。请确认 package.json 的 files 仅含 dist/syncx.js。');
}

if (opts.doSmoke) {
  const packed = JSON.parse((await npm(['pack', '--json'], { forward: false })).stdout)[0].filename;
  const tgz = join(ROOT, packed);
  track(tgz);
  const prefix = track(mkdtempSync(join(tmpdir(), 'syncx-install-')));
  const cfg2 = track(mkdtempSync(join(tmpdir(), 'syncx-run-')));
  log(`模拟全局安装:npm i -g --prefix <tmp> ${packed}`);
  await npm(['i', '-g', '--prefix', prefix, tgz], { inherit: true });
  // scoped 包(@scope/name)安装到 node_modules/@scope/name,无 scope 则 node_modules/name;
  // 用 pkg.name 拆段拼接,scoped / unscoped 都兼容。
  const installed = join(prefix, 'node_modules', ...pkg.name.split('/'), 'dist', 'syncx.js');
  if (!existsSync(installed)) fail(`临时安装后找不到 ${installed},请检查 package.json 的 files/bin`);
  log('验证全局安装后的 syncx 命令可运行…');
  const r2 = await exec(process.execPath, [installed, 'status', '--config', join(cfg2, 'config.json')]);
  if (!r2.stdout.includes('device:')) fail('安装产物冒烟失败:status 输出缺少 device: 行');
  log('模拟全局安装验证通过:syncx@' + (opts.dryRun ? cur : target) + ' 可正常运行');
}

/* ---------- 6. 真正发布 ---------- */
if (opts.dryRun) {
  log(`dry-run 结束:未发布、未改版本号、未 commit。可去掉 --dry-run 执行真实发布(${target})`);
} else {
  const otpHint = opts.otp ? `(--otp=${'*'.repeat(opts.otp.length)})` : '(未提供 OTP)';
  log(`执行 npm publish… ${otpHint}`);
  const publishArgs = ['publish', '--access', 'public', '--tag', opts.tag];
  if (opts.registry) publishArgs.push('--registry', opts.registry);

  const readOtp = () => new Promise((resolve) => {
    if (!process.stdin.isTTY) return resolve(undefined); // 非交互环境必须走 --otp / SYNCX_NPM_OTP
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    process.stdout.write('请输入 npm OTP(6 位,输入不回显):');
    let buf = '';
    const onKey = (_s, key) => {
      if (!key) return;
      if (key.name === 'return') { rl.close(); return; }
      if (key.name === 'backspace') buf = buf.slice(0, -1);
      else if (key.sequence && !key.ctrl && !key.meta) buf += key.sequence;
    };
    rl.input.on('keypress', onKey);
    rl.on('close', () => {
      rl.input.removeListener('keypress', onKey);
      process.stdout.write('\n');
      resolve(buf.trim() || undefined);
    });
  });

  let otp = opts.otp;
  let attempts = 0;
  await withSpinner(`发布到 npm (${opts.tag})`, async () => {
    for (;;) {
      try {
        const args = otp ? [...publishArgs, '--otp', otp] : publishArgs;
        await npm(args, { forward: false });
        return; // 发布成功
      } catch (e) {
        const needOtp = e instanceof ExecError && /EOTP|one[- ]?time password|ENEEDAUTH|incorrect otp/i.test(e.stderrTail);
        if (needOtp && attempts < 3) {
          attempts += 1;
          warn(`OTP 缺失或无效(第 ${attempts} 次),请重新输入`);
          otp = await readOtp();
          if (!otp) fail('未提供 OTP。请用 --otp=<code> 或设置 SYNCX_NPM_OTP 后重试。');
          continue;
        }
        throw e;
      }
    }
  });

  log(`✅ 已发布 syncx@${target}:npm i -g syncx@${target} 后可直接运行 syncx`);

  /* ---------- 7. 发布成功后自动 commit 版本变更 ---------- */
  if (opts.doGit) {
    const st = await git(['status', '--porcelain', 'package.json', 'package-lock.json'], { forward: false });
    if (!st.stdout.trim()) {
      log('package.json 无改动,跳过 commit');
    } else {
      await git(['add', 'package.json', 'package-lock.json'], { inherit: true });
      await git(['commit', '-m', `chore: 发布 v${target}`], { inherit: true });
      log(`已提交版本变更(未 push)。可手动执行:git tag v${target} && git push --follow-tags`);
    }
  } else {
    log(`已跳过自动 git commit(--no-git)。建议手动:git add package.json package-lock.json && git commit -m "chore: 发布 v${target}"`);
  }
}
