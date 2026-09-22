/**
 * 内置回退渲染器:当 Vite 构建的 SSR 包(dist/ui/server.js)缺失时,
 * 仍能渲染可用的登录页与状态页,避免 "请先 npm run build" 的空壳页面。
 * 纯字符串模板,不依赖 Vue,可被 tsx 直接加载(无需构建步骤)。
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 速率的人类可读形式(B/s 自适应到 GB/s);无速率(0/undefined)返回空串。 */
function fmtRate(bps?: number): string {
  if (!bps || bps <= 0) return '';
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let v = bps;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${v >= 10 || u === 0 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

const STYLE = `
  :root { --bg:#f4f6f9; --bg-soft:#eaeef3; --card:#ffffff; --card-hi:#ffffff; --text:#1e2630; --muted:#7e8aa0; --muted-strong:#55606f; --accent:#4a7fc0; --accent-2:#2bb6ac; --accent-3:#2fa56f; --flow:linear-gradient(90deg,var(--accent),var(--accent-2)); --border:#e5e9f0; --border-strong:#d4dae4; --online:#2fa56f; --offline:#d96b6b; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: system-ui, sans-serif; padding: 24px; line-height: 1.5; }
  .container { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 22px; margin-bottom: 16px; }
  h2 { font-size: 16px; margin-bottom: 10px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 18px; margin-bottom: 16px; box-shadow: 0 1px 2px rgba(22,32,52,.04), 0 12px 30px -20px rgba(22,32,52,.28); }
  .muted { color: var(--muted); font-size: 13px; }
  .message { color: var(--online); margin-bottom: 12px; font-size: 14px; }
  .error { color: var(--offline); margin-bottom: 12px; font-size: 14px; }
  .deviceId { font-size: 18px; font-weight: 600; margin: 4px 0 8px; }
  .stat-row { display: flex; gap: 24px; margin-top: 8px; }
  .stat b { display: block; font-size: 22px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 500; }
  input { background: var(--bg-soft); color: var(--text); border: 1px solid var(--border); border-radius: 9px; padding: 8px 10px; width: 100%; margin-top: 8px; }
  button { background: var(--accent); color: #fff; border: none; border-radius: 9px; padding: 6px 12px; cursor: pointer; margin-top: 10px; font-size: 13px; }
  button:hover { opacity: 0.9; }
  .btn-sm { padding: 4px 8px; font-size: 12px; margin-top: 0; }
  .online { color: var(--online); }
  .offline { color: var(--offline); }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
  .dot-online { background: var(--online); box-shadow: 0 0 0 3px rgb(47,165,111,.16); }
  .dot-offline { background: var(--offline); box-shadow: 0 0 0 3px rgb(217,107,107,.16); }
  .actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
  .progress-bar { background: var(--bg-soft); border-radius: 999px; height: 6px; margin-top: 4px; overflow: hidden; }
  .progress-fill { background: var(--accent-3); height: 100%; border-radius: 4px; }
`;

function shell(content: string): string {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width"><title>syncx</title><style>${STYLE}</style></head><body><div id="app" class="container">${content}</div></body></html>`;
}

interface FallbackStatus {
  deviceId?: string;
  paused?: boolean;
  folders?: Array<{ path: string; devices?: string[]; id?: string; paused?: boolean }>;
  entries?: number;
  tombstones?: number;
  devices?: Array<{ deviceId: string; online: boolean; url?: string; folders?: string[] }>;
  syncProgress?: Array<{ folder: string; pending: number; sending: number; receiving: number; sendRate?: number; receiveRate?: number }>;
}

export function renderControlFallback(data: {
  status?: unknown;
  error?: string;
  message?: string;
}): string {
  const status = data.status as FallbackStatus | undefined;

  if (!status) {
    const error = data.error ? `<p class="error">${escapeHtml(data.error)}</p>` : '';
    return shell(`
      <h1>syncx</h1>
      <p class="muted">输入控制令牌以登录</p>
      ${error}
      <form method="post" action="/login">
        <input name="token" type="password" placeholder="control token" autocomplete="off" />
        <button type="submit">登录</button>
      </form>
    `);
  }

  const folders = (status.folders ?? [])
    .map((f) => {
      const folderId = f.id ?? f.path;
      // 操作列:暂停/恢复开关(paused 取反提交)。路径回退形态的 folderId 含特殊字符
      // 也没关系:hidden input 走表单编码,不经过 URL。
      const pauseBtn =
        `<form method="post" action="/actions" style="display:inline">` +
        `<input type="hidden" name="action" value="pause-folder">` +
        `<input type="hidden" name="folderId" value="${escapeHtml(folderId)}">` +
        `<input type="hidden" name="paused" value="${f.paused ? '0' : '1'}">` +
        `<button type="submit" class="btn-sm">${f.paused ? '恢复' : '暂停'}</button></form>`;
      // 版本入口:被对端覆盖修改前的旧内容自动留档,可在此查看/恢复/删除
      const versionsLink = `<a class="btn-sm" href="/versions?folder=${encodeURIComponent(folderId)}">版本</a>`;
      const state = f.paused ? ' <span class="offline">已暂停</span>' : '';
      return `<tr><td>${escapeHtml(f.path)}${state}</td><td>${escapeHtml((f.devices ?? []).join(', '))}</td><td>${pauseBtn} ${versionsLink}</td></tr>`;
    })
    .join('');
  const message = data.message ? `<p class="message">${escapeHtml(data.message)}</p>` : '';
  const error = data.error ? `<p class="error">${escapeHtml(data.error)}</p>` : '';

  // 设备连接状态列表
  const devices = (status.devices ?? []);
  const peerRows = devices.length > 0
    ? devices.map((p) => {
        const onlineClass = p.online ? 'dot-online' : 'dot-offline';
        const statusText = p.online ? '在线' : '离线';
        const statusClass = p.online ? 'online' : 'offline';
        const reconnectBtn = p.online
          ? ''
          : `<form method="post" action="/actions" style="display:inline"><input type="hidden" name="action" value="reconnect"><input type="hidden" name="deviceId" value="${escapeHtml(p.deviceId)}"><button type="submit" class="btn-sm">重连</button></form>`;
        return `<tr><td><span class="dot ${onlineClass}"></span>${escapeHtml(p.deviceId)}</td><td class="${statusClass}">${statusText}</td><td>${reconnectBtn}</td></tr>`;
      }).join('')
    : '<tr><td colspan="3" class="muted">暂无对端</td></tr>';

  // 同步进度列表(速率有值才显示,空闲时不占列宽)
  const syncProgress = (status.syncProgress ?? []);
  const progressRows = syncProgress.length > 0
    ? syncProgress.map((p) => {
        const total = p.pending + p.sending + p.receiving;
        const pct = total > 0 ? Math.round((p.receiving / total) * 100) : 0;
        const sendRate = fmtRate(p.sendRate);
        const recvRate = fmtRate(p.receiveRate);
        return `<tr><td>${escapeHtml(p.folder)}</td><td>${p.pending}</td><td>${p.sending}${sendRate ? `<span class="muted"> · ${sendRate}</span>` : ''}</td><td>${p.receiving}${recvRate ? `<span class="muted"> · ${recvRate}</span>` : ''}</td><td><div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div></td></tr>`;
      }).join('')
    : '<tr><td colspan="5" class="muted">同步中无待处理任务</td></tr>';

  return shell(`
    <h1>syncx</h1>
    <div class="card">
      <div class="muted">设备 ID</div>
      <div class="deviceId">${escapeHtml(status.deviceId ?? '')}</div>
      <div class="stat-row">
        <div class="stat"><b>${status.entries ?? 0}</b><span class="muted">文件</span></div>
        <div class="stat"><b>${status.tombstones ?? 0}</b><span class="muted">墓碑</span></div>
        <div class="stat"><b>${(status.folders ?? []).length}</b><span class="muted">目录</span></div>
      </div>
      <div class="actions">
        <form method="post" action="/actions" style="display:inline">
          <input type="hidden" name="action" value="rescan">
          <button type="submit">手动扫描</button>
        </form>
        <form method="post" action="/actions" style="display:inline">
          <input type="hidden" name="action" value="pause-global">
          <input type="hidden" name="paused" value="${status.paused ? '0' : '1'}">
          <button type="submit">${status.paused ? '恢复全部同步' : '暂停全部同步'}</button>
        </form>
        ${status.paused ? '<span class="offline">已全局暂停同步</span>' : ''}
      </div>
    </div>
    ${message}${error}
    <div class="card">
      <h2>对端连接</h2>
      <table><thead><tr><th>设备</th><th>状态</th><th>操作</th></tr></thead>
      <tbody>${peerRows}</tbody></table>
    </div>
    <div class="card">
      <h2>同步进度</h2>
      <table><thead><tr><th>目录</th><th>待处理</th><th>发送中</th><th>接收中</th><th>进度</th></tr></thead>
      <tbody>${progressRows}</tbody></table>
    </div>
    <div class="card">
      <h2>共享目录 <a class="btn-sm" href="/history">全局同步记录</a></h2>
      <table><thead><tr><th>路径</th><th>设备</th><th>操作</th></tr></thead>
      <tbody>${folders || '<tr><td colspan="3" class="muted">暂无共享目录</td></tr>'}</tbody></table>
      <form method="post" action="/folders">
        <input name="path" placeholder="目录路径" />
        <input name="devices" placeholder="设备 ID(逗号分隔,可选)" />
        <button type="submit">添加目录</button>
      </form>
    </div>
  `);
}