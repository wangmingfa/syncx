import { sign, verify } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DeviceIdentity } from './identity.js';

/** 邀请码有效期:1 小时。 */
export const INVITE_TTL_MS = 60 * 60 * 1000;

/** 邀请码吊销列表文件:每行一个已吊销的邀请码。 */
function revokeFilePath(configDir: string): string {
  return join(configDir, 'revoked-invites.txt');
}

/** 吊销一个邀请码:追加到吊销列表。已吊销的邀请码在 parseInviteCode 时会被拒绝。 */
export function revokeInviteCode(configDir: string, code: string): void {
  const file = revokeFilePath(configDir);
  const existing = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
  const lines = existing ? existing.split('\n') : [];
  if (!lines.includes(code)) {
    lines.push(code);
    writeFileSync(file, lines.join('\n') + '\n');
  }
}

/** 检查邀请码是否已被吊销。 */
export function isInviteRevoked(configDir: string, code: string): boolean {
  const file = revokeFilePath(configDir);
  if (!existsSync(file)) return false;
  const content = readFileSync(file, 'utf8').trim();
  if (!content) return false;
  return content.split('\n').includes(code);
}

export interface InvitePayload {
  deviceId: string;
  publicKey: string;
  folder: string;
  ts: number;
}

/**
 * 生成一次性邀请码:`base64url(payloadJSON.sig)`。邀请方用自己的 Ed25519
 * 私钥对 payload 签名,对端验签后即可信任其 deviceId/公钥绑定关系。
 */
export function createInviteCode(
  identity: DeviceIdentity,
  folder: string,
  now = Date.now(),
): string {
  const payload: InvitePayload = {
    deviceId: identity.deviceId,
    publicKey: identity.publicKey,
    folder,
    ts: now,
  };
  const payloadJson = JSON.stringify(payload);
  const sig = sign(null, Buffer.from(payloadJson, 'utf8'), identity.privateKey).toString('base64');
  return Buffer.from(JSON.stringify({ payload: payloadJson, sig })).toString('base64url');
}

/**
 * 解析并校验邀请码:签名必须匹配携带的公钥、不得过期、不得被吊销,否则抛错。
 * configDir 用于检查吊销列表;不传则跳过吊销校验。
 */
export function parseInviteCode(code: string, configDir?: string, now = Date.now()): InvitePayload {
  if (typeof code !== 'string' || code === '') throw new Error('invalid invitation code');
  if (configDir && isInviteRevoked(configDir, code)) {
    throw new Error('invitation revoked');
  }
  let parsed: { payload: string; sig: string };
  try {
    parsed = JSON.parse(Buffer.from(code, 'base64url').toString('utf8'));
  } catch {
    throw new Error('invalid invitation code');
  }
  if (!parsed || typeof parsed.payload !== 'string' || typeof parsed.sig !== 'string') {
    throw new Error('invalid invitation code');
  }

  let payload: InvitePayload;
  try {
    payload = JSON.parse(parsed.payload) as InvitePayload;
  } catch {
    throw new Error('invalid invitation code');
  }
  if (
    typeof payload.deviceId !== 'string' ||
    typeof payload.publicKey !== 'string' ||
    typeof payload.folder !== 'string' ||
    typeof payload.ts !== 'number'
  ) {
    throw new Error('invalid invitation code');
  }

  if (!verify(null, Buffer.from(parsed.payload, 'utf8'), payload.publicKey, Buffer.from(parsed.sig, 'base64'))) {
    throw new Error('invalid invitation signature');
  }
  if (now - payload.ts > INVITE_TTL_MS) {
    throw new Error('invitation expired');
  }
  return payload;
}
