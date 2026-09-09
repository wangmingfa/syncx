import { ref } from 'vue';

export type ToastKind = 'info' | 'alert';

/**
 * 全局轻提示:info=普通操作反馈(底部小胶囊);alert=重要通知(配对/升级,
 * 顶部高对比样式,见 style.css .toast--alert)。
 */
export function useToast() {
  const toast = ref<{ msg: string; kind: ToastKind } | undefined>(undefined);

  function showToast(msg: string, kind: ToastKind = 'info'): void {
    toast.value = { msg, kind };
    // 3 秒后自动消失
    setTimeout(() => {
      if (toast.value?.msg === msg) toast.value = undefined;
    }, 3000);
  }

  return { toast, showToast };
}
