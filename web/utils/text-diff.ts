/**
 * 行级文本差异(IDEA 风格的并排对比用)。
 *
 * 纯函数、可单测:输入两段文本,输出逐行对齐的结果 + 可直接「按块应用」的差异块。
 *
 * ## 参照系:git 的 xdiff(默认 Myers,非 histogram/patience)
 *
 * 本文件按 git 默认 diff 管线逐段移植,运行期零依赖(不 spawn git、不引 diff 库、
 * 无 wasm)。参照源码:git 2.45.x 的 xdiff/xdiffi.c、xprepare.c、xemit.c
 * (master @ 2026-10);上游算法或后处理若变更,本实现不会自动跟进,需人工重新比对。
 *
 * 管线与 git 一一对应:
 *  1. 分类(xdl_classify_record):行内容 → 整数类号。行身份 = 归一化文本 +
 *     「是否有行尾换行」—— git 的行记录自带 '\n',最后一行没有换行就是另一条
 *     记录(差异里表现为该行 change + "\ No newline at end of file")。
 *  2. xdl_trim_ends:剥公共前后缀。
 *  3. xdl_cleanup_records:与对侧零匹配的行直接标改(DISCARD —— 反正不可能匹配,
 *     提前标掉能让它们不参与搜索);高频行(在对侧出现次数 >= bogosqrt(行数),
 *     上限 XDL_MAX_EQLIMIT)按 xdl_clean_mmatch 的窗口规则决定去留 —— 这就是
 *     git 对大量重复行(空行、"{"、"ua")撑爆 D 的保护。
 *  4. xdl_split / xdl_recs_cmp:Myers O(ND) 贪心 + 线性空间分治,含 mxcost
 *     启发式二分。所以产出的是「git 同款」的近似最小 diff —— git 默认不开
 *     --diff-algorithm=minimal,XDF_MAX_COST 类预算超了就二分,不是严格最小。
 *  5. xdl_change_compact:把改动块边界上下滑到最整齐的位置(对齐相邻组的改动、
 *     减少碎块),这是 git diff 输出观感的主要来源。含缩进启发式:git 2.14 起
 *     diff.indentHeuristic 默认开启(XDF_INDENT_HEURISTIC),滑动自由度先看
 *     能否与对侧组对齐,不能就按 measure_split/score_add_split 的缩进得分落位
 *     —— 权重逐个照抄 xdiffi.c,少一个分支结果就会分叉。
 *  6. xdl_build_script:changed[] → 变更组;再组装成并排行与按块应用的差异块。
 *
 * ## 与 git 的显式偏差(调用方依赖的既有行为,不能改)
 *
 * prepare() 先把 CRLF/CR 归一化成 LF 再切行;git 按原始字节比。只影响两侧行尾
 * 风格不一致的场景 —— 同步工具里 CRLF/LF 混排常见,UI 不想为此刷红。两侧风格
 * 一致时归一化对结构无影响,与 git 的 hunk 仍逐一对得上。
 *
 * ## 为什么不是「DP + 兜底」
 *
 * 旧实现是 O(n*m) 整表 DP,超过 150 万格就退化成「整段替换」:一份 6368 行的
 * 真实文件对(剥完前后缀中段 5883×5768 ≈ 3394 万格)远超预算,被兜底成
 * 「5883 行全改了」,还把 5768 行塞进一个可整块应用的 hunk —— 用户点一下
 * 「应用到原文件」就会盲改近六千行。整表 DP 与不诚实的兜底都已删除:Myers 的
 * 空间是 O(N)(kvd + changed 数组,几万行也只占几百 KB),时间 O(ND),差异
 * 稀疏时 D 很小;退化路径与 git 相同(启发式二分,子盒继续真比)。任何路径下
 * 每一行都真实参与过比对,不存在「没比却标成全改」的谎言。
 */

export type LineType = 'same' | 'change' | 'del' | 'add';

export interface DiffLine {
  /** 左侧行号(1 基);该行只在右侧存在时缺省。 */
  leftNo?: number;
  leftText?: string;
  rightNo?: number;
  rightText?: string;
  type: LineType;
}

export interface DiffHunk {
  /** 在 rows 中的区间:[start, end)。 */
  start: number;
  end: number;
  /** 两侧对应的行区间(0 基),按块应用时直接对行数组 splice。 */
  leftStart: number;
  leftCount: number;
  rightStart: number;
  rightCount: number;
}

export interface TextDiff {
  rows: DiffLine[];
  hunks: DiffHunk[];
}

/** git -U3 语义的 hunk 头(0 基区间),仅供与 git 的对拍测试使用。 */
export interface GitStyleHunk {
  start1: number;
  count1: number;
  start2: number;
  count2: number;
}

// —— git xdiff 常量(xdiffi.c / xprepare.c 原值)——

const XDL_MAX_COST_MIN = 256;
const XDL_HEUR_MIN_COST = 256;
const XDL_SNAKE_CNT = 20;
const XDL_K_HEUR = 4;
const XDL_KPDIS_RUN = 4;
const XDL_MAX_EQLIMIT = 1024;
const XDL_SIMSCAN_WINDOW = 100;
/** kvdb 的哨兵值,对应 XDL_LINE_MAX(C 的 long 上限,这里取 Int32 安全值)。 */
const KVD_LINE_MAX = 0x7fffffff;
const DISCARD = 0;
const KEEP = 1;
const INVESTIGATE = 2;

/** xdl_bogosqrt:git 的整数平方根近似(按 2 位右移计数)。 */
function bogosqrt(n: number): number {
  let i = 1;
  for (; n > 0; n >>= 2) i <<= 1;
  return i;
}

