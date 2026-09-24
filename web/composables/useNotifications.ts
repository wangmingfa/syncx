import { computed, ref, watch } from 'vue';
import type { Ref } from 'vue';
import type { StatusData } from '../types';
import { setFaviconCount } from '../utils/favicon';
import { useToast } from './useToast';

/**
 * 桌面通知 + favicon 角标:把「需要人工处理的事」顶出去,而不是等人刷页面。
 *
 * 计数口径(与标签页标题同一类语义,三处相加,favicon 封顶 99+):
 *  - 待确认邀请(pending offers):不处理对方就一直等;
 *  - 冲突副本(conflictCounts 总和):需要选保留哪一版;
 *  - 同步错误(folderErrors):需要人看一眼原因。
 *
 * 通知只在「计数上涨」的边沿触发(挂载时的存量不发,处理完回落后再涨才发),
 * 避免每帧骚扰;开关按浏览器存 localStorage(这是浏览器偏好,不是 daemon 配置)。
 */
export function useNotifications(status: Ref<StatusData>): {
  notifSupported: boolean;
  notifEnabled: Ref<boolean>;
  toggleNotifications: () => Promise<void>;
} {
  const { showToast } = useToast();
  const notifSupported = typeof Notification !== 'undefined';
  const notifEnabled = ref(notifSupported && localStorage.getItem('syncx:notify') === '1');

  const pendingOfferCount = computed(() => status.value.offers.filter((o) => o.status === 'pending').length);
  const conflictCount = computed(() =>
    Object.values(status.value.conflictCounts ?? {}).reduce((sum, n) => sum + n, 0),
  );
  const errorCount = computed(() => status.value.folderErrors?.length ?? 0);
  const attentionCount = computed(() => pendingOfferCount.value + conflictCount.value + errorCount.value);

  // 角标随状态推送即时刷新;0 = 恢复原始图标
  watch(attentionCount, (n) => setFaviconCount(n), { immediate: true });

  // 边沿触发:仅「上涨」发通知,首次运行(prev 为 undefined)与回落都不发
  const notify = (title: string, body: string): void => {
    if (!notifEnabled.value || Notification.permission !== 'granted') return;
    try {
      new Notification(title, { body, tag: 'syncx-attention', silent: false });
    } catch {
      /* 个别环境构造函数被禁,静默跳过 */
    }
  };
  watch(pendingOfferCount, (n, prev) => {
    if (prev !== undefined && n > prev) notify('SYNCX:收到待确认邀请', '有设备请求配对或共享目录,点击打开处理');
  });
  watch(conflictCount, (n, prev) => {
    if (prev !== undefined && n > prev) notify('SYNCX:出现冲突副本', '同一文件两端都改过,需要选择保留哪一版');
  });
  watch(errorCount, (n, prev) => {
    if (prev !== undefined && n > prev) {
      const first = status.value.folderErrors?.[0];
      notify('SYNCX:同步出错', first?.message?.slice(0, 120) ?? '某目录同步失败,点击打开查看');
    }
  });

  async function toggleNotifications(): Promise<void> {
    if (!notifSupported) {
      showToast('当前浏览器不支持桌面通知', 'alert');
      return;
    }
    if (!notifEnabled.value) {
      // 浏览器要求授权;被拒后开关键仍可回弹,但通知不会再发(见 notify 的 permission 判断)
      let permission = Notification.permission;
      if (permission === 'default') {
        try {
          permission = await Notification.requestPermission();
        } catch {
          permission = Notification.permission;
        }
      }
      if (permission === 'denied') {
        showToast('桌面通知权限已被浏览器拒绝,请在浏览器设置中放行', 'alert');
        return;
      }
      notifEnabled.value = true;
      localStorage.setItem('syncx:notify', '1');
      showToast('已开启桌面通知');
    } else {
      notifEnabled.value = false;
      localStorage.setItem('syncx:notify', '0');
      showToast('已关闭桌面通知');
    }
  }

  return { notifSupported, notifEnabled, toggleNotifications };
}
