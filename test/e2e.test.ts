import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { BLOCK_SIZE, hashBlock, splitIntoBlocks } from '../src/blockstore.js';
import { loadConfig } from '../src/config.js';
import { setFolderE2E } from '../src/devices.js';
import { buildStatus } from '../src/status.js';
import { createControlServer } from '../src/api.js';
import {
  decPathFor,
  deriveE2EKey,
  e2eKeyBuffer,
  e2eKeyForPeer,
  encryptBlock,
  decryptBlock,
  encPathFor,
  recoverFile,
  toBlindEntries,
  wrapTransportBlind,
} from '../src/e2e.js';
import type { IndexEntry } from '../src/index.js';
import type { PeerTransport } from '../src/peer.js';

/**
 * 端到端加密(v1 盲区站外备份)单测。
 *
 * 覆盖:口令派生的确定性/密钥形态、路径与块的确定性 AEAD、盲区条目换算
 * (密文名 + 密文块真实哈希 + 膨胀尺寸)、整文件还原、transport 包装的整批跳过,
 * 以及 devices 校验、路由透传、状态脱敏三段接线。
 */

const KEY = e2eKeyBuffer(deriveE2EKey('正确的马儿跳'))!;

function entry(path: string, over: Partial<IndexEntry> = {}): IndexEntry {
  return {
    path,
    version: new Map([['DEV1', 1]]),
    size: 0,
    deleted: false,
    blocks: [],
    ...over,
  };
}

describe('deriveE2EKey / e2eKeyBuffer', () => {
  it('同口令同 salt 派生恒定;32 字节密钥', () => {
    const salt = Buffer.from('0123456789abcdef', 'utf8');
    const a = deriveE2EKey('pass-phrase', salt);
    const b = deriveE2EKey('pass-phrase', salt);
    expect(a).toEqual(b);
    expect(Buffer.from(a.key, 'base64')).toHaveLength(32);
    // 换 salt(或缺省随机 salt)得到不同密钥
    const c = deriveE2EKey('pass-phrase');
    const d = deriveE2EKey('pass-phrase');
    expect(c.salt).not.toBe(d.salt);
    expect(c.key).not.toBe(d.key);
  });
  it('形态不合法的记录返回 undefined,不抛错', () => {
    expect(e2eKeyBuffer(undefined)).toBeUndefined();
    expect(e2eKeyBuffer({ salt: 'AA', key: 'not-base64-!!' })).toBeUndefined();
    expect(e2eKeyBuffer({ salt: 'AA', key: Buffer.alloc(16).toString('base64') })).toBeUndefined();
    expect(e2eKeyBuffer({ salt: 'AA', key: '短' })).toBeUndefined();
  });
});

describe('encPathFor / decPathFor', () => {
  it('确定性:同路径同密文名;不同路径不同;单段文件名(不含 /)', () => {
    const e1 = encPathFor(KEY, 'docs/报告.txt');
    expect(encPathFor(KEY, 'docs/报告.txt')).toBe(e1);
    expect(encPathFor(KEY, 'docs/报告.u')).not.toBe(e1);
    expect(e1).not.toContain('/');
    expect(e1).not.toContain('+');
    expect(e1).not.toContain('=');
  });
  it('解密还原;篡改密文名或用错密钥都抛错', () => {
    const p = 'a/b/c.bin';
    expect(decPathFor(KEY, encPathFor(KEY, p))).toBe(p);
    const enc = encPathFor(KEY, p);
    const raw = Buffer.from(enc, 'base64url');
    raw[0] = (raw[0] ?? 0) ^ 0xff;
    expect(() => decPathFor(KEY, raw.toString('base64url'))).toThrow();
    const other = e2eKeyBuffer(deriveE2EKey('另一个口令'))!;
    expect(() => decPathFor(other, enc)).toThrow();
    expect(() => decPathFor(KEY, 'AAAA')).toThrow(/bad encPath/);
  });
});

