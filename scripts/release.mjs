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
 * 交互流程(TTY 下,与 model-gate 一致的方向键 + Enter):
 *   1. 选择发布通道:latest / beta / alpha / 自定义 tag(默认 latest)
 *   2. 选择升级方式:patch / minor / major / iteration —— 选项右侧直接预览算出的版本号
 *      缺省随通道:latest → patch,beta 等预发布 → iteration
 *   3. 全部检查通过后才做最后一次「发布 / 取消」确认
 *   传了 --tag / 升级方式参数则跳过对应那一步;给了显式版本号则跳过 1、2 两步。
 *   非交互环境(管道 / CI / 沙箱,没有 TTY)自动跳过所有选择,用默认值继续。
 *
 * 用法:
 *   npm run release [major|minor|patch|iteration|<semver>] [options]
 *
 * 发布通道(--tag):
 *   --tag=latest(默认)  正式版,版本号形如 x.y.z
 *   --tag=beta           预发布,版本号形如 x.y.z-beta.N,并以 --tag beta 发布到 beta dist-tag
 *   其它标签(alpha / next 等)同理,预发布后缀与标签同名。
 *
 * 基准版本来源(与 model-gate 一致):
 *   从 npm registry 查询「当前通道」已发布的最新版本作为递增基准
 *   (npm view <pkg> versions --json → 按通道过滤 → semver 排序取最大),
 *   而不是读本地 package.json —— 避免本地与远端不一致导致版本回退或撞车。
 *   只有当该通道远端无任何版本(首发)时,才回退到 package.json 当前版本。
 *   注意:不能用 `npm view <pkg> version`,它只看 latest dist-tag,会漏掉 beta 版本。
 *
 * 升级方式:
 *   major / minor / patch  递增基础版本号(预发布通道会附 -<tag>.1)
 *   iteration              预发布迭代号 +1(x.y.z-beta.3 → beta.4);正式通道等价于 patch
 *   缺省:beta 通道为 iteration,latest 通道为 patch
 *   也可直接给完整版本号(如 1.2.3 或 1.2.3-beta.1),此时通道由预发布后缀自动推断。
 *   预发布 + iteration 时若目标已被占用,会自动顺延迭代号直到找到可用版本。
 *
 * Options:
 *   --otp <code>       npm 一次性密码(2FA)。不传则优先读环境变量 SYNCX_NPM_OTP,
 *                      再退化为交互式隐藏输入。
 *   --tag <tag>        发布通道 / dist-tag(默认 latest)。例如 --tag beta。
 *                      不传此参数时,交互式选择通道(方向键)。
 *   --yes / -y         跳过发布前的「发布 / 取消」确认。
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

/** 执行 `npm view <name> versions --json`,返回 { found, versions }。
 *  found=false 表示包在 registry 上不存在(404,视为首发);其它错误抛错以便重试。 */
async function npmViewVersions(name) {
  return await withRetry(
    async () => {
      const r = await npmRaw(['view', name, 'versions', '--json']);
      if (r.code === 0) {
        try {
          const parsed = JSON.parse(r.stdout);
          return { found: true, versions: Array.isArray(parsed) ? parsed : [] };
        } catch {
          throw new Error(`npm 返回了无法解析的响应: ${r.stdout.trim().slice(0, 200)}`);
        }
      }
      if (/E?404|Not Found/i.test(r.stderr)) return { found: false, versions: [] };
      throw new Error(`npm view 查询失败 (exit ${r.code}): ${(r.stderr.trim() || r.stdout.trim()).slice(0, 300)}`);
    },
    {
      retries: 3,
      delayMs: 1000,
      onRetry: (attempt, e) => warn(`第 ${attempt} 次查询 npm 失败,1s 后重试:${e.message}`),
    },
  );
}

/** semver 比较:a<b 返回负数,a===b 返回 0,a>b 返回正数。
 *  必须正确处理预发布:无后缀 > 有后缀;同为后缀时按「标签名 + 迭代号数值」比较,
 *  不可用字符串比较,否则会掉进 beta.10 < beta.9 的字典序陷阱,把旧版本排成最大。 */
