import { describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import {
  consumeUpdateDoneFile,
  extractAndValidate,
  inspectPackage,
  isSafePtyRange,
  packSelfTgz,
  runSelfUpdate,
  sha256Hex,
} from '../src/selfupdate.js';

/** 等待文件出现(updater 结果文件),超时抛错。 */
async function waitForFile(path: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`等待超时: ${path}`);
}

/** 造一个可实跑的假安装目录:package.json + dist/syncx.js(-v 读旁边 package.json,与真 bundle 同口径)。 */
function makeFakePackage(parent: string, name: string, version: string): string {
  const root = join(parent, name);
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: '@wangmingfa/syncx', version }),
  );
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

/** 用系统 tar 把目录打成 tgz(与生产 P2P 发送侧同一条路径;相对归档名避 GNU tar 的 C: 陷阱)。 */
function tgzDir(dir: string): Buffer {
  const work = mkdtempSync(join(tmpdir(), 'syncx-test-tgz-'));
  const r = spawnSync('tar', ['-czf', 'out.tgz', '-C', dir, '.'], { encoding: 'utf8', cwd: work });
  if (r.status !== 0) throw new Error(`tar 打包失败: ${r.stderr}`);
  const buf = readFileSync(join(work, 'out.tgz'));
  rmSync(work, { recursive: true, force: true });
  return buf;
}

describe('sha256Hex', () => {
  it('produces a stable hex digest', () => {
    const data = Buffer.from('syncx package content');
    const a = sha256Hex(data);
    const b = sha256Hex(Buffer.from('syncx package content'));

    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
  });

  it('differs for different content (even 1 byte)', () => {
    const a = sha256Hex(Buffer.alloc(64 * 1024, 0x41));
    const b = sha256Hex(Buffer.alloc(64 * 1024, 0x42));

    expect(a).not.toBe(b);
  });

  it('matches an independently computed sha256', () => {
    const data = Buffer.alloc(48 * 1024, 0x20);
    const expected = createHash('sha256').update(data).digest('hex');

    expect(sha256Hex(data)).toBe(expected);
  });
});

describe('packSelfTgz', () => {
  it('returns undefined in dev runtime', async () => {
    // vitest / tsx 下 import.meta.url 指向 .ts → dev 态,没有可打包的安装目录
    await expect(packSelfTgz()).resolves.toBeUndefined();
  });

  /**
   * node_modules 绝不能进整包。updater 换包成功后会在**安装目录里**现装 node-pty
   * (原生模块,单文件 bundle 带不走),于是安装目录旁就多了几十 MB。接收方不依赖那个目录
   * (bundle 自包含,只缺 node-pty,而它会由对端自己的 updater 现装),而带着它打包会顶穿
   * MIN/MAX_PACKAGE_BYTES 或 30 秒 tar 超时 → packSelfTgz 静默返回 undefined →
   * 「发给对端升级」变成「不可用」。
   */
  it('excludes node_modules from the packed payload', async () => {
    const work = mkdtempSync(join(tmpdir(), 'syncx-test-pack-'));
    const pkgDir = makeFakePackage(work, 'pkg', '0.2.0');
    // 撑过 MIN_PACKAGE_BYTES(16KB),否则 packSelfTgz 走到体积闸门就返回 undefined。
    // 必须用随机字节:'a'.repeat(40K) 压完只剩几十字节,过不了这道闸。
    writeFileSync(join(pkgDir, 'dist', 'blob.bin'), randomBytes(40 * 1024));
    mkdirSync(join(pkgDir, 'node_modules', 'node-pty', 'build'), { recursive: true });
    writeFileSync(
      join(pkgDir, 'node_modules', 'node-pty', 'package.json'),
      JSON.stringify({ name: 'node-pty', version: '1.1.0' }),
    );
    writeFileSync(join(pkgDir, 'node_modules', 'node-pty', 'build', 'pty.node'), randomBytes(64 * 1024));

    const tgz = await packSelfTgz(pkgDir);
    expect(tgz).toBeInstanceOf(Buffer);

    const tgzPath = join(work, 'packed.tgz');
    writeFileSync(tgzPath, tgz as unknown as Buffer);
    const listed = spawnSync('tar', ['-tzf', tgzPath], { encoding: 'utf8' });
    expect(listed.status).toBe(0);
    expect(listed.stdout).not.toContain('node_modules');
    // 排除不能把正包一起排除掉
    expect(listed.stdout).toContain('dist/syncx.js');
    expect(listed.stdout).toContain('package.json');
    rmSync(work, { recursive: true, force: true });
  });
});

