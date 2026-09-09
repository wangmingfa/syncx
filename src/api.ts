import { createServer, type Server } from 'node:http';
import { type ControlServerDeps } from './api/deps.js';
import { createSessionAuth } from './api/session.js';
import { isControlRoute, devViteTarget, pathname, readToken, redirect, sendJson } from './api/helpers.js';
import { tryPreAuthRoutes } from './api/routes/public.js';
import { tryPublicAuthRoutes, tryAccountRoutes } from './api/routes/auth.js';
import { trySystemRoutes } from './api/routes/system.js';
import { tryFolderRoutes } from './api/routes/folders.js';
import { tryDeviceRoutes } from './api/routes/devices.js';
import { tryOfferRoutes } from './api/routes/offers.js';

export type { ControlServerDeps } from './api/deps.js';

/**
 * Local control API on localhost. Auth accepts Bearer token (legacy) or
 * the HttpOnly `syncx_session` cookie. Form POSTs redirect back to the
 * SSR page; unknown paths return 404.
 *
 * 路由按域拆分在 `src/api/routes/` 下,本函数只负责编排分发顺序:
 * 1. 免认证探活/静态资源(favicon、/health)
 * 2. dev 模式下非控制端点的 web 请求重定向到 vite
 * 3. 免认证登录与 UI 入口(/api/auth、/api/login、/logout、/、/client.js)
 * 4. 认证门(401)
 * 5. 各业务域(system → account → folders → devices → offers),均未命中则 404
 *
 * 若传入 `devViteUrl`,非控制端点的请求会先重定向到 vite dev server
 * (见 `isControlRoute`),生产形态下不传该参数。
 */
export function createControlServer(deps: ControlServerDeps): Server {
  const auth = createSessionAuth(deps.token, deps.authFile);

  return createServer((req, res) => {
    void (async () => {
      try {
        // 探活与图标:公开资源,必须在认证与 dev 重定向之前处理
        if (await tryPreAuthRoutes(req, res)) return;

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
        if (await trySystemRoutes(req, res, deps)) return;
        if (await tryAccountRoutes(req, res, deps, auth)) return;
        if (await tryFolderRoutes(req, res, deps)) return;
        if (await tryDeviceRoutes(req, res, deps)) return;
        if (await tryOfferRoutes(req, res, deps)) return;

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