function cmpSemver(a, b) {
  const na = a.split('-')[0].split('.').map(Number);
  const nb = b.split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((na[i] ?? 0) !== (nb[i] ?? 0)) return (na[i] ?? 0) - (nb[i] ?? 0);
  }
  const parsePre = (v) => {
    const pre = v.includes('-') ? v.slice(v.indexOf('-') + 1) : null;
    if (!pre) return null;
    const dot = pre.indexOf('.');
    const tag = dot === -1 ? pre : pre.slice(0, dot);
    const num = dot === -1 ? NaN : Number(pre.slice(dot + 1));
    return { tag, num };
  };
  const pa = parsePre(a);
  const pb = parsePre(b);
  if (pa === null && pb === null) return 0;
  if (pa === null) return 1;
  if (pb === null) return -1;
  if (pa.tag !== pb.tag) return pa.tag < pb.tag ? -1 : 1;
  return (Number.isNaN(pa.num) ? 0 : pa.num) - (Number.isNaN(pb.num) ? 0 : pb.num);
}

/** 拆版本号为 { base, pre, nums },pre 形如 "beta.3" 或 null。 */
function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(v);
  if (!m) throw new Error(`无法解析版本号: ${v}`);
  return { base: `${m[1]}.${m[2]}.${m[3]}`, pre: m[4] ?? null, nums: [Number(m[1]), Number(m[2]), Number(m[3])] };
}

/**
 * 从 npm registry 拉取该包「当前通道」已发布的最新版本(按 semver 取最大)。
 *   - 通道 latest:只看 stable 版本(无预发布后缀)
 *   - 通道 beta / 其它:只看预发布标签与该通道同名的版本(如 x.y.z-beta.N)
 * 该通道没有任何已发布版本(含从未发布)返回 null。
 * 注意:不能用 `npm view <pkg> version`(它只看 latest dist-tag,会漏掉 beta 版本)。
 */
async function fetchLatestVersion(name, channel) {
  const result = await npmViewVersions(name);
  if (!result.found) return null;
  const preTagOf = (v) => {
    const pre = v.includes('-') ? v.slice(v.indexOf('-') + 1) : null;
    if (!pre) return null;
    const dot = pre.indexOf('.');
    return dot === -1 ? pre : pre.slice(0, dot);
  };
  const inChannel = channel === 'latest' ? (v) => preTagOf(v) === null : (v) => preTagOf(v) === channel;
  const candidates = result.versions.filter(inChannel).sort(cmpSemver);
  return candidates.length ? candidates[candidates.length - 1] : null;
}

/** 递增基础版本号(major/minor/patch)。 */
function bumpBase([maj, min, pat], bump) {
  if (bump === 'major') return [maj + 1, 0, 0];
  if (bump === 'minor') return [maj, min + 1, 0];
  return [maj, min, pat + 1]; // patch
}

/**
 * 计算新版本号。
 * @param current        基准版本(远端该通道最新版,或本地 package.json 兜底)
 * @param channel        latest 或 beta 等预发布标签名
 * @param bump           major / minor / patch / iteration
 * @param isFirstRelease 远端该通道查不到任何版本(首发)
 */
function nextVersion(current, channel, bump, isFirstRelease = false) {
  const { nums, pre } = parseVersion(current);

  if (channel !== 'latest') {
    if (bump === 'iteration') {
      // 当前已在同标签的预发布线上:迭代号 +1(beta.9 → beta.10,按数值比较)
      if (pre && pre.startsWith(`${channel}.`)) {
        const n = Number(pre.slice(channel.length + 1)) || 0;
        return `${nums[0]}.${nums[1]}.${nums[2]}-${channel}.${n + 1}`;
      }
      // 当前是 stable 或别的预发布标签:切到下一个 patch 的 -<channel>.1
      //   首发例外:直接用当前 base 挂 -beta.1(如 0.1.0 → 0.1.0-beta.1)
      if (isFirstRelease) return `${nums[0]}.${nums[1]}.${nums[2]}-${channel}.1`;
      const [maj, min, pat] = bumpBase(nums, 'patch');
      return `${maj}.${min}.${pat}-${channel}.1`;
    }
    // 预发布 + major/minor/patch:升基础版本并附 -<channel>.1
    const [maj, min, pat] = bumpBase(nums, bump);
    return `${maj}.${min}.${pat}-${channel}.1`;
  }

  // latest 通道:iteration 无预发布概念,等价于 patch
  const [maj, min, pat] = bumpBase(nums, bump === 'iteration' ? 'patch' : bump);
  return `${maj}.${min}.${pat}`;
}

