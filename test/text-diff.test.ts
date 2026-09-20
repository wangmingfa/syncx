import { describe, expect, it } from 'vitest';
import { applyHunk, countChanged, diffText } from '../web/utils/text-diff.js';

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
