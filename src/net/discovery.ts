import multicastDNS, { type ResponsePacket } from 'multicast-dns';
import { hostname } from 'node:os';
import type { RemoteInfo } from 'node:dgram';
import type { DeviceIdentity } from '../identity.js';
import { deriveDeviceIdFromPublicKey } from '../handshake.js';

const SERVICE = '_syncx._tcp.local';

export interface DiscoveredPeer {
  deviceId: string;
  /** SRV target —— 对端 `hostname()` 的裸值(不带 .local 后缀),不保证可解析。 */
  host: string;
  port: number;
  /**
   * 收到这个 mDNS 包的**源 IP**(组播 socket 的 rinfo.address),即对端实际发包用的地址。
   *
   * 刻意不从 SRV target 去解析、也不要求对端在广播里附 A 记录:
   *  - 附 A 记录要改 advertise(),而且只对同样升级过的对端有效;
   *  - 解析 `xxx.local` 依赖本机 mDNS 解析器(Windows 10+ 有,Termux / 无 avahi 的
   *    Linux 没有),失败时还会卡几秒;
   *  - 而 rinfo 是白捡的,并且语义更准:它就是「这台机器此刻 reachable 的地址」,
   *    A 记录反而可能列出好几个(含不在本网段的)。
   *
   * 可选是因为注入的假 mdns(测试)可以不传第二个参数。
   */
  address?: string;
}

export interface DiscoveryOptions {
  /**
   * 在网门控:返回 false 时**暂停**周期性的 advertise + query(无网省电,移动端
   * 关 WiFi 后组播发不出去还照样烧电)。恢复由上层在状态翻转时调用 kick() 立即
   * 补一轮,不依赖下一个 30s tick。缺省(未提供)= 永远在线,行为与旧版一致。
   */
  isOnline?: () => boolean;
}

export interface Discovery {
  close(): void;
  /** 立即补一轮 advertise + query(网络恢复时调用;ready 之前调用是空操作)。 */
  kick(): void;
}

/** mDNS 实例类型( multicast-dns 默认导出的返回值)。便于测试时注入假对象。 */
export type MdnsInstance = ReturnType<typeof multicastDNS>;

/**
 * 解析 mDNS TXT 记录的 data。
 * dns-packet 的 TXT 解码结果在真实环境下是 `Buffer[]`(每段一段文本),
 * 而旧版本 / 测试假对象可能是单个 Buffer 或字符串。统一归一化为字符串。
 */
function decodeTxtData(data: unknown): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) {
    return data
      .map((part) => (Buffer.isBuffer(part) ? part.toString('utf8') : String(part)))
      .join('');
  }
  if (typeof data === 'string') return data;
  return '';
}

/**
 * Thin mDNS discovery: advertises this device (deviceId derived from the
 * public key, service port in SRV), and reports peers that advertise the
 * same service. Advertisement is refreshed periodically and we also query
 * for the service, so a daemon that starts after peers are already running
 * still discovers them (a one-shot announce would miss late joiners).
 *
 * `createMdns` 可注入(默认新建真实 mDNS 实例),便于在测试中替换假实现。
 */
export function startDiscovery(
  identity: DeviceIdentity,
  port: number,
  onPeerFound: (peer: DiscoveredPeer) => void,
  createMdns: () => MdnsInstance = multicastDNS,
  opts: DiscoveryOptions = {},
): Discovery {
  const mdns = createMdns();
  let timer: ReturnType<typeof setInterval> | undefined;

  const advertise = (): void => {
    mdns.respond({
      answers: [
        {
          name: SERVICE,
          type: 'SRV',
          ttl: 120,
          data: {
            priority: 0,
            weight: 0,
            port,
            target: hostname(),
          },
        },
        {
          name: SERVICE,
          type: 'TXT',
          ttl: 120,
          data: Buffer.from(`deviceId=${identity.deviceId}`),
        },
      ],
    });
  };

  const announceAndQuery = (): void => {
    advertise();
    mdns.query([
      { name: SERVICE, type: 'SRV' },
      { name: SERVICE, type: 'TXT' },
    ]);
  };

  mdns.on('ready', () => {
    // 启动只广播不查询(保持既有语义):发起查询是周期 tick 的事,恢复补发走 kick()
    advertise();
    // 周期重播并主动查询:保证后加入节点既能被发现,也能发现已运行的节点
    timer = setInterval(() => {
      // 无网门控:WiFi 关闭时组播既发不出去也收不到,白烧电(移动端尤甚);
      // 恢复由上层调 kick() 立即补一轮,不等到下一个 tick
      if (opts.isOnline && !opts.isOnline()) return;
      announceAndQuery();
    }, 30000);
  });

  mdns.on('response', (response: ResponsePacket, rinfo?: RemoteInfo) => {
    const txt = response.answers.find((a) => a.type === 'TXT' && a.name === SERVICE);
    const srv = response.answers.find((a) => a.type === 'SRV' && a.name === SERVICE);
    if (!txt || !srv || srv.type !== 'SRV' || txt.type !== 'TXT') return;

    const text = decodeTxtData(txt.data);
    const match = text.match(/deviceId=([A-Z2-7]{10})/);
    if (!match) return;
    const deviceId = match[1];
    if (!deviceId) return;

    const target = srv.data.target ?? '';
    const host = target.replace(/\.$/, '');
    if (deviceId !== identity.deviceId) {
      onPeerFound({ deviceId, host, port: srv.data.port, address: rinfo?.address });
    }
  });

  return {
    kick(): void {
      // ready 之前(timer 未建)mdns 还没就绪,不补;恢复场景都在运行期,必然已建
      if (timer === undefined) return;
      announceAndQuery();
    },
    close(): void {
      if (timer) clearInterval(timer);
      mdns.destroy();
    },
  };
}
