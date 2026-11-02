#!/usr/bin/env node
/**
 * 从 Node 实现导出 golden fixtures,供 Rust 侧 `syncx-core` 对拍。
 *
 * ADR-0025 第 7 节把「协议/算法互通」定为功能完整性的唯一可信标准。纯逻辑模块
 * (版本向量、传输规划、忽略规则、CDC 切块、时段判定、文件类别)最容易在移植时
 * **悄悄跑偏** —— 编译通过、逻辑看着等价、结果差一位,而症状是"这个文件永远同步不动"。
 * 所以这里不手写期望值,而是**直接跑 Node 实现**把输入输出固化下来。
 *
 * 用法:
 *   node_modules/.bin/tsx rust/scripts/gen-fixtures.mjs
 *
 * 产物 `rust/crates/syncx-core/fixtures/*.json` 提交入库:Rust 测试不需要 Node 也能跑。
 * 只有 Node 侧语义变了才重跑本脚本 —— 那时 Rust 测试会红,正是要的效果。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compareVersions, mergeVersions, incrementVersion } from '../../src/version.ts';
import { buildPlan, buildDeltaPlan, planPath } from '../../src/plan.ts';
import { parseIgnoreRules, isIgnored, isHardIgnored } from '../../src/ignore.ts';
import { splitIntoBlocks, hashBlock, chunkContent } from '../../src/blockstore.ts';
import { imageMimeOf, compareContentLimit } from '../../src/file-kind.ts';
import {
  normalizeSchedule,
  withinSchedule,
  scheduleIsUnbounded,
  nextScheduleChangeAt,
  formatScheduleSummary,
} from '../../src/schedule.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'crates', 'syncx-core', 'fixtures');
mkdirSync(OUT, { recursive: true });

/** 写一个 fixture 文件;末尾补换行,便于 git diff。 */
function write(name, value) {
  writeFileSync(join(OUT, name), `${JSON.stringify(value, null, 2)}\n`);
}

/* ------------------------------------------------------------------ *
 * 确定性的伪随机数据。**只存种子与长度,不存字节**:12MB 用例的 base64 会让
 * fixture 膨胀到 28MB。Rust 侧移植同一个 mulberry32 复现同一份字节
 * (见 crates/syncx-core/src/fixtures.rs 的 prng_bytes)。
 * 不用简单递增序列 —— CDC 的边界由内容决定,全零/线性字节会让指纹长期为 0,
 * 测不到真实边界分布。
 * ------------------------------------------------------------------ */
function prngBytes(seed, length) {
  const out = Buffer.alloc(length);
  let a = seed >>> 0;
  for (let i = 0; i < length; i++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    out[i] = (t ^ (t >>> 14)) & 0xff;
  }
  return out;
}

/* ============================ 版本向量 ============================ */

const VECTORS = {
  empty: {},
  a1: { A: 1 },
  a2: { A: 2 },
  a1b1: { A: 1, B: 1 },
  a2b1: { A: 2, B: 1 },
  a1b2: { A: 1, B: 2 },
  b1: { B: 1 },
  a1b1c1: { A: 1, B: 1, C: 1 },
};

