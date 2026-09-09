import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ControlServerDeps } from '../deps.js';
import { pathname, readBody, redirect, sendJson } from '../helpers.js';

/** 目录域:目录增删(表单 + JSON API)、设备指派、gitignore 开关、同步记录查询。 */
export async function tryFolderRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ControlServerDeps,
): Promise<boolean> {
  const { addFolder, removeFolder, setFolderDevices, setFolderUseGitignore, getFolderHistory } = deps;
  const path = req.url ? pathname(req.url) : '/';

  // Form POST /folders : add or (via _method=DELETE) remove a folder
  if (req.method === 'POST' && path === '/folders') {
    const params = new URLSearchParams(await readBody(req));
    const method = params.get('_method');
    if (method === 'DELETE' && removeFolder) {
      const p = params.get('path');
      if (p) removeFolder(p);
      redirect(res, '/');
      return true;
    }
    const p = params.get('path') ?? '';
    const devicesRaw = params.get('devices') ?? '';
    const devices = devicesRaw.split(',').map((s) => s.trim()).filter(Boolean);
    if (p && addFolder) {
      addFolder(p, devices);
      redirect(res, '/?msg=shared folder added');
      return true;
    }
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'path is required' }));
    return true;
  }

  // Legacy JSON API: POST /api/folders
  if (req.method === 'POST' && path === '/api/folders' && addFolder) {
    try {
      const raw = await readBody(req);
      const body = raw === '' ? {} : JSON.parse(raw);
      if (typeof (body as any).path !== 'string' || (body as any).path === '') {
        sendJson(res, 400, { error: 'path is required' });
        return true;
      }
      const devices = ((body as any).devices ?? []).filter((d: unknown): d is string => typeof d === 'string');
      const id = typeof (body as any).id === 'string' && (body as any).id !== '' ? (body as any).id : undefined;
      const created = addFolder((body as any).path, devices, id);
      sendJson(res, 201, { ok: true, created });
    } catch {
      sendJson(res, 400, { error: 'invalid json body' });
    }
    return true;
  }

  // POST /api/folders/devices : 精确设置某目录的设备列表(按目录多选设备)
  if (req.method === 'POST' && path === '/api/folders/devices' && setFolderDevices) {
    try {
      const raw = await readBody(req);
      const body = raw === '' ? {} : JSON.parse(raw);
      if (typeof (body as any).path !== 'string' || (body as any).path === '') {
        sendJson(res, 400, { error: 'path is required' });
        return true;
      }
      const devices = ((body as any).devices ?? []).filter((d: unknown): d is string => typeof d === 'string');
      setFolderDevices((body as any).path, devices);
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : 'invalid json body' });
    }
    return true;
  }

  // POST /api/folders/gitignore : 设置某目录是否遵循 .gitignore 忽略规则
  if (req.method === 'POST' && path === '/api/folders/gitignore' && setFolderUseGitignore) {
    try {
      const raw = await readBody(req);
      const body = raw === '' ? {} : JSON.parse(raw);
      if (typeof (body as any).path !== 'string' || (body as any).path === '') {
        sendJson(res, 400, { error: 'path is required' });
        return true;
      }
      setFolderUseGitignore((body as any).path, (body as any).enabled !== false);
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : 'invalid json body' });
    }
    return true;
  }

  // GET /api/folders/history?folderId=xxx : 读取某目录的同步记录(倒序)
  if (req.method === 'GET' && req.url && path === '/api/folders/history' && getFolderHistory) {
    const url = new URL(req.url, 'http://localhost');
    const folderId = url.searchParams.get('folderId');
    if (!folderId) {
      sendJson(res, 400, { error: 'folderId is required' });
      return true;
    }
    sendJson(res, 200, { events: getFolderHistory(folderId) });
    return true;
  }

  // Legacy JSON API: DELETE /api/folders
  if (req.method === 'DELETE' && req.url && path === '/api/folders' && removeFolder) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.searchParams.get('path');
    if (p === null || p === '') {
      sendJson(res, 400, { error: 'path is required' });
      return true;
    }
    removeFolder(p);
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}