describe('isSafePtyRange', () => {
  it('accepts the ranges npm actually uses', () => {
    for (const range of ['^1.1.0', '~1.1.0', '1.1.0', '>=1.0.0 <2.0.0', '^1.0.0 || ^2.0.0', '*']) {
      expect(isSafePtyRange(range), range).toBe(true);
    }
  });

  /**
   * 这条范围来自**新包的 package.json**,P2P 路径上就是「对端写的字符串」,
   * 而 Windows 侧的 npm.cmd 还要经 shell 拼接。判据宁可窄:误杀只是终端落受限模式,
   * 放进 shell 就是别人的机器在跑别人写的命令行。
   */
  it('rejects anything that could reach a shell', () => {
    for (const range of [
      '1.0.0; touch /tmp/pwned',
      '1.0.0 && rm -rf .',
      '^1.0.0 || $(curl evil)',
      '1.0.0 `id`',
      '1.0.0%PATH%',
      'file:../../evil',
      'C:\\windows\\system32',
      'npm:other@1',
      'x'.repeat(200),
      123,
      undefined,
      null,
      { x: 1 },
    ]) {
      expect(isSafePtyRange(range), String(range)).toBe(false);
    }
  });
});

describe('extractAndValidate', () => {
  it('extracts and validates a well-formed package', async () => {
    const work = mkdtempSync(join(tmpdir(), 'syncx-test-pkg-'));
    const pkgDir = makeFakePackage(work, 'pkg', '0.2.0');
    const tgz = tgzDir(pkgDir);

    const staging = await extractAndValidate(tgz, '0.2.0', { minBytes: 16 });

    expect(readFileSync(join(staging.root, 'package.json'), 'utf8')).toContain('0.2.0');
    expect(existsSync(join(staging.root, 'dist', 'syncx.js'))).toBe(true);
    expect(existsSync(join(staging.workDir, 'pkg.tgz'))).toBe(true);
    rmSync(work, { recursive: true, force: true });
  });

  it('rejects version mismatch between package.json and declared version', async () => {
    const work = mkdtempSync(join(tmpdir(), 'syncx-test-pkg-'));
    const pkgDir = makeFakePackage(work, 'pkg', '9.9.9');
    const tgz = tgzDir(pkgDir);

    await expect(extractAndValidate(tgz, '0.2.0', { minBytes: 16 })).rejects.toThrow('与宣告');
    rmSync(work, { recursive: true, force: true });
  });

  it('rejects corrupt tarballs', async () => {
    const garbage = Buffer.concat([Buffer.from('not a tarball at all'), Buffer.alloc(64 * 1024, 0x20)]);

    await expect(extractAndValidate(garbage, '0.2.0', { minBytes: 16 })).rejects.toThrow('tar 解压');
  });

  it('rejects undersized payloads before touching tar', async () => {
    await expect(extractAndValidate(Buffer.from('x'), '0.2.0')).rejects.toThrow('疑似损坏');
  });
});

