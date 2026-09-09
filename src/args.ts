/** CLI 参数解析与重连退避策略(纯函数,无 daemon 状态)。 */

export interface ParsedArgs {
  command: 'start' | 'stop' | 'status' | 'install' | 'invite' | 'join' | 'revoke' | 'upgrade';
  /** 位置参数(如 invite/join 的参数)。 */
  positionals: string[];
  configPath?: string;
  port?: number;
  controlPort?: number;
  /** Control API/Web UI bind host; default 127.0.0.1 (localhost only). */
  host?: string;
  /** 日志文件路径;不指定则仅输出到 stdout。 */
  logFile?: string;
  /** dev 模式:vite dev server 基址(如 http://127.0.0.1:5173)。设置后 8384 的 web 页面请求会 302 重定向过去,由 vite 提供 HMR;不设置则 8384 直接提供页面(生产/打包形态)。 */
  devViteUrl?: string;
}

const COMMANDS = new Set(['start', 'stop', 'status', 'install', 'invite', 'join', 'revoke', 'upgrade']);

/** 控制 API 可安全绑定的回环地址;非回环地址必须显式 --expose-control。 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/** 断线重连退避基数与上限(指数退避 1s、2s、4s…,封顶 30s)。 */
export const RECONNECT_BASE_MS = 1000;
export const RECONNECT_MAX_MS = 30000;

/**
 * 断线重连退避延迟:attempts 为已连续失败次数。
 * 第 0 次(首连失败)立即重试(0ms),之后按指数退避 —— 避免双 daemon
 * 同时启动时互相 ECONNREFUSED,连接建立被推后到 30s 边缘。
 */
export function reconnectDelayMs(attempts: number): number {
  if (attempts <= 0) return 0;
  return Math.min(RECONNECT_BASE_MS * 2 ** (attempts - 1), RECONNECT_MAX_MS);
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [rawCommand, ...rest] = argv;

  const result: ParsedArgs = {
    command: (rawCommand ?? 'start') as ParsedArgs['command'],
    positionals: [],
  };
  if (!COMMANDS.has(result.command)) {
    throw new Error(`unknown command: ${String(rawCommand)}`);
  }

  let exposeControl = false;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === undefined) break;
    const value = rest[i + 1];
    if (flag === '--config') {
      result.configPath = value;
      i++;
    } else if (flag === '--port') {
      result.port = Number(value);
      i++;
    } else if (flag === '--control-port') {
      result.controlPort = Number(value);
      i++;
    } else if (flag === '--host') {
      result.host = value;
      i++;
    } else if (flag === '--log-file') {
      result.logFile = value;
      i++;
    } else if (flag === '--dev-vite') {
      // 用 URL 构造器校验:非法基址在此处就报错,而不是等某次请求代理时才炸。
      new URL(String(value));
      result.devViteUrl = value;
      i++;
    } else if (flag === '--expose-control') {
      exposeControl = true;
    } else if (flag.startsWith('-')) {
      throw new Error(`unknown option: ${flag}`);
    } else {
      result.positionals.push(flag);
    }
  }

  // 控制 API 暴露防护:非回环地址把控制端点以明文 HTTP 暴露到 LAN,token 可被
  // 嗅探。必须显式 --expose-control 才允许,否则拒绝启动。
  if (result.host !== undefined && !LOOPBACK_HOSTS.has(result.host) && !exposeControl) {
    throw new Error(
      `--host ${result.host} exposes the control API over plain HTTP on the LAN; pass --expose-control to allow it`,
    );
  }

  return result;
}
