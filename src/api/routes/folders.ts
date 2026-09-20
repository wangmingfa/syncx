import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ControlServerDeps } from '../deps.js';
import { pathname, readBody, redirect, sendJson } from '../helpers.js';

/** 目录域:目录增删(表单 + JSON API)、设备指派、gitignore 开关、同步记录查询。 */
export async function tryFolderRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ControlServerDeps,
): Promise<boolean> {
  const { addFolder, removeFolder, setFolderDevices, setFolderUseGitignore, getFolderHistory, clearFolderHistory, diffFolder, compareFolder, readFilePair, applyFileSync } = deps;
  const path = req.url ? pathname(req.url) : '/';

  // Form POST /folders : add or (via _method=DELETE) remove a folder
  if (req.method === 'POST' && path === '/folders') {
    const params = new URLSearchParams(await readBody(req));
    const method = params.get('_method');
    if (method === 'DELETE' && removeFolder) {
      const p = params.get('path');
      if (p) removeFolder(p, { purgeIndex: params.get('purgeIndex') === '1' });
      redirect(res, '/');
      return true;
    }
    const p = params.get('path') ?? '';
    const devicesRaw = params.get('devices') ?? '';
    const devices = devicesRaw.split(',').map((s) => s.trim()).filter(Boolean);
    const receiveOnly = params.get('receiveOnly') === '1' || params.get('receiveOnly') === 'true';
    if (p && addFolder) {
      addFolder(p, devices, undefined, receiveOnly);
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
      const receiveOnly = (body as any).receiveOnly === true;
      const created = addFolder((body as any).path, devices, id, receiveOnly);
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

  // GET /api/folders/diff?folderId=xxx&device=yyy : 与指定对端对比同一目录 id 的内容
  // (诊断用,只读:不改动任何一端的状态,见 docs/adr/0013)
  if (req.method === 'GET' && req.url && path === '/api/folders/diff' && diffFolder) {
    const url = new URL(req.url, 'http://localhost');
    const folderId = url.searchParams.get('folderId');
    const device = url.searchParams.get('device');
    if (!folderId || !device) {
      sendJson(res, 400, { error: 'folderId and device are required' });
      return true;
    }
    try {
      sendJson(res, 200, await diffFolder(folderId, device));
    } catch (e) {
      // 设备离线 / 对端版本过旧 / 目录未共享给它:都是「这次比不了」,如实回原因
      sendJson(res, 400, { error: e instanceof Error ? e.message : '对比失败' });
    }
    return true;
  }

  // GET /api/folders/compare?folderId=xxx&device=yyy : 双栏对比页的数据源 ——
  // 差异分类之外再带上两侧条目清单(目录结构对齐视图需要看到「两边都一样的那些」)。
  // 与 /api/folders/diff 同源、同样只读。
  if (req.method === 'GET' && req.url && path === '/api/folders/compare' && compareFolder) {
    const url = new URL(req.url, 'http://localhost');
    const folderId = url.searchParams.get('folderId');
    const device = url.searchParams.get('device');
    if (!folderId || !device) {
      sendJson(res, 400, { error: 'folderId and device are required' });
      return true;
    }
    try {
      sendJson(res, 200, await compareFolder(folderId, device));
    } catch (e) {
      // 设备离线 / 对端版本过旧 / 目录未共享给它:都是「这次比不了」,如实回原因
      sendJson(res, 400, { error: e instanceof Error ? e.message : '对比失败' });
    }
    return true;
  }

  // GET /api/folders/file?folderId=xxx&device=yyy&path=zzz : 同一个文件的两侧内容(只读)。
  if (req.method === 'GET' && req.url && path === '/api/folders/file' && readFilePair) {
    const url = new URL(req.url, 'http://localhost');
    const folderId = url.searchParams.get('folderId');
    const device = url.searchParams.get('device');
    const filePath = url.searchParams.get('path');
    if (!folderId || !device || !filePath) {
      sendJson(res, 400, { error: 'folderId, device and path are required' });
      return true;
    }
    try {
      sendJson(res, 200, await readFilePair(folderId, device, filePath));
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : '读取文件失败' });
    }
    return true;
  }

  // POST /api/folders/file/sync : 把一侧文件的内容同步到另一侧(对比页逐块应用/整文件覆盖)。
  // content 省略 = 整文件照抄来源侧;给了则以给定内容为准(逐块应用后的结果)。
  if (req.method === 'POST' && path === '/api/folders/file/sync' && applyFileSync) {
    try {
      const raw = await readBody(req);
      const body = raw === '' ? {} : JSON.parse(raw);
      const folderId = (body as { folderId?: unknown }).folderId;
      const device = (body as { device?: unknown }).device;
      const filePath = (body as { path?: unknown }).path;
      const direction = (body as { direction?: unknown }).direction;
      const content = (body as { content?: unknown }).content;
      if (typeof folderId !== 'string' || folderId === '' ||
          typeof device !== 'string' || device === '' ||
          typeof filePath !== 'string' || filePath === '') {
        sendJson(res, 400, { error: 'folderId, device and path are required' });
        return true;
      }
      if (direction !== 'pull' && direction !== 'push') {
        sendJson(res, 400, { error: "direction must be 'pull' or 'push'" });
        return true;
      }
      await applyFileSync({
        folderId,
        deviceId: device,
        path: filePath,
        direction,
        ...(typeof content === 'string' ? { content } : {}),
      });
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : '同步失败' });
    }
    return true;
  }

  // POST /api/folders/history/clear : 清空某目录的同步记录(不可逆,需前端二次确认)
  if (req.method === 'POST' && path === '/api/folders/history/clear' && clearFolderHistory) {
    try {
      const raw = await readBody(req);
      const body = raw === '' ? {} : JSON.parse(raw);
      const folderId = (body as { folderId?: unknown }).folderId;
      if (typeof folderId !== 'string' || folderId === '') {
        sendJson(res, 400, { error: 'folderId is required' });
        return true;
      }
      clearFolderHistory(folderId);
      sendJson(res, 200, { ok: true });
    } catch {
      sendJson(res, 400, { error: 'invalid json body' });
    }
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
    removeFolder(p, { purgeIndex: url.searchParams.get('purgeIndex') === '1' });
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}
