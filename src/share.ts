import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { loadConfig, mutateConfig, type ShareRecord } from './config.js';

/**
 * 分享链接:限时、免登录的**单文件只读**下载(默认关闭,config.shareEnabled 显式开启)。
 *
 * 令牌形态:`<id>.<expiresAt>.<sig>`
 *  - id:16 随机字节 hex —— 记录主键(config.shares),撤销 = 删记录,链接即刻失效;
 *  - expiresAt:毫秒时间戳,创建时定死并参与签名,URL 里改一个字符签名即不匹配;
 *  - sig:HMAC-SHA256(key, `syncx-share-v1|<id>|<expiresAt>`) 的前 32 位 hex。
 *
 * 密钥 key 由**控制令牌**派生(sha256 域分离):不新增任何落盘机密,且轮换 control.token
 * 即吊销全部在外的分享链接 —— 想紧急止血时改令牌就行。校验恒定时间比对,签名不匹配、
 * 记录不存在、已过期统一回 404(不区分原因,不给探测者判别 oracle)。
 *
 * 记录随 config.json 持久化(saveConfig 原子写):daemon 重启链接不失效;
 * 活跃份额上限 SHARE_CAP,创建时顺手清掉已过期/已撤销的旧条目。
 */

/** 活跃分享记录上限:超了先拒创建(防 config.json 被人肉滚雪球)。 */
export const SHARE_CAP = 100;
/** 有效期合法区间:1 分钟 – 30 天。 */
const MIN_TTL_MS = 60_000;
const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** URL 令牌的形态约束(先粗筛再验签,脏串不进 HMAC)。捕获组:id / 有效期 / 签名。 */
const TOKEN_RE = /^([0-9a-f]{32})\.(\d{1,16})\.([0-9a-f]{32})$/;

/** 由控制令牌派生分享密钥(域分离前缀;控制令牌轮换 = 全部链接作废)。 */
export function deriveShareKey(controlToken: string): Buffer {
  return createHash('sha256').update(`syncx-share-v1|${controlToken}`).digest();
}

function sign(key: Buffer, id: string, expiresAt: number): string {
  return createHmac('sha256', key).update(`syncx-share-v1|${id}|${expiresAt}`).digest('hex').slice(0, 32);
}

/** 恒定时间比较两段 hex(长度不等直接 false,与 timingSafeEqual 的用法一致)。 */
function sigMatches(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}

export interface IssuedShare {
  record: ShareRecord;
  /** 直接拼进 /s/<token> 的完整令牌。 */
  urlToken: string;
}

/**
 * 创建一条分享:校验有效期区间与活跃上限,落盘记录并返回 URL 令牌。
 * folderId 由调用方给出(路由已确认目录存在);path 为目录内相对路径,
 * 「文件真实存在且是普通文件」由调用方在创建前把关(占位文件盘上没有,不可分享)。
 * 超限/参数非法抛错,路由转 400。
 */
export function createShare(
  configPath: string,
  controlToken: string,
  input: { folderId: string; path: string; ttlMs: number },
  now: number = Date.now(),
): IssuedShare {
  const { folderId, path, ttlMs } = input;
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs < MIN_TTL_MS || ttlMs > MAX_TTL_MS) {
    throw new Error('分享有效期须在 1 分钟到 30 天之间');
  }
  const id = randomBytes(16).toString('hex');
  const expiresAt = now + ttlMs;
  const record: ShareRecord = { id, folderId, path, createdAt: now, expiresAt };
  mutateConfig(configPath, (config) => {
    // 顺手清理:先丢掉已过期/已撤销的,再看是否触顶(触顶拒绝创建,不做静默淘汰 ——
    // 悄悄踢掉别人的链接比报错更糟)
    const live = (config.shares ?? []).filter((s) => s.expiresAt > now);
    if (live.length + 1 > SHARE_CAP) {
      throw new Error(`活跃分享已达上限 ${SHARE_CAP} 条,请先撤销一些`);
    }
    config.shares = [...live, record];
  });
  const urlToken = `${id}.${expiresAt}.${sign(deriveShareKey(controlToken), id, expiresAt)}`;
  return { record, urlToken };
}

/** 当前有效(未过期未撤销)的分享列表,新→旧。只读,不落盘。 */
export function listShares(configPath: string, now: number = Date.now()): ShareRecord[] {
  const shares = loadConfig(configPath).shares ?? [];
  return shares
    .filter((s) => s.expiresAt > now)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** 撤销一条分享(删记录):即刻失效,哪怕令牌尚未过期。找不到抛错。 */
export function revokeShare(configPath: string, id: string): ShareRecord {
  let removed: ShareRecord | undefined;
  mutateConfig(configPath, (config) => {
    const shares = config.shares ?? [];
    removed = shares.find((s) => s.id === id);
    if (!removed) throw new Error('分享不存在(可能已被撤销)');
    config.shares = shares.filter((s) => s.id !== id);
  });
  return removed as ShareRecord;
}

/** 记一次匿名下载(计数 + 最近下载时间);记录已被撤销时静默忽略。 */
export function noteShareDownload(configPath: string, id: string, now: number = Date.now()): void {
  mutateConfig(configPath, (config) => {
    const s = (config.shares ?? []).find((x) => x.id === id);
    if (!s) return false; // 撤销与下载竞态:计数丢了无所谓,不报错
    s.downloads = (s.downloads ?? 0) + 1;
    s.lastDownloadAt = now;
  });
}

export type ShareVerdict =
  | { ok: true; record: ShareRecord }
  | { ok: false; reason: 'malformed' | 'bad-signature' | 'unknown-or-expired' };

/**
 * 校验匿名下载令牌:形态 → 验签(恒定时间)→ 记录在册且未过期未撤销。
 * 全部通过才回 ok;任何一环失败都只回抽象 reason(路由统一渲染 404)。
 */
export function verifyShare(
  configPath: string,
  controlToken: string,
  urlToken: string,
  now: number = Date.now(),
): ShareVerdict {
  const m = TOKEN_RE.exec(urlToken);
  if (!m) return { ok: false, reason: 'malformed' };
  const id = m[1];
  const expiresAt = Number(m[2]);
  const sig = m[3];
  if (id === undefined || sig === undefined || !Number.isFinite(expiresAt) || expiresAt <= 0 || expiresAt <= now) {
    return { ok: false, reason: 'unknown-or-expired' };
  }
  if (!sigMatches(sign(deriveShareKey(controlToken), id, expiresAt), sig)) {
    return { ok: false, reason: 'bad-signature' };
  }
  const record = (loadConfig(configPath).shares ?? []).find((s) => s.id === id);
  // expiresAt 参与签名且必须与记录一致:记录被篡改/重建出不同有效期同样拒
  if (!record || record.expiresAt !== expiresAt) return { ok: false, reason: 'unknown-or-expired' };
  return { ok: true, record };
}
