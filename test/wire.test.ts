import { describe, expect, it } from 'vitest';
import { encryptMessage, decryptMessage, type WireMessage } from '../src/net/wire.js';

const key = Buffer.from('0123456789abcdef0123456789abcdef'); // 32 字节 AES-256

describe('wire message encryption', () => {
  it('round-trips an index message', () => {
    const msg: WireMessage = { type: 'index', folder: 'main', payload: 'aGk=' };
    expect(decryptMessage(key, encryptMessage(key, msg))).toEqual(msg);
  });

  it('round-trips block-request and block-response messages', () => {
    const req: WireMessage = {
      type: 'block-request',
      folder: 'main',
      payload: { deviceId: 'DEV-A', path: 'a.txt', blockIndex: 0, hash: 'h1' },
    };
    expect(decryptMessage(key, encryptMessage(key, req))).toEqual(req);

    const resp: WireMessage = {
      type: 'block-response',
      folder: 'main',
      payload: {
        deviceId: 'DEV-A',
        path: 'a.txt',
        blockIndex: 0,
        hash: 'h1',
        data: 'aGVsbG8=',
      },
    };
    expect(decryptMessage(key, encryptMessage(key, resp))).toEqual(resp);
  });

  it('produces distinct ciphertexts for the same plaintext (random iv)', () => {
    const msg: WireMessage = { type: 'index', folder: 'main', payload: 'aGk=' };
    expect(encryptMessage(key, msg)).not.toBe(encryptMessage(key, msg));
  });

  it('fails to decrypt with the wrong key', () => {
    const other = Buffer.from('fedcba9876543210fedcba9876543210');
    const cipher = encryptMessage(key, { type: 'index', folder: 'main', payload: 'aGk=' });
    expect(() => decryptMessage(other, cipher)).toThrow();
  });

  it('rejects unencrypted (plaintext) wire input', () => {
    expect(() => decryptMessage(key, '{"type":"index","folder":"main","payload":"aGk="}')).toThrow(
      'expected encrypted',
    );
  });
});
