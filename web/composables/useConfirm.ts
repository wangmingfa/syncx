import { ref, type Ref } from 'vue';
import type { ConfirmState } from '../types';

/** 通用二次确认弹窗状态(移除目录 / 移除设备 / 升级 / 自更新共用;执行在 ConfirmModal 内)。 */
export function useConfirm(busy: Ref<boolean>): {
  confirmState: Ref<ConfirmState | null>;
  askConfirm: (state: ConfirmState) => void;
} {
  const confirmState = ref<ConfirmState | null>(null);

  function askConfirm(state: ConfirmState): void {
    if (busy.value) return;
    confirmState.value = state;
  }

  return { confirmState, askConfirm };
}
