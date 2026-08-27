import multicastDNS, { type ResponsePacket } from 'multicast-dns';
import { hostname } from 'node:os';
import type { DeviceIdentity } from '../identity.js';
import { deriveDeviceIdFromPublicKey } from '../handshake.js';

const SERVICE = '_syncx._tcp.local';

export interface DiscoveredPeer {
  deviceId: string;
  host: string;
  port: number;
}

export interface Discovery {
  close(): void;
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

  mdns.on('ready', () => {
    advertise();
    // 周期重播并主动查询:保证后加入节点既能被发现,也能发现已运行的节点
    timer = setInterval(() => {
      advertise();
      mdns.query([
        { name: SERVICE, type: 'SRV' },
        { name: SERVICE, type: 'TXT' },
      ]);
    }, 30000);
  });

  mdns.on('response', (response: ResponsePacket) => {
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
      onPeerFound({ deviceId, host, port: srv.data.port });
    }
  });

  return {
    close(): void {
      if (timer) clearInterval(timer);
      mdns.destroy();
    },
  };
}