// —— 文本准备 ——

interface Prepared {
  lines: string[];
  /** 每行是否以换行结尾;只有最后一行可能是 0(行身份的一部分,见文件头)。 */
  terms: Uint8Array;
}

function prepare(text: string): Prepared {
  const norm = text.replace(/\r\n?/g, '\n');
  const trailing = norm.endsWith('\n');
  const body = trailing ? norm.slice(0, -1) : norm;
  const lines = body === '' ? [] : body.split('\n');
  const terms = new Uint8Array(lines.length);
  terms.fill(1);
  if (lines.length > 0) terms[lines.length - 1] = trailing ? 1 : 0;
  return { lines, terms };
}

// —— 分类与预处理(xprepare.c)——

interface Env {
  n1: number;
  n2: number;
  /** 实际行号(0 基)→ 类号。 */
  ids1: Int32Array;
  ids2: Int32Array;
  /** 实际行号 → 是否变更(算法全程往这里打标)。 */
  chg1: Uint8Array;
  chg2: Uint8Array;
  /** 参与搜索的行(实际行号,来自 trim 后的区间),及对应类号(get_hash 等价物)。 */
  eff1: Int32Array;
  eff2: Int32Array;
  hid1: Int32Array;
  hid2: Int32Array;
  nreff1: number;
  nreff2: number;
  /** Myers 的 K 值数组;前半是 forward、后半是 backward,各自带对角线偏移。 */
  kvd: Int32Array;
  kvdfBase: number;
  kvdbBase: number;
  mxcost: number;
}

function prepareEnv(left: string, right: string): { a: Prepared; b: Prepared; x: Env } {
  const a = prepare(left);
  const b = prepare(right);
  const n1 = a.lines.length;
  const n2 = b.lines.length;

  // 分类:类号即「行身份」。git 的记录含 '\n',所以无换行的末行是独立身份。
  const classOf = new Map<string, number>();
  const cnt1: number[] = [];
  const cnt2: number[] = [];
  const intern = (line: string, term: number, side: 1 | 2): number => {
    // 'N'/'E' 前缀区分有无行尾换行;不能用拼接 '\0' 兜底 —— 行内容本身可能含 \0
    const key = (term ? 'N' : 'E') + line;
    let id = classOf.get(key);
    if (id === undefined) {
      id = cnt1.length;
      cnt1.push(0);
      cnt2.push(0);
      classOf.set(key, id);
    }
    if (side === 1) cnt1[id]!++;
    else cnt2[id]!++;
    return id;
  };
  const ids1 = new Int32Array(n1);
  const ids2 = new Int32Array(n2);
  for (let i = 0; i < n1; i++) ids1[i] = intern(a.lines[i]!, a.terms[i]!, 1);
  for (let j = 0; j < n2; j++) ids2[j] = intern(b.lines[j]!, b.terms[j]!, 2);

  // xdl_trim_ends
  let i = 0;
  const lim = Math.min(n1, n2);
  while (i < lim && ids1[i] === ids2[i]) i++;
  const dstart = i;
  let j = 0;
  const blim = lim - i;
  while (j < blim && ids1[n1 - 1 - j] === ids2[n2 - 1 - j]) j++;
  const dend1 = n1 - j - 1;
  const dend2 = n2 - j - 1;

  const x: Env = {
    n1,
    n2,
    ids1,
    ids2,
    chg1: new Uint8Array(n1),
    chg2: new Uint8Array(n2),
    eff1: new Int32Array(Math.max(0, dend1 - dstart + 1)),
    eff2: new Int32Array(Math.max(0, dend2 - dstart + 1)),
    hid1: new Int32Array(0),
    hid2: new Int32Array(0),
    nreff1: 0,
    nreff2: 0,
    kvd: new Int32Array(0),
    kvdfBase: 0,
    kvdbBase: 0,
    mxcost: XDL_MAX_COST_MIN,
  };

  cleanupRecords(x, dstart, dend1, dend2, cnt1, cnt2);

  // xdl_do_diff:K 向量与搜索预算。对角线 d 的合法范围是
  // [-(nreff2+1), nreff1+1] ∪ [bmid-(nreff2+1), …],照抄 C 的偏移方式。
  const ndiags = x.nreff1 + x.nreff2 + 3;
  x.kvd = new Int32Array(2 * ndiags + 2);
  x.kvdfBase = x.nreff2 + 1;
  x.kvdbBase = ndiags + x.nreff2 + 1;
  x.mxcost = Math.max(bogosqrt(ndiags), XDL_MAX_COST_MIN);

  return { a, b, x };
}

