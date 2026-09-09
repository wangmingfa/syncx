/**
 * daemon 生命周期:控制令牌、pid 文件、status/stop 命令实现与控制端口绑定。
 * 从 cli.ts 拆出——纯函数或仅依赖 configDir,不持有 daemon 运行期状态。
 */
import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';

/** 创建(或读取)控制 API 访问令牌,落盘在 {configDir}/control.token(0600)。 */
export function loadOrCreateToken(configDir: string): string {
  const file = join(configDir, 'control.token');
  if (existsSync(file)) {
    const existing = readFileSync(file, 'utf8').trim();
    // 空/纯空白令牌会让「无凭据」也通过常量时间比较(空串 vs 空串恒等),
    // 等于把整个控制 API 开放出去。这里视同「令牌缺失」重新生成。
    if (existing) return existing;
    console.warn(`[warn] ${file} 内容为空,已重新生成令牌`);
  }
  const token = randomBytes(24).toString('hex');
  writeFileSync(file, token, { mode: 0o600 });
  return token;
}

/* ---------- stop:查找并停止运行中的 daemon ---------- */

/** pid 文件名与内容:start 时写入 {pid, controlPort},优雅关闭时删除。 */
export const PID_FILE = 'syncx.pid';

export interface PidRecord {
  pid?: number;
  controlPort?: number;
}

export function pidFilePath(configDir: string): string {
  return join(configDir, PID_FILE);
}

/** 进程是否存活(信号 0 = 只探测,不发送)。 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 把秒数格式化成人类可读的运行时长:45s / 12m30s / 3h05m / 2d04h。 */
export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (d > 0) return `${d}d${String(h).padStart(2, '0')}h`;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/**
 * 读取 daemon 运行状态(status 命令的 daemon 段)。纯读,不创建/不清理任何文件:
 * - pid 文件不存在 → not running
 * - pid 探活失败 → not running(提示 stale pid file,清理交给 stop 命令)
 * - 存活 → running(pid + 经 /health 拿运行时长;health 不通只影响时长显示)
 */
export async function daemonStatusLines(
  configDir: string,
  controlPortOverride: number | undefined,
  healthFetch: (url: string, init?: { signal: AbortSignal }) => Promise<{
    ok: boolean;
    arrayBuffer: () => Promise<ArrayBuffer>;
    json: () => Promise<unknown>;
  }> = fetch,
): Promise<string[]> {
  const pidFile = pidFilePath(configDir);
  if (!existsSync(pidFile)) {
    return ['daemon: not running'];
  }

  let info: PidRecord = {};
  try {
    info = JSON.parse(readFileSync(pidFile, 'utf8')) as PidRecord;
  } catch {
    // pid 文件损坏:按未知处理,与 stale 同等对待
  }

  const pid = info.pid;
  if (typeof pid !== 'number' || !isProcessAlive(pid)) {
    return ['daemon: not running (stale pid file)'];
  }

  const port = controlPortOverride ?? info.controlPort ?? 8384;
  let uptime = '';
  try {
    const res = await healthFetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const body = (await res.json()) as { uptime?: unknown };
      if (typeof body.uptime === 'number' && body.uptime >= 0) {
        uptime = `, up ${formatUptime(body.uptime)}`;
      }
    }
    await res.arrayBuffer().catch(() => {});
  } catch {
    // API 不通(如控制端口被改):进程确实活着,只是拿不到时长
  }

  return [
    `daemon: running (pid ${pid}${uptime})`,
    `control UI: http://127.0.0.1:${port}`,
  ];
}

/**
 * 停止运行中的 daemon(stop 命令)。不创建任何文件/身份。
 *
 * 优先走控制 API(带令牌):触发 daemon 优雅关闭(关 peer socket、sqlite 索引、
 * 配置 watcher),跨平台一致 —— Windows 上对其他进程 process.kill(SIGTERM)
 * 是 TerminateProcess 硬杀,不会经过优雅退出。
 * API 不可达(端口不通/超时)时回退信号:Unix SIGTERM 仍优雅;Windows 强杀(sqlite 崩溃安全)。
 */
export async function stopDaemon(configDir: string, controlPortOverride: number | undefined): Promise<void> {
  const pidFile = pidFilePath(configDir);
  if (!existsSync(pidFile)) {
    console.log('syncx is not running');
    return;
  }

  let info: PidRecord = {};
  try {
    info = JSON.parse(readFileSync(pidFile, 'utf8')) as PidRecord;
  } catch {
    // pid 文件损坏:按未知处理,下方尽力清理
  }

  const port = controlPortOverride ?? info.controlPort ?? 8384;
  const tokenFile = join(configDir, 'control.token');

  // 1) 优雅路径:控制 API。令牌认证通过即证明目标就是本机 daemon,不会误杀无关进程。
  if (existsSync(tokenFile)) {
    const token = readFileSync(tokenFile, 'utf8').trim();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        // 读掉响应体:keep-alive 连接若挂着会让 CLI 进程在 run() 返回后仍不退出
        await res.arrayBuffer().catch(() => {});
        console.log(`syncx stopped (pid ${info.pid ?? 'unknown'})`);
        return; // daemon 优雅退出时自己删除 pid 文件
      }
      await res.arrayBuffer().catch(() => {});
      console.warn(`[warn] /api/shutdown returned ${res.status}, falling back to signal`);
    } catch {
      console.warn('[warn] control API unreachable, falling back to signal');
    }
  }

  // 2) 回退:向 pid 发信号。
  if (typeof info.pid === 'number' && isProcessAlive(info.pid)) {
    process.kill(info.pid, 'SIGTERM');
    console.log(`sent SIGTERM to syncx (pid ${info.pid})`);
  } else {
    console.log('syncx is not running (stale pid file)');
  }
  try {
    unlinkSync(pidFile);
  } catch {
    // 清理失败不影响结果
  }
}

