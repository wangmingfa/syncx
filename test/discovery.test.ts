import { describe, expect, it, vi } from 'vitest';
import {
  startDiscovery,
  type MdnsInstance,
  type DiscoveredPeer,
} from '../src/net/discovery.js';
import type { DeviceIdentity } from '../src/identity.js';

const SERVICE = '_syncx._tcp.local';

type AnyFn = (...args: unknown[]) => void;

/** 最小化的假 mDNS,记录 respond/query 调用并可手动触发事件,免去真实组播。 */
class FakeMdns {
  private listeners: Record<string, AnyFn[]> = {};
  responded: unknown[] = [];
  queried: unknown[] = [];
  destroyed = false;

  on(event: string, cb: AnyFn): this {
    (this.listeners[event] ??= []).push(cb);
    return this;
  }
  respond(records: unknown): void {
    this.responded.push(records);
  }
  query(questions: unknown): void {
    this.queried.push(questions);
  }
  destroy(): void {
    this.destroyed = true;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.listeners[event] ?? []) cb(...args);
  }
}

const SELF: DeviceIdentity = { deviceId: 'SELF234567', publicKey: '', privateKey: '' };

function peerResponse(deviceId: string, host: string, port: number) {
  return {
    answers: [
      { name: SERVICE, type: 'TXT', data: Buffer.from(`deviceId=${deviceId}`) },
      { name: SERVICE, type: 'SRV', data: { target: `${host}.`, port } },
    ],
  };
}

describe('mDNS discovery', () => {
  it('advertises on ready and periodically re-advertises + queries for late joiners', () => {
    vi.useFakeTimers();
    const fake = new FakeMdns();
    startDiscovery(SELF, 22000, () => {}, () => fake as unknown as MdnsInstance);

    // 启动即广播一次
    fake.emit('ready');
    expect(fake.responded).toHaveLength(1);

    // 周期(30s)后应再次广播并发起查询,保证后加入节点也能被发现
    vi.advanceTimersByTime(30000);
    expect(fake.responded).toHaveLength(2);
    expect(fake.queried).toHaveLength(1);

    vi.useRealTimers();
  });

  it('reports discovered peers and ignores our own device id', () => {
    const fake = new FakeMdns();
    const found: DiscoveredPeer[] = [];
    startDiscovery(SELF, 22000, (p) => found.push(p), () => fake as unknown as MdnsInstance);
    fake.emit('ready');

    fake.emit('response', peerResponse('PEER234567', 'host', 22000));
    expect(found).toEqual([{ deviceId: 'PEER234567', host: 'host', port: 22000 }]);

    // 自身的广播不应被当成对端
    const before = found.length;
    fake.emit('response', peerResponse('SELF234567', 'self', 22000));
    expect(found).toHaveLength(before);
  });

  it('closes the underlying mDNS socket on close()', () => {
    const fake = new FakeMdns();
    const disc = startDiscovery(SELF, 22000, () => {}, () => fake as unknown as MdnsInstance);
    disc.close();
    expect(fake.destroyed).toBe(true);
  });
});
