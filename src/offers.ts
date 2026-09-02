import { randomBytes } from 'node:crypto';
import { loadConfig, saveConfig, folderIdFor, type PendingOffer } from './config.js';

/** 接收方视角:一个待确认项的去重键(同一对方 + 同类 + 同一目录)。 */
function dedupeKey(offer: Pick<PendingOffer, 'fromDeviceId' | 'kind' | 'folderId'>): string {
  return `${offer.fromDeviceId}|${offer.kind}|${offer.folderId ?? ''}`;
}

/** 列出仍为 pending 的待确认项(已确认 / 已忽略的不展示)。 */
export function listPendingOffers(configPath: string): PendingOffer[] {
  return loadConfig(configPath).pendingOffers.filter((o) => o.status === 'pending');
}

/** 按 id 查找待确认项(任意状态)。 */
export function findPendingOffer(configPath: string, id: string): PendingOffer | undefined {
  return loadConfig(configPath).pendingOffers.find((o) => o.id === id);
}

/**
 * 收到一个对方推送的邀请(配对 / 目录共享)。
 * - 去重:同一 (from, kind, folderId) 已存在任意状态则忽略,返回 null(避免重连重推刷屏)。
 * - 跳过已 mutual 的关系:目录已与对方互相同步、或对方已在已知设备,则不再弹确认(防 echo)。
 * 返回新创建的待确认项,或 null(被去重 / 跳过)。
 */
export function receiveOffer(
  configPath: string,
  offer: { id: string; kind: PendingOffer['kind']; fromDeviceId: string; folderId?: string; folderName?: string },
): PendingOffer | null {
  const config = loadConfig(configPath);

  const key = dedupeKey(offer);
  if (config.pendingOffers.some((o) => dedupeKey(o) === key)) {
    return null;
  }

  // 已 mutual:目录已与对方互相同步 → 这是连接建立时的重发 echo,不弹确认
  if (offer.kind === 'folder' && offer.folderId) {
    const mutual = config.sharedFolders.some(
      (f) => folderIdFor(f) === offer.folderId && (f.devices ?? []).includes(offer.fromDeviceId),
    );
    if (mutual) return null;
  }
  // 已 mutual:对方已在已知设备 → pairing 请求是 echo
  if (offer.kind === 'pairing' && config.knownDevices.some((d) => d.id === offer.fromDeviceId)) {
    return null;
  }

  const full: PendingOffer = {
    id: offer.id,
    kind: offer.kind,
    fromDeviceId: offer.fromDeviceId,
    folderId: offer.folderId,
    folderName: offer.folderName ?? offer.folderId,
    status: 'pending',
    createdAt: Date.now(),
  };
  config.pendingOffers.push(full);
  saveConfig(configPath, config);
  return full;
}

/** 确认一个待确认项(校验存在,置为 accepted 并返回,持久化由调用方完成实际配置变更)。 */
export function markOfferAccepted(configPath: string, id: string): PendingOffer | undefined {
  const config = loadConfig(configPath);
  const offer = config.pendingOffers.find((o) => o.id === id);
  if (!offer) return undefined;
  offer.status = 'accepted';
  saveConfig(configPath, config);
  return offer;
}

/** 忽略一个待确认项(置为 declined)。 */
export function markOfferDeclined(configPath: string, id: string): PendingOffer | undefined {
  const config = loadConfig(configPath);
  const offer = config.pendingOffers.find((o) => o.id === id);
  if (!offer) return undefined;
  offer.status = 'declined';
  saveConfig(configPath, config);
  return offer;
}

/** 生成本机发起邀请的确定性 id(便于对端重推时幂等)。 */
export function makeOfferId(prefix: string, remoteDeviceId: string, folderId?: string): string {
  const raw = `${prefix}:${remoteDeviceId}:${folderId ?? ''}`;
  return randomBytes(4).toString('hex') + ':' + raw;
}
