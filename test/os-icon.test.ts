import { describe, expect, it } from 'vitest';
import { osIconKind, osIconLabel } from '../web/utils/os-icon.js';

/**
 * platform → 图标类别。输入永远是后端原样透出的 process.platform(本机 status.platform
 * 或对端 hello 宣告),不是用户输入,因此**刻意不做归一化**:'Win32' 落到 unknown 是
 * 正确行为 —— 真要出现大小写变体,说明上游已经坏了,这里悄悄兜住反而藏起 bug。
 */
describe('osIconKind', () => {
  it('三个已知平台各归其位', () => {
    expect(osIconKind('win32')).toBe('windows');
    expect(osIconKind('darwin')).toBe('macos');
    expect(osIconKind('linux')).toBe('linux');
  });

  it('其它平台归 unknown,不拿 Linux 凑数', () => {
    expect(osIconKind('freebsd')).toBe('unknown');
    expect(osIconKind('sunos')).toBe('unknown');
    expect(osIconKind('aix')).toBe('unknown');
    expect(osIconKind('android')).toBe('unknown');
  });

  it('缺省 / 空串归 unknown(旧后端未发 platform 字段)', () => {
    expect(osIconKind(undefined)).toBe('unknown');
    expect(osIconKind('')).toBe('unknown');
  });
});

describe('osIconLabel', () => {
  it('与图标类别同名', () => {
    expect(osIconLabel('win32')).toBe('Windows');
    expect(osIconLabel('darwin')).toBe('macOS');
    expect(osIconLabel('linux')).toBe('Linux');
    expect(osIconLabel('freebsd')).toBe('未知系统');
    expect(osIconLabel(undefined)).toBe('未知系统');
  });
});
