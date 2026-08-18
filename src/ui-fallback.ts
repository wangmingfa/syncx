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
  :root { --bg:#0f1117; --card:#1a1d27; --text:#e6e8ee; --muted:#8b90a0; --accent:#4f8cff; --border:#2a2e3b; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: system-ui, sans-serif; padding: 24px; line-height: 1.5; }
  .container { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 22px; margin-bottom: 16px; }
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
  button { background: var(--accent); color: #fff; border: none; border-radius: 6px; padding: 6px 12px; cursor: pointer; margin-top: 10px; }
`;

function shell(content: string): string {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width"><title>syncx</title><style>${STYLE}</style></head><body><div id="app" class="container">${content}</div></body></html>`;
}

interface FallbackStatus {
  deviceId?: string;
  folders?: Array<{ path: string; devices?: string[]; id?: string }>;
  entries?: number;
  tombstones?: number;
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
    </div>
    ${message}${error}
    <div class="card">
      <h1>共享目录</h1>
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
