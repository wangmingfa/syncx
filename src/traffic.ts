import type { TrafficSample, TrafficStats } from './status.js';

/**
 * 传输字节账本:累计量 + 固定窗口的采样环(供流量面板画 24h 曲线)。
 *
 * 设计约束:
 *  - 采样环容量按「窗口宽 × 环长 = 覆盖时长」定(默认 5min × 288 = 24h),超出丢最旧;
 *  - 曲线要的是「这段时间走了多少」而非「当前总量」,所以每次 flush 记录的是**窗口内增量**
 *    (与上次快照的差),而不是绝对值;这样曲线段的高度直接对应速率,读图无需再算差;
 *  - daemon 重启即清零(内存态,不落盘):统计是「这次在线期间」的观测量,不值得为
 *    跨重启的历史引入持久化与迁移负担。
 */

/** 采样窗口宽(毫秒):默认 5 分钟一个点。 */
const WINDOW_MS = 5 * 60 * 1000;
/** 环长:288 × 5min = 24 小时。 */
const RING_LEN = 288;

export class TrafficLedger {
  private sent = 0;
  private received = 0;
  /** 上个采样窗口结束时的累计读数,用于算下一段的增量。 */
  private lastSent = 0;
  private lastReceived = 0;
  /** 当前采样窗口起点(对齐到 WINDOW_MS 边界)。 */
  private windowStart = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;
  private readonly samples: TrafficSample[] = [];

  /** 记一笔传输字节(方向 send=本机供出 / receive=本机拉入)。 */
  add(direction: 'send' | 'receive', bytes: number): void {
    if (bytes <= 0) return;
    if (direction === 'send') this.sent += bytes;
    else this.received += bytes;
  }

  /**
   * 推进到给定时刻:凡是跨过了采样窗口边界,就把「自上次 flush 起的增量」
   * 记为一个样本,并按 windowStart 对齐推进。空闲(无流量)窗口仍会补零,
   * 让曲线时间轴连续(否则稀疏流量下 x 轴会误判相邻点间距)。
   * 单次最多回填 ringLen 个窗口,防止长时间挂起后一次性灌爆循环。
   */
  flushTo(now: number): void {
    let target = Math.floor(now / WINDOW_MS) * WINDOW_MS;
    if (target <= this.windowStart) return; // 还在当前窗口内,不产生新样本
    let guard = 0;
    while (this.windowStart < target && guard < RING_LEN) {
      const sent = this.sent - this.lastSent;
      const received = this.received - this.lastReceived;
      this.pushSample({ at: this.windowStart, sent, received });
      this.lastSent = this.sent;
      this.lastReceived = this.received;
      this.windowStart += WINDOW_MS;
      guard += 1;
    }
    // 回填护栏触发(进程久睡/暂停):直接把游标跳到当前窗口,丢弃中间的空白区间
    if (this.windowStart < target) {
      this.lastSent = this.sent;
      this.lastReceived = this.received;
      this.windowStart = target;
    }
  }

  private pushSample(sample: TrafficSample): void {
    this.samples.push(sample);
    if (this.samples.length > RING_LEN) this.samples.shift();
  }

  /** 取当前累计 + 采样序列(先按 now 推进窗口)。 */
  snapshot(now = Date.now()): TrafficStats {
    this.flushTo(now);
    // 未闭合的当前窗口不进 samples(避免把「进行中」的半截增量当成一格);
    // 曲线展示的是已完成窗口的历史。
    return { sent: this.sent, received: this.received, samples: this.samples.slice() };
  }
}
