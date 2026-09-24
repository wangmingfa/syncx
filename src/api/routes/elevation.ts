import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadAccount, verifyPassword } from '../../auth.js';
import type { ControlServerDeps } from '../deps.js';
import type { SessionAuth } from '../session.js';
import { ELEVATE_COOKIE, lockRemaining, noteFailure, noteSuccess, pathname, readBody, readCookie, sendJson } from '../helpers.js';

/**
 * 敏感操作提权(终端 / 文件管理器):
 * - GET  /api/elevate  当前是否已提权(前端进敏感页面前先问一次)
 * - POST /api/elevate  提交验证:账号密码 或 控制令牌,成功后下发短时效提权 cookie
 *
 * 登录会话「能看状态」不等于「能开 shell、删文件」:提权必须来自一次新鲜的
 * 凭据校验,cookie 10 分钟有效、仅在敏感请求上滑动续期 —— 离开键盘 10 分钟
 * 回来就要重新验一次。两种验证方式与登录页同款;失败计入与登录同一套失败锁定,
 * 防止拿提权接口绕开登录限速做爆破。
 */
export async function tryElevationRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ControlServerDeps,
  auth: SessionAuth,
): Promise<boolean> {
  const path = req.url ? pathname(req.url) : '/';

  // ---- GET /api/elevate : 提权状态查询(供页面决定要不要弹验证) ----
  if (req.method === 'GET' && path === '/api/elevate') {
    sendJson(res, 200, { ok: auth.elevateOk(readCookie(req, ELEVATE_COOKIE)) });
    return true;
  }

  // ---- POST /api/elevate : 提交验证 ----
  if (req.method === 'POST' && path === '/api/elevate') {
    const locked = lockRemaining(req);
    if (locked > 0) {
      sendJson(res, 429, { error: `尝试过于频繁,请 ${Math.ceil(locked / 1000)}s 后重试` });
      return true;
    }
    let body: { username?: unknown; password?: unknown; token?: unknown } = {};
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: 'invalid json' });
      return true;
    }

    const token = typeof body.token === 'string' ? body.token.trim() : '';
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (token) {
      // 控制令牌通道(也是忘记密码时的恢复通道)
      if (auth.tokenAccepted(token)) {
        noteSuccess(req);
        auth.issueElevation(res);
        sendJson(res, 200, { ok: true });
      } else {
        noteFailure(req);
        sendJson(res, 401, { error: '控制令牌无效' });
      }
      return true;
    }

    // 账号密码通道
    if (!username || !password) {
      sendJson(res, 400, { error: '请提供账号密码或控制令牌' });
      return true;
    }
    if (!deps.authFile) {
      sendJson(res, 404, { error: '未启用账号密码验证' });
      return true;
    }
    if (loadAccount(deps.authFile) === undefined) {
      sendJson(res, 404, { error: '未设置登录账号,请使用控制令牌验证' });
      return true;
    }
    if (await verifyPassword(deps.authFile, username, password)) {
      noteSuccess(req);
      auth.issueElevation(res);
      sendJson(res, 200, { ok: true });
    } else {
      noteFailure(req);
      sendJson(res, 401, { error: '用户名或密码错误' });
    }
    return true;
  }

  return false;
}
