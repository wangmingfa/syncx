/**
 * 令牌桶速率限制器:按配置的 KB/s 限制累计发送字节数。
 * 不阻塞,超出限速时返回 false 让调用方延迟发送。
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly rateBytesPerMs: number;

  /**
   * @param rateKbps 速率上限(KB/s),0 表示不限速
   */
  constructor(rateKbps: number) {
    this.rateBytesPerMs = rateKbps > 0 ? (rateKbps * 1024) / 1000 : 0;
    this.tokens = this.rateBytesPerMs > 0 ? this.rateBytesPerMs * 1000 : 0;
    this.lastRefill = Date.now();
  }

  /** 尝试消耗 bytes 字节的额度,返回是否允许发送。 */
  tryConsume(bytes: number): boolean {
    if (this.rateBytesPerMs === 0) return true;
    this._refill();
    if (bytes > this.tokens) return false;
    this.tokens -= bytes;
    return true;
  }

  /** 获取下次可用等待时间(毫秒),0 表示立即可用。 */
  waitTime(bytes: number): number {
    if (this.rateBytesPerMs === 0) return 0;
    this._refill();
    if (bytes <= this.tokens) return 0;
    const deficit = bytes - this.tokens;
    return Math.ceil(deficit / this.rateBytesPerMs);
  }

  private _refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(
      this.rateBytesPerMs * 1000,
      this.tokens + this.rateBytesPerMs * elapsed,
    );
    this.lastRefill = now;
  }

  refill(): void {
    this._refill();
  }

  /** 清空当前令牌:用于单条超过桶容量的消息发送后,仍按限速节流后续发送。 */
  drain(): void {
    this._refill();
    this.tokens = 0;
  }
}