import { ref, onMounted, onUnmounted, type Ref } from 'vue';
import { useToast } from './useToast';
import { apiJson, errText } from '../utils/api';
import { copyText } from '../utils/clipboard';
import type { StatusData } from '../types';

export interface StatusProps {
  status: StatusData;
  message?: string;
}

/**
 * 状态推送通道路径。与后端 `src/api/helpers.ts` 的 EVENTS_PATH 是同一个字面量 ——
 * 客户端 bundle 不 import 后端模块,两边不一致的表现是「界面悄悄退回轮询」,
 * 不报错也很难发现,改一侧务必同步改另一侧。
 */
const EVENTS_PATH = '/api/events';
/** WS 不可用时的回退轮询间隔(与改造前的行为一致,保证界面仍在更新)。 */
const FALLBACK_POLL_MS = 4000;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;

/**
 * 核心状态与基础设施:status 本地持有(初始值来自 props,交互后由 fetch 更新)。
 *
 * 状态刷新走 `WS /api/events` 推送:服务端在变更时推一帧全量 status,连上后不需要
 * 任何轮询。WS 建不起来时(反向代理未转发 Upgrade、daemon 正在重启等)自动退回
 * 4s 轮询,连上即停 —— 两条路径互斥,不会同时刷新。
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
      // 走统一 apiJson:会话失效(401)时由 apiJson 内部统一跳回登录页,
      // 这里只需静默保留当前状态,不必再单独判断未登录。
      const data = await apiJson<StatusData>('/api/status');
      status.value = data;
    } catch {
      // 静默失败,保留当前状态(401 已在 apiJson 内统一跳转登录页)
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

  /** 复制文本到剪贴板,并轻提示。底层复用公共 clipboard 工具,兼容非安全上下文。 */
  async function copy(text: string): Promise<void> {
    const ok = await copyText(text);
    showToast(ok ? '已复制到剪贴板' : '复制失败,请手动选择');
  }

  /* ==================== 推送通道(含轮询回退) ==================== */

  let socket: WebSocket | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectDelay = RECONNECT_MIN_MS;
  let disposed = false;

  function startPolling(): void {
    if (pollTimer !== undefined || disposed) return;
    pollTimer = setInterval(() => void refreshStatus(), FALLBACK_POLL_MS);
  }

  function stopPolling(): void {
    if (pollTimer === undefined) return;
    clearInterval(pollTimer);
    pollTimer = undefined;
  }

  function scheduleReconnect(): void {
    if (disposed || reconnectTimer !== undefined) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, reconnectDelay);
    // 指数退避封顶 30s:daemon 升级重启期间不会把控制端口打满,恢复后又很快追上
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  }

  function connect(): void {
    if (disposed || socket !== undefined) return;
    const proto = globalThis.location?.protocol === 'https:' ? 'wss:' : 'ws:';
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${proto}//${globalThis.location?.host ?? ''}${EVENTS_PATH}`);
    } catch {
      // 构造失败(地址非法等):按通道不可用处理,直接走回退
      startPolling();
      scheduleReconnect();
      return;
    }
    socket = ws;

    ws.addEventListener('open', () => {
      // 连上即停轮询:此后状态只由推送驱动,不再有定时请求
      reconnectDelay = RECONNECT_MIN_MS;
      stopPolling();
    });

    ws.addEventListener('message', (event) => {
      let message: { type?: string; status?: StatusData };
      try {
        message = JSON.parse(String(event.data)) as { type?: string; status?: StatusData };
      } catch {
        return; // 非法帧忽略:通道仍在,不必因此重连
      }
      // ping 仅保活(也让中间代理不因空闲掐断连接),不触发任何渲染
      if (message.type === 'status' && message.status) status.value = message.status;
    });

    const onGone = (): void => {
      if (socket !== ws) return; // 已被新一轮连接取代(或已卸载),不重复处理
      socket = undefined;
      if (disposed) return;
      // 通道不可用:退回轮询保证界面继续更新,同时后台重连
      startPolling();
      scheduleReconnect();
    };
    ws.addEventListener('close', onGone);
    // error 后必然跟一个 close,统一在 close 里收口,避免双份重连
    ws.addEventListener('error', () => {});

    // 首帧由服务端在握手后立刻下发,不必在这里再拉一次
  }

  function onVisibilityChange(): void {
    if (disposed) return;
    if (globalThis.document?.visibilityState !== 'visible') return;
    // 后台标签页里连接可能已被浏览器/代理静默掐断而未触发 close:
    // 回到前台时补一次连接与拉取,避免界面停在旧数据上
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      connect();
      void refreshStatus();
    }
  }

  onMounted(() => {
    // 首屏先拉一次:SSR/初始注入的数据可能已过期,不等握手就能画出界面
    void refreshStatus();
    connect();
    globalThis.document?.addEventListener('visibilitychange', onVisibilityChange);
  });

  onUnmounted(() => {
    disposed = true;
    globalThis.document?.removeEventListener('visibilitychange', onVisibilityChange);
    stopPolling();
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    socket?.close();
    socket = undefined;
  });

  // 邀请链接进页面的提示属重要通知,走 alert 级
  if (props.message) showToast(props.message, 'alert');

  return { status, busy, isDev, controlPort, refreshStatus, post, copy };
}
