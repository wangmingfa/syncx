import { describe, expect, it } from 'vitest';
import { applyHunk, countChanged, diffText, gitStyleHunks } from '../web/utils/text-diff.js';

/**
 * 行级差异是「逐块同步」的地基:块划错,用户点一下 ← 就会把不该覆盖的行覆盖掉。
 * 这里锁住四类基本形态(相同 / 改一行 / 纯新增 / 纯删除)与两个容易出错的细节 ——
 * 行尾换行必须原样保留、按块应用后目标侧要真的等于来源侧。
 */
describe('diffText', () => {
  it('内容相同:全部 same,无差异块', () => {
    const text = 'a\nb\nc\n';
    const d = diffText(text, text);
    expect(d.rows.every((r) => r.type === 'same')).toBe(true);
    expect(d.hunks).toHaveLength(0);
    expect(countChanged(d.rows)).toBe(0);
  });

  it('改一行:配成 change 且左右行号都在', () => {
    const d = diffText('a\nb\nc\n', 'a\nB\nc\n');
    const changed = d.rows.filter((r) => r.type !== 'same');
    expect(changed).toHaveLength(1);
    expect(changed[0]!.type).toBe('change');
    expect(changed[0]!.leftNo).toBe(2);
    expect(changed[0]!.rightNo).toBe(2);
    expect(d.hunks).toHaveLength(1);
  });

  it('纯新增:只有右半边的 add 行', () => {
    const d = diffText('a\nc\n', 'a\nb\nc\n');
    const changed = d.rows.filter((r) => r.type !== 'same');
    expect(changed).toHaveLength(1);
    expect(changed[0]!.type).toBe('add');
    expect(changed[0]!.leftNo).toBeUndefined();
    expect(changed[0]!.rightNo).toBe(2);
  });

  it('纯删除:只有左半边的 del 行', () => {
    const d = diffText('a\nb\nc\n', 'a\nc\n');
    const changed = d.rows.filter((r) => r.type !== 'same');
    expect(changed).toHaveLength(1);
    expect(changed[0]!.type).toBe('del');
    expect(changed[0]!.leftNo).toBe(2);
    expect(changed[0]!.rightNo).toBeUndefined();
  });

  it('行号在两侧各自单调递增', () => {
    const d = diffText('a\nb\nc\nd\ne\n', 'a\nB\nc\nX\nY\ne\n');
    const left = d.rows.filter((r) => r.leftNo !== undefined).map((r) => r.leftNo!);
    const right = d.rows.filter((r) => r.rightNo !== undefined).map((r) => r.rightNo!);
    expect(left).toEqual([...left].sort((x, y) => x - y));
    expect(right).toEqual([...right].sort((x, y) => x - y));
  });

  it('保留行尾换行(不悄悄吃掉或补一个空行)', () => {
    const withNl = diffText('a\nb\n', 'a\nB\n');
    expect(applyHunk('a\nb\n', 'a\nB\n', withNl.hunks[0]!, 'left')).toBe('a\nB\n');
    const withoutNl = diffText('a\nb', 'a\nB');
    expect(applyHunk('a\nb', 'a\nB', withoutNl.hunks[0]!, 'left')).toBe('a\nB');
  });
});

describe('applyHunk', () => {
  it('全部应用到右侧后,右侧全文等于左侧', () => {
    const left = 'a\nb\nc\nd\n';
    const right = 'a\nX\nc\nY\n';
    let current = right;
    // 从后往前应用:前面的块应用后行号会漂移,倒序才不会错切
    for (const hunk of [...diffText(left, current).hunks].reverse()) {
      current = applyHunk(left, current, hunk, 'right');
    }
    expect(current).toBe(left);
  });

  it('全部应用到左侧后,左侧全文等于右侧', () => {
    const left = 'a\nb\nc\n';
    const right = 'a\nB\nC\nc\n';
    let current = left;
    for (const hunk of [...diffText(current, right).hunks].reverse()) {
      current = applyHunk(current, right, hunk, 'left');
    }
    expect(current).toBe(right);
  });

  it('只应用一个块时,其余差异原样保留', () => {
    const left = 'a\nb\nc\nd\n';
    const right = 'a\nX\nc\nY\n';
    const hunks = diffText(left, right).hunks;
    expect(hunks).toHaveLength(2);
    const after = applyHunk(left, right, hunks[0]!, 'right');
    // 第一块(b→X)被左侧覆盖,第二块(Y)不动
    expect(after).toBe('a\nb\nc\nY\n');
  });
});

// —— 旧实现的真实退化场景(任务书 7.1):6368 行文件、161 处稀疏改动,
// 旧 DP 超预算后兜底成「整段替换」(countChanged ≈ 5883)。新实现必须给出
// 与改动点同量级的结果,且未改动的行不许被标成差异。——

