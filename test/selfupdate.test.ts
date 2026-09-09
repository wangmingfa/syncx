import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractAndValidate,
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
