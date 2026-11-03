import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as net from 'node:net';
import { dirname, join } from 'node:path';
import {
  KNOWN_TARGET_TRIPLES,
  controlPortFromArgs,
  decideSwapAction,
  detectArchiveType,
  extractBackendPackage,
  localTargetTriple,
  parseBackendStageName,
  runBackendSwap,
  sniffBackendPackage,
} from '../src/backend-swap.js';

/** 等待文件出现,超时抛错(与 selfupdate.test.ts 同款)。 */
async function waitForFile(path: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`等待超时: ${path}`);
}

/** 把目录打成 tgz(相对归档名,避 GNU tar 的 C: 陷阱)。 */
function tgzDir(dir: string): Buffer {
  const work = mkdtempSync(join(tmpdir(), 'syncx-test-tgz-'));
  const r = spawnSync('tar', ['-czf', 'out.tgz', '-C', dir, '.'], { encoding: 'utf8', cwd: work });
  if (r.status !== 0) throw new Error(`tar 打包失败: ${r.stderr}`);
  const buf = readFileSync(join(work, 'out.tgz'));
  rmSync(work, { recursive: true, force: true });
  return buf;
}

/**
 * 造一个假的后端安装包目录:`syncx-<rs|mbt>-v<version>-<triple>/syncx-rs|syncx-mb`。
 * binaryContent 会补注释撑过「二进制 >= 1KB」的体积闸门。
 */
function makeBackendPackage(
  parent: string,
  kind: 'rs' | 'mbt',
  version: string,
  triple: string,
  binaryContent: string,
): string {
  const binName = kind === 'rs' ? 'syncx-rs' : 'syncx-mb';
  const root = join(parent, `syncx-${kind}-v${version}-${triple}`);
  mkdirSync(root, { recursive: true });
  const padded = `${binaryContent}\n/* padding: ${'x'.repeat(1200)} */\n`;
  writeFileSync(join(root, binName), padded, { mode: 0o755 });
  return root;
}

/** 造一个假的 npm 载体包(顶层 package/,与 pack:local 缺省产物同构)。 */
function makeNodePackage(parent: string, version: string): string {
  const root = join(parent, 'package');
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@wangmingfa/syncx', version }));
  writeFileSync(join(root, 'dist', 'syncx.js'), '#!/usr/bin/env node\nprocess.exit(0);\n');
  return root;
}

/** 起一个必死进程当「旧进程」,返回已退出的 pid。 */
async function deadPid(): Promise<number> {
  const dead = spawn(process.execPath, ['-e', 'process.exit(0)']);
  const pid = dead.pid as number;
  await new Promise<void>((resolve) => dead.on('exit', resolve));
  return pid;
}

