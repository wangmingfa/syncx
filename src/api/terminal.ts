import { spawn, type ChildProcess } from 'node:child_process';
import { basename } from 'node:path';
import { homedir } from 'node:os';
import type { WebSocket } from 'ws';

/**
 * 浏览器内终端(简易 shell 通道)。
 *
 * 实现:控制服务 WS 升级到 /api/terminal 后,按连接 spawn 一个本机 shell
 * (Windows = PowerShell,Unix = $SHELL 兜底 bash),stdin/stdout 与 WS 双向搬运。
 * 不经过 PTY(node-pty 为原生依赖,会破坏单文件分发形态),因此 vim/top 这类
 * 全屏交互程序不可用;逐行 REPL(执行命令、看输出)与 PowerShell/bash 的
 * 日常管理命令均可用 —— 定位是「远程排障入口」,不是完整终端模拟器。
 *
 * 协议(JSON 文本帧):
 *   客户端 → 服务端:{ t: 'in', data }   键入的一行(含结尾换行由服务端补)
 *                  { t: 'sigint' }       中断:杀掉当前 shell 并重开一个
 *   服务端 → 客户端:{ t: 'ready', shell } 就绪(shell 短名)
 *                  { t: 'out', data }    一段输出(utf-8 文本)
 *                  { t: 'exit', code }   当前 shell 进程退出(中断时也会先出这条)
 *
 * 输出编码:Windows PowerShell 管道输出默认跟随控制台代码页(中文系统常为 GBK),
 * spawn 后先写一行 `[Console]::OutputEncoding=UTF8` 让后续输出统一成 UTF-8,
 * 避免中文输出在浏览器端乱码。
 */

export const TERMINAL_PATH = '/api/terminal';

export interface TerminalHub {
  /** api.ts 在 WS upgrade 鉴权通过后把连接交给它。 */
  handle(ws: WebSocket): void;
  /** daemon 优雅关闭时杀掉所有存活的 shell 子进程。 */
  close(): void;
}

export function createTerminalHub(): TerminalHub {
  const children = new Set<ChildProcess>();

  function spawnShell(): ChildProcess {
    const isWin = process.platform === 'win32';
    const shell = isWin ? 'powershell.exe' : (process.env.SHELL || '/bin/bash');
    const child = spawn(shell, isWin ? ['-NoProfile', '-NoLogo'] : [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: homedir(),
      env: { ...process.env, TERM: 'dumb' },
      windowsHide: true,
    });
    children.add(child);
    // Windows:先切 UTF-8 输出编码,后续输出才不会乱码(bash 无此问题,写入无副作用)
    child.stdin?.write(isWin ? '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8\r\n' : '');
    child.once('exit', () => children.delete(child));
    return child;
  }

  function kill(child: ChildProcess): void {
    children.delete(child);
    try {
      child.kill();
    } catch {
      /* 已退出 */
    }
  }

  function handle(ws: WebSocket): void {
    let child = spawnShell();
    const send = (msg: unknown): void => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    };
    send({ t: 'ready', shell: basename(child.spawnfile ?? '') });

    const onStdout = (chunk: Buffer): void => send({ t: 'out', data: chunk.toString('utf8') });
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStdout);
    child.once('exit', (code) => send({ t: 'exit', code }));

    ws.on('message', (raw) => {
      let msg: { t?: string; data?: string };
      try {
        msg = JSON.parse(String(raw)) as typeof msg;
      } catch {
        return;
      }
      if (msg.t === 'in' && typeof msg.data === 'string' && msg.data.length > 0) {
        child.stdin?.write(msg.data.endsWith('\n') ? msg.data : msg.data + '\n');
        return;
      }
      // 中断:杀掉当前 shell 换一个干净的(无 PTY 下 ctrl+c 无法直送前台进程组)
      if (msg.t === 'sigint') {
        kill(child);
        child = spawnShell();
        send({ t: 'ready', shell: basename(child.spawnfile ?? '') });
      }
    });

    ws.on('close', () => kill(child));
  }

  return {
    handle,
    close(): void {
      for (const child of [...children]) kill(child);
    },
  };
}