/** 从版本号推断通道:带 -beta 等预发布后缀 → 该后缀标签,否则 latest。 */
function channelOfVersion(v) {
  const pre = v.includes('-') ? v.slice(v.indexOf('-') + 1) : null;
  if (!pre) return 'latest';
  const dot = pre.indexOf('.');
  return dot === -1 ? pre : pre.slice(0, dot);
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
  if (isInteractive()) {
    const ok = await selectPrompt('未登录，是否现在执行 npm login？', [
      { value: false, label: '否', hint: '稍后自行登录再重试（推荐，避免浏览器登录流程卡住）' },
      { value: true, label: '是', hint: '立即 npm login（会拉起浏览器授权，需等待完成）' },
    ], 0);
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

/* ---------- 交互选择(方向键 + Enter) ---------- */
/* model-gate 用 inquirer 的 select 实现;这里零依赖手写同款交互,避免为一个发布脚本
 * 再引入一个依赖包(window misses raw-mode 处理由 node:readline 承担)。 */

/** TTY 下才着色/移动光标;管道与 CI 输出保持纯文本,避免日志里混入转义序列。 */
const canAnsi = () => Boolean(process.stdout.isTTY);
const paint = {
  bold: (s) => (canAnsi() ? `\x1b[1m${s}\x1b[22m` : s),
  cyan: (s) => (canAnsi() ? `\x1b[36m${s}\x1b[39m` : s),
  green: (s) => (canAnsi() ? `\x1b[32m${s}\x1b[39m` : s),
  dim: (s) => (canAnsi() ? `\x1b[2m${s}\x1b[22m` : s),
};

/** 是否处于可读按键的交互环境。CI / 管道 / 沙箱里没有 TTY,一律走默认值不阻塞。 */
const isInteractive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

/**
 * 方向键单选提示。
 *   ↑/↓(或 k/j)移动光标,Enter 选中并折叠为一行结果,Ctrl+C 直接退出。
 *   非交互环境无法读取按键,直接返回默认项,不阻塞流程。
 * @param message      提示语
 * @param choices      [{ value, label, hint }],hint 为右侧说明(可省)
 * @param defaultIndex 默认高亮项下标
 * @returns 选中项的 value
 */
async function selectPrompt(message, choices, defaultIndex = 0) {
  const idx0 = Math.min(Math.max(defaultIndex, 0), choices.length - 1);
  if (!isInteractive()) return choices[idx0].value;

  let index = idx0;
  // 渲染块高度:提示行 + 每个选项一行 + 末行按键说明
  const height = choices.length + 2;
  const pad = Math.max(...choices.map((c) => c.label.length));
  const width = process.stdout.columns ?? 100;
  let rendered = false;

  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, terminal: true });
    const wasRaw = Boolean(process.stdin.isRaw);
    if (typeof process.stdin.setRawMode === 'function') process.stdin.setRawMode(true);

    // 光标回到块首并清除已渲染内容，用于原地重绘
    const rewind = () => {
      readline.moveCursor(process.stdout, 0, -height);
      readline.cursorTo(process.stdout, 0);
      readline.clearScreenDown(process.stdout);
    };

    const render = () => {
      if (rendered) rewind();
      rendered = true;
      process.stdout.write(`${message}\n`);
      choices.forEach((c, i) => {
        const active = i === index;
        const cursor = active ? paint.cyan('❯') : ' ';
        const mark = active ? paint.cyan('●') : '○';
        // 先按原始长度补空格再加粗:若先加粗再 padEnd,ANSI 转义符会被算进宽度导致右侧说明错位
        const gap = ' '.repeat(Math.max(pad - c.label.length, 0));
        const head = ` ${cursor} ${mark} ${(active ? paint.bold(c.label) : c.label)}${gap}`;
        if (c.hint) {
          // 按终端宽度截断说明，避免换行打乱行数（重绘依赖固定行高）
          const room = width - head.length - 1;
          if (room > 8) process.stdout.write(`${head} ${paint.dim(c.hint.slice(0, room))}`);
          else process.stdout.write(head);
        } else {
          process.stdout.write(head);
        }
        process.stdout.write('\n');
      });
      process.stdout.write(`${paint.dim('  ↑/↓ 或 k/j 移动，Enter 确认，Ctrl+C 退出')}\n`);
    };

    const done = (value) => {
      rl.input.removeListener('keypress', onKey);
      rl.close();
      if (typeof process.stdin.setRawMode === 'function' && !wasRaw) process.stdin.setRawMode(false);
      rewind();
      const chosen = choices.find((c) => c.value === value);
      process.stdout.write(`${message} ${paint.green(paint.bold(chosen?.label ?? String(value)))}\n`);
      resolve(value);
    };

    const onKey = (_seq, key) => {
      if (!key) return;
      if (key.ctrl && key.name === 'c') {
        rl.input.removeListener('keypress', onKey);
        rl.close();
        if (typeof process.stdin.setRawMode === 'function' && !wasRaw) process.stdin.setRawMode(false);
        process.stdout.write('\n');
        process.exit(130);
      }
      if (key.name === 'up' || key.sequence === 'k') {
        index = (index - 1 + choices.length) % choices.length;
        render();
      } else if (key.name === 'down' || key.sequence === 'j') {
        index = (index + 1) % choices.length;
        render();
      } else if (key.name === 'return' || key.name === 'enter') {
        done(choices[index].value);
      }
    };

    rl.input.on('keypress', onKey);
    render();
  });
}

