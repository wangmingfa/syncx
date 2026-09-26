import type { ControlMessage } from './wire.js';

/** 账本需要的消息形态:folder-invitation / pairing-request 的公共字段。 */
export type TrackedOffer = Extract<ControlMessage, { kind: 'folder-invitation' } | { kind: 'pairing-request' }>;

/**
 * 出站邀请的「至少一次」台账。
 *
 * 背景:邀请(folder-invitation / pairing-request)是一次性推送,接收方只有
 * **用户决策**后才回 `*-ack` —— 那个信号可能几分钟、几小时,也可能永远不来,
 * 不能拿来驱动重发。这里引入独立的投递层回执 `offer-receipt`:接收方只要
 * **处理了**这条邀请(新建待确认 / 去重命中 / 已互信跳过,任一分支)就立刻回
 * 一帧 receipt,证明「送达」。发送方将邀请记入本台账,定期重发、直到收到回执。
 *
 * 为什么仍然值得做:主丢帧源(握手后分发空窗)已在 connectPeer 缓冲回放修复;
 * 但「发出即永不自愈」仍是语义而非保证 —— 连接猝死时 ws 出站缓冲里的未刷帧会
 * 被丢弃、解密认证失败的帧在分发器里被静默吞掉。新会话建立时 pushSharesTo 会
 * 重播,但那要等下一次重连;这层台账把自愈窗口从「下次会话」缩到「5 秒」。
 *
 * 兼容:旧版本对端不回 receipt → 重发至上限后放弃并记日志(接收侧按
 * (from, kind, folderId) 去重,重发对它无害且不可见);绝不无限重发。
 */
export interface OfferRetryLedgerOptions {
  /** 实际发送给目标对端(通常绑 SessionManager.sendControlTo)。返回 false = 对端当前离线。 */
  send: (message: TrackedOffer, targetDeviceId: string) => boolean;
  /** 日志(放弃 / 耗尽时记录)。 */
  log?: (message: string) => void;
  /** 重发间隔,默认 5000ms。 */
  intervalMs?: number;
  /** 除首次发送外的最大重发次数,默认 5(覆盖 ~30s 空窗)。 */
  maxResends?: number;
  /** 对端离线时的整体挂起期限(不消耗重发次数,超期放弃),默认 120000ms。 */
  offlineDeadlineMs?: number;
  /** 定时器注入(测试可控);缺省用全局 setTimeout/clearTimeout。 */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

interface LedgerEntry {
  message: TrackedOffer;
  /** 目标对端(邀请是发给它的):offerId 里嵌的也是它的设备 id,但发送要显式参数,不做字符串解析取巧。 */
  target: string;
  key: string;
  resends: number;
  trackingSince: number;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * 台账键 = trackKeyFromOfferId(offerId) —— track 与 confirm 必须走同一推导。
 * 注意 offerId 里嵌的是**目标对端**的设备 id(makeOfferId 以 remoteDeviceId 构造),
 * 而不是本机 fromDeviceId;消息侧没有「目标」字段,故一律从 offerId 解析,
 * 天然对齐。
 */

/**
 * 从 offerId(邀请或回执/ack 携带的)还原台账键。
 *
 * offerId 形态(见 offers.makeOfferId):`<随机hex>:<folder|pair>:<deviceId>[:<folderId>]`。
 * folderId 是路径,可能含半角冒号(Windows「D:\x」),故第 4 段起一律拼回。
 * 关键口径:回执带来的是接收方**首包**存下的 id —— 发送方即便重推换了新随机前缀,
 * 前缀后的(类别 + 设备 + folderId)不变,推出的键相同,照样能销账。
 */
export function trackKeyFromOfferId(offerId: string): string | undefined {
  const parts = offerId.split(':');
  if (parts.length < 3) return undefined;
  const [, prefix, deviceId] = parts;
  if (prefix === 'pair') return `${deviceId}|pairing-request|`;
  if (prefix === 'folder') return `${deviceId}|folder-invitation|${parts.slice(3).join(':')}`;
  return undefined;
}

export class OfferRetryLedger {
  private readonly entries = new Map<string, LedgerEntry>();
  private readonly send: (message: TrackedOffer, targetDeviceId: string) => boolean;
  private readonly log: (message: string) => void;
  private readonly intervalMs: number;
  private readonly maxResends: number;
  private readonly offlineDeadlineMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  private destroyed = false;

