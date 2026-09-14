import { ref, onMounted, onUnmounted, type Ref } from 'vue';
import { useToast } from './useToast';
import { apiJson, errText } from '../utils/api';
import type { StatusData } from '../types';

export interface StatusProps {
  status: StatusData;
  message?: string;
}

/**
 * 核心状态与基础设施:status 本地持有(初始值来自 props,交互后由 fetch 更新),
 * 周期轮询刷新,以及通用的 post/copy。其余业务 composable 通过 CoreDeps 复用这些。
 */
export function useStatus(props: StatusProps): {
  status: Ref<StatusData>;
  busy: Ref<boolean>;
  isDev: boolean;
  controlPort: string;
  refreshStatus: () => Promise<void>;
  post: (action: string, body?: Record<string, string>) => Promise<void>;
  copy: (text: string) => Promise<void>;
} {
  const { showToast } = useToast();
  const status = ref<StatusData>(props.status);
  const busy = ref(false);
  // 端口提示仅开发模式显示:「dev 请访问 5173(HMR)」对终端用户是噪音,
  // build 后由 vite 静态替换为 false 并 tree-shake 掉整段 DOM。
  const isDev = import.meta.env.DEV;
  // 控制端口取当前地址的真实端口,而非硬编码 8384(--port 可改)。
  const controlPort = globalThis.location?.port || '8384';

  async function refreshStatus(): Promise<void> {
    try {
      const res = await fetch('/api/status');
      if (!res.ok) throw new Error(`status ${res.status}`);
      status.value = (await res.json()) as StatusData;
    } catch {
      // 静默失败,保留当前状态
    }
  }

  /** 调用一个 JSON API 端点,成功后刷新状态并弹 toast。 */
  async function post(action: string, body?: Record<string, string>): Promise<void> {
    if (busy.value) return;
    busy.value = true;
    try {
      await apiJson(action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      showToast('操作已触发');
      await refreshStatus();
    } catch (e) {
      showToast(errText(e, '操作失败,请重试'), 'alert');
    } finally {
      busy.value = false;
    }
  }

  /** 复制文本到剪贴板,并轻提示。优先现代 Clipboard API,HTTPS 受限时降级到 execCommand。 */
  async function copy(text: string): Promise<void> {
    // 1. 优先使用现代 Clipboard API
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        showToast('已复制到剪贴板');
        return;
      } catch {
        // 继续降级
      }
    }
    // 2. 兼容 HTTP / 老浏览器
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      textarea.style.top = '0';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const success = document.execCommand('copy');
      textarea.remove();
      if (success) {
        showToast('已复制到剪贴板');
        return;
      }
    } catch {
      // 降级失败
    }
    showToast('复制失败,请手动选择');
  }

  // 挂载后立即刷新一次 + 周期轮询(让对方推送的待确认项及时弹出);卸载清理定时器
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  onMounted(() => {
    void refreshStatus();
    pollTimer = setInterval(() => void refreshStatus(), 4000);
  });
  onUnmounted(() => {
    if (pollTimer) clearInterval(pollTimer);
  });

  // 邀请链接进页面的提示属重要通知,走 alert 级
  if (props.message) showToast(props.message, 'alert');

  return { status, busy, isDev, controlPort, refreshStatus, post, copy };
}
