import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ControlServerDeps } from '../deps.js';
import { pathname, readBodyBuffer, sendJson } from '../helpers.js';

/** 系统域:状态查询、日志尾部、优雅关闭、手动扫描与 npm 自更新。 */
export async function trySystemRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ControlServerDeps,
): Promise<boolean> {
  const { getStatus, logFile, shutdown, rescan, checkForUpdate, selfUpdateNpm, inspectLocalPackage, selfUpdateUpload } =
    deps;
  const path = req.url ? pathname(req.url) : '/';

  // dev 运行态:源码启动无单文件运行时可替换,所有自更新接口一律拒绝。
  // 前端入口已拦截,这里作为最后一道防线(防直连 API),并返回明确原因。
  if (deps.devMode && path.startsWith('/api/self-update')) {
    sendJson(res, 400, { ok: false, error: '开发模式下不支持升级功能（运行态为 dev，无单文件运行时可替换）' });
    return true;
  }

  // GET /api/status
  if (req.method === 'GET' && path === '/api/status') {
    sendJson(res, 200, getStatus());
    return true;
  }

  // GET /api/logs?lines=500 : 读取日志文件尾部(Web UI「日志」弹窗)。需认证。
  // 仅在 daemon 以 --log-file 启动时可用:未设置时没有日志文件可读,
  // 返回 ok:false 而非 404,前端据此提示用户补上启动参数。
  if (req.method === 'GET' && req.url && path === '/api/logs') {
    const url = new URL(req.url, 'http://localhost');
    const requested = Number.parseInt(url.searchParams.get('lines') ?? '500', 10);
    const maxLines = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 5000) : 500;
    if (!logFile) {
      sendJson(res, 200, {
        ok: false,
        error: '未设置 --log-file,daemon 没有记录日志文件。启动时加 --log-file <路径> 后可在此查看日志。',
      });
      return true;
    }
    try {
      const content = readFileSync(logFile, 'utf8');
      const all = content.split('\n');
      // 文件以换行结尾时最后一个元素是空串,不计入日志行
      if (all.length > 0 && all[all.length - 1] === '') all.pop();
      const truncated = Math.max(0, all.length - maxLines);
      const lines = all.slice(-maxLines);
      sendJson(res, 200, { ok: true, file: logFile, total: all.length, truncated, lines });
    } catch (e) {
      sendJson(res, 200, { ok: false, error: `读取日志失败:${e instanceof Error ? e.message : String(e)}` });
    }
    return true;
  }

  // POST /api/shutdown : stop 命令的优雅关闭入口。必须已认证(与其它写操作同级):
  // 令牌只在本机磁盘上,拿到它的人本就能随意处置本机数据,但绝不能让无凭据请求关停服务。
  if (req.method === 'POST' && path === '/api/shutdown') {
    if (!shutdown) {
      sendJson(res, 503, { error: 'shutdown not available' });
      return true;
    }
    sendJson(res, 200, { ok: true, msg: 'shutting down' });
    // 先让响应冲出内核缓冲,再走关闭链路(control.close 在其中)
    setTimeout(shutdown, 50);
    return true;
  }

  // POST /api/self-update/check : 立即查一次 npm registry(需认证),返回有无可用更新
  if (req.method === 'POST' && path === '/api/self-update/check') {
    if (!checkForUpdate) {
      sendJson(res, 503, { error: 'update check not available' });
      return true;
    }
    try {
      const update = await checkForUpdate();
      sendJson(res, 200, { ok: true, update: update ?? null });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
    return true;
  }

  // POST /api/self-update : 用户确认后的 npm 自升级(需认证)。
  // 成功时响应后延迟触发优雅关闭,updater 完成换入并拉起新进程(端口不变)。
  if (req.method === 'POST' && path === '/api/self-update') {
    if (!selfUpdateNpm) {
      sendJson(res, 503, { error: 'self-update not available' });
      return true;
    }
    try {
      const r = await selfUpdateNpm();
      sendJson(res, 200, { ok: true, version: r.version, restarting: true });
      setTimeout(() => shutdown?.(), 150);
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
    return true;
  }

  // POST /api/self-update/upload/inspect : 上传安装包的只读预检(需认证)。
  // 请求体即 tgz 原始字节(application/octet-stream,不走 multipart,省掉解析依赖)。
  // 只校验并读出包内版本,不派发 updater、不改动任何运行期状态 —— 供前端在确认前展示版本对比。
  if (req.method === 'POST' && path === '/api/self-update/upload/inspect') {
    if (!inspectLocalPackage) {
      sendJson(res, 503, { error: 'upload update not available' });
      return true;
    }
    try {
      const tgz = await readBodyBuffer(req);
      const info = await inspectLocalPackage(tgz);
      sendJson(res, 200, { ok: true, version: info.version, name: info.name, current: info.current });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
    return true;
  }

  // POST /api/self-update/upload : 上传本地打好的安装包并升级(需认证)。
  // 与 npm / P2P 两条来源汇入同一条管线:校验 → updater 接管换入 → 拉起新 daemon(失败回滚)。
  // 成功时响应后延迟触发优雅关闭,与 POST /api/self-update 保持一致。
  if (req.method === 'POST' && path === '/api/self-update/upload') {
    if (!selfUpdateUpload) {
      sendJson(res, 503, { error: 'upload update not available' });
      return true;
    }
    try {
      const tgz = await readBodyBuffer(req);
      const r = await selfUpdateUpload(tgz);
      sendJson(res, 200, { ok: true, version: r.version, restarting: true });
      setTimeout(() => shutdown?.(), 150);
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
    return true;
  }

  // POST /api/rescan : 手动触发一轮扫描
  if (req.method === 'POST' && path === '/api/rescan' && rescan) {
    rescan();
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}
