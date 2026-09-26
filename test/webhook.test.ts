import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { rmDir } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { setGlobalSettings } from '../src/devices.js';
import { createControlServer } from '../src/api.js';
import { createWebhookNotifier, isFeishuWebhook, summarizeEvent, type WebhookEvent } from '../src/webhook.js';

/**
 * Webhook 通知器单测:fetch 全部注入,不发真实请求。
 * 覆盖:飞书地址识别、两类格式的请求体与签名、串行队列、失败静默、
 * 设置的热生效(每次现读 config),以及 setGlobalSettings 的校验与落盘。
 */

interface Sent {
  url: string;
  init: RequestInit;
}

function tempConfig(initial: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'syncx-webhook-'));
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ sharedFolders: [], peers: [], knownDevices: [], ...initial }));
  return file;
}

function fakeFetch(
  responses: ((url: string, init: RequestInit) => Response | Promise<Response>)[] = [],
): { sent: Sent[]; fetchImpl: (url: string, init: RequestInit) => Promise<Response> } {
  const sent: Sent[] = [];
  let i = 0;
  return {
    sent,
    fetchImpl: async (url, init) => {
      sent.push({ url, init });
      const next = responses[Math.min(i, responses.length - 1)] ?? (() => new Response(null, { status: 200 }));
      i += 1;
      return next(url, init);
    },
  };
}

/** 等微任务/真实 Promise 链全部落地(notify 是火后忘,得让串行队列跑完)。 */
async function drain(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 5));
}

function bodyOf(s: Sent): Record<string, unknown> {
  return JSON.parse(String(s.init.body)) as Record<string, unknown>;
}

function headersOf(s: Sent): Record<string, string> {
  return s.init.headers as Record<string, string>;
}

function notifierWith(url: string, secret?: string) {
  const file = tempConfig(secret ? { webhookUrl: url, webhookSecret: secret } : { webhookUrl: url });
  const f = fakeFetch();
  const n = createWebhookNotifier({ configPath: file, fetchImpl: f.fetchImpl });
  return { file, sent: f.sent, notifier: n };
}

describe('isFeishuWebhook', () => {
  it('识别官方域与机器人钩子路径,拒绝非法 URL', () => {
    expect(isFeishuWebhook('https://open.feishu.cn/open-apis/bot/v2/hook/abc')).toBe(true);
    expect(isFeishuWebhook('https://www.larksuite.com/open-apis/bot/v2/hook/abc')).toBe(true);
    expect(isFeishuWebhook('https://proxy.example.com/open-apis/bot/v2/hook/abc')).toBe(true);
    expect(isFeishuWebhook('https://example.com/hook')).toBe(false);
    expect(isFeishuWebhook('不是URL')).toBe(false);
  });
});

describe('summarizeEvent', () => {
  it('各类事件都产出含目录与 kind 语义的中文一行摘要', () => {
    const ts = Date.parse('2026-09-26T10:00:00Z');
    expect(summarizeEvent({ kind: 'completed', ts, folder: '/srv/docs' })).toContain('/srv/docs 同步完成');
    expect(
      summarizeEvent({ kind: 'conflict', ts, folder: '/srv/docs', path: 'a.txt', deviceId: 'DEV1' }),
    ).toContain('出现冲突:a.txt(对端 DEV1)');
    expect(summarizeEvent({ kind: 'error', ts, folder: '/srv/docs', message: '磁盘满' })).toContain('同步出错:磁盘满');
    expect(summarizeEvent({ kind: 'test', ts })).toContain('Webhook 测试消息');
  });
});

