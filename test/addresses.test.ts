import { describe, expect, it } from 'vitest';
import { getLanAddresses, formatHost } from '../src/net/addresses.js';

describe('lan addresses', () => {
  it('returns only non-internal IPv4 addresses', () => {
    const addresses = getLanAddresses();

    for (const lan of addresses) {
      expect(lan.family).toBe('IPv4');
      expect(lan.address.length).toBeGreaterThan(0);
      // 内部/回环地址(127.x)不应出现,IPv6 也应被排除
      expect(lan.address).not.toMatch(/^127\./);
      expect(lan.address).not.toContain(':');
    }
  });

  it('formats IPv6 addresses with brackets and IPv4 without', () => {
    expect(formatHost('192.168.1.10', 'IPv4')).toBe('192.168.1.10');
    expect(formatHost('fe80::1', 'IPv6')).toBe('[fe80::1]');
  });
});