describe('encryptBlock / decryptBlock', () => {
  it('roundtrip + 确定性(同路径同块号恒定)', () => {
    const enc = encPathFor(KEY, 'f.bin');
    const plain = Buffer.from('hello e2e world');
    const c1 = encryptBlock(KEY, enc, 0, plain);
    expect(encryptBlock(KEY, enc, 0, plain)).toEqual(c1);
    expect(c1).toHaveLength(plain.length + 16);
    expect(decryptBlock(KEY, enc, 0, c1)).toEqual(plain);
  });
  it('块号参与绑定;tag 被篡改抛错', () => {
    const enc = encPathFor(KEY, 'f.bin');
    const plain = Buffer.from('x'.repeat(64));
    const c = encryptBlock(KEY, enc, 0, plain);
    expect(() => decryptBlock(KEY, enc, 1, c)).toThrow();
    const bad = Buffer.from(c);
    bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 0x01;
    expect(() => decryptBlock(KEY, enc, 0, bad)).toThrow();
    expect(() => decryptBlock(KEY, enc, 0, Buffer.from('123'))).toThrow(/bad block/);
  });
});

describe('e2eKeyForPeer', () => {
  const rec = deriveE2EKey('口令口令');
  it('口令已设 + 在名单里才给密钥', () => {
    expect(e2eKeyForPeer({ e2eKey: rec, e2eUntrusted: ['DEVB'] }, 'DEVB')).toBeInstanceOf(Buffer);
    expect(e2eKeyForPeer({ e2eKey: rec, e2eUntrusted: ['DEVB'] }, 'DEVA')).toBeUndefined();
    expect(e2eKeyForPeer({ e2eUntrusted: ['DEVB'] }, 'DEVB')).toBeUndefined();
    expect(e2eKeyForPeer({ e2eKey: { salt: 'x', key: '坏数据' }, e2eUntrusted: ['DEVB'] }, 'DEVB')).toBeUndefined();
  });
});

describe('toBlindEntries', () => {
  const root = mkdtempSync(join(tmpdir(), 'syncx-e2e-'));
  mkdirSync(join(root, 'docs'), { recursive: true });
  const small = Buffer.from('小型文件内容');
  const big = Buffer.alloc(BLOCK_SIZE + 1000, 0xab); // 2 块
  writeFileSync(join(root, 'docs', 'a.txt'), small);
  writeFileSync(join(root, 'docs', 'big.bin'), big);

  it('路径换成密文名单段;块哈希是密文块的真实 SHA-256;尺寸=明文+16B/块', () => {
    const entries = [entry('docs/a.txt', { size: small.length }), entry('docs/big.bin', { size: big.length })];
    const blind = toBlindEntries(entries, KEY, root);
    expect(blind).toHaveLength(2);
    const dataA = readFileSync(join(root, 'docs', 'a.txt'));
    const encA = encPathFor(KEY, 'docs/a.txt');
    const [a, b] = blind as [IndexEntry, IndexEntry];
    expect(a.path).toBe(encA);
    expect(a.blocks).toEqual([hashBlock(encryptBlock(KEY, encA, 0, dataA))]);
    expect(a.size).toBe(small.length + 16);
    expect(b.blocks).toHaveLength(2);
    const blocksBig = splitIntoBlocks(big);
    const encB = encPathFor(KEY, 'docs/big.bin');
    expect(b.blocks).toEqual(blocksBig.map((blk, i) => hashBlock(encryptBlock(KEY, encB, i, blk))));
    expect(b.size).toBe(big.length + 32);
    // 明文路径不出现在任何输出里
    const blob = JSON.stringify(blind);
    expect(blob).not.toContain('docs');
    expect(blob).not.toContain('a.txt');
    expect(blob).not.toContain('big.bin');
  });

  it('tombstone 映射到密文名;读不到的文件整条跳过', () => {
    const blind = toBlindEntries(
      [entry('docs/gone.txt', { deleted: true }), entry('docs/ghost.txt')],
      KEY,
      root,
    );
    expect(blind).toHaveLength(1);
    const t = blind[0]!;
    expect(t.path).toBe(encPathFor(KEY, 'docs/gone.txt'));
    expect(t.deleted).toBe(true);
    expect(t.blocks).toEqual([]);
  });
});