/** 构造一份带高频重复行(空行、"  }"、"};")的大文件,贴近真实源码形态。 */
function buildBase(n: number): string[] {
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    const m = i % 12;
    if (m === 0) lines.push('');
    else if (m === 5) lines.push('  }');
    else if (m === 9) lines.push('};');
    else lines.push(`const value_${i} = compute(${i}, ${i * 7});`);
  }
  return lines;
}

describe('大文件退化场景(旧实现兜底成整段替换的用例)', () => {
  const left = buildBase(6368).join('\n') + '\n';
  // 160 处单行修改(间隔 36 行,互不相邻)+ 1 处单 token 修改
  const points = Array.from({ length: 160 }, (_, k) => 500 + k * 36);
  const rightLines = [...buildBase(6368)];
  for (const p of points) rightLines[p] = `${rightLines[p]} // tweaked-${p}`;
  // 3002 是 compute 行(3000 是空行、3001 是 "};" 行),且与 36 间隔的变异点错开
  rightLines[3002] = rightLines[3002]!.replace('compute(', 'Compute(');
  const right = rightLines.join('\n') + '\n';

  it('161 处稀疏改动:改动行数与块数都与改动点同量级', () => {
    const d = diffText(left, right);
    expect(countChanged(d.rows)).toBeLessThan(400);
    expect(d.hunks.length).toBeGreaterThanOrEqual(150);
    expect(d.hunks.length).toBeLessThanOrEqual(170);
    expect(d.rows.filter((r) => r.type === 'change')).toHaveLength(161);
  });

  it('诚实性:两侧文本相同的行必须是 same', () => {
    const d = diffText(left, right);
    for (const r of d.rows) {
      if (r.leftText !== undefined && r.rightText !== undefined && r.leftText === r.rightText) {
        expect(r.type).toBe('same');
      }
    }
  });

  it('应用全部块后两侧互换相等(大文件,两个方向)', () => {
    const d = diffText(left, right);
    let cur = right;
    for (const h of [...d.hunks].reverse()) cur = applyHunk(left, cur, h, 'right');
    expect(cur).toBe(left);
    let cur2 = left;
    for (const h of [...d.hunks].reverse()) cur2 = applyHunk(cur2, right, h, 'left');
    expect(cur2).toBe(right);
  });

  it('万行稀疏比对在 200ms 内完成', () => {
    const l = buildBase(10000).join('\n') + '\n';
    const rLines = buildBase(10000);
    for (let k = 0; k < 300; k++) {
      const p = 300 + k * 31;
      rLines[p] = `${rLines[p]} // tweaked-${p}`;
    }
    const r = rLines.join('\n') + '\n';
    const t0 = performance.now();
    const d = diffText(l, r);
    const ms = performance.now() - t0;
    expect(countChanged(d.rows)).toBeLessThan(700);
    expect(ms).toBeLessThan(200);
  });
});

// —— EOF 与换行:行身份含行尾换行(对齐 git),最后一行有无 \n 是不同的行。——

describe('EOF 与行尾换行', () => {
  it('仅 EOF 换行不同:最后一行是 change,且可互相应用', () => {
    const d = diffText('a\nb\n', 'a\nb');
    const changed = d.rows.filter((r) => r.type !== 'same');
    expect(changed).toHaveLength(1);
    expect(changed[0]!.type).toBe('change');
    expect(d.hunks).toHaveLength(1);
    expect(applyHunk('a\nb\n', 'a\nb', d.hunks[0]!, 'right')).toBe('a\nb\n');
    expect(applyHunk('a\nb\n', 'a\nb', d.hunks[0]!, 'left')).toBe('a\nb');
  });

  it('末尾纯新增(新增行不带换行):应用后 EOF 状态跟来源走', () => {
    const d = diffText('a\n', 'a\nb');
    const changed = d.rows.filter((r) => r.type !== 'same');
    expect(changed).toHaveLength(1);
    expect(changed[0]!.type).toBe('add');
    const h = d.hunks[0]!;
    expect(applyHunk('a\n', 'a\nb', h, 'right')).toBe('a\n');
    expect(applyHunk('a\n', 'a\nb', h, 'left')).toBe('a\nb');
  });

  it('CRLF 归一化:仅行尾风格不同不刷红,内容变更照常标出', () => {
    expect(countChanged(diffText('a\r\nb\r\n', 'a\nb\n').rows)).toBe(0);
    expect(countChanged(diffText('a\r\nb\r\n', 'a\nB\n').rows)).toBe(1);
  });

  it('空对空、空对满', () => {
    expect(diffText('', '').rows).toHaveLength(0);
    const d = diffText('', 'a\nb\n');
    expect(d.rows.every((r) => r.type === 'add')).toBe(true);
    expect(applyHunk('', 'a\nb\n', d.hunks[0]!, 'right')).toBe('');
    expect(applyHunk('', 'a\nb\n', d.hunks[0]!, 'left')).toBe('a\nb\n');
  });
});

