import { describe, expect, it } from 'vitest';
import { renderControlFallback } from '../src/ui-fallback.js';

describe('ui-fallback', () => {
  it('renders a login form when no status is provided', () => {
    const html = renderControlFallback({});

    expect(html).toContain('<h1>syncx</h1>');
    expect(html).toContain('method="post"');
    expect(html).toContain('action="/login"');
    expect(html).toContain('name="token"');
  });

  it('renders the status page with device id, stats, and shared folders', () => {
    const html = renderControlFallback({
      status: {
        deviceId: 'ABCDEFGH23',
        folders: [
          { path: '/data/docs', devices: ['PEER234567'] },
          { path: '/data/pics', devices: [] },
        ],
        entries: 42,
        tombstones: 3,
      },
    });

    expect(html).toContain('ABCDEFGH23');
    expect(html).toContain('42');
    expect(html).toContain('3');
    expect(html).toContain('/data/docs');
    expect(html).toContain('/data/pics');
    expect(html).toContain('action="/folders"');
  });

  it('escapes user-controlled strings to prevent HTML injection', () => {
    const html = renderControlFallback({
      status: {
        deviceId: '"><script>alert(1)</script>it\'s',
        folders: [{ path: '<img src=x onerror=alert(1)>' }],
      },
      message: '<b>bad</b>',
      error: '<b>bad</b>',
    });

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&#39;');
  });

  it('renders the error message on the login page', () => {
    const html = renderControlFallback({ error: 'token 无效,请重试' });

    expect(html).toContain('token 无效,请重试');
    expect(html).toContain('class="error"');
  });
});
