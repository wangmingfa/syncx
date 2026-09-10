import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { IndexEntry } from '../index.js';
import type { BlockRequest, BlockResponse } from '../messages.js';
import { encodeIndex, decodeIndex } from '../messages.js';
import type { PeerTransport, SyncPeer } from '../peer.js';
import { RateLimiter } from '../ratelimit.js';

export type WireMessage =
  | { type: 'index'; folder: string; payload: string }
  | { type: 'block-request'; folder: string; payload: BlockRequest }
  | { type: 'block-response'; folder: string; payload: Omit<BlockResponse, 'data'> & { data: string } }
  | { type: 'control'; payload: ControlMessage };

/**
 * 与同步数据无关的「控制面」消息:设备配对请求 与 目录共享邀请,
 * 以及对方的确认回执。它们不绑定某个共享目录,故走独立的 control 通道,
 * 由接收方路由到一个全局处理器(而非按 folder 找 SyncPeer)。
 */
export type ControlMessage =
  | { kind: 'folder-invitation'; offerId: string; fromDeviceId: string; folderId: string; folderName: string }
  | { kind: 'folder-invitation-ack'; offerId: string; fromDeviceId: string; accepted: boolean }
  | { kind: 'pairing-request'; offerId: string; fromDeviceId: string }
  | { kind: 'pairing-ack'; offerId: string; fromDeviceId: string; accepted: boolean }
  /** 会话建立与共享关系变更时互发的「本机当前与你在同步的目录清单」,
   *  接收方据此在 UI 上区分设备标签的 同步中 / 已停止共享 状态。
   *  pendingFolderIds:本机仍待确认的、来自对方的目录邀请 id 集合,
   *  对方据此把标签显示为「待对方确认」而非误判「已停止共享」。
   *  旧版本对端不发送该字段(undefined),接收方按未知处理,退回旧逻辑。 */
  | { kind: 'folder-sync-list'; fromDeviceId: string; folderIds: string[]; pendingFolderIds?: string[] }
  /** 会话建立时互发的版本宣告。dev 态(src 直跑)version 为 'dev'。
   *  hostname 为本机 node:os 主机名,供对端在设备卡 / 配对 / 共享邀请上展示来源主机,
   *  旧版本对端不发送该字段,接收方按 undefined 处理(不展示主机名)。 */
  | { kind: 'hello'; fromDeviceId: string; version: string; hostname?: string }
  /** 请求对端的自身安装包(tgz,整包),用于「版本低于对方时从对方升级」。
   *  仅经握手签名校验过的会话可发;对端 dev 态时 response.data 为 undefined。 */
  | { kind: 'self-binary-request'; requestId: string; fromDeviceId: string }
  /** 对端安装包回传:base64 的整包 tgz(含 package.json 与 dist/syncx.js)+ 内容
   *  sha256 指纹;data 缺省 = 对端无法提供(dev 态或打包失败)。 */
  | { kind: 'self-binary-response'; requestId: string; fromDeviceId: string; version: string; sha256: string; data?: string };

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
export function makePeerTransport(
  socket: WebSocket,
  key: Buffer,
  folderPath: string,
  rateLimiter?: RateLimiter,
): PeerTransport {
  const limiter = rateLimiter ?? new RateLimiter(0);
  // 串行化限速发送:队列中每条消息都等待前一条消耗完令牌后再计算等待,
  // 避免多条消息基于同一令牌快照同时醒来,造成约 2 倍速率的突发发送。
  let sendQueue: Promise<void> = Promise.resolve();

  /** 按限速发送一条消息:令牌不足时排队等待,等待后重新评估并消耗令牌。 */
  function sendRateLimited(data: string): void {
    const bytes = Buffer.byteLength(data);
    sendQueue = sendQueue
      .then(async () => {
        const wait = limiter.waitTime(bytes);
        if (wait > 0) {
          await new Promise((resolve) => setTimeout(resolve, wait));
        }
        // 等待后重新评估并消耗令牌;超大消息(超过桶容量)无法一次消耗,
        // 清空桶后照常发送,避免其完全绕过限速。
        if (!limiter.tryConsume(bytes)) {
          limiter.drain();
        }
        socket.send(data);
      })
      .catch(() => {
        // socket 可能在排队期间已关闭;忽略发送失败,后续消息不受影响
      });
  }

  return {
    sendEntries(entries: IndexEntry[]): void {
      sendRateLimited(
        encryptMessage(key, {
          type: 'index',
          folder: folderPath,
          payload: encodeIndex(entries).toString('base64'),
        }),
      );
    },
    sendBlockRequest(request: BlockRequest): void {
      sendRateLimited(encryptMessage(key, { type: 'block-request', folder: folderPath, payload: request }));
    },
    sendBlockResponse(response: BlockResponse): void {
      sendRateLimited(
        encryptMessage(key, {
          type: 'block-response',
          folder: folderPath,
          payload: { ...response, data: response.data.toString('base64') },
        }),
      );
    },
  };
}

/** 经已建立的会话密钥,发送一条 control 控制面消息(不绑定任何目录)。 */
export function sendControlMessage(socket: WebSocket, key: Buffer, message: ControlMessage): void {
  socket.send(encryptMessage(key, { type: 'control', payload: message }));
}

/**
 * Receive-side dispatcher: decrypts incoming wire messages and routes each
 * message to the SyncPeer registered for its folder. `control` 类型的消息
 * (配对请求 / 目录共享邀请 / 确认回执)路由到 onControl,不经过 folder 路由。
 */
export function attachPeerMessages(
  peers: Map<string, SyncPeer>,
  socket: WebSocket,
  key: Buffer,
  onControl?: (message: ControlMessage) => void,
): void {
  socket.on('message', (data) => {
    const raw = data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data as Buffer);
    let message: WireMessage;
    try {
      message = decryptMessage(key, raw.toString('utf8'));
    } catch {
      return; // 解密/认证失败(篡改或噪声),忽略
    }
    if (message.type === 'control') {
      onControl?.(message.payload);
      return;
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
