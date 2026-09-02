import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import webClientJs from './web-client.js';
import { FAVICON_SVG } from './favicon.js';

export interface ControlServerDeps {
  token: string;
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
  /** 确认一个待确认项;目录共享邀请需附带 localPath(本机落地路径)。 */
  acceptOffer?: (offerId: string, localPath?: string) => void;
  /** 忽略一个待确认项。 */
  declineOffer?: (offerId: string) => void;
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
  return new URL(rawUrl, 'http://localhost').pathname;
}

/**
 * 判断请求是否必须由 control server 本地处理。
 *
 * dev 代理下其余请求一律转交 vite,所以这里必须显式列出全部控制端点,
 * 否则后续新增的 API 会被误当成前端资源代理出去(静默失效)。
 */
function isControlRoute(method: string, path: string): boolean {
  if (path.startsWith('/api/')) return true;
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
  const { token, getStatus, addFolder, removeFolder, addDevice, removeDevice, setFolderDevices, rescan, reconnect, getOffers, acceptOffer, declineOffer, devViteUrl } = deps;

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
    const authenticated = tokenMatches(reqToken ?? '', token);

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

    // POST /login : set HttpOnly session cookie and redirect
    if (req.method === 'POST' && req.url && pathname(req.url) === '/login') {
      const body = await readBody(req);
      const match = new URLSearchParams(body).get('token');
      if (match && tokenMatches(match, token)) {
        res.writeHead(302, {
          Location: '/',
          'Set-Cookie': `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/`,
        });
        res.end();
      } else {
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

    // POST /api/offers/:id/accept : 确认一个待确认项
    // 目录共享邀请需 body 带 localPath(本机落地路径);配对邀请无需路径
    if (req.method === 'POST' && req.url && pathname(req.url).startsWith('/api/offers/') && acceptOffer) {
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
    if (req.method === 'POST' && req.url && pathname(req.url).startsWith('/api/offers/') && declineOffer) {
      const id = pathname(req.url).slice('/api/offers/'.length).replace(/\/decline$/, '');
      if (!id) {
        sendJson(res, 400, { error: 'offer id is required' });
        return;
      }
      declineOffer(id);
      sendJson(res, 200, { ok: true });
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
