import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import webClientJs from './web-client.js';
import { FAVICON_SVG } from './favicon.js';
import {
  clearPassword,
  loadAccount,
  safeEqual,
  sessionSecret,
  setPassword,
  signSession,
  verifyPassword,
  verifySession,
  SESSION_TTL_MS,
  type SessionPayload,
} from './auth.js';

export interface ControlServerDeps {
  token: string;
  /**
   * 账号密码落盘位置(cli 传 ~/.syncx/auth.json)。
   * 不传则禁用账号密码登录,只保留 control.token 一条通道;
   * 文件不存在时同样退回「仅令牌登录」,设置密码后才启用账号登录。
   */
  authFile?: string;
  /** stop 命令经 POST /api/shutdown 触发的优雅关闭;不传则该端点返回 503。 */
  shutdown?: () => void;
  getStatus: () => unknown;
  addFolder?: (path: string, devices: string[], id?: string) => void;
  removeFolder?: (path: string) => void;
  /** 添加一个已知对端设备 ID(按 ID 配对,不依赖邀请码)。可选 address 直接写入
   *  config.peers 并立即直连,用于跨网段/无 mDNS 时手动指定对方 ws:// 地址。 */
  addDevice?: (deviceId: string, address?: string) => void;
  /** 移除一个已知对端设备(同时从各目录 devices 中摘除)。 */
  removeDevice?: (deviceId: string) => void;
  /** 精确设置某目录的设备列表(按目录多选设备的提交)。 */
  setFolderDevices?: (path: string, devices: string[]) => void;
  /** 列出待确认项(对方推送的配对 / 目录共享邀请)。 */
  getOffers?: () => unknown;
  /** 读取某共享目录的同步记录(最近变更,倒序)。参数为目录 ID。 */
  getFolderHistory?: (folderId: string) => unknown;
  /** 确认一个待确认项;目录共享邀请需附带 localPath(本机落地路径)。 */
  acceptOffer?: (offerId: string, localPath?: string) => void;
  /** 忽略一个待确认项。 */
  declineOffer?: (offerId: string) => void;
  /** 恢复一个已忽略的待确认项(置回 pending)。 */
  restoreOffer?: (offerId: string) => void;
  /** 手动触发一轮扫描。 */
  rescan?: () => void;
  /** 手动重连指定对端。 */
  reconnect?: (deviceId: string) => void;
  /**
   * 开发模式的 vite dev server 基址(如 `http://127.0.0.1:5173`)。
   * 设置后,非控制端点的 web 请求会 302 重定向到该地址,由 vite 原生提供 HMR;
   * 浏览器访问 8384 的页面会自动跳到 5173,无需先跑 `vite build`。
   * 控制端点(/api、登录、增删目录)仍由 8384 本地处理。
   * 生产/打包形态不传,走内嵌 bundle 直接提供页面。
   */
  devViteUrl?: string;
}

const COOKIE_NAME = 'syncx_session';

// web 请求在 dev 模式下重定向到 vite dev server(见 createControlServer),
// 不再反向代理,故无需逐跳首部与防回环标记头。

/** 纯 CSR 页面壳:客户端 bundle 挂载后自行拉取状态与处理交互。 */
const UI_SHELL = `<!DOCTYPE html><html lang="zh-CN"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<title>syncx</title>
</head><body>
<div id="app"></div>
<script type="module" src="/client.js"></script>
</body></html>`;