/** xdl_cleanup_records:决定 trim 后区间里哪些行进搜索(DISCARD 的直接标改)。 */
function cleanupRecords(
  x: Env,
  dstart: number,
  dend1: number,
  dend2: number,
  cnt1: number[],
  cnt2: number[],
): void {
  const len1 = dend1 - dstart + 1;
  const len2 = dend2 - dstart + 1;
  if (len1 <= 0 && len2 <= 0) return;

  // git 用整文件行数求 mlim(不是区间长度),照抄 —— 语义是「重复行占比」。
  const mlim1 = Math.min(bogosqrt(x.n1), XDL_MAX_EQLIMIT);
  const mlim2 = Math.min(bogosqrt(x.n2), XDL_MAX_EQLIMIT);

  const action1 = new Uint8Array(Math.max(0, len1));
  const action2 = new Uint8Array(Math.max(0, len2));
  for (let k = 0; k < len1; k++) {
    const nm = cnt2[x.ids1[k + dstart]!] ?? 0;
    action1[k] = nm === 0 ? DISCARD : nm < mlim1 ? KEEP : INVESTIGATE;
  }
  for (let k = 0; k < len2; k++) {
    const nm = cnt1[x.ids2[k + dstart]!] ?? 0;
    action2[k] = nm === 0 ? DISCARD : nm < mlim2 ? KEEP : INVESTIGATE;
  }

  x.nreff1 = 0;
  for (let k = 0; k < len1; k++) {
    let action = action1[k]!;
    if (action === INVESTIGATE) action = cleanMmatch(action1, k, len1) ? DISCARD : KEEP;
    const real = k + dstart;
    if (action === KEEP) x.eff1[x.nreff1++] = real;
    else if (action === DISCARD) x.chg1[real] = 1;
  }
  x.nreff2 = 0;
  for (let k = 0; k < len2; k++) {
    let action = action2[k]!;
    if (action === INVESTIGATE) action = cleanMmatch(action2, k, len2) ? DISCARD : KEEP;
    const real = k + dstart;
    if (action === KEEP) x.eff2[x.nreff2++] = real;
    else if (action === DISCARD) x.chg2[real] = 1;
  }

  x.hid1 = new Int32Array(x.nreff1);
  x.hid2 = new Int32Array(x.nreff2);
  for (let k = 0; k < x.nreff1; k++) x.hid1[k] = x.ids1[x.eff1[k]!]!;
  for (let k = 0; k < x.nreff2; k++) x.hid2[k] = x.ids2[x.eff2[k]!]!;
}

/** xdl_clean_mmatch:高频行只有在「无匹配行组成的带子」中间才被丢弃。 */
function cleanMmatch(action: Uint8Array, i: number, len: number): boolean {
  let s = 0;
  let e = len - 1;
  if (i - s > XDL_SIMSCAN_WINDOW) s = i - XDL_SIMSCAN_WINDOW;
  if (e - i > XDL_SIMSCAN_WINDOW) e = i + XDL_SIMSCAN_WINDOW;

  let rdis0 = 0;
  let rpdis0 = 1;
  for (let r = 1; i - r >= s; r++) {
    const a = action[i - r]!;
    if (a === DISCARD) rdis0++;
    else if (a === INVESTIGATE) rpdis0++;
    else break;
  }
  if (rdis0 === 0) return false;

  let rdis1 = 0;
  let rpdis1 = 1;
  for (let r = 1; i + r <= e; r++) {
    const a = action[i + r]!;
    if (a === DISCARD) rdis1++;
    else if (a === INVESTIGATE) rpdis1++;
    else break;
  }
  if (rdis1 === 0) return false;

  return (rpdis0 + rpdis1) * XDL_KPDIS_RUN < rpdis0 + rpdis1 + rdis0 + rdis1;
}

// —— Myers 内核(xdiffi.c 的 xdl_split / xdl_recs_cmp)——

interface Split {
  i1: number;
  i2: number;
  minLo: boolean;
  minHi: boolean;
}

/**
 * 在盒子 [off1,lim1)×[off2,lim2) 里找分裂点:双向 Myers 相向推进,相遇即最小
 * 分裂;代价超阈值时走 git 的两条启发式(带蛇形的采样 / mxcost 的最远点),
 * 所以结果可能与严格最小 diff 不同 —— 这是刻意的,目标是与 git 一致。
 */
function xdlSplit(x: Env, off1: number, lim1: number, off2: number, lim2: number, needMin: boolean): Split {
  const kvd = x.kvd;
  const fd = x.kvdfBase;
  const bd = x.kvdbBase;
  const hid1 = x.hid1;
  const hid2 = x.hid2;
  const dmin = off1 - lim2;
  const dmax = lim1 - off2;
  const fmid = off1 - off2;
  const bmid = lim1 - lim2;
  const odd = (fmid - bmid) & 1;
  let fmin = fmid;
  let fmax = fmid;
  let bmin = bmid;
  let bmax = bmid;

  kvd[fd + fmid] = off1;
  kvd[bd + bmid] = lim1;

  for (let ec = 1; ; ec++) {
    let gotSnake = 0;

    // 扩对角线窗口;顶到盒边时反向收缩(C 注释:(max-min) 须保持 2 的幂)
    if (fmin > dmin) {
      fmin--;
      kvd[fd + fmin - 1] = -1;
    } else fmin++;
    if (fmax < dmax) {
      fmax++;
      kvd[fd + fmax + 1] = -1;
    } else fmax--;

    for (let d = fmax; d >= fmin; d -= 2) {
      let i1 = kvd[fd + d - 1]! >= kvd[fd + d + 1]! ? kvd[fd + d - 1]! + 1 : kvd[fd + d + 1]!;
      const prev1 = i1;
      let i2 = i1 - d;
      for (; i1 < lim1 && i2 < lim2 && hid1[i1] === hid2[i2]; i1++, i2++);
      if (i1 - prev1 > XDL_SNAKE_CNT) gotSnake = 1;
      kvd[fd + d] = i1;
      if (odd !== 0 && bmin <= d && d <= bmax && kvd[bd + d]! <= i1) {
        return { i1, i2, minLo: true, minHi: true };
      }
    }

    if (bmin > dmin) {
      bmin--;
      kvd[bd + bmin - 1] = KVD_LINE_MAX;
    } else bmin++;
    if (bmax < dmax) {
      bmax++;
      kvd[bd + bmax + 1] = KVD_LINE_MAX;
    } else bmax--;

    for (let d = bmax; d >= bmin; d -= 2) {
      let i1 = kvd[bd + d - 1]! < kvd[bd + d + 1]! ? kvd[bd + d - 1]! : kvd[bd + d + 1]! - 1;
      const prev1 = i1;
      let i2 = i1 - d;
      for (; i1 > off1 && i2 > off2 && hid1[i1 - 1] === hid2[i2 - 1]; i1--, i2--);
      if (prev1 - i1 > XDL_SNAKE_CNT) gotSnake = 1;
      kvd[bd + d] = i1;
      if (odd === 0 && fmin <= d && d <= fmax && i1 <= kvd[fd + d]!) {
        return { i1, i2, minLo: true, minHi: true };
      }
    }

    if (needMin) continue;

    // 启发式 1:代价高于阈值且出现过蛇形时,采样当前对角线,找「离盒角够远、
    // 前面还压着 20 行匹配」的路径当分裂点(v = 进度 - 偏离中线距离)。
    if (gotSnake !== 0 && ec > XDL_HEUR_MIN_COST) {
      let best = 0;
      let bi1 = 0;
      let bi2 = 0;
      for (let d = fmax; d >= fmin; d -= 2) {
        const dd = d > fmid ? d - fmid : fmid - d;
        const i1 = kvd[fd + d]!;
        const i2 = i1 - d;
        const v = i1 - off1 + i2 - off2 - dd;
        if (
          v > XDL_K_HEUR * ec && v > best &&
          off1 + XDL_SNAKE_CNT <= i1 && i1 < lim1 &&
          off2 + XDL_SNAKE_CNT <= i2 && i2 < lim2
        ) {
          for (let k = 1; hid1[i1 - k] === hid2[i2 - k]; k++) {
            if (k === XDL_SNAKE_CNT) {
              best = v;
              bi1 = i1;
              bi2 = i2;
              break;
            }
          }
        }
      }
      if (best > 0) return { i1: bi1, i2: bi2, minLo: true, minHi: false };

      best = 0;
      for (let d = bmax; d >= bmin; d -= 2) {
        const dd = d > bmid ? d - bmid : bmid - d;
        const i1 = kvd[bd + d]!;
        const i2 = i1 - d;
        const v = lim1 - i1 + lim2 - i2 - dd;
        if (
          v > XDL_K_HEUR * ec && v > best &&
          off1 < i1 && i1 <= lim1 - XDL_SNAKE_CNT &&
          off2 < i2 && i2 <= lim2 - XDL_SNAKE_CNT
        ) {
          for (let k = 0; hid1[i1 + k] === hid2[i2 + k]; k++) {
            if (k === XDL_SNAKE_CNT - 1) {
              best = v;
              bi1 = i1;
              bi2 = i2;
              break;
            }
          }
        }
      }
      if (best > 0) return { i1: bi1, i2: bi2, minLo: false, minHi: true };
    }

    // 兜底:代价烧到 mxcost,按 (i1+i2) 找两侧最远的可达点强拆。
    if (ec >= x.mxcost) {
      let fbest = -1;
      let fbest1 = -1;
      for (let d = fmax; d >= fmin; d -= 2) {
        let i1 = Math.min(kvd[fd + d]!, lim1);
        let i2 = i1 - d;
        if (lim2 < i2) {
          i1 = lim2 + d;
          i2 = lim2;
        }
        if (fbest < i1 + i2) {
          fbest = i1 + i2;
          fbest1 = i1;
        }
      }
      let bbest = KVD_LINE_MAX;
      let bbest1 = KVD_LINE_MAX;
      for (let d = bmax; d >= bmin; d -= 2) {
        let i1 = Math.max(off1, kvd[bd + d]!);
        let i2 = i1 - d;
        if (i2 < off2) {
          i1 = off2 + d;
          i2 = off2;
        }
        if (i1 + i2 < bbest) {
          bbest = i1 + i2;
          bbest1 = i1;
        }
      }
      if (lim1 + lim2 - bbest < fbest - (off1 + off2)) {
        return { i1: fbest1, i2: fbest - fbest1, minLo: true, minHi: false };
      }
      return { i1: bbest1, i2: bbest - bbest1, minLo: false, minHi: true };
    }
  }
}

/** xdl_recs_cmp 的等价迭代版:changed[] 打标与处理顺序无关,显式栈防深递归。 */
function recsCmp(x: Env, off1: number, lim1: number, off2: number, lim2: number, needMin: boolean): void {
  const stack: number[] = [off1, lim1, off2, lim2, needMin ? 1 : 0];
  while (stack.length > 0) {
    const nm = stack.pop() === 1;
    let l2 = stack.pop()!;
    let o2 = stack.pop()!;
    let l1 = stack.pop()!;
    let o1 = stack.pop()!;

    const hid1 = x.hid1;
    const hid2 = x.hid2;
    while (o1 < l1 && o2 < l2 && hid1[o1] === hid2[o2]) {
      o1++;
      o2++;
    }
    while (o1 < l1 && o2 < l2 && hid1[l1 - 1] === hid2[l2 - 1]) {
      l1--;
      l2--;
    }

    if (o1 === l1) {
      for (; o2 < l2; o2++) x.chg2[x.eff2[o2]!] = 1;
    } else if (o2 === l2) {
      for (; o1 < l1; o1++) x.chg1[x.eff1[o1]!] = 1;
    } else {
      const spl = xdlSplit(x, o1, l1, o2, l2, nm);
      // 钳回盒内。git 的 C 版假定分裂点落在盒内,启发式路径在极端输入下
      // 理论上可能贴边;钳掉后若子盒不再缩小,就用盒心中点强拆 —— 两半
      // 各自独立真比,只是放弃最小性,不会死循环。
      let si1 = Math.min(Math.max(spl.i1, o1), l1);
      let si2 = Math.min(Math.max(spl.i2, o2), l2);
      let lo = spl.minLo;
      let hi = spl.minHi;
      if ((si1 === o1 && si2 === o2) || (si1 === l1 && si2 === l2)) {
        si1 = o1 + Math.ceil((l1 - o1) / 2);
        si2 = o2 + Math.ceil((l2 - o2) / 2);
        lo = true;
        hi = true;
      }
      stack.push(si1, l1, si2, l2, hi ? 1 : 0);
      stack.push(o1, si1, o2, si2, lo ? 1 : 0);
    }
  }
}

// —— 后处理:change_compact(xdiffi.c)——

interface Group {
  s: number;
  e: number;
}

// —— 缩进启发式(xdiffi.c 的 measure_split / score_add_split,git 2.14 起默认
// 开启;这些经验权重是拿 diff-slider-tools 语料调出来的,必须逐个照抄)——

/** 行缩进超过此值直接钳住,避免病态输入把打分拖成 O(行宽)。 */
const MAX_INDENT = 200;
/** 组上下连续空白行数超过此值就停止计数,避免 O(N²) 扫描。 */
const MAX_BLANKS = 20;
const START_OF_FILE_PENALTY = 1;
const END_OF_FILE_PENALTY = 21;
const TOTAL_BLANK_WEIGHT = -30;
const POST_BLANK_WEIGHT = 6;
const RELATIVE_INDENT_PENALTY = -4;
const RELATIVE_INDENT_WITH_BLANK_PENALTY = 10;
const RELATIVE_OUTDENT_PENALTY = 24;
const RELATIVE_OUTDENT_WITH_BLANK_PENALTY = 17;
const RELATIVE_DEDENT_PENALTY = 23;
const RELATIVE_DEDENT_WITH_BLANK_PENALTY = 17;
const INDENT_WEIGHT = 60;
/** 组最多滑这么多行;再远的位置对观感无意义,还省掉 O(组宽×滑距) 的打分。 */
const INDENT_HEURISTIC_MAX_SLIDING = 100;

/** 行的缩进列数:空格记 1、TAB 进到 8 的倍数;纯空白行返回 -1。C 版按原始
 * 字节扫(含行尾 '\n',也是空白)—— 这里行已剥掉换行,对纯空白行的 -1
 * 判定与其余行的提前返回完全等价。 */
function getIndent(line: string): number {
  let ret = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === ' ') ret += 1;
    else if (c === '\t') ret += 8 - (ret % 8);
    else if (c !== '\r' && c !== '\f' && c !== '\v') return ret;
    // 其余空白字符忽略(与 C 的 isspace 一致)
    if (ret >= MAX_INDENT) return MAX_INDENT;
  }
  return -1;
}

interface SplitMeasurement {
  endOfFile: boolean;
  /** 切分点之后第一条行的缩进;-1 表示该行是空白行。 */
  indent: number;
  preBlank: number;
  preIndent: number;
  postBlank: number;
  postIndent: number;
}

interface SplitScore {
  effectiveIndent: number;
  penalty: number;
}

/** measure_split:测量「在 split 上方切开」的周边形态(split 是其后那条行的
 * 0 基下标)。C 版依赖滑动范围不越过文件头的既有不变式,split 恒 >= 0。 */
function measureSplit(lines: string[], split: number, m: SplitMeasurement): void {
  if (split >= lines.length) {
    m.endOfFile = true;
    m.indent = -1;
  } else {
    m.endOfFile = false;
    m.indent = getIndent(lines[split]!);
  }

  m.preBlank = 0;
  m.preIndent = -1;
  for (let i = split - 1; i >= 0; i--) {
    m.preIndent = getIndent(lines[i]!);
    if (m.preIndent !== -1) break;
    m.preBlank += 1;
    if (m.preBlank === MAX_BLANKS) {
      m.preIndent = 0;
      break;
    }
  }

  m.postBlank = 0;
  m.postIndent = -1;
  for (let i = split + 1; i < lines.length; i++) {
    m.postIndent = getIndent(lines[i]!);
    if (m.postIndent !== -1) break;
    m.postBlank += 1;
    if (m.postBlank === MAX_BLANKS) {
      m.postIndent = 0;
      break;
    }
  }
}

/** score_add_split:把一个切分点的测量折算进累计得分(越小越好)。 */
function scoreAddSplit(m: SplitMeasurement, s: SplitScore): void {
  if (m.preIndent === -1 && m.preBlank === 0) s.penalty += START_OF_FILE_PENALTY;
  if (m.endOfFile) s.penalty += END_OF_FILE_PENALTY;

  // postBlank 把紧贴切分点之后的空白行也计入(indent=-1 即其后第一条行是空白)
  const postBlank = m.indent === -1 ? 1 + m.postBlank : 0;
  const totalBlank = m.preBlank + postBlank;
  s.penalty += TOTAL_BLANK_WEIGHT * totalBlank;
  s.penalty += POST_BLANK_WEIGHT * postBlank;

  const indent = m.indent !== -1 ? m.indent : m.postIndent;
  const anyBlanks = totalBlank !== 0;
  s.effectiveIndent += indent;

  if (indent === -1) {
    // 文件末尾,无相对缩进可言
  } else if (m.preIndent === -1) {
    // 文件开头,无前驱可比
  } else if (indent > m.preIndent) {
    s.penalty += anyBlanks ? RELATIVE_INDENT_WITH_BLANK_PENALTY : RELATIVE_INDENT_PENALTY;
  } else if (indent === m.preIndent) {
    // 与前驱同级,无调整
  } else if (m.postIndent !== -1 && m.postIndent > indent) {
    // 比前驱浅、比后继深 —— 更像新块的开始而非块结束
    s.penalty += anyBlanks ? RELATIVE_OUTDENT_WITH_BLANK_PENALTY : RELATIVE_OUTDENT_PENALTY;
  } else {
    s.penalty += anyBlanks ? RELATIVE_DEDENT_WITH_BLANK_PENALTY : RELATIVE_DEDENT_PENALTY;
  }
}

/** score_cmp:先比有效缩进(权重 60),平手再比罚分。 */
function scoreCmp(s1: SplitScore, s2: SplitScore): number {
  const cmpIndents =
    (s1.effectiveIndent > s2.effectiveIndent ? 1 : 0) -
    (s1.effectiveIndent < s2.effectiveIndent ? 1 : 0);
  return INDENT_WEIGHT * cmpIndents + (s1.penalty - s2.penalty);
}

/**
 * xdl_change_compact:把本文件的改动组上下滑到最整齐的位置。
 * C 里 changed[] 在 -1 和 n 处有哨兵 0;这里换成显式边界判断(语义相同)。
 */
function changeCompact(
  ids: Int32Array,
  chg: Uint8Array,
  idsO: Int32Array,
  chgO: Uint8Array,
  lines: string[],
): void {
  const n = ids.length;
  const nO = idsO.length;
  const g: Group = { s: 0, e: 0 };
  const go: Group = { s: 0, e: 0 };
  while (g.e < n && chg[g.e] === 1) g.e++;
  while (go.e < nO && chgO[go.e] === 1) go.e++;

  const nextG = (gr: Group, ch: Uint8Array, len: number): boolean => {
    if (gr.e === len) return false;
    gr.s = gr.e + 1;
    gr.e = gr.s;
    while (gr.e < len && ch[gr.e] === 1) gr.e++;
    return true;
  };
  const prevG = (gr: Group, ch: Uint8Array): boolean => {
    if (gr.s === 0) return false;
    gr.e = gr.s - 1;
    gr.s = gr.e;
    while (gr.s > 0 && ch[gr.s - 1] === 1) gr.s--;
    return true;
  };
  const slideDown = (): boolean => {
    if (g.e < n && ids[g.s] === ids[g.e]) {
      chg[g.s++] = 0;
      chg[g.e++] = 1;
      while (g.e < n && chg[g.e] === 1) g.e++;
      return true;
    }
    return false;
  };
  const slideUp = (): boolean => {
    if (g.s > 0 && ids[g.s - 1] === ids[g.e - 1]) {
      // C:changed[--start] = true; changed[--end] = false —— 顶行并入组、组尾交还
      chg[--g.s] = 1;
      chg[--g.e] = 0;
      while (g.s > 0 && chg[g.s - 1] === 1) g.s--;
      return true;
    }
    return false;
  };

  for (;;) {
    if (g.e !== g.s) {
      let groupsize = 0;
      let earliestEnd = 0;
      let endMatchingOther = -1;
      do {
        groupsize = g.e - g.s;
        endMatchingOther = -1;
        // 先推到最高;撞上别的组就吞并重来(靠外层 do-while 判尺寸变化)
        while (slideUp()) {
          if (!prevG(go, chgO)) throw new Error('group sync broken sliding up');
        }
        earliestEnd = g.e;
        if (go.e > go.s) endMatchingOther = g.e;
        // 再推到最低,途中记录与对侧组对齐的落点
        for (;;) {
          if (!slideDown()) break;
          if (!nextG(go, chgO, nO)) throw new Error('group sync broken sliding down');
          if (go.e > go.s) endMatchingOther = g.e;
        }
      } while (groupsize !== g.e - g.s);

      if (g.e === earliestEnd) {
        // 完全不能滑,保持原位
      } else if (endMatchingOther !== -1) {
        // 能滑则滑回去与对侧最近的改动组对齐,避免把一处改动拆成孤立的增/删
        while (go.e === go.s) {
          if (!slideUp()) throw new Error('match disappeared');
          if (!prevG(go, chgO)) throw new Error('group sync broken sliding to match');
        }
      } else {
        // 缩进启发式:与对侧组无对齐可用时,在滑动自由度内按「组底/组顶两个
        // 切分点的缩进得分之和」挑落位(<= 0 取先到者,与 C 的更新顺序一致)。
        const m: SplitMeasurement = {
          endOfFile: false,
          indent: 0,
          preBlank: 0,
          preIndent: 0,
          postBlank: 0,
          postIndent: 0,
        };
        let shift = Math.max(
          earliestEnd,
          g.e - groupsize - 1,
          g.e - INDENT_HEURISTIC_MAX_SLIDING,
        );
        let bestShift = -1;
        let best: SplitScore = { effectiveIndent: 0, penalty: 0 };
        for (; shift <= g.e; shift++) {
          const score: SplitScore = { effectiveIndent: 0, penalty: 0 };
          measureSplit(lines, shift, m);
          scoreAddSplit(m, score);
          measureSplit(lines, shift - groupsize, m);
          scoreAddSplit(m, score);
          if (bestShift === -1 || scoreCmp(score, best) <= 0) {
            best = { effectiveIndent: score.effectiveIndent, penalty: score.penalty };
            bestShift = shift;
          }
        }
        while (g.e > bestShift) {
          if (!slideUp()) throw new Error('best shift unreached');
          if (!prevG(go, chgO)) throw new Error('group sync broken sliding to blank line');
        }
      }
    }
    if (!nextG(g, chg, n)) break;
    if (!nextG(go, chgO, nO)) throw new Error('group sync broken moving to next group');
  }
  // C:if (!group_next(xdfo, &go)) BUG —— group_next 成功返回 0、到尾返回 -1,
  // 所以这句是「还能再前进」才失步:主循环因 g 到尾退出时,go 必须恰好停在
  // 自己的最后一个组上(两侧组数相同,但 g 先走了一步)。
  if (nextG(go, chgO, nO)) throw new Error('group sync broken at end of file');
}

// —— 变更组 → 操作序列 / 并排行 / 差异块 ——

type Op = { t: 'same'; i: number; j: number } | { t: 'del'; i: number } | { t: 'add'; j: number };

interface ChangeGroup {
  i1: number;
  i2: number;
  c1: number;
  c2: number;
}

/** xdl_build_script:扫出变更组(从后往前扫、收集后翻转,与 C 的前插等价)。 */
function buildGroups(x: Env): ChangeGroup[] {
  const out: ChangeGroup[] = [];
  let i1 = x.n1;
  let i2 = x.n2;
  while (i1 >= 0 || i2 >= 0) {
    if ((i1 > 0 && x.chg1[i1 - 1] === 1) || (i2 > 0 && x.chg2[i2 - 1] === 1)) {
      const l1 = i1;
      const l2 = i2;
      while (i1 > 0 && x.chg1[i1 - 1] === 1) i1--;
      while (i2 > 0 && x.chg2[i2 - 1] === 1) i2--;
      out.push({ i1, i2, c1: l1 - i1, c2: l2 - i2 });
    }
    i1--;
    i2--;
  }
  out.reverse();
  return out;
}

/** 未变行两侧按序一一配对;组内是纯 del / 纯 add / 两者混合。 */
function groupsToOps(n1: number, n2: number, groups: ChangeGroup[]): Op[] {
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  for (const g of groups) {
    while (i < g.i1 && j < g.i2) {
      ops.push({ t: 'same', i: i++, j: j++ });
    }
    for (let k = 0; k < g.c1; k++) ops.push({ t: 'del', i: g.i1 + k });
    for (let k = 0; k < g.c2; k++) ops.push({ t: 'add', j: g.i2 + k });
    i = g.i1 + g.c1;
    j = g.i2 + g.c2;
  }
  while (i < n1 && j < n2) {
    ops.push({ t: 'same', i: i++, j: j++ });
  }
  return ops;
}

/**
 * 把操作序列组装成并排行。
 *
 * 一段连续的「删 + 增」里,先按序两两配对成 `change`(左右各占半行、视觉上对齐),
 * 多出来的再各自成 del / add 行 —— 这样「改了一行」显示为一行对齐的变更,
 * 而不是「删一行 + 加一行」两条,更接近 IDEA 的观感。
 */
function assemble(a: string[], b: string[], ops: Op[]): DiffLine[] {
  const rows: DiffLine[] = [];
  let k = 0;
  while (k < ops.length) {
    const op = ops[k]!;
    if (op.t === 'same') {
      rows.push({
        leftNo: op.i + 1,
        leftText: a[op.i] ?? '',
        rightNo: op.j + 1,
        rightText: b[op.j] ?? '',
        type: 'same',
      });
      k++;
      continue;
    }
    const dels: number[] = [];
    const adds: number[] = [];
    while (k < ops.length && ops[k]!.t !== 'same') {
      const cur = ops[k]!;
      if (cur.t === 'del') dels.push(cur.i);
      else adds.push(cur.j);
      k++;
    }
    const pairs = Math.min(dels.length, adds.length);
    for (let x = 0; x < pairs; x++) {
      const i = dels[x]!;
      const j = adds[x]!;
      rows.push({
        leftNo: i + 1,
        leftText: a[i] ?? '',
        rightNo: j + 1,
        rightText: b[j] ?? '',
        type: 'change',
      });
    }
    for (let x = pairs; x < dels.length; x++) {
      const i = dels[x]!;
      rows.push({ leftNo: i + 1, leftText: a[i] ?? '', type: 'del' });
    }
    for (let x = pairs; x < adds.length; x++) {
      const j = adds[x]!;
      rows.push({ rightNo: j + 1, rightText: b[j] ?? '', type: 'add' });
    }
  }
  return rows;
}

/** 连续的非 same 行合成一个差异块,并记下它在两侧的行区间(供按块应用)。 */
function buildHunks(rows: DiffLine[]): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let lastLeft = -1;
  let lastRight = -1;
  let k = 0;
  while (k < rows.length) {
    const row = rows[k]!;
    if (row.type === 'same') {
      if (row.leftNo !== undefined) lastLeft = row.leftNo - 1;
      if (row.rightNo !== undefined) lastRight = row.rightNo - 1;
      k++;
      continue;
    }
    const start = k;
    let ls = -1;
    let le = -1;
    let rs = -1;
    let re = -1;
    while (k < rows.length && rows[k]!.type !== 'same') {
      const cur = rows[k]!;
      if (cur.leftNo !== undefined) {
        const i = cur.leftNo - 1;
        if (ls < 0) ls = i;
        le = i;
      }
      if (cur.rightNo !== undefined) {
        const j = cur.rightNo - 1;
        if (rs < 0) rs = j;
        re = j;
      }
      k++;
    }
    hunks.push({
      start,
      end: k,
      leftStart: ls >= 0 ? ls : lastLeft + 1,
      leftCount: ls >= 0 ? le - ls + 1 : 0,
      rightStart: rs >= 0 ? rs : lastRight + 1,
      rightCount: rs >= 0 ? re - rs + 1 : 0,
    });
    if (le >= 0) lastLeft = le;
    if (re >= 0) lastRight = re;
  }
  return hunks;
}

function runDiff(left: string, right: string): { a: Prepared; b: Prepared; groups: ChangeGroup[] } {
  const { a, b, x } = prepareEnv(left, right);
  recsCmp(x, 0, x.nreff1, 0, x.nreff2, false);
  // git:先压左(对右)、再压右(对左),然后才收集变更组
  changeCompact(x.ids1, x.chg1, x.ids2, x.chg2, a.lines);
  changeCompact(x.ids2, x.chg2, x.ids1, x.chg1, b.lines);
  return { a, b, groups: buildGroups(x) };
}

/** 比对两段文本,得到并排行与差异块。 */
export function diffText(left: string, right: string): TextDiff {
  const { a, b, groups } = runDiff(left, right);
  const ops = groupsToOps(a.lines.length, b.lines.length, groups);
  const rows = assemble(a.lines, b.lines, ops);
  return { rows, hunks: buildHunks(rows) };
}

/**
 * 按 git `diff -U3` 的发射规则(xemit.c 的 xdl_get_hunk / xdl_emit_diff,
 * 无 ignore 标志的简化路径)把变更组折成 hunk:上下文 3 行,两组之间未变行
 * <= 2*ctx 时合并。返回 0 基区间,仅供对拍测试;UI 的按块应用用的仍是
 * diffText().hunks(连续差异行,粒度更细,适合逐块按钮)。
 */
export function gitStyleHunks(left: string, right: string): GitStyleHunk[] {
  const ctx = 3;
  const maxCommon = 2 * ctx; // interhunkctx 默认 0
  const { a, b, groups } = runDiff(left, right);
  const out: GitStyleHunk[] = [];
  let k = 0;
  while (k < groups.length) {
    const first = groups[k]!;
    let last = first;
    k++;
    while (k < groups.length && groups[k]!.i1 - (last.i1 + last.c1) <= maxCommon) {
      last = groups[k]!;
      k++;
    }
    const s1 = Math.max(0, first.i1 - ctx);
    const s2 = Math.max(0, first.i2 - ctx);
    // C:xdl_emit_diff 的 lctx 是两侧剩余行数与 ctx 三者取最小,e1/e2 共用同一个
    // lctx(真实对齐里组后剩余未变行两侧数量恒等,这里照抄原式以防万一)。
    const lctx = Math.min(
      ctx,
      a.lines.length - (last.i1 + last.c1),
      b.lines.length - (last.i2 + last.c2),
    );
    const e1 = last.i1 + last.c1 + lctx;
    const e2 = last.i2 + last.c2 + lctx;
    out.push({ start1: s1, count1: e1 - s1, start2: s2, count2: e2 - s2 });
  }
  return out;
}

/**
 * 把一个差异块应用到目标侧,返回目标侧的**新全文**。
 *
 * target='right' 表示「用左边的内容替换右边这一块」(→);'left' 反之(←)。
 * 纯函数:不修改入参,方便 UI 先算出结果再决定是否提交。
 *
 * 行尾换行是行身份的一部分:替换段顶到文件末尾时,结果的 EOF 换行状态要跟
 * 来源走,否则「应用全部块 → 两侧全文相等」这条不变式会被 EOF 差异打破。
 */
export function applyHunk(left: string, right: string, hunk: DiffHunk, target: 'left' | 'right'): string {
  const a = prepare(left);
  const b = prepare(right);
  if (target === 'right') {
    const lines = [...b.lines];
    const repl = a.lines.slice(hunk.leftStart, hunk.leftStart + hunk.leftCount);
    lines.splice(hunk.rightStart, hunk.rightCount, ...repl);
    return joinWithTrailing(lines, resultTrailing(a, b, hunk.leftStart, hunk.leftCount, hunk.rightStart, hunk.rightCount));
  }
  const lines = [...a.lines];
  const repl = b.lines.slice(hunk.rightStart, hunk.rightStart + hunk.rightCount);
  lines.splice(hunk.leftStart, hunk.leftCount, ...repl);
  return joinWithTrailing(lines, resultTrailing(b, a, hunk.rightStart, hunk.rightCount, hunk.leftStart, hunk.leftCount));
}

/** 应用一个块后,结果最后一行是否带换行(见 applyHunk 的说明)。 */
function resultTrailing(
  src: Prepared,
  dst: Prepared,
  srcStart: number,
  srcCount: number,
  dstStart: number,
  dstCount: number,
): boolean {
  if (dstStart + dstCount < dst.lines.length) return dst.terms[dst.lines.length - 1] === 1;
  if (srcCount > 0) return src.terms[srcStart + srcCount - 1] === 1;
  // 纯删且删到末尾:剩下的最后一行是 dst 的中侧行,必有换行;dstStart===0 则结果为空
  return dstStart > 0;
}

function joinWithTrailing(lines: string[], trailing: boolean): string {
  if (lines.length === 0) return '';
  return lines.join('\n') + (trailing ? '\n' : '');
}

/** 有差异的行数(change + del + add),用于弹窗标题上的计数。 */
export function countChanged(rows: DiffLine[]): number {
  let n = 0;
  for (const r of rows) if (r.type !== 'same') n++;
  return n;
}
