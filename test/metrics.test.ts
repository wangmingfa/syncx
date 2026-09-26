import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createControlServer } from '../src/api.js';
import { renderMetrics } from '../src/api/routes/metrics.js';

/**
 * Prometheus /metrics + /healthz 的测试:
 * - renderMetrics 的文本格式(HELP/TYPE 一次、标签转义、缺字段渲染 0 不出 NaN);
 * - 路由接线:/healthz 免认证、/metrics 需登录、Content-Type 与 405 语义。
 */

let server: ReturnType<typeof createControlServer>;
let port = 0;

beforeAll(async () => {
  server = createControlServer({
    token: 'secret',
    getStatus: () => ({
      deviceId: 'DEV-A',
      version: '0.3.2',
      platform: 'win32',
      entries: 120,
      tombstones: 3,
      paused: false,
      folders: [
        { path: 'C:\\share\\photos', devices: ['DEV-B', 'DEV-C'], paused: true },
        { id: 'box', path: '/data/box', devices: [], onDemand: true },
      ],
      devices: [
        { deviceId: 'DEV-B', online: true, folders: [] },
        { deviceId: 'DEV-C', online: false, folders: [] },
      ],
      syncProgress: [{ folder: 'box', pending: 4, sending: 1, receiving: 2 }],
      offers: [],
      folderErrors: [{ folder: 'box', message: 'x', ts: 1 }],
      conflictCounts: { box: 2 },
      traffic: { sent: 1000, received: 2000, samples: [] },
      powerGuard: null,
    }),
  });
  server.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  server.close();
});

function req(
  path: string,
  opts: { method?: string; token?: string } = {},
): Promise<{ status: number; headers: NodeJS.Dict<string | string[]>; text: string }> {
  return new Promise((resolve, reject) => {
    const r = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: opts.method ?? 'GET',
        headers: opts.token ? { Authorization: `Bearer ${opts.token}` } : {},
      },
      (res) => {
        res.setEncoding('utf8');
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: data }));
      },
    );
    r.on('error', reject);
    r.end();
  });
}

describe('GET /healthz(免认证探活)', () => {
  it('无凭据 200,只报存活与时长', async () => {
    const res = await req('/healthz');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.text) as { ok?: boolean; uptime?: number };
    expect(body.ok).toBe(true);
    expect(typeof body.uptime).toBe('number');
  });
});

describe('GET /metrics(需登录)', () => {
  it('无凭据 401;带令牌 200 + Prometheus 文本格式', async () => {
    expect((await req('/metrics')).status).toBe(401);
    const res = await req('/metrics', { token: 'secret' });
    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toContain('text/plain; version=0.0.4');
    expect(res.text).toContain('syncx_up 1');
    expect(res.text).toContain('syncx_index_entries 120');
    expect(res.text).toContain('syncx_index_tombstones 3');
    expect(res.text).toContain('syncx_shared_folders 2');
    expect(res.text).toContain('syncx_peers_configured 2');
    expect(res.text).toContain('syncx_peers_online 1');
    expect(res.text).toContain('syncx_traffic_sent_bytes_total 1000');
    expect(res.text).toContain('syncx_traffic_received_bytes_total 2000');
    expect(res.text).toContain('syncx_transfer_pending_files{folder="box"} 4');
    expect(res.text).toContain('syncx_conflict_copies{folder="box"} 2');
    expect(res.text).toContain('syncx_folder_error{folder="box"} 1');
    expect(res.text).toContain('syncx_folder_paused{folder="C:\\\\share\\\\photos"} 1');
    expect(res.text).toContain('syncx_folder_on_demand{folder="box"} 1');
    expect(res.text).toContain('syncx_build_info{version="0.3.2",platform="win32"} 1');
  });

  it('非 GET 405;HEAD 200 无正文', async () => {
    expect((await req('/metrics', { method: 'POST', token: 'secret' })).status).toBe(405);
    const head = await req('/metrics', { method: 'HEAD', token: 'secret' });
    expect(head.status).toBe(200);
    expect(head.text).toBe('');
  });
});

describe('renderMetrics 的格式约定', () => {
  it('每个指标名 HELP/TYPE 恰一次,样本行都带数值', () => {
    const text = renderMetrics({
      entries: 1,
      folders: [
        { path: '/a', devices: [] },
        { path: '/b', devices: [] },
      ],
    });
    const typeCount = new Map<string, number>();
    for (const line of text.split('\n')) {
      const m = /^# TYPE (\S+) (gauge|counter)$/.exec(line);
      if (m && m[1]) typeCount.set(m[1], (typeCount.get(m[1]) ?? 0) + 1);
      // 样本行(非注释、非空):必须形如 name{labels}? number
      if (line && !line.startsWith('# ')) {
        expect(line).toMatch(/^[a-z_0-9]+(\{.*\})? -?[\d.eE+]+$/);
      }
    }
    for (const [name, count] of typeCount) expect(count).toBe(1);
    // 两条目录序列 → folder 标签出现两次而 TYPE 一次
    expect(typeCount.get('syncx_folder_paused')).toBe(1);
    expect(text.match(/syncx_folder_paused\{folder="/g)?.length).toBe(2);
  });

  it('空/残缺载荷不崩:数值缺省渲染 0,不出 NaN', () => {
    // 真实载荷可能带 null(JSON 反序列化残留),类型上不允许但运行时要扛住
    const text = renderMetrics({ entries: Number.NaN, folders: null } as unknown as Parameters<typeof renderMetrics>[0]);
    expect(text).toContain('syncx_up 1');
    expect(text).toContain('syncx_index_entries 0');
    expect(text).not.toContain('NaN');
    expect(renderMetrics(null)).toContain('syncx_up 1');
    expect(renderMetrics(undefined)).toContain('syncx_shared_folders 0');
  });
});
