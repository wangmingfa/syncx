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

/**
 * 列出「待确认 + 已忽略」的待确认项(已接受的不展示)。
 * 已忽略项供 UI 灰显并提供「恢复」按钮,兜住手误忽略的场景。
 */
export function listOpenOffers(configPath: string): PendingOffer[] {
  return loadConfig(configPath).pendingOffers.filter((o) => o.status !== 'accepted');
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
  offer: {
    id: string;
    kind: PendingOffer['kind'];
    fromDeviceId: string;
    folderId?: string;
    folderName?: string;
    fromIp?: string;
    fromHostname?: string;
  },
): PendingOffer | null {
  const config = loadConfig(configPath);

  const key = dedupeKey(offer);
  const existing = config.pendingOffers.find((o) => dedupeKey(o) === key);
  if (existing) {
    // 命中去重即不再新建(避免重连重推刷屏),但来源信息要顺带回填:
    // 该记录可能创建于 fromIp / fromHostname 字段引入之前,或对端当时版本较旧
    // 没带 hostname —— 老卡片否则永远只有「来自 <id>」,对方重推也补不上。
    // 仅补空值,不覆盖已有信息(IP 可能因换网段而变化,以首次记录为准)。
    let dirty = false;
    if (!existing.fromIp && offer.fromIp) {
      existing.fromIp = offer.fromIp;
      dirty = true;
    }
    if (!existing.fromHostname && offer.fromHostname) {
      existing.fromHostname = offer.fromHostname;
      dirty = true;
    }
    if (dirty) saveConfig(configPath, config);
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
    fromIp: offer.fromIp,
    fromHostname: offer.fromHostname,
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

/** 恢复一个已忽略的待确认项(置回 pending);仅 declined 可恢复,其余返回 undefined。 */
export function restoreDeclinedOffer(configPath: string, id: string): PendingOffer | undefined {
  const config = loadConfig(configPath);
  const offer = config.pendingOffers.find((o) => o.id === id);
  if (!offer || offer.status !== 'declined') return undefined;
  offer.status = 'pending';
  saveConfig(configPath, config);
  return offer;
}

/**
 * 清理「已被对方撤销」的目录邀请。
 *
 * 对端经 folder-sync-list 宣告的 folderIds 是它**当前仍想共享给本机**的目录集合
 * (session-manager 的 syncFolderIdsFor 口径)。因此本机上来源为该对端、仍为 pending 的
 * 目录邀请里,folderId 不在该集合中的,说明对方已删除该共享 → 移除,避免对方删除后
 * 本机残留一张永远点不动的「待确认」卡片。
 *
 * - 只动 pending:accepted 走正常的「已停止共享」逻辑,declined 保留供「恢复」
 * - folderIds 为空数组是有效输入(对方撤销了全部共享),会清空该对端所有 pending 目录邀请
 * - 返回被清理的条数
 */
export function pruneRevokedOffers(configPath: string, fromDeviceId: string, folderIds: string[]): number {
  const config = loadConfig(configPath);
  const keep = new Set(folderIds);
  const before = config.pendingOffers.length;
  config.pendingOffers = config.pendingOffers.filter(
    (o) =>
      !(
        o.kind === 'folder' &&
        o.status === 'pending' &&
        o.fromDeviceId === fromDeviceId &&
        o.folderId !== undefined &&
        !keep.has(o.folderId)
      ),
  );
  const removed = before - config.pendingOffers.length;
  if (removed > 0) saveConfig(configPath, config);
  return removed;
}

/** 生成本机发起邀请的确定性 id(便于对端重推时幂等)。 */
export function makeOfferId(prefix: string, remoteDeviceId: string, folderId?: string): string {
  const raw = `${prefix}:${remoteDeviceId}:${folderId ?? ''}`;
  return randomBytes(4).toString('hex') + ':' + raw;
}
