import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearPassword,
  loadAccount,
  safeEqual,
  sessionSecret,
  setPassword,
  signSession,
  verifyPassword,
  verifySession,
  SESSION_TTL_MS,
} from '../src/auth.js';
import { createControlServer } from '../src/api.js';

function tmpAuthFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'syncx-auth-'));
  return join(dir, 'auth.json');
}

describe('auth: 密码哈希与存储', () => {
  let file: string;
  beforeEach(() => {
    file = tmpAuthFile();
  });
  afterEach(() => clearPassword(file));

  it('未设置时 loadAccount 返回 undefined,校验恒为 false', async () => {
    expect(loadAccount(file)).toBeUndefined();
    expect(await verifyPassword(file, 'a', 'b')).toBe(false);
  });

  it('设置后可用正确密码通过,错误密码与错误用户名均拒绝', async () => {
    await setPassword(file, 'wangmingfa', 'hunter2!');
    expect(loadAccount(file)?.username).toBe('wangmingfa');
    expect(await verifyPassword(file, 'wangmingfa', 'hunter2!')).toBe(true);
    expect(await verifyPassword(file, 'wangmingfa', 'wrong')).toBe(false);
    expect(await verifyPassword(file, 'someone', 'hunter2!')).toBe(false);
  });

  it('落盘的是 scrypt 派生值,不含明文密码', async () => {
    await setPassword(file, 'u', 'super-secret-password');
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain('super-secret-password');
    const rec = loadAccount(file);
    expect(rec?.algo).toBe('scrypt');
    expect(rec?.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(rec?.hash).toMatch(/^[0-9a-f]{128}$/);
  });

  it('每次设置都换盐,同一密码两次哈希不同', async () => {
    const a = await setPassword(file, 'u', 'same');
    const b = await setPassword(file, 'u', 'same');
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });

  it('清除后文件消失,退回未设置状态', async () => {
    await setPassword(file, 'u', 'p');
    expect(existsSync(file)).toBe(true);
    clearPassword(file);
    expect(existsSync(file)).toBe(false);
    expect(loadAccount(file)).toBeUndefined();
  });

  it('文件损坏时 loadAccount 不抛,返回 undefined', () => {
    writeFileSync(file, '{ not json', 'utf8');
    expect(loadAccount(file)).toBeUndefined();
  });
});

describe('auth: 无状态签名会话', () => {
  it('签发后可校验通过,并带上 via/sub', () => {
    const secret = sessionSecret('base-secret');
    const value = signSession({ via: 'password', sub: 'wmf', exp: Date.now() + 60_000 }, secret);
    expect(value).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const payload = verifySession(value, secret);
    expect(payload?.sub).toBe('wmf');
    expect(payload?.via).toBe('password');
  });

  it('cookie 值不含分号/空格/非 ASCII(避免破坏 Set-Cookie 语法)', () => {
    const secret = sessionSecret('base');
    const value = signSession({ via: 'password', sub: '我的密码', exp: Date.now() + 60_000 }, secret);
    expect(value).not.toMatch(/[; "\\\x00-\x1f\x80-\uffff]/);
  });

  it('密钥不同则校验失败(改密码即踢掉旧会话)', () => {
    const value = signSession({ via: 'password', sub: 'u', exp: Date.now() + 60_000 }, sessionSecret('old'));
    expect(verifySession(value, sessionSecret('new'))).toBeUndefined();
  });

  it('过期会话被拒绝', () => {
    const secret = sessionSecret('base');
    const value = signSession({ via: 'password', sub: 'u', exp: Date.now() - 1 }, secret);
    expect(verifySession(value, secret)).toBeUndefined();
  });

  it('被篡改的 payload 校验失败', () => {
    const secret = sessionSecret('base');
    const value = signSession({ via: 'password', sub: 'u', exp: Date.now() + 60_000 }, secret);
    const [body, sig] = value.split('.');
    const forged = `${Buffer.from(JSON.stringify({ via: 'password', sub: 'admin', exp: Date.now() + 60_000 })).toString('base64url')}.${sig}`;
    expect(forged).not.toBe(value);
    expect(body).toBeDefined();
    expect(verifySession(forged, secret)).toBeUndefined();
  });

  it('safeEqual 对同长不同内容返回 false', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});

/* --------------------------- 控制服务器集成 --------------------------- */

interface Started {
  port: number;
  close: () => void;
}

async function start(token: string, authFile: string): Promise<Started> {
  const server = createControlServer({ token, authFile, getStatus: () => ({ ok: true }) });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { port, close: () => server.close() };
}

function cookieOf(res: Response): string {
  const raw = res.headers.get('set-cookie') ?? '';
  return raw.slice(raw.indexOf('=') + 1, raw.indexOf(';'));
}

describe('control server: 令牌 + 账号密码双通道', () => {
  let authFile: string;
  let s: Started;
  const TOKEN = 'tok-abcdef';

  beforeEach(async () => {
    authFile = tmpAuthFile();
    s = await start(TOKEN, authFile);
  });
  afterEach(() => {
    s.close();
    clearPassword(authFile);
  });

  it('/api/auth 未设密码时报告 token 模式', async () => {
    const res = await fetch(`http://127.0.0.1:${s.port}/api/auth`);
    expect((await res.json()).mode).toBe('token');
  });

  it('未认证请求被拒;Bearer 令牌可用', async () => {
    expect((await fetch(`http://127.0.0.1:${s.port}/api/status`)).status).toBe(401);
    const ok = await fetch(`http://127.0.0.1:${s.port}/api/status`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(ok.status).toBe(200);
  });

  it('未设密码时 /api/login 返回 401(不是绕过)', async () => {
    const res = await fetch(`http://127.0.0.1:${s.port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'u', password: 'p' }),
    });
    expect(res.status).toBe(401);
  });

  it('设密码后可用账号密码登录,凭 cookie 访问 API', async () => {
    // 用令牌登录 → 设置密码(需要已认证)
    const login = await fetch(`http://127.0.0.1:${s.port}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `token=${TOKEN}`,
      redirect: 'manual',
    });
    const bootstrap = cookieOf(login);
    expect(bootstrap).not.toBe('');
    // 令牌原文不再进 cookie(避免分号/非 ASCII 破坏 cookie 语法)
    expect(bootstrap).not.toBe(TOKEN);

    const setRes = await fetch(`http://127.0.0.1:${s.port}/api/auth/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `syncx_session=${bootstrap}` },
      body: JSON.stringify({ username: 'wmf', password: 'hunter2!' }),
    });
    expect(setRes.status).toBe(200);

    // 账号密码登录
    const res = await fetch(`http://127.0.0.1:${s.port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'wmf', password: 'hunter2!' }),
    });
    expect(res.status).toBe(200);
    const session = cookieOf(res);
    const status = await fetch(`http://127.0.0.1:${s.port}/api/status`, {
      headers: { Cookie: `syncx_session=${session}` },
    });
    expect(status.status).toBe(200);
  });

  it('密码错误返回 401,且不下发 cookie', async () => {
    await setPassword(authFile, 'wmf', 'right-one');
    const res = await fetch(`http://127.0.0.1:${s.port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'wmf', password: 'wrong' }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('设置密码后旧的令牌会话失效,令牌原文仍然可用(恢复通道)', async () => {
    const login = await fetch(`http://127.0.0.1:${s.port}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `token=${TOKEN}`,
      redirect: 'manual',
    });
    const oldSession = cookieOf(login);

    await setPassword(authFile, 'wmf', 'hunter2!');

    // 旧会话(由 token 派生密钥签发)作废
    const rejected = await fetch(`http://127.0.0.1:${s.port}/api/status`, {
      headers: { Cookie: `syncx_session=${oldSession}` },
    });
    expect(rejected.status).toBe(401);

    // 令牌本身依然可用
    const ok = await fetch(`http://127.0.0.1:${s.port}/api/status`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(ok.status).toBe(200);
  });

  it('改密码会踢掉旧会话', async () => {
    await setPassword(authFile, 'wmf', 'first-pass');
    const r1 = await fetch(`http://127.0.0.1:${s.port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'wmf', password: 'first-pass' }),
    });
    const oldSession = cookieOf(r1);

    // 用旧会话改密码
    const change = await fetch(`http://127.0.0.1:${s.port}/api/auth/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `syncx_session=${oldSession}` },
      body: JSON.stringify({ username: 'wmf', password: 'second-pass' }),
    });
    expect(change.status).toBe(200);
    // 改密码时给当前请求补发了新会话,所以这次请求本身不会被踢
    expect(change.headers.get('set-cookie')).not.toBeNull();

    const after = await fetch(`http://127.0.0.1:${s.port}/api/status`, {
      headers: { Cookie: `syncx_session=${oldSession}` },
    });
    expect(after.status).toBe(401);
  });

  it('清除密码后退回令牌模式,账号登录不可用', async () => {
    await setPassword(authFile, 'wmf', 'hunter2!');
    const del = await fetch(`http://127.0.0.1:${s.port}/api/auth/password`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(del.status).toBe(200);
    const info = await (await fetch(`http://127.0.0.1:${s.port}/api/auth`)).json();
    expect(info).toMatchObject({ mode: 'token' });
    const res = await fetch(`http://127.0.0.1:${s.port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'wmf', password: 'hunter2!' }),
    });
    expect(res.status).toBe(401);
  });

  it('密码太短被拒;设置密码需要已认证', async () => {
    const short = await fetch(`http://127.0.0.1:${s.port}/api/auth/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ username: 'wmf', password: '123' }),
    });
    expect(short.status).toBe(400);

    const anon = await fetch(`http://127.0.0.1:${s.port}/api/auth/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'wmf', password: 'hunter2!' }),
    });
    expect(anon.status).toBe(401);
  });

  it('连续失败达上限后被限流(429)', async () => {
    await setPassword(authFile, 'wmf', 'hunter2!');
    let last = 0;
    for (let i = 0; i < 6; i++) {
      const res = await fetch(`http://127.0.0.1:${s.port}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'wmf', password: 'nope' }),
      });
      last = res.status;
      if (res.status === 429) break;
    }
    expect(last).toBe(429);
  });

  it('会话 TTL 为 24h', () => {
    expect(SESSION_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });
});
