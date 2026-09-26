/**
 * 端到端加密目录(不可信节点)—— v1 口径:**盲区站外备份**。
 *
 * 场景:把某个共享目录同步给一个「只存块、看不懂内容」的备份/中转节点。
 * 目录主人设置口令(scrypt 派生密钥存 config,口令本体不落盘),并把该节点
 * 的设备 id 列入 `e2eUntrusted`。此后**发给这些对端的一切**都是密文视图:
 *  - 路径:确定性加密(chacha20-poly1305)→ 单个 base64url 文件名,盲区端看不到目录结构与真实路径;
 *  - 内容:逐块加密(块号与密文路径绑定 nonce),宣告的块哈希是**密文块的真实 SHA-256**,
 *    因此盲区端的扫描/校验/落盘全走原有管线,零特判;
 *  - 盲区端永不回源:它的索引宣告在可信端被整轮忽略(e2e 会话只出不进),块请求由可信端
 *    读明文、现场加密后响应;控制面目录索引快照对盲区端拒绝服务。
 *
 * 已知边界(v1 刻意如此,勿当 bug 修):
 *  - 泄露:路径长度(密文长度≈明文长度)、文件大小(密文=明文+16B/块)、修改时序与版本数;
 *  - 同一 (路径, 块号) 的密钥流恒定 ⇒ 盲区端若留存了同一块的两个历史版本,可 XOR 出明文差;
 *    v1 盲区端只保留最新一份(接收即覆盖),正常使用不触发;
 *  - 长路径密文变长(≈4/3 + tag),文件系统单段名上限(NTFS 255B)约合 170 字符明文;
 *  - 每次挂接/重连向盲区端全量重算密文视图(逐块读文件),百 GB 级目录首传较慢。
 *  - 还原:凭口令 + 盲区端磁盘可完整还原(recoverFile),不必依赖任何一端的索引。
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BLOCK_SIZE, hashBlock, splitIntoBlocks } from './blockstore.js';
import type { IndexEntry } from './index.js';
// 仅类型引用(peer.ts 运行时反向依赖本模块,`import type` 编译期擦除,不构成环)
import type { IndexMode, PeerTransport } from './peer.js';

const KEY_LEN = 32;
const NONCE_LEN = 12;
const TAG_LEN = 16;
/** scrypt 参数:N=2^15 需 ~64MB 内存,派生一次几十 ms,可接受(Node 默认 maxmem=32MB,显式放宽)。 */
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

/** config 里的落盘形态(salt/key 均 base64;口令本体绝不落盘)。 */
export interface E2EKeyRecord {
  salt: string;
  key: string;
}

/** 口令 → 落盘密钥记录。同一口令 + 同一 salt 派生结果恒定;新 salt 随机。 */
export function deriveE2EKey(passphrase: string, salt?: Buffer): E2EKeyRecord {
  const s = salt ?? randomBytes(16);
  const key = scryptSync(passphrase, s, KEY_LEN, SCRYPT);
  return { salt: s.toString('base64'), key: key.toString('base64') };
}

/** 从落盘记录恢复密钥 Buffer;形态不合法(base64 解出来不是 32 字节)返回 undefined。 */
export function e2eKeyBuffer(rec: E2EKeyRecord | undefined): Buffer | undefined {
  if (!rec || typeof rec.key !== 'string' || typeof rec.salt !== 'string') return undefined;
  const raw = Buffer.from(rec.key, 'base64');
  return raw.length === KEY_LEN ? raw : undefined;
}

/** 该目录对该对端是否走端到端加密视图(口令已设 + 对端在不可信名单里)。 */
export function e2eKeyForPeer(
  folderConfig: { e2eKey?: E2EKeyRecord; e2eUntrusted?: string[] },
  remoteDeviceId: string,
): Buffer | undefined {
  const key = e2eKeyBuffer(folderConfig.e2eKey);
  if (!key) return undefined;
  return (folderConfig.e2eUntrusted ?? []).includes(remoteDeviceId) ? key : undefined;
}

/** 派生一个 32B 子密钥:domain 是固定域分隔串,ctx 是本次用途上下文。 */
function subkey(key: Buffer, domain: string, ctx = ''): Buffer {
  return createHmac('sha256', key).update(`syncx-e2e/${domain}${ctx}`).digest();
}

function nonceOf(key: Buffer, domain: string, ctx: string): Buffer {
  return createHmac('sha256', key).update(`syncx-e2e/n/${domain}${ctx}`).digest().subarray(0, NONCE_LEN);
}

/**
 * 确定性加密相对路径(整条路径作为一个字符串加密,不保留目录层级)。
 * 同一路径永远得到同一密文名 —— 版本一致性与「改名=删+增」的同步语义都依赖这点。
 */
export function encPathFor(key: Buffer, path: string): string {
  const k = subkey(key, 'path', '');
  const c = createCipheriv('chacha20-poly1305', k, nonceOf(key, 'path', ''), { authTagLength: TAG_LEN });
  c.setAAD(Buffer.from('syncx-e2e/path', 'utf8'));
  const ct = Buffer.concat([c.update(Buffer.from(path, 'utf8')), c.final()]);
  return Buffer.concat([ct, c.getAuthTag()]).toString('base64url');
}

