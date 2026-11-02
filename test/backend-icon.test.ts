import { describe, expect, it } from 'vitest';
import { backendIconKind, backendIconLabel } from '../web/utils/backend-icon.js';

/**
 * runtime → 图标类别。输入来自控制消息(本机 /api/status 是对端 hello 宣告),
 * 不是用户输入,因此**刻意不做归一化**:'Node' 落到 null 是正确行为 ——
 * 真出现大小写变体,说明上游协议已经坏了,悄悄兜住只会藏起 bug。
 */
describe('backendIconKind', () => {
  it('三种后端各归其位', () => {
    expect(backendIconKind('node')).toBe('node');
    expect(backendIconKind('rust')).toBe('rust');
    expect(backendIconKind('moonbit')).toBe('moonbit');
  });

  it('未知名一律 null —— 宁可不画,也不猜成某一种', () => {
    expect(backendIconKind(undefined)).toBeNull();
    expect(backendIconKind('')).toBeNull();
    expect(backendIconKind('Node')).toBeNull();
    expect(backendIconKind('go')).toBeNull();
    expect(backendIconKind('nodejs')).toBeNull();
  });
});

describe('backendIconLabel', () => {
  it('与图标类别同名', () => {
    expect(backendIconLabel('node')).toBe('Node.js');
    expect(backendIconLabel('rust')).toBe('Rust');
    expect(backendIconLabel('moonbit')).toBe('MoonBit');
  });

  it('未知后端给出中性文案(不是空串:title 不能是空的)', () => {
    expect(backendIconLabel(undefined)).toBe('未知后端');
    expect(backendIconLabel('go')).toBe('未知后端');
  });
});
