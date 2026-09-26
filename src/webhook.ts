import { createHmac } from 'node:crypto';
import { loadConfig } from './config.js';

/**
 * 同步事件 Webhook(无人值守 NAS 的通知闭环):
 * 同步完成 / 冲突 / 目录错误三类事件 POST 到用户配置的 URL。
 * 地址填飞书群机器人 webhook(open.feishu.cn / larksuite 域或 /bot/v2/hook/ 路径)
 * 时自动切换为飞书文本消息格式并按飞书算法加签;其余地址走通用 JSON 载荷,
 * 配了密钥就带 HMAC 签名头供接收方校验。
 */

export type WebhookKind = 'completed' | 'conflict' | 'error' | 'test';

export interface WebhookEvent {
  kind: WebhookKind;
  ts: number;
  folderId?: string;
  /** 目录在本机的绝对路径(信息性字段,接收方展示用)。 */
  folder?: string;
  path?: string;
  deviceId?: string;
  message?: string;
}

export interface WebhookNotifier {
  /** 发送一个事件(火后忘:内部串行队列 + 超时,任何失败只落 warn 日志)。 */
  notify(ev: WebhookEvent): void;
  /** 测试发送:等真实响应,把成/败回给调用方(设置弹窗「测试」按钮)。 */
  test(): Promise<{ ok: boolean; error?: string }>;
}

export interface WebhookNotifierOptions {
  configPath: string;
  /** 注入点:测试可换掉真 fetch。缺省用全局 fetch。 */
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  logger?: { info(msg: string): void; warn(msg: string): void };
}

const REQUEST_TIMEOUT_MS = 5_000;

/** 飞书/Lark 群机器人 webhook 的识别:官方域或机器人钩子路径(自建网关代理也能命中)。 */
export function isFeishuWebhook(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.hostname.endsWith('feishu.cn') ||
      u.hostname.endsWith('larksuite.com') ||
      u.pathname.includes('/bot/v2/hook/')
    );
  } catch {
    return false;
  }
}

/** 事件 → 人类可读的一行摘要(飞书文本消息与日志共用)。 */
export function summarizeEvent(ev: WebhookEvent): string {
  const where = ev.folder ?? ev.folderId ?? '';
  const time = new Date(ev.ts).toLocaleString();
  switch (ev.kind) {
    case 'completed':
      return `[syncx] ${where} 同步完成(传输排空)· ${time}`;
    case 'conflict':
      return `[syncx] ${where} 出现冲突:${ev.path ?? '?'}${ev.deviceId ? `(对端 ${ev.deviceId})` : ''}· ${time}`;
    case 'error':
      return `[syncx] ${where} 同步出错:${ev.message ?? ''} · ${time}`;
    case 'test':
      return `[syncx] Webhook 测试消息 · ${time}`;
  }
}

interface WebhookSettings {
  url?: string;
  secret?: string;
}

export function createWebhookNotifier(opts: WebhookNotifierOptions): WebhookNotifier {
  const doFetch = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const log = opts.logger;

  // 每次事件现读配置:改设置即时生效,不需要重启或重建通知器。
  function settings(): WebhookSettings {
    try {
      const c = loadConfig(opts.configPath);
      return { url: c.webhookUrl, secret: c.webhookSecret };
    } catch {
      return {};
    }
  }

  function buildRequest(s: WebhookSettings, ev: WebhookEvent): { init: RequestInit } | null {
    if (!s.url) return null;
    if (isFeishuWebhook(s.url)) {
      const payload: Record<string, unknown> = {
        msg_type: 'text',
        content: { text: summarizeEvent(ev) },
      };
      if (s.secret) {
        // 飞书加签算法:timestamp 秒级,key = `${timestamp}\n${secret}` 作 HMAC 密钥,
        // 对空消息体签名,base64 输出。
        const timestamp = Math.floor(ev.ts / 1000).toString();
        const sign = createHmac('sha256', `${timestamp}\n${s.secret}`).update('').digest('base64');
        payload.timestamp = timestamp;
        payload.sign = sign;
      }
      return { init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) } };
    }
    // 通用 JSON 载荷:字段直白,接收方(自建网关/n8n/Server酱桥等)自行映射
    const body = JSON.stringify(ev);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (s.secret) {
      // 签名口径:HMAC-SHA256(secret, `${ts}.${body}`) hex,放在两个固定头里
      headers['x-syncx-timestamp'] = String(ev.ts);
      headers['x-syncx-signature'] = createHmac('sha256', s.secret).update(`${ev.ts}.${body}`).digest('hex');
    }
    return { init: { method: 'POST', headers, body } };
  }

  async function deliver(ev: WebhookEvent): Promise<{ ok: boolean; error?: string }> {
    const s = settings();
    if (!s.url) return { ok: false, error: '未配置 Webhook 地址' };
    const req = buildRequest(s, ev);
    if (!req) return { ok: false, error: '未配置 Webhook 地址' };
    try {
      const res = await doFetch(s.url, { ...req.init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!res.ok) return { ok: false, error: `Webhook 返回 ${res.status}` };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  // 串行投递队列:事件保持先后顺序,慢端点不会并发堆积请求;失败只记日志不抛出。
  let tail: Promise<void> = Promise.resolve();

  return {
    notify(ev: WebhookEvent): void {
      tail = tail
        .then(async () => {
          const r = await deliver(ev);
          if (!r.ok) log?.warn(`webhook ${ev.kind} failed: ${r.error}`);
          else log?.info(`webhook ${ev.kind} delivered`);
        })
        .catch((e: unknown) => {
          log?.warn(`webhook delivery error: ${e instanceof Error ? e.message : String(e)}`);
        });
    },
    async test(): Promise<{ ok: boolean; error?: string }> {
      return deliver({ kind: 'test', ts: Date.now(), message: 'Webhook 测试消息' });
    },
  };
}