/** 提取请求路径(去掉查询串),用于精确路由匹配。 */
function pathname(rawUrl: string): string {
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
function isControlRoute(method: string, path: string): boolean {
  if (path.startsWith('/api/')) return true;
  if (path === '/health') return true; // dev 模式下探活也命中控制服务,而不是被重定向到 vite
  // 表单提交走 control server:登录写 cookie,目录增删写配置。
  return method === 'POST' && (path === '/login' || path === '/folders' || path === '/actions');
}

// web 请求改为重定向到 vite,proxyToDevServer 已移除。

function readToken(req: IncomingMessage): string | undefined {
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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function redirect(res: ServerResponse, location: string): void {
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
function devViteTarget(req: IncomingMessage, devViteUrl: string): string {
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
function tokenMatches(a: string, b: string): boolean {
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
function lockRemaining(req: IncomingMessage): number {
  const rec = loginFails.get(clientIp(req));
  if (!rec?.until) return 0;
  return Math.max(0, rec.until - Date.now());
}

function noteFailure(req: IncomingMessage): void {
  const ip = clientIp(req);
  const rec = loginFails.get(ip) ?? { count: 0 };
  rec.count += 1;
  if (rec.count >= MAX_FAILS) {
    rec.until = Date.now() + LOCK_MS;
    rec.count = 0;
  }
  loginFails.set(ip, rec);
}

function noteSuccess(req: IncomingMessage): void {
  loginFails.delete(clientIp(req));
}

/** 读取请求体,超过 maxBytes 直接拒绝,防止大请求体耗尽内存。 */
function readBody(req: IncomingMessage, maxBytes = 1_000_000): Promise<string> {
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
        reject(new Error('request body too large'));
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

async function ensureSsr(): Promise<void> {
  // 纯 CSR 化后不再需要 SSR 渲染;保留空实现以兼容调用点(如有)。
}

/**
 * Local control API on localhost. Auth accepts Bearer token (legacy) or
 * the HttpOnly `syncx_session` cookie. Form POSTs redirect back to the
 * SSR page; unknown paths return 404.
 *
 * 若传入 `devViteUrl`,非控制端点的请求会先代理到 vite dev server
 * (见 `isControlRoute`),生产形态下不传该参数。
 */
export function createControlServer(deps: ControlServerDeps): Server {
  const { token, authFile, getStatus, shutdown, addFolder, removeFolder, addDevice, removeDevice, setFolderDevices, rescan, reconnect, getOffers, getFolderHistory, acceptOffer, declineOffer, restoreOffer, devViteUrl } = deps;

  /**
   * 会话签名密钥的「基」。
   * - 已设置账号密码 → 用密码哈希:改/清密码即让所有旧会话失效
   * - 未设置 → 用 control.token:未设密码时也能签发会话(值仍是签名串,
   *   而不是把 token 原文塞进 cookie)
   */
  function sessionBase(): string {
    const acct = authFile ? loadAccount(authFile) : undefined;
    return acct ? acct.hash : token;
  }

  /**
   * token 原文是否匹配。空串一律不算通过 —— 否则 token 为空(或请求伪造空 cookie)时
   * 常量时间比较「空 vs 空」恒真,整个控制 API 等于不设防。
   */
  function tokenAccepted(candidate: string | undefined): boolean {
    if (!candidate || !token) return false;
    return tokenMatches(candidate, token);
  }

  /** 凭据是否有效:Bearer/cookie 里的值可以是 token 原文,也可以是签名会话。 */
  function credentialOk(raw: string | undefined): boolean {
    if (!raw) return false;
    if (tokenAccepted(raw)) return true;
    const session = verifySession(raw, sessionSecret(sessionBase()));
    return session !== undefined;
  }

  /** 下发会话 cookie;值恒定是 base64url 签名串,不含分号/空格/非 ASCII。 */
  function issueSession(res: ServerResponse, payload: SessionPayload): void {
    const value = signSession(payload, sessionSecret(sessionBase()));
    res.setHeader(
      'Set-Cookie',
      `${COOKIE_NAME}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    );
  }

  return createServer((req, res) => {
    void (async () => {
      try {
    const path = req.url ? pathname(req.url) : '/';

    // 站点图标:公开资源,且打包形态下也须可用,
    // 故排在认证兜底与 dev 代理之前,避免落到 401 分支。
    if (req.method === 'GET' && path === '/favicon.svg') {
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'public, max-age=86400',
      });
      res.end(FAVICON_SVG);
      return;
    }
    // GET /health : 免认证健康检查(监控 / 反向代理 / curl 探活)。
    // 故意只报存活与进程运行时长,不暴露版本、设备 ID 等任何细节 —— 该端点谁都能访问。
    if (req.method === 'GET' && path === '/health') {
      sendJson(res, 200, { ok: true, msg: 'syncx is ok', uptime: Math.floor(process.uptime()) });
      return;
    }
    // 浏览器在无 <link rel="icon"> 时会自动请求 .ico;这里显式给 204,
    // 否则会落到下方未认证分支返回 401,在控制台里误导排查。
    if (req.method === 'GET' && path === '/favicon.ico') {
      res.writeHead(204, {});
      res.end();
      return;
    }

    // dev 模式:非控制端点的 web 页面请求重定向到 vite dev server,
    // 由 vite 原生提供 HMR。fetch 反向代理无法转发 HMR 的 WebSocket,
    // 经 8384 打开的页面能加载却不热更新,因此改为重定向(浏览器自动跳到 5173)。
    // 控制端点(/api、登录、增删目录)仍本地处理;生产形态不传 devViteUrl,
    // 走下方内嵌 bundle 直接提供页面。
    if (devViteUrl && !isControlRoute(req.method ?? 'GET', path)) {
      redirect(res, devViteTarget(req, devViteUrl));
      return;
    }

    const reqToken = readToken(req);
    const authenticated = credentialOk(reqToken);

    // GET /api/auth : 公开。告诉登录页当前该渲染哪种表单(账号密码 / 令牌)。
    if (req.method === 'GET' && req.url && pathname(req.url) === '/api/auth') {
      const acct = authFile ? loadAccount(authFile) : undefined;
      sendJson(res, 200, {
        mode: acct ? 'password' : 'token',
        ...(acct ? { username: acct.username } : {}),
        ...(authFile ? {} : { passwordLogin: false }),
      });
      return;
    }

    // POST /api/login : 账号密码登录,成功后下发无状态签名会话。
    if (req.method === 'POST' && req.url && pathname(req.url) === '/api/login') {
      const locked = lockRemaining(req);
      if (locked > 0) {
        sendJson(res, 429, { error: `尝试过于频繁,请 ${Math.ceil(locked / 1000)}s 后重试` });
        return;
      }
      if (!authFile) {
        sendJson(res, 404, { error: '未启用账号密码登录' });
        return;
      }
      let body: { username?: unknown; password?: unknown } = {};
      try {
        body = JSON.parse(await readBody(req)) as typeof body;
      } catch {
        sendJson(res, 400, { error: 'invalid json' });
        return;
      }
      const username = typeof body.username === 'string' ? body.username : '';
      const password = typeof body.password === 'string' ? body.password : '';
      if (!username || !password) {
        sendJson(res, 400, { error: '用户名和密码不能为空' });
        return;
      }
      if (await verifyPassword(authFile, username, password)) {
        noteSuccess(req);
        issueSession(res, { via: 'password', sub: username, exp: Date.now() + SESSION_TTL_MS });
        sendJson(res, 200, { ok: true });
      } else {
        noteFailure(req);
        sendJson(res, 401, { error: '用户名或密码错误' });
      }
      return;
    }

    // POST /api/logout : 清 cookie。会话本身无状态,服务端不需要记录。
    if (req.method === 'POST' && req.url && pathname(req.url) === '/api/logout') {
      res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
      sendJson(res, 200, { ok: true });
      return;
    }

    // GET / : 纯 CSR 页面壳。客户端挂载后自行 fetch /api/status 拉取状态,
    // 交互(手动扫描/重连/增删目录)走 JSON API + fetch,不再整页刷新。
    if (req.method === 'GET' && req.url && pathname(req.url) === '/') {
      sendHtml(res, UI_SHELL);
      return;
    }

    // GET /login : 登录表单(纯 CSR 下由客户端渲染)
    if (req.method === 'GET' && req.url && pathname(req.url) === '/login') {
      sendHtml(res, UI_SHELL);
      return;
    }

    // POST /login : 令牌登录(恢复通道)。同样下发签名会话,不再把 token 原文写进 cookie ——
    // 分号/空格/非 ASCII 会破坏 cookie 语法(甚至让 writeHead 抛错),签名串天然是安全字符集。
    if (req.method === 'POST' && req.url && pathname(req.url) === '/login') {
      const locked = lockRemaining(req);
      if (locked > 0) {
        res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`尝试过于频繁,请 ${Math.ceil(locked / 1000)}s 后重试`);
        return;
      }
      const body = await readBody(req);
      const match = new URLSearchParams(body).get('token');
      if (tokenAccepted(match ?? undefined)) {
        noteSuccess(req);
        issueSession(res, { via: 'token', sub: 'token', exp: Date.now() + SESSION_TTL_MS });
        res.writeHead(302, { Location: '/' });
        res.end();
      } else {
        noteFailure(req);
        sendHtml(res, UI_SHELL);
      }
      return;
    }

    // GET /client.js : 纯 CSR 客户端 bundle。UI 壳由浏览器在加载时即拉取,
    // 此时尚未登录,故保持公开(与 /、/login 一致);写操作仍受 token 保护。
    if (req.method === 'GET' && req.url && pathname(req.url) === '/client.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(webClientJs);
      return;
    }

    if (!authenticated) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    // GET /api/status
    if (req.method === 'GET' && req.url && pathname(req.url) === '/api/status') {
      sendJson(res, 200, getStatus());
      return;
    }

    // POST /api/shutdown : stop 命令的优雅关闭入口。必须已认证(与其它写操作同级):
    // 令牌只在本机磁盘上,拿到它的人本就能随意处置本机数据,但绝不能让无凭据请求关停服务。
    if (req.method === 'POST' && req.url && pathname(req.url) === '/api/shutdown') {
      if (!shutdown) {
        sendJson(res, 503, { error: 'shutdown not available' });
        return;
      }
      sendJson(res, 200, { ok: true, msg: 'shutting down' });
      // 先让响应冲出内核缓冲,再走关闭链路(control.close 在其中)
      setTimeout(shutdown, 50);
      return;
    }

    // 设置 / 修改账号密码。必须已认证(令牌或旧密码均可),
    // 保证「拿到 control.token 才能设密码」这条链不被绕过。
    if (req.method === 'POST' && req.url && pathname(req.url) === '/api/auth/password') {
      if (!authFile) {
        sendJson(res, 404, { error: '未启用账号密码登录' });
        return;
      }
      let body: { username?: unknown; password?: unknown } = {};
      try {
        body = JSON.parse(await readBody(req)) as typeof body;
      } catch {
        sendJson(res, 400, { error: 'invalid json' });
        return;
      }
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      if (!username) {
        sendJson(res, 400, { error: '用户名不能为空' });
        return;
      }
      if (password.length < 6) {
        sendJson(res, 400, { error: '密码至少 6 位' });
        return;
      }
      const rec = await setPassword(authFile, username, password);
      // 密钥基已变成新密码哈希:旧会话立即失效,给当前这次请求补发一条新会话,
      // 否则设置完密码当场就被踢下线。
      issueSession(res, { via: 'password', sub: rec.username, exp: Date.now() + SESSION_TTL_MS });
      sendJson(res, 200, { ok: true, username: rec.username });
      return;
    }

    // 清除账号密码,退回「仅令牌登录」。同样会即时作废所有会话。
    if (req.method === 'DELETE' && req.url && pathname(req.url) === '/api/auth/password') {
      if (!authFile) {
        sendJson(res, 404, { error: '未启用账号密码登录' });
        return;
      }
      clearPassword(authFile);
      sendJson(res, 200, { ok: true });
      return;
    }

    // Form POST /folders : add or (via _method=DELETE) remove a folder
    if (req.method === 'POST' && req.url && pathname(req.url) === '/folders') {
      const params = new URLSearchParams(await readBody(req));
      const method = params.get('_method');
      if (method === 'DELETE' && removeFolder) {
        const path = params.get('path');
        if (path) removeFolder(path);
        redirect(res, '/');
        return;
      }
      const path = params.get('path') ?? '';
      const devicesRaw = params.get('devices') ?? '';
      const devices = devicesRaw.split(',').map((s) => s.trim()).filter(Boolean);
      if (path && addFolder) {
        addFolder(path, devices);
        redirect(res, '/?msg=shared folder added');
        return;
      }
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'path is required' }));
      return;
    }

    // Form POST /actions : 手动重扫或重连(需认证)
    if (req.method === 'POST' && req.url && pathname(req.url) === '/actions') {
      const params = new URLSearchParams(await readBody(req));
      const action = params.get('action');
      if (action === 'rescan' && rescan) {
        rescan();
        redirect(res, '/?msg=' + encodeURIComponent('扫描已触发'));
        return;
      }
      if (action === 'reconnect' && reconnect) {
        const deviceId = params.get('deviceId');
        if (deviceId) reconnect(deviceId);
        redirect(res, '/?msg=' + encodeURIComponent('重连已触发'));
        return;
      }
      redirect(res, '/');
      return;
    }

    // Legacy JSON API: POST /api/folders
    if (req.method === 'POST' && req.url && pathname(req.url) === '/api/folders' && addFolder) {
      try {
        const raw = await readBody(req);
        const body = raw === '' ? {} : JSON.parse(raw);
        if (typeof (body as any).path !== 'string' || (body as any).path === '') {
          sendJson(res, 400, { error: 'path is required' });
          return;
        }
        const devices = ((body as any).devices ?? []).filter((d: unknown): d is string => typeof d === 'string');
        const id = typeof (body as any).id === 'string' && (body as any).id !== '' ? (body as any).id : undefined;
        addFolder((body as any).path, devices, id);
        sendJson(res, 201, { ok: true });
      } catch {
        sendJson(res, 400, { error: 'invalid json body' });
      }
      return;
    }

    // POST /api/folders/devices : 精确设置某目录的设备列表(按目录多选设备)
    if (req.method === 'POST' && req.url && pathname(req.url) === '/api/folders/devices' && setFolderDevices) {
      try {
        const raw = await readBody(req);
        const body = raw === '' ? {} : JSON.parse(raw);
        if (typeof (body as any).path !== 'string' || (body as any).path === '') {
          sendJson(res, 400, { error: 'path is required' });
          return;
        }
        const devices = ((body as any).devices ?? []).filter((d: unknown): d is string => typeof d === 'string');
        setFolderDevices((body as any).path, devices);
        sendJson(res, 200, { ok: true });
      } catch (e) {
        sendJson(res, 400, { error: e instanceof Error ? e.message : 'invalid json body' });
      }
      return;
    }

    // POST /api/devices : 添加一个已知对端设备 ID
    if (req.method === 'POST' && req.url && pathname(req.url) === '/api/devices' && addDevice) {
      try {
        const raw = await readBody(req);
        const body = raw === '' ? {} : JSON.parse(raw);
        if (typeof (body as any).deviceId !== 'string' || (body as any).deviceId === '') {
          sendJson(res, 400, { error: 'deviceId is required' });
          return;
        }
        const address =
          typeof (body as any).address === 'string' && (body as any).address !== ''
            ? (body as any).address
            : undefined;
        addDevice((body as any).deviceId, address);
        sendJson(res, 201, { ok: true });
      } catch (e) {
        sendJson(res, 400, { error: e instanceof Error ? e.message : 'failed to add device' });
      }
      return;
    }

    // DELETE /api/devices?deviceId=xxx : 移除一个已知对端设备
    if (req.method === 'DELETE' && req.url && pathname(req.url) === '/api/devices' && removeDevice) {
      const url = new URL(req.url, 'http://localhost');
      const deviceId = url.searchParams.get('deviceId');
      if (!deviceId) {
        sendJson(res, 400, { error: 'deviceId is required' });
        return;
      }
      removeDevice(deviceId);
      sendJson(res, 200, { ok: true });
      return;
    }

    // GET /api/offers : 列出待确认项(对方推送的配对 / 目录共享邀请)
    if (req.method === 'GET' && req.url && pathname(req.url) === '/api/offers' && getOffers) {
      sendJson(res, 200, getOffers());
      return;
    }

    // GET /api/folders/history?folderId=xxx : 读取某目录的同步记录(倒序)
    if (req.method === 'GET' && req.url && pathname(req.url) === '/api/folders/history' && getFolderHistory) {
      const url = new URL(req.url, 'http://localhost');
      const folderId = url.searchParams.get('folderId');
      if (!folderId) {
        sendJson(res, 400, { error: 'folderId is required' });
        return;
      }
      sendJson(res, 200, { events: getFolderHistory(folderId) });
      return;
    }

    // POST /api/offers/:id/accept : 确认一个待确认项
    // 目录共享邀请需 body 带 localPath(本机落地路径);配对邀请无需路径
    // 注意必须校验 /accept 后缀:否则会截胡同前缀的 /decline 请求,
    // 用 ".../decline" 结尾的错误 id 去查 offer → 报 offer not found。
    if (
      req.method === 'POST' &&
      req.url &&
      pathname(req.url).startsWith('/api/offers/') &&
      pathname(req.url).endsWith('/accept') &&
      acceptOffer
    ) {
      const id = pathname(req.url).slice('/api/offers/'.length).replace(/\/accept$/, '');
      if (!id) {
        sendJson(res, 400, { error: 'offer id is required' });
        return;
      }
      try {
        const raw = await readBody(req);
        const body = raw === '' ? {} : JSON.parse(raw);
        const localPath = typeof (body as any).localPath === 'string' ? (body as any).localPath : undefined;
        acceptOffer(id, localPath);
        sendJson(res, 200, { ok: true });
      } catch (e) {
        // 待确认项不存在 / 目录邀请缺少本地路径 / 配置写入失败:透传错误
        sendJson(res, 400, { error: e instanceof Error ? e.message : 'failed to accept offer' });
      }
      return;
    }

    // POST /api/offers/:id/decline : 忽略一个待确认项
    if (
      req.method === 'POST' &&
      req.url &&
      pathname(req.url).startsWith('/api/offers/') &&
      pathname(req.url).endsWith('/decline') &&
      declineOffer
    ) {
      const id = pathname(req.url).slice('/api/offers/'.length).replace(/\/decline$/, '');
      if (!id) {
        sendJson(res, 400, { error: 'offer id is required' });
        return;
      }
      declineOffer(id);
      sendJson(res, 200, { ok: true });
      return;
    }

    // POST /api/offers/:id/restore : 恢复一个已忽略的待确认项(手误忽略的兜底)
    if (
      req.method === 'POST' &&
      req.url &&
      pathname(req.url).startsWith('/api/offers/') &&
      pathname(req.url).endsWith('/restore') &&
      restoreOffer
    ) {
      const id = pathname(req.url).slice('/api/offers/'.length).replace(/\/restore$/, '');
      if (!id) {
        sendJson(res, 400, { error: 'offer id is required' });
        return;
      }
      try {
        restoreOffer(id);
        sendJson(res, 200, { ok: true });
      } catch (e) {
        sendJson(res, 400, { error: e instanceof Error ? e.message : 'failed to restore offer' });
      }
      return;
    }

    // Legacy JSON API: DELETE /api/folders
    if (req.method === 'DELETE' && req.url && pathname(req.url) === '/api/folders' && removeFolder) {
      const url = new URL(req.url, 'http://localhost');
      const path = url.searchParams.get('path');
      if (path === null || path === '') {
        sendJson(res, 400, { error: 'path is required' });
        return;
      }
      removeFolder(path);
      sendJson(res, 200, { ok: true });
      return;
    }

    // POST /api/rescan : 手动触发一轮扫描
    if (req.method === 'POST' && req.url && pathname(req.url) === '/api/rescan' && rescan) {
      rescan();
      sendJson(res, 200, { ok: true });
      return;
    }

    // POST /api/reconnect?deviceId=xxx : 手动重连指定对端
    if (req.method === 'POST' && req.url && pathname(req.url) === '/api/reconnect' && reconnect) {
      const url = new URL(req.url, 'http://localhost');
      const deviceId = url.searchParams.get('deviceId');
      if (!deviceId) {
        sendJson(res, 400, { error: 'deviceId is required' });
        return;
      }
      reconnect(deviceId);
      sendJson(res, 200, { ok: true });
      return;
    }

    sendJson(res, 404, { error: 'not found' });
      } catch {
        // 读取请求体失败(如超出大小上限):尚未响应时返回 413,避免连接挂起
        if (!res.headersSent) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'request body too large' }));
        }
      }
    })();
  });
}
