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

/**
 * Thin mDNS discovery: advertises this device (deviceId derived from the
 * public key, service port in SRV), and reports peers that advertise the
 * same service. Real pairing/connection logic is a later batch.
 */
export function startDiscovery(
  identity: DeviceIdentity,
  port: number,
  onPeerFound: (peer: DiscoveredPeer) => void,
): Discovery {
  const mdns = multicastDNS();

  mdns.on('ready', () => {
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
  });

  mdns.on('response', (response: ResponsePacket) => {
    const txt = response.answers.find((a) => a.type === 'TXT' && a.name === SERVICE);
    const srv = response.answers.find((a) => a.type === 'SRV' && a.name === SERVICE);
    if (!txt || !srv || srv.type !== 'SRV' || txt.type !== 'TXT') return;

    const text = Buffer.isBuffer(txt.data) ? txt.data.toString('utf8') : '';
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
      mdns.destroy();
    },
  };
}