function toVector(obj) {
  return new Map(Object.entries(obj));
}
function fromVector(v) {
  return Object.fromEntries([...v.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

const versionComparisons = [];
for (const [an, av] of Object.entries(VECTORS)) {
  for (const [bn, bv] of Object.entries(VECTORS)) {
    versionComparisons.push({
      a: fromVector(toVector(av)),
      b: fromVector(toVector(bv)),
      relation: compareVersions(toVector(av), toVector(bv)),
    });
  }
}

const versionMerges = [];
for (const [an, av] of Object.entries(VECTORS)) {
  for (const [bn, bv] of Object.entries(VECTORS)) {
    versionMerges.push({
      a: fromVector(toVector(av)),
      b: fromVector(toVector(bv)),
      merged: fromVector(mergeVersions(toVector(av), toVector(bv))),
    });
  }
}

const versionIncrements = Object.entries(VECTORS).map(([, v]) => ({
  input: fromVector(toVector(v)),
  device: 'NEW',
  result: fromVector(incrementVersion(toVector(v), 'NEW')),
}));

write('version.json', {
  comparisons: versionComparisons,
  merges: versionMerges,
  increments: versionIncrements,
});

/* ============================ 传输规划 ============================ */
//
// 两种规划语义必须分别覆盖:并集(全量索引)与只看消息侧(增量索引)。
// 历史上把增量按并集算导致两端无限互推(见 src/plan.ts 的注释),这组用例
// 就是防止 Rust 侧重演同一个事故。

/** 构造一个索引条目;version 用简单对象,size 用来区分内容。 */
function entry(path, versionObj, opts = {}) {
  return {
    path,
    version: toVector(versionObj),
    size: opts.size ?? 100,
    deleted: opts.deleted ?? false,
    blocks: opts.blocks ?? ['b1'],
  };
}

const RELATIONS = [
  // [名称, 本机条目, 对端条目]
  ['absent-both', undefined, undefined],
  ['local-only', entry('/x', { A: 1 }), undefined],
  ['remote-only', undefined, entry('/x', { A: 1 })],
  ['equal', entry('/x', { A: 1 }), entry('/x', { A: 1 })],
  ['local-newer', entry('/x', { A: 2 }), entry('/x', { A: 1 })],
  ['remote-newer', entry('/x', { A: 1 }), entry('/x', { A: 2 })],
  ['conflict', entry('/x', { A: 1, B: 1 }), entry('/x', { A: 1, C: 1 })],
  ['local-deleted-newer', entry('/x', { A: 2 }, { deleted: true }), entry('/x', { A: 1 })],
  ['remote-deleted-newer', entry('/x', { A: 1 }), entry('/x', { A: 2 }, { deleted: true })],
  ['local-deleted-equal', entry('/x', { A: 1 }, { deleted: true }), entry('/x', { A: 1 }, { deleted: true })],
];

/** 条目里的 version 是 `Map`,`JSON.stringify` 会把它写成 `{}` —— 必须显式转对象。 */
function entryToJson(e) {
  if (e === undefined) return null;
  return { ...e, version: fromVector(e.version) };
}

/**
 * 规划动作转 JSON:send/receive 的 `entry`、conflict 的 `local`/`remote` 都含 Map。
 * 直接在 action 上 JSON.stringify 会把版本向量一起丢成 `{}`,Rust 侧只会看到空向量,
 * 于是每条都判成 equal —— 测试照样"通过",而对拍实际上什么都没测到。
 */
function actionToJson(action) {
  if (action === undefined) return null;
  switch (action.kind) {
    case 'send':
    case 'receive':
      return { kind: action.kind, path: action.path, entry: entryToJson(action.entry) };
    case 'delete':
      return { kind: action.kind, path: action.path };
    case 'conflict':
      return {
        kind: action.kind,
        path: action.path,
        local: entryToJson(action.local),
        remote: entryToJson(action.remote),
      };
    default:
      throw new Error(`未知动作 ${action.kind}`);
  }
}

const planPathCases = RELATIONS.map(([name, l, r]) => ({
  name,
  local: entryToJson(l),
  remote: entryToJson(r),
  action: actionToJson(planPath('/x', l, r)),
}));

/** 多路径场景:同时存在只在本地、只在对端、冲突的路径。 */
function buildScenario() {
  const local = new Map();
  const remote = new Map();
  local.set('/same', entry('/same', { A: 1 }));
  remote.set('/same', entry('/same', { A: 1 }));
  local.set('/local-only', entry('/local-only', { A: 1 }));
  remote.set('/remote-only', entry('/remote-only', { A: 1 }));
  local.set('/local-newer', entry('/local-newer', { A: 2 }));
  remote.set('/local-newer', entry('/local-newer', { A: 1 }));
  local.set('/remote-newer', entry('/remote-newer', { A: 1 }));
  remote.set('/remote-newer', entry('/remote-newer', { A: 2 }));
  local.set('/conflict', entry('/conflict', { A: 1, B: 1 }));
  remote.set('/conflict', entry('/conflict', { A: 1, C: 1 }));
  return { local, remote };
}

const scenario = buildScenario();
const asObject = (m) => fromVectorOnly(Object.fromEntries([...m].map(([k, v]) => [k, entryToJson(v)])));

/** 让对象键序稳定,便于 diff。 */
function fromVectorOnly(obj) {
  const out = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k];
  return out;
}

/** 规划结果按路径排序后输出,避免 Map 插入顺序影响 fixture。 */
function planToJsonSorted(actions) {
  return [...actions]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map(actionToJson);
}

write('plan.json', {
  pathCases: planPathCases,
  full: {
    local: asObject(scenario.local),
    remote: asObject(scenario.remote),
    actions: planToJsonSorted(buildPlan(scenario.local, scenario.remote)),
  },
  delta: {
    local: asObject(scenario.local),
    remote: asObject(scenario.remote),
    actions: planToJsonSorted(buildDeltaPlan(scenario.local, scenario.remote)),
  },
});

/* ============================ 忽略规则 ============================ */

const IGNORE_RULE_SETS = [
  ['builtin', ['node_modules/', '.git/', '*.log', '!important.log']],
  ['anchored', ['/root.txt', 'build/', 'sub/build/']],
  ['double-star', ['a/**/b', 'a/**', 'logs/**']],
  ['single-star', ['*.tmp', 'dir/*.bak', 'q?.txt']],
  ['literal', ['secret.txt', 'nested/secret.txt']],
  ['nested-negation', ['*.log', '!keep/**', '!keep/deep.log']],
  ['brackets', ['file[0-9].txt']],
  ['escapes', ['a.b.c', 'x+y.txt']],
];

const IGNORE_PATHS = [
  'node_modules',
  'node_modules/pkg/index.js',
  'admin/node_modules/pkg/index.js',
  '.git/config',
  'app.log',
  'src/app.log',
  'important.log',
  'root.txt',
  'sub/root.txt',
  'build',
  'build/out.o',
  'sub/build/x.o',
  'a/b',
  'a/x/b',
  'a/x/y/b',
  'a/foo',
  'logs/2026/10.txt',
  'x.tmp',
  'dir/x.bak',
  'q1.txt',
  'q12.txt',
  'secret.txt',
  'nested/secret.txt',
  'keep/deep.log',
  'keep/other.txt',
  'file9.txt',
  'fileA.txt',
  'a.b.c',
  'x+y.txt',
  'sync-conflict-file.sync-conflict-20260101-abcd1234-ABCDEFGHIJ.txt',
];

const ignoreCases = [];
for (const [setName, lines] of IGNORE_RULE_SETS) {
  const rules = parseIgnoreRules(lines);
  for (const p of IGNORE_PATHS) {
    for (const isDir of [false, true]) {
      ignoreCases.push({ set: setName, rules: lines, path: p, isDir, ignored: isIgnored(rules, p, isDir) });
    }
  }
}

const hardIgnorePaths = [
  '.git',
  '.git/config',
  'sub/.git/HEAD',
  '.hg/x',
  '.svn/x',
  '.syncx-trash/x',
  '.syncx-folder/x',
  '.github/workflows',
  '.svnignore',
  'a/x.syncx-tmp',
  'a/x.syncx-partial',
  'a/X.SYNCX-TMP',
  'normal/file.txt',
  'dir/file.sync-conflict-20260101-ab12cd34-ABCDEFGHIJ.txt',
];

write('ignore.json', {
  ruleSets: IGNORE_RULE_SETS.map(([name, lines]) => ({ name, lines })),
  cases: ignoreCases,
  hardIgnored: hardIgnorePaths.map((p) => ({ path: p, hard: isHardIgnored(p) })),
});

/* ============================ 分块与哈希 ============================ */

const BLOCK_CASES = [
  { name: 'empty', seed: 1, size: 0 },
  { name: 'one-byte', seed: 2, size: 1 },
  { name: 'sub-block', seed: 3, size: 64 * 1024 },
  { name: 'exact-block', seed: 4, size: 1024 * 1024 },
  { name: 'block-plus-one', seed: 5, size: 1024 * 1024 + 1 },
  { name: 'three-blocks', seed: 6, size: 3 * 1024 * 1024 + 12345 },
  { name: 'cdc-small', seed: 7, size: 300 * 1024 },
  { name: 'cdc-medium', seed: 8, size: 4 * 1024 * 1024 },
  { name: 'cdc-large', seed: 9, size: 12 * 1024 * 1024 },
];

const blockCases = BLOCK_CASES.map(({ name, seed, size }) => {
  const data = prngBytes(seed, size);
  const fixed = splitIntoBlocks(data);
  const cdc = chunkContent(data);
  return {
    name,
    seed,
    size,
    fixed: fixed.map((b) => ({ length: b.length, sha256: hashBlock(b) })),
    cdc: cdc.map((c) => ({ length: c.length, sha256: hashBlock(c) })),
  };
});

write('blocks.json', { cases: blockCases });

/* ============================ 文件类别 ============================ */

const KIND_PATHS = [
  'a.png',
  'a.PNG',
  'dir/a.jpg',
  'a.jpeg',
  'a.gif',
  'a.webp',
  'a.bmp',
  'a.ico',
  'a.avif',
  'a.svg',
  'a.tiff',
  'a.txt',
  'a',
  '.env',
  '.hidden.png',
  'dir.d/file',
  'noext/dir.name/file',
  'a.tar.gz',
  '',
];

write('file-kind.json', {
  cases: KIND_PATHS.map((p) => ({
    path: p,
    mime: imageMimeOf(p) ?? null,
    limit: compareContentLimit(p),
  })),
});

/* ============================ 同步时段 ============================ */
//
// 刻意把「此刻」拆成 (年,月,日,当天第几分钟,星期几) 再喂给 Node 实现:
// 直接用 Date 会让 fixture 依赖运行机器的时区,换台机器对拍就红。
// Rust 侧同样按这套分解量计算,两边都不碰时区。

/** 由民用日期直接算星期几(0=周日),与 JS Date.getDay() 同口径。 */
function dowOf(y, m, d) {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function localClock(y, m, d, hh, mm) {
  return new Date(y, m - 1, d, hh, mm, 0, 0);
}

/** 由毫秒时间戳反解成 (y,m,d,minutes),用本地时区 —— 与 input 构造时同一口径。 */
function decompose(ms) {
  const dt = new Date(ms);
  return {
    year: dt.getFullYear(),
    month: dt.getMonth() + 1,
    day: dt.getDate(),
    minutes: dt.getHours() * 60 + dt.getMinutes(),
  };
}

const SCHEDULE_INPUTS = [
  { name: 'undefined', raw: undefined },
  { name: 'empty-array', raw: [] },
  { name: 'legacy-string', raw: '22:00-08:00' },
  { name: 'legacy-same', raw: '09:00-09:00' },
  { name: 'legacy-garbage', raw: 'nonsense' },
  { name: 'legacy-out-of-range', raw: '25:00-08:00' },
  {
    name: 'workday-window',
    raw: [{ days: { kind: 'workday' }, windows: [{ from: '09:00', to: '18:00' }] }],
  },
  {
    name: 'any-with-overnight',
    raw: [{ days: { kind: 'any' }, windows: [{ from: 1320, to: 480 }] }],
  },
  {
    name: 'dow-subset',
    raw: [{ days: { kind: 'dow', days: [1, 3, 5] }, windows: [{ from: 600, to: 700 }] }],
  },
  {
    name: 'dow-all-seven-collapses',
    raw: [{ days: { kind: 'dow', days: [0, 1, 2, 3, 4, 5, 6] }, windows: [{ from: 600, to: 700 }] }],
  },
  {
    name: 'dow-empty-collapses',
    raw: [{ days: { kind: 'dow', days: [] }, windows: [{ from: 600, to: 700 }] }],
  },
  {
    name: 'flat-window-shorthand',
    raw: [{ days: { kind: 'any' }, from: '08:00', to: '10:00' }],
  },
  {
    name: 'zero-length-window-is-unbounded',
    raw: [{ days: { kind: 'workday' }, windows: [{ from: 540, to: 540 }] }],
  },
  {
    name: 'dedupes-windows',
    raw: [
      {
        days: { kind: 'any' },
        windows: [
          { from: 540, to: 600 },
          { from: 540, to: 600 },
          { from: 660, to: 720 },
        ],
      },
    ],
  },
  {
    name: 'drops-bad-windows',
    raw: [{ days: { kind: 'any' }, windows: [{ from: 'abc', to: 600 }, { from: 700, to: 800 }] }],
  },
  { name: 'two-rules-or', raw: [
    { days: { kind: 'workday' }, windows: [{ from: '09:00', to: '18:00' }] },
    { days: { kind: 'offday' }, windows: [{ from: '10:00', to: '20:00' }] },
  ] },
];

/** 工作日判定用固定表注入,消除节假日数据与时区依赖。 */
const WORKDAY_DATES = new Set(['2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31']);
const isWorkdayFixed = (date) => {
  const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return WORKDAY_DATES.has(key);
};

const CLOCK_SAMPLES = [
  [2026, 10, 28, 8, 59],
  [2026, 10, 28, 9, 0],
  [2026, 10, 28, 12, 0],
  [2026, 10, 28, 17, 59],
  [2026, 10, 28, 18, 0],
  [2026, 10, 28, 23, 30],
  [2026, 10, 29, 0, 30],
  [2026, 10, 31, 13, 0],
  [2026, 11, 1, 11, 0],
];

const scheduleCases = SCHEDULE_INPUTS.map(({ name, raw }) => {
  const normalized = normalizeSchedule(raw);
  return {
    name,
    raw: raw === undefined ? null : raw,
    normalized: normalized ?? null,
    unbounded: scheduleIsUnbounded(normalized),
    summary: formatScheduleSummary(normalized),
    evaluations: CLOCK_SAMPLES.map(([y, m, d, hh, mm]) => {
      const at = localClock(y, m, d, hh, mm);
      return {
        year: y,
        month: m,
        day: d,
        minutes: hh * 60 + mm,
        dow: dowOf(y, m, d),
        allowed: withinSchedule(normalized, at, isWorkdayFixed),
      };
    }),
    nextChanges: CLOCK_SAMPLES.slice(0, 4).map(([y, m, d, hh, mm]) => {
      const at = localClock(y, m, d, hh, mm);
      const next = nextScheduleChangeAt(normalized, at, isWorkdayFixed);
      return {
        from: { year: y, month: m, day: d, minutes: hh * 60 + mm },
        next: next === undefined ? null : decompose(next),
      };
    }),
  };
});

write('schedule.json', {
  workdays: [...WORKDAY_DATES],
  cases: scheduleCases,
});

console.log(`fixtures 已写入 ${OUT}`);