describe('runSelfUpdate', () => {
  it('swaps the target directory and reports success via done file', async () => {
    const work = mkdtempSync(join(tmpdir(), 'syncx-test-swap-'));
    const install = join(work, 'install');
    mkdirSync(install, { recursive: true });
    // 「旧安装」:0.1.0
    makeFakePackage(install, 'syncx', '0.1.0');
    const targetDir = join(install, 'syncx');
    // 新包 tgz:0.2.0
    const stagingSrc = makeFakePackage(work, 'newpkg', '0.2.0');
    const tgz = tgzDir(stagingSrc);
    // 一个必死的进程作为「旧进程」:updater 的 alive() 立即返回 false
    const dead = spawn(process.execPath, ['-e', 'process.exit(0)']);
    const deadPid = dead.pid as number;
    await new Promise<void>((resolve) => dead.on('exit', resolve));

    const { doneFile } = await runSelfUpdate(tgz, '0.2.0', {
      targetDir,
      minBytes: 16,
      oldPid: deadPid,
      waitMs: 10_000,
      verifyMs: 400,
      // 「新 daemon」:活 1.2 秒,超过 400ms 观察期即视为启动成功
      restartArgs: ['-e', 'setTimeout(() => {}, 1200)'],
    });

    await waitForFile(doneFile);
    const result = JSON.parse(readFileSync(doneFile, 'utf8')) as { ok?: boolean; version?: string };
    expect(result.ok).toBe(true);
    expect(result.version).toBe('0.2.0');
    // 目标目录已被换入新包
    expect(readFileSync(join(targetDir, 'package.json'), 'utf8')).toContain('0.2.0');
    // 旧包备份已清理
    expect(existsSync(join(install, '.syncx-update-backup'))).toBe(false);
    rmSync(work, { recursive: true, force: true });
  }, 30_000);

  /**
   * 生成的 updater 脚本本身也要能被审 —— 它是唯一跑在「旧进程已死、包已换入」之后的代码,
   * 而 macOS/Linux 上永远执行不到 Windows 那一支。这里用静态断言把两条分支的形状钉死:
   * 早先的实现把整条命令拼成一个字符串、只在 Windows 开 shell,于是 POSIX 下
   * Node 拿整个字符串去 execvp → ENOENT,node-pty 在 Mac/Linux 上一次都没装上过,
   * 而这个形状在本机上任何测试都看不出来。
   */
  it('generates an updater script whose npm call is split by platform', async () => {
    const work = mkdtempSync(join(tmpdir(), 'syncx-test-gen-'));
    const install = join(work, 'install');
    mkdirSync(install, { recursive: true });
    makeFakePackage(install, 'syncx', '0.1.0');
    const stagingSrc = makeFakePackage(work, 'newpkg', '0.2.0');
    const tgz = tgzDir(stagingSrc);
    const dead = spawn(process.execPath, ['-e', 'process.exit(0)']);
    const deadPid = dead.pid as number;
    await new Promise<void>((resolve) => dead.on('exit', resolve));

    const { doneFile } = await runSelfUpdate(tgz, '0.2.0', {
      targetDir: join(install, 'syncx'),
      minBytes: 16,
      oldPid: deadPid,
      waitMs: 10_000,
      verifyMs: 400,
      restartArgs: ['-e', 'setTimeout(() => {}, 1200)'],
    });
    await waitForFile(doneFile);

    const updaterFile = join(dirname(doneFile), 'updater.mjs');
    const code = readFileSync(updaterFile, 'utf8');
    // 生成的脚本必须真的可解析(它是独立 ES 模块,拼错一个引号就等于升级整条路径报废)
    const check = spawnSync(process.execPath, ['--check', updaterFile], { encoding: 'utf8' });
    expect(check.status, check.stderr).toBe(0);

    expect(code).toContain("spawnSync('npm', args, opts)"); // POSIX:argv
    expect(code).toContain(String.raw`'\"' + spec + '\"'`); // Windows:spec 裹在双引号里
    expect(code).not.toContain('shell: isWin'); // 老 bug 的形状:单串命令 + 只有 Windows 开 shell
    rmSync(work, { recursive: true, force: true });
  }, 60_000);

  /**
   * node-pty 安装步骤(封闭验证:PATH 上放一个假 npm,不碰网络)。
   *
   * 假 npm 会在**它被调用时的 cwd** 落一个 node_modules/node-pty 标记 ——
   * 这恰好同时钉住两件事:updater 确实调了 npm;且 cwd 是 targetDir
   * (装到别处的话,`import('node-pty')` 从 dist/syncx.js 向上解析是找不到的)。
   */
  it('updater installs node-pty into the target when the package declares it', async () => {
    const work = mkdtempSync(join(tmpdir(), 'syncx-test-pty-'));
    const install = join(work, 'install');
    mkdirSync(install, { recursive: true });
    makeFakePackage(install, 'syncx', '0.1.0');
    const targetDir = join(install, 'syncx');
    const stagingSrc = makeFakePackage(work, 'newpkg', '0.2.0');
    // 新包声明 node-pty 依赖 → 触发 updater 的安装步骤
    const pkgPath = join(stagingSrc, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { dependencies?: Record<string, string> };
    pkg.dependencies = { 'node-pty': '^1.1.0' };
    writeFileSync(pkgPath, JSON.stringify(pkg));
    const tgz = tgzDir(stagingSrc);

    const fakeBin = join(work, 'fakebin');
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(
      join(fakeBin, 'npm'),
      '#!/bin/sh\nmkdir -p node_modules/node-pty\n' +
        'printf \'{"name":"node-pty","version":"9.9.9-fake"}\' > node_modules/node-pty/package.json\nexit 0\n',
      { mode: 0o755 },
    );
    writeFileSync(
      join(fakeBin, 'npm.cmd'),
      [
        '@echo off',
        'if not exist node_modules\\node-pty mkdir node_modules\\node-pty',
        'echo {"name":"node-pty","version":"9.9.9-fake"} > node_modules\\node-pty\\package.json',
        'exit /b 0',
      ].join('\r\n'),
    );
    const prevPath = process.env.PATH ?? '';
    process.env.PATH = `${fakeBin}${delimiter}${prevPath}`;

    const dead = spawn(process.execPath, ['-e', 'process.exit(0)']);
    const deadPid = dead.pid as number;
    await new Promise<void>((resolve) => dead.on('exit', resolve));

    try {
      const { doneFile } = await runSelfUpdate(tgz, '0.2.0', {
        targetDir,
        minBytes: 16,
        oldPid: deadPid,
        waitMs: 10_000,
        verifyMs: 400,
        restartArgs: ['-e', 'setTimeout(() => {}, 1200)'],
      });

      await waitForFile(doneFile);
      const result = JSON.parse(readFileSync(doneFile, 'utf8')) as {
        ok?: boolean;
        pty?: { attempted?: boolean; ok?: boolean; error?: string };
      };
      expect(result.ok).toBe(true);
      expect(result.pty).toEqual({ attempted: true, ok: true, error: '' });
      // 假 npm 在 targetDir 里执行过:原生模块落在解析路径上
      expect(existsSync(join(targetDir, 'node_modules', 'node-pty', 'package.json'))).toBe(true);
    } finally {
      process.env.PATH = prevPath;
      rmSync(work, { recursive: true, force: true });
    }
  }, 60_000);

  it('pty install failure must not roll back the upgrade (终端只是降级,升级不算失败)', async () => {
    const work = mkdtempSync(join(tmpdir(), 'syncx-test-ptyfail-'));
    const install = join(work, 'install');
    mkdirSync(install, { recursive: true });
    makeFakePackage(install, 'syncx', '0.1.0');
    const targetDir = join(install, 'syncx');
    const stagingSrc = makeFakePackage(work, 'newpkg', '0.2.0');
    const pkgPath = join(stagingSrc, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { dependencies?: Record<string, string> };
    pkg.dependencies = { 'node-pty': '^1.1.0' };
    writeFileSync(pkgPath, JSON.stringify(pkg));
    const tgz = tgzDir(stagingSrc);

    const fakeBin = join(work, 'fakebin');
    mkdirSync(fakeBin, { recursive: true });
    // 必败的假 npm
    writeFileSync(join(fakeBin, 'npm'), '#!/bin/sh\nexit 3\n', { mode: 0o755 });
    writeFileSync(join(fakeBin, 'npm.cmd'), ['@echo off', 'exit /b 3'].join('\r\n'));
    const prevPath = process.env.PATH ?? '';
    process.env.PATH = `${fakeBin}${delimiter}${prevPath}`;

    const dead = spawn(process.execPath, ['-e', 'process.exit(0)']);
    const deadPid = dead.pid as number;
    await new Promise<void>((resolve) => dead.on('exit', resolve));

    try {
      const { doneFile } = await runSelfUpdate(tgz, '0.2.0', {
        targetDir,
        minBytes: 16,
        oldPid: deadPid,
        waitMs: 10_000,
        verifyMs: 400,
        restartArgs: ['-e', 'setTimeout(() => {}, 1200)'],
      });

      await waitForFile(doneFile);
      const result = JSON.parse(readFileSync(doneFile, 'utf8')) as {
        ok?: boolean;
        rolledBack?: boolean;
        pty?: { attempted?: boolean; ok?: boolean; error?: string };
      };
      // 升级本体算成功;pty 失败只如实记录
      expect(result.ok).toBe(true);
      expect(result.rolledBack).toBeUndefined();
      expect(result.pty?.attempted).toBe(true);
      expect(result.pty?.ok).toBe(false);
      // 必须钉住「失败原因」而不只是 ok=false:早先版本只断言 ok=false,于是 npm
      // 压根没被拉起来(POSIX 下 spawnSync 拿到整条命令串 → ENOENT)时用例照样绿,
      // 这个阻塞级 bug 就这么跟着提交上了主干。
      expect(result.pty?.error).toContain('退出码 3');
    } finally {
      process.env.PATH = prevPath;
      rmSync(work, { recursive: true, force: true });
    }
  }, 60_000);

  /**
   * 对端来的包里塞一条「能拼进命令行」的 node-pty 范围:升级照做,npm 照旧不执行。
   *
   * 判据是 done 文件里的原因文案 + 两个「不该出现的文件」:假 npm 留下的调用标记,
   * 以及被注入命令真跑起来才会落地的 pwned.txt。少断一半都行,但整条路径只在
   * 「npm 从未被拉起」时同时成立 —— 这正是白名单要保住的东西。
   */
  it('refuses to hand a peer-authored node-pty range to npm, and still upgrades', async () => {
    const work = mkdtempSync(join(tmpdir(), 'syncx-test-ptyevil-'));
    const install = join(work, 'install');
    mkdirSync(install, { recursive: true });
    makeFakePackage(install, 'syncx', '0.1.0');
    const targetDir = join(install, 'syncx');
    const stagingSrc = makeFakePackage(work, 'newpkg', '0.2.0');
    const pkgPath = join(stagingSrc, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { dependencies?: Record<string, string> };
    pkg.dependencies = { 'node-pty': '1.0.0; touch pwned.txt' };
    writeFileSync(pkgPath, JSON.stringify(pkg));
    const tgz = tgzDir(stagingSrc);

    const fakeBin = join(work, 'fakebin');
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(join(fakeBin, 'npm'), '#!/bin/sh\ntouch npm-ran.txt\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(fakeBin, 'npm.cmd'), ['@echo off', 'type nul > npm-ran.txt', 'exit /b 0'].join('\r\n'));
    const prevPath = process.env.PATH ?? '';
    process.env.PATH = `${fakeBin}${delimiter}${prevPath}`;

    const dead = spawn(process.execPath, ['-e', 'process.exit(0)']);
    const deadPid = dead.pid as number;
    await new Promise<void>((resolve) => dead.on('exit', resolve));

    try {
      const { doneFile } = await runSelfUpdate(tgz, '0.2.0', {
        targetDir,
        minBytes: 16,
        oldPid: deadPid,
        waitMs: 10_000,
        verifyMs: 400,
        restartArgs: ['-e', 'setTimeout(() => {}, 1200)'],
      });

      await waitForFile(doneFile);
      const result = JSON.parse(readFileSync(doneFile, 'utf8')) as {
        ok?: boolean;
        pty?: { attempted?: boolean; ok?: boolean; error?: string };
      };
      expect(result.ok).toBe(true);
      expect(result.pty?.attempted).toBe(false);
      expect(result.pty?.ok).toBe(false);
      expect(result.pty?.error).toContain('已跳过安装');
      expect(existsSync(join(targetDir, 'npm-ran.txt'))).toBe(false);
      expect(existsSync(join(targetDir, 'pwned.txt'))).toBe(false);
    } finally {
      process.env.PATH = prevPath;
      rmSync(work, { recursive: true, force: true });
    }
  }, 60_000);

  it('rolls back to the old package when the new daemon dies immediately', async () => {
    const work = mkdtempSync(join(tmpdir(), 'syncx-test-rb-'));
    const install = join(work, 'install');
    mkdirSync(install, { recursive: true });
    makeFakePackage(install, 'syncx', '0.1.0');
    const targetDir = join(install, 'syncx');
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
      // 「新 daemon」:立即退出 → updater 应回滚旧包
      restartArgs: ['-e', 'process.exit(7)'],
    });

    await waitForFile(doneFile);
    const result = JSON.parse(readFileSync(doneFile, 'utf8')) as { ok?: boolean; rolledBack?: boolean };
    expect(result.ok).toBe(false);
    expect(result.rolledBack).toBe(true);
    // 旧包被还原
    expect(readFileSync(join(targetDir, 'package.json'), 'utf8')).toContain('0.1.0');
    expect(existsSync(join(targetDir, 'dist', 'syncx.js'))).toBe(true);
    rmSync(work, { recursive: true, force: true });
  }, 30_000);
});

describe('上传来源:包内自带版本(无宣告)', () => {
  it('extractAndValidate 传 undefined 时采用包内版本', async () => {
    const work = mkdtempSync(join(tmpdir(), 'syncx-test-nover-'));
    const pkgDir = makeFakePackage(work, 'pkg', '1.4.0');
    const tgz = tgzDir(pkgDir);

    const staged = await extractAndValidate(tgz, undefined, { minBytes: 16, verify: false });

    expect(staged.version).toBe('1.4.0');
    rmSync(staged.workDir, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });

  it('inspectPackage 读出包内版本与包名,并清理临时目录', async () => {
    const work = mkdtempSync(join(tmpdir(), 'syncx-test-inspect-'));
    const pkgDir = makeFakePackage(work, 'pkg', '0.3.1');
    const tgz = tgzDir(pkgDir);

    const info = await inspectPackage(tgz, { minBytes: 16, verify: false });

    expect(info.version).toBe('0.3.1');
    expect(info.name).toBe('@wangmingfa/syncx');
    rmSync(work, { recursive: true, force: true });
  });

  it('inspectPackage 拒绝版本号非法的包', async () => {
    const work = mkdtempSync(join(tmpdir(), 'syncx-test-inspect-bad-'));
    const root = join(work, 'pkg');
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'syncx', version: 'not-a-version' }));
    writeFileSync(join(root, 'dist', 'syncx.js'), '#!/usr/bin/env node\nprocess.exit(0);\n');
    const tgz = tgzDir(root);

    await expect(inspectPackage(tgz, { minBytes: 16, verify: false })).rejects.toThrow('版本号异常');
    rmSync(work, { recursive: true, force: true });
  });

  it('上传包整包替换后按包内版本落地', async () => {
    const work = mkdtempSync(join(tmpdir(), 'syncx-test-upload-'));
    const install = join(work, 'install');
    mkdirSync(install, { recursive: true });
    makeFakePackage(install, 'syncx', '0.1.0');
    const targetDir = join(install, 'syncx');
    const stagingSrc = makeFakePackage(work, 'newpkg', '0.5.0');
    const tgz = tgzDir(stagingSrc);
    const dead = spawn(process.execPath, ['-e', 'process.exit(0)']);
    const deadPid = dead.pid as number;
    await new Promise<void>((resolve) => dead.on('exit', resolve));

    const { doneFile, version } = await runSelfUpdate(tgz, undefined, {
      targetDir,
      minBytes: 16,
      verify: false,
      oldPid: deadPid,
      waitMs: 10_000,
      verifyMs: 400,
      restartArgs: ['-e', 'setTimeout(() => {}, 1200)'],
    });

    expect(version).toBe('0.5.0');
    await waitForFile(doneFile);
    const result = JSON.parse(readFileSync(doneFile, 'utf8')) as { ok?: boolean; version?: string };
    expect(result.ok).toBe(true);
    expect(result.version).toBe('0.5.0');
    expect(readFileSync(join(targetDir, 'package.json'), 'utf8')).toContain('0.5.0');
    rmSync(work, { recursive: true, force: true });
  }, 30_000);
});