describe('recoverFile', () => {
  it('凭口令从盲区磁盘密文还原路径与全文(跨块)', () => {
    const plain = Buffer.concat([Buffer.from('头'), Buffer.alloc(BLOCK_SIZE, 0x5a), Buffer.from('尾')]);
    const path = 'deep/nest/文件.dat';
    const enc = encPathFor(KEY, path);
    const cipher = Buffer.concat(splitIntoBlocks(plain).map((blk, i) => encryptBlock(KEY, enc, i, blk)));
    const got = recoverFile(KEY, enc, cipher);
    expect(got.path).toBe(path);
    expect(got.data).toEqual(plain);
    // 盲区磁盘上的密文文件尺寸与 toBlindEntries 宣告的 size 一致
    expect(cipher.length).toBe(plain.length + 16 * splitIntoBlocks(plain).length);
  });
});

describe('wrapTransportBlind', () => {
  /** 假 transport:记录每类出站帧。 */
  function capture(): { t: PeerTransport; sent: { entries: IndexEntry[][]; req: unknown[]; res: unknown[] } } {
    const sent = { entries: [] as IndexEntry[][], req: [] as unknown[], res: [] as unknown[] };
    const t: PeerTransport = {
      sendEntries(entries) {
        sent.entries.push(entries);
      },
      sendBlockRequest(r) {
        sent.req.push(r);
      },
      sendBlockResponse(r) {
        sent.res.push(r);
      },
    };
    return { t, sent };
  }

  it('宣告换成密文视图;块请求/响应原样透传', () => {
    const root = mkdtempSync(join(tmpdir(), 'syncx-e2e-wrap-'));
    writeFileSync(join(root, 'x.txt'), '内容');
    const { t, sent } = capture();
    const w = wrapTransportBlind(t, KEY, root);
    w.sendEntries([entry('x.txt', { size: 6 })], 'full');
    expect(sent.entries).toHaveLength(1);
    expect(sent.entries[0]![0]!.path).toBe(encPathFor(KEY, 'x.txt'));
    const req = { path: 'p', blockIndex: 0, hash: 'h' };
    w.sendBlockRequest(req as never);
    expect(sent.req).toEqual([req]);
    const res = { path: 'p', blockIndex: 0, hash: 'h', data: Buffer.alloc(0) };
    w.sendBlockResponse(res as never, { priority: true });
    expect(sent.res).toEqual([res]);
  });

  it('活文件全读不到时不发帧(空 full 会让盲区端误判);tombstone 仍会发出', () => {
    const { t, sent } = capture();
    const w = wrapTransportBlind(t, KEY, mkdtempSync(join(tmpdir(), 'syncx-e2e-empty-')));
    w.sendEntries([entry('missing.txt')], 'full');
    expect(sent.entries).toHaveLength(0);
    w.sendEntries([entry('gone.txt', { deleted: true })], 'delta');
    expect(sent.entries).toHaveLength(1);
    expect(sent.entries[0]![0]!.deleted).toBe(true);
  });
});

describe('devices.setFolderE2E', () => {
  function tempConfig(): string {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-e2e-cfg-'));
    const file = join(dir, 'config.json');
    writeFileSync(
      file,
      JSON.stringify({
        sharedFolders: [{ path: '/data/box', devices: ['DEVA', 'DEVB'] }],
        peers: [],
        knownDevices: [],
      }),
    );
    return file;
  }
  function folderOf(file: string) {
    return loadConfig(file).sharedFolders[0]!;
  }

  it('设口令落密钥不落口令;名单去重修剪', () => {
    const file = tempConfig();
    setFolderE2E(file, '/data/box', { passphrase: '超长的秘密口令', untrusted: ['DEVB', ' DEVB ', 'DEVA'] });
    const f = folderOf(file);
    expect(f.e2eKey?.key).toBeTruthy();
    expect(f.e2eUntrusted).toEqual(['DEVB', 'DEVA']);
    // 口令本体绝不落盘
    expect(readFileSync(file, 'utf8')).not.toContain('超长的秘密口令');
  });

  it('没口令不能标名单;口令过短拒绝;设备不在目录拒绝', () => {
    const file = tempConfig();
    expect(() => setFolderE2E(file, '/data/box', { untrusted: ['DEVA'] })).toThrow(/请先设置端到端口令/);
    expect(() => setFolderE2E(file, '/data/box', { passphrase: '短' })).toThrow(/4–512/);
    setFolderE2E(file, '/data/box', { passphrase: '够长的口令' });
    expect(() => setFolderE2E(file, '/data/box', { untrusted: ['DEVZ'] })).toThrow(/尚未共享该目录/);
  });

  it('清空口令连带清名单;untrusted:null 单独清名单', () => {
    const file = tempConfig();
    setFolderE2E(file, '/data/box', { passphrase: '够长的口令', untrusted: ['DEVA'] });
    setFolderE2E(file, '/data/box', { untrusted: null });
    expect(folderOf(file).e2eKey).toBeTruthy();
    expect(folderOf(file).e2eUntrusted).toBeUndefined();
    setFolderE2E(file, '/data/box', { passphrase: '' });
    expect(folderOf(file).e2eKey).toBeUndefined();
    expect(folderOf(file).e2eUntrusted).toBeUndefined();
  });
});