/** 单行文本输入(用于自定义 dist-tag);非交互环境返回默认值。 */
function textPrompt(question, fallback) {
  if (!isInteractive()) return fallback;
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} `, (ans) => {
      rl.close();
      resolve(ans.trim() || fallback);
    });
  });
}

/* ---------- 参数解析 ---------- */
const argv = process.argv.slice(2);
const opts = {
  // 未显式指定升级方式时,解析完 --tag 后按通道取默认:beta → iteration,latest → patch
  bumpArg: undefined,
  otp: process.env.SYNCX_NPM_OTP,
  registry: undefined,
  tag: 'latest',
  tagGiven: false, // 是否显式传了 --tag:显式时不弹交互式通道选择
  bumpGiven: false, // 是否显式传了升级方式
  yes: false, // 跳过发布前的二次确认
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
  else if (a === '--yes' || a === '-y') opts.yes = true;
  else if (a.startsWith('--otp=')) opts.otp = a.slice('--otp='.length);
  else if (a.startsWith('--registry=')) opts.registry = a.slice('--registry='.length);
  else if (a.startsWith('--tag=')) { opts.tag = a.slice('--tag='.length); opts.tagGiven = true; }
  else if (a.startsWith('--otp') || a.startsWith('--registry') || a.startsWith('--tag')) fail(`用法错误:${a} 需以 --x=value 形式传参`);
  else if (a === 'patch' || a === 'minor' || a === 'major' || a === 'iteration') { opts.bumpArg = a; opts.bumpGiven = true; }
  // 允许显式版本号,含预发布(如 0.1.1-beta.1)—— 此时通道由后缀自动推断
  else if (/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(a)) { opts.bumpArg = a; opts.bumpGiven = true; }
  else fail(`无法识别的参数:${a}(应为 patch/minor/major/iteration,或如 1.2.3 / 1.2.3-beta.1)`);
}

/* ---------- 解析通道与基准版本(基准取自 npm 远端该通道的最新版本) ---------- */
const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'));
const pkgName = pkg.name;
const cur = pkg.version; // 本地版本仅作「远端该通道无版本」时的首发兜底基准

// 显式版本号(如 0.1.1-beta.1):通道由预发布后缀推断,跳过所有选择
const explicitVersion =
  opts.bumpArg && /^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(opts.bumpArg) ? opts.bumpArg : undefined;

let channel;
if (explicitVersion) {
  channel = channelOfVersion(explicitVersion);
  log(`使用显式版本号 ${explicitVersion}(通道由后缀推断为 ${channel})`);
} else if (opts.tagGiven) {
  channel = opts.tag;
} else {
  // 交互选择通道(model-gate 用 inquirer:select;等价于方向键 + Enter)
  const picked = await selectPrompt('选择发布通道:', [
    { value: 'latest', label: 'latest', hint: '正式版 x.y.z；npm i -g 默认装到它' },
    { value: 'beta', label: 'beta', hint: '预发布 x.y.z-beta.N；需显式 @beta 安装' },
    { value: 'alpha', label: 'alpha', hint: '预发布 x.y.z-alpha.N；早期尝鲜' },
    { value: '__custom__', label: '自定义 tag', hint: '手动输入 dist-tag(如 rc / next)' },
  ], 0);
  channel =
    picked === '__custom__'
      ? await textPrompt('请输入 dist-tag:', 'latest')
      : picked;
  if (!/^[a-z][\w.-]*$/i.test(channel)) fail(`dist-tag 不合法: ${channel}(应为字母开头,如 latest / beta / rc)`);
}
opts.tag = channel;

let base;
let isFirstRelease = false;
if (explicitVersion) {
  base = explicitVersion;
} else {
  const remote = await withSpinner(
    `查询 npm 上 ${pkgName} 在 ${channel} 通道的最新版本`,
    () => fetchLatestVersion(pkgName, channel),
  );
  isFirstRelease = remote === null;
  base = remote ?? cur;
  if (isFirstRelease) {
    log(`npm 上未找到 ${pkgName} 的 ${channel} 通道版本,按首发处理(基准取本地 ${cur})`);
  } else {
    log(`npm ${channel} 通道最新版本 ${remote}(本地 package.json 为 ${cur})`);
  }
}

let bump;
if (explicitVersion) {
  bump = 'iteration'; // 显式版本下不参与计算,仅作展示
} else if (opts.bumpGiven) {
  bump = opts.bumpArg;
} else {
  // 选项右侧直接预览「选中后得到的版本号」,避免猜
  const preview = (b) => nextVersion(base, channel, b, isFirstRelease);
  const bumpDefault = channel === 'latest' ? 'patch' : 'iteration';
  const bumpOptions = [
    { value: 'patch', label: 'patch', hint: `修订号 +1 → ${preview('patch')}` },
    { value: 'minor', label: 'minor', hint: `次版本号 +1 → ${preview('minor')}` },
    { value: 'major', label: 'major', hint: `主版本号 +1 → ${preview('major')}` },
    {
      value: 'iteration',
      label: 'iteration',
      hint: channel === 'latest' ? `正式通道等价于 patch → ${preview('iteration')}` : `预发布迭代 +1 → ${preview('iteration')}`,
    },
  ];
  bump = await selectPrompt('选择版本升级方式:', bumpOptions, bumpOptions.findIndex((o) => o.value === bumpDefault));
}

let target = explicitVersion ?? nextVersion(base, channel, bump, isFirstRelease);
log(`通道 ${channel} | 升级方式 ${bump} | 基准 ${base} → 目标 ${target}`);

// 目标的基础版本不得低于本地 package.json(防止误发回退版本)。
// 只比 x.y.z 基础部分:预发布按 semver 本就低于同 base 的正式版(0.1.1-beta.1 < 0.1.1),
// 首个 beta 属合法场景,不能因后缀而被拦;真正要拦的是基础版本倒退(如本地 0.5.0 却发 0.2.0-beta.1)。
if (!explicitVersion) {
  const targetBase = target.split('-')[0];
  const localBase = cur.split('-')[0];
  if (cmpSemver(targetBase, localBase) < 0) {
    fail(
      `目标版本 ${target} 的基础版本低于本地 package.json 的 ${cur},已中止。` +
      '远端该通道版本落后于本地时请检查是否选错通道,或先手动改 package.json。',
    );
  }
}

/* ---------- 网络预检 1:目标版本号是否已被 npm 占用 ---------- */
// 预发布 + iteration 时若已占用则自动顺延迭代号(beta.1 被占 → beta.2),与 model-gate 一致;
// 其它升级方式被占用则直接失败,不静默跳版本。
let occupied = await withSpinner(
  `校验 ${pkgName}@${target} 是否已被 npm 占用`,
  () => versionExists(pkgName, target),
);
if (occupied) {
  if (channel !== 'latest' && bump === 'iteration') {
    let guard = 0;
    while (occupied) {
      const next = nextVersion(target, channel, 'iteration', false);
      if (++guard > 50) fail('iteration 顺延超过 50 次仍被占用,请检查 npm 版本历史');
      target = next;
      occupied = await withSpinner(
        `校验 ${pkgName}@${target} 是否已被 npm 占用`,
        () => versionExists(pkgName, target),
      );
    }
    warn(`基准 ${base} 的下一版已被占用,已自动顺延到 ${target}`);
  } else {
    fail(
      `版本 ${pkgName}@${target} 已被发布过,不能重复发布。` +
      '请换更高版本号,或在预发布通道用 iteration 自动顺延。',
    );
  }
}
log(`版本 ${target} 未被占用,可发布`);

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
  if (isInteractive()) {
    // 交互态下要问「是否 npm login」,不能再套 spinner —— 否则动画会和用户提示抢同一行输出
    await ensureNpmLogin();
  } else {
    await withSpinner('确认 npm 登录态', async () => { await ensureNpmLogin(); });
  }
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
  // 最后一次方向键确认(model-gate 同样在所有检查之后才 confirm)
  if (!opts.yes) {
    const go = await selectPrompt(`确认发布 ${pkgName}@${target} ?`, [
      { value: true, label: '发布', hint: `npm publish, dist-tag = ${opts.tag}` },
      { value: false, label: '取消', hint: '放弃本次发布,不做任何远端变更' },
    ], 0);
    if (!go) {
      log(`已取消发布:${pkgName}@${target}(未执行 npm publish)`);
      process.exit(0);
    }
  }

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
