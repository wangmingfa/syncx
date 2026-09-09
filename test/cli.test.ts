import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { daemonStatusLines, formatUptime } from '../src/daemon.js';
import { parseArgs, reconnectDelayMs } from '../src/args.js';
import { readFolderIgnoreLines } from '../src/ignore.js';
import { isIgnored, parseIgnoreRules } from '../src/ignore.js';
import { helpText, packageVersion, wantsHelp, wantsVersion } from '../src/usage.js';

describe('cli parseArgs', () => {
  it('defaults to the start command when invoked with no arguments', () => {
    expect(parseArgs([])).toEqual({
      command: 'start',
      configPath: undefined,
      port: undefined,
      controlPort: undefined,
      host: undefined,
      positionals: [],
    });
  });

  it('parses the start command with defaults', () => {
    expect(parseArgs(['start'])).toEqual({
      command: 'start',
      configPath: undefined,
      port: undefined,
      controlPort: undefined,
      host: undefined,
      positionals: [],
    });
  });

  it('parses the status command with defaults', () => {
    expect(parseArgs(['status'])).toEqual({
      command: 'status',
      configPath: undefined,
      port: undefined,
      controlPort: undefined,
      host: undefined,
      positionals: [],
    });
  });

  it('parses --config and --port options', () => {
    expect(parseArgs(['start', '--config', '/etc/syncx.json', '--port', '22000'])).toEqual({
      command: 'start',
      configPath: '/etc/syncx.json',
      port: 22000,
      controlPort: undefined,
      host: undefined,
      positionals: [],
    });
  });

  it('parses the --control-port option', () => {
    expect(
      parseArgs(['start', '--config', '/etc/syncx.json', '--port', '22000', '--control-port', '8385']),
    ).toEqual({
      command: 'start',
      configPath: '/etc/syncx.json',
      port: 22000,
      controlPort: 8385,
      host: undefined,
      positionals: [],
    });
  });

  it('parses the --host option', () => {
    expect(
      parseArgs(['start', '--config', '/etc/syncx.json', '--host', '0.0.0.0', '--expose-control']),
    ).toEqual({
      command: 'start',
      configPath: '/etc/syncx.json',
      port: undefined,
      controlPort: undefined,
      host: '0.0.0.0',
      positionals: [],
    });
  });

  it('rejects a non-loopback --host unless --expose-control is given', () => {
    // 非回环地址意味着控制 API 以明文 HTTP 暴露在 LAN 上,token 可被嗅探。
    // 必须显式 --expose-control 才允许,否则启动即拒绝。
    expect(() => parseArgs(['start', '--host', '0.0.0.0'])).toThrow(/expose-control/);
    expect(() => parseArgs(['start', '--host', '192.168.1.5'])).toThrow(/expose-control/);
    expect(() => parseArgs(['start', '--host', '0.0.0.0', '--config', '/etc/syncx.json'])).toThrow(
      /expose-control/,
    );
  });

  it('allows a loopback --host without --expose-control', () => {
    expect(parseArgs(['start', '--host', '127.0.0.1']).host).toBe('127.0.0.1');
    expect(parseArgs(['start', '--host', 'localhost']).host).toBe('localhost');
  });

  it('parses the install command with defaults', () => {
    expect(parseArgs(['install'])).toEqual({
      command: 'install',
      configPath: undefined,
      port: undefined,
      controlPort: undefined,
      host: undefined,
      positionals: [],
    });
  });

  it('rejects an unknown command', () => {
    expect(() => parseArgs(['frobnicate'])).toThrow(/unknown command/);
  });

  it('parses the invite command with a positional folder path', () => {
    expect(parseArgs(['invite', '/data/docs'])).toEqual({
      command: 'invite',
      configPath: undefined,
      port: undefined,
      controlPort: undefined,
      host: undefined,
      positionals: ['/data/docs'],
    });
  });

  it('parses the join command with code and local path positionals', () => {
    expect(parseArgs(['join', 'SOMECODE123', '/local/path'])).toEqual({
      command: 'join',
      configPath: undefined,
      port: undefined,
      controlPort: undefined,
      host: undefined,
      positionals: ['SOMECODE123', '/local/path'],
    });
  });

  it('parses the revoke command with an invite code positional', () => {
    expect(parseArgs(['revoke', 'SOMECODE123'])).toEqual({
      command: 'revoke',
      configPath: undefined,
      port: undefined,
      controlPort: undefined,
      host: undefined,
      positionals: ['SOMECODE123'],
    });
  });

  it('collects positionals alongside flags for invite', () => {
    expect(parseArgs(['invite', '/data/docs', '--config', '/etc/syncx.json'])).toEqual({
      command: 'invite',
      configPath: '/etc/syncx.json',
      port: undefined,
      controlPort: undefined,
      host: undefined,
      positionals: ['/data/docs'],
    });
  });
});

describe('reconnectDelayMs', () => {
  it('retries the first failed connection attempt immediately', () => {
    // 首连失败(attempts=0)不等待,立即重试 —— 修复前第一个延迟就是 1s,
    // 双 daemon 同时启动时互相 ECONNREFUSED 后连接建立会被推后,
    // 负载高时退避到 30s 边缘导致同步类集成测试间歇超时
    expect(reconnectDelayMs(0)).toBe(0);
  });

  it('backs off exponentially after the immediate retry, capped at 30s', () => {
    expect(reconnectDelayMs(1)).toBe(1000);
    expect(reconnectDelayMs(2)).toBe(2000);
    expect(reconnectDelayMs(3)).toBe(4000);
    expect(reconnectDelayMs(4)).toBe(8000);
    expect(reconnectDelayMs(5)).toBe(16000);
    expect(reconnectDelayMs(6)).toBe(30000);
    expect(reconnectDelayMs(10)).toBe(30000);
  });
});

