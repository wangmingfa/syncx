import { describe, expect, it, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createControlServer } from '../src/api.js';
import { pauseDaemon } from '../src/daemon.js';
import { rmDir } from './helpers.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'syncx-pause-'));
}

describe('pause/resume 命令(pauseDaemon)', () => {
  const created: string[] = [];
  afterEach(() => {
    for (const d of created) rmDir(d);
    created.length = 0;
    vi.restoreAllMocks();
  });

  it('带令牌请求 /api/pause:setGlobalPaused 收到对应布尔值,并输出确认信息', async () => {
    const calls: boolean[] = [];
    const server = createControlServer({
      token: 'secret',
      getStatus: () => ({}),
      setGlobalPaused: (paused) => calls.push(paused),
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const dir = tmpDir();
    created.push(dir);
    // pauseDaemon 只读 pid 文件与 control.token,均需手工准备好
    writeFileSync(join(dir, 'control.token'), 'secret', { mode: 0o600 });
    writeFileSync(join(dir, 'syncx.pid'), JSON.stringify({ pid: process.pid, controlPort: port }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await pauseDaemon(dir, undefined, true);
      await pauseDaemon(dir, undefined, false);
    } finally {
      server.close();
    }
    expect(calls).toEqual([true, false]);
    // 两次都有确认输出:暂停提示带 resume 指引,恢复提示直接说恢复
    expect(log).toHaveBeenCalledTimes(2);
    expect(String(log.mock.calls[0]?.[0])).toContain('syncx resume');
    expect(String(log.mock.calls[1]?.[0])).toContain('已恢复');
  });

  it('pid 文件缺失:不请求 API,提示 daemon 未运行', async () => {
    const dir = tmpDir();
    created.push(dir);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await pauseDaemon(dir, undefined, true);
    expect(log).toHaveBeenCalledWith('syncx is not running');
  });

  it('端口不通:抛出指向 status 的中文错误', async () => {
    const dir = tmpDir();
    created.push(dir);
    // 走 override 端口 1(无监听,连接必被拒):「先占再释放」的探测法在并行测试下
    // 存在端口被其它用例复用的竞态,曾经导致偶发失败
    writeFileSync(join(dir, 'control.token'), 'secret', { mode: 0o600 });
    writeFileSync(join(dir, 'syncx.pid'), JSON.stringify({ pid: process.pid }));
    await expect(pauseDaemon(dir, 1, true)).rejects.toThrow('syncx status');
  });
});
