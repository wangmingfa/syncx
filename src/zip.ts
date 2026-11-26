/**
 * 最小 ZIP 写入器:直发「把多个文件打包成一个压缩包」用它(ADR-0028)。
 *
 * 只做 **store**(方法 0,不压缩),两个理由:
 *  - 直发的瓶颈是链路与往返,不是 CPU;压缩会把上限语义搞模糊(包内体积 ≠ 源文件体积),
 *    而 100MB 的判定必须可预期;
 *  - store 可以纯流式:边读边写、边算 CRC,任何一个文件都不必整个读进内存
 *    (直发的其余路径都在刻意避免整文件驻留,这里没理由破例)。
 *
 * 用「数据描述符」(本地头 flag bit 3)把 CRC 与长度写在数据**之后**:CRC 只有读完才知道,
 * 而流式写不允许回头改前面的本地头。文件名一律按 UTF-8 写并置 flag bit 11。
 */

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';

export interface ZipEntry {
  /** 包内路径(只支持同级文件名,出现分隔符会被替换掉)。 */
  name: string;
  /** 源文件绝对路径。 */
  path: string;
  /** 源文件大小,用于发现「打包过程中被改动」。 */
  size: number;
}

export interface ZipResult {
  size: number;
  sha256: string;
  /** 实际写进包里的文件名(重名时已加序号),与 entries 一一对应。 */
  names: string[];
}

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const DESCRIPTOR_SIG = 0x08074b50;
/** bit 3 = 长度/CRC 在数据之后;bit 11 = 文件名是 UTF-8。 */
const FLAGS = 0x0808;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/** 增量 CRC-32:入参是「未取反」的中间值,首块传 0xffffffff,末块再取反。 */
export function crc32Update(crc: number, buf: Buffer): number {
  let c = crc >>> 0;
  for (let i = 0; i < buf.length; i++) {
    c = (CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
  }
  return c;
}

/** 一次性算 CRC-32(测试与短数据用)。 */
export function crc32(buf: Buffer): number {
  return (crc32Update(0xffffffff, buf) ^ 0xffffffff) >>> 0;
}

/** MS-DOS 时间戳:ZIP 的老格式只有它,秒的精度是 2 秒。 */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(d.getFullYear(), 1980);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** 包内只放同级文件名:`../` 或 `a/b` 这种路径要么是调用方出错,要么是攻击。 */
function entryName(raw: string, used: Set<string>): string {
  const flat = raw.replace(/[\\/]+/g, '_').trim() || 'file';
  let name = flat;
  let n = 1;
  while (used.has(name.toLowerCase())) {
    const dot = flat.lastIndexOf('.');
    name = dot > 0 ? `${flat.slice(0, dot)} (${n})${flat.slice(dot)}` : `${flat} (${n})`;
    n++;
  }
  used.add(name.toLowerCase());
  return name;
}

/**
 * 写一个 store 模式的 zip。返回包大小、整包 sha256(直发提议要用)与实际条目名。
 * 源文件在读取过程中变短/变长直接抛错,而不是产出一个损坏的包。
 */
export async function writeZip(dest: string, entries: ZipEntry[]): Promise<ZipResult> {
  const hash = createHash('sha256');
  /** 已写出的字节数 = 下一个本地头的偏移(中央目录要回填每个条目的起点)。 */
  let offset = 0;
  const ws = createWriteStream(dest, { flags: 'wx' });
  let failure: Error | undefined;
  ws.on('error', (e: Error) => { failure = e; });

  /** 写一块并等它真的落进内核缓冲:回调本身就是背压,不必另外等 drain。 */
  async function put(buf: Buffer): Promise<void> {
    offset += buf.length;
    hash.update(buf);
    await new Promise<void>((resolve, reject) => {
      ws.write(buf, (err) => (err ? reject(err) : resolve()));
    });
    if (failure) throw failure;
  }

  const { time, date } = dosDateTime(new Date());
  const used = new Set<string>();
  const names: string[] = [];
  const central: Buffer[] = [];

  try {
    for (const entry of entries) {
      const name = entryName(entry.name, used);
      names.push(name);
      const nameBuf = Buffer.from(name, 'utf8');
      const localOffset = offset;

      const local = Buffer.alloc(30);
      local.writeUInt32LE(LOCAL_SIG, 0);
      local.writeUInt16LE(20, 4); // 需要 2.0 才能解
      local.writeUInt16LE(FLAGS, 6);
      local.writeUInt16LE(0, 8); // store
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      // CRC / 压缩后大小 / 原始大小留 0,交给数据描述符。
      local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt16LE(0, 28);
      await put(local);
      await put(nameBuf);

      let crc = 0xffffffff;
      let written = 0;
      for await (const chunk of createReadStream(entry.path)) {
        const buf = chunk as Buffer;
        crc = crc32Update(crc, buf);
        written += buf.length;
        await put(buf);
      }
      if (written !== entry.size) {
        throw new Error(`打包时源文件大小变了:${entry.name}(${entry.size} → ${written} 字节)`);
      }
      const finalCrc = (crc ^ 0xffffffff) >>> 0;

      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(DESCRIPTOR_SIG, 0);
      descriptor.writeUInt32LE(finalCrc, 4);
      descriptor.writeUInt32LE(written, 8);
      descriptor.writeUInt32LE(written, 12);
      await put(descriptor);

      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(CENTRAL_SIG, 0);
      cd.writeUInt16LE(20, 4); // version made by
      cd.writeUInt16LE(20, 6); // version needed
      cd.writeUInt16LE(FLAGS, 8);
      cd.writeUInt16LE(0, 10);
      cd.writeUInt16LE(time, 12);
      cd.writeUInt16LE(date, 14);
      cd.writeUInt32LE(finalCrc, 16);
      cd.writeUInt32LE(written, 20);
      cd.writeUInt32LE(written, 24);
      cd.writeUInt16LE(nameBuf.length, 28);
      cd.writeUInt16LE(0, 30); // extra
      cd.writeUInt16LE(0, 32); // comment
      cd.writeUInt16LE(0, 34); // disk start
      cd.writeUInt16LE(0, 36); // internal attrs
      cd.writeUInt32LE(0, 38); // external attrs
      cd.writeUInt32LE(localOffset, 42);
      central.push(cd, nameBuf);
    }

    const cdOffset = offset;
    let cdSize = 0;
    for (const rec of central) {
      await put(rec);
      cdSize += rec.length;
    }
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(EOCD_SIG, 0);
    eocd.writeUInt16LE(0, 4); // 本盘号
    eocd.writeUInt16LE(0, 6); // 中央目录所在盘
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdOffset, 16);
    eocd.writeUInt16LE(0, 20); // 注释长度
    await put(eocd);

    await new Promise<void>((resolve, reject) => {
      ws.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  } catch (e) {
    ws.destroy();
    throw e;
  }

  return { size: offset, sha256: hash.digest('hex'), names };
}

/** 供测试与调用方判断:一次打包最多塞这么多(与直发单文件上限同口径)。 */
export const ZIP_MAX_BYTES = 100 * 1024 * 1024;