describe('consumeUpdateDoneFile', () => {
  /** 造结果文件并消费它,返回记下的日志。 */
  function report(result: unknown): { info: string[]; warn: string[] } {
    const work = mkdtempSync(join(tmpdir(), 'syncx-test-done-'));
    const p = join(work, 'update-done.json');
    const logs = { info: [] as string[], warn: [] as string[] };
    const logger = {
      info: (m: string) => logs.info.push(m),
      warn: (m: string) => logs.warn.push(m),
    };
    try {
      writeFileSync(p, JSON.stringify(result));
      consumeUpdateDoneFile(logger, p);
      // 用后即删:新 daemon 不该在下次启动时重放这次的结果
      expect(existsSync(p)).toBe(false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
    return logs;
  }

  it('reports a successful pty install as full mode', () => {
    const logs = report({ ok: true, version: '0.2.0', pty: { attempted: true, ok: true, error: '' } });

    expect(logs.warn).toEqual([]);
    expect(logs.info.join('\n')).toContain('完整模式');
  });

  it('logs the reason when npm ran and failed', () => {
    const logs = report({
      ok: true,
      version: '0.2.0',
      pty: { attempted: true, ok: false, error: 'npm 退出码 3: preinstall script failed' },
    });

    expect(logs.info.join('\n')).not.toContain('完整模式');
    expect(logs.warn.join('\n')).toContain('安装失败');
    expect(logs.warn.join('\n')).toContain('退出码 3');
  });

  /**
   * 「未执行」同样必须留痕:白名单挡下可疑范围时终端一样是受限的,
   * 只记 attempted=true 的那一支就等于把这条降级重新变回静默。
   */
  it('logs the reason even when npm was never invoked', () => {
    const logs = report({
      ok: true,
      version: '0.2.0',
      pty: { attempted: false, ok: false, error: '包声明的 node-pty 版本范围不适合作为命令行参数执行,已跳过安装' },
    });

    expect(logs.info.join('\n')).not.toContain('完整模式');
    expect(logs.warn.join('\n')).toContain('未安装');
    expect(logs.warn.join('\n')).toContain('已跳过安装');
  });
});

describe('源码仓库护栏', () => {
  it('目标目录疑似源码仓库时拒绝整包替换,源码原样保留', async () => {
    const work = mkdtempSync(join(tmpdir(), 'syncx-test-guard-'));
    // 造一个「仓库根」:含 src/main.ts,整包替换会把它删掉
    const repo = join(work, 'repo');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'main.ts'), '// source entry\n');
    makeFakePackage(work, 'newpkg', '0.2.0');
    const tgz = tgzDir(join(work, 'newpkg'));

    await expect(
      runSelfUpdate(tgz, '0.2.0', { targetDir: repo, minBytes: 16, verify: false }),
    ).rejects.toThrow('源码仓库');

    // 关键:拒绝必须是「什么都没动」,源码原样保留
    expect(existsSync(join(repo, 'src', 'main.ts'))).toBe(true);
    rmSync(work, { recursive: true, force: true });
  });
});
