import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareVersions, isDaemonRunning, normalizeUpgradeTag, runUpgrade, stripPrerelease } from '../src/upgrade.js';
import { parseArgs } from '../src/args.js';

describe('normalizeUpgradeTag', () => {
  it('defaults to latest when omitted or blank', () => {
    expect(normalizeUpgradeTag()).toBe('latest');
    expect(normalizeUpgradeTag('')).toBe('latest');
    expect(normalizeUpgradeTag('  ')).toBe('latest');
  });

  it('accepts known channels and trims input', () => {
    expect(normalizeUpgradeTag('beta')).toBe('beta');
    expect(normalizeUpgradeTag(' alpha ')).toBe('alpha');
    expect(normalizeUpgradeTag('next-rc.1')).toBe('next-rc.1');
  });

  it('rejects tags that could break the npm command line', () => {
    expect(() => normalizeUpgradeTag('beta;rm')).toThrow();
    expect(() => normalizeUpgradeTag('a b')).toThrow();
    expect(() => normalizeUpgradeTag('../evil')).toThrow();
    expect(() => normalizeUpgradeTag('-beta')).toThrow();
  });
});

describe('compareVersions', () => {
  it('compares base versions numerically', () => {
    expect(compareVersions('0.1.3', '0.1.2')).toBeGreaterThan(0);
    expect(compareVersions('0.2.0', '0.1.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.9.0', '0.10.0')).toBeLessThan(0);
  });

  it('treats release as newer than its pre-release', () => {
    expect(compareVersions('1.2.3', '1.2.3-beta.1')).toBeGreaterThan(0);
    expect(compareVersions('1.2.3-beta.1', '1.2.3')).toBeLessThan(0);
  });

  it('compares pre-release iterations numerically (beta.10 > beta.9)', () => {
    expect(compareVersions('0.1.3-beta.10', '0.1.3-beta.9')).toBeGreaterThan(0);
    expect(compareVersions('0.1.3-beta.2', '0.1.3-beta.10')).toBeLessThan(0);
    expect(compareVersions('0.1.3-beta.3', '0.1.3-beta.3')).toBe(0);
  });

  it('compares pre-release tag names', () => {
    expect(compareVersions('0.1.3-alpha.1', '0.1.3-beta.1')).toBeLessThan(0);
  });

  it('handles dirty input without throwing', () => {
    expect(compareVersions('unknown', '0.1.3')).toBeLessThanOrEqual(0);
    expect(compareVersions('', '0.1.3')).toBeLessThanOrEqual(0);
  });
});

describe('stripPrerelease(版本一致锁口径)', () => {
  it('剥掉预发布后缀,纯版本原样保留', () => {
    expect(stripPrerelease('0.4.1-20261105.1105')).toBe('0.4.1');
    expect(stripPrerelease('0.4.1-beta.3')).toBe('0.4.1');
    expect(stripPrerelease('0.4.1')).toBe('0.4.1');
  });

  it('时间戳构建与同基数正式版视为一致——版本一致锁不触发', () => {
    expect(compareVersions(stripPrerelease('0.4.1-20261105.1105'), stripPrerelease('0.4.1'))).toBe(0);
    expect(compareVersions(stripPrerelease('0.4.1-20261105.0900'), stripPrerelease('0.4.1-20261105.1105'))).toBe(0);
  });

  it('基数演进照常比出先后(0.4.2 > 0.4.1 的时间戳构建)', () => {
    expect(compareVersions(stripPrerelease('0.4.2'), stripPrerelease('0.4.1-20261105.1105'))).toBeGreaterThan(0);
  });
});

describe('isDaemonRunning', () => {
  it('returns false when the pid file does not exist or is unreadable', () => {
    expect(isDaemonRunning(join(tmpdir(), 'syncx-nope', 'syncx.pid'))).toBe(false);
  });

  it('returns true for a live pid and false after it exits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-pid-'));
    const pidFile = join(dir, 'syncx.pid');
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], { detached: false });
    await new Promise<void>((resolve, reject) => {
      child.on('error', reject);
      // 稍等确保进程已起来
      setTimeout(resolve, 100);
    });
    writeFileSync(pidFile, JSON.stringify({ pid: child.pid, controlPort: 8384 }));

    expect(isDaemonRunning(pidFile)).toBe(true);

    child.kill();
    await new Promise<void>((resolve) => child.on('close', () => resolve()));
    expect(isDaemonRunning(pidFile)).toBe(false);

    rmSync(dir, { recursive: true, force: true });
  });
});

describe('runUpgrade', () => {
  it('throws for an invalid tag before touching the network', async () => {
    const logs: string[] = [];
    await expect(
      runUpgrade('beta;rm', { log: (m) => logs.push(m), error: (m) => logs.push(m) }),
    ).rejects.toThrow(/invalid dist-tag/);
    expect(logs).toEqual([]);
  });
});

describe('upgrade command parsing', () => {
  it('accepts an optional channel positional', () => {
    expect(parseArgs(['upgrade']).command).toBe('upgrade');
    expect(parseArgs(['upgrade']).positionals).toEqual([]);
    const withTag = parseArgs(['upgrade', 'beta']);
    expect(withTag.command).toBe('upgrade');
    expect(withTag.positionals).toEqual(['beta']);
  });
});
