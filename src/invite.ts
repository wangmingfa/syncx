import { sign, verify } from 'node:crypto';
import type { DeviceIdentity } from './identity.js';

/** 邀请码有效期:1 小时。 */
export const INVITE_TTL_MS = 60 * 60 * 1000;

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
 * 解析并校验邀请码:签名必须匹配携带的公钥、不得过期,否则抛错。
 */
export function parseInviteCode(code: string, now = Date.now()): InvitePayload {
  if (typeof code !== 'string' || code === '') throw new Error('invalid invitation code');
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
