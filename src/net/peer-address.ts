import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { normalizePeerUrl } from '../config.js';

/** 本机所有**非 internal**(即真实网卡上)的单播地址,小写、已剥 IPv4-mapped 前缀。 */
export function localInterfaceAddresses(
  list: Record<string, NetworkInterfaceInfo[] | undefined> = networkInterfaces(),
): Set<string> {
  const out = new Set<string>();
  for (const addrs of Object.values(list)) {
    for (const addr of addrs ?? []) {
      if (addr.internal) continue;
      out.add(normalizeHost(addr.address));
    }
  }
  return out;
}

function normalizeHost(host: string): string {
  const h = host.toLowerCase();
  return h.startsWith('::ffff:') ? h.slice('::ffff:'.length) : h;
}

/**
 * 这条 peers 条目是不是「拨自己」:host 命中本机网卡地址**且端口就是本机 peer 端口**。
 *
 * 端口必须一起判,否则会误杀合法拓扑:同一台机器跑两个 syncx 实例(不同 config 目录、
 * 不同 device.key)各占一个端口,例如 `ws://192.168.1.5:22000` 是本机、
 * `ws://192.168.1.5:22001` 是同机另一个实例 —— 只看 host 会把后者也跳掉。
 * 回环地址(internal)不在集合里,所以用户手写的 `ws://localhost:22000` 不会被误判:
 * 那通常是刻意连本机另一实例。
 */
export function isSelfPeerUrl(url: string, local: Set<string>, selfPort: number): boolean {
  const normalized = normalizePeerUrl(url);
  const m = /^ws:\/\/\[([^\]]+)\]:(\d+)$|^ws:\/\/([^[\]:]+):(\d+)$/i.exec(normalized);
  if (!m) return false;
  const host = normalizeHost(m[1] ?? m[3] ?? '');
  const port = Number(m[2] ?? m[4]);
  return port === selfPort && host !== '' && local.has(host);
}