describe('POST /api/folders/e2e', () => {
  async function withServer(
    deps: Partial<Parameters<typeof createControlServer>[0]>,
  ): Promise<{ port: number; close: () => void }> {
    const server = createControlServer({
      token: 'secret',
      getStatus: () => ({}),
      ...deps,
    } as Parameters<typeof createControlServer>[0]);
    server.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    return {
      port: (server.address() as AddressInfo).port,
      close: () => server.close(),
    };
  }

  function post(port: number, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path: '/api/folders/e2e',
          method: 'POST',
          headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
        },
        (res) => {
          res.setEncoding('utf8');
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, json: data === '' ? {} : (JSON.parse(data) as Record<string, unknown>) }),
          );
        },
      );
      req.on('error', reject);
      req.write(JSON.stringify(body));
      req.end();
    });
  }

  it('folderId 缺失 / passphrase 非串 / untrusted 非串数组都 400', async () => {
    const { port, close } = await withServer({ setFolderE2E: () => {} });
    expect((await post(port, { passphrase: 'x' })).status).toBe(400);
    expect((await post(port, { folderId: 'f', passphrase: 123 })).status).toBe(400);
    expect((await post(port, { folderId: 'f', untrusted: 'DEVA' })).status).toBe(400);
    expect((await post(port, { folderId: 'f', untrusted: [1] })).status).toBe(400);
    close();
  });

  it('合法请求 present-key 透传;passphrase null 归一成空串(清除语义)', async () => {
    let patch: Record<string, unknown> | null = null;
    const { port, close } = await withServer({
      setFolderE2E: (folderId: string, p: Record<string, unknown>) => {
        patch = { folderId, ...p };
      },
    });
    const res = await post(port, { folderId: '/data/box', passphrase: null, untrusted: ['DEVA'] });
    expect(res.status).toBe(200);
    expect(patch).toEqual({ folderId: '/data/box', passphrase: '', untrusted: ['DEVA'] });
    // 只带 untrusted 时不出现 passphrase 键(present-key 语义)
    patch = null;
    await post(port, { folderId: '/data/box', untrusted: [] });
    expect(patch).toEqual({ folderId: '/data/box', untrusted: [] });
    close();
  });
});

describe('buildStatus 密钥脱敏', () => {
  it('有 e2eKey 的目录只外发 e2eKeySet 标志,密钥本体不出 daemon', () => {
    const rec = deriveE2EKey('口令口令口令');
    const status = buildStatus(
      { deviceId: 'DEV1234567', publicKey: 'pk', privateKey: 'sk' },
      {
        sharedFolders: [
          { path: '/data/box', devices: ['DEVA'], e2eKey: rec, e2eUntrusted: ['DEVA'] },
          { path: '/data/open', devices: ['DEVA'] },
        ],
        peers: [],
        knownDevices: [],
        pendingOffers: [],
      } as never,
      { entries: 1, tombstones: 0 },
    );
    const folders = status.folders as unknown as Record<string, unknown>[];
    expect(folders[0]!.e2eKey).toBeUndefined();
    expect(folders[0]!.e2eKeySet).toBe(true);
    expect(folders[0]!.e2eUntrusted).toEqual(['DEVA']);
    expect(folders[1]!.e2eKeySet).toBeUndefined();
    expect(JSON.stringify(status)).not.toContain(rec.key);
  });
});
