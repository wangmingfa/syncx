import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createControlServer } from '../src/api.js';
import type { ControlServerDeps } from '../src/api/deps.js';
import { DEFAULT_CONFIG, loadConfig, saveConfig, type ShareRecord } from '../src/config.js';
import { setGlobalSettings } from '../src/devices.js';
import { resolveFolderSubpath } from '../src/filebrowser.js';
import {
  SHARE_CAP,
  createShare,
  listShares,
  noteShareDownload,
  revokeShare,
  verifyShare,
} from '../src/share.js';
import { resetShareRateLimit } from '../src/api/routes/share.js';

/**
 * 分享链接(免登录限时下载,默认关闭)的三层验证:
 * - share.ts 纯逻辑:签发/验签/过期/撤销/上限/竞态计数;
 * - config 清洗:手改的坏记录不会混进校验路径;关开关 = 记录全清;
 * - 路由编排:/s/ 匿名下载、创建需提权、列出仅需登录、限流与开关语义。
 */

const TOKEN = 'secret';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'syncx-share-'));
}

function makeRecord(over: Partial<ShareRecord> = {}): ShareRecord {
  const now = Date.now();
  return {
    id: 'a'.repeat(32),
    folderId: 'F1',
    path: 'f.txt',
    createdAt: now,
    expiresAt: now + 3_600_000,
    ...over,
  };
}

