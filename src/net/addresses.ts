import type { WebSocket } from 'ws';

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

/**
 * 由入站 socket 的对端源 IP + 握手 kx 中广播的监听端口,拼出可反向连接的
 * ws:// 地址。@types/ws 未暴露 remoteAddress,故对 ws 实例做防御性读取
 * (优先 socket.remoteAddress,回退底层 _socket.remoteAddress)。IPv6 自动加方括号。
 * 端口非法或缺失时返回 undefined(旧版对端不广播端口,则无法反向发现)。
 *
 * 地址规范化:剥离 IPv4-mapped IPv6 前缀(::ffff:a.b.c.d → a.b.c.d)。
 * peer server 默认双栈监听(::),IPv4 对端连入时 OS 会套这层壳,
 * 否则会存成 ws://[::ffff:a.b.c.d]:port —— 既丑又无法与手动填的纯 IPv4
 * (ws://a.b.c.d:port) 去重,污染 config.peers。
 */
export function learnPeerUrl(socket: WebSocket, listenPort?: number): string | undefined {
  if (typeof listenPort !== 'number' || listenPort <= 0 || listenPort > 65535) return undefined;
  const anySock = socket as unknown as {
    remoteAddress?: string;
    _socket?: { remoteAddress?: string };
  };
  let addr = anySock.remoteAddress ?? anySock._socket?.remoteAddress;
  if (!addr) return undefined;
  // 去方括号
  if (addr.startsWith('[') && addr.endsWith(']')) addr = addr.slice(1, -1);
  // 还原 IPv4-mapped IPv6 地址(::ffff:a.b.c.d → a.b.c.d)
  if (addr.startsWith('::ffff:')) addr = addr.slice('::ffff:'.length);
  // 仅真正的 IPv6(仍含冒号)才加方括号
  const host = addr.includes(':') && !addr.startsWith('[') ? `[${addr}]` : addr;
  return `ws://${host}:${listenPort}`;
}
