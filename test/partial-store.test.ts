import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmDir } from './helpers.js';
import {
  PARTIAL_SUFFIX,
  PARTIAL_TTL_MS,
  SlotBitmap,
  entryFingerprint,
  partialPaths,
  pruneScratchFile,
  readManifest,
  removePartial,
  writeManifest,
  type PartialManifest,
} from '../src/partial-store.js';
import { hashBlock } from '../src/blockstore.js';
import type { IndexEntry } from '../src/index.js';

function ent(over: Partial<IndexEntry> & { path: string }): IndexEntry {
  return {
    version: new Map([['DEV-A', 1]]),
    size: 0,
    deleted: false,
    blocks: [],
    ...over,
  };
}

function manifest(over: Partial<PartialManifest> = {}): PartialManifest {
  return {
    v: 1,
    fingerprint: 'fp',
    cdc: false,
    slots: 8,
    bitmap: Buffer.from([0b00001111]).toString('base64'),
    startedAt: 1,
    updatedAt: 2,
    ...over,
  };
}

describe('SlotBitmap', () => {
  it('tracks slots by bit and survives a base64 round trip', () => {
    const b = new SlotBitmap(10);
    expect(b.count()).toBe(0);
    expect(b.full()).toBe(false);
    for (const i of [0, 3, 7, 8]) b.set(i);
    expect([b.has(0), b.has(1), b.has(3), b.has(7), b.has(8), b.has(9)]).toEqual([
      true, false, true, true, true, false,
    ]);
    expect(b.count()).toBe(4);
    // 跨 1 字节边界(第 8 位在第二个字节):槽位数与位图长度必须一致,否则续传读不回
    const back = new SlotBitmap(10, b.toBase64());
    expect([back.has(0), back.has(8), back.has(3)]).toEqual([true, true, true]);
    expect(back.count()).toBe(4);
    back.clear(8);
    expect(back.has(8)).toBe(false);
    expect(back.count()).toBe(3);
  });

  it('ignores out-of-range indices instead of corrupting neighbours', () => {
    const b = new SlotBitmap(3);
    b.set(-1);
    b.set(3);
    b.set(999);
    expect(b.count()).toBe(0);
    expect(b.has(-1)).toBe(false);
    expect(b.has(999)).toBe(false);
    b.set(2);
    expect(b.count()).toBe(1);
    expect(b.full()).toBe(false);
  });

  it('treats a zero-slot bitmap as immediately full (an empty file has nothing to receive)', () => {
    const b = new SlotBitmap(0);
    expect(b.full()).toBe(true);
    expect(b.count()).toBe(0);
  });

  it('rejects a base64 whose length does not match the slot count', () => {
    // 位图与槽位数必须严格同长:长度不符意味着这份位图根本不是说这个条目的
    expect(() => new SlotBitmap(20, Buffer.from([0xff]).toString('base64'))).toThrow(/长度不符/);
  });
});

describe('entryFingerprint', () => {
  it('is a statement about content only, not about version / mtime / path', () => {
    // 续传关心的是「已写进 tmp 的那些块,对当前条目还成不成立」。所以版本涨了、mtime 变了、
    // 文件换了名字,只要字节布局一样,已收的块就照样能用 —— 反过来 version 参与指纹会让
    // 每一次冲突裁决都白白丢掉进度。
    const base = ent({
      path: 'a.txt',
      size: 10,
      blocks: [hashBlock(Buffer.from('0123456789'))],
      mtime: 111,
    });
    const same = ent({ ...base, path: 'elsewhere/b.txt', mtime: 999 });
    const bumped = ent({ ...base, version: new Map([['DEV-A', 7], ['DEV-B', 2]]) });
    expect(entryFingerprint(same)).toBe(entryFingerprint(base));
    expect(entryFingerprint(bumped)).toBe(entryFingerprint(base));
  });

  it('changes with any of the four content-bearing fields', () => {
    const base = ent({
      path: 'a.txt',
      size: 4,
      blocks: [hashBlock(Buffer.from('aaaa'))],
      cdh: [hashBlock(Buffer.from('aa')), hashBlock(Buffer.from('aa'))],
      clens: [2, 2],
    });
    const variants = [
      ent({ ...base, size: 5 }),
      ent({ ...base, blocks: [hashBlock(Buffer.from('bbbb'))] }),
      ent({ ...base, cdh: [hashBlock(Buffer.from('aa')), hashBlock(Buffer.from('bb'))] }),
      // 块哈希没变、边界变了(内容被重新切过):tmp 的偏移布局就变了,必须作废
      ent({ ...base, clens: [1, 3] }),
    ];
    const seen = new Set(variants.map(entryFingerprint));
    expect(seen.has(entryFingerprint(base))).toBe(false);
    expect(seen.size).toBe(variants.length);
  });

  it('does not care whether the entry merely lacks an optional CDC view', () => {
    // 旧对端送来的条目没有 cdh:指纹要能算,且与「cdh 为空列表」同口径
    const noCdc = ent({ path: 'a.txt', size: 2, blocks: [hashBlock(Buffer.from('ab'))] });
    const emptyCdc = ent({ ...noCdc, cdh: [], clens: [] });
    expect(entryFingerprint(emptyCdc)).toBe(entryFingerprint(noCdc));
  });
});

