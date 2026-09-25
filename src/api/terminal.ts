import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import type { WebSocket } from 'ws';
import { ELEVATE_TTL_MS } from './helpers.js';

/**
 * 浏览器内终端(完整 PTY,回退简易管道)。
 *
 * 优先走 node-pty:控制服务 WS 升级到 /api/terminal 后,按连接 spawn 一个带
 * 伪控制台(PTY)的本机 shell —— 与系统自带终端同构的完整交互:xterm.js 直出
 * VT 序列,vim/top/htop 等全屏程序、彩色输出、Ctrl+C 直送前台进程组全部可用。
 *
 * node-pty 是原生依赖:以动态 import 惰性加载,**加载失败时自动回退**到旧的
 * 无 PTY 管道模式(逐行 REPL)。单文件分发包(scp 到别处直接跑)旁边没有
 * node_modules,拿不到原生模块 —— 回退保证终端功能在任何分发形态下都可用,
 * 只是交互能力降级;npm 安装/源码运行则永远是完整 PTY。
 *
 * 协议(JSON 文本帧):
 *   客户端 → 服务端:{ t: 'in', data }         原始键入(xterm 输出流,含控制字符)
 *                  { t: 'resize', cols, rows } 前端视口尺寸变化(PTY 模式有效)
 *                  { t: 'sigint' }             仅回退模式:杀掉当前 shell 重开
 *                  { t: 'ping' }               前端活跃心跳(用户在场凭证,喂给服务端闲置门)
 *   服务端 → 客户端:{ t: 'ready', shell, pty } 就绪(shell 短名;pty=是否完整模式)
 *                  { t: 'out', data }          一段输出(VT 流原样转发)
 *                  { t: 'exit', code }         当前 shell 进程退出
 *
 * 服务端存活门(不依赖前端诚实):整条连接的「闲置超时 + 绝对上限」由本模块
 * 兜底。WS 一旦升级成功,提权 cookie 的 TTL 就不再约束它 —— 所以这里按
 * 「最后一次有向服务端的数据帧」和「握手时刻」两条线主动 close,close 事件即
 * 触发 kill shell(见各分支的 ws.on('close'))。闲置窗对齐提权有效期
 * (ELEVATE_TTL_MS,10 分钟):前端只在用户真实活动(未 idleExpired)时发 ping,
 * 标签页被挂起/后台节流/无人看管时 ping 断流,服务端到点收尸 —— 这把「10 分钟
 * 无人操作即断」从纯前端约定变成了服务端保证。绝对上限 TERMINAL_MAX_LIFETIME_MS
 * 则兜住「自动化客户端持续心跳」这一类不诚实场景,到点强制回落到重新提权。
 */

export const TERMINAL_PATH = '/api/terminal';

/** 闲置多久没有任何入站数据帧即判为无人操作(对齐提权有效期)。 */
export const TERMINAL_IDLE_MS = ELEVATE_TTL_MS;
/** 单条终端连接的最长存活时间,超过强制关闭并要求重新提权(兜不诚实的心跳)。 */
export const TERMINAL_MAX_LIFETIME_MS = 60 * 60 * 1000;
/** 存活巡检周期。 */
const REAPER_INTERVAL_MS = 30_000;

/** 巡检判定所需的最小连接视图(真实 TrackedConn 与单测里的桩都满足)。 */
export interface ReapTarget {
  ws: { close(): void };
  lastTouch: number;
  openedAt: number;
}

/**
 * 扫一遍连接,把「闲置超阈」或「存活超绝对上限」的关掉(其 close 事件负责杀
 * shell 与摘除登记),返回被关掉的项。判定用 `>=`:到点即收,不留一格余量。
 * 抽成纯函数是为了让「10 分钟闲置 / 1 小时上限」这两条线可被单测直接验证。
 */
export function reapStale<T extends ReapTarget>(
  conns: Iterable<T>,
  opts: { idleMs: number; maxLifetimeMs: number },
  now: number = Date.now(),
): T[] {
  const reaped: T[] = [];
  for (const t of conns) {
    if (now - t.lastTouch >= opts.idleMs || now - t.openedAt >= opts.maxLifetimeMs) {
      t.ws.close();
      reaped.push(t);
    }
  }
  return reaped;
}

