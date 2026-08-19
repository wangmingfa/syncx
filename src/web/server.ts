const CSS = `
  :root {
    --bg: #0f1117;
    --card: #1a1d27;
    --text: #e6e8ee;
    --muted: #8b90a0;
    --accent: #4f8cff;
    --border: #2a2e3b;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    padding: 24px;
    line-height: 1.5;
  }
  .container { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 22px; margin-bottom: 16px; }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 18px;
    margin-bottom: 16px;
  }
  .muted { color: var(--muted); font-size: 13px; }
  .message { color: #7ee787; margin-bottom: 12px; font-size: 14px; }
  .error { color: #ff6b6b; margin-bottom: 12px; font-size: 14px; }
  .deviceId { font-size: 18px; font-weight: 600; margin: 4px 0 8px; }
  .stat-row { display: flex; gap: 24px; margin-top: 8px; }
  .stat b { display: block; font-size: 22px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 500; }
  input {
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px 10px;
    width: 100%;
    margin-top: 8px;
  }
  button {
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: 6px;
    padding: 6px 12px;
    cursor: pointer;
    margin-top: 10px;
  }
  button:hover { opacity: 0.9; }
  .actions button { margin-top: 0; margin-left: 4px; }
  .actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
  .online { color: #7ee787; }
  .offline { color: #ff6b6b; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
  .dot-online { background: #7ee787; }
  .dot-offline { background: #ff6b6b; }
  .btn-sm { padding: 4px 8px; font-size: 12px; margin-top: 0; }
  .progress-bar { background: var(--bg); border-radius: 4px; height: 6px; margin-top: 4px; overflow: hidden; }
  .progress-fill { background: var(--accent); height: 100%; border-radius: 4px; }
`;

const SHELL = (content: string): string =>
  `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width"><title>syncx</title><style>${CSS}</style></head><body><div id="app">${content}</div></body></html>`;

import { createSSRApp } from 'vue';
import App from './App.vue';

export async function render(page: string, data: unknown): Promise<string> {
  const app = createSSRApp(App, { page, data });
  const { renderToString } = await import('@vue/server-renderer');
  return SHELL(await renderToString(app));
}
