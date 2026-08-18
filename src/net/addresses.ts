import { networkInterfaces } from 'node:os';

export interface LanAddress {
  address: string;
  family: 'IPv4' | 'IPv6';
}

/**
 * Enumerate all non-internal (non-loopback) IPv4 addresses of this host.
 * IPv6 addresses are deliberately excluded: they are rarely routable in a
 * LAN and clutter the startup log.
 */
export function getLanAddresses(): LanAddress[] {
  const result: LanAddress[] = [];
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.internal) continue;
      if (iface.family !== 'IPv4') continue;
      result.push({ address: iface.address, family: 'IPv4' });
    }
  }
  return result;
}

/** Format an address for use in a URL (IPv6 needs brackets). */
export function formatHost(address: string, family: 'IPv4' | 'IPv6'): string {
  return family === 'IPv6' ? `[${address}]` : address;
}
