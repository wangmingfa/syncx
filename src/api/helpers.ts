import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const COOKIE_NAME = 'syncx_session';

/** 敏感操作提权 cookie(终端/文件管理器):独立于登录会话,短时效、独立签名密钥。 */
export const ELEVATE_COOKIE = 'syncx_su';
/** 提权有效期:10 分钟。仅在敏感请求上滑动续期,后台轮询不会续。 */
export const ELEVATE_TTL_MS = 10 * 60 * 1000;

/**
 * 状态推送通道的路径。前端 useStatus.ts 里手写了同一个字面量(客户端 bundle 不 import
 * 后端模块),改这里时务必同步改那边 —— 两边不一致的表现是「界面不再实时更新,悄悄退回
 * 轮询」,不会报错,很难发现。
 */
export const EVENTS_PATH = '/api/events';

/**
 * 纯 CSR 页面壳:客户端 bundle 挂载后自行拉取状态与处理交互。
 *
 * 深色模式的首绘处理:bundle 是 module(延后执行),等它注入样式前 body 是白底,
 * 深色用户会先白闪一下。故在 <head> 内联一段脚本按 localStorage/系统偏好预设
 * `data-theme`,并给深色一条兜底底色。键位与 web/composables/useTheme.ts、
 * web/index.html(dev 入口)三处必须一致。
 */
export const UI_SHELL = `<!DOCTYPE html><html lang="zh-CN"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<title>syncx</title>
<style>html[data-theme=dark]{background:#0f131a;color-scheme:dark}</style>
<script>(function(){try{var m=localStorage.getItem('syncx:theme');var d=m==='dark'||((!m||m==='system')&&matchMedia('(prefers-color-scheme:dark)').matches);if(d)document.documentElement.dataset.theme='dark';}catch(e){}})();</script>
</head><body>
<div id="app"></div>
<script type="module" src="/client.js"></script>
</body></html>`;

/** 提取请求路径(去掉查询串),用于精确路由匹配。 */
export function pathname(rawUrl: string): string {
  const p = new URL(rawUrl, 'http://localhost').pathname;
  // 解码百分号编码(如 offer id 中的冒号 %3A → :),否则含冒号的 offer id
  // 经路由提取后与盘上存储的不一致,导致 accept/decline 报 offer not found。
  // 畸形编码(非法的 %)回退到原始 pathname,避免任意请求触发异常。
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

/**
 * 判断请求是否必须由 control server 本地处理。
 *
 * dev 代理下其余请求一律转交 vite,所以这里必须显式列出全部控制端点,
 * 否则后续新增的 API 会被误当成前端资源代理出去(静默失效)。
 */
export function isControlRoute(method: string, path: string): boolean {
  if (path.startsWith('/api/')) return true;
  if (path === '/health' || path === '/healthz') return true; // dev 模式下探活也命中控制服务,而不是被重定向到 vite
  if (path === '/metrics') return true; // Prometheus 抓取端点同理(见 routes/metrics.ts)
  if (path.startsWith('/s/')) return true; // 分享链接匿名下载:外部访客没有 vite,必须落在 daemon 上(见 routes/share.ts)
  // 表单提交走 control server:登录写 cookie,目录增删写配置。
  return method === 'POST' && (path === '/login' || path === '/folders' || path === '/actions');
}

export function readToken(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (auth) {
    const match = auth.match(/^Bearer (.+)$/);
    if (match) return match[1];
  }
  const cookie = req.headers.cookie ?? '';
  for (const part of cookie.split(';')) {
    const trimmed = part.trim();
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const k = trimmed.slice(0, eqIdx);
    const v = trimmed.slice(eqIdx + 1);
    if (k === COOKIE_NAME) return v;
  }
  return undefined;
}

/** 按名字读单个 cookie(提权校验只认 cookie;Bearer 头是 CLI 场景,不参与提权)。 */
export function readCookie(req: IncomingMessage, name: string): string | undefined {
  const cookie = req.headers.cookie ?? '';
  for (const part of cookie.split(';')) {
    const trimmed = part.trim();
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    if (trimmed.slice(0, eqIdx) === name) return trimmed.slice(eqIdx + 1);
  }
  return undefined;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

export function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { Location: location });
  res.end();
}

