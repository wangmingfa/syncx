import { ref, type Ref } from 'vue';
import { useToast } from './useToast';
import { useStatusFeed } from './useStatusFeed';
import { apiJson, errText } from '../utils/api';
import { copyText } from '../utils/clipboard';
import type { StatusData } from '../types';

export interface StatusProps {
  status: StatusData;
  message?: string;
}

/**
 * 核心状态与基础设施:status 本地持有(初始值来自 props,交互后由推送/拉取更新)。
 *
 * 状态刷新走共享的推送通道 `useStatusFeed`(见 ADR-0011):这里只负责把帧写进自己的 ref,
 * 连接、退避、轮询回退都不在本文件重复实现 —— 版本一致锁的宿主也要订阅同一份 status,
 * 两份实现迟早会漂移。
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

  const { refresh: refreshStatus } = useStatusFeed((s) => {
    status.value = s;
  });

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

  /** 复制文本到剪贴板,并轻提示。底层复用公共 clipboard 工具,兼容非安全上下文。 */
  async function copy(text: string): Promise<void> {
    const ok = await copyText(text);
    showToast(ok ? '已复制到剪贴板' : '复制失败,请手动选择');
  }

  // 邀请链接进页面的提示属重要通知,走 alert 级
  if (props.message) showToast(props.message, 'alert');

  return { status, busy, isDev, controlPort, refreshStatus, post, copy };
}
