import { describe, expect, it } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';
import { hasRoutableInterface } from '../src/net/offline-probe.js';
import {
  NETWORK_OFFLINE_BACKOFF_MS,
  offlineAwareReconnectDelay,
  reconnectDelayMs,
} from '../src/args.js';

function iface(family: string, internal = false): NetworkInterfaceInfo {
  return {
    address: internal ? '127.0.0.1' : '192.168.1.2',
    netmask: '255.255.255.0',
    family: family as NetworkInterfaceInfo['family'],
    mac: '00:00:00:00:00:00',
    internal,
  } as NetworkInterfaceInfo;
}

describe('hasRoutableInterface(在网判据)', () => {
  it('only loopback → offline; non-internal IPv4/IPv6 → online', () => {
    expect(hasRoutableInterface({ lo: [iface('IPv4', true)] })).toBe(false);
    expect(hasRoutableInterface({ lo: [iface('IPv4', true)], wlan0: [iface('IPv4')] })).toBe(true);
    expect(hasRoutableInterface({ wlan0: [iface('IPv6')] })).toBe(true);
  });

  it('empty address list (interface down) → offline', () => {
    expect(hasRoutableInterface({ wlan0: [] })).toBe(false);
    expect(hasRoutableInterface({})).toBe(false);
  });

  it('numeric family (legacy Node) is normalized', () => {
    expect(hasRoutableInterface({ wlan0: [iface('4')] })).toBe(true);
    expect(hasRoutableInterface({ wlan0: [iface('6')] })).toBe(true);
    expect(hasRoutableInterface({ wlan0: [iface('unknown')] })).toBe(false);
  });
});

describe('offlineAwareReconnectDelay(无网退避)', () => {
  it('online: passthrough of the exponential backoff', () => {
    expect(offlineAwareReconnectDelay(reconnectDelayMs(0), true)).toBe(0);
    expect(offlineAwareReconnectDelay(reconnectDelayMs(1), true)).toBe(1000);
    expect(offlineAwareReconnectDelay(reconnectDelayMs(9), true)).toBe(30000);
  });

  it('offline: floored at NETWORK_OFFLINE_BACKOFF_MS, never shortened', () => {
    expect(offlineAwareReconnectDelay(0, false)).toBe(NETWORK_OFFLINE_BACKOFF_MS);
    expect(offlineAwareReconnectDelay(30000, false)).toBe(NETWORK_OFFLINE_BACKOFF_MS);
    expect(offlineAwareReconnectDelay(400000, false)).toBe(400000);
  });
});
