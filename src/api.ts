import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

export interface ControlServerDeps {
  token: string;
  getStatus: () => unknown;
  addFolder?: (path: string, devices: string[]) => void;
  removeFolder?: (path: string) => void;
  /** 手动触发一轮扫描。 */
  rescan?: () => void;
  /** 手动重连指定对端。 */
  reconnect?: (deviceId: string) => void;
}

const COOKIE_NAME = 'syncx_session';

/** 纯 CSR 页面壳:客户端 bundle 挂载后自行拉取状态与处理交互。 */
const UI_SHELL = `<!DOCTYPE html><html lang="zh-CN"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width">
<title>syncx</title>
</head><body>
<div id="app"></div>
<script type="module" src="/client.js"></script>
</body></html>`;

/** 提取请求路径(去掉查询串),用于精确路由匹配。 */
function pathname(rawUrl: string): string {
  return new URL(rawUrl, 'http://localhost').pathname;
}

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
 */
export function createControlServer(deps: ControlServerDeps): Server {
  const { token, getStatus, addFolder, removeFolder, rescan, reconnect } = deps;

  return createServer((req, res) => {
    void (async () => {
      try {
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

    if (!authenticated) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    // GET /client.js : 纯 CSR 客户端 bundle(由 UI_SHELL 的 <script> 加载)
    if (req.method === 'GET' && req.url && pathname(req.url) === '/client.js') {
      try {
        const js = readFileSync(new URL('../dist/web/client.js', import.meta.url));
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
        res.end(js);
      } catch {
        sendJson(res, 500, { error: 'client bundle not built; run npm run build' });
      }
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
        addFolder((body as any).path, ((body as any).devices ?? []).filter((d: unknown): d is string => typeof d === 'string'));
        sendJson(res, 201, { ok: true });
      } catch {
        sendJson(res, 400, { error: 'invalid json body' });
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
