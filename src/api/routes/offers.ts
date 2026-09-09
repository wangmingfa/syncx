import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ControlServerDeps } from '../deps.js';
import { pathname, readBody, sendJson } from '../helpers.js';

/** 待确认项域:配对 / 目录共享邀请的查看、确认、忽略与恢复。 */
export async function tryOfferRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ControlServerDeps,
): Promise<boolean> {
  const { getOffers, acceptOffer, declineOffer, restoreOffer } = deps;
  const path = req.url ? pathname(req.url) : '/';

  // GET /api/offers : 列出待确认项(对方推送的配对 / 目录共享邀请)
  if (req.method === 'GET' && path === '/api/offers' && getOffers) {
    sendJson(res, 200, getOffers());
    return true;
  }

  // POST /api/offers/:id/accept : 确认一个待确认项
  // 目录共享邀请需 body 带 localPath(本机落地路径);配对邀请无需路径
  // 注意必须校验 /accept 后缀:否则会截胡同前缀的 /decline 请求,
  // 用 ".../decline" 结尾的错误 id 去查 offer → 报 offer not found。
  if (req.method === 'POST' && path.startsWith('/api/offers/') && path.endsWith('/accept') && acceptOffer) {
    const id = path.slice('/api/offers/'.length).replace(/\/accept$/, '');
    if (!id) {
      sendJson(res, 400, { error: 'offer id is required' });
      return true;
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
    return true;
  }

  // POST /api/offers/:id/decline : 忽略一个待确认项
  if (req.method === 'POST' && path.startsWith('/api/offers/') && path.endsWith('/decline') && declineOffer) {
    const id = path.slice('/api/offers/'.length).replace(/\/decline$/, '');
    if (!id) {
      sendJson(res, 400, { error: 'offer id is required' });
      return true;
    }
    declineOffer(id);
    sendJson(res, 200, { ok: true });
    return true;
  }

  // POST /api/offers/:id/restore : 恢复一个已忽略的待确认项(手误忽略的兜底)
  if (req.method === 'POST' && path.startsWith('/api/offers/') && path.endsWith('/restore') && restoreOffer) {
    const id = path.slice('/api/offers/'.length).replace(/\/restore$/, '');
    if (!id) {
      sendJson(res, 400, { error: 'offer id is required' });
      return true;
    }
    try {
      restoreOffer(id);
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : 'failed to restore offer' });
    }
    return true;
  }

  return false;
}
