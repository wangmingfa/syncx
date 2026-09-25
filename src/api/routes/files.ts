import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ControlServerDeps } from '../deps.js';
import { pathname, sendJson } from '../helpers.js';
import { PathUnsafeError } from '../../filebrowser.js';

/** 提取 folderId/path 查询参数;缺 path 视为根目录。 */
function queryOf(req: IncomingMessage): { folderId: string; path: string; limit?: number } {
  const url = new URL(req.url ?? '/api/folder-files', 'http://localhost');
  const folderId = url.searchParams.get('folderId') ?? '';
  const path = url.searchParams.get('path') ?? '';
  const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined;
  return { folderId, path, limit };
}

/** PathUnsafeError 与「目录不存在」统一转 400 + 原因,其余原样上抛进顶层 500。 */
function sendErr(res: ServerResponse, e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  sendJson(res, 400, { error: msg });
}

/**
 * 文件管理器域(需认证;删除额外**需提权**):
 * - GET    /api/folder-files?folderId&path&limit  列举目录(目录在前,超限截断)——仅需登录
 * - GET    /api/folder-files/download?folderId&path 下载单个文件(流式,不动索引)——仅需登录
 * - DELETE /api/folder-files?folderId&path        删除文件或整个子目录——需提权
 *
 * 鉴权分两档:浏览与下载是只读操作,登录会话(401 门)即可放行;删除会真实变更
 * 文件系统并作为本地删除传播给对端,属敏感操作,在登录之外还要求一次性提权
 * (POST /api/elevate,终端同一条门)。提权的 10 分钟窗口、滑动续期、失败限流等
 * 频率逻辑保持不变 —— 只要持有有效提权 cookie,任意放行的请求顺手续期(滑动),
 * 一直在用就不用反复验证;闲置过期后由前端在删除前引导重新验证。
 *
 * 这与「移除共享目录只摘配置、不删文件」不同,路由注释与 UI 文案都已写明。
 */
export async function tryFileRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ControlServerDeps,
  elevated: boolean,
  reissueElevation: (res: ServerResponse) => void,
): Promise<boolean> {
  const { listFolderDirectory, resolveFolderFile, deleteFolderEntry } = deps;
  const path = req.url ? pathname(req.url) : '/';
  const isFiles = path === '/api/folder-files' || path === '/api/folder-files/download';

  if (!isFiles) return false;
  if (!listFolderDirectory || !resolveFolderFile || !deleteFolderEntry) {
    sendJson(res, 503, { error: 'file browser not available' });
    return true;
  }

  // 删除是变更操作:必须有有效提权 cookie。列举/下载只需登录(401 门已在上游把关)。
  if (req.method === 'DELETE' && !elevated) {
    sendJson(res, 403, { error: '敏感操作需要验证:请先用控制令牌或密码完成验证' });
    return true;
  }

  // 放行即滑动续期(仅当本次确实带了有效提权 cookie):setHeader 必须在
  // writeHead/sendJson 之前,下载分支尤其注意。
  if (elevated) reissueElevation(res);

  // ---- GET /api/folder-files : 目录列举 ----
  if (req.method === 'GET' && path === '/api/folder-files') {
    try {
      const { folderId, path: rel, limit } = queryOf(req);
      if (!folderId) {
        sendJson(res, 400, { error: 'folderId is required' });
        return true;
      }
      sendJson(res, 200, listFolderDirectory(folderId, rel, limit));
    } catch (e) {
      if (e instanceof PathUnsafeError) sendErr(res, e);
      else throw e;
    }
    return true;
  }

  // ---- GET /api/folder-files/download : 流式下载 ----
  if (req.method === 'GET' && path === '/api/folder-files/download') {
    try {
      const { folderId, path: rel } = queryOf(req);
      if (!folderId) {
        sendJson(res, 400, { error: 'folderId is required' });
        return true;
      }
      const abs = resolveFolderFile(folderId, rel);
      const st = await stat(abs);
      if (!st.isFile()) {
        sendJson(res, 400, { error: '只能下载文件' });
        return true;
      }
      // RFC 5987:文件名可能含中文/空格,ASCII 名走 filename,其余走 filename*
      const name = abs.includes('\\') ? abs.slice(abs.lastIndexOf('\\') + 1) : abs.slice(abs.lastIndexOf('/') + 1);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': st.size,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        'Cache-Control': 'no-store',
      });
      const stream = createReadStream(abs);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    } catch (e) {
      if (e instanceof PathUnsafeError) sendErr(res, e);
      else sendErr(res, e);
    }
    return true;
  }

  // ---- DELETE /api/folder-files : 删除(递归目录/文件) ----
  if (req.method === 'DELETE' && path === '/api/folder-files') {
    try {
      const { folderId, path: rel } = queryOf(req);
      if (!folderId) {
        sendJson(res, 400, { error: 'folderId is required' });
        return true;
      }
      if (!rel) {
        sendJson(res, 400, { error: '不能删除共享目录本身' });
        return true;
      }
      deleteFolderEntry(folderId, rel);
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendErr(res, e);
    }
    return true;
  }

  return false;
}
