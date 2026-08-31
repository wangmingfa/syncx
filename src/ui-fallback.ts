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

const STYLE = `
  :root { --bg:#0c0e14; --bg-deep:#080a0f; --card:#151823; --card-hi:#1c2030; --text:#eef1f7; --muted:#9aa1b4; --accent:#4f8cff; --accent-2:#22d3ee; --accent-3:#5ee0a8; --flow:linear-gradient(90deg,var(--accent),var(--accent-2)); --border:#262b3a; --online:#5ee08a; --offline:#ff6b6b; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: system-ui, sans-serif; padding: 24px; line-height: 1.5; }
  .container { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 22px; margin-bottom: 16px; }
  h2 { font-size: 16px; margin-bottom: 10px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 18px; margin-bottom: 16px; }
  .muted { color: var(--muted); font-size: 13px; }
  .message { color: #7ee787; margin-bottom: 12px; font-size: 14px; }
  .error { color: #ff6b6b; margin-bottom: 12px; font-size: 14px; }
  .deviceId { font-size: 18px; font-weight: 600; margin: 4px 0 8px; }
  .stat-row { display: flex; gap: 24px; margin-top: 8px; }
  .stat b { display: block; font-size: 22px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 500; }
  input { background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; width: 100%; margin-top: 8px; }
  button { background: var(--accent); color: #fff; border: none; border-radius: 6px; padding: 6px 12px; cursor: pointer; margin-top: 10px; font-size: 13px; }
  button:hover { opacity: 0.85; }
  .btn-sm { padding: 4px 8px; font-size: 12px; margin-top: 0; }
  .online { color: var(--online); }
  .offline { color: var(--offline); }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
  .dot-online { background: var(--online); }
  .dot-offline { background: var(--offline); }
  .actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
  .progress-bar { background: var(--bg-deep); border-radius: 999px; height: 6px; margin-top: 4px; overflow: hidden; }
  .progress-fill { background: var(--accent); height: 100%; border-radius: 4px; }
`;

function shell(content: string): string {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width"><title>syncx</title><style>${STYLE}</style></head><body><div id="app" class="container">${content}</div></body></html>`;
}

interface FallbackStatus {
  deviceId?: string;
  folders?: Array<{ path: string; devices?: string[]; id?: string }>;
  entries?: number;
  tombstones?: number;
  peers?: Array<{ deviceId: string; online: boolean; url?: string }>;
  syncProgress?: Array<{ folder: string; pending: number; sending: number; receiving: number }>;
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
    .map(
      (f) =>
        `<tr><td>${escapeHtml(f.path)}</td><td>${escapeHtml((f.devices ?? []).join(', '))}</td></tr>`,
    )
    .join('');
  const message = data.message ? `<p class="message">${escapeHtml(data.message)}</p>` : '';
  const error = data.error ? `<p class="error">${escapeHtml(data.error)}</p>` : '';

  // 对端连接状态列表
  const peers = (status.peers ?? []);
  const peerRows = peers.length > 0
    ? peers.map((p) => {
        const onlineClass = p.online ? 'dot-online' : 'dot-offline';
        const statusText = p.online ? '在线' : '离线';
        const statusClass = p.online ? 'online' : 'offline';
        const reconnectBtn = p.online
          ? ''
          : `<form method="post" action="/actions" style="display:inline"><input type="hidden" name="action" value="reconnect"><input type="hidden" name="deviceId" value="${escapeHtml(p.deviceId)}"><button type="submit" class="btn-sm">重连</button></form>`;
        return `<tr><td><span class="dot ${onlineClass}"></span>${escapeHtml(p.deviceId)}</td><td class="${statusClass}">${statusText}</td><td>${reconnectBtn}</td></tr>`;
      }).join('')
    : '<tr><td colspan="3" class="muted">暂无对端</td></tr>';

  // 同步进度列表
  const syncProgress = (status.syncProgress ?? []);
  const progressRows = syncProgress.length > 0
    ? syncProgress.map((p) => {
        const total = p.pending + p.sending + p.receiving;
        const pct = total > 0 ? Math.round((p.receiving / total) * 100) : 0;
        return `<tr><td>${escapeHtml(p.folder)}</td><td>${p.pending}</td><td>${p.sending}</td><td>${p.receiving}</td><td><div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div></td></tr>`;
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
      <h2>共享目录</h2>
      <table><thead><tr><th>路径</th><th>设备</th></tr></thead>
      <tbody>${folders || '<tr><td colspan="2" class="muted">暂无共享目录</td></tr>'}</tbody></table>
      <form method="post" action="/folders">
        <input name="path" placeholder="目录路径" />
        <input name="devices" placeholder="设备 ID(逗号分隔,可选)" />
        <button type="submit">添加目录</button>
      </form>
    </div>
  `);
}