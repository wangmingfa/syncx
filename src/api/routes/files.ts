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
 * 文件管理器域(需认证 + **需提权**):
 * - GET    /api/folder-files?folderId&path&limit  列举目录(目录在前,超限截断)
 * - GET    /api/folder-files/download?folderId&path 下载单个文件(流式,不动索引)
 * - DELETE /api/folder-files?folderId&path        删除文件或整个子目录
 *
 * 列真实盘面、能下载任意文件、能删任何子目录 —— 比一般控制 API 危险一档,
 * 因此在登录之外还要求一次性提权(POST /api/elevate,终端同一条门)。每个
 * 放行的请求顺手续期提权 cookie(滑动),只要一直在用就不用反复验证;
 * 闲置过期后由前端引导重新验证。
 *
 * 删除走的是真实文件系统 —— 下一轮扫描会把它作为本地删除传播给对端;
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
  if (!elevated) {
    sendJson(res, 403, { error: '敏感操作需要验证:请先用控制令牌或密码完成验证' });
    return true;
  }
  if (!listFolderDirectory || !resolveFolderFile || !deleteFolderEntry) {
    sendJson(res, 503, { error: 'file browser not available' });
    return true;
  }

  // 放行即滑动续期:setHeader 必须在 writeHead/sendJson 之前,下载分支尤其注意
  reissueElevation(res);

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
