import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import type { WebSocket } from 'ws';

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
 *   服务端 → 客户端:{ t: 'ready', shell, pty } 就绪(shell 短名;pty=是否完整模式)
 *                  { t: 'out', data }          一段输出(VT 流原样转发)
 *                  { t: 'exit', code }         当前 shell 进程退出
 */

export const TERMINAL_PATH = '/api/terminal';

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
    },
  };
}
