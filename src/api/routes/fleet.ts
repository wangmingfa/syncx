import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody, sendJson } from '../helpers.js';

/**
 * 多实例集中管理(fleet)的代理路由。
 *
 * 浏览器里的 fleet 页没法直接跨源 fetch 别的 daemon(整套控制 API 无 CORS,
 * 会话 cookie 也是 SameSite=Lax),所以由本机 daemon 代发:登录用户把目标
 * daemon 的 url + 控制令牌交给本页,本机经服务端 fetch 转发,响应原样回传。
 *
 * 安全边界(刻意收紧,不做通用代理):
 *  - 目标路径白名单:只有 fleet 视图真正需要的三个端点,方法绑定路径;
 *  - 目标 url 只取 origin(路径/查询/片段一律丢弃),scheme 仅 http/https;
 *  - 令牌只进不出:只在转发请求的 Authorization 头里出现,不回显给页面;
 *  - 5s 超时 + 4MB 响应上限:远端挂了或异常肥大时快速失败,不拖垮本页。
 *
 * SSRF 说明:目标由已登录的操作者显式给出,与终端页"给整机 shell"同级信任,
 * 不构成越权面;未登录请求在认证门就被拦下,进不了本路由。
 */

/** fleet 代理白名单:路径 → 方法。新增动作前先想清楚 fleet 视图是否真的需要。 */
const PROXY_ALLOWED: Record<string, 'GET' | 'POST'> = {
  '/api/status': 'GET',
  '/api/pause': 'POST',
  '/api/folders/pause': 'POST',
};

const PROXY_TIMEOUT_MS = 5_000;
const PROXY_MAX_BYTES = 4 * 1024 * 1024;

/** POST /api/fleet/call { url, token, path, body? } : 白名单转发,响应 { ok, status?, data? }。 */
export async function tryFleetRoutes(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method !== 'POST' || (req.url ?? '') !== '/api/fleet/call') return false;

  let body: Record<string, unknown>;
  try {
    const raw = await readBody(req);
    body = raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>);
  } catch {
    sendJson(res, 400, { error: '请求体须为 JSON' });
    return true;
  }

  const { url, token, path } = body;
  if (typeof url !== 'string' || url === '') {
    sendJson(res, 400, { error: 'url is required' });
    return true;
  }
  if (typeof token !== 'string' || token === '' || token.length > 512) {
    sendJson(res, 400, { error: 'token 须为非空字符串(≤512 字符)' });
    return true;
  }
  if (typeof path !== 'string' || !(path in PROXY_ALLOWED)) {
    sendJson(res, 400, { error: 'path 不在 fleet 代理白名单内' });
    return true;
  }

  let origin: string;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('scheme');
    if (u.pathname !== '/' && u.pathname !== '') throw new Error('path');
    origin = u.origin;
  } catch {
    sendJson(res, 400, { error: 'url 须为 http(s) 地址且不含路径' });
    return true;
  }

  const method = PROXY_ALLOWED[path];
  const payload = method === 'POST' && body.body !== undefined ? JSON.stringify(body.body) : undefined;

  try {
    const upstream = await fetch(`${origin}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: payload,
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    });
    const text = await upstream.text();
    if (text.length > PROXY_MAX_BYTES) {
      sendJson(res, 200, { ok: false, error: '远端响应过大(>4MB)' });
      return true;
    }
    let data: unknown = null;
    try {
      data = text === '' ? null : JSON.parse(text);
    } catch {
      // 远端回了非 JSON(被反代改写 / 端口上是别的服务):原样透出前 200 字符帮助排障
      sendJson(res, 200, { ok: false, status: upstream.status, error: `远端响应不是 JSON:${text.slice(0, 200)}` });
      return true;
    }
    sendJson(res, 200, { ok: true, status: upstream.status, data });
  } catch (e) {
    const msg = e instanceof Error && e.name === 'TimeoutError' ? '远端无响应(5s 超时)' : '无法连接远端';
    sendJson(res, 200, { ok: false, error: msg });
  }
  return true;
}
