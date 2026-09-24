/**
 * 极简 QR 编码器(字节模式,纠错等级 L,版本 1–4,固定掩码 0)。
 *
 * 为什么手写而不引依赖:项目刻意保持零运行时依赖(除 vue/naive-ui/ws 等),
 * 而配对二维码的载荷只有一个 `syncx://pair?d=…&h=…&p=…` 串(≤80 字节),
 * 版本 4-L(80 字节、单 RS 块)绰绰有余 —— 恰好避开多块交织的复杂度,
 * 整个编码器可以压在一个文件里。要编码更长内容时再考虑升级版本数。
 *
 * 算法与布局遵循 ISO/IEC 18004:模式头(0100)+ 8 位字符数 + 数据字节,
 * RS 纠错(GF(256),α=2),寻像/校正/时序图案与格式信息按标准摆位,
 * 数据沿双列锯齿自右下向上填充,套掩码 0((row+col)%2==0 翻转)。
 * 任何解码器都支持任意掩码,固定 0 不影响识别,只是冗余度略欠优化。
 */

// ---- GF(256),本原多项式 0x11d,α = 2 ----
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a]! + LOG[b]!]!;
}

/** 各版本(L 级,单块)的数据码字数:总码字 - 纠错码字。 */
const DATA_CODEWORDS = [19, 34, 55, 80];
/** 各版本(L 级)的每块纠错码字数。 */
const EC_CODEWORDS = [7, 10, 15, 20];
/**
 * 各版本字节模式真实容量(字节):dataLen*8 位里要先扣掉 12 位头部(模式 4 + 长度 8),
 * floor((dataLen*8 - 12)/8) = dataLen - 2。按码字数选版本会差 1–2 字节 ——
 * 多出的字节会溢出数据区被静默截断,码看起来正常却解不出来。
 */
const BYTE_CAPACITY = DATA_CODEWORDS.map((n) => n - 2);

/** 生成 x^ecLen 阶 RS 生成多项式系数(高次在前)。 */
function rsGenerator(ecLen: number): number[] {
  let g: number[] = [1];
  for (let i = 0; i < ecLen; i++) {
    const next = new Array<number>(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j]! ^= g[j]!; // 乘 x
      next[j + 1]! ^= gfMul(g[j]!, EXP[i]!); // 乘 (x + α^i)
    }
    g = next;
  }
  return g;
}

/** 对数据码字做 RS 纠错,返回 ecLen 个校验码字。 */
function rsEncode(data: number[], ecLen: number): number[] {
  const gen = rsGenerator(ecLen);
  const buf = [...data, ...new Array<number>(ecLen).fill(0)];
  for (let i = 0; i < data.length; i++) {
    const factor = buf[i]!;
    if (factor === 0) continue;
    for (let j = 1; j < gen.length; j++) {
      buf[i + j]! ^= gfMul(gen[j]!, factor);
    }
  }
  return buf.slice(data.length);
}

/** 格式信息:5 位数据(2 位纠错级 L=01 + 3 位掩码号)+ 10 位 BCH,再异或 0x5412。 */
function formatBits(mask: number): number {
  const data = 0b01 << 3 | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) {
    rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  }
  return ((data << 10) | rem) ^ 0x5412;
}

/**
 * 把字节串编码为 QR 矩阵(true = 深色模块)。
 * 超过 78 字节(版本 4-L 字节容量)抛错 —— 这个编码器只服务配对串这类短载荷。
 */
