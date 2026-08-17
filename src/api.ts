import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';

export interface ControlServerDeps {
  token: string;
  getStatus: () => unknown;
  /** Static index page served at `/`; API endpoints stay token-protected. */
  uiHtml?: string;
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

/**
 * Local control API on localhost. Every API endpoint requires
 * `Authorization: Bearer <token>`; unknown paths return 404.
 */
export function createControlServer(deps: ControlServerDeps): Server {
  const { token, getStatus, uiHtml } = deps;

  return createServer((req, res) => {
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

    sendJson(res, 404, { error: 'not found' });
  });
}