/** 找一个空闲 TCP 端口(先听 0 拿端口再立刻释放,测试体量下竞态可忽略)。 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo;
      const port = addr.port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

describe('parseBackendStageName / localTargetTriple', () => {
  it('解析 rust 资产名(带预发布版本)', () => {
    expect(parseBackendStageName('syncx-rs-v0.2.14-local.1-aarch64-apple-darwin')).toEqual({
      backend: 'rust',
      version: '0.2.14-local.1',
      target: 'aarch64-apple-darwin',
    });
  });

  it('解析 moonbit 资产名', () => {
    expect(parseBackendStageName('syncx-mbt-v1.2.3-x86_64-unknown-linux-gnu')).toEqual({
      backend: 'moonbit',
      version: '1.2.3',
      target: 'x86_64-unknown-linux-gnu',
    });
  });

  it('npm 载体目录名与乱名一律不认', () => {
    expect(parseBackendStageName('package')).toBeNull();
    expect(parseBackendStageName('syncx-0.2.14')).toBeNull();
    expect(parseBackendStageName('syncx-rs-v0.2.14-unknown-target-xyz')).toBeNull();
    expect(parseBackendStageName('syncx-rs-vnot-semver-aarch64-apple-darwin')).toBeNull();
  });

  it('本机三元组在已知矩阵内', () => {
    expect(KNOWN_TARGET_TRIPLES).toContain(localTargetTriple());
  });
});

describe('sniffBackendPackage / extractBackendPackage', () => {
  it('识别 rust 安装包并完成结构校验', async () => {
    const work = mkdtempSync(join(tmpdir(), 'syncx-test-rs-'));
    try {
      makeBackendPackage(work, 'rs', '0.2.14', localTargetTriple(), 'fake-binary');
      const tgz = tgzDir(work);
      expect(await sniffBackendPackage(tgz)).toEqual({
        backend: 'rust',
        version: '0.2.14',
        target: localTargetTriple(),
      });
      const pkg = await extractBackendPackage(tgz, { minBytes: 16 });
      expect(pkg.backend).toBe('rust');
      expect(pkg.version).toBe('0.2.14');
      expect(existsSync(pkg.binaryPath)).toBe(true);
      rmSync(pkg.workDir, { recursive: true, force: true });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('识别 moonbit 安装包', async () => {
    const work = mkdtempSync(join(tmpdir(), 'syncx-test-mbt-'));
    try {
      makeBackendPackage(work, 'mbt', '0.3.0-beta.2', localTargetTriple(), 'fake-binary');
      const tgz = tgzDir(work);
      expect(await sniffBackendPackage(tgz)).toEqual({
        backend: 'moonbit',
        version: '0.3.0-beta.2',
        target: localTargetTriple(),
      });
      const pkg = await extractBackendPackage(tgz, { minBytes: 16 });
      expect(pkg.backend).toBe('moonbit');
      expect(pkg.binaryPath.endsWith('syncx-mb')).toBe(true);
      rmSync(pkg.workDir, { recursive: true, force: true });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('npm tgz 嗅探为 null(走既有 Node 管线)', async () => {
    const work = mkdtempSync(join(tmpdir(), 'syncx-test-nodetgz-'));
    try {
      makeNodePackage(work, '0.4.1');
      expect(await sniffBackendPackage(tgzDir(work))).toBeNull();
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('坏包(缺二进制)拒绝', async () => {
    const work = mkdtempSync(join(tmpdir(), 'syncx-test-badpkg-'));
    try {
      // 顶层目录名对得上,但没有 syncx-rs 二进制
      const root = join(work, `syncx-rs-v0.2.14-${localTargetTriple()}`);
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'README.md'), 'x'.repeat(4096));
      const tgz = tgzDir(work);
      await expect(extractBackendPackage(tgz, { minBytes: 16 })).rejects.toThrow('缺少二进制');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('目标平台与本机不符拒绝', async () => {
    const work = mkdtempSync(join(tmpdir(), 'syncx-test-triple-'));
    try {
      const other = localTargetTriple() === 'aarch64-apple-darwin' ? 'x86_64-apple-darwin' : 'aarch64-apple-darwin';
      makeBackendPackage(work, 'rs', '0.2.14', other, 'fake-binary');
      const tgz = tgzDir(work);
      await expect(extractBackendPackage(tgz, { minBytes: 16, expectTarget: localTargetTriple() })).rejects.toThrow(
        '目标平台',
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('zip 载体(Windows 资产)直接给出明确指引', async () => {
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)]);
    expect(detectArchiveType(zip)).toBe('zip');
    await expect(sniffBackendPackage(zip)).rejects.toThrow('.zip');
  });
});

describe('decideSwapAction(换入决策,纯逻辑)', () => {
  const triple = localTargetTriple();

  it('打包态 + rust 包 → 换入', () => {
    expect(
      decideSwapAction({ packageBackend: 'rust', runningBundled: true, packageTarget: triple, localTriple: triple }),
    ).toEqual({ action: 'backend-swap', backend: 'rust' });
  });

  it('打包态 + moonbit 包 → 换入', () => {
    expect(
      decideSwapAction({ packageBackend: 'moonbit', runningBundled: true, packageTarget: triple, localTriple: triple }),
    ).toEqual({ action: 'backend-swap', backend: 'moonbit' });
  });

  it('dev 态(tsx watch / node dist 调试)拒绝跨后端换入并给出指引', () => {
    const d = decideSwapAction({ packageBackend: 'rust', runningBundled: false, packageTarget: triple, localTriple: triple });
    expect(d.action).toBe('reject');
    if (d.action === 'reject') expect(d.reason).toContain('跨后端换入');
  });

  it('dev 态的 node 包升级同样拒绝', () => {
    const d = decideSwapAction({ packageBackend: 'node', runningBundled: false });
    expect(d.action).toBe('reject');
  });

  it('打包态 + node 包 → 走既有 npm 管线', () => {
    expect(decideSwapAction({ packageBackend: 'node', runningBundled: true })).toEqual({ action: 'node-update' });
  });

  it('目标平台不符拒绝', () => {
    const d = decideSwapAction({
      packageBackend: 'rust',
      runningBundled: true,
      packageTarget: 'x86_64-unknown-linux-gnu',
      localTriple: 'aarch64-apple-darwin',
    });
    expect(d.action).toBe('reject');
    if (d.action === 'reject') expect(d.reason).toContain('x86_64-unknown-linux-gnu');
  });

  it('控制端口从启动参数解析,缺失回落 8384', () => {
    expect(controlPortFromArgs(['start', '--control-port', '9527', '--config', 'x'])).toBe(9527);
    expect(controlPortFromArgs(['start', '--config', 'x'])).toBe(8384);
  });
});

describe('runBackendSwap(冒烟:真实目录 + 假二进制)', () => {
  // 假二进制靠 shebang 直接 exec,Windows 上没有这层语义,只在类 Unix 冒烟
  it.skipIf(process.platform === 'win32')(
    '健康通过:二进制落 bin/、done 记录 ok',
    async () => {
      const work = mkdtempSync(join(tmpdir(), 'syncx-test-swapok-'));
      try {
        const port = await freePort();
        // 假后端二进制:监听 --control-port 指定的端口并对 /health 回 200(与真后端探活契约一致)
        const fakeBin = [
          '#!/usr/bin/env node',
          "const http = require('node:http');",
          'const i = process.argv.indexOf("--control-port");',
          'const port = Number(process.argv[i + 1]);',
          "http.createServer((req, res) => { res.writeHead(200, {'content-type':'text/plain'}); res.end('ok'); }).listen(port, '127.0.0.1');",
          `/* padding: ${'x'.repeat(1200)} */`,
          '',
        ].join('\n');
        makeBackendPackage(work, 'rs', '0.2.14', localTargetTriple(), fakeBin);
        const tgz = tgzDir(work);
        const configDir = join(work, 'config');
        const installDir = join(configDir, 'bin');
        const pid = await deadPid();

        const { doneFile } = await runBackendSwap(tgz, {
          configDir,
          installDir,
          controlPort: port,
          oldPid: pid,
          waitMs: 10_000,
          healthTimeoutMs: 10_000,
          minBytes: 16,
          allowDevRuntime: true,
          daemonArgs: ['start', '--control-port', String(port)],
          restartArgs: ['-e', 'process.exit(0)'], // 成功路径不应触发回滚
        });

        await waitForFile(doneFile);
        const result = JSON.parse(readFileSync(doneFile, 'utf8')) as { ok?: boolean; pid?: number; backend?: string; version?: string };
        expect(result.ok).toBe(true);
        expect(result.backend).toBe('rust');
        expect(result.version).toBe('0.2.14');
        // 二进制确实装进了数据目录,且带可执行位
        const installed = join(installDir, 'syncx-rs');
        expect(existsSync(installed)).toBe(true);
        expect(statSync(installed).mode & 0o111).not.toBe(0);
        // 解包现场被 swapper 清掉
        expect(existsSync(join(dirname(doneFile), 'extract'))).toBe(false);
        if (result.pid) {
          try {
            process.kill(result.pid, 'SIGKILL'); // 收掉假 daemon
          } catch {
            /* 已退出则无需收 */
          }
        }
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it.skipIf(process.platform === 'win32')(
    '新二进制立即退出:回滚并拉回原 node 进程',
    async () => {
      const work = mkdtempSync(join(tmpdir(), 'syncx-test-swaprb-'));
      try {
        makeBackendPackage(work, 'rs', '0.2.14', localTargetTriple(), '#!/usr/bin/env node\nprocess.exit(7);');
        const tgz = tgzDir(work);
        const configDir = join(work, 'config');
        const rollbackMarker = join(work, 'rolled-back.txt');
        const pid = await deadPid();

        const { doneFile } = await runBackendSwap(tgz, {
          configDir,
          installDir: join(configDir, 'bin'),
          controlPort: await freePort(),
          oldPid: pid,
          waitMs: 10_000,
          healthTimeoutMs: 5_000,
          minBytes: 16,
          allowDevRuntime: true,
          daemonArgs: ['start'],
          // 「备份的运行方式」:回滚时按它重新拉起原 node 进程
          restartArgs: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(rollbackMarker)}, 'back')`],
        });

        await waitForFile(doneFile);
        const result = JSON.parse(readFileSync(doneFile, 'utf8')) as { ok?: boolean; rolledBack?: boolean; error?: string };
        expect(result.ok).toBe(false);
        expect(result.rolledBack).toBe(true);
        expect(result.error).toBeTruthy();
        // 原 node 进程被重新拉起(回滚标记落地)
        await waitForFile(rollbackMarker, 10_000);
        expect(readFileSync(rollbackMarker, 'utf8')).toBe('back');
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it.skipIf(process.platform === 'win32')(
    '健康检查超时:杀掉新进程并回滚',
    async () => {
      const work = mkdtempSync(join(tmpdir(), 'syncx-test-swapto-'));
      try {
        // 活着但永远不监听控制端口 → 健康检查超时
        makeBackendPackage(work, 'mbt', '0.3.0', localTargetTriple(), '#!/usr/bin/env node\nsetInterval(() => {}, 1000);');
        const tgz = tgzDir(work);
        const configDir = join(work, 'config');
        const rollbackMarker = join(work, 'rolled-back.txt');
        const pid = await deadPid();

        const { doneFile } = await runBackendSwap(tgz, {
          configDir,
          installDir: join(configDir, 'bin'),
          controlPort: await freePort(),
          oldPid: pid,
          waitMs: 10_000,
          healthTimeoutMs: 800,
          minBytes: 16,
          allowDevRuntime: true,
          daemonArgs: ['start'],
          restartArgs: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(rollbackMarker)}, 'back')`],
        });

        await waitForFile(doneFile);
        const result = JSON.parse(readFileSync(doneFile, 'utf8')) as { ok?: boolean; rolledBack?: boolean; error?: string };
        expect(result.ok).toBe(false);
        expect(result.rolledBack).toBe(true);
        expect(result.error).toContain('健康检查');
        await waitForFile(rollbackMarker, 10_000);
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
