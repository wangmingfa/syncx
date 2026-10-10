import { describe, expect, it } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';
import { isSelfPeerUrl, localInterfaceAddresses } from '../src/net/peer-address.js';

function iface(address: string, internal = false): NetworkInterfaceInfo {
  return { address, family: 'IPv4', internal } as NetworkInterfaceInfo;
}

describe('localInterfaceAddresses', () => {
  it('collects non-internal hosts, lowercased and IPv4-mapped stripped', () => {
    const set = localInterfaceAddresses({
      lo: [iface('127.0.0.1', true), iface('::1', true)],
      wlan0: [iface('10.13.17.178'), iface('FE80::1')],
      veth: [iface('::ffff:172.25.48.48')],
      gone: undefined,
    });
    expect([...set].sort()).toEqual(['10.13.17.178', '172.25.48.48', 'fe80::1']);
    expect(set.has('127.0.0.1')).toBe(false);
  });
});

describe('isSelfPeerUrl(自拨判定)', () => {
  const local = new Set(['172.25.48.48', '10.13.17.178']);

  it('hits only host AND own port together', () => {
    expect(isSelfPeerUrl('ws://172.25.48.48:22000', local, 22000)).toBe(true);
    // 同机另一实例(不同端口)是合法对端,不能被掐
    expect(isSelfPeerUrl('ws://172.25.48.48:22001', local, 22000)).toBe(false);
    expect(isSelfPeerUrl('ws://10.13.17.178:22000', local, 22000)).toBe(true);
    expect(isSelfPeerUrl('ws://10.13.17.99:22000', local, 22000)).toBe(false);
  });

  it('never flags loopback/localhost (deliberate same-machine second instance)', () => {
    expect(isSelfPeerUrl('ws://localhost:22000', local, 22000)).toBe(false);
    expect(isSelfPeerUrl('ws://127.0.0.1:22000', local, 22000)).toBe(false);
  });

  it('normalizes IPv4-mapped and case before comparing', () => {
    expect(isSelfPeerUrl('ws://[::FFFF:172.25.48.48]:22000', local, 22000)).toBe(true);
    expect(isSelfPeerUrl('ws://172.25.48.48:22000', new Set(['172.25.48.48']), 22000)).toBe(true);
  });

  it('malformed or missing port never matches', () => {
    expect(isSelfPeerUrl('ws://172.25.48.48', local, 22000)).toBe(false);
    expect(isSelfPeerUrl('http://172.25.48.48:22000', local, 22000)).toBe(false);
    expect(isSelfPeerUrl('', local, 22000)).toBe(false);
  });
});
