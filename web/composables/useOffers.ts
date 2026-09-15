import { reactive, computed, ref } from 'vue';
import type { ComputedRef, Ref } from 'vue';
import { useToast } from './useToast';
import { apiJson, errText } from '../utils/api';
import { folderKey } from '../utils/format';
import type { CoreDeps } from './statusContext';
import type { OfferInfo } from '../types';

/** 待确认项:对方推送的配对 / 目录共享邀请(accept/decline/restore + pending/declined 分组)。 */
export function useOffers(deps: CoreDeps): {
  offerPaths: Record<string, string>;
  offerReceiveOnly: Record<string, boolean>;
  reusedFolderPath: (offer: OfferInfo) => string | undefined;
  acceptOffer: (offer: OfferInfo) => Promise<void>;
  declineOffer: (offer: OfferInfo) => Promise<void>;
  restoreOffer: (offer: OfferInfo) => Promise<void>;
  pendingOffers: ComputedRef<OfferInfo[]>;
  declinedOffers: ComputedRef<OfferInfo[]>;
  declinedOpen: Ref<boolean>;
} {
  const { status, busy, refreshStatus } = deps;
  const { showToast } = useToast();

  // 目录共享邀请需要本机落地路径,按 offer id 暂存输入框内容
  const offerPaths = reactive<Record<string, string>>({});
  /** 接受目录邀请时是否设为接收模式(只拉不推),按 offer id 暂存勾选状态。 */
  const offerReceiveOnly = reactive<Record<string, boolean>>({});

  /**
   * 邀请的目录 id 在本机已有对应目录时返回其本地路径 → 直接复用,不再要求用户重填。
   * 典型场景:对方把本机早就共享过的目录反向邀请回来。口径与后端 acceptOffer 一致(按 id 匹配)。
   */
  function reusedFolderPath(offer: OfferInfo): string | undefined {
    if (offer.kind !== 'folder' || !offer.folderId) return undefined;
    return status.value.folders.find((f) => folderKey(f) === offer.folderId)?.path;
  }

  async function acceptOffer(offer: OfferInfo): Promise<void> {
    if (busy.value) return;
    busy.value = true;
    try {
      // 可复用本机已有目录时不传 localPath,由后端按 id 复用该映射(两侧口径必须一致)
      const reuse = reusedFolderPath(offer);
      const localPath = offer.kind === 'folder' && !reuse ? offerPaths[offer.id]?.trim() : undefined;
      if (offer.kind === 'folder' && !reuse && !localPath) {
        showToast('请填写本机目录路径');
        busy.value = false;
        return;
      }
      await apiJson(`/api/offers/${encodeURIComponent(offer.id)}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          localPath,
          receiveOnly: offer.kind === 'folder' ? offerReceiveOnly[offer.id] === true : undefined,
        }),
      });
      showToast(offer.kind === 'folder' ? '已接受目录共享,开始同步' : '已接受配对', 'alert');
      await refreshStatus();
    } catch (e) {
      showToast(errText(e, '确认失败,请重试'), 'alert');
    } finally {
      busy.value = false;
    }
  }

  async function declineOffer(offer: OfferInfo): Promise<void> {
    if (busy.value) return;
    busy.value = true;
    try {
      await apiJson(`/api/offers/${encodeURIComponent(offer.id)}/decline`, {
        method: 'POST',
      });
      showToast('已忽略该请求(可在下方「已忽略」中恢复)');
      await refreshStatus();
    } catch (e) {
      showToast(errText(e, '操作失败,请重试'), 'alert');
    } finally {
      busy.value = false;
    }
  }

  /** 手误忽略的兜底:把已忽略的待确认项恢复为 pending,重新出现在确认列表。 */
  async function restoreOffer(offer: OfferInfo): Promise<void> {
    if (busy.value) return;
    busy.value = true;
    try {
      await apiJson(`/api/offers/${encodeURIComponent(offer.id)}/restore`, {
        method: 'POST',
      });
      showToast('已恢复,请重新确认');
      await refreshStatus();
    } catch (e) {
      showToast(errText(e, '恢复失败,请重试'), 'alert');
    } finally {
      busy.value = false;
    }
  }

  // 待确认区分两组:pending 可确认/忽略;declined 灰显仅供恢复(默认收起,点按钮展开)
  const pendingOffers = computed(() => status.value.offers.filter((o) => o.status !== 'declined'));
  const declinedOffers = computed(() => status.value.offers.filter((o) => o.status === 'declined'));
  const declinedOpen = ref(false);

  return {
    offerPaths,
    offerReceiveOnly,
    reusedFolderPath,
    acceptOffer,
    declineOffer,
    restoreOffer,
    pendingOffers,
    declinedOffers,
    declinedOpen,
  };
}
