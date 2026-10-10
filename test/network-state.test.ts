import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SyncSessionManager } from '../src/session-manager.js';
import type { Logger } from 'pino';
import { loadOrCreateIdentity } from '../src/identity.js';
import { rmDir } from './helpers.js';

/** 无目录、不绑端口的会话管理器:只为测在网状态机(probeNetwork 注入)。 */
function makeManager(probe: () => boolean, recovered: () => void) {
  const dir = mkdtempSync(join(tmpdir(), 'syncx-netstate-'));
  const lines: string[] = [];
  const logger = {
    info: (m: string) => lines.push(m),
    warn: () => {},
    error: () => {},
    debug: () => {},
  } as unknown as Logger;
  const manager = new SyncSessionManager(
    {
      identity: loadOrCreateIdentity(dir),
      configPath: join(dir, 'config.json'),
      configDir: dir,
      peerPort: 0,
      logger,
      probeNetwork: probe,
      onNetworkRecovered: recovered,
    },
    [],
  );
  return { manager, dir, lines };
}

describe('network online/offline state machine', () => {
  let cleanup: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanup) fn();
    cleanup = [];
  });

  it('starts online by default and logs the offline transition once', () => {
    let online = true;
    const { manager, dir, lines } = makeManager(
      () => online,
      () => {},
    );
    cleanup.push(() => {
      manager.close();
      rmDir(dir);
    });
    // 构造时的首次探测:与默认值一致,无翻转无日志
    expect(manager.isNetworkOnline()).toBe(true);
    expect(lines.some((l) => l.includes('network offline'))).toBe(false);

    online = false;
    manager.checkNetworkState();
    expect(manager.isNetworkOnline()).toBe(false);
    expect(lines.filter((l) => l.includes('network offline (no routable interface)')).length).toBe(1);
    // 重复巡检:状态未翻转,不重复记日志
    manager.checkNetworkState();
    expect(lines.filter((l) => l.includes('network offline')).length).toBe(1);
  });

  it('fires onNetworkRecovered exactly once per recovery', () => {
    let online = false;
    let recovered = 0;
    const { manager, dir } = makeManager(
      () => online,
      () => {
        recovered += 1;
      },
    );
    cleanup.push(() => {
      manager.close();
      rmDir(dir);
    });
    // 构造时即离线(带关掉的 WiFi 启动的形态),再翻回在线应触发恢复回调
    expect(manager.isNetworkOnline()).toBe(false);
    online = true;
    manager.checkNetworkState();
    expect(manager.isNetworkOnline()).toBe(true);
    expect(recovered).toBe(1);
    manager.checkNetworkState();
    expect(recovered).toBe(1);
  });

  it('offline→online flush is safe with no pending reconnects and close() stops probing', () => {
    let online = false;
    const recovered = vi.fn();
    const { manager, dir } = makeManager(() => online, recovered);
    cleanup.push(() => {
      manager.close();
      rmDir(dir);
    });
    manager.checkNetworkState(); // 先进离线
    online = true;
    manager.close(); // 关闭后不再巡检
    manager.checkNetworkState();
    expect(recovered).not.toHaveBeenCalled();
  });
});
