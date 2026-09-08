import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

/**
 * 账号密码登录 + 无状态签名会话。
 *
 * 设计要点:
 * - 密码用 scrypt 加盐派生后落盘,不存明文;校验走常量时间比较。
 * - 会话 cookie 只带 base64url(payload).base64url(HMAC),服务端不存 session,
 *   故 daemon 重启后已登录页面不掉线。
 * - 会话密钥由**密码哈希**派生:改密码 → 密钥变 → 所有旧会话立即失效。
 * - control.token 始终是独立的恢复通道,与账号体系互不覆盖。
 */

/** scrypt 参数:Node 默认值量级,单次约 50–100ms,足以对抗离线爆破。 */
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LEN = 64;
const SALT_LEN = 16;

/** 会话密钥派生上下文:改这个值等于让全部已签发会话失效。 */
const SESSION_CTX = 'syncx-session-v1';

/** 会话有效期。 */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export interface AccountRecord {
  username: string;
  algo: 'scrypt';
  /** hex */
  salt: string;
  /** hex,scrypt 派生结果 */
  hash: string;
  createdAt: number;
  updatedAt: number;
}

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LEN, SCRYPT, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** 常量时间比较。 */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** 读取账号记录;文件不存在或损坏时返回 undefined(不抛,避免拖垮 daemon)。 */
export function loadAccount(file: string): AccountRecord | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<AccountRecord>;
    if (
      typeof parsed.username !== 'string' ||
      typeof parsed.salt !== 'string' ||
      typeof parsed.hash !== 'string' ||
      parsed.algo !== 'scrypt'
    ) {
      return undefined;
    }
    return {
      username: parsed.username,
      algo: 'scrypt',
      salt: parsed.salt,
      hash: parsed.hash,
      createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : 0,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
    };
  } catch {
    return undefined;
  }
}

/** 写入账号记录(0600,与 control.token 同一保护级别)。 */
function writeAccount(file: string, rec: AccountRecord): void {
  writeFileSync(file, `${JSON.stringify(rec, null, 2)}\n`, { mode: 0o600 });
}

/** 设置(或覆盖)账号密码。返回落盘后的记录。 */
export async function setPassword(file: string, username: string, password: string): Promise<AccountRecord> {
  const prev = loadAccount(file);
  const salt = randomBytes(SALT_LEN);
  const hash = await derive(password, salt);
  const now = Date.now();
  const rec: AccountRecord = {
    username,
    algo: 'scrypt',
    salt: salt.toString('hex'),
    hash: hash.toString('hex'),
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  };
  writeAccount(file, rec);
  return rec;
}

/** 校验密码;账号未设置时恒为 false。 */
export async function verifyPassword(file: string, username: string, password: string): Promise<boolean> {
  const rec = loadAccount(file);
  if (!rec) return false;
  // 用户名也走常量时间比较,避免用响应耗时枚举用户名
  if (!safeEqual(username, rec.username)) return false;
  const hash = await derive(password, Buffer.from(rec.salt, 'hex'));
  return safeEqual(hash.toString('hex'), rec.hash);
}

/** 清除账号,退回「仅令牌登录」。文件不存在时不报错。 */
export function clearPassword(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // 文件本来就不存在
  }
}

/* ------------------------------ 无状态会话 ------------------------------ */

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

/** 由「密码哈希」或「control.token」派生会话签名密钥。 */
export function sessionSecret(base: string): string {
  return createHmac('sha256', SESSION_CTX).update(base).digest('hex');
}

export interface SessionPayload {
  /** 登录方式:'password'(账号密码)或 'token'(令牌恢复通道) */
  via: 'password' | 'token';
  /** 用户名;token 登录时固定为 'token' */
  sub: string;
  /** 过期时间(毫秒时间戳) */
  exp: number;
}

/** 签发会话:返回 `<payload>.<签名>`,字符集为 base64url,可直接放进 cookie。 */
export function signSession(payload: SessionPayload, secret: string): string {
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

/** 校验会话;签名不符或已过期返回 undefined。 */
export function verifySession(value: string, secret: string): SessionPayload | undefined {
  const dot = value.indexOf('.');
  if (dot <= 0) return undefined;
  const body = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const expected = b64url(createHmac('sha256', secret).update(body).digest());
  if (!safeEqual(sig, expected)) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload;
    if (typeof payload.exp !== 'number' || Date.now() > payload.exp) return undefined;
    return payload;
  } catch {
    return undefined;
  }
}
