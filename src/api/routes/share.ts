import { createReadStream, type Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ControlServerDeps } from '../deps.js';
import { pathname, readBody, sendJson } from '../helpers.js';

/**
 * 分享链接域(默认关闭,见 src/share.ts):
 *
 * - 匿名下载 `GET /s/<token>`:免登录、限时、单文件只读。排在认证门与 dev 重定向
 *   之前处理 —— 链接就是给没有会话的人用的;关着或令牌无效一律 404(不给探测者
 *   区分「不存在/过期/撤销」的信息)。
 * - 管理面(登录门内):
 *   - GET  /api/shares                列出在册有效分享 + 开关状态
 *   - POST /api/shares/create         创建链接 —— 开放匿名读属敏感操作,与删除/终端
 *                                     同一条提权门(syncx_su cookie)
 *   - POST /api/shares/revoke         撤销(删记录,立即失效)—— 撤销是收紧权限,登录即可
 */

/** 匿名端点的失败限流:同 IP 每分钟探测超过 FAIL_MAX 次即 429(挡令牌爆破/枚举)。 */
const FAIL_WINDOW_MS = 60_000;
const FAIL_MAX = 40;
const failCounts = new Map<string, { count: number; windowStart: number }>();

/** 测试钩子:限流是模块级状态,单测之间需要清零。 */
export function resetShareRateLimit(): void {
  failCounts.clear();
}

function noteFailureAndCheckLimited(ip: string): boolean {
  const now = Date.now();
  const rec = failCounts.get(ip);
  if (!rec || now - rec.windowStart > FAIL_WINDOW_MS) {
    failCounts.set(ip, { count: 1, windowStart: now });
    return false;
  }
  rec.count += 1;
  return rec.count > FAIL_MAX;
}

function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown';
}

/** 创建链接允许的有效期(小时):白名单杜绝「分享一百年」的手滑。 */
const ALLOWED_TTL_HOURS = [1, 24, 168, 720] as const;

/**
 * 匿名下载:`GET /s/<token>`。命中该前缀就吃掉请求(含失败路径),
 * 绝不让未知令牌继续落到认证/404 链路上——语义统一为「这个链接不存在」。
 */
export async function trySharePublicRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ControlServerDeps,
): Promise<boolean> {
  const path = req.url ? pathname(req.url) : '/';
  if (!path.startsWith('/s/')) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'method not allowed' });
    return true;
  }
  const ip = clientIp(req);
  const share = deps.share;
  const token = path.slice(3);
  // 限流先于一切:锁定后连「开关是否开着」都不透露,失败原因也不区分(一律先 429)
  const recent = failCounts.get(ip);
  if (recent && Date.now() - recent.windowStart <= FAIL_WINDOW_MS && recent.count > FAIL_MAX) {
    sendJson(res, 429, { error: 'too many failed attempts' });
    return true;
  }
  if (!share || !share.enabled() || !deps.resolveFolderFile || token === '' || token.length > 200) {
    sendJson(res, 404, { error: 'not found' });
    return true;
  }
  const verified = share.verify(token);
  if (!verified) {
    if (noteFailureAndCheckLimited(ip)) {
      share.reportFailure?.(ip, 'rate-limited');
      sendJson(res, 429, { error: 'too many failed attempts' });
      return true;
    }
    share.reportFailure?.(ip, 'invalid-token');
    sendJson(res, 404, { error: 'not found' });
    return true;
  }
  let abs: string;
  let st: Stats;
  try {
    abs = deps.resolveFolderFile(verified.folderId, verified.path);
    st = await stat(abs);
    if (!st.isFile()) throw new Error('not a file');
  } catch {
    // 目录被移除 / 文件已删除 / 记录指向占位:记录虽在,内容已不可得
    share.reportFailure?.(ip, 'file-gone');
    sendJson(res, 404, { error: 'not found' });
    return true;
  }
  share.noteDownload(verified.id, ip);
  const name = abs.includes('\\') ? abs.slice(abs.lastIndexOf('\\') + 1) : abs.slice(abs.lastIndexOf('/') + 1);
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': st.size,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Cache-Control': 'no-store',
  });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  const stream = createReadStream(abs);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
  return true;
}

/** 管理面:列分享 / 创建(需提权)/ 撤销(登录即可)。 */
export async function tryShareAdminRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ControlServerDeps,
  elevated: boolean,
  reissueElevation: (res: ServerResponse) => void,
): Promise<boolean> {
  const path = req.url ? pathname(req.url) : '/';
  if (path !== '/api/shares' && path !== '/api/shares/create' && path !== '/api/shares/revoke') {
    return false;
  }
  const share = deps.share;
  if (!share) {
    sendJson(res, 503, { error: 'share not available' });
    return true;
  }

  // GET /api/shares : 在册分享(只读,登录门已过)
  if (req.method === 'GET' && path === '/api/shares') {
    sendJson(res, 200, { enabled: share.enabled(), shares: share.list() });
    return true;
  }

  if (req.method === 'POST' && path === '/api/shares/create') {
    // 创建 = 对外开放匿名读一道门:与删除文件同一条提权门
    if (!elevated) {
      sendJson(res, 403, { error: '敏感操作需要验证:请先用控制令牌或密码完成验证' });
      return true;
    }
    try {
      const raw = await readBody(req);
      const body = raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>);
      if (!share.enabled()) {
        sendJson(res, 400, { error: '分享链接未启用:请先在全局设置中打开开关' });
        return true;
      }
      const folderId = body.folderId;
      const relPath = body.path;
      const ttlHours = body.ttlHours;
      if (typeof folderId !== 'string' || folderId === '') {
        sendJson(res, 400, { error: 'folderId is required' });
        return true;
      }
      if (typeof relPath !== 'string' || relPath === '') {
        sendJson(res, 400, { error: '不能分享目录本身,请选择文件' });
        return true;
      }
      if (typeof ttlHours !== 'number' || !(ALLOWED_TTL_HOURS as readonly number[]).includes(ttlHours)) {
        sendJson(res, 400, { error: `有效期只能是 ${ALLOWED_TTL_HOURS.join('/')} 小时` });
        return true;
      }
      const r = share.create(folderId, relPath, ttlHours * 3_600_000);
      reissueElevation(res);
      sendJson(res, 200, { ok: true, urlToken: r.urlToken, expiresAt: r.expiresAt });
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : '创建分享失败' });
    }
    return true;
  }

  if (req.method === 'POST' && path === '/api/shares/revoke') {
    try {
      const raw = await readBody(req);
      const body = raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>);
      const id = body.id;
      if (typeof id !== 'string' || id === '') {
        sendJson(res, 400, { error: 'id is required' });
        return true;
      }
      share.revoke(id);
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : '撤销分享失败' });
    }
    return true;
  }

  sendJson(res, 405, { error: 'method not allowed' });
  return true;
}
