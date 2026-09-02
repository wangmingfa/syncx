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

  it('renders peer connection status with online/offline indicators', () => {
    const html = renderControlFallback({
      status: {
        deviceId: 'ABCDEFGH23',
        folders: [],
        devices: [
          { deviceId: 'PEER234567', online: true },
          { deviceId: 'OFFLINE123', online: false },
        ],
      },
    });

    expect(html).toContain('PEER234567');
    expect(html).toContain('在线');
    expect(html).toContain('dot-online');
    expect(html).toContain('OFFLINE123');
    expect(html).toContain('离线');
    expect(html).toContain('dot-offline');
  });

  it('renders a reconnect button only for offline peers', () => {
    const html = renderControlFallback({
      status: {
        deviceId: 'ABCDEFGH23',
        folders: [],
        devices: [
          { deviceId: 'PEER234567', online: true },
          { deviceId: 'OFFLINE123', online: false },
        ],
      },
    });

    // 离线对端应有重连按钮
    expect(html).toContain('value="reconnect"');
    expect(html).toContain('value="OFFLINE123"');
    expect(html).toContain('重连');
    // 在线对端所在行不应包含重连按钮
    const onlineIdx = html.indexOf('PEER234567');
    const offlineIdx = html.indexOf('OFFLINE123');
    const onlineRow = html.slice(onlineIdx, offlineIdx);
    expect(onlineRow).not.toContain('value="reconnect"');
  });

  it('renders sync progress table with folder stats', () => {
    const html = renderControlFallback({
      status: {
        deviceId: 'ABCDEFGH23',
        folders: [{ path: '/data/docs' }],
        syncProgress: [
          { folder: 'docs', pending: 5, sending: 2, receiving: 3 },
          { folder: 'pics', pending: 0, sending: 0, receiving: 1 },
        ],
      },
    });

    expect(html).toContain('docs');
    expect(html).toContain('5');
    expect(html).toContain('2');
    expect(html).toContain('3');
    expect(html).toContain('pics');
    expect(html).toContain('progress-bar');
  });

  it('renders a manual rescan button on the status page', () => {
    const html = renderControlFallback({
      status: {
        deviceId: 'ABCDEFGH23',
        folders: [],
      },
    });

    expect(html).toContain('value="rescan"');
    expect(html).toContain('手动扫描');
  });

  it('shows empty state when no devices are configured', () => {
    const html = renderControlFallback({
      status: {
        deviceId: 'ABCDEFGH23',
        folders: [],
        devices: [],
      },
    });

    expect(html).toContain('暂无对端');
  });

  it('shows empty state when no sync progress exists', () => {
    const html = renderControlFallback({
      status: {
        deviceId: 'ABCDEFGH23',
        folders: [],
        syncProgress: [],
      },
    });

    expect(html).toContain('同步中无待处理任务');
  });
});