export interface TerminalHub {
  /** api.ts 在 WS upgrade 鉴权通过后把连接交给它。 */
  handle(ws: WebSocket): void;
  /** daemon 优雅关闭时杀掉所有存活的 shell 子进程。 */
  close(): void;
}

/** node-pty 终端进程的最小接口(只取用到的部分,避免强绑其类型版本)。 */
interface PtyProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (event: { exitCode: number; signal?: number }) => void): void;
}

interface PtyModule {
  spawn(file: string, args: string[], options: Record<string, unknown>): PtyProcess;
}

/** shell 选择:Windows 返回系统自带的 PowerShell 绝对路径(PATH 解析在部分环境不可靠)。 */
export function pickShell(env: NodeJS.ProcessEnv = process.env): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    const root = env.SystemRoot ?? 'C:\\Windows';
    return { file: join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoProfile', '-NoLogo'] };
  }
  // 登录 shell 通常已在 /etc/shells 白名单里,绝对路径直接可信
  return { file: env.SHELL || '/bin/bash', args: [] };
}

/**
 * 惰性加载 node-pty(进程内缓存结果,失败不再重试)。
 * 动态 import 在单文件 bundle 里被 external 保留为运行时解析 —— 旁边没有
 * node_modules 时抛错,由调用方捕获并降级为管道模式。
 */
let ptyPromise: Promise<PtyModule | null> | null = null;
function loadPty(): Promise<PtyModule | null> {
  ptyPromise ??= import('node-pty')
    .then((mod) => (mod as { default?: PtyModule }).default ?? (mod as unknown as PtyModule))
    .catch(() => null);
  return ptyPromise;
}

