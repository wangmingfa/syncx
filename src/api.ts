import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { renderControlFallback } from './ui-fallback.js';

export interface ControlServerDeps {
  token: string;
  getStatus: () => unknown;
  addFolder?: (path: string, devices: string[]) => void;
  removeFolder?: (path: string) => void;
  /** Render the SSR app; may be undefined (e.g. in tests) and falls back to a 404. */
  renderSsr?: (data: { status?: unknown; error?: string; message?: string }) => Promise<string>;
}

const COOKIE_NAME = 'syncx_session';

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
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > maxBytes) {
        req.removeListener('data', onData);
        reject(new Error('request body too large'));
        return;
      }
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function ensureSsr(renderSsr?: ControlServerDeps['renderSsr']): Promise<ControlServerDeps['renderSsr'] | undefined> {
  if (renderSsr) return renderSsr;
  try {
    const { render } = await import('./web/server.js');
    const r = (data: { status?: unknown; error?: string; message?: string }) =>
      render(data.status ? 'status' : 'login', data);
    return r;
  } catch {
    // SSR 包缺失时回退到内置渲染器,保证控制页可用
    return (data) => Promise.resolve(renderControlFallback(data));
  }
}

/**
 * Local control API on localhost. Auth accepts Bearer token (legacy) or
 * the HttpOnly `syncx_session` cookie. Form POSTs redirect back to the
 * SSR page; unknown paths return 404.
 */
export function createControlServer(deps: ControlServerDeps): Server {
  const { token, getStatus, addFolder, removeFolder, renderSsr } = deps;

  return createServer((req, res) => {
    void (async () => {
      try {
    const reqToken = readToken(req);
    const authenticated = tokenMatches(reqToken ?? '', token);

    const r = await ensureSsr(renderSsr);

    // GET / : SSR status page (auth required) or login form
    if (req.method === 'GET' && req.url === '/' && r) {
      if (authenticated) {
        sendHtml(res, await r({ status: getStatus() }));
      } else {
        sendHtml(res, await r({ error: undefined }));
      }
      return;
    }

    // GET /login : always render the login form
    if (req.method === 'GET' && req.url === '/login' && r) {
      const error = reqToken !== undefined && !tokenMatches(reqToken, token) ? 'token 无效,请重试' : undefined;
      sendHtml(res, await r({ error }));
      return;
    }

    // POST /login : set HttpOnly session cookie and redirect
    if (req.method === 'POST' && req.url === '/login' && r) {
      const body = await readBody(req);
      const match = new URLSearchParams(body).get('token');
      if (match && tokenMatches(match, token)) {
        res.writeHead(302, {
          Location: '/',
          'Set-Cookie': `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/`,
        });
        res.end();
      } else {
        sendHtml(res, await r({ error: 'token 无效,请重试' }));
      }
      return;
    }

    if (!authenticated) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    // GET /api/status
    if (req.method === 'GET' && req.url === '/api/status') {
      sendJson(res, 200, getStatus());
      return;
    }

    // Form POST /folders : add or (via _method=DELETE) remove a folder
    if (req.method === 'POST' && req.url === '/folders') {
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

    // Legacy JSON API: POST /api/folders
    if (req.method === 'POST' && req.url === '/api/folders' && addFolder) {
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
    if (req.method === 'DELETE' && req.url?.startsWith('/api/folders') && removeFolder) {
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