/**
 * EACCES(绑定被拒绝)的平台专属提示。同一错误码在各平台根因不同:
 *   - Windows:几乎总是 WinNAT 排除端口范围(Hyper-V/WSL/Docker 依赖,每次重启漂移),
 *     而非端口被占用 → 给 netsh 排查 + 管理员永久预占命令;
 *   - Linux:绑定 <1024 特权端口,或 SELinux/AppArmor 策略拦截非标端口(Fedora/RHEL 常见);
 *   - macOS:基本只有 <1024 特权端口(root 才能绑定)。
 * 返回的最后一行之后由调用方统一追加「换端口」提示。
 */
export function eaccessHints(port: number): string[] {
  if (process.platform === 'win32') {
    return [
      'Windows 上这通常不是端口被占用,而是被系统保留——Hyper-V/WSL/Docker 依赖的',
      'WinNAT 会在每次重启后动态保留一批 TCP 端口段,该端口恰好落在本次保留范围内。',
      '  排查:netsh interface ipv4 show excludedportrange protocol=tcp',
      '  修复(管理员,永久预占该端口):',
      '    net stop winnat',
      `    netsh int ipv4 add excludedportrange protocol=tcp startport=${port} numberofports=1 store=persistent`,
      '    net start winnat',
    ];
  }
  if (process.platform === 'linux') {
    return [
      port < 1024
        ? 'Linux 上绑定 1024 以下特权端口需要 root——建议直接换一个 ≥1024 的端口。'
        : 'Linux 上绑定被拒绝通常是安全策略拦截(Fedora/RHEL 的 SELinux 常拦截非标端口):',
      ...(port >= 1024
        ? [
            '  SELinux 排查:semanage port -l | grep ' + port,
            `  SELinux 放行(管理员):semanage port -a -t http_port_t -p tcp ${port}`,
          ]
        : []),
    ];
  }
  if (process.platform === 'darwin') {
    return [
      port < 1024
        ? 'macOS 上绑定 1024 以下特权端口需要 root(sudo)——建议直接换一个 ≥1024 的端口。'
        : 'macOS 上该端口被系统策略拒绝,未占用的情况下可尝试关闭防火墙/安全软件后重试。',
    ];
  }
  return ['该端口被系统策略拒绝绑定。'];
}

/**
 * 绑定控制 API 端口:成功 resolve;失败输出可操作的中文提示后立即退出进程。
 *
 * 此前 listen 错误经 uncaughtException 异步抵达,启动日志照常输出,
 * `[fatal]` 淹没在正常日志里且毫无指向性。现在改为:
 *  - 绑定失败 → 打印根因(EACCES 在 Windows 上几乎总是 Hyper-V/WSL/Docker 的
 *    WinNAT 排除端口范围,且范围每次重启漂移,而非端口被占用)+ 排查/修复命令,
 *    process.exit(1);调用方把启动日志全部放在 await 之后,失败时一句多余日志都没有。
 *  - 监听成功 → 换挂常驻 error 处理,运行期错误只记日志,不再崩溃。
 */
export function listenControl(server: HttpServer, port: number, host: string, logError: (msg: string) => void): Promise<void> {
  return new Promise((resolve) => {
    let listening = false;
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (!listening) {
        if (err.code === 'EACCES') {
          console.error(`[fatal] 控制端口绑定被拒绝(EACCES): ${host}:${port}`);
          for (const line of eaccessHints(port)) console.error(line);
          console.error(`  或换端口启动:syncx start --control-port <其他端口>`);
        } else if (err.code === 'EADDRINUSE') {
          console.error(`[fatal] 控制端口已被占用(EADDRINUSE): ${host}:${port}`);
          console.error('可能已有 syncx daemon 在运行(先执行 syncx status / syncx stop),或其他程序占用了该端口;也可用 --control-port 换端口。');
        } else {
          console.error(`[fatal] 控制端口绑定失败: ${host}:${port} (${err.code ?? '未知错误'}) ${err.message}`);
        }
        process.exit(1);
      }
      logError(`control server error: ${err.message}`);
    });
    server.once('listening', () => {
      listening = true;
      resolve();
    });
    server.listen(port, host);
  });
}
