import { describe, expect, it } from 'vitest';
import { formatDuration } from '../web/utils/duration.js';

/**
 * 同步耗时的可读形式。分档与"哪一档保留余数"是有意为之的不对称,
 * 所以每一档的边界都单独钉 —— 边界值(整分、整点、整天)最容易写错成
 * 「1小时0分钟」或者掉回上一档。
 */
describe('formatDuration', () => {
  it('缺省 / 非法值返回空串(区别于"小于1秒")', () => {
    expect(formatDuration(undefined)).toBe('');
    expect(formatDuration(null)).toBe('');
    expect(formatDuration(NaN)).toBe('');
    expect(formatDuration(Infinity)).toBe('');
    expect(formatDuration(-1)).toBe('');
  });

  it('亚秒单独一档,不写成 0 秒', () => {
    expect(formatDuration(0)).toBe('小于1秒');
    expect(formatDuration(999)).toBe('小于1秒');
  });

  it('秒档:整秒向下取整,不进位到分钟', () => {
    expect(formatDuration(1000)).toBe('1秒');
    expect(formatDuration(3200)).toBe('3秒');
    expect(formatDuration(59_999)).toBe('59秒');
  });

  it('分钟档保留余秒(这一档正是"到底慢不慢"最关心的区间)', () => {
    expect(formatDuration(60_000)).toBe('1分钟');
    expect(formatDuration(119_000)).toBe('1分钟59秒');
    expect(formatDuration(120_000)).toBe('2分钟');
    expect(formatDuration(3_599_000)).toBe('59分钟59秒');
  });

  it('小时档丢弃秒,只到分钟', () => {
    expect(formatDuration(3_600_000)).toBe('1小时');
    expect(formatDuration(3_661_000)).toBe('1小时1分钟');
    expect(formatDuration(4_320_000)).toBe('1小时12分钟');
    // 2 小时 30 秒:余下的 30 秒不该冒出来
    expect(formatDuration(7_230_000)).toBe('2小时');
  });

  it('天档丢弃分钟,只到小时', () => {
    expect(formatDuration(86_400_000)).toBe('1天');
    expect(formatDuration(90_000_000)).toBe('1天1小时');
    expect(formatDuration(90_060_000)).toBe('1天1小时'); // 10 分钟被丢掉
    expect(formatDuration(3_600_000 * 26)).toBe('1天2小时');
  });
});
