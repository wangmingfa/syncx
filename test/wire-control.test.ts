import { describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  encryptMessage,
  decryptMessage,
  sendControlMessage,
  attachPeerMessages,
  type ControlMessage,
} from '../src/net/wire.js';
import { encodeIndex } from '../src/messages.js';

/** 最小 WebSocket mock:记录 send 内容,允许手动 emit 'message'。 */
class MockSocket {
  public sent: string[] = [];
  private handlers: Record<string, (data: unknown) => void> = {};
  send(data: string): void {
    this.sent.push(data);
  }
  on(event: string, cb: (data: unknown) => void): void {
    this.handlers[event] = cb;
  }
  emit(data: unknown): void {
    this.handlers['message']?.(data);
  }
}

/** 最小 SyncPeer mock,用于验证 folder 路由不被 control 消息误触发。 */
function mockPeer() {
  return {
    onPeerIndex: vi.fn(),
    onBlockRequest: vi.fn(),
    onBlockResponse: vi.fn(),
  };
}

describe('control message wire channel (Phase 2)', () => {
  const key = randomBytes(32);

  it('sendControlMessage encrypts a control payload that round-trips', () => {
    const socket = new MockSocket();
    const msg: ControlMessage = {
      kind: 'folder-invitation',
      offerId: 'f1',
      fromDeviceId: 'DEVB',
      folderId: 'main',
      folderName: 'main',
    };
    sendControlMessage(socket, key, msg);
    expect(socket.sent).toHaveLength(1);
    const decoded = decryptMessage(key, socket.sent[0]);
    expect(decoded).toEqual({ type: 'control', payload: msg });
  });

  it('attachPeerMessages routes control messages to onControl and NOT to folder peers', () => {
    const socket = new MockSocket();
    const peer = mockPeer();
    const peers = new Map([['main', peer]]);
    const onControl = vi.fn();
    attachPeerMessages(peers, socket as never, key, onControl);

    // 推送一条 control 消息(pairing-request)
    const ctrl = encryptMessage(key, {
      type: 'control',
      payload: { kind: 'pairing-request', offerId: 'o1', fromDeviceId: 'DEVA' } as ControlMessage,
    });
    socket.emit(ctrl);

    expect(onControl).toHaveBeenCalledTimes(1);
    expect(onControl).toHaveBeenCalledWith({ kind: 'pairing-request', offerId: 'o1', fromDeviceId: 'DEVA' });
    // control 消息绝不应落到 folder 的 peer 处理链
    expect(peer.onPeerIndex).not.toHaveBeenCalled();
    expect(peer.onBlockRequest).not.toHaveBeenCalled();
  });

  it('attachPeerMessages still routes index/block messages to the folder peer (not onControl)', () => {
    const socket = new MockSocket();
    const peer = mockPeer();
    const peers = new Map([['main', peer]]);
    const onControl = vi.fn();
    attachPeerMessages(peers, socket as never, key, onControl);

    const idxPayload = encodeIndex([
      { path: 'a.txt', version: new Map([['DEVA', 1]]), size: 1, deleted: false, blocks: ['h'] },
    ]).toString('base64');
    const idx = encryptMessage(key, { type: 'index', folder: 'main', payload: idxPayload });
    socket.emit(idx);

    expect(peer.onPeerIndex).toHaveBeenCalledTimes(1);
    // 普通 folder 消息不应触发 control 回调
    expect(onControl).not.toHaveBeenCalled();
  });

  it('malformed/tampered messages are silently ignored (no throw, no onControl)', () => {
    const socket = new MockSocket();
    const peer = mockPeer();
    const peers = new Map([['main', peer]]);
    const onControl = vi.fn();
    attachPeerMessages(peers, socket as never, key, onControl);

    socket.emit('not-valid-json');
    socket.emit(encryptMessage(key, { type: 'index', folder: 'main', payload: 'x' }) + '.tampered');

    expect(onControl).not.toHaveBeenCalled();
    expect(peer.onPeerIndex).not.toHaveBeenCalled();
  });
});
