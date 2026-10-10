import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';

/**
 * 在网判据:存在**非 internal、非回环**的单播地址 = 有可用的本机接口。
 *
 * 刻意只看接口、不探外网:syncx 是 LAN 同步,「wlan0 还有没有 IP」才是对的信号 ——
 * WiFi 关闭(出门)时接口地址消失,正好是要挂起的形态;而有 IP 没外网(公司网闸、
 * 路由断 WAN)时 LAN 同步照常可用,探外网反而会误挂起。
 *
 * 判据天然跨平台(Windows/macOS/Termux 同一套),探测是纯内存读,搭心跳节拍每 20s
 * 调一次零成本。误判方向是安全的:把「有 IP 但实际不通」判成在线 → 走原有拨号重试,
 * 与旧行为一致;把「真离线」判成在线最坏也就是退回 30s 空转。
 */
export function hasRoutableInterface(
  list: Record<string, NetworkInterfaceInfo[] | undefined> = networkInterfaces(),
): boolean {
  for (const addrs of Object.values(list)) {
    for (const addr of addrs ?? []) {
      if (addr.internal) continue;
      // Node 旧版 family 是数字 4/6,新版是 'IPv4'/'IPv6':归一成大写统一判
      const family = String(addr.family).toUpperCase();
      if (family === 'IPV4' || family === 'IPV6' || family === '4' || family === '6') return true;
    }
  }
  return false;
}
