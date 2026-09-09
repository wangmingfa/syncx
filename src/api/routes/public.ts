import type { IncomingMessage, ServerResponse } from 'node:http';
import { FAVICON_SVG } from '../../favicon.js';
import { pathname, sendJson } from '../helpers.js';

/**
 * 免认证的探活与静态资源:favicon.svg、/health、favicon.ico。
 * 必须排在认证兜底与 dev 重定向之前,避免落到 401 分支。
 */
export async function tryPreAuthRoutes(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = req.url ? pathname(req.url) : '/';

  // 站点图标:公开资源,且打包形态下也须可用,
  // 故排在认证兜底与 dev 代理之前,避免落到 401 分支。
  if (req.method === 'GET' && path === '/favicon.svg') {
    res.writeHead(200, {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=86400',
    });
    res.end(FAVICON_SVG);
    return true;
  }
  // GET /health : 免认证健康检查(监控 / 反向代理 / curl 探活)。
  // 故意只报存活与进程运行时长,不暴露版本、设备 ID 等任何细节 —— 该端点谁都能访问。
  if (req.method === 'GET' && path === '/health') {
    sendJson(res, 200, { ok: true, msg: 'syncx is ok', uptime: Math.floor(process.uptime()) });
    return true;
  }
  // 浏览器在无 <link rel="icon"> 时会自动请求 .ico;这里显式给 204,
  // 否则会落到下方未认证分支返回 401,在控制台里误导排查。
  if (req.method === 'GET' && path === '/favicon.ico') {
    res.writeHead(204, {});
    res.end();
    return true;
  }
  return false;
}
