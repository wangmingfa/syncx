import type { ServerResponse } from 'node:http';
import {
  loadAccount,
  sessionSecret,
  signSession,
  verifySession,
  SESSION_TTL_MS,
  type SessionPayload,
} from '../auth.js';
import { COOKIE_NAME, tokenMatches } from './helpers.js';

/** 会话签名与凭据校验:闭包持有 token 与账号文件路径,由 createControlServer 创建。 */
export interface SessionAuth {
  /** 凭据是否有效:Bearer/cookie 里的值可以是 token 原文,也可以是签名会话。 */
  credentialOk(raw: string | undefined): boolean;
  /** 下发会话 cookie;值恒定是 base64url 签名串,不含分号/空格/非 ASCII。 */
  issueSession(res: ServerResponse, payload: SessionPayload): void;
  /** token 原文是否匹配(令牌登录通道用)。 */
  tokenAccepted(candidate: string | undefined): boolean;
}

export function createSessionAuth(token: string, authFile?: string): SessionAuth {
  /**
   * 会话签名密钥的「基」。
   * - 已设置账号密码 → 用密码哈希:改/清密码即让所有旧会话失效
   * - 未设置 → 用 control.token:未设密码时也能签发会话(值仍是签名串,
   *   而不是把 token 原文塞进 cookie)
   */
  function sessionBase(): string {
    const acct = authFile ? loadAccount(authFile) : undefined;
    return acct ? acct.hash : token;
  }

  /**
   * token 原文是否匹配。空串一律不算通过 —— 否则 token 为空(或请求伪造空 cookie)时
   * 常量时间比较「空 vs 空」恒真,整个控制 API 等于不设防。
   */
  function tokenAccepted(candidate: string | undefined): boolean {
    if (!candidate || !token) return false;
    return tokenMatches(candidate, token);
  }

  function credentialOk(raw: string | undefined): boolean {
    if (!raw) return false;
    if (tokenAccepted(raw)) return true;
    const session = verifySession(raw, sessionSecret(sessionBase()));
    return session !== undefined;
  }

  function issueSession(res: ServerResponse, payload: SessionPayload): void {
    const value = signSession(payload, sessionSecret(sessionBase()));
    res.setHeader(
      'Set-Cookie',
      `${COOKIE_NAME}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    );
  }

  return { credentialOk, issueSession, tokenAccepted };
}