export function createTerminalHub(): TerminalHub {
  // 存活的子进程(两种模式统一记录),关闭时统一收割
  const alive = new Set<{ kill(): void }>();

  // ---- 服务端存活门:每条连接记最后活动时间与握手时刻,单条定时器巡检 ----
  interface TrackedConn {
    ws: WebSocket;
    lastTouch: number;
    openedAt: number;
  }
  const conns = new Map<WebSocket, TrackedConn>();
  let reaper: ReturnType<typeof setInterval> | null = null;

  function stopReaperIfIdle(): void {
    if (conns.size === 0 && reaper) {
      clearInterval(reaper);
      reaper = null;
    }
  }

  function ensureReaper(): void {
    if (reaper) return;
    reaper = setInterval(() => {
      // close 事件会触发各分支注册的 killAlive,shell 随之被杀;清理由 close 兜底
      reapStale(conns.values(), { idleMs: TERMINAL_IDLE_MS, maxLifetimeMs: TERMINAL_MAX_LIFETIME_MS });
    }, REAPER_INTERVAL_MS);
    reaper.unref?.(); // 不因这条定时器拖住进程退出
  }

  // ---- PTY 模式:完整终端 ----
  function spawnPty(pty: PtyModule): PtyProcess {
    const { file, args } = pickShell();
    const proc = pty.spawn(file, args, {
      name: 'xterm-256color', // xterm.js 按这个名字启用 256 色 + 应用键盘模式
      cols: 80,
      rows: 24,
      cwd: homedir(),
      env: { ...process.env, TERM: 'xterm-256color' },
      windowsHide: true,
    });
    alive.add(proc);
    proc.onExit(() => alive.delete(proc));
    return proc;
  }

  // ---- 回退:无 PTY 管道模式(逐行 REPL,无全屏程序支持) ----
  function spawnPipe(): ChildProcess {
    const isWin = process.platform === 'win32';
    const shell = pickShell();
    const child = spawn(shell.file, shell.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: homedir(),
      env: { ...process.env, TERM: 'dumb' },
      windowsHide: true,
    });
    alive.add(child);
    child.once('exit', () => alive.delete(child));
    // Windows:先切 UTF-8 输出编码,后续输出才不会乱码(bash 无此问题,写入无副作用)
    child.stdin?.write(isWin ? '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8\r\n' : '');
    return child;
  }

  function killAlive(proc: { kill(): void }): void {
    alive.delete(proc);
    try {
      proc.kill();
    } catch {
      /* 已退出 */
    }
  }

  async function handle(ws: WebSocket): Promise<void> {
    const pty = await loadPty();
    // 加载期间连接可能已断开(页面刷新):此时不再 spawn,避免产生无人认领的 shell
    if (ws.readyState !== ws.OPEN) return;

    // 纳入服务端存活门:任何入站数据帧都算「用户在动」(ping/in/resize),
    // close/error 摘除登记。这两条监听与各分支自己的 kill 监听并存、互不干扰。
    const tracked: TrackedConn = { ws, lastTouch: Date.now(), openedAt: Date.now() };
    conns.set(ws, tracked);
    ensureReaper();
    ws.on('message', () => {
      tracked.lastTouch = Date.now();
    });
    const unregister = (): void => {
      conns.delete(ws);
      stopReaperIfIdle();
    };
    ws.on('close', unregister);
    ws.on('error', unregister);

    const { file } = pickShell();
    const send = (msg: unknown): void => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    };

    if (pty) {
      // ---- PTY:输出是 VT 流原样转发,输入逐字节透传,支持 resize ----
      const proc = spawnPty(pty);
      send({ t: 'ready', shell: basename(file), pty: true });
      proc.onData((data) => send({ t: 'out', data }));
      proc.onExit(({ exitCode }) => send({ t: 'exit', code: exitCode }));

      ws.on('message', (raw) => {
        let msg: { t?: string; data?: string; cols?: number; rows?: number };
        try {
          msg = JSON.parse(String(raw)) as typeof msg;
        } catch {
          return;
        }
        if (msg.t === 'in' && typeof msg.data === 'string' && msg.data.length > 0) {
          proc.write(msg.data);
          return;
        }
        if (msg.t === 'resize') {
          // 视口尺寸夹在合理区间,防恶意/异常值把 conhost 撑爆
          const cols = Math.max(2, Math.min(999, Math.floor(Number(msg.cols) || 80)));
          const rows = Math.max(2, Math.min(999, Math.floor(Number(msg.rows) || 24)));
          proc.resize(cols, rows);
        }
        // PTY 下 Ctrl+C 由 xterm 作为 \x03 直送前台进程组,sigint 消息无需处理
      });
      ws.on('close', () => killAlive(proc));
      return;
    }

    // ---- 回退:无 PTY 管道模式(逐行 REPL) ----
    let proc = spawnPipe();
    send({ t: 'ready', shell: basename(proc.spawnfile ?? ''), pty: false });
    const onOut = (chunk: Buffer): void => send({ t: 'out', data: chunk.toString('utf8') });
    proc.stdout?.on('data', onOut);
    proc.stderr?.on('data', onOut);
    proc.once('exit', (code) => send({ t: 'exit', code }));

    ws.on('message', (raw) => {
      let msg: { t?: string; data?: string };
      try {
        msg = JSON.parse(String(raw)) as typeof msg;
      } catch {
        return;
      }
      if (msg.t === 'in' && typeof msg.data === 'string' && msg.data.length > 0) {
        proc.stdin?.write(msg.data.endsWith('\n') ? msg.data : msg.data + '\n');
        return;
      }
      // 中断:杀掉当前 shell 换一个干净的(无 PTY 下 ctrl+c 无法直送前台进程组)
      if (msg.t === 'sigint') {
        killAlive(proc);
        proc = spawnPipe();
        send({ t: 'ready', shell: basename(proc.spawnfile ?? ''), pty: false });
      }
    });
    ws.on('close', () => killAlive(proc));
  }

  return {
    handle: (ws) => void handle(ws),
    close(): void {
      for (const child of [...alive]) killAlive(child);
      if (reaper) {
        clearInterval(reaper);
        reaper = null;
      }
      conns.clear();
    },
  };
}
