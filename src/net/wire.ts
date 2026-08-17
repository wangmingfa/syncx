import type { WebSocket } from 'ws';
import type { IndexEntry } from '../index.js';
import type { BlockRequest, BlockResponse } from '../messages.js';
import { encodeIndex, decodeIndex } from '../messages.js';
import type { PeerTransport, SyncPeer } from '../peer.js';

export type WireMessage =
  | { type: 'index'; payload: string }
  | { type: 'block-request'; payload: BlockRequest }
  | { type: 'block-response'; payload: Omit<BlockResponse, 'data'> & { data: string } };

export function encodeWireMessage(message: WireMessage): string {
  return JSON.stringify(message);
}

export function decodeWireMessage(raw: string): WireMessage {
  return JSON.parse(raw) as WireMessage;
}

/** Send-side transport that serializes messages onto a socket. */
export function makePeerTransport(socket: WebSocket): PeerTransport {
  return {
    sendEntries(entries: IndexEntry[]): void {
      socket.send(
        encodeWireMessage({
          type: 'index',
          payload: encodeIndex(entries).toString('base64'),
        }),
      );
    },
    sendBlockRequest(request: BlockRequest): void {
      socket.send(encodeWireMessage({ type: 'block-request', payload: request }));
    },
    sendBlockResponse(response: BlockResponse): void {
      socket.send(
        encodeWireMessage({
          type: 'block-response',
          payload: { ...response, data: response.data.toString('base64') },
        }),
      );
    },
  };
}

/** Receive-side dispatcher that feeds incoming wire messages to a peer. */
export function attachPeerMessages(peer: SyncPeer, socket: WebSocket): void {
  socket.on('message', (data) => {
    const raw = data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data as Buffer);
    const message = decodeWireMessage(raw.toString('utf8'));
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