describe('manifest sidecar', () => {
  it('reads back only what it was written for, and treats every mismatch as absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-partial-'));
    const p = join(dir, `a.txt${PARTIAL_SUFFIX}`);
    const want = { fingerprint: 'fp', cdc: false, slots: 8 };

    // 文件根本不存在
    expect(readManifest(p, want)).toBeNull();
    writeManifest(p, manifest());
    expect(readManifest(p, want)).toMatchObject({ slots: 8, cdc: false });

    // 坏 JSON / 结构版本不符 / 指纹不符 / 口径不符 / 槽位数不符 / 位图长度不符
    const bad: PartialManifest[] = [
      manifest({ fingerprint: 'other' }),
      manifest({ cdc: true }),
      manifest({ slots: 16 }),
      { ...manifest(), v: 2 as 1 },
    ];
    for (const m of bad) {
      writeManifest(p, m);
      expect(readManifest(p, want)).toBeNull();
    }
    writeFileSync(p, '{not json');
    expect(readManifest(p, want)).toBeNull();
    writeManifest(p, manifest({ bitmap: Buffer.from([0xff, 0xff]).toString('base64') }));
    expect(readManifest(p, want)).toBeNull();

    rmDir(dir);
  });

  it('removePartial takes both halves of the pair, always together', () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-partial-'));
    const target = join(dir, 'sub', 'a.txt');
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(`${target}.syncx-tmp`, 'half written');
    writeManifest(`${target}${PARTIAL_SUFFIX}`, manifest());

    removePartial(target);
    const { tmp, manifest: m } = partialPaths(target);
    expect(existsSync(tmp)).toBe(false);
    expect(existsSync(m)).toBe(false);
    // 目标从来没有中间态时也不能抛(落地后的收尾每轮都会调它)
    expect(() => removePartial(join(dir, 'nothing-here.txt'))).not.toThrow();

    rmDir(dir);
  });
});

describe('pruneScratchFile', () => {
  const DAY = 24 * 3600 * 1000;

  function touchOld(abs: string, ageMs: number): void {
    const t = (Date.now() - ageMs) / 1000; // utimesSync 的单位是秒
    utimesSync(abs, t, t);
  }

  it('leaves everything that is not a scratch name alone, without stat-ing it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-prune-'));
    writeFileSync(join(dir, 'notes.tmp'), 'user file');
    writeFileSync(join(dir, 'data.txt'), 'user file');
    const now = Date.now();
    expect(pruneScratchFile(dir, 'notes.tmp', now)).toBe(false);
    expect(pruneScratchFile(dir, 'data.txt', now)).toBe(false);
    expect(existsSync(join(dir, 'notes.tmp'))).toBe(true);
    rmDir(dir);
  });

  it('keeps a fresh pair (an in-flight receive must never be eaten by the sweeper)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-prune-'));
    writeFileSync(join(dir, 'a.bin.syncx-tmp'), 'progress');
    writeFileSync(join(dir, `a.bin${PARTIAL_SUFFIX}`), '{}');
    expect(pruneScratchFile(dir, 'a.bin.syncx-tmp', Date.now())).toBe(false);
    expect(existsSync(join(dir, 'a.bin.syncx-tmp'))).toBe(true);
    rmDir(dir);
  });

  it('reaps an expired pair from either half being seen first', () => {
    for (const seen of ['a.bin.syncx-tmp', `a.bin${PARTIAL_SUFFIX}`] as const) {
      const dir = mkdtempSync(join(tmpdir(), 'syncx-prune-'));
      writeFileSync(join(dir, 'a.bin.syncx-tmp'), 'nobody will resume this');
      writeFileSync(join(dir, `a.bin${PARTIAL_SUFFIX}`), '{}');
      touchOld(join(dir, 'a.bin.syncx-tmp'), PARTIAL_TTL_MS + DAY);
      touchOld(join(dir, `a.bin${PARTIAL_SUFFIX}`), PARTIAL_TTL_MS + DAY);

      expect(pruneScratchFile(dir, seen, Date.now())).toBe(true);
      expect(existsSync(join(dir, 'a.bin.syncx-tmp'))).toBe(false);
      expect(existsSync(join(dir, `a.bin${PARTIAL_SUFFIX}`))).toBe(false);
      rmDir(dir);
    }
  });

  it('reaps an orphan tmp that never had a manifest', () => {
    // 崩在「写完块、还没写位图」之间就是这种形态,而它恰恰最需要回收
    const dir = mkdtempSync(join(tmpdir(), 'syncx-prune-'));
    const tmp = join(dir, 'a.bin.syncx-tmp');
    writeFileSync(tmp, 'abandoned bytes');
    touchOld(tmp, PARTIAL_TTL_MS + DAY);
    expect(pruneScratchFile(dir, 'a.bin.syncx-tmp', Date.now())).toBe(true);
    expect(existsSync(tmp)).toBe(false);
    rmDir(dir);
  });

  it('is false, not an error, when the file vanished mid-scan', () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-prune-'));
    expect(pruneScratchFile(dir, 'already-gone.bin.syncx-tmp', Date.now())).toBe(false);
    rmDir(dir);
  });

  it('stays inside the TTL window exactly (one minute short is still kept)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-prune-'));
    const tmp = join(dir, 'a.bin.syncx-tmp');
    writeFileSync(tmp, 'bytes');
    touchOld(tmp, PARTIAL_TTL_MS - 60_000);
    expect(pruneScratchFile(dir, 'a.bin.syncx-tmp', Date.now())).toBe(false);
    expect(existsSync(tmp)).toBe(true);
    rmDir(dir);
  });
});
