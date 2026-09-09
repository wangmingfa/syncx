import type { IncomingMessage, ServerResponse } from 'node:http';
import { clearPassword, loadAccount, setPassword, verifyPassword, SESSION_TTL_MS } from '../../auth.js';
import type { ControlServerDeps } from '../deps.js';
import type { SessionAuth } from '../session.js';
import {
  COOKIE_NAME,
  lockRemaining,
  noteFailure,
  noteSuccess,
  pathname,
  readBody,
  sendHtml,
  sendJson,
  UI_SHELL,
} from '../helpers.js';
import webClientJs from '../../web-client.js';

/**
 * 免认证路由:登录相关(/api/auth、/api/login、/api/logout)+ UI 入口
 *(/、/login、/client.js)。认证门(401)在这些路由之后才生效。
 */
export async function tryPublicAuthRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ControlServerDeps,
  auth: SessionAuth,
): Promise<boolean> {
  const { authFile } = deps;
  const path = req.url ? pathname(req.url) : '/';

  // GET /api/auth : 公开。告诉登录页当前该渲染哪种表单(账号密码 / 令牌)。
  if (req.method === 'GET' && path === '/api/auth') {
    const acct = authFile ? loadAccount(authFile) : undefined;
    sendJson(res, 200, {
      mode: acct ? 'password' : 'token',
      ...(acct ? { username: acct.username } : {}),
      ...(authFile ? {} : { passwordLogin: false }),
    });
    return true;
  }

  // POST /api/login : 账号密码登录,成功后下发无状态签名会话。
  if (req.method === 'POST' && path === '/api/login') {
    const locked = lockRemaining(req);
    if (locked > 0) {
      sendJson(res, 429, { error: `尝试过于频繁,请 ${Math.ceil(locked / 1000)}s 后重试` });
      return true;
    }
    if (!authFile) {
      sendJson(res, 404, { error: '未启用账号密码登录' });
      return true;
    }
    let body: { username?: unknown; password?: unknown } = {};
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: 'invalid json' });
      return true;
    }
    const username = typeof body.username === 'string' ? body.username : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!username || !password) {
      sendJson(res, 400, { error: '用户名和密码不能为空' });
      return true;
    }
    if (await verifyPassword(authFile, username, password)) {
      noteSuccess(req);
      auth.issueSession(res, { via: 'password', sub: username, exp: Date.now() + SESSION_TTL_MS });
      sendJson(res, 200, { ok: true });
    } else {
      noteFailure(req);
      sendJson(res, 401, { error: '用户名或密码错误' });
    }
    return true;
  }

  // POST /api/logout : 清 cookie。会话本身无状态,服务端不需要记录。
  if (req.method === 'POST' && path === '/api/logout') {
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    sendJson(res, 200, { ok: true });
    return true;
  }

  // GET / : 纯 CSR 页面壳。客户端挂载后自行 fetch /api/status 拉取状态,
  // 交互(手动扫描/重连/增删目录)走 JSON API + fetch,不再整页刷新。
  if (req.method === 'GET' && path === '/') {
    sendHtml(res, UI_SHELL);
    return true;
  }

  // GET /login : 登录表单(纯 CSR 下由客户端渲染)
  if (req.method === 'GET' && path === '/login') {
    sendHtml(res, UI_SHELL);
    return true;
  }

  // POST /login : 令牌登录(恢复通道)。同样下发签名会话,不再把 token 原文写进 cookie ——
  // 分号/空格/非 ASCII 会破坏 cookie 语法(甚至让 writeHead 抛错),签名串天然是安全字符集。
  if (req.method === 'POST' && path === '/login') {
    const locked = lockRemaining(req);
    if (locked > 0) {
      res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`尝试过于频繁,请 ${Math.ceil(locked / 1000)}s 后重试`);
      return true;
    }
    const body = await readBody(req);
    const match = new URLSearchParams(body).get('token');
    if (auth.tokenAccepted(match ?? undefined)) {
      noteSuccess(req);
      auth.issueSession(res, { via: 'token', sub: 'token', exp: Date.now() + SESSION_TTL_MS });
      res.writeHead(302, { Location: '/' });
      res.end();
    } else {
      noteFailure(req);
      sendHtml(res, UI_SHELL);
    }
    return true;
  }

  // GET /client.js : 纯 CSR 客户端 bundle。UI 壳由浏览器在加载时即拉取,
  // 此时尚未登录,故保持公开(与 /、/login 一致);写操作仍受 token 保护。
  if (req.method === 'GET' && path === '/client.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
    res.end(webClientJs);
    return true;
  }

  return false;
}

/** 已认证后的账号管理:设置 / 清除账号密码(改密即时作废旧会话并补发新会话)。 */
export async function tryAccountRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ControlServerDeps,
  auth: SessionAuth,
): Promise<boolean> {
  const { authFile } = deps;
  const path = req.url ? pathname(req.url) : '/';

  // 设置 / 修改账号密码。必须已认证(令牌或旧密码均可),
  // 保证「拿到 control.token 才能设密码」这条链不被绕过。
  if (req.method === 'POST' && path === '/api/auth/password') {
    if (!authFile) {
      sendJson(res, 404, { error: '未启用账号密码登录' });
      return true;
    }
    let body: { username?: unknown; password?: unknown } = {};
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: 'invalid json' });
      return true;
    }
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!username) {
      sendJson(res, 400, { error: '用户名不能为空' });
      return true;
    }
    if (password.length < 6) {
      sendJson(res, 400, { error: '密码至少 6 位' });
      return true;
    }
    const rec = await setPassword(authFile, username, password);
    // 密钥基已变成新密码哈希:旧会话立即失效,给当前这次请求补发一条新会话,
    // 否则设置完密码当场就被踢下线。
    auth.issueSession(res, { via: 'password', sub: rec.username, exp: Date.now() + SESSION_TTL_MS });
    sendJson(res, 200, { ok: true, username: rec.username });
    return true;
  }

  // 清除账号密码,退回「仅令牌登录」。同样会即时作废所有会话。
  if (req.method === 'DELETE' && path === '/api/auth/password') {
    if (!authFile) {
      sendJson(res, 404, { error: '未启用账号密码登录' });
      return true;
    }
    clearPassword(authFile);
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}
