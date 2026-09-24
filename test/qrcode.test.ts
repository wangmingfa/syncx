import { describe, expect, it } from 'vitest';
import { encodeQr, qrToSvg, pairCodeUrl, parsePairCode } from '../web/utils/qrcode.js';

/**
 * 配对二维码编码器的结构自检:没有解码器依赖,就用 ISO/IEC 18004 的可验性质
 * (尺寸 / 寻像与时序图案 / 格式信息 BCH 自洽)卡住回归。任何一条破坏,
 * 码都会从「能用」变成「看着正常却扫不出来」—— 恰是最危险的静默坏法。
 */

/** 版本 n 的模块数:4n+17。 */
const sizeOf = (n: number) => 4 * n + 17;

/** 15 位格式信息做 BCH(0x537) 余数:合法编码余 0。 */
function bchRemainder(v: number): number {
  let r = v;
  for (let i = 14; i >= 10; i--) {
    if ((r >>> i) & 1) r ^= 0x537 << (i - 10);
  }
  return r;
}

/** 从矩阵左上角的第一份格式信息拷贝还原 15 位值(位序与编码器一致:bit i = 第 i 位)。 */
function readFormatCopy1(m: boolean[][]): number {
  let v = 0;
  for (let i = 0; i <= 5; i++) if (m[i]![8]) v |= 1 << i;
  if (m[7]![8]) v |= 1 << 6;
  if (m[8]![8]) v |= 1 << 7;
  if (m[8]![7]) v |= 1 << 8;
  for (let i = 9; i < 15; i++) if (m[8]![14 - i]) v |= 1 << i;
  return v;
}

/** 第二份拷贝(右下角,行 8 与列 8)。两份必须逐位一致。 */
function readFormatCopy2(m: boolean[][]): number {
  const size = m.length;
  let v = 0;
  for (let i = 0; i < 8; i++) if (m[8]![size - 1 - i]) v |= 1 << i;
  for (let i = 8; i < 15; i++) if (m[size - 15 + i]![8]) v |= 1 << i;
  return v;
}

describe('encodeQr:版本与尺寸', () => {
  it('载荷落在哪个版本,矩阵就是对应尺寸(4n+17,含 2 模块白边由 SVG 层加)', () => {
    expect(encodeQr('a').length).toBe(sizeOf(1)); // 1 ≤ 17
    expect(encodeQr('x'.repeat(18)).length).toBe(sizeOf(2)); // 18 ≤ 32
    expect(encodeQr('x'.repeat(33)).length).toBe(sizeOf(3)); // 33 ≤ 53
    expect(encodeQr('x'.repeat(54)).length).toBe(sizeOf(4)); // 54 ≤ 78
    expect(encodeQr('x'.repeat(78)).length).toBe(sizeOf(4));
  });

  it('字节模式容量按真实位数(码字数 - 2)算,79 字节必须抛错而不是产出坏码', () => {
    // 回归:曾按数据码字数(80)选版本,79–80 字节会溢出数据区被静默截断
    expect(() => encodeQr('x'.repeat(79))).toThrow(/too long/);
  });

  it('矩阵是方阵,且同一输入两次编码结果完全一致(确定性)', () => {
    const a = encodeQr('syncx://pair?v=1&d=KMWQZZT&h=192.168.1.10&p=22000');
    const b = encodeQr('syncx://pair?v=1&d=KMWQZZT&h=192.168.1.10&p=22000');
    expect(a.length).toBe(a[0]!.length);
    expect(a).toEqual(b);
  });
});

describe('encodeQr:功能图案', () => {
  const m = encodeQr('hello');

  it('三个寻像图案:3×3 深色中心 + 1 圈浅色 + 外圈深色', () => {
    const size = m.length;
    // 中心与外框深(以左上角为例)
    expect(m[3]![3]).toBe(true);
    expect(m[0]![0]).toBe(true);
    expect(m[0]![3]).toBe(true);
    expect(m[0]![6]).toBe(true);
    // 中心外一圈(dist 2)浅色
    expect(m[1]![1]).toBe(false);
    expect(m[3]![1]).toBe(false);
    // 分隔条(dist 4)全浅:右下再无图案干涉的角落
    expect(m[7]![0]).toBe(false);
    expect(m[0]![7]).toBe(false);
    // 另外两只角同样成立
    expect(m[3]![size - 4]).toBe(true);
    expect(m[size - 4]![3]).toBe(true);
  });

  it('时序图案:第 6 行/列从 (8,6) 起深浅交替', () => {
    const size = m.length;
    for (let i = 8; i < size - 8; i++) {
      expect(m[6]![i]).toBe(i % 2 === 0);
      expect(m[i]![6]).toBe(i % 2 === 0);
    }
  });

  it('固定深色模块 (8, size-8) 必须为深', () => {
    expect(m[m.length - 8]![8]).toBe(true);
  });
});

describe('encodeQr:格式信息', () => {
  it('15 位 BCH 自洽:去掉 0x5412 掩码后能被 0x537 整除,高 5 位 = L 级 + 掩码 0', () => {
    for (const payload of ['a', 'x'.repeat(60)]) {
      const m = encodeQr(payload);
      const v = readFormatCopy1(m);
      const unmasked = v ^ 0x5412;
      expect(bchRemainder(unmasked)).toBe(0);
      expect(unmasked >>> 10).toBe(0b01_000); // L=01,mask=0
    }
  });

  it('两份拷贝逐位一致', () => {
    const m = encodeQr('hello');
    expect(readFormatCopy2(m)).toBe(readFormatCopy1(m));
  });
});

describe('qrToSvg', () => {
  it('SVG 尺寸 = (模块数 + 2×白边) × 像素,深色模块转成 rect', () => {
    const pixel = 4;
    const svg = qrToSvg('hello', pixel);
    const size = encodeQr('hello').length;
    const dim = (size + 4) * pixel;
    expect(svg).toContain(`width="${dim}"`);
    expect(svg).toContain(`height="${dim}"`);
    expect(svg).toContain('fill="#fff"');
    expect(svg).toContain('fill="#000"');
    expect(svg.match(/<rect /g)!.length).toBeGreaterThan(size); // 白底 1 + 深色模块若干
  });
});

describe('配对串组装与解析', () => {
  it('pairCodeUrl → parsePairCode 往返一致', () => {
    const url = pairCodeUrl('KMWQZZT', '192.168.1.10', 22000);
    expect(url).toBe('syncx://pair?v=1&d=KMWQZZT&h=192.168.1.10&p=22000');
    expect(parsePairCode(url)).toEqual({ deviceId: 'KMWQZZT', host: '192.168.1.10', port: '22000' });
  });

  it('非 syncx:// 输入返回 null(手输设备 ID 走原逻辑)', () => {
    expect(parsePairCode('KMWQZZT')).toBeNull();
    expect(parsePairCode('http://pair?v=1&d=KMWQZZT')).toBeNull();
    expect(parsePairCode('')).toBeNull();
  });

  it('设备 ID 含 base32 之外字符(0/1/9)时拒绝', () => {
    expect(parsePairCode('syncx://pair?d=ABC01')).toBeNull();
    expect(parsePairCode('syncx://pair?d=ABC9')).toBeNull();
    expect(parsePairCode('syncx://pair?d=')).toBeNull();
  });

  it('host / port 可省(deviceId 是唯一必填)', () => {
    expect(parsePairCode('syncx://pair?d=KMWQZZT')).toEqual({
      deviceId: 'KMWQZZT',
      host: '',
      port: '',
    });
  });
});
