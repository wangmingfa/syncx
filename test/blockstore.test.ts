import { describe, expect, it } from 'vitest';
import { BLOCK_SIZE, splitIntoBlocks, hashBlock, verifyBlock } from '../src/blockstore.js';

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
});