/** 解密回原路径;密文名被篡改/非本密钥产出时抛错。 */
export function decPathFor(key: Buffer, encPath: string): string {
  const raw = Buffer.from(encPath, 'base64url');
  if (raw.length < TAG_LEN) throw new Error('e2e: bad encPath');
  const k = subkey(key, 'path', '');
  const d = createDecipheriv('chacha20-poly1305', k, nonceOf(key, 'path', ''), { authTagLength: TAG_LEN });
  d.setAAD(Buffer.from('syncx-e2e/path', 'utf8'));
  d.setAuthTag(raw.subarray(raw.length - TAG_LEN));
  return Buffer.concat([d.update(raw.subarray(0, raw.length - TAG_LEN)), d.final()]).toString('utf8');
}

/** 加密一个明文块;nonce 绑定 (密文路径, 块号),确定性。 */
export function encryptBlock(key: Buffer, encPath: string, blockIndex: number, plain: Buffer): Buffer {
  const ctx = `${encPath}:${blockIndex}`;
  const c = createCipheriv('chacha20-poly1305', subkey(key, 'blk', ''), nonceOf(key, 'blk', ctx), {
    authTagLength: TAG_LEN,
  });
  c.setAAD(Buffer.from(`syncx-e2e/${ctx}`, 'utf8'));
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
}

/** 解密一个密文块(还原用);完整性失败时抛错。 */
export function decryptBlock(key: Buffer, encPath: string, blockIndex: number, cipher: Buffer): Buffer {
  const ctx = `${encPath}:${blockIndex}`;
  if (cipher.length < TAG_LEN) throw new Error('e2e: bad block');
  const d = createDecipheriv('chacha20-poly1305', subkey(key, 'blk', ''), nonceOf(key, 'blk', ctx), {
    authTagLength: TAG_LEN,
  });
  d.setAAD(Buffer.from(`syncx-e2e/${ctx}`, 'utf8'));
  d.setAuthTag(cipher.subarray(cipher.length - TAG_LEN));
  return Buffer.concat([d.update(cipher.subarray(0, cipher.length - TAG_LEN)), d.final()]);
}

/**
 * 本地索引条目 → 盲区对端可见的密文条目。blocks 换成**密文块的真实 SHA-256**
 * (逐块读文件现场加密),盲区端落盘后自扫描哈希自然吻合,不会反复重拉。
 * 本地文件此刻读不到(在途删除/tmp 改名)的条目**整条跳过** —— 与既有的
 * 「供不出的块靠下一轮索引收敛」行为一致。
 * 入参条目须为 '/' 分隔相对路径(索引口径)。
 */
export function toBlindEntries(entries: IndexEntry[], key: Buffer, root: string): IndexEntry[] {
  const out: IndexEntry[] = [];
  for (const e of entries) {
    const enc = encPathFor(key, e.path);
    if (e.deleted) {
      out.push({ path: enc, version: e.version, size: 0, deleted: true, blocks: [] });
      continue;
    }
    let data: Buffer;
    try {
      data = readFileSync(join(root, e.path));
    } catch {
      continue; // 文件读不到:这条不宣告,下一轮再收敛
    }
    const blocks = splitIntoBlocks(data).map((b, i) => hashBlock(encryptBlock(key, enc, i, b)));
    const size = data.length + blocks.length * TAG_LEN;
    out.push({ path: enc, version: e.version, size, deleted: false, blocks });
  }
  return out;
}

/**
 * 从盲区端磁盘还原一份明文(可信端索引已丢失时的救命通道):
 * encPath 解回相对路径,密文文件按块切(每块 = 明文块 +16B tag)逐块解密拼接。
 */
export function recoverFile(key: Buffer, encPath: string, cipherData: Buffer): { path: string; data: Buffer } {
  const path = decPathFor(key, encPath);
  const CB = BLOCK_SIZE + TAG_LEN;
  const parts: Buffer[] = [];
  for (let off = 0, i = 0; off < cipherData.length; off += CB, i += 1) {
    parts.push(decryptBlock(key, encPath, i, cipherData.subarray(off, Math.min(off + CB, cipherData.length))));
  }
  return { path, data: Buffer.concat(parts) };
}

/**
 * 盲区 transport 包装:可信端向不可信对端发出的一切索引宣告先换成密文视图。
 * sendEntries 之外原样透传(块响应在 SyncPeer 内已完成加密,块请求/响应方向由
 * e2e 语义保证不会用到)。整批条目全被跳过(文件都读不到)时不发 —— 空 delta 是
 * 空操作,空 full 会让盲区端把「本轮没提到的本机条目」当成对端缺失而回推噪声。
 */
export function wrapTransportBlind(t: PeerTransport, key: Buffer, root: string): PeerTransport {
  return {
    sendEntries(entries: IndexEntry[], mode: IndexMode, opts?: { relayed?: boolean }): void {
      const blind = toBlindEntries(entries, key, root);
      if (blind.length > 0) t.sendEntries(blind, mode, opts);
    },
    sendBlockRequest(request) {
      t.sendBlockRequest(request);
    },
    sendBlockResponse(response, opts) {
      t.sendBlockResponse(response, opts);
    },
  };
}
