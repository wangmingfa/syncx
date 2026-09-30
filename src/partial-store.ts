import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IndexEntry } from './index.js';
import { SCRATCH_SUFFIXES } from './ignore.js';

/**
 * 断点续传的落盘中间态:在途接收的块位图 + 条目指纹,以 JSON sidecar 形式躺在
 * 目标文件旁边(`<target>.syncx-partial`),与 `<target>.syncx-tmp` 成对出现/成对消失。
 *
 * 为什么是 sidecar 而不是把位图塞进 tmp 头部:tmp 的内容必须**就是**最终文件字节
 * (rename 即落地,不做二次搬运),任何头部都会污染它。
 *
 * 为什么指纹只看内容不看版本:续传关心的是「已写进 tmp 的那些块,对当前条目还成不成立」。
 * 块哈希列表 + CDC 视图 + 尺寸三者相同,字节布局就相同,版本向量变不变都无所谓
 * (对端 revert 回旧内容这种「版本变了内容没变」的情况,续传反而是对的)。
 * 反过来内容一变(哪怕一个块),指纹就变,旧 tmp 整份作废 —— 宁可重传,不可错接。
 */

/** 续传中间态文件后缀(与 .syncx-tmp 成对;扫描器/文件管理器都必须跳过这两个后缀)。 */
export const PARTIAL_SUFFIX = '.syncx-partial';

export interface PartialManifest {
  /** 结构版本,将来字段变更时拒绝旧文件(直接作废重传,不做迁移)。 */
  v: 1;
  fingerprint: string;
  cdc: boolean;
  slots: number;
  /** 位图的 base64(每 bit 一个槽位,1 = 该块已正确写入 tmp)。 */
  bitmap: string;
  startedAt: number;
  updatedAt: number;
}

/**
 * 条目内容指纹:尺寸 + 定长块哈希 + CDC 视图。
 * 刻意**不含** version / mtime / path:path 由文件名承载,version 与内容布局无关。
 */
export function entryFingerprint(entry: IndexEntry): string {
  const h = createHash('sha256');
  h.update(String(entry.size));
  h.update('\u0000');
  h.update(entry.blocks.join(','));
  h.update('\u0000');
  h.update((entry.cdh ?? []).join(','));
  h.update('\u0000');
  h.update((entry.clens ?? []).join(','));
  return h.digest('hex');
}

/** 位图:固定槽位数的 bitset,序列化成 base64。 */
export class SlotBitmap {
  private readonly buf: Uint8Array;
  constructor(readonly slots: number, base64?: string) {
    const bytes = Math.ceil(slots / 8);
    if (base64 !== undefined) {
      const decoded = Buffer.from(base64, 'base64');
      if (decoded.length !== bytes) throw new Error(`位图长度不符:期望 ${bytes} 字节,实际 ${decoded.length}`);
      this.buf = new Uint8Array(decoded);
    } else {
      this.buf = new Uint8Array(bytes);
    }
  }

  has(index: number): boolean {
    if (index < 0 || index >= this.slots) return false;
    return (this.buf[index >> 3]! & (1 << (index & 7))) !== 0;
  }

  set(index: number): void {
    if (index < 0 || index >= this.slots) return;
    this.buf[index >> 3]! |= 1 << (index & 7);
  }

  /** 清位:续传自检发现某块「位图说写了、盘上内容不对」时,把它退回缺失态重传。 */
  clear(index: number): void {
    if (index < 0 || index >= this.slots) return;
    this.buf[index >> 3]! &= ~(1 << (index & 7));
  }

  count(): number {
    let n = 0;
    for (const byte of this.buf) n += BIT_COUNT[byte]!;
    return n;
  }

  full(): boolean {
    return this.count() === this.slots;
  }

  toBase64(): string {
    return Buffer.from(this.buf).toString('base64');
  }
}

const BIT_COUNT: readonly number[] = (() => {
  const t = new Array<number>(256).fill(0);
  for (let i = 0; i < 256; i++) t[i] = (i & 1) + t[i >> 1]!;
  return t;
})();