describe('webhook delivery', () => {
  it('test() 走通用 JSON:成功返回 ok,请求体就是 test 事件', async () => {
    const { file, sent, notifier } = notifierWith('https://hook.example.com/notify');
    const before = Date.now();
    const r = await notifier.test();
    expect(r.ok).toBe(true);
    expect(sent[0]!.url).toBe('https://hook.example.com/notify');
    const payload = bodyOf(sent[0]!);
    expect(payload.kind).toBe('test');
    expect(payload.message).toBe('Webhook 测试消息');
    expect(Number(payload.ts)).toBeGreaterThanOrEqual(before);
    rmDir(dirname(file));
  });

  it('通用地址 + 密钥:完整事件作 JSON 载荷,带可复算的 x-syncx-* HMAC 签名头', async () => {
    const { file, sent, notifier } = notifierWith('https://hook.example.com/notify', 'k3y');
    const ev: WebhookEvent = { kind: 'completed', ts: 1_700_000_000_000, folderId: 'f1', folder: '/srv/docs' };
    notifier.notify(ev);
    await drain();
    expect(sent).toHaveLength(1);
    expect(bodyOf(sent[0]!)).toEqual(ev);
    expect(headersOf(sent[0]!)['Content-Type']).toBe('application/json');
    expect(headersOf(sent[0]!)['x-syncx-timestamp']).toBe('1700000000000');
    expect(headersOf(sent[0]!)['x-syncx-signature']).toBe(
      createHmac('sha256', 'k3y').update(`1700000000000.${JSON.stringify(ev)}`).digest('hex'),
    );
    rmDir(dirname(file));
  });

  it('飞书地址:text 消息格式;密钥按飞书算法(秒级 timestamp + 对空串签名 base64)', async () => {
    const { file, sent, notifier } = notifierWith(
      'https://open.feishu.cn/open-apis/bot/v2/hook/abc',
      'sec',
    );
    notifier.notify({ kind: 'conflict', ts: 1_700_000_000_500, folder: '/srv/docs', path: 'x.md' });
    await drain();
    const payload = bodyOf(sent[0]!);
    expect(payload.msg_type).toBe('text');
    expect((payload.content as { text: string }).text).toContain('出现冲突:x.md');
    expect(payload.timestamp).toBe('1700000000');
    expect(payload.sign).toBe(createHmac('sha256', '1700000000\nsec').update('').digest('base64'));
    rmDir(dirname(file));
  });

  it('未配置地址:test 报「未配置」,notify 静默不发请求、只落 warn 日志', async () => {
    const file = tempConfig();
    const f = fakeFetch();
    const logs: string[] = [];
    const n = createWebhookNotifier({
      configPath: file,
      fetchImpl: f.fetchImpl,
      logger: { info: () => {}, warn: (m) => logs.push(m) },
    });
    expect(await n.test()).toEqual({ ok: false, error: '未配置 Webhook 地址' });
    n.notify({ kind: 'completed', ts: 1 });
    await drain();
    expect(f.sent).toHaveLength(0);
    expect(logs.some((l) => l.includes('未配置 Webhook 地址'))).toBe(true);
    rmDir(dirname(file));
  });

  it('非 2xx 与抛错都不让 notify 崩,失败进 warn 日志;后续事件照常投递', async () => {
    const file = tempConfig({ webhookUrl: 'https://hook.example.com/x' });
    const f = fakeFetch([
      () => new Response(null, { status: 500 }),
      () => {
        throw new Error('ECONNREFUSED');
      },
      () => new Response(null, { status: 204 }),
    ]);
    const logs: string[] = [];
    const n = createWebhookNotifier({
      configPath: file,
      fetchImpl: f.fetchImpl,
      logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    });
    n.notify({ kind: 'completed', ts: 1 });
    n.notify({ kind: 'completed', ts: 2 });
    n.notify({ kind: 'conflict', ts: 3 });
    await drain();
    expect(f.sent).toHaveLength(3);
    expect(logs).toContain('webhook completed failed: Webhook 返回 500');
    expect(logs).toContain('webhook completed failed: ECONNREFUSED');
    expect(logs).toContain('webhook conflict delivered');
    rmDir(dirname(file));
  });

  it('串行队列:慢的第一个事件挡在后面的事件之前,顺序不乱', async () => {
    const file = tempConfig({ webhookUrl: 'https://hook.example.com/x' });
    const order: string[] = [];
    const n = createWebhookNotifier({
      configPath: file,
      fetchImpl: async (_url, init) => {
        const kind = (JSON.parse(String(init.body)) as { kind: string }).kind;
        if (kind === 'completed') await new Promise((r) => setTimeout(r, 60));
        order.push(kind);
        return new Response(null, { status: 200 });
      },
    });
    // notify 是同步火后忘:两个事件几乎同时入队,慢端点下仍须按入队顺序投递
    n.notify({ kind: 'completed', ts: 1 });
    n.notify({ kind: 'conflict', ts: 2 });
    await drain();
    expect(order).toEqual(['completed', 'conflict']);
    rmDir(dirname(file));
  });

  it('改配置即时生效:notify 每次现读 config,不需要重建通知器', async () => {
    const file = tempConfig({ webhookUrl: 'https://old.example.com/h' });
    const f = fakeFetch();
    const n = createWebhookNotifier({ configPath: file, fetchImpl: f.fetchImpl });
    n.notify({ kind: 'completed', ts: 1 });
    await drain();
    setGlobalSettings(file, { webhookUrl: 'https://new.example.com/h' });
    n.notify({ kind: 'completed', ts: 2 });
    await drain();
    expect(f.sent.map((s) => s.url)).toEqual(['https://old.example.com/h', 'https://new.example.com/h']);
    rmDir(dirname(file));
  });
});

