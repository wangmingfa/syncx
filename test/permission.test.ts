import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ensureExecutable } from '../src/selfexec.js';
import { packSelfTgz, runSelfUpdate } from '../src/selfupdate.js';

const WIN = process.platform === 'win32';

/** 文件是否带任一执行位(Unix)。Windows 下无意义,调用方应 skipIf(WIN)。 */
function hasExec(path: string): boolean {
  return (statSync(path).mode & 0o111) !== 0;
}

/** 造一个可实跑的假安装目录:package.json + dist/syncx.js。 */
function makeFakePackage(parent: string, name: string, version: string): string {
  const root = join(parent, name);
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@wangmingfa/syncx', version }));
  writeFileSync(
    join(root, 'dist', 'syncx.js'),
    [
      '#!/usr/bin/env node',
      "import { readFileSync } from 'node:fs';",
      "process.stdout.write(String(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version));",
      '',
    ].join('\n'),
  );
  return root;
}

/** 用系统 tar 把目录打成 tgz(与生产 P2P 发送侧同一条路径)。 */
function tgzDir(dir: string): Buffer {
  const work = mkdtempSync(join(tmpdir(), 'syncx-test-tgz-'));
  const r = spawnSync('tar', ['-czf', 'out.tgz', '-C', dir, '.'], { encoding: 'utf8', cwd: work });
  if (r.status !== 0) throw new Error(`tar 打包失败: ${r.stderr}`);
  const buf = readFileSync(join(work, 'out.tgz'));
  rmSync(work, { recursive: true, force: true });
  return buf;
}

/** 解出 tgz 到临时目录,返回解压根(取唯一顶层目录)。 */
function untar(tgz: Buffer): string {
  const work = mkdtempSync(join(tmpdir(), 'syncx-test-untar-'));
  writeFileSync(join(work, 'self.tgz'), tgz);
  const r = spawnSync('tar', ['-xzf', 'self.tgz', '-C', work], { encoding: 'utf8', cwd: work });
  if (r.status !== 0) throw new Error(`tar 解压失败: ${r.stderr}`);
  const entries = readdirSync(work).filter((e: string) => e !== 'self.tgz');
  const top = entries[0];
  const root = join(work, top);
  return statSync(root).isDirectory() ? root : work;
}

/** 等待文件出现(updater 结果文件),超时抛错。 */
async function waitForFile(path: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`等待超时: ${path}`);
}

describe('ensureExecutable (权限自动修复核心)', () => {
  it('把 0644 文件补成可执行(0755)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-ens-'));
    const f = join(dir, 'bin.js');
    writeFileSync(f, '#!/usr/bin/env node\nconsole.log(1);');
    chmodSync(f, 0o644); // 缺执行位
    ensureExecutable(f);
    expect(hasExec(f)).toBe(true); // 自动修复生效
    rmSync(dir, { recursive: true, force: true });
  });

  it('已可执行(0755)保持不动且不报错', () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-ens-'));
    const f = join(dir, 'bin.js');
    writeFileSync(f, 'x');
    chmodSync(f, 0o755);
    ensureExecutable(f);
    expect(hasExec(f)).toBe(true); // 幂等,未降级
    rmSync(dir, { recursive: true, force: true });
  });

  it('文件不存在时静默跳过(不抛)', () => {
    expect(() => ensureExecutable(join(tmpdir(), 'no-such-dir-xyz', 'nope.js'))).not.toThrow();
  });
});

describe('packSelfTgz 发送侧补执行位 (B)', () => {
  it('发送侧:源 0644 → 发出的 tgz 内 bundle 恒 0755', async () => {
    if (WIN) return; // Windows 无 POSIX exec 位,本场景无意义
    const work = mkdtempSync(join(tmpdir(), 'syncx-b-'));
    const pkg = makeFakePackage(work, 'pkg', '0.2.0');
    const bundle = join(pkg, 'dist', 'syncx.js');
    chmodSync(bundle, 0o644); // 模拟本机已装产物缺 +x
    // packSelfTgz 有 16KB 体积下界守卫,假包需足够大;用不可压缩随机字节垫到超过 16KB
    writeFileSync(join(pkg, 'filler.bin'), randomBytes(40 * 1024));

    const tgz = await packSelfTgz(pkg); // 发送侧:overridePkgDir 注入假包目录
    expect(tgz).toBeDefined();

    // 解出 tgz,检查归档内 dist/syncx.js 的权限头(发送侧已补 0755)
    const root = untar(tgz!);
    const extracted = join(root, 'dist', 'syncx.js');
    expect(existsSync(extracted)).toBe(true);
    expect(hasExec(extracted)).toBe(true); // 发出的包恒 0755,接收方即便更老版本也安全
    rmSync(work, { recursive: true, force: true });
    rmSync(dirname(root), { recursive: true, force: true });
  });
});

