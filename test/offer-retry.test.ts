import { describe, expect, it } from 'vitest';
import { OfferRetryLedger, trackKeyFromOfferId, type TrackedOffer } from '../src/net/offer-retry.js';
import { makeOfferId } from '../src/offers.js';

/** 手动触发的定时器桩:测试决定何时走到下一轮重发。 */
function fakeTimers() {
  let queue: Array<{ id: number; fn: () => void }> = [];
  let nextId = 1;
  return {
    setTimer(fn: () => void) {
      const id = nextId++;
      queue.push({ id, fn });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer(timer: ReturnType<typeof setTimeout>) {
      queue = queue.filter((t) => t.id !== (timer as unknown as number));
    },
    /** 触发当前所有待执行的定时器(快照后执行,允许回调里重新排期)。 */
    fire() {
      const due = queue;
      queue = [];
      for (const t of due) t.fn();
    },
    get pending() {
      return queue.length;
    },
  };
}

function folderInvitation(to: string, folderId: string): TrackedOffer {
  return {
    kind: 'folder-invitation',
    offerId: makeOfferId('folder', to, folderId),
    fromDeviceId: 'MYDEVICE01',
    folderId,
    folderName: folderId,
  };
}

function pairingRequest(to: string): TrackedOffer {
  return {
    kind: 'pairing-request',
    offerId: makeOfferId('pair', to),
    fromDeviceId: 'MYDEVICE01',
  };
}

describe('trackKeyFromOfferId', () => {
  it('round-trips folder ids that contain colons (Windows paths)', () => {
    const offerId = makeOfferId('folder', 'AAA1111111', 'D:\\sync\\photos');
    expect(trackKeyFromOfferId(offerId)).toBe('AAA1111111|folder-invitation|D:\\sync\\photos');
  });

  it('maps pair ids to the pairing-request key', () => {
    const offerId = makeOfferId('pair', 'BBB2222222');
    expect(trackKeyFromOfferId(offerId)).toBe('BBB2222222|pairing-request|');
  });

  it('returns undefined for malformed ids', () => {
    expect(trackKeyFromOfferId('nope')).toBeUndefined();
    expect(trackKeyFromOfferId('hex:unknown:DEV')).toBeUndefined();
  });
});

describe('OfferRetryLedger', () => {
  it('resends an offer every tick until the receipt confirms it', () => {
    const timers = fakeTimers();
    const sent: TrackedOffer[] = [];
    const ledger = new OfferRetryLedger({
      send: (message) => {
        sent.push(message);
        return true;
      },
      intervalMs: 5000,
      maxResends: 5,
      setTimer: (fn) => timers.setTimer(fn),
      clearTimer: (t) => timers.clearTimer(t),
    });

    const invite = folderInvitation('PEER000001', 'docs');
    ledger.track(invite);
    expect(ledger.size).toBe(1);

    timers.fire();
    timers.fire();
    expect(sent.length).toBe(2); // 每轮 tick 重发一次

    expect(ledger.confirm(invite.offerId)).toBe(true);
    timers.fire();
    expect(sent.length).toBe(2); // 销账后不再重发
    expect(ledger.size).toBe(0);
    expect(timers.pending).toBe(0);
  });

  it('confirms the tracked entry when the receipt carries the FIRST offer id after a re-track', () => {
    // 接收方按 (from,kind,folderId) 去重:重播产生新随机前缀的 id,但它存的是
    // 首包 id、回执也带首包 id —— 销账必须按解析键而非 offerId 全等。
    const timers = fakeTimers();
    const ledger = new OfferRetryLedger({
      send: () => true,
      setTimer: (fn) => timers.setTimer(fn),
      clearTimer: (t) => timers.clearTimer(t),
    });
    const first = folderInvitation('PEER000001', 'docs');
    const replay = folderInvitation('PEER000001', 'docs'); // 新会话重播,随机前缀不同
    expect(replay.offerId).not.toBe(first.offerId);

    ledger.track(first);
    ledger.track(replay);
    expect(ledger.size).toBe(1); // 同键替换,不重复挂账

    expect(ledger.confirm(first.offerId)).toBe(true);
    expect(ledger.size).toBe(0);
  });

  it('drops the offer after maxResends without receipt (old peers never answer)', () => {
    const timers = fakeTimers();
    let sentCount = 0;
    const logs: string[] = [];
    const ledger = new OfferRetryLedger({
      send: () => {
        sentCount++;
        return true;
      },
      log: (m) => logs.push(m),
      intervalMs: 5000,
      maxResends: 3,
      setTimer: (fn) => timers.setTimer(fn),
      clearTimer: (t) => timers.clearTimer(t),
    });

    ledger.track(pairingRequest('PEER000001'));
    for (let i = 0; i < 6; i++) timers.fire();

    expect(sentCount).toBe(3); // 恰好上限次重发,绝不无限
    expect(ledger.size).toBe(0);
    expect(logs.join('\n')).toContain('exhausted 3 resends');
    expect(timers.pending).toBe(0); // 放弃后不留定时器
  });

  it('offline ticks do not consume resend budget, but past deadline drops', () => {
    const timers = fakeTimers();
    let online = false;
    const logs: string[] = [];
    const ledger = new OfferRetryLedger({
      send: () => online,
      log: (m) => logs.push(m),
      intervalMs: 5000,
      maxResends: 2,
      offlineDeadlineMs: 0, // 首次离线 tick 即超期,免赖真实时钟
      setTimer: (fn) => timers.setTimer(fn),
      clearTimer: (t) => timers.clearTimer(t),
    });

    ledger.track(folderInvitation('PEER000001', 'docs'));
    timers.fire(); // 离线 + 已超期 → 放弃(新会话重播会重新 track)
    expect(ledger.size).toBe(0);
    expect(logs.join('\n')).toContain('dropped');
  });

  it('confirm on unknown / malformed offerId is a silent no-op', () => {
    const ledger = new OfferRetryLedger({
      send: () => true,
      setTimer: (fn) => fakeTimers().setTimer(fn),
      clearTimer: () => {},
    });
    expect(ledger.confirm('garbage')).toBe(false);
    expect(ledger.confirm('hex:folder:DEV:x')).toBe(false); // 格式合法但没挂过账
    expect(ledger.size).toBe(0);
  });

  it('destroy clears all timers and blocks further tracking', () => {
    const timers = fakeTimers();
    let sentCount = 0;
    const ledger = new OfferRetryLedger({
      send: () => {
        sentCount++;
        return true;
      },
      setTimer: (fn) => timers.setTimer(fn),
      clearTimer: (t) => timers.clearTimer(t),
    });
    ledger.track(folderInvitation('PEER000001', 'docs'));
    expect(timers.pending).toBe(1);
    ledger.destroy();
    expect(timers.pending).toBe(0);
    ledger.track(folderInvitation('PEER000001', 'photos')); // destroy 后不再入账
    expect(ledger.size).toBe(0);
    timers.fire();
    expect(sentCount).toBe(0);
  });
});