  constructor(opts: OfferRetryLedgerOptions) {
    this.send = opts.send;
    this.log = opts.log ?? (() => {});
    this.intervalMs = opts.intervalMs ?? 5000;
    this.maxResends = opts.maxResends ?? 5;
    this.offlineDeadlineMs = opts.offlineDeadlineMs ?? 120_000;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  /**
   * 记一次出站邀请(首次发送已由调用方完成或在此完成)。同键已有条目时**替换**
   * 消息并重置重发计数 —— 新会话重播意味着新的自愈周期;保留最新 offerId,
   * 销账按键匹配,不受 id 随机前缀变化影响。
   */
  track(message: TrackedOffer): void {
    if (this.destroyed) return;
    const key = trackKeyFromOfferId(message.offerId);
    if (!key) return; // 非法/未知前缀的 offerId 不入账(无法销账,重发只会制造噪声)
    const existing = this.entries.get(key);
    if (existing) {
      this.clearTimerIfAny(existing);
      existing.message = message;
      existing.resends = 0;
      existing.trackingSince = Date.now();
      this.schedule(existing);
      return;
    }
    const entry: LedgerEntry = {
      message,
      target: key.slice(0, key.indexOf('|')),
      key,
      resends: 0,
      trackingSince: Date.now(),
    };
    this.entries.set(key, entry);
    this.schedule(entry);
  }

  /** 收到投递回执:销账。返回 true 表示确有挂起条目(陌生回执返回 false,静默忽略)。 */
  confirm(offerId: string): boolean {
    const key = trackKeyFromOfferId(offerId);
    if (!key) return false;
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.clearTimerIfAny(entry);
    this.entries.delete(key);
    return true;
  }

  /** 当前挂起条目数(测试 / 诊断用)。 */
  get size(): number {
    return this.entries.size;
  }

  /** daemon 关闭:清掉所有定时器,账本作废。 */
  destroy(): void {
    this.destroyed = true;
    for (const entry of this.entries.values()) this.clearTimerIfAny(entry);
    this.entries.clear();
  }

  private schedule(entry: LedgerEntry): void {
    entry.timer = this.setTimer(() => this.tick(entry), this.intervalMs);
  }

  private tick(entry: LedgerEntry): void {
    if (this.destroyed) return;
    // 键可能已被 confirm/track 更新过(回执到达、或新会话重播换了条目),陈旧 tick 直接退出
    if (this.entries.get(entry.key) !== entry) return;
    const ok = this.send(entry.message, entry.target);
    if (ok) {
      entry.resends++;
      if (entry.resends >= this.maxResends) {
        this.entries.delete(entry.key);
        this.log(
          `offer to ${entry.key} exhausted ${this.maxResends} resends without receipt; ` +
            `dropping (peer may run an old version without offer-receipt)`,
        );
        return;
      }
    } else if (Date.now() - entry.trackingSince >= this.offlineDeadlineMs) {
      // 对端一直离线:不消耗重发次数,但也不能无限挂账(新会话重播会重新 track)
      this.entries.delete(entry.key);
      this.log(`offer to ${entry.key} unresolved while peer offline past deadline; dropped (replayed on next session)`);
      return;
    }
    this.schedule(entry);
  }

  private clearTimerIfAny(entry: LedgerEntry): void {
    if (entry.timer !== undefined) {
      this.clearTimer(entry.timer);
      entry.timer = undefined;
    }
  }
}
