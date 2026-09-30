import { onMounted, onUnmounted } from 'vue';
import { apiJson } from '../utils/api';
import type { StatusData } from '../types';

/**
 * 状态推送通道(`WS /api/events`)。与后端 `src/api/helpers.ts` 的 EVENTS_PATH 是同一个字面量 ——
 * 客户端 bundle 不 import 后端模块,两边不一致的表现是「界面悄悄退回轮询」,
 * 不报错也很难发现,改一侧务必同步改另一侧。
 */
const EVENTS_PATH = '/api/events';
/** WS 不可用时的回退轮询间隔(与改造前的行为一致,保证界面仍在更新)。 */
const FALLBACK_POLL_MS = 4000;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;

/**
 * 把 daemon 的全量 status 送进宿主:走 `WS /api/events` 推送(服务端在变更时推一帧全量),
 * 建不起来时退回 4s 轮询,连上即停 —— 两条路径互斥,不会同时刷新。
 *
 * 生命周期跟随调用组件(onMounted / onUnmounted),所以只能在组件 setup 同步期调用。
 * 抽出来是因为版本一致锁要在**每一条路由**上生效,而终端页 / 文件页各自拉自己的数据、
 * 没有共享的 status 实例:与其在两处各写一份重连与退避,不如共用这一条通道。
 * 多一条连接的代价近乎为零 —— 推送是差异驱动的(算出的状态与上一帧相同就一帧都不发),
 * 服务端只为变化计算一次快照,按连接扇出(见 ADR-0011)。
 */
export function useStatusFeed(apply: (status: StatusData) => void): {
  /** 主动拉一次 `/api/status`(动作之后、或回到前台时补帧)。 */
  refresh: () => Promise<void>;
} {
  let socket: WebSocket | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectDelay = RECONNECT_MIN_MS;
  let disposed = false;

  async function refresh(): Promise<void> {
    try {
      // 走统一 apiJson:会话失效(401)时由 apiJson 内部统一跳回登录页,
      // 这里只需静默保留当前状态,不必再单独判断未登录。
      apply(await apiJson<StatusData>('/api/status'));
    } catch {
      // 静默失败,保留当前状态(401 已在 apiJson 内统一跳转登录页)
    }
  }

  function startPolling(): void {
    if (pollTimer !== undefined || disposed) return;
    pollTimer = setInterval(() => void refresh(), FALLBACK_POLL_MS);
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
      if (message.type === 'status' && message.status) apply(message.status);
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
      void refresh();
    }
  }

  onMounted(() => {
    // 首屏先拉一次:即使推送通道还在握手,也不等它就能画出界面
    void refresh();
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

  return { refresh };
}
