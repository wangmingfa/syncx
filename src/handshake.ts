import { createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, sign, verify } from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Derive the 10-character Device ID from an Ed25519 public key (PEM):
 * sha256 of the key, first 6 bytes, base32-encoded.
 */
export function deriveDeviceIdFromPublicKey(publicKeyPem: string): string {
  const hash = createHash('sha256').update(publicKeyPem).digest();
  let value = 0n;
  for (let i = 0; i < 6; i++) {
    value = (value << 8n) | BigInt(hash[i]!);
  }
  let out = '';
  for (let i = 0; i < 10; i++) {
    out = BASE32[Number(value & 31n)]! + out;
    value >>= 5n;
  }
  return out;
}

export function signChallenge(privateKeyPem: string, challenge: Buffer): Buffer {
  return sign(null, challenge, privateKeyPem);
}

export function verifyChallenge(
  publicKeyPem: string,
  challenge: Buffer,
  signature: Buffer,
): boolean {
  return verify(null, challenge, publicKeyPem, signature);
}

/** 一次会话的 X25519 临时密钥对(PEM)。 */
export interface X25519KeyPair {
  publicKeyPem: string;
  privateKeyPem: string;
}

export function generateX25519KeyPair(): X25519KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}

/** X25519 公钥的 DER 字节,用作签名对象(保证 kx 消息与设备身份绑定)。 */
export function x25519PublicDer(publicKeyPem: string): Buffer {
  return createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' }) as Buffer;
}

/** ECDH 协商会话密钥(sha256 派生 32 字节,AES-256-GCM 用)。 */
export function deriveSessionKey(privateKeyPem: string, peerPublicKeyPem: string): Buffer {
  const shared = diffieHellman({
    privateKey: createPrivateKey(privateKeyPem),
    publicKey: createPublicKey(peerPublicKeyPem),
  });
  return createHash('sha256').update(shared).digest();
}

/** 握手第二阶段的密钥交换消息:携带 X25519 公钥及其 Ed25519 签名。 */
export interface KxMessage {
  type: 'kx';
  /** base64 编码的 X25519 公钥 DER */
  x25519: string;
  /** base64 编码的 Ed25519 签名(对 x25519 DER 字节签名) */
  sig: string;
}

export function encodeKxMessage(kx: KxMessage): string {
  return JSON.stringify(kx);
}

export function decodeKxMessage(raw: string): KxMessage {
  return JSON.parse(raw) as KxMessage;
}

/**
 * 构造并签名一个 kx 消息:用设备 Ed25519 私钥绑定本次会话的 X25519 公钥,
 * 防止中间人替换密钥。
 */
export function buildKxMessage(
  x25519Pair: X25519KeyPair,
  ed25519PrivateKeyPem: string,
): KxMessage {
  const der = x25519PublicDer(x25519Pair.publicKeyPem);
  return {
    type: 'kx',
    x25519: der.toString('base64'),
    sig: signChallenge(ed25519PrivateKeyPem, der).toString('base64'),
  };
}

/** 验证对端的 kx 消息:签名必须由对端 Ed25519 公钥签发。返回 X25519 公钥 PEM。 */
export function verifyKxMessage(kx: KxMessage, ed25519PublicKeyPem: string): string {
  const der = Buffer.from(kx.x25519, 'base64');
  if (!verifyChallenge(ed25519PublicKeyPem, der, Buffer.from(kx.sig, 'base64'))) {
    throw new Error('invalid key exchange signature');
  }
  return createPublicKey({ key: der, type: 'spki', format: 'der' }).export({
    type: 'spki',
    format: 'pem',
  }) as string;
}
