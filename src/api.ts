import { createServer, type Server } from 'node:http';
import { WebSocketServer } from 'ws';
import { type ControlServerDeps } from './api/deps.js';
import { createSessionAuth } from './api/session.js';
import { isControlRoute, devViteTarget, pathname, readToken, redirect, sendJson, RequestBodyTooLargeError, EVENTS_PATH, ELEVATE_COOKIE, readCookie } from './api/helpers.js';
import { tryPreAuthRoutes } from './api/routes/public.js';
import { tryPublicAuthRoutes, tryAccountRoutes } from './api/routes/auth.js';
import { tryElevationRoutes } from './api/routes/elevation.js';
import { trySystemRoutes } from './api/routes/system.js';
import { tryMetricsRoutes } from './api/routes/metrics.js';
import { tryFolderRoutes } from './api/routes/folders.js';
import { tryDeviceRoutes } from './api/routes/devices.js';
import { tryOfferRoutes } from './api/routes/offers.js';
import { tryFleetRoutes } from './api/routes/fleet.js';
import { tryFileRoutes } from './api/routes/files.js';
import { trySharePublicRoutes, tryShareAdminRoutes } from './api/routes/share.js';
import { TERMINAL_PATH } from './api/terminal.js';

export type { ControlServerDeps } from './api/deps.js';

/**
 * Local control API on localhost. Auth accepts Bearer token (legacy) or
 * the HttpOnly `syncx_session` cookie. Form POSTs redirect back to the
 * SSR page; unknown paths return 404.
 *
 * 路由按域拆分在 `src/api/routes/` 下,本函数只负责编排分发顺序:
 * 1. 免认证探活/静态资源(favicon、/health)+ 分享链接匿名下载(/s/<token>,自带限时令牌)
 * 2. dev 模式下非控制端点的 web 请求重定向到 vite
 * 3. 免认证登录与 UI 入口(/api/auth、/api/login、/logout、/、/client.js)
 * 4. 认证门(401)
 * 5. 各业务域(system → metrics → account → folders → devices → offers → fleet → files → shares),均未命中则 404
 *
 * 若传入 `devViteUrl`,非控制端点的请求会先重定向到 vite dev server
 * (见 `isControlRoute`),生产形态下不传该参数。
 *
 * WebSocket:`WS /api/events` 是状态推送通道(见 status-hub.ts)。握手不走请求
 * 处理器而在 `upgrade` 事件里处理 —— 浏览器无法给 WebSocket 设置请求头,鉴权只能
 * 靠同源 cookie(`syncx_session`),`readToken` 两种凭据都能读,故复用同一套校验。
 */
export function createControlServer(deps: ControlServerDeps): Server {
  const auth = createSessionAuth(deps.token, deps.authFile);

  const server = createServer((req, res) => {
    void (async () => {
      try {
        // 探活与图标:公开资源,必须在认证与 dev 重定向之前处理
        if (await tryPreAuthRoutes(req, res)) return;

        // 分享链接的匿名下载(/s/<token>):自带 HMAC 限时令牌这道门,不进登录域;
        // 也必须排在 dev 重定向之前 —— 收到链接的外部访客没有 vite,更没有会话。
        if (await trySharePublicRoutes(req, res, deps)) return;

        // dev 模式:非控制端点的 web 页面请求重定向到 vite dev server,
        // 由 vite 原生提供 HMR。fetch 反向代理无法转发 HMR 的 WebSocket,
        // 经 8384 打开的页面能加载却不热更新,因此改为重定向(浏览器自动跳到 5173)。
        // 控制端点(/api、登录、增删目录)仍本地处理;生产形态不传 devViteUrl,
        // 走下方内嵌 bundle 直接提供页面。
        const path = req.url ? pathname(req.url) : '/';
        if (deps.devViteUrl && !isControlRoute(req.method ?? 'GET', path)) {
          redirect(res, devViteTarget(req, deps.devViteUrl));
          return;
        }

        const authenticated = auth.credentialOk(readToken(req));

        // 免认证:登录相关 + UI 入口
        if (await tryPublicAuthRoutes(req, res, deps, auth)) return;

        if (!authenticated) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }

        // 已认证业务域;每域未命中返回 false,落到下一个域,最后 404
        if (await tryElevationRoutes(req, res, deps, auth)) return;
        if (await trySystemRoutes(req, res, deps)) return;
        // Prometheus 抓取端点:走登录门(Bearer 令牌或会话 cookie),不进提权域
        if (await tryMetricsRoutes(req, res, deps)) return;
        if (await tryAccountRoutes(req, res, deps, auth)) return;
        if (await tryFolderRoutes(req, res, deps)) return;
        if (await tryDeviceRoutes(req, res, deps)) return;
        if (await tryOfferRoutes(req, res, deps)) return;
        // fleet 代理:多实例集中管理页经本机 daemon 转发远端 daemon(白名单收紧,见 routes/fleet.ts)
        if (await tryFleetRoutes(req, res)) return;
        // 分享链接管理面(列出/创建/撤销):创建需提权,列出与撤销仅需登录门
        if (await tryShareAdminRoutes(req, res, deps, auth.elevateOk(readCookie(req, ELEVATE_COOKIE)), auth.issueElevation)) return;
        // 文件管理器是敏感域:除了登录,还要一次性提权(终端/文件管理器共用)
        if (await tryFileRoutes(req, res, deps, auth.elevateOk(readCookie(req, ELEVATE_COOKIE)), auth.issueElevation)) return;

        sendJson(res, 404, { error: 'not found' });
      } catch (err) {
        if (err instanceof RequestBodyTooLargeError) {
          // 请求体超过大小上限:返回 413,避免连接挂起
          if (!res.headersSent) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'request body too large' }));
          }
          return;
        }
        // 其它未捕获异常(路由逻辑错、DB/索引异常、JSON 解析错等):记录日志并返回 500,
        // 不再误诊为「请求体过大」,便于排障。避免把真实错误掩盖成 413。
        console.error('[control-api] unhandled error:', err instanceof Error ? (err.stack ?? err.message) : err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal server error' }));
        }
      }
    })();
  });

  // WebSocket 升级:/api/events 是状态推送(status-hub),/api/terminal 是浏览器内
  // 终端(简易 shell 通道),其余路径一律断开 —— 放着不管会让连接永久挂起。
  // 鉴权失败回一个 401 响应再断开 —— 客户端能据此区分「没登录」与「网络不通」,
  // 而不是看到一个没有原因的重连循环。
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const path = req.url ? pathname(req.url) : '/';
    const eventsOk = path === EVENTS_PATH && deps.statusHub;
    const terminalOk = path === TERMINAL_PATH && deps.terminal;
    if (!eventsOk && !terminalOk) {
      socket.destroy();
      return;
    }
    if (!auth.credentialOk(readToken(req))) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    // 终端是最高危通道(整机 shell):登录之外还要提权。文件管理器的三个 HTTP
    // 路由在请求处理器里查,这里是 WS 的对应关口;过期后重连会被打回,前端
    // 收到关闭会重新探测并弹验证。
    if (terminalOk && !auth.elevateOk(readCookie(req, ELEVATE_COOKIE))) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (terminalOk && !eventsOk) {
      const terminal = deps.terminal!;
      wss.handleUpgrade(req, socket, head, (ws) => terminal.handle(ws));
      return;
    }
    const hub = deps.statusHub!;
    wss.handleUpgrade(req, socket, head, (ws) => hub.attach(ws));
  });

  return server;
}
