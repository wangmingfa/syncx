import { bench, describe } from 'vitest';

import { chunkContent, hashBlock } from '../src/blockstore.js';
import { isIgnored, parseIgnoreRules } from '../src/ignore.js';
import type { IndexEntry } from '../src/index.js';
import { decodeIndex, encodeIndex } from '../src/messages.js';
import { buildPlan } from '../src/plan.js';

/**
 * 核心算法基准:与 Rust `rust/crates/syncx-core/benches/core_bench.rs`、
 * MoonBit `moonbit/core/core_bench_test.mbt` 同一份确定性合成负载,跑四条热路径
 * (CDC 切块 / 单块 SHA-256 / 全量规划 / 忽略匹配)。跑法:`npm run bench`。
 * 跨后端只比量级与比例,绝对值受运行时与机器状态影响。
 *
 * 数据合成:Lehmer 随机 `state * 48271 % 2147483647`、种子 20261106 ——
 * 乘积 < 2^48,在 Number(double)里同样精确,三端可复现同一序列。
 */

function lcgNext(state: number): number {
  return (state * 48271) % 2147483647;
}

/**
 * 造 size 字节合成缓冲:LCG 逐字节,每 13 步插 64 字节平坦段,
 * 让 CDC 既有指纹命中的边界、也有走 CDC_MAX 强制收块的边界。
 */
function makeBytes(size: number): Buffer {
  const out = Buffer.alloc(size);
  let state = 20261106;
  let i = 0;
  while (i < size) {
    state = lcgNext(state);
    if (state % 13 === 0) {
      const fill = state % 251;
      for (let k = 0; k < 64 && i < size; k++) out[i++] = fill;
    } else {
      out[i++] = state % 256;
    }
  }
  return out;
}

/** 一条索引条目:blocks 用两个定长假哈希(内容不影响规划开销,长度影响)。 */
function makeEntry(path: string, size: number, b: number): IndexEntry {
  return {
    path,
    version: new Map([
      ['DEV-A', 1],
      ['DEV-B', b],
    ]),
    size,
    deleted: false,
    blocks: [
      '3a985a74119fb1b3eea7e1a5f7d0e2f6e5c8f0d2c1b0a9f8e7d6c5b4a3f2e1d0',
      'b9812a7c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8',
    ],
  };
}

/**
 * 规划负载:2000 条索引。4% 对端缺失(send),10% 对端更新(receive),
 * 其余双方一致(无动作)—— 三类路径都走到。
 */
function makePlanMaps(): [Map<string, IndexEntry>, Map<string, IndexEntry>] {
  const local = new Map<string, IndexEntry>();
  const remote = new Map<string, IndexEntry>();
  for (let i = 0; i < 2000; i++) {
    const path = `dir${i % 37}/file${i}.bin`;
    const size = i * 977 + 1024;
    local.set(path, makeEntry(path, size, 1));
    if (i % 25 === 0) continue;
    remote.set(path, makeEntry(path, size, i % 10 === 0 ? 2 : 1));
  }
  return [local, remote];
}

/** 忽略匹配负载:2000 条路径,命中/未命中/目录/文件混着,与同一份规则集对拍。 */
function makeIgnorePaths(): Array<[string, boolean]> {
  const out: Array<[string, boolean]> = [];
  let state = 20261106;
  for (let i = 0; i < 2000; i++) {
    state = lcgNext(state);
    const isDir = state % 4 === 0;
    const path =
      state % 7 === 0
        ? `node_modules/pkg${i % 40}/index.js`
        : state % 7 === 1
          ? `src/file${i}.ts`
          : state % 7 === 2
            ? `logs/app-${i % 12}.log`
            : state % 7 === 3
              ? `dist/bundle-${i % 20}.js`
              : state % 7 === 4
                ? `docs/guide/chapter${i % 9}.md`
                : state % 7 === 5
                  ? `tmp/cache-${i}.tmp`
                  : `assets/img-${i % 33}.png`;
    out.push([path, isDir]);
  }
  return out;
}

const IGNORE_LINES = [
  'node_modules/', '.git', '.syncx-trash', '*.log', '!keep.log', 'dist/',
  'build/', '*.tmp', 'temp/', 'coverage/', '*.pid', '*.seed', '.DS_Store',
  'logs/', '.idea/', '.vscode/', '*.bak', 'cache/', 'uploads/', '*.min.js',
];

// 负载在 bench 外一次生成:测的是算法本身,不是数据合成。
const CDC_DATA = makeBytes(4 * 1024 * 1024);
const HASH_BLOCK = makeBytes(64 * 1024);
const [PLAN_LOCAL, PLAN_REMOTE] = makePlanMaps();
const IGNORE_PATHS = makeIgnorePaths();
// 线上编解码负载:2000 条索引(全量索引交换,每次连接必付)。
const WIRE_ENTRIES: IndexEntry[] = Array.from({ length: 2000 }, (_, i) => ({
  ...makeEntry(`dir${i % 37}/file${i}.bin`, i * 977 + 1024, 1),
  mtime: 1750000000123.456,
}));
const WIRE_PAYLOAD = encodeIndex(WIRE_ENTRIES);

describe('syncx core（与 Rust/MoonBit 同负载）', () => {
  bench('cdc-4mib', () => {
    chunkContent(CDC_DATA);
  });

  bench('sha256-64k', () => {
    hashBlock(HASH_BLOCK);
  });

  bench('plan-2000', () => {
    buildPlan(PLAN_LOCAL, PLAN_REMOTE);
  });

  bench('ignore-2k', () => {
    const rules = parseIgnoreRules(IGNORE_LINES);
    for (const [path, isDir] of IGNORE_PATHS) isIgnored(rules, path, isDir);
  });

  bench('wire-encode-2000', () => {
    encodeIndex(WIRE_ENTRIES);
  });

  bench('wire-decode-2000', () => {
    decodeIndex(WIRE_PAYLOAD);
  });
});