describe('setGlobalSettings webhook validation', () => {
  it('trim 后落盘;非法 scheme / 超长抛中文错误;空串与 null 清除', () => {
    const file = tempConfig();
    setGlobalSettings(file, { webhookUrl: '  https://a.example.com/h  ' });
    expect(JSON.parse(readFileSync(file, 'utf8')).webhookUrl).toBe('https://a.example.com/h');

    expect(() => setGlobalSettings(file, { webhookUrl: 'ftp://a.example.com' })).toThrow(
      'Webhook 地址须以 http:// 或 https:// 开头',
    );
    expect(() => setGlobalSettings(file, { webhookUrl: `https://${'a'.repeat(500)}` })).toThrow('Webhook 地址过长');
    expect(() => setGlobalSettings(file, { webhookSecret: 'x'.repeat(201) })).toThrow('Webhook 密钥过长');

    setGlobalSettings(file, { webhookUrl: '' });
    expect(JSON.parse(readFileSync(file, 'utf8')).webhookUrl).toBeUndefined();
    // 未出现的键保持不动:只清密钥不应碰地址
    setGlobalSettings(file, { webhookUrl: 'https://b.example.com', webhookSecret: 's1' });
    setGlobalSettings(file, { webhookSecret: null });
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    expect(raw.webhookUrl).toBe('https://b.example.com');
    expect(raw.webhookSecret).toBeUndefined();
    rmDir(dirname(file));
  });

  it('loadConfig 保留 webhook 字段且清洗坏值(非字符串丢弃、空白 trim、超长丢弃)', () => {
    const file = tempConfig();
    writeFileSync(file, JSON.stringify({ webhookUrl: 'https://a.example.com', webhookSecret: '  pad  ' }));
    expect(loadConfig(file).webhookUrl).toBe('https://a.example.com');
    expect(loadConfig(file).webhookSecret).toBe('pad');
    // 无关设置的 mutateConfig 往返不能弄丢 webhook 配置(loadConfig 白名单遗漏的回归)
    setGlobalSettings(file, { versionsPerPath: 5 });
    expect(loadConfig(file).webhookUrl).toBe('https://a.example.com');
    writeFileSync(file, JSON.stringify({ webhookUrl: 42, webhookSecret: '   ' }));
    expect(loadConfig(file).webhookUrl).toBeUndefined();
    expect(loadConfig(file).webhookSecret).toBeUndefined();
    rmDir(dirname(file));
  });
});

describe('webhook control routes', () => {
  async function withServer(
    deps: Partial<Parameters<typeof createControlServer>[0]>,
  ): Promise<{ port: number; close: () => void }> {
    const server = createControlServer({
      token: 'secret',
      getStatus: () => ({}),
      ...deps,
    } as Parameters<typeof createControlServer>[0]);
    server.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    return {
      port: (server.address() as AddressInfo).port,
      close: () => server.close(),
    };
  }

  function post(port: number, path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path,
          method: 'POST',
          headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
        },
        (res) => {
          res.setEncoding('utf8');
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, json: data === '' ? {} : (JSON.parse(data) as Record<string, unknown>) }),
          );
        },
      );
      req.on('error', reject);
      req.write(JSON.stringify(body));
      req.end();
    });
  }

  it('POST /api/settings:webhook 键按出现才传,非字符串值 400', async () => {
    let received: Record<string, unknown> | undefined;
    const { port, close } = await withServer({
      setGlobalSettings: (patch: Record<string, unknown>) => {
        received = patch;
      },
    });
    const ok = await post(port, '/api/settings', { webhookUrl: 'https://a.example.com', webhookSecret: null });
    expect(ok.status).toBe(200);
    // 只出现的键进 patch;null 原样透传(清除语义);未出现的 webhookSecret 之外字段不凭空补
    expect(received).toEqual({ webhookUrl: 'https://a.example.com', webhookSecret: null });

    const bad = await post(port, '/api/settings', { webhookUrl: 42 });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe('webhookUrl must be a string or null');
    close();
  });

  it('POST /api/settings/webhook-test:成功 200,失败 400 透出原因', async () => {
    let result = { ok: true } as { ok: boolean; error?: string };
    const { port, close } = await withServer({ testWebhook: () => Promise.resolve(result) });
    expect((await post(port, '/api/settings/webhook-test', {})).status).toBe(200);
    result = { ok: false, error: '未配置 Webhook 地址' };
    const r = await post(port, '/api/settings/webhook-test', {});
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('未配置 Webhook 地址');
    close();
  });
});
