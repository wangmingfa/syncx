import type { WebSocket } from 'ws';

/**
 * 控制面状态推送中枢(`/api/events`)。
 *
 * 背景:Web UI 此前每 4 秒 `GET /api/status`,而每次都要读配置、按目录做索引统计
 * 并读待确认项 —— 一个空闲的 daemon 也会被持续叫醒,客户端拿到的还是陈旧数据。
 * 状态本身的变更源却是离散的(设备上下线、目录清单变化、邀请到达、目录错误、
 * 扫描结果),唯一高频的只有传输进度。因此改为服务端在变更时推送。
 *
 * 触发模型是「事件 + 兜底」两层:
 *  - 事件层:`notify()` 由会话管理的变更点调用,经 `flushMs` 合并窗口后推一帧。
 *    实时性靠它(亚秒级),也让传输中的进度更新足够跟手。
 *  - 兜底层:一个低频 tick 无条件重算一次。它保证「漏了某个通知点」只表现为
 *    「变化晚到几秒」,而不是「界面永久不动」—— 这个性质比省掉几次重算重要得多。
 *
 * 推送是**差异驱动**的:算出的状态与上一次发出的序列化结果相同时一帧都不发。
 * 于是事件层可以放心地在粗粒度位置打点(多打几个通知不会变成多推几帧)。
 *
 * 空闲零开销:没有客户端连接时,两个定时器都不存在;最后一个连接断开即停。
 */
export interface StatusHub {
  /** 接管一条已完成握手的连接:立即回一帧全量,之后随变更推送。 */
  attach(socket: WebSocket): void;
  /** 状态可能已变(由会话管理的变更点调用)。合并窗口内多次调用只推一帧。 */
  notify(): void;
  /** 当前连接数(测试与诊断用)。 */
  clientCount(): number;
  /** 关闭全部连接并停止定时器(daemon 优雅关闭时调用)。 */
  close(): void;
}

export interface StatusHubOptions {
  /** 取当前状态快照(与 `/api/status` 同源,返回可 JSON 序列化的对象)。 */
  getStatus: () => unknown;
  /** 变更合并窗口:此窗口内的多次 notify 合并成一帧。 */
  flushMs?: number;
  /** 兜底重算周期:无论有没有事件,至少这个间隔检查一次是否有变化。 */
  fallbackMs?: number;
  /** 应用层 ping 周期:保活并让中间代理不因空闲掐断连接。 */
  pingMs?: number;
  /** 诊断日志(取快照失败等异常不会中断通道,只记一行)。 */
  log?: (message: string) => void;
}

/** 变更合并窗口。够短到「点了按钮界面立刻变」,够长到一次扫描的成批变更只推一帧。 */
const DEFAULT_FLUSH_MS = 250;
/**
 * 兜底重算周期。取 5s 与扫描周期同阶:扫描是本机状态最主要的驱动源,
 * 兜底比它更密没有意义,更疏则漏事件时的迟钝会变得可感知。
 */
const DEFAULT_FALLBACK_MS = 5000;
/** 应用层 ping 周期。低于多数中间代理 60s 的空闲阈值。 */
const DEFAULT_PING_MS = 30000;

export function createStatusHub(options: StatusHubOptions): StatusHub {
  const { getStatus, log } = options;
  const flushMs = options.flushMs ?? DEFAULT_FLUSH_MS;
  const fallbackMs = options.fallbackMs ?? DEFAULT_FALLBACK_MS;
  const pingMs = options.pingMs ?? DEFAULT_PING_MS;

  const clients = new Set<WebSocket>();
  /** 上一次真正发出的状态序列化结果:与本轮相同即跳过发送。 */
  let lastSent = '';
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let fallbackTimer: ReturnType<typeof setInterval> | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  function send(socket: WebSocket, payload: unknown): void {
    try {
      socket.send(JSON.stringify(payload));
    } catch (error) {
      // 发送失败(对端已消失等):立刻摘掉,避免反复对死连接写
      clients.delete(socket);
      log?.(`status push failed, client dropped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function broadcast(payload: unknown): void {
    for (const socket of [...clients]) send(socket, payload);
  }

  /**
   * 取一帧状态快照。取不到(序列化抛错)时返回 undefined 并记一行日志 ——
   * 通道本身不该因为一次快照失败而断掉。
   */
  function snapshot(): string | undefined {
    try {
      return JSON.stringify(getStatus());
    } catch (error) {
      log?.(`status snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  /**
   * 重算一次状态,有变化才广播。
   * 事件层与兜底层共用:兜底层只是「无条件调用它」,因此它必须是差异驱动的 ——
   * 否则兜底 tick 会变成 5s 一次的无效推送。
   */
  function flush(): void {
    if (clients.size === 0) return;
    const serialized = snapshot();
    if (serialized === undefined || serialized === lastSent) return;
    lastSent = serialized;
    broadcast({ type: 'status', status: JSON.parse(serialized) as unknown });
  }

  function startTimers(): void {
    if (closed || fallbackTimer !== undefined) return;
    fallbackTimer = setInterval(flush, fallbackMs);
    pingTimer = setInterval(() => {
      const payload = { type: 'ping', ts: Date.now() };
      for (const socket of [...clients]) send(socket, payload);
    }, pingMs);
    // 定时器不应单独把进程钉住(daemon 存活由 peer/控制端口维持)
    fallbackTimer.unref?.();
    pingTimer.unref?.();
  }

  function stopTimers(): void {
    if (fallbackTimer !== undefined) {
      clearInterval(fallbackTimer);
      fallbackTimer = undefined;
    }
    if (pingTimer !== undefined) {
      clearInterval(pingTimer);
      pingTimer = undefined;
    }
  }

  return {
    clientCount(): number {
      return clients.size;
    },

    attach(socket: WebSocket): void {
      if (closed) {
        socket.close(1001, 'server shutting down');
        return;
      }
      clients.add(socket);
      const drop = (): void => {
        clients.delete(socket);
        if (clients.size === 0) {
          stopTimers();
          // 没有订阅者时重置基线:下一个客户端连上后必须收到一帧,而不是被
          // 「与上次相同」的差异判断挡掉
          lastSent = '';
        }
        if (flushTimer !== undefined) {
          clearTimeout(flushTimer);
          flushTimer = undefined;
        }
      };
      socket.on('close', drop);
      socket.on('error', drop);
      startTimers();
      // 新连接立即给一帧全量:不依赖任何事件,界面连上就能画。
      // 只发给这一条连接(并顺手校准基线),不必惊动已在线的其它标签页。
      const serialized = snapshot();
      if (serialized !== undefined) {
        lastSent = serialized;
        send(socket, { type: 'status', status: JSON.parse(serialized) as unknown });
      }
    },

    notify(): void {
      if (closed || clients.size === 0) return;
      if (flushTimer !== undefined) return;
      flushTimer = setTimeout(() => {
        flushTimer = undefined;
        flush();
      }, flushMs);
      flushTimer.unref?.();
    },

    close(): void {
      closed = true;
      if (flushTimer !== undefined) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
      stopTimers();
      for (const socket of [...clients]) {
        try {
          socket.close(1001, 'server shutting down');
        } catch {
          // 已断开
        }
      }
      clients.clear();
      lastSent = '';
    },
  };
}
