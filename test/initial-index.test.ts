import { describe, expect, it, vi } from 'vitest';
import { createSyncPeer, type PeerTransport } from '../src/peer.js';
import type { IndexEntry } from '../src/index.js';
import { indexFingerprint } from '../src/index-fingerprint.js';

function entry(path: string, version: Array<[string, number]>, blocks: string[], size = 100): IndexEntry {
  return { path, version: new Map(version), size, deleted: false, blocks };
}

/** 带指纹能力的 transport 替身:记录发出的指纹/全量与表态。 */
function fingerprintingTransport() {
  const sentFull: IndexEntry[][] = [];
  const sentFingerprints: string[] = [];
  const replies: Array<'index-ack' | 'index-request'> = [];
  const transport = {
    sendEntries(entries: IndexEntry[]): void {
      sentFull.push([...entries]);
    },
    sendBlockRequest(): void {},
    sendBlockResponse(): void {},
    sendIndexFingerprint(fp: string): void {
      sentFingerprints.push(fp);
    },
    sendIndexExchangeReply(kind: 'index-ack' | 'index-request'): void {
      replies.push(kind);
    },
  } satisfies PeerTransport;
  return { transport, sentFull, sentFingerprints, replies };
}

function makePeer(
  transport: PeerTransport,
  local: Map<string, IndexEntry>,
  opts: { fallbackMs?: number; onOutcome?: (o: 'skipped' | 'fallback' | 'request-served') => void; e2eKey?: Buffer } = {},
) {
  return createSyncPeer({
    transport,
    localIndex: local,
    executor: null as never,
    readLocalBlock: () => Buffer.from(''),
    deviceId: 'DEV-A',
    initialIndexFallbackMs: opts.fallbackMs,
    onInitialIndexOutcome: opts.onOutcome,
    ...(opts.e2eKey ? { e2eKey: opts.e2eKey } : {}),
  });
}

describe('initial index exchange (fingerprint skip)', () => {
  const local = new Map<string, IndexEntry>([['a.txt', entry('a.txt', [['dev-a', 1]], ['h0'])]]);

  it('sends the fingerprint and skips the full index on ack', () => {
    const { transport, sentFingerprints, sentFull, replies } = fingerprintingTransport();
    const outcomes: string[] = [];
    const peer = makePeer(transport, local, { onOutcome: (o) => outcomes.push(o) });

    peer.beginInitialIndexExchange();
    expect(sentFingerprints).toEqual([indexFingerprint([...local.values()])]);
    expect(sentFull).toEqual([]);

    peer.onIndexAck();
    expect(sentFull).toEqual([]);
    expect(replies).toEqual([]);
    expect(outcomes).toEqual(['skipped']);
  });

  it('serves the full snapshot on index-request', () => {
    const { transport, sentFull } = fingerprintingTransport();
    const outcomes: string[] = [];
    const peer = makePeer(transport, local, { onOutcome: (o) => outcomes.push(o) });

    peer.beginInitialIndexExchange();
    peer.onIndexRequest();
    expect(sentFull).toEqual([[...local.values()]]);
    expect(outcomes).toEqual(['request-served']);
  });

  it('compares an incoming fingerprint against the local index and replies', () => {
    const { transport, replies } = fingerprintingTransport();
    const peer = makePeer(transport, local);

    peer.onIndexFingerprint(indexFingerprint([...local.values()]));
    peer.onIndexFingerprint(indexFingerprint([entry('a.txt', [['dev-a', 9]], ['h0'])]));
    expect(replies).toEqual(['index-ack', 'index-request']);
  });

  it('falls back to the full index when the peer never answers', async () => {
    const { transport, sentFull } = fingerprintingTransport();
    const outcomes: string[] = [];
    const peer = makePeer(transport, local, { fallbackMs: 5, onOutcome: (o) => outcomes.push(o) });

    peer.beginInitialIndexExchange();
    await new Promise((r) => setTimeout(r, 30));
    expect(sentFull).toEqual([[...local.values()]]);
    expect(outcomes).toEqual(['fallback']);
  });

  it('a late ack after the fallback does not send the full index twice', async () => {
    const { transport, sentFull } = fingerprintingTransport();
    const peer = makePeer(transport, local, { fallbackMs: 5 });

    peer.beginInitialIndexExchange();
    await new Promise((r) => setTimeout(r, 30));
    peer.onIndexAck();
    expect(sentFull).toEqual([[...local.values()]]);
  });

  it('dispose cancels the fallback timer', async () => {
    const { transport, sentFull } = fingerprintingTransport();
    const peer = makePeer(transport, local, { fallbackMs: 5 });

    peer.beginInitialIndexExchange();
    peer.dispose();
    await new Promise((r) => setTimeout(r, 30));
    expect(sentFull).toEqual([]);
  });

  it('without fingerprint capability (or on e2e channels) it sends the full index right away', () => {
    const outcomes: string[] = [];
    const plain = {
      sendEntries(entries: IndexEntry[]): void {
        sentFullPlain.push([...entries]);
      },
      sendBlockRequest(): void {},
      sendBlockResponse(): void {},
    } satisfies PeerTransport;
    const sentFullPlain: IndexEntry[][] = [];
    const peer = makePeer(plain, local, { onOutcome: (o) => outcomes.push(o) });
    peer.beginInitialIndexExchange();
    expect(sentFullPlain).toEqual([[...local.values()]]);

    const e2e = fingerprintingTransport();
    const e2ePeer = makePeer(e2e.transport, local, { e2eKey: Buffer.from('k'.repeat(32)) });
    e2ePeer.beginInitialIndexExchange();
    expect(e2e.sentFull).toEqual([[...local.values()]]);
    expect(e2e.sentFingerprints).toEqual([]);
    expect(outcomes).toEqual([]);
  });

  it('dispose is idempotent and begin after dispose is a no-op', () => {
    const { transport, sentFull, sentFingerprints } = fingerprintingTransport();
    const peer = makePeer(transport, local);
    expect(() => {
      peer.dispose();
      peer.dispose();
      peer.beginInitialIndexExchange();
    }).not.toThrow();
    expect(sentFull).toEqual([]);
    expect(sentFingerprints).toEqual([]);
  });
});
