import { createHash } from 'node:crypto';

export const BLOCK_SIZE = 1 * 1024 * 1024;

export function splitIntoBlocks(data: Buffer): Buffer[] {
  const blocks: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += BLOCK_SIZE) {
    blocks.push(data.subarray(offset, Math.min(offset + BLOCK_SIZE, data.length)));
  }
  return blocks;
}

export function hashBlock(block: Buffer): string {
  return createHash('sha256').update(block).digest('hex');
}

export function verifyBlock(block: Buffer, hash: string): boolean {
  return hashBlock(block) === hash;
}