/** 一个目标文件的两个中间态路径:在途内容(tmp)与在途位图(manifest),成对出现成对消失。 */
export function partialPaths(target: string): { tmp: string; manifest: string } {
  return { tmp: `${target}.syncx-tmp`, manifest: `${target}.syncx-partial` };
}

/** 读 manifest;不存在/损坏/结构不符一律返回 null(调用方按「无中间态」处理)。 */
export function readManifest(path: string, expect: { fingerprint: string; cdc: boolean; slots: number }): PartialManifest | null {
  if (!existsSync(path)) return null;
  let m: PartialManifest;
  try {
    m = JSON.parse(readFileSync(path, 'utf8')) as PartialManifest;
  } catch {
    return null;
  }
  if (m.v !== 1) return null;
  if (m.fingerprint !== expect.fingerprint) return null;
  if (m.cdc !== expect.cdc || m.slots !== expect.slots) return null;
  try {
    // 构造一次位图以校验 base64 与长度;坏的就当没有
    new SlotBitmap(m.slots, m.bitmap);
  } catch {
    return null;
  }
  return m;
}

export function writeManifest(path: string, m: PartialManifest): void {
  writeFileSync(path, JSON.stringify(m));
}

/** 成对删除 tmp 与 manifest(作废 / 落地完成后调用)。 */
export function removePartial(target: string): void {
  const { tmp, manifest } = partialPaths(target);
  for (const p of [tmp, manifest]) {
    try {
      rmSync(p, { force: true });
    } catch {
      /* 删不掉也无妨:下次 beginReceive 会再试,扫描器也会跳过这两个后缀 */
    }
  }
}

/**
 * 中间态的保鲜期:超过它就整对回收。
 *
 * 为什么必须有回收:接收中止的原因里有一类是「对端根本供不出这些块」(它的编辑器
 * tmp 中间文件进了索引又改名,2026-09-22 事故),这种半截 tmp 永远不会有人来续,
 * 也永远不会被宣告出去 —— 不回收就是用户共享目录里一堆没人认领的巨型文件。
 * 取 7 天:比任何合理的断线时长都长(断网一周的 NAS 应该重新规划而不是赌旧位图),
 * 又足够短,不至于把盘占死。集成测试可用 SYNCX_PARTIAL_TTL_MS 调短。
 */
export const PARTIAL_TTL_MS = Number(process.env.SYNCX_PARTIAL_TTL_MS) || 7 * 24 * 3600 * 1000;

/**
 * 扫描器遍历到一个中间态文件时顺手做的回收:超期就删掉**整对**(tmp 与 manifest 同进同出)。
 *
 * 判据用 tmp 自己的 mtime 而不是 manifest 里的 updatedAt:在途接收每落一块 mtime 就更新
 * 一次,7 天不动 = 确实没人续它;而「没有 manifest 的孤儿 tmp」连 updatedAt 都没有,
 * 却正是最需要回收的那种残骸。
 *
 * 只对**名字命中后缀**的目录项调用,非中间态一个 stat 都不多花 —— macOS/Linux 的
 * readdir 不带时间戳(Dirent.mtimeMs 是 undefined),时间只能现查。
 *
 * 返回 true 表示已删干净(调用方据此跳过后续)。删不掉(被别的管线攥着 / 已消失)不抛错:
 * 留到下一轮扫描再试。
 */
export function pruneScratchFile(dirAbs: string, name: string, now = Date.now()): boolean {
  const lower = name.toLowerCase();
  const suffix = SCRATCH_SUFFIXES.find((s) => lower.endsWith(s));
  if (suffix === undefined) return false;
  const abs = join(dirAbs, name);
  let mtimeMs: number;
  try {
    mtimeMs = statSync(abs).mtimeMs;
  } catch {
    return false; // 扫描途中它已经消失:没有可回收的东西
  }
  if (now - mtimeMs <= PARTIAL_TTL_MS) return false;
  // 去掉后缀得到目标文件本体:tmp 与它的 manifest 一起回收,不留半对
  removePartial(join(dirAbs, name.slice(0, name.length - suffix.length)));
  return !existsSync(abs);
}
