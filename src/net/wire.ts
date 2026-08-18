import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { IndexEntry } from '../index.js';
import type { BlockRequest, BlockResponse } from '../messages.js';
import { encodeIndex, decodeIndex } from '../messages.js';
import type { PeerTransport, SyncPeer } from '../peer.js';

export type WireMessage =
  | { type: 'index'; folder: string; payload: string }
  | { type: 'block-request'; folder: string; payload: BlockRequest }
  | { type: 'block-response'; folder: string; payload: Omit<BlockResponse, 'data'> & { data: string } };

export function encodeWireMessage(message: WireMessage): string {
  return JSON.stringify(message);
}

export function decodeWireMessage(raw: string): WireMessage {
  return JSON.parse(raw) as WireMessage;
}

/** AES-256-GCM 加密一条消息,输出携带 iv/tag 的 JSON 字符串。 */
export function encryptMessage(key: Buffer, message: WireMessage): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(encodeWireMessage(message), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    type: 'enc',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: enc.toString('base64'),
  });
}

export function decryptMessage(key: Buffer, raw: string): WireMessage {
  const msg = JSON.parse(raw) as { type: string; iv: string; tag: string; data: string };
  if (msg.type !== 'enc') {
    throw new Error('expected encrypted message');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(msg.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(msg.tag, 'base64'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(msg.data, 'base64')),
    decipher.final(),
  ]);
  return decodeWireMessage(plain.toString('utf8'));
}

/**
 * Send-side transport bound to one shared folder: every message carries
 * the folder path so a single socket can multiplex several folders.
 */
export function makePeerTransport(socket: WebSocket, key: Buffer, folderPath: string): PeerTransport {
  return {
    sendEntries(entries: IndexEntry[]): void {
      socket.send(
        encryptMessage(key, {
          type: 'index',
          folder: folderPath,
          payload: encodeIndex(entries).toString('base64'),
        }),
      );
    },
    sendBlockRequest(request: BlockRequest): void {
      socket.send(encryptMessage(key, { type: 'block-request', folder: folderPath, payload: request }));
    },
    sendBlockResponse(response: BlockResponse): void {
      socket.send(
        encryptMessage(key, {
          type: 'block-response',
          folder: folderPath,
          payload: { ...response, data: response.data.toString('base64') },
        }),
      );
    },
  };
}

/**
 * Receive-side dispatcher: decrypts incoming wire messages and routes each
 * message to the SyncPeer registered for its folder.
 */
export function attachPeerMessages(peers: Map<string, SyncPeer>, socket: WebSocket, key: Buffer): void {
  socket.on('message', (data) => {
    const raw = data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data as Buffer);
    let message: WireMessage;
    try {
      message = decryptMessage(key, raw.toString('utf8'));
    } catch {
      return; // 解密/认证失败(篡改或噪声),忽略
    }
    const peer = peers.get(message.folder);
    if (!peer) return;
    switch (message.type) {
      case 'index':
        void peer.onPeerIndex(decodeIndex(Buffer.from(message.payload, 'base64')));
        break;
      case 'block-request':
        peer.onBlockRequest(message.payload);
        break;
      case 'block-response':
        void peer.onBlockResponse({
          ...message.payload,
          data: Buffer.from(message.payload.data, 'base64'),
        });
        break;
    }
  });
}
