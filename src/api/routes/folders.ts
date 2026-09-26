import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ControlServerDeps } from '../deps.js';
import type { SyncAction, SyncDirection, SyncHistoryFilter } from '../../history.js';
import { getHistoryMaxEvents } from '../../history.js';
import { pathname, readBody, redirect, sendJson } from '../helpers.js';

/** fallback 版本页的 HTML 转义(与 ui-fallback 的 escapeHtml 同款)。 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 解析历史查询的公共参数(GET /api/folders/history 与 GET /api/history 共用):
 * limit(clamp 到保留上限)、direction、device、action、q。
 * 非法取值返回 { error } 而不是默默忽略 —— 参数打错时静默等于全量,比报错更难查。
 */
function parseHistoryQuery(
  url: URL,
): { error: string } | { limit?: number; filter: SyncHistoryFilter } {
  let limit: number | undefined;
  const rawLimit = url.searchParams.get('limit');
  if (rawLimit !== null && rawLimit !== '') {
    const n = Number(rawLimit);
    if (!Number.isFinite(n) || n < 1) {
      return { error: 'limit must be a positive integer' };
    }
    limit = Math.min(Math.floor(n), getHistoryMaxEvents());
  }
  const directionRaw = url.searchParams.get('direction');
  const actionRaw = url.searchParams.get('action');
  const bad: string[] = [];
  if (directionRaw && directionRaw !== 'local' && directionRaw !== 'remote') bad.push('direction');
  if (actionRaw && !['add', 'update', 'delete', 'conflict'].includes(actionRaw)) bad.push('action');
  if (bad.length > 0) {
    return { error: `invalid ${bad.join(', ')} parameter` };
  }
  return {
    limit,
    filter: {
      direction: (directionRaw || undefined) as SyncDirection | undefined,
      action: (actionRaw || undefined) as SyncAction | undefined,
      deviceId: url.searchParams.get('device') || undefined,
      query: url.searchParams.get('q') || undefined,
    },
  };
}

