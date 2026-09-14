import { ref, type Ref } from 'vue';

export type ToastKind = 'info' | 'alert';

/**
 * 全局轻提示:info=普通操作反馈(底部小胶囊);alert=重要通知(配对/升级,
 * 顶部高对比样式,见 style.css .toast--alert)。
 * 模块级单例:拆分成多个 composable 后,所有调用方必须共享同一个 toast ref,
 * 否则只有 StatusPage 那次 useToast() 的 toast 会被模板渲染,其余调用方的提示会「消失」。
 */
const toast = ref<{ msg: string; kind: ToastKind } | undefined>(undefined);

function showToast(msg: string, kind: ToastKind = 'info'): void {
  toast.value = { msg, kind };
  // 3 秒后自动消失
  setTimeout(() => {
    if (toast.value?.msg === msg) toast.value = undefined;
  }, 3000);
}

export function useToast(): { toast: Ref<typeof toast.value>; showToast: typeof showToast } {
  return { toast, showToast };
}
