import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';

export interface ControlServerDeps {
  token: string;
  getStatus: () => unknown;
  /** Static index page served at `/`; API endpoints stay token-protected. */
  uiHtml?: string;
  /** POST /api/folders handler: add a shared folder. */
  addFolder?: (path: string, devices: string[]) => void;
  /** DELETE /api/folders handler: remove a shared folder by path. */
  removeFolder?: (path: string) => void;
}

function readToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const match = header.match(/^Bearer (.+)$/);
  return match?.[1];
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      try {
        resolve(data === '' ? {} : JSON.parse(data));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

/**
 * Local control API on localhost. Every API endpoint requires
 * `Authorization: Bearer <token>`; unknown paths return 404.
 */
export function createControlServer(deps: ControlServerDeps): Server {
  const { token, getStatus, uiHtml, addFolder, removeFolder } = deps;

  return createServer(async (req, res) => {
    // 静态页面不需要 token(它自己从 /api/status 拉数据时带 token)
    if (req.method === 'GET' && req.url === '/' && uiHtml !== undefined) {
      sendHtml(res, uiHtml);
      return;
    }

    const reqToken = readToken(req);
    if (reqToken !== token) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    if (req.method === 'GET' && req.url === '/api/status') {
      sendJson(res, 200, getStatus());
      return;
    }

    if (req.method === 'POST' && req.url === '/api/folders' && addFolder !== undefined) {
      try {
        const body = (await readBody(req)) as { path?: unknown; devices?: unknown };
        if (typeof body.path !== 'string' || body.path === '') {
          sendJson(res, 400, { error: 'path is required' });
          return;
        }
        const devices = Array.isArray(body.devices)
          ? body.devices.filter((d): d is string => typeof d === 'string')
          : [];
        addFolder(body.path, devices);
        sendJson(res, 201, { ok: true });
      } catch {
        sendJson(res, 400, { error: 'invalid json body' });
      }
      return;
    }

    if (req.method === 'DELETE' && req.url?.startsWith('/api/folders') && removeFolder !== undefined) {
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
  });
}
