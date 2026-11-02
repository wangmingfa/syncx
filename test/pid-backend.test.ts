import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describePidHolder, backendStopHint, pidFilePath } from '../src/daemon.js';
import { rmDir } from './helpers.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'syncx-pid-'));
}

/**
 * Node 与 Rust 共用同一数据目录,同一时刻只允许一个后端(见 docs/adr/0025)。
 * 这些用例钉住的是「第二个启动时能否指出对方是谁」——直接影响用户知不知道
 * 该敲 `syncx stop` 还是 `syncx-rs stop`。
 */
describe('pid 文件的 backend 字段(双后端互斥)', () => {
  const created: string[] = [];
  afterEach(() => {
    for (const d of created) rmDir(d);
    created.length = 0;
  });

  function dir(): string {
    const d = tmpDir();
    created.push(d);
    return d;
  }

  it('没有 pid 文件时没有任何占用者', () => {
    expect(describePidHolder(dir())).toBeUndefined();
  });

  it('pid 文件损坏时不猜占用者(交给通用排查文案)', () => {
    const d = dir();
    writeFileSync(pidFilePath(d), '{ not json');
    expect(describePidHolder(d)).toBeUndefined();
  });

  it('进程已退的陈旧 pid 文件不算占用', () => {
    const d = dir();
    // 取一个几乎不可能存在的 pid:比当前进程 pid 大很多且未启动
    writeFileSync(pidFilePath(d), JSON.stringify({ pid: 2 ** 22, backend: 'node' }));
    expect(describePidHolder(d)).toBeUndefined();
  });

  it('存活的 Rust 后端给出 syncx-rs stop 提示', () => {
    const d = dir();
    writeFileSync(
      pidFilePath(d),
      JSON.stringify({ pid: process.pid, backend: 'rust', version: '0.5.0' }),
    );
    const hint = describePidHolder(d);
    expect(hint).toContain('backend=rust');
    expect(hint).toContain(`pid=${process.pid}`);
    expect(hint).toContain('syncx-rs stop');
  });

  it('缺 backend 的旧 pid 文件按 node 处理', () => {
    // 本字段引入前的 pid 文件只有 {pid, controlPort};那时只有 Node 实现,
    // 判成 node 才对。若这里判成 rust,老用户会被指向一条不存在的命令。
    const d = dir();
    writeFileSync(pidFilePath(d), JSON.stringify({ pid: process.pid }));
    const hint = describePidHolder(d);
    expect(hint).toContain('backend=node');
    expect(hint).toContain('syncx stop');
    expect(hint).not.toContain('syncx-rs');
  });

  it('backendStopHint 覆盖两种实现', () => {
    expect(backendStopHint('rust')).toBe('syncx-rs stop');
    expect(backendStopHint('node')).toBe('syncx stop');
    expect(backendStopHint(undefined)).toBe('syncx stop');
  });
});
