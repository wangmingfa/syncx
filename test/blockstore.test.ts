import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BLOCK_SIZE, splitIntoBlocks, hashBlock, verifyBlock, readBlockAt } from '../src/blockstore.js';

describe('blockstore', () => {
  it('splits a small buffer into a single block', () => {
    const data = Buffer.from('hello syncx');
    const blocks = splitIntoBlocks(data);
    expect(blocks.length).toBe(1);
    expect(blocks[0]).toEqual(data);
  });

  it('splits a buffer larger than one block', () => {
    const data = Buffer.alloc(BLOCK_SIZE + 10, 0xab);
    const blocks = splitIntoBlocks(data);
    expect(blocks.length).toBe(2);
    expect(blocks[0]!.length).toBe(BLOCK_SIZE);
    expect(blocks[1]!.length).toBe(10);
    expect(Buffer.concat(blocks).equals(data)).toBe(true);
  });

  it('hashes a block with sha-256', () => {
    const hash = hashBlock(Buffer.from('hello'));
    expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('verifies a block against its hash', () => {
    const block = Buffer.from('hello');
    expect(verifyBlock(block, hashBlock(block))).toBe(true);
  });

  it('rejects a block whose content does not match the hash', () => {
    const block = Buffer.from('hello');
    const otherHash = hashBlock(Buffer.from('hellx'));
    expect(verifyBlock(block, otherHash)).toBe(false);
  });

  describe('readBlockAt(按偏移读单块)', () => {
    it('reads only the requested block without loading the whole file', () => {
      const dir = mkdtempSync(join(tmpdir(), 'syncx-blockstore-'));
      try {
        // 2 块整 + 末块短:首尾与中间各不相同,能暴露「读错偏移 / 读到相邻块」的问题
        const head = Buffer.alloc(BLOCK_SIZE, 0x11);
        const mid = Buffer.alloc(BLOCK_SIZE, 0x22);
        const tail = Buffer.from('tail-bytes');
        const file = join(dir, 'big.bin');
        writeFileSync(file, Buffer.concat([head, mid, tail]));

        expect(readBlockAt(file, 0).equals(head)).toBe(true);
        expect(readBlockAt(file, 1).equals(mid)).toBe(true);
        expect(readBlockAt(file, 2).equals(tail)).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('throws for an index beyond the file size (含文件被截短)', () => {
      const dir = mkdtempSync(join(tmpdir(), 'syncx-blockstore-'));
      try {
        const file = join(dir, 'small.bin');
        writeFileSync(file, Buffer.from('tiny'));
        expect(() => readBlockAt(file, 0)).not.toThrow();
        expect(() => readBlockAt(file, 1)).toThrow(/out of range/);
        expect(() => readBlockAt(file, 99)).toThrow(/out of range/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('reads exactly what splitIntoBlocks would slice, block by block', () => {
      const dir = mkdtempSync(join(tmpdir(), 'syncx-blockstore-'));
      try {
        const data = Buffer.alloc(BLOCK_SIZE * 2 + 1234, 0x5a);
        const file = join(dir, 'parity.bin');
        writeFileSync(file, data);
        splitIntoBlocks(data).forEach((expected, i) => {
          expect(readBlockAt(file, i).equals(expected)).toBe(true);
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
