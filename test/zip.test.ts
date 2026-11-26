/**
 * zip 写入器:CRC 向量、结构自洽(能被自己的解析器读回)、重名去重、源文件改动作废。
 *
 * 这里刻意不调 `unzip`/`Expand-Archive`:CI 的三个平台不保证都有,而「结构能读回」
 * 已经覆盖了我们要保证的东西(store 模式 + 数据描述符 + 中央目录偏移)。
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { crc32, writeZip } from '../src/zip.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'syncx-zip-'));
}

/** 极简 ZIP 读回:读 EOCD → 中央目录 → 各条目的本地头与数据。 */
function readZip(buf: Buffer): Array<{ name: string; data: Buffer; crc: number }> {
  // EOCD 在末尾 22 字节(没有注释)。
  const eocd = buf.length - 22;
  expect(buf.readUInt32LE(eocd)).toBe(0x06054b50);
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const out: Array<{ name: string; data: Buffer; crc: number }> = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    // 本地头:30 + 名字;flag bit 3 → 数据之后还有 16 字节描述符。
    expect(buf.readUInt32LE(localOffset)).toBe(0x04034b50);
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const dataStart = localOffset + 30 + localNameLen;
    const data = buf.subarray(dataStart, dataStart + size);
    const descriptor = dataStart + size;
    expect(buf.readUInt32LE(descriptor)).toBe(0x08074b50);
    expect(buf.readUInt32LE(descriptor + 4)).toBe(crc);
    expect(buf.readUInt32LE(descriptor + 8)).toBe(size);
    out.push({ name, data, crc });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

describe('zip 写入器', () => {
  it('CRC-32 与标准向量一致', () => {
    expect(crc32(Buffer.from('hello'))).toBe(0x3610a686);
    expect(crc32(Buffer.alloc(0))).toBe(0);
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  it('写出的包能被读回:名字、内容、CRC 都对得上', async () => {
    const dir = tmpDir();
    const a = join(dir, 'a.txt');
    const b = join(dir, 'b.bin');
    const aData = Buffer.from('你好,syncx\n', 'utf8');
    const bData = Buffer.alloc(300_000, 7);
    writeFileSync(a, aData);
    writeFileSync(b, bData);

    const dest = join(dir, 'out.zip');
    const result = await writeZip(dest, [
      { name: 'a.txt', path: a, size: aData.length },
      { name: 'b.bin', path: b, size: bData.length },
    ]);

    const raw = readFileSync(dest);
    expect(result.size).toBe(raw.length);
    expect(result.sha256).toBe(createHash('sha256').update(raw).digest('hex'));

    const parsed = readZip(raw);
    expect(parsed.map((e) => e.name)).toEqual(['a.txt', 'b.bin']);
    expect(parsed[0]!.data.equals(aData)).toBe(true);
    expect(parsed[1]!.data.equals(bData)).toBe(true);
    expect(parsed[0]!.crc).toBe(crc32(aData));
    expect(parsed[1]!.crc).toBe(crc32(bData));
  });

  it('重名与路径分隔符:同名加序号,路径拍平成文件名', async () => {
    const dir = tmpDir();
    const one = join(dir, 'one');
    writeFileSync(one, 'x');
    const dest = join(dir, 'out.zip');
    const result = await writeZip(dest, [
      { name: 'same.txt', path: one, size: 1 },
      { name: 'same.txt', path: one, size: 1 },
      { name: 'dir/nested.txt', path: one, size: 1 },
    ]);
    expect(result.names).toEqual(['same.txt', 'same (1).txt', 'dir_nested.txt']);
    expect(readZip(readFileSync(dest)).map((e) => e.name)).toEqual(result.names);
  });

  it('打包过程中源文件大小变了 → 报错而不是产出坏包', async () => {
    const dir = tmpDir();
    const file = join(dir, 'short.txt');
    writeFileSync(file, 'abc');
    await expect(writeZip(join(dir, 'out.zip'), [{ name: 'short.txt', path: file, size: 10 }]))
      .rejects.toThrow(/大小变了/);
  });
});
