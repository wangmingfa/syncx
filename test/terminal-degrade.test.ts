import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

/**
 * 终端的两条降级线(与 terminal-hub.test.ts 的存活门互补,那边只走 PTY 成功分支):
 *
 * 1. node-pty **装上了却 spawn 不出来**。原生层缺件要到 pty.spawn 才炸 —— 实测 npm 提取
 *    会丢 spawn-helper 的执行位,抛的就是 `posix_spawnp failed.`。此前这一路没人接:
 *    前端连 {t:'ready'} 都收不到,界面永远停在「连接中」,而升级重启时 stderr 被 updater
 *    丢进 /dev/null,日志里一个字都没有。现在必须回退管道模式并如实 warn。
 * 2. 连回退的 shell 都起不来。hub 兜最后一层:记日志 + 关闭连接,而不是留一个浮动
 *    rejection(vitest 会把未处理的 rejection 记成失败,这正是本用例的红/绿判据)。
 */

// vi.mock 工厂被提到模块顶,只能引用 vi.hoisted 出来的绑定。
const { state, FakePipe } = vi.hoisted(() => {
  /** 管道模式的假 shell:只长 terminal.ts 用到的那一圈表面。 */
  class FakePipe {
    killed = false;
    writes: string[] = [];
    spawnfile = '/bin/zsh';
    dataCb?: (chunk: Buffer) => void;
    exitCb?: (code: number) => void;
    stdin = {
      write: (d: string): void => {
        this.writes.push(d);
      },
    };
    stdout = { on: (_event: string, cb: (chunk: Buffer) => void): void => void (this.dataCb = cb) };
    stderr = { on: (_event: string, _cb: unknown): void => {} };
    on(): void {}
    once(event: string, cb: (code: number) => void): void {
      if (event === 'exit') this.exitCb = cb;
    }
    kill(): void {
      this.killed = true;
    }
    emitData(s: string): void {
      this.dataCb?.(Buffer.from(s));
    }
  }
  return {
    FakePipe,
    state: {
      /** pty.spawn 抛的消息(置空则用实测原文)。 */
      ptyError: '',
      /** 非空则 child_process.spawn 抛该消息:连回退 shell 都起不来。 */
      pipeError: '',
      /** 每次管道模式 spawn 都登记,断言用。 */
      pipes: [] as FakePipe[],
    },
  };
});

vi.mock('node-pty', () => {
  const mod = {
    spawn: () => {
      throw new Error(state.ptyError || 'posix_spawnp failed.');
    },
  };
  // loadPty 读 `mod.default ?? mod`:node-pty 是 CJS,mock 不给 default 会被它当成加载失败。
  return { default: mod, ...mod };
});

vi.mock('node:child_process', () => ({
  spawn: () => {
    if (state.pipeError) throw new Error(state.pipeError);
    const p = new FakePipe();
    state.pipes.push(p);
    return p;
  },
}));

const { createTerminalHub } = await import('../src/api/terminal.js');

/** 满足 handle() 用到的 WebSocket 表面(与 terminal-hub.test.ts 同一套最小形状)。 */
class FakeWs extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  send(data: string): void {
    if (this.readyState === this.OPEN) this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {
    if (this.readyState !== this.OPEN) return;
    this.readyState = 3;
    this.emit('close');
  }
  receive(msg: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(msg)));
  }
  ready(): Record<string, unknown> | undefined {
    return this.sent.find((m) => m.t === 'ready');
  }
}

/** 放行 loadPty 的动态 import(微任务)与随后的 spawn。 */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
}

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  state.ptyError = '';
  state.pipeError = '';
  state.pipes.length = 0;
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  error.mockRestore();
  vi.useRealTimers();
});

describe('终端降级:node-pty 装上了却 spawn 不出来', () => {
  it('回退管道模式,ready 照发、终端照用,而不是把连接卡在「连接中」', async () => {
    const hub = createTerminalHub();
    const ws = new FakeWs();

    hub.handle(ws as never);
    await flush();

    // 旧行为:pty.spawn 抛出 → handle 的 promise  reject → 一个字节都没发给前端。
    expect(ws.ready()).toEqual({ t: 'ready', shell: expect.any(String), pty: false });
    // 降级必须有痕迹,否则只能对着一个不闪的光标猜根因。
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('posix_spawnp failed'));
    expect(state.pipes.length).toBe(1);

    // 回退模式仍然能用:输入逐行补换行喂给 shell(首帧空写入是 spawnPipe 的编码切换占位)
    ws.receive({ t: 'in', data: 'ls' });
    expect(state.pipes[0]!.writes).toEqual(['', 'ls\n']);

    hub.close();
  });

  it('回退的 shell 也起不来:hub 接住异常,记日志并关闭连接(不留浮动 rejection)', async () => {
    state.pipeError = 'spawn /bin/zsh ENOENT';
    const hub = createTerminalHub();
    const ws = new FakeWs();

    hub.handle(ws as never);
    await flush();

    // 没有 ready 是诚实的(这条会话确实起不来),但连接不能挂着让前端转「连接中」
    expect(ws.ready()).toBeUndefined();
    expect(ws.readyState).toBe(3);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('会话异常终止'));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('spawn /bin/zsh ENOENT'));

    hub.close();
  });

  it('用户关闭回退会话同样杀掉 shell', async () => {
    const hub = createTerminalHub();
    const ws = new FakeWs();
    hub.handle(ws as never);
    await flush();
    const pipe = state.pipes[0]!;

    ws.close();

    expect(pipe.killed).toBe(true);
    hub.close();
  });
});