/** 目录域:目录增删(表单 + JSON API)、设备指派、gitignore 开关、同步记录查询。 */
export async function tryFolderRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ControlServerDeps,
): Promise<boolean> {
  const { addFolder, removeFolder, setFolderDevices, setFolderUseGitignore, setFolderPaused, setFolderSchedule, setFolderGitSync, setFolderConflictPolicy, prioritizeTransfer, getFolderIgnoreInfo, setFolderIgnoreLines, testFolderIgnore, reAdoptFolderIdentity, getFolderHistory, getGlobalHistory, clearFolderHistory, listFolderConflicts, resolveFolderConflict, conflictFilePair, applyConflictMerge, cleanIdenticalConflicts, diffFolder, compareFolder, readFilePair, applyFileSync, listFolderVersions, restoreFolderVersion, deleteFolderVersion } = deps;
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

  // POST /api/folders/pause : 设置某目录是否暂停同步(数据面停摆,控制面照常)
  if (req.method === 'POST' && path === '/api/folders/pause' && setFolderPaused) {
    try {
      const raw = await readBody(req);
      const body = raw === '' ? {} : JSON.parse(raw);
      if (typeof (body as any).folderId !== 'string' || (body as any).folderId === '') {
        sendJson(res, 400, { error: 'folderId is required' });
        return true;
      }
      setFolderPaused((body as any).folderId, (body as any).paused === true);
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : 'invalid json body' });
    }
    return true;
  }

  // POST /api/folders/schedule { folderId, schedule } : 设置某目录的同步时段。
  // schedule 形如 HH:MM-HH:MM(支持跨午夜);空串 = 清除(全天同步);非法格式 400。
  if (req.method === 'POST' && path === '/api/folders/schedule' && setFolderSchedule) {
    try {
      const raw = await readBody(req);
      const body = raw === '' ? {} : JSON.parse(raw);
      const folderId = (body as { folderId?: unknown }).folderId;
      const schedule = (body as { schedule?: unknown }).schedule;
      if (typeof folderId !== 'string' || folderId === '') {
        sendJson(res, 400, { error: 'folderId is required' });
        return true;
      }
      if (typeof schedule !== 'string') {
        sendJson(res, 400, { error: 'schedule must be a string (HH:MM-HH:MM, or empty to clear)' });
        return true;
      }
      setFolderSchedule(folderId, schedule);
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : '设置同步时段失败' });
    }
    return true;
  }

  // POST /api/folders/git-sync { folderId, mode } : 设置某目录的 git 提交同步模式。
  // mode 取 off / send / receive / full;非法值 400。
  if (req.method === 'POST' && path === '/api/folders/git-sync' && setFolderGitSync) {
    try {
      const raw = await readBody(req);
      const body = raw === '' ? {} : JSON.parse(raw);
      const folderId = (body as { folderId?: unknown }).folderId;
      const mode = (body as { mode?: unknown }).mode;
      if (typeof folderId !== 'string' || folderId === '') {
        sendJson(res, 400, { error: 'folderId is required' });
        return true;
      }
      if (mode !== 'off' && mode !== 'send' && mode !== 'receive' && mode !== 'full') {
        sendJson(res, 400, { error: 'mode must be one of: off, send, receive, full' });
        return true;
      }
      setFolderGitSync(folderId, mode);
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : '设置 git 同步模式失败' });
    }
    return true;
  }

  // POST /api/folders/conflict-policy { folderId, policy } : 设置某目录的冲突自动处理策略。
  // policy 取 keep-both / newest-wins / local-wins;非法值 400。
  if (req.method === 'POST' && path === '/api/folders/conflict-policy' && setFolderConflictPolicy) {
    try {
      const raw = await readBody(req);
      const body = raw === '' ? {} : JSON.parse(raw);
      const folderId = (body as { folderId?: unknown }).folderId;
      const policy = (body as { policy?: unknown }).policy;
      if (typeof folderId !== 'string' || folderId === '') {
        sendJson(res, 400, { error: 'folderId is required' });
        return true;
      }
      if (policy !== 'keep-both' && policy !== 'newest-wins' && policy !== 'local-wins') {
        sendJson(res, 400, { error: 'policy must be one of: keep-both, newest-wins, local-wins' });
        return true;
      }
      setFolderConflictPolicy(folderId, policy);
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : '设置冲突策略失败' });
    }
    return true;
  }

  // POST /api/folders/prioritize { folderId, path } : 「优先同步」某个在传文件。
  // 幂等:该文件此刻没在收就是空操作;在收则让对端发送队列把它的块插到最前。
  if (req.method === 'POST' && path === '/api/folders/prioritize' && prioritizeTransfer) {
    try {
      const raw = await readBody(req);
      const body = raw === '' ? {} : JSON.parse(raw);
      const folderId = (body as { folderId?: unknown }).folderId;
      const p = (body as { path?: unknown }).path;
      if (typeof folderId !== 'string' || folderId === '') {
        sendJson(res, 400, { error: 'folderId is required' });
        return true;
      }
      if (typeof p !== 'string' || p === '') {
        sendJson(res, 400, { error: 'path is required' });
        return true;
      }
      prioritizeTransfer(folderId, p);
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : '优先同步请求失败' });
    }
    return true;
  }

  // GET /api/folders/ignore?folderId=xxx : 忽略规则编辑器数据(.syncxignore 原始行 +
  // 内置默认行 + useGitignore)。规则本体在磁盘上,这里只读不回写配置。
  if (req.method === 'GET' && req.url && path === '/api/folders/ignore' && getFolderIgnoreInfo) {
    const url = new URL(req.url, 'http://localhost');
    const folderId = url.searchParams.get('folderId');
    if (!folderId) {
      sendJson(res, 400, { error: 'folderId is required' });
      return true;
    }
    try {
      sendJson(res, 200, getFolderIgnoreInfo(folderId));
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : '读取忽略规则失败' });
    }
    return true;
  }

  // POST /api/folders/ignore { folderId, lines } : 保存 .syncxignore 并立即生效。
  if (req.method === 'POST' && path === '/api/folders/ignore' && setFolderIgnoreLines) {
    try {
      const raw = await readBody(req);
      const body = raw === '' ? {} : JSON.parse(raw);
      const folderId = (body as { folderId?: unknown }).folderId;
      const lines = (body as { lines?: unknown }).lines;
      if (typeof folderId !== 'string' || folderId === '') {
        sendJson(res, 400, { error: 'folderId is required' });
        return true;
      }
      if (!Array.isArray(lines) || lines.some((l) => typeof l !== 'string')) {
        sendJson(res, 400, { error: 'lines must be an array of strings' });
        return true;
      }
      setFolderIgnoreLines(folderId, lines as string[]);
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : '保存忽略规则失败' });
    }
    return true;
  }

  // POST /api/folders/ignore/test { folderId, path, lines? } : 实时测试器。
  // 带 lines(编辑器草稿)时预测「按这份规则保存后」的结果,不带则按磁盘现状。
  if (req.method === 'POST' && path === '/api/folders/ignore/test' && testFolderIgnore) {
    try {
      const raw = await readBody(req);
      const body = raw === '' ? {} : JSON.parse(raw);
      const folderId = (body as { folderId?: unknown }).folderId;
      const p = (body as { path?: unknown }).path;
      const lines = (body as { lines?: unknown }).lines;
      if (typeof folderId !== 'string' || folderId === '') {
        sendJson(res, 400, { error: 'folderId is required' });
        return true;
      }
      if (typeof p !== 'string' || p === '') {
        sendJson(res, 400, { error: 'path is required' });
        return true;
      }
      if (lines !== undefined && (!Array.isArray(lines) || lines.some((l) => typeof l !== 'string'))) {
        sendJson(res, 400, { error: 'lines must be an array of strings' });
        return true;
      }
      sendJson(res, 200, testFolderIgnore(folderId, p, lines as string[] | undefined));
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : '忽略规则测试失败' });
    }
    return true;
  }

  // POST /api/folders/re-adopt-identity { folderId } : 「目录不可信」时重新采集身份指纹。
  // 仅更新 folderIdentity(索引/实例不动);目录不可读时后端拒绝(400 + 原因)。
  if (req.method === 'POST' && path === '/api/folders/re-adopt-identity' && reAdoptFolderIdentity) {
    try {
      const raw = await readBody(req);
      const body = raw === '' ? {} : JSON.parse(raw);
      const folderId = (body as { folderId?: unknown }).folderId;
      if (typeof folderId !== 'string' || folderId === '') {
        sendJson(res, 400, { error: 'folderId is required' });
        return true;
      }
      reAdoptFolderIdentity(folderId);
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : '采集身份失败' });
    }
    return true;
  }

  // GET /api/folders/history?folderId=xxx[&limit=N][&direction=local|remote][&device=ID]
  //     [&action=add|update|delete|conflict][&q=关键词]
  // : 读取某目录的同步记录(服务端筛选,倒序)。响应除事件外还带 total/matched/oldestTs/
  // maxRetention,前端「共 N 条 / 最早记录 / 加载更多」全靠这几个口径,不再靠猜加载长度。
  if (req.method === 'GET' && req.url && path === '/api/folders/history' && getFolderHistory) {
    const url = new URL(req.url, 'http://localhost');
    const folderId = url.searchParams.get('folderId');
    if (!folderId) {
      sendJson(res, 400, { error: 'folderId is required' });
      return true;
    }
    const parsed = parseHistoryQuery(url);
    if ('error' in parsed) {
      sendJson(res, 400, { error: parsed.error });
      return true;
    }
    sendJson(res, 200, getFolderHistory(folderId, parsed.limit, parsed.filter));
    return true;
  }

  // GET /api/history[&limit=..&direction=..&device=..&action=..&q=..]
  // : 全局时间线 —— 汇总各目录记录按时间归并(条目带 folderPath)。参数与单目录查询同义。
  if (req.method === 'GET' && req.url && path === '/api/history' && getGlobalHistory) {
    const url = new URL(req.url, 'http://localhost');
    const parsed = parseHistoryQuery(url);
    if ('error' in parsed) {
      sendJson(res, 400, { error: parsed.error });
      return true;
    }
    sendJson(res, 200, getGlobalHistory(parsed.limit, parsed.filter));
    return true;
  }

  // GET /history : 全局时间线页(fallback UI,服务端渲染、无 JS;只读,无表单动作)。
  if (req.method === 'GET' && req.url && path === '/history' && getGlobalHistory) {
    interface HistoryRow {
      ts: number;
      folderPath?: string;
      path: string;
      action: string;
      direction: string;
      deviceId?: string;
    }
    let events: HistoryRow[] = [];
    let errorText = '';
    try {
      const result = getGlobalHistory(200, {}) as { events?: HistoryRow[] };
      events = result.events ?? [];
    } catch (e) {
      errorText = e instanceof Error ? e.message : '读取同步记录失败';
    }
    const actionZh: Record<string, string> = { add: '新增', update: '修改', delete: '删除', conflict: '冲突' };
    const rows = events
      .map((ev) => {
        const dir = ev.direction === 'local' ? '本地' : `对端${ev.deviceId ? `:${escapeHtml(ev.deviceId)}` : ''}`;
        const conflict = ev.action === 'conflict' ? ' class="conflict"' : '';
        return (
          `<tr${conflict}><td>${escapeHtml(new Date(ev.ts).toLocaleString())}</td>` +
          `<td>${escapeHtml(ev.folderPath ?? '')}</td>` +
          `<td>${escapeHtml(actionZh[ev.action] ?? ev.action)}</td>` +
          `<td>${dir}</td>` +
          `<td>${escapeHtml(ev.path)}</td></tr>`
        );
      })
      .join('');
    const body = errorText
      ? `<p class="error">${escapeHtml(errorText)}</p>`
      : events.length === 0
        ? '<p class="muted">还没有同步记录</p>'
        : `<p class="muted">仅展示最近 200 条 · 各目录分别保留最近 2000 条</p>` +
          `<table><tr><th>时间</th><th>目录</th><th>动作</th><th>方向</th><th>路径</th></tr>${rows}</table>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<h1>同步记录 · 全部目录</h1>${body}<p><a href="/">← 返回</a></p>`);
    return true;
  }

  // GET /versions?folder=xxx : 某目录的文件版本页(fallback UI,服务端渲染)。
  // 恢复/删除经由 /actions 的表单提交(devices.ts),保持 fallback 全程无 JS。
  if (req.method === 'GET' && req.url && path === '/versions' && listFolderVersions) {
    const url = new URL(req.url, 'http://localhost');
    const folderId = url.searchParams.get('folder');
    if (!folderId) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<p>missing folder parameter</p><a href="/">返回</a>');
      return true;
    }
    let versions: Array<{ file: string; path: string; size: number; mtime: number }> = [];
    let errorText = '';
    try {
      const list = listFolderVersions(folderId) as { versions?: typeof versions };
      versions = list.versions ?? [];
    } catch (e) {
      errorText = e instanceof Error ? e.message : '读取版本失败';
    }
    const fmtSize = (n: number): string =>
      n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB`
      : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB`
      : n >= 1024 ? `${(n / 1024).toFixed(1)} KB`
      : `${n} B`;
    const rows = versions
      .map((v) => {
        const back = encodeURIComponent(`/versions?folder=${folderId}`);
        const restore =
          `<form method="post" action="/actions" style="display:inline">` +
          `<input type="hidden" name="action" value="restore-version">` +
          `<input type="hidden" name="folderId" value="${escapeHtml(folderId)}">` +
          `<input type="hidden" name="file" value="${escapeHtml(v.file)}">` +
          `<input type="hidden" name="back" value="${back}">` +
          `<button type="submit" class="btn-sm">恢复</button></form>`;
        const del =
          `<form method="post" action="/actions" style="display:inline">` +
          `<input type="hidden" name="action" value="delete-version">` +
          `<input type="hidden" name="folderId" value="${escapeHtml(folderId)}">` +
          `<input type="hidden" name="file" value="${escapeHtml(v.file)}">` +
          `<input type="hidden" name="back" value="${back}">` +
          `<button type="submit" class="btn-sm">删除</button></form>`;
        const time = new Date(v.mtime).toLocaleString();
        return `<tr><td>${escapeHtml(v.path)}</td><td>${fmtSize(v.size)}</td><td>${escapeHtml(time)}</td><td>${restore} ${del}</td></tr>`;
      })
      .join('');
    const body = errorText
      ? `<p class="error">${escapeHtml(errorText)}</p>`
      : versions.length === 0
        ? '<p class="muted">暂无版本留档(文件被对端覆盖修改时会自动留档旧内容)</p>'
        : `<table><tr><th>原始路径</th><th>大小</th><th>留档时间</th><th>操作</th></tr>${rows}</table>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      `<h1>文件版本 · ${escapeHtml(folderId)}</h1>${body}<p><a href="/">← 返回</a></p>`,
    );
    return true;
  }

  // GET /api/folders/versions?folderId=xxx : 某目录的文件版本列表
  // (对端覆盖修改前自动留档,见 executor 的 snapshotVersion)。
  if (req.method === 'GET' && req.url && path === '/api/folders/versions' && listFolderVersions) {
    const url = new URL(req.url, 'http://localhost');
    const folderId = url.searchParams.get('folderId');
    if (!folderId) {
      sendJson(res, 400, { error: 'folderId is required' });
      return true;
    }
    try {
      sendJson(res, 200, listFolderVersions(folderId));
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : '读取版本失败' });
    }
    return true;
  }

  // POST /api/folders/versions/restore : 把某个版本恢复回共享目录原路径
  // (当前内容会先留档一份,恢复动作可逆)。
  if (req.method === 'POST' && path === '/api/folders/versions/restore' && restoreFolderVersion) {
    try {
      const raw = await readBody(req);
      const body = raw === '' ? {} : JSON.parse(raw);
      const folderId = (body as { folderId?: unknown }).folderId;
      const file = (body as { file?: unknown }).file;
      if (typeof folderId !== 'string' || folderId === '' || typeof file !== 'string' || file === '') {
        sendJson(res, 400, { error: 'folderId and file are required' });
        return true;
      }
      restoreFolderVersion(folderId, file);
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : '恢复失败' });
    }
    return true;
  }

  // POST /api/folders/versions/delete : 删除单个版本文件(不可逆,需前端二次确认)。
  if (req.method === 'POST' && path === '/api/folders/versions/delete' && deleteFolderVersion) {
    try {
      const raw = await readBody(req);
      const body = raw === '' ? {} : JSON.parse(raw);
      const folderId = (body as { folderId?: unknown }).folderId;
      const file = (body as { file?: unknown }).file;
      if (typeof folderId !== 'string' || folderId === '' || typeof file !== 'string' || file === '') {
        sendJson(res, 400, { error: 'folderId and file are required' });
        return true;
      }
      deleteFolderVersion(folderId, file);
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : '删除失败' });
    }
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

  // GET /api/folders/conflicts?folderId=xxx : 冲突收件箱 —— 实时扫描目录内残留的
  // .sync-conflict-* 副本,返回 { conflicts: [...], truncated }。
  if (req.method === 'GET' && req.url && path === '/api/folders/conflicts' && listFolderConflicts) {
    const url = new URL(req.url, 'http://localhost');
    const folderId = url.searchParams.get('folderId');
    if (!folderId) {
      sendJson(res, 400, { error: 'folderId is required' });
      return true;
    }
    try {
      sendJson(res, 200, listFolderConflicts(folderId));
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : '读取冲突列表失败' });
    }
    return true;
  }

  // POST /api/folders/conflicts/resolve { folderId, copyPath, choice }
  // : 处理一条冲突副本。choice=keep-local(副本覆盖回原路径,当前内容先留档)/ discard(副本进回收站)。
  if (req.method === 'POST' && path === '/api/folders/conflicts/resolve' && resolveFolderConflict) {
    try {
      const raw = await readBody(req);
      const body = raw === '' ? {} : JSON.parse(raw);
      const { folderId, copyPath, choice } = body as { folderId?: unknown; copyPath?: unknown; choice?: unknown };
      if (typeof folderId !== 'string' || folderId === '') {
        sendJson(res, 400, { error: 'folderId is required' });
        return true;
      }
      if (typeof copyPath !== 'string' || copyPath === '') {
        sendJson(res, 400, { error: 'copyPath is required' });
        return true;
      }
      if (choice !== 'keep-local' && choice !== 'discard') {
        sendJson(res, 400, { error: 'choice must be keep-local or discard' });
        return true;
      }
      resolveFolderConflict(folderId, copyPath, choice);
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : '处理冲突失败' });
    }
    return true;
  }

  // GET /api/folders/conflicts/diff?folderId=xxx&copyPath=yyy : 冲突「查看对比」数据。
  // 返回与 /api/folders/file 同形状:{ path(原文件), local(原文件当前=对端版), remote(副本=本机旧版), deviceId }。
  if (req.method === 'GET' && req.url && path === '/api/folders/conflicts/diff' && conflictFilePair) {
    const url = new URL(req.url, 'http://localhost');
    const folderId = url.searchParams.get('folderId');
    const copyPath = url.searchParams.get('copyPath');
    if (!folderId || !copyPath) {
      sendJson(res, 400, { error: 'folderId and copyPath are required' });
      return true;
    }
    try {
      sendJson(res, 200, conflictFilePair(folderId, copyPath));
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : '读取对比失败' });
    }
    return true;
  }

  // POST /api/folders/conflicts/merge { folderId, copyPath, content }
  // : 把逐块合并后的完整内容写回原文件(当前内容先留档,副本不动),随后触发扫描广播。
  if (req.method === 'POST' && path === '/api/folders/conflicts/merge' && applyConflictMerge) {
    try {
      const raw = await readBody(req);
      const body = raw === '' ? {} : JSON.parse(raw);
      const { folderId, copyPath, content } = body as { folderId?: unknown; copyPath?: unknown; content?: unknown };
      if (typeof folderId !== 'string' || folderId === '') {
        sendJson(res, 400, { error: 'folderId is required' });
        return true;
      }
      if (typeof copyPath !== 'string' || copyPath === '') {
        sendJson(res, 400, { error: 'copyPath is required' });
        return true;
      }
      if (typeof content !== 'string') {
        sendJson(res, 400, { error: 'content is required' });
        return true;
      }
      applyConflictMerge(folderId, copyPath, content);
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : '合并写回失败' });
    }
    return true;
  }

  // POST /api/folders/conflicts/clean-identical { folderId } : 一键清理逐字节无差异的副本。
  if (req.method === 'POST' && path === '/api/folders/conflicts/clean-identical' && cleanIdenticalConflicts) {
    try {
      const raw = await readBody(req);
      const body = raw === '' ? {} : JSON.parse(raw);
      const folderId = (body as { folderId?: unknown }).folderId;
      if (typeof folderId !== 'string' || folderId === '') {
        sendJson(res, 400, { error: 'folderId is required' });
        return true;
      }
      sendJson(res, 200, cleanIdenticalConflicts(folderId));
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : '清理失败' });
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
