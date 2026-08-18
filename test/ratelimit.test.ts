import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/ratelimit.js';

describe('RateLimiter', () => {
  it('allows all traffic when rate is 0 (unlimited)', () => {
    const limiter = new RateLimiter(0);
    expect(limiter.tryConsume(1_000_000)).toBe(true);
    expect(limiter.waitTime(1_000_000)).toBe(0);
  });

  it('allows traffic within the rate limit', () => {
    // 1024 KB/s = 1 MB/s
    const limiter = new RateLimiter(1024);
    // Initial burst: 1 second worth of tokens = 1048576 bytes
    expect(limiter.tryConsume(500 * 1024)).toBe(true);
    expect(limiter.tryConsume(500 * 1024)).toBe(true);
    // Total consumed = 1024000, remaining ~24576, so 1024 still fits
    expect(limiter.tryConsume(1024)).toBe(true);
    // But a large chunk should be throttled
    expect(limiter.tryConsume(50 * 1024)).toBe(false);
  });

  it('returns wait time when throttled', () => {
    const limiter = new RateLimiter(1024);
    // Consume all initial tokens
    limiter.tryConsume(1024 * 1024);
    const wait = limiter.waitTime(1024);
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(1000);
  });

  it('refills tokens over time', () => {
    const limiter = new RateLimiter(1024);
    limiter.tryConsume(1024 * 1024); // drain all
    // After draining, a large chunk requires waiting
    const wait = limiter.waitTime(100 * 1024);
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThan(100); // 100KB at 1024KB/s < 100ms
  });
});