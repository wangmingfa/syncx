/**
 * 行级文本差异(IDEA 风格的并排对比用)。
 *
 * 纯函数、可单测:输入两段文本,输出逐行对齐的结果 + 可直接「按块应用」的差异块。
 *
 * 两个刻意的取舍:
 *  1. **先剥公共前后缀再跑 LCS** —— 绝大多数文件只有中间一小段不同,剥掉后 DP 规模
 *     从「全文 × 全文」降到「改动段 × 改动段」,大文件也不会卡死浏览器。
 *  2. **规模兜底**:剥完仍然过大(超 MAX_LCS_CELLS 格)就退化成「整段替换」,
 *     宁可显示得粗糙,也不能让 UI 假死。
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

/** LCS 表格的单元格上限;超过则退化为整段替换。 */
const MAX_LCS_CELLS = 1_500_000;

interface Prepared {
  lines: string[];
  /** 原文是否以换行结尾(用于还原,避免悄悄吃掉/多出一个空行)。 */
  trailing: boolean;
}

function prepare(text: string): Prepared {
  const norm = text.replace(/\r\n?/g, '\n');
  const trailing = norm.endsWith('\n');
  const body = trailing ? norm.slice(0, -1) : norm;
  return { lines: body === '' ? [] : body.split('\n'), trailing };
}

function joinLines(lines: string[], trailing: boolean): string {
  if (lines.length === 0) return '';
  return lines.join('\n') + (trailing ? '\n' : '');
}

type Op = { t: 'same'; i: number; j: number } | { t: 'del'; i: number } | { t: 'add'; j: number };

function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) return b.map((_, j) => ({ t: 'add' as const, j }));
  if (m === 0) return a.map((_, i) => ({ t: 'del' as const, i }));
  if ((n + 1) * (m + 1) > MAX_LCS_CELLS) {
    // 兜底:整段替换。显示上等价于「这一整块都改了」,不会误判成左右一致
    return [
      ...a.map((_, i) => ({ t: 'del' as const, i })),
      ...b.map((_, j) => ({ t: 'add' as const, j })),
    ];
  }

  // dp[i][j] = a[i..] 与 b[j..] 的 LCS 长度;倒序填表,正向回溯出操作序列
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] === b[j]
          ? (dp[(i + 1) * w + (j + 1)] ?? 0) + 1
          : Math.max(dp[(i + 1) * w + j] ?? 0, dp[i * w + (j + 1)] ?? 0);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: 'same', i, j });
      i++;
      j++;
    } else if ((dp[(i + 1) * w + j] ?? 0) >= (dp[i * w + (j + 1)] ?? 0)) {
      ops.push({ t: 'del', i });
      i++;
    } else {
      ops.push({ t: 'add', j });
      j++;
    }
  }
  while (i < n) {
    ops.push({ t: 'del', i });
    i++;
  }
  while (j < m) {
    ops.push({ t: 'add', j });
    j++;
  }
  return ops;
}

/** 剥掉公共前后缀后再比对中间段,最后把前后缀拼回去。 */
function diffOps(a: string[], b: string[]): Op[] {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }

  const ops: Op[] = [];
  for (let k = 0; k < prefix; k++) ops.push({ t: 'same', i: k, j: k });
  for (const op of lcsOps(a.slice(prefix, a.length - suffix), b.slice(prefix, b.length - suffix))) {
    if (op.t === 'same') ops.push({ t: 'same', i: prefix + op.i, j: prefix + op.j });
    else if (op.t === 'del') ops.push({ t: 'del', i: prefix + op.i });
    else ops.push({ t: 'add', j: prefix + op.j });
  }
  for (let k = 0; k < suffix; k++) {
    ops.push({ t: 'same', i: a.length - suffix + k, j: b.length - suffix + k });
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

/** 比对两段文本,得到并排行与差异块。 */
export function diffText(left: string, right: string): TextDiff {
  const a = prepare(left);
  const b = prepare(right);
  const rows = assemble(a.lines, b.lines, diffOps(a.lines, b.lines));
  return { rows, hunks: buildHunks(rows) };
}

/**
 * 把一个差异块应用到目标侧,返回目标侧的**新全文**。
 *
 * target='right' 表示「用左边的内容替换右边这一块」(→);'left' 反之(←)。
 * 纯函数:不修改入参,方便 UI 先算出结果再决定是否提交。
 */
export function applyHunk(left: string, right: string, hunk: DiffHunk, target: 'left' | 'right'): string {
  const a = prepare(left);
  const b = prepare(right);
  if (target === 'right') {
    const lines = [...b.lines];
    const replacement = a.lines.slice(hunk.leftStart, hunk.leftStart + hunk.leftCount);
    lines.splice(hunk.rightStart, hunk.rightCount, ...replacement);
    return joinLines(lines, b.trailing);
  }
  const lines = [...a.lines];
  const replacement = b.lines.slice(hunk.rightStart, hunk.rightStart + hunk.rightCount);
  lines.splice(hunk.leftStart, hunk.leftCount, ...replacement);
  return joinLines(lines, a.trailing);
}

/** 有差异的行数(change + del + add),用于弹窗标题上的计数。 */
export function countChanged(rows: DiffLine[]): number {
  let n = 0;
  for (const r of rows) if (r.type !== 'same') n++;
  return n;
}