export function encodeQr(text: string): boolean[][] {
  const bytes = Array.from(new TextEncoder().encode(text));
  const version = BYTE_CAPACITY.findIndex((cap) => cap >= bytes.length);
  if (version < 0) {
    throw new Error(`QR payload too long: ${bytes.length} bytes (max ${BYTE_CAPACITY[3]})`);
  }
  const dataLen = DATA_CODEWORDS[version]!;
  const ecLen = EC_CODEWORDS[version]!;

  // ---- 数据位流:模式(0100)+ 长度(8 位)+ 数据 + 终止符 + 补齐 ----
  const bits: number[] = [0, 1, 0, 0];
  const pushBits = (value: number, len: number): void => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  pushBits(bytes.length, 8);
  for (const b of bytes) pushBits(b, 8);
  pushBits(0, Math.min(4, dataLen * 8 - bits.length)); // 终止符(最多 4 位)
  while (bits.length % 8 !== 0) bits.push(0); // 补到字节边界
  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]!;
    codewords.push(b);
  }
  for (let pad = 0; codewords.length < dataLen; pad++) codewords.push(pad % 2 === 0 ? 0xec : 0x11); // 0xEC/0x11 交替
  codewords.push(...rsEncode(codewords, ecLen));

  // ---- 画功能图案 ----
  const size = 4 * (version + 1) + 17;
  const modules: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const isFunction: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const setFn = (x: number, y: number, dark: boolean): void => {
    modules[y]![x] = dark;
    isFunction[y]![x] = true;
  };
  const finder = (cx: number, cy: number): void => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        setFn(x, y, dist !== 2 && dist !== 4); // 7×7 环 + 白边(分隔条)
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  // 校正图案(版本 2–4 只有右下角一个,中心 size-7)
  if (version >= 2) {
    const c = size - 7;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        setFn(c + dx, c + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }
  // 时序图案:第 6 行/列,深浅交替
  for (let i = 8; i < size - 8; i++) {
    setFn(i, 6, i % 2 === 0);
    setFn(6, i, i % 2 === 0);
  }
  setFn(8, size - 8, true); // 固定深色模块

  // ---- 格式信息(两份拷贝,先于数据填充:这些位置必须标记为功能模块供数据绕行;
  //      格式信息自带 0x5412 掩码,不受数据掩码影响,画一次即可) ----
  const fmt = formatBits(0);
  const fmtBit = (i: number): boolean => ((fmt >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) setFn(8, i, fmtBit(i)); // 左上竖段
  setFn(8, 7, fmtBit(6));
  setFn(8, 8, fmtBit(7));
  setFn(7, 8, fmtBit(8));
  for (let i = 9; i < 15; i++) setFn(14 - i, 8, fmtBit(i)); // 左上横段
  for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, fmtBit(i)); // 右下横段(行 8)
  for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, fmtBit(i)); // 右下竖段(列 8)

  // ---- 数据填充:双列锯齿,自右下角起;掩码 0 直接在放置时套用 ----
  let bitIdx = 0;
  const totalBits = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // 跳过时序列
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (isFunction[y]![x]) continue;
        let dark = bitIdx < totalBits ? ((codewords[bitIdx >>> 3]! >>> (7 - (bitIdx & 7))) & 1) === 1 : false;
        if ((x + y) % 2 === 0) dark = !dark; // 掩码 0
        modules[y]![x] = dark;
        bitIdx++;
      }
    }
  }

  return modules;
}

/** 渲染成 SVG 字符串(视框自带 2 模块白边)。 */
export function qrToSvg(text: string, pixel = 4): string {
  const m = encodeQr(text);
  const size = m.length;
  const quiet = 2;
  const dim = (size + quiet * 2) * pixel;
  let rects = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (m[y]![x]) rects += `<rect x="${(x + quiet) * pixel}" y="${(y + quiet) * pixel}" width="${pixel}" height="${pixel}"/>`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}"><rect width="${dim}" height="${dim}" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
}

/** 组装本机配对串:syncx://pair?v=1&d=<deviceId>&h=<host>&p=<port>。 */
export function pairCodeUrl(deviceId: string, host: string, port: number): string {
  return `syncx://pair?v=1&d=${encodeURIComponent(deviceId)}&h=${encodeURIComponent(host)}&p=${port}`;
}

/** 解析配对串(或手输内容):合法 syncx://pair 链接返回三要素,其余返回 null。 */
export function parsePairCode(input: string): { deviceId: string; host: string; port: string } | null {
  if (!input.startsWith('syncx://')) return null;
  try {
    const url = new URL(input);
    const d = url.searchParams.get('d');
    if (!d) return null;
    const h = url.searchParams.get('h') ?? '';
    const p = url.searchParams.get('p') ?? '';
    if (!/^[a-zA-Z2-7]+$/.test(d)) return null; // base32 设备 ID
    return { deviceId: d, host: h, port: p };
  } catch {
    return null;
  }
}