describe('share.ts 签发与验签', () => {
  let dir = '';
  let cfg = '';

  beforeEach(() => {
    dir = tmpDir();
    cfg = join(dir, 'config.json');
    saveConfig(cfg, { ...DEFAULT_CONFIG, shareEnabled: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('创建 → 校验通过,记录落盘且 urlToken 三段齐', () => {
    const { record, urlToken } = createShare(cfg, TOKEN, { folderId: 'F1', path: 'a/b.bin', ttlMs: 3_600_000 });
    expect(urlToken.split('.')).toHaveLength(3);
    const v = verifyShare(cfg, TOKEN, urlToken);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.record.id).toBe(record.id);
      expect(v.record.path).toBe('a/b.bin');
    }
    // 记录确实在 config 里(重启不丢)
    expect(loadConfig(cfg).shares?.map((s) => s.id)).toContain(record.id);
  });

  it('篡改签名/改有效期 → bad-signature;换控制令牌 → 一律不认(轮换即吊销)', () => {
    const { urlToken } = createShare(cfg, TOKEN, { folderId: 'F1', path: 'x.bin', ttlMs: 3_600_000 });
    const [id = '', exp = '0', sig = ''] = urlToken.split('.');
    const flip = (s: string): string => (s[0] === 'f' ? 'e' : 'f') + s.slice(1);
    expect(verifyShare(cfg, TOKEN, `${id}.${exp}.${flip(sig)}`)).toEqual({ ok: false, reason: 'bad-signature' });
    expect(verifyShare(cfg, TOKEN, `${id}.${Number(exp) + 1000}.${sig}`)).toEqual({ ok: false, reason: 'bad-signature' });
    expect(verifyShare(cfg, 'other-token', urlToken).ok).toBe(false);
  });

  it('过期 → unknown-or-expired;撤销(删记录)后同令牌立即失效', () => {
    const now = Date.now();
    const { urlToken } = createShare(cfg, TOKEN, { folderId: 'F1', path: 'x.bin', ttlMs: 60_000 }, now);
    expect(verifyShare(cfg, TOKEN, urlToken, now + 61_000).ok).toBe(false);
    // 未过期时能验过,撤销记录后即刻不过
    const v = verifyShare(cfg, TOKEN, urlToken, now + 1000);
    expect(v.ok).toBe(true);
    if (v.ok) revokeShare(cfg, v.record.id);
    expect(verifyShare(cfg, TOKEN, urlToken, now + 1000)).toEqual({ ok: false, reason: 'unknown-or-expired' });
    expect(() => revokeShare(cfg, 'nope')).toThrow(/不存在/);
  });

  it('脏令牌不发 HMAC:malformed;列表只回未过期的,新→旧', () => {
    expect(verifyShare(cfg, TOKEN, 'zzz.1.2')).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyShare(cfg, TOKEN, 'x'.repeat(40))).toEqual({ ok: false, reason: 'malformed' });
    const now = Date.now();
    createShare(cfg, TOKEN, { folderId: 'F1', path: 'old.bin', ttlMs: 60_000 }, now - 61_000); // 60s 有效期,1s 前已过期
    const b = createShare(cfg, TOKEN, { folderId: 'F1', path: 'b.bin', ttlMs: 3_600_000 }, now - 5_000);
    const a = createShare(cfg, TOKEN, { folderId: 'F1', path: 'a.bin', ttlMs: 3_600_000 }, now);
    const live = listShares(cfg, now + 1000);
    expect(live.map((s) => s.path)).toEqual(['a.bin', 'b.bin']);
    expect(live[0]?.id).toBe(a.record.id);
    expect(live[1]?.id).toBe(b.record.id);
  });

  it('有效期越界拒绝;活跃数触顶拒绝(不静默淘汰既有链接);触顶前先清过期', () => {
    expect(() => createShare(cfg, TOKEN, { folderId: 'F1', path: 'x', ttlMs: 1000 })).toThrow(/1 分钟/);
    expect(() => createShare(cfg, TOKEN, { folderId: 'F1', path: 'x', ttlMs: 31 * 86_400_000 })).toThrow(/30 天/);
    const now = Date.now();
    const seed: ShareRecord[] = Array.from({ length: SHARE_CAP }, (_, i) =>
      makeRecord({ id: i.toString(16).padStart(32, '0'), createdAt: now - 1, expiresAt: now + 86_400_000 }),
    );
    saveConfig(cfg, { ...DEFAULT_CONFIG, shareEnabled: true, shares: seed });
    expect(() => createShare(cfg, TOKEN, { folderId: 'F1', path: 'x', ttlMs: 3_600_000 }, now)).toThrow(/上限/);
    // 一半已过期的不算数:清理后仍能创建
    const half = seed.map((s, i) => (i % 2 === 0 ? { ...s, expiresAt: now - 1 } : s));
    saveConfig(cfg, { ...DEFAULT_CONFIG, shareEnabled: true, shares: half });
    expect(() => createShare(cfg, TOKEN, { folderId: 'F1', path: 'x', ttlMs: 3_600_000 }, now + 10)).not.toThrow();
  });

  it('下载计数累加;记录恰被撤销时静默吞下(竞态不报错)', () => {
    const { record } = createShare(cfg, TOKEN, { folderId: 'F1', path: 'x.bin', ttlMs: 3_600_000 });
    noteShareDownload(cfg, record.id, 111);
    noteShareDownload(cfg, record.id, 222);
    const rec = loadConfig(cfg).shares?.find((s) => s.id === record.id);
    expect(rec?.downloads).toBe(2);
    expect(rec?.lastDownloadAt).toBe(222);
    expect(() => noteShareDownload(cfg, 'gone', 333)).not.toThrow();
  });
});

describe('config 清洗与开关落盘', () => {
  let dir = '';
  let cfg = '';

  beforeEach(() => {
    dir = tmpDir();
    cfg = join(dir, 'config.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('手改的坏分享记录被丢弃,好条目字段保留;空列表归一为缺省', () => {
    const good = makeRecord({ id: 'b'.repeat(32), downloads: 3 });
    saveConfig(cfg, {
      ...DEFAULT_CONFIG,
      // 绕开类型直接写脏数据:模拟手改 config.json
      shares: [
        good,
        { id: '', folderId: 'F', path: 'p', createdAt: 1, expiresAt: 2 }, // 空 id
        { id: 'x', folderId: 'F', path: 'p', createdAt: 9, expiresAt: 9 }, // 到期不晚于创建
        { id: 'y', folderId: 'F', path: 'p', createdAt: 1 }, // 缺 expiresAt
        null,
        'junk',
      ],
    } as never);
    const shares = loadConfig(cfg).shares;
    expect(shares?.map((s) => s.id)).toEqual(['b'.repeat(32)]);
    expect(shares?.[0]?.downloads).toBe(3);
    saveConfig(cfg, { ...DEFAULT_CONFIG, shares: [] } as never);
    expect(loadConfig(cfg).shares).toBeUndefined();
  });

  it('setGlobalSettings:shareEnabled 仅 true 落盘;关闭连带清空在册记录(关即全断)', () => {
    saveConfig(cfg, {
      ...DEFAULT_CONFIG,
      shareEnabled: true,
      shares: [makeRecord()],
    });
    setGlobalSettings(cfg, { shareEnabled: false });
    let c = loadConfig(cfg);
    expect(c.shareEnabled).toBeUndefined();
    expect(c.shares).toBeUndefined();
    setGlobalSettings(cfg, { shareEnabled: true });
    c = loadConfig(cfg);
    expect(c.shareEnabled).toBe(true);
    // 再关:null 与 false 同义
    setGlobalSettings(cfg, { shareEnabled: null });
    expect(loadConfig(cfg).shareEnabled).toBeUndefined();
  });
});

// ---------------- 路由层 ----------------

interface RawRes {
  status: number;
  headers: NodeJS.Dict<string | string[]>;
  text: string;
}

function reqRaw(
  port: number,
  path: string,
  opts: { method?: string; token?: string; cookie?: string; body?: unknown } = {},
): Promise<RawRes> {
  return new Promise((resolve, reject) => {
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: opts.method ?? 'GET',
        headers: {
          ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
          ...(opts.cookie ? { Cookie: opts.cookie } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
      },
      (res) => {
        res.setEncoding('utf8');
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: data }));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('分享链接路由', () => {
  let dir = '';
  let cfg = '';
  let shareRoot = '';
  let server: ReturnType<typeof createControlServer>;
  let port = 0;

  beforeAll(async () => {
    dir = tmpDir();
    cfg = join(dir, 'config.json');
    shareRoot = join(dir, 'share');
    mkdirSync(shareRoot, { recursive: true });
    writeFileSync(join(shareRoot, 'movie.mkv'), '分享载荷-bytes');
    saveConfig(cfg, { ...DEFAULT_CONFIG, shareEnabled: true });
    // 与 cli.ts 同一条接线的微缩版:真 share.ts + 真 config 文件
    const deps: ControlServerDeps = {
      token: TOKEN,
      getStatus: () => ({}),
      // 走真实的 devices.setGlobalSettings(shareEnabled 落盘 + 关即清册)
      setGlobalSettings: (patch) => setGlobalSettings(cfg, patch),
      resolveFolderFile: (folderId, rel) => {
        if (folderId !== 'F1') throw new Error('未找到共享目录');
        return resolveFolderSubpath(shareRoot, rel);
      },
      share: {
        enabled: () => loadConfig(cfg).shareEnabled === true,
        list: () => listShares(cfg),
        create: (folderId, p, ttlMs) => {
          if (loadConfig(cfg).shareEnabled !== true) throw new Error('分享链接未启用');
          if (folderId !== 'F1') throw new Error('未找到共享目录');
          const abs = resolveFolderSubpath(shareRoot, p);
          if (!statSync(abs).isFile()) throw new Error('只能分享盘上存在的文件');
          const r = createShare(cfg, TOKEN, { folderId, path: p, ttlMs });
          return { urlToken: r.urlToken, expiresAt: r.record.expiresAt };
        },
        revoke: (id) => {
          revokeShare(cfg, id);
        },
        verify: (t) => {
          const v = verifyShare(cfg, TOKEN, t);
          return v.ok ? { id: v.record.id, folderId: v.record.folderId, path: v.record.path } : undefined;
        },
        noteDownload: (id) => {
          noteShareDownload(cfg, id);
        },
      },
    };
    server = createControlServer(deps);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    resetShareRateLimit();
    saveConfig(cfg, { ...DEFAULT_CONFIG, shareEnabled: true });
  });

  async function mintSu(): Promise<string> {
    const res = await reqRaw(port, '/api/elevate', { method: 'POST', token: TOKEN, body: { token: TOKEN } });
    expect(res.status).toBe(200);
    const raw = res.headers['set-cookie'];
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const su = list.find((c) => c.startsWith('syncx_su='));
    expect(su).toBeDefined();
    return (su as string).slice(0, (su as string).indexOf(';'));
  }

  it('/api/shares 列表:登录即可,带开关状态;未登录 401', async () => {
    const anon = await reqRaw(port, '/api/shares');
    expect(anon.status).toBe(401);
    const r = await reqRaw(port, '/api/shares', { token: TOKEN });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toEqual({ enabled: true, shares: [] });
  });

  it('创建需提权;匿名下载命中内容;撤销后 404', async () => {
    const noSu = await reqRaw(port, '/api/shares/create', {
      method: 'POST',
      token: TOKEN,
      body: { folderId: 'F1', path: 'movie.mkv', ttlHours: 24 },
    });
    expect(noSu.status).toBe(403);

    const su = await mintSu();
    const made = await reqRaw(port, '/api/shares/create', {
      method: 'POST',
      token: TOKEN,
      cookie: su,
      body: { folderId: 'F1', path: 'movie.mkv', ttlHours: 24 },
    });
    expect(made.status).toBe(200);
    const { urlToken } = JSON.parse(made.text) as { urlToken: string };
    expect(urlToken).toMatch(/^[0-9a-f]{32}\.\d+\.[0-9a-f]{32}$/);

    // 匿名(不带任何凭据)按链接下载
    const dl = await reqRaw(port, `/s/${urlToken}`);
    expect(dl.status).toBe(200);
    expect(dl.text).toBe('分享载荷-bytes');
    expect(String(dl.headers['content-disposition'])).toContain('movie.mkv');

    // 下载计数进了记录
    const list = await reqRaw(port, '/api/shares', { token: TOKEN });
    const rows = (JSON.parse(list.text) as { shares: Array<{ downloads?: number; path: string }> }).shares;
    expect(rows[0]?.path).toBe('movie.mkv');
    expect(rows[0]?.downloads).toBe(1);

    // 撤销(登录即可,不需提权)后链接立即失效
    const id = (JSON.parse(list.text) as { shares: Array<{ id: string }> }).shares[0]?.id ?? '';
    const rev = await reqRaw(port, '/api/shares/revoke', { method: 'POST', token: TOKEN, body: { id } });
    expect(rev.status).toBe(200);
    expect((await reqRaw(port, `/s/${urlToken}`)).status).toBe(404);
  });

  it('无效令牌一律 404;同 IP 连败超限后 429(第 41 次失败起)', async () => {
    expect((await reqRaw(port, '/s/deadbeef')).status).toBe(404); // 失败 #1(脏串也算一次探测)
    for (let i = 0; i < 39; i++) {
      // 失败 #2..#40:仍在阈值内
      expect((await reqRaw(port, '/s/00000000000000000000000000000000.9999999999999.00000000000000000000000000000000')).status).toBe(404);
    }
    // 第 41 次失败本身就被限流;之后的请求(连令牌形态都不看)一律 429
    expect((await reqRaw(port, '/s/whatever')).status).toBe(429);
    expect((await reqRaw(port, '/s/whatever')).status).toBe(429);
  });

  it('开关关闭:在外的链接立即 404、创建被拒;POST /api/settings 透传该键', async () => {
    const su = await mintSu();
    const made = await reqRaw(port, '/api/shares/create', {
      method: 'POST',
      token: TOKEN,
      cookie: su,
      body: { folderId: 'F1', path: 'movie.mkv', ttlHours: 1 },
    });
    const { urlToken } = JSON.parse(made.text) as { urlToken: string };
    expect((await reqRaw(port, `/s/${urlToken}`)).status).toBe(200);

    // 走真实的全局设置链路关掉开关
    const off = await reqRaw(port, '/api/settings', { method: 'POST', token: TOKEN, body: { shareEnabled: null } });
    expect(off.status).toBe(200);
    expect(loadConfig(cfg).shareEnabled).toBeUndefined();
    expect(loadConfig(cfg).shares).toBeUndefined(); // 关即清册
    expect((await reqRaw(port, `/s/${urlToken}`)).status).toBe(404);
    const denied = await reqRaw(port, '/api/shares/create', {
      method: 'POST',
      token: TOKEN,
      cookie: su,
      body: { folderId: 'F1', path: 'movie.mkv', ttlHours: 1 },
    });
    expect(denied.status).toBe(400);
    expect(denied.text).toContain('未启用');
  });

  it('参数校验:非法 ttlHours/空路径/目录不可分享都回 400', async () => {
    const su = await mintSu();
    const badTtl = await reqRaw(port, '/api/shares/create', {
      method: 'POST', token: TOKEN, cookie: su, body: { folderId: 'F1', path: 'movie.mkv', ttlHours: 5 },
    });
    expect(badTtl.status).toBe(400);
    const emptyPath = await reqRaw(port, '/api/shares/create', {
      method: 'POST', token: TOKEN, cookie: su, body: { folderId: 'F1', path: '', ttlHours: 24 },
    });
    expect(emptyPath.status).toBe(400);
    const noFile = await reqRaw(port, '/api/shares/create', {
      method: 'POST', token: TOKEN, cookie: su, body: { folderId: 'F1', path: 'ghost.bin', ttlHours: 24 },
    });
    expect(noFile.status).toBe(400);
    const unknownFolder = await reqRaw(port, '/api/shares/create', {
      method: 'POST', token: TOKEN, cookie: su, body: { folderId: 'ZZ', path: 'movie.mkv', ttlHours: 24 },
    });
    expect(unknownFolder.status).toBe(400);
  });
});
