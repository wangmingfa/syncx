/**
 * 由 Node 侧生成身份 fixture:固定种子 → PEM 与 Device ID。
 *
 * 为什么必须对拍:Device ID 是设备在局域网里的身份,两端算法不同就意味着
 * 同一台机器在 Node 与 Rust 下是**两台设备**,已配对关系全部失效 —— 而且不报错,
 * 症状只是"对端把我当陌生设备"。
 *
 * 用法:`node_modules/.bin/tsx rust/scripts/gen-identity-fixture.mjs`
 */
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { deriveDeviceId } from '../../src/identity.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '../crates/syncx-net/fixtures');
mkdirSync(outDir, { recursive: true });

/**
 * 把 32 字节种子包成 Ed25519 PKCS#8 PEM。
 *
 * Node 侧 `generateKeyPairSync` 不能指定种子,所以这里手工拼 DER:
 * PKCS#8 = SEQUENCE { INTEGER 0, SEQUENCE { OID 1.3.101.112 }, OCTET STRING { OCTET STRING {seed} } }
 * 前缀是固定 16 字节,与 Node 导出的形态逐字节一致(见下方断言)。
 */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function seedToPrivatePem(seed) {
  const der = Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]);
  const b64 = der.toString('base64');
  const lines = b64.match(/.{1,64}/g).join('\n');
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----\n`;
}

/**
 * 由私钥导出 SPKI 公钥 PEM —— 与 Node `createPublicKey(...).export()` 同形态。
 *
 * `PrivateKeyObject.export({type:'spki'})` 在更新版本的 Node 上会直接拒绝
 * (`type` 对私钥只接受 pkcs8/sec1/pkcs1),所以要先导出 pkcs8 再转成
 * `KeyObject` 公钥。
 */
function publicPemOf(privatePem) {
  const keyObject = createPrivateKey(privatePem);
  return createPublicKey(keyObject).export({ type: 'spki', format: 'pem' });
}

const seeds = [
  Buffer.alloc(32, 1),
  Buffer.alloc(32, 0x42),
  Buffer.from(
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    'hex',
  ),
];

const cases = seeds.map((seed) => {
  const privateKeyPem = seedToPrivatePem(seed);
  const publicKeyPem = publicPemOf(privateKeyPem);
  return {
    seed: seed.toString('hex'),
    publicKeyPem,
    privateKeyPem,
    deviceId: deriveDeviceId(publicKeyPem),
    /** 兼作自检:Node 的 sha256(pem) 前 6 字节应能重算回同一个 ID。 */
    sha256PrefixHex: createHash('sha256').update(publicKeyPem).digest('hex').slice(0, 12),
  };
});

writeFileSync(join(outDir, 'identity.json'), JSON.stringify({ cases }, null, 2) + '\n');
process.stdout.write(`写入 ${cases.length} 条身份用例 → ${outDir}/identity.json\n`);