// —— fuzz:随机小样本与「纯增删编辑距离」对拍。小输入下 git 默认 Myers 没有
// 启发式介入(ec 到不了 256),产出严格最小 diff,所以 del+add 行数必须恰好
// 等于 DP 最优值;同时校验行完整性与 apply-all 不变式。——

/** mulberry32:确定性随机,失败可复现。 */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** 只允许增/删的编辑距离(= m+n-2·LCS):行级 diff 把「改一行」表示成一对 del+add。 */
function delInsDistance(a: string[], b: string[]): number {
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        a[i - 1] === b[j - 1] ? prev[j - 1]! : Number.MAX_SAFE_INTEGER,
      );
    }
    prev = cur;
  }
  return prev[n]!;
}

describe('fuzz:随机小样本对拍', () => {
  // 词池 ≥ 50:单行出现次数远低于 bogosqrt(行数),高频行 INVESTIGATE 不会介入,
  // 产出一律是最小 diff,才好用 DP 对拍。
  const POOL = Array.from({ length: 80 }, (_, i) => `tok-${i}`);

  it('del+add 行数等于最优编辑距离,行完整,可互推', () => {
    const rand = mulberry32(20261009);
    for (let iter = 0; iter < 150; iter++) {
      const na = 1 + Math.floor(rand() * 70);
      const aLines = Array.from({ length: na }, () => POOL[Math.floor(rand() * POOL.length)]!);
      const bLines = [...aLines];
      const k = Math.floor(rand() * 6);
      for (let m = 0; m < k && bLines.length > 0; m++) {
        const p = Math.floor(rand() * bLines.length);
        const mode = rand();
        if (mode < 0.4) bLines[p] = POOL[Math.floor(rand() * POOL.length)]!;
        else if (mode < 0.7) bLines.splice(p, 1);
        else bLines.splice(p, 0, POOL[Math.floor(rand() * POOL.length)]!);
      }
      const a = aLines.length === 0 ? '' : aLines.join('\n') + '\n';
      const b = bLines.length === 0 ? '' : bLines.join('\n') + '\n';

      const d = diffText(a, b);
      const dels = d.rows.filter((r) => r.type === 'del' || r.type === 'change').length;
      const adds = d.rows.filter((r) => r.type === 'add' || r.type === 'change').length;
      expect(dels + adds).toBe(delInsDistance(aLines, bLines));

      // 行完整性:两侧各自的行序列被原样重现
      expect(d.rows.filter((r) => r.leftNo !== undefined).map((r) => r.leftText)).toEqual(aLines);
      expect(d.rows.filter((r) => r.rightNo !== undefined).map((r) => r.rightText)).toEqual(bLines);

      // 相同内容的行不许标成差异
      for (const r of d.rows) {
        if (r.leftText !== undefined && r.rightText !== undefined) {
          expect(r.leftText === r.rightText ? r.type === 'same' : true).toBe(true);
        }
      }

      // 应用全部块后互换相等
      let cur = b;
      for (const h of [...d.hunks].reverse()) cur = applyHunk(a, cur, h, 'right');
      expect(cur).toBe(a);
      let cur2 = a;
      for (const h of [...d.hunks].reverse()) cur2 = applyHunk(cur2, b, h, 'left');
      expect(cur2).toBe(b);
    }
  });
});

// —— gitStyleHunks:对齐 git diff -U3 的发射规则(xemit.c),供与 git 对拍。——

describe('gitStyleHunks(-U3 发射规则)', () => {
  const base = Array.from({ length: 40 }, (_, i) => `line-${i}`).join('\n') + '\n';
  const patch = (points: number[]): string => {
    const lines = base.slice(0, -1).split('\n');
    for (const p of points) lines[p] = `changed-${p}`;
    return lines.join('\n') + '\n';
  };

  it('两组间距 ≤ 2*ctx 时合并成一个 hunk', () => {
    // 改 10、16 两行:距离 16-(10+1)=5 ≤ 6,合并;上下文 [7,20)
    expect(gitStyleHunks(base, patch([10, 16]))).toEqual([
      { start1: 7, count1: 13, start2: 7, count2: 13 },
    ]);
  });

  it('间距足够远时保持多个 hunk,头行裁到 3 行上下文', () => {
    const hunks = gitStyleHunks(base, patch([10, 30]));
    expect(hunks).toEqual([
      { start1: 7, count1: 7, start2: 7, count2: 7 },
      { start1: 27, count1: 7, start2: 27, count2: 7 },
    ]);
  });
});
