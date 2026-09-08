import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { packageVersion } from './usage.js';

/** 默认升级通道:npm dist-tag latest(正式版)。 */
export const DEFAULT_UPGRADE_TAG = 'latest';

/** npm 包名(与 package.json 一致)。 */
const PACKAGE_NAME = '@wangmingfa/syncx';

/**
 * 校验并规范化升级通道(dist-tag)。
 * - 省略参数时用 latest;
 * - 只接受 npm 合法的 tag 字符集(字母/数字开头,可含 . _ -),
 *   拦掉带空格/斜杠的输入,避免拼进 npm 命令后被 shell 误解析。
 * @throws 输入不合法时抛错(由 main.ts 统一转为非零退出码)。
 */
export function normalizeUpgradeTag(input?: string): string {
  // 空串/纯空白视为「省略参数」,回落到默认通道(?? 只能兜住 null/undefined)
  const tag = (input ?? '').trim() || DEFAULT_UPGRADE_TAG;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tag)) {
    throw new Error(`invalid dist-tag: ${tag}(可用通道如 latest / beta / alpha)`);
  }
  return tag;
}

/**
 * 比较两个 semver 版本号:相等返回 0,a 更大返回正数,b 更大返回负数。
 * 规则与 scripts/release.mjs 的 cmpSemver 同源:
 * - 先比 maj.min.patch(数值);
 * - 基础版本相同时,无预发布后缀的更大(1.2.3 > 1.2.3-beta.1);
 * - 预发布比标签名再比迭代号,且迭代号按数值比(beta.10 > beta.9,不能字典序)。
 * 非法输入按 0.0.0 处理,不抛错(版本号来自网络/包描述,防脏数据崩溃)。
 */
export function compareVersions(a: string, b: string): number {
  function parse(v: string): { nums: [number, number, number]; pre: { tag: string; n: number } | null } {
    const [base, preRaw] = v.split('-');
    const [maj, min, pat] = (base ?? '').split('.');
    const num = (s: string | undefined) => (s !== undefined && /^\d+$/.test(s) ? Number(s) : 0);
    let pre: { tag: string; n: number } | null = null;
    if (preRaw) {
      const dot = preRaw.indexOf('.');
      if (dot > 0) {
        pre = { tag: preRaw.slice(0, dot), n: num(preRaw.slice(dot + 1)) };
      } else {
        pre = { tag: preRaw, n: 0 };
      }
    }
    return { nums: [num(maj), num(min), num(pat)], pre };
  }

  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i]! - pb.nums[i]!;
  }
  if (!pa.pre && !pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  if (pa.pre.tag !== pb.pre.tag) return pa.pre.tag < pb.pre.tag ? -1 : 1;
  return pa.pre.n - pb.pre.n;
}

/**
 * 查询某 dist-tag 当前指向的版本号:npm view <pkg>@<tag> version。
 * 查询失败(网络不通 / tag 不存在 / npm 缺失)返回 undefined,由调用方决定报错话术。
 */
export function fetchTagVersion(tag: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    // Windows 下 npm 是 npm.cmd,必须经 shell 解析才能找到
    const child = spawn('npm', ['view', `${PACKAGE_NAME}@${tag}`, 'version'], {
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.on('error', () => resolve(undefined));
    child.on('close', (code) => {
      const version = out.trim().split('\n')[0]?.trim();
      resolve(code === 0 && version !== '' ? version : undefined);
    });
  });
}

/** pid 文件默认路径(与 cli.ts 的 pidFilePath 口径一致,用于运行中提示)。 */
function defaultPidFile(): string {
  return join(homedir(), '.syncx', 'syncx.pid');
}

/** 本机是否有 daemon 在跑(pid 文件存在且记录的进程存活)。探测失败按未运行处理。 */
export function isDaemonRunning(pidFile = defaultPidFile()): boolean {
  try {
    if (!existsSync(pidFile)) return false;
    const rec = JSON.parse(readFileSync(pidFile, 'utf8')) as { pid?: unknown };
    if (typeof rec.pid !== 'number') return false;
    process.kill(rec.pid, 0); // 信号 0 = 只探测存活
    return true;
  } catch {
    return false;
  }
}

export interface UpgradeIo {
  log: (msg: string) => void;
  error: (msg: string) => void;
}

/**
 * 执行升级:查询 dist-tag 指向的版本 → 与本地比较 → 不同则 npm install -g。
 * - 已是最新:提示后直接返回,不触发安装;
 * - 本机 daemon 在运行:先给提示(Windows 下全局安装替换正在使用的文件可能 EPERM);
 * - 安装经子进程执行且 stdio 透传,npm 的交互/进度原样呈现。
 * @throws 查询失败或 npm 安装退出码非零时抛错。
 */
export async function runUpgrade(tagInput: string | undefined, io: UpgradeIo = { log: console.log, error: console.error }): Promise<void> {
  const tag = normalizeUpgradeTag(tagInput);
  const current = packageVersion();
  io.log(`当前版本: ${current}`);
  io.log(`查询通道 ${tag} 的最新版本...`);

  const target = await fetchTagVersion(tag);
  if (!target) {
    throw new Error(`无法获取 ${PACKAGE_NAME}@${tag} 的版本(npm 查询失败:网络不通、通道不存在或未安装 npm)`);
  }
  if (current !== 'unknown' && compareVersions(current, target) >= 0) {
    io.log(`已是最新版本 ${target}(${tag} 通道),无需升级`);
    return;
  }
  io.log(`${current} → ${target}(${tag} 通道),开始安装...`);
  if (isDaemonRunning()) {
    io.log('提示: 检测到 daemon 正在运行。若安装报 EPERM/文件占用,请先 syncx stop 再重试。');
  }

  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn('npm', ['install', '-g', `${PACKAGE_NAME}@${tag}`], {
      shell: process.platform === 'win32',
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('close', (c) => resolve(c ?? 1));
  });
  if (code !== 0) {
    throw new Error(`npm install -g 失败(退出码 ${code})`);
  }
  io.log(`升级完成: ${target}。正在运行的 daemon 需重启后才生效(syncx stop && syncx start)。`);
}