describe('runSelfUpdate 接收侧补执行位 (A)', () => {
  it('接收侧:对端包 0644 → 换入成功的目标 bundle 补成 0755', async () => {
    if (WIN) return; // Unix 才验证 exec 位
    const work = mkdtempSync(join(tmpdir(), 'syncx-a-'));
    const install = join(work, 'install');
    mkdirSync(install, { recursive: true });
    makeFakePackage(install, 'syncx', '0.1.0'); // 旧安装 0.1.0
    const targetDir = join(install, 'syncx');

    const stagingSrc = makeFakePackage(work, 'newpkg', '0.2.0');
    const newBundle = join(stagingSrc, 'dist', 'syncx.js');
    chmodSync(newBundle, 0o644); // 对端发来的包缺 +x
    const tgz = tgzDir(stagingSrc);

    const dead = spawn(process.execPath, ['-e', 'process.exit(0)']);
    const deadPid = dead.pid as number;
    await new Promise<void>((resolve) => dead.on('exit', resolve));

    const { doneFile } = await runSelfUpdate(tgz, '0.2.0', {
      targetDir,
      minBytes: 16,
      oldPid: deadPid,
      waitMs: 10_000,
      verifyMs: 400,
      restartArgs: ['-e', 'setTimeout(() => {}, 1200)'], // 新 daemon 活过观察期
    });
    await waitForFile(doneFile);
    const result = JSON.parse(readFileSync(doneFile, 'utf8')) as { ok?: boolean; version?: string };
    expect(result.ok).toBe(true);

    // 换入成功 → 目标 bundle 必须可执行(接收侧 ensureExec 兜底对端缺 +x)
    expect(hasExec(join(targetDir, 'dist', 'syncx.js'))).toBe(true);
    expect(readFileSync(join(targetDir, 'package.json'), 'utf8')).toContain('0.2.0');
    rmSync(work, { recursive: true, force: true });
  }, 30_000);

  it('接收侧:新 daemon 立即退出回滚 → 还原的旧包(原 0644)补成 0755', async () => {
    if (WIN) return; // Unix 才验证 exec 位
    const work = mkdtempSync(join(tmpdir(), 'syncx-a-rb-'));
    const install = join(work, 'install');
    mkdirSync(install, { recursive: true });
    makeFakePackage(install, 'syncx', '0.1.0'); // 旧安装 0.1.0
    const targetDir = join(install, 'syncx');
    const oldBundle = join(targetDir, 'dist', 'syncx.js');
    chmodSync(oldBundle, 0o644); // 老包原本就缺 +x

    const stagingSrc = makeFakePackage(work, 'newpkg', '0.2.0');
    const tgz = tgzDir(stagingSrc);
    const dead = spawn(process.execPath, ['-e', 'process.exit(0)']);
    const deadPid = dead.pid as number;
    await new Promise<void>((resolve) => dead.on('exit', resolve));

    const { doneFile } = await runSelfUpdate(tgz, '0.2.0', {
      targetDir,
      minBytes: 16,
      oldPid: deadPid,
      waitMs: 10_000,
      verifyMs: 400,
      restartArgs: ['-e', 'process.exit(7)'], // 新 daemon 立即退出 → 应回滚旧包
    });
    await waitForFile(doneFile);
    const result = JSON.parse(readFileSync(doneFile, 'utf8')) as { ok?: boolean; rolledBack?: boolean };
    expect(result.ok).toBe(false);
    expect(result.rolledBack).toBe(true);

    // 回滚后还原的旧包必须可执行(修复后补位;否则老包原本 0644 会让 CLI 仍 Permission denied)
    expect(hasExec(oldBundle)).toBe(true);
    expect(readFileSync(join(targetDir, 'package.json'), 'utf8')).toContain('0.1.0');
    rmSync(work, { recursive: true, force: true });
  }, 30_000);
});

describe('main.ts 启动自修复 (C)', () => {
  it('启动自修复:副本 bundle 0644 → 首次被 node 拉起即自修为 0755', async () => {
    if (WIN) return; // Unix 才验证 exec 位
    const bundlePath = join(process.cwd(), 'dist', 'syncx.js');
    if (!existsSync(bundlePath)) return; // 未构建单文件产物时跳过(先 npm run build)

    // 复制到临时目录隔离测试,避免改动真实 dist/syncx.js
    const dir = mkdtempSync(join(tmpdir(), 'syncx-c-'));
    const copy = join(dir, 'syncx-copy.js');
    writeFileSync(copy, readFileSync(bundlePath));
    // 给副本一个能撑起 -v 的 package.json(与 bundle 同级,packageVersion 向上找到 syncx)
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@wangmingfa/syncx', version: '0.0.0-test' }));
    chmodSync(copy, 0o644); // 模拟升级后落到 0644

    const r = spawnSync(process.execPath, [copy, '-v'], { encoding: 'utf8' });
    expect(r.status).toBe(0); // 自修复在模块顶层早于参数解析,启动不依赖 exec 位
    expect(hasExec(copy)).toBe(true); // 首次被 node 拉起即自修为 0755
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('build-single 产物带执行位 (d9d7238)', () => {
  it('构建出的 dist/syncx.js 可执行', async () => {
    // 跑完整构建(含 vite web client),确保产物存在且走真实构建管线
    const r = spawnSync('npm', ['run', 'build'], { encoding: 'utf8', cwd: process.cwd(), shell: true });
    expect(r.status).toBe(0);
    const out = join(process.cwd(), 'dist', 'syncx.js');
    expect(existsSync(out)).toBe(true);
    if (!WIN) expect(hasExec(out)).toBe(true); // 非 Windows 必须带执行位
  }, 120_000);
});