describe('cli help/version 开关', () => {
  it('-h / --help 在任意位置都能命中,且与相似前缀不混淆', () => {
    expect(wantsHelp(['-h'])).toBe(true);
    expect(wantsHelp(['--help'])).toBe(true);
    // 常见于 `syncx start -h`:开关跟在命令后面也应生效
    expect(wantsHelp(['start', '-h'])).toBe(true);
    expect(wantsHelp([])).toBe(false);
    expect(wantsHelp(['start'])).toBe(false);
    // --host 以 --h 开头但不是帮助开关,不能误命中
    expect(wantsHelp(['start', '--host', '127.0.0.1'])).toBe(false);
  });

  it('-v / --version 同理', () => {
    expect(wantsVersion(['-v'])).toBe(true);
    expect(wantsVersion(['--version'])).toBe(true);
    expect(wantsVersion(['status', '--version'])).toBe(true);
    expect(wantsVersion([])).toBe(false);
    expect(wantsVersion(['start', '--dev-vite', 'http://127.0.0.1:5173'])).toBe(false);
  });

  it('帮助文本列出全部命令与选项', () => {
    const text = helpText('0.1.0');
    expect(text.startsWith('syncx 0.1.0')).toBe(true);
    for (const cmd of ['start', 'status', 'install', 'invite', 'join', 'revoke']) {
      expect(text).toContain(cmd);
    }
    for (const flag of [
      '-h, --help',
      '-v, --version',
      '--config',
      '--port',
      '--control-port',
      '--host',
      '--expose-control',
      '--log-file',
      '--dev-vite',
    ]) {
      expect(text).toContain(flag);
    }
  });

  it('packageVersion 读到的是 syncx 自己的版本号', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(packageVersion()).toBe(pkg.version);
  });
});

describe('daemonStatusLines / formatUptime', () => {
  const healthFetch = (uptime: number | null) =>
    (url: string) =>
      uptime === null
        ? Promise.reject(new Error('connection refused'))
        : Promise.resolve({
            ok: true,
            arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
            json: () => Promise.resolve({ uptime }),
          });

  it('formats uptime in human readable units', () => {
    expect(formatUptime(45)).toBe('45s');
    expect(formatUptime(750)).toBe('12m30s');
    expect(formatUptime(3725)).toBe('1h02m');
    expect(formatUptime(183_600)).toBe('2d03h');
  });

  it('reports not running when no pid file exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-status-'));
    try {
      expect(await daemonStatusLines(dir, undefined)).toEqual(['daemon: not running']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports stale pid file when the recorded process is gone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-status-'));
    try {
      // 用一个必然已退出的子进程 pid 制造 stale 记录
      const { spawnSync } = await import('node:child_process');
      const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
      const exitedPid = dead.pid ?? 0;
      writeFileSync(join(dir, 'syncx.pid'), JSON.stringify({ pid: exitedPid, controlPort: 8384 }));
      expect(await daemonStatusLines(dir, undefined)).toEqual(['daemon: not running (stale pid file)']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports running with uptime and control URL when alive', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-status-'));
    try {
      writeFileSync(join(dir, 'syncx.pid'), JSON.stringify({ pid: process.pid, controlPort: 18499 }));
      const lines = await daemonStatusLines(dir, undefined, healthFetch(3725));
      expect(lines).toEqual([
        `daemon: running (pid ${process.pid}, up 1h02m)`,
        'control UI: http://127.0.0.1:18499',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still reports running without uptime when the health endpoint is unreachable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-status-'));
    try {
      writeFileSync(join(dir, 'syncx.pid'), JSON.stringify({ pid: process.pid, controlPort: 18499 }));
      const lines = await daemonStatusLines(dir, undefined, healthFetch(null));
      expect(lines).toEqual([
        `daemon: running (pid ${process.pid})`,
        'control UI: http://127.0.0.1:18499',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('readFolderIgnoreLines', () => {
  it('merges .gitignore and .syncxignore with syncxignore last (higher precedence)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-ignore-'));
    try {
      writeFileSync(join(dir, '.gitignore'), 'node_modules/\n*.log\n!keep.log\n');
      writeFileSync(join(dir, '.syncxignore'), 'secret.txt\n!*.log\n');
      const lines = readFolderIgnoreLines(dir, true).map((l) => l.trim()).filter((l) => l !== '');
      // .gitignore 在前,.syncxignore 在后(优先级更高,负向规则可覆盖)
      expect(lines).toEqual(['node_modules/', '*.log', '!keep.log', 'secret.txt', '!*.log']);

      const rules = parseIgnoreRules(readFolderIgnoreLines(dir, true));
      expect(isIgnored(rules, 'node_modules', true)).toBe(true);
      expect(isIgnored(rules, 'secret.txt', false)).toBe(true);
      expect(isIgnored(rules, 'a/b/c.log', false)).toBe(false); // 被后读的 !*.log 负向覆盖
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips .gitignore when disabled but still reads .syncxignore', () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-ignore-'));
    try {
      writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
      writeFileSync(join(dir, '.syncxignore'), 'secret.txt\n');
      const rules = parseIgnoreRules(readFolderIgnoreLines(dir, false));
      expect(isIgnored(rules, 'node_modules/x.js', false)).toBe(false); // .gitignore 未并入
      expect(isIgnored(rules, 'secret.txt', false)).toBe(true);
      // 无任何忽略文件时不抛错,返回空规则
      expect(readFolderIgnoreLines(mkdtempSync(join(tmpdir(), 'syncx-ignore-empty')), true)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
