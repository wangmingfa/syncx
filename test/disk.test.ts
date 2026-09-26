import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmDir } from './helpers.js';
import { freeBytesAt, DISK_GUARD_MIN_FREE_BYTES } from '../src/disk.js';

describe('disk guard free-space probe', () => {
  it('reports a plausible free-space figure for an existing directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-disk-'));
    const free = freeBytesAt(dir);

    // 真盘查询:应为正数且不超过一个荒谬的上界(位拼接错误会瞬间冲出天文数字)
    expect(free).toBeTypeOf('number');
    expect(free!).toBeGreaterThan(0);
    expect(free!).toBeLessThan(1024 * 1024 * 1024 * 1024 * 1024);
    rmDir(dir);
  });

  it('returns undefined for an unreadable path (guard must not block on its own blindness)', () => {
    expect(freeBytesAt(join(tmpdir(), 'syncx-disk-no-such-dir-9f3a'))).toBeUndefined();
  });

  it('keeps a reserve水位 large enough for half-written-file protection', () => {
    // 256MB:低于此值停收,给系统与正在写的临时文件留出原子 rename 的空间
    expect(DISK_GUARD_MIN_FREE_BYTES).toBe(256 * 1024 * 1024);
  });
});