/**
 * 计算 dev 模式下 web 请求应跳转到的 vite 地址。
 *
 * 只替换端口、沿用浏览器原本使用的主机名 —— 若直接跳到 `devViteUrl` 里的
 * `127.0.0.1`,从别的机器访问 `http://<host>:8384` 时会被跳到访问者自己的
 * 本机地址而打不开。
 */
export function devViteTarget(req: IncomingMessage, devViteUrl: string): string {
  const vite = new URL(devViteUrl);
  const hostHeader = Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host;
  const target = new URL(req.url ?? '/', devViteUrl);
  if (hostHeader) {
    // Host 形如 `wmf3.com:8384` 或 `[::1]:8384`,只取主机名部分。
    const hostname = new URL(`http://${hostHeader}`).hostname;
    if (hostname) target.hostname = hostname;
  }
  target.port = vite.port;
  return target.toString();
}

/** 常量时间比较,避免 token 校验被时序侧信道利用。 */
export function tokenMatches(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** 登录失败限流:同一来源 IP 连续失败 MAX_FAILS 次后锁 LOCK_MS。 */
const MAX_FAILS = 5;
const LOCK_MS = 60_000;
const loginFails = new Map<string, { count: number; until?: number }>();

function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown';
}

/** 返回剩余锁定时长(ms);0 表示未锁定。 */
export function lockRemaining(req: IncomingMessage): number {
  const rec = loginFails.get(clientIp(req));
  if (!rec?.until) return 0;
  return Math.max(0, rec.until - Date.now());
}

export function noteFailure(req: IncomingMessage): void {
  const ip = clientIp(req);
  const rec = loginFails.get(ip) ?? { count: 0 };
  rec.count += 1;
  if (rec.count >= MAX_FAILS) {
    rec.until = Date.now() + LOCK_MS;
    rec.count = 0;
  }
  loginFails.set(ip, rec);
}

export function noteSuccess(req: IncomingMessage): void {
  loginFails.delete(clientIp(req));
}

/** 请求体超出 maxBytes 时抛出的专用错误,便于顶层 catch-all 区分「体过大」与「其它异常」。 */
export class RequestBodyTooLargeError extends Error {
  constructor() {
    super('request body too large');
    this.name = 'RequestBodyTooLargeError';
  }
}

/** 读取请求体,超过 maxBytes 直接拒绝,防止大请求体耗尽内存。 */
export function readBody(req: IncomingMessage, maxBytes = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    const cleanup = (): void => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
    };

    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > maxBytes) {
        cleanup();
        reject(new RequestBodyTooLargeError());
      }
    };
    const onEnd = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

/**
 * 二进制请求体上限(64MB):与自更新包上限同阶(ws 控制通道亦为 64MB)。
 * 自包含 bundle 压缩后约 220KB,留足余量,超界即视为脏数据。
 */
export const MAX_BINARY_BODY_BYTES = 64 * 1024 * 1024;

/**
 * 读取二进制请求体(上传安装包用),返回原始 Buffer。
 * 与 readBody 分开的原因:后者 toString('utf8') 会把 tgz 的任意字节变成 U+FFFD,
 * 包必然损坏。超限同样抛 RequestBodyTooLargeError(顶层映射为 413)。
 */
export function readBodyBuffer(req: IncomingMessage, maxBytes = MAX_BINARY_BODY_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    const cleanup = (): void => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
    };

    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > maxBytes) {
        cleanup();
        reject(new RequestBodyTooLargeError());
      }
    };
    const onEnd = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}
