import { describe, expect, it } from 'vitest';
import { formatBytes } from '../web/utils/bytes.js';

describe('formatBytes', () => {
  it('B / KB / MB 三档', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('2 KB'); // 取整到 KB
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1_500_000)).toBe('1.4 MB');
  });
});
