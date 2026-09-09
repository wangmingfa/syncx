import { describe, expect, it, vi } from 'vitest';
import {
  createUpdateChecker,
  downloadTarball,
  fetchLatestRelease,
} from '../src/update-check.js';

/** 造一个 mock fetch:返回固定 registry JSON。 */
function mockFetch(body: unknown, status = 200) {
  // 注意:不能用 Buffer.from(...).buffer —— 14 字节小 Buffer 走 Node 共享池,
  // .buffer 是整个 8KB 池(含 vitest 自身代码),Buffer.from(arrayBuffer) 会整池拷贝。
  const tgzBytes = new TextEncoder().encode('fake-tgz-bytes');
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    arrayBuffer: async () => tgzBytes.buffer.slice(0, tgzBytes.byteLength),
  })) as unknown as Parameters<typeof fetchLatestRelease>[0];
}

describe('fetchLatestRelease', () => {
  it('parses version and tarball url', async () => {
    const r = await fetchLatestRelease(
      mockFetch({ version: '0.2.0', dist: { tarball: 'https://registry.example/x.tgz' } }),
    );

    expect(r).toEqual({ version: '0.2.0', tarballUrl: 'https://registry.example/x.tgz' });
  });

  it('throws on http error', async () => {
    await expect(fetchLatestRelease(mockFetch({}, 503))).rejects.toThrow('HTTP 503');
  });

  it('throws on malformed body', async () => {
    await expect(fetchLatestRelease(mockFetch({ version: 42 }))).rejects.toThrow('结构异常');
  });
});

describe('createUpdateChecker', () => {
  it('reports availability only when latest is higher than current', async () => {
    const checker = createUpdateChecker('0.1.0', {
      fetchImpl: mockFetch({ version: '0.2.0', dist: { tarball: 'https://r/x.tgz' } }),
    });

    expect(checker.available()).toBeUndefined(); // 还没查过
    await checker.check();
    expect(checker.available()).toMatchObject({ latest: '0.2.0', current: '0.1.0' });
  });

  it('reports nothing when current is already up to date', async () => {
    const checker = createUpdateChecker('9.9.9', {
      fetchImpl: mockFetch({ version: '0.2.0', dist: { tarball: 'https://r/x.tgz' } }),
    });

    await checker.check();
    expect(checker.available()).toBeUndefined();
  });

  it('keeps silent on fetch failure and stays available-free', async () => {
    const failing = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as Parameters<typeof fetchLatestRelease>[0];
    const checker = createUpdateChecker('0.1.0', { fetchImpl: failing });

    await expect(checker.check()).resolves.toBeUndefined();
    expect(checker.available()).toBeUndefined();
  });

  it('start/stop lifecycle does not throw', () => {
    const checker = createUpdateChecker('0.1.0', { fetchImpl: mockFetch({}) });

    checker.start(10_000, 5);
    checker.stop(); // 立即停止,不会有定时器泄漏
    expect(true).toBe(true);
  });
});

describe('downloadTarball', () => {
  it('returns a buffer of the response body', async () => {
    const buf = await downloadTarball('https://registry.example/x.tgz', mockFetch({}));

    expect(buf.toString('utf8')).toBe('fake-tgz-bytes');
  });

  it('throws on http error', async () => {
    await expect(downloadTarball('https://registry.example/x.tgz', mockFetch({}, 404))).rejects.toThrow(
      'HTTP 404',
    );
  });
});
