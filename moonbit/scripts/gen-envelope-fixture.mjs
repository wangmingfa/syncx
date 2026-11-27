/**
 * 由 Node 侧生成帧信封的跨语言 fixture:`moonbit/net/envelope_fixture.mbt`。
 *
 * 为什么要对拍:MoonBit 的 `net/envelope.mbt` 是对 `src/net/wire.ts` 的
 * 独立实现。字段名、base64 字母表、`iv|tag|version|kind|headerLen` 布局、
 * 二进制头与体的分界,任何一处对不上,症状都只是「握手成功但收不到东西」——
 * 因为对端解密失败后按约定**静默丢弃**该帧,日志里连报错都没有。
 *
 * 所以这里把 Node 真正封出来的字节固化下来:
 *   1. MoonBit 用同一组 (key, iv) 解开它,明文必须逐字节相等;
 *   2. MoonBit 再用同一组 (key, iv) 重新封一遍,密文必须逐字节相等。
 *
 * 第 2 条是关键:它同时证明了反向可用 —— 密文相同,Node 必然也能解开
 * MoonBit 的产物。只做第 1 条验不出键序与字段名之外的差异。
 *
 * 为了固定 iv,这里用的是 `encryptMessageWithIv` / `encodeBinaryFrameWithIv`
 * —— 生产路径的那两个函数内部自己取随机 iv,对拍没法复现。
 *
 * 生成:node_modules/.bin/tsx moonbit/scripts/gen-envelope-fixture.mjs
 *
 * 什么时候必须重跑:`src/net/wire.ts` 的 `encryptMessage*` /
 * `encodeBinaryFrame*` 改了信封结构(base64 换字母表、tag 位置、版本号、
 * 头长字节序),或 `net/envelope.mbt` 改了实现。两边的字节必须同时是新的,
 * 否则测试会在一个早已过期的契约上绿着。
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodeBinaryFrameWithIv, encryptMessageWithIv } from '../../src/net/wire.js';

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, '../net/envelope_fixture.mbt');

/** 固定会话密钥(32 字节)。生产路径永远是握手产物。 */
const key = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');
/** 固定 iv(12 字节)。GCM 下绝不能在两条不同明文上复用 —— 这里只用于对拍。 */
const iv = Buffer.from('a0a1a2a3a4a5a6a7a8a9aaab', 'hex');

/**
 * 文本fixture:一条 `control` 信封里的 hello。
 *
 * 挑 hello 是因为它是两条链路(客户端主动连 / 服务端注册)都会发的第一条
 * 数据面消息,也是「握完手到底通没通」的最小判据。hostname 用中文,
 * 顺手钉住 UTF-8 多字节不走形。
 */
const textMessage = {
  type: 'control',
  payload: {
    kind: 'hello',
    fromDeviceId: 'FIXTUREDEVICE1',
    version: '0.0.0-fixture',
    hostname: '夹具主机',
    platform: 'linux',
    runtime: 'node',
  },
};
const textPlain = Buffer.from(JSON.stringify(textMessage), 'utf8');
const textEnvelope = encryptMessageWithIv(key, textMessage, iv);

/**
 * 二进制 fixture:一帧 `direct-file-chunk`(kind 3)。
 *
 * 选直发分片而不是块响应,是因为它的头最小(id + seq)、体是纯字节,
 * 一旦头长/体起点算错,体里那串可校验的模式数据立刻对不上。
 */
const binaryHeader = { id: 'fixture-transfer-1', seq: 0 };
const binaryBody = Buffer.alloc(4096);
for (let i = 0; i < binaryBody.length; i += 1) {
  binaryBody[i] = (i * 7 + 13) & 0xff;
}
const binaryFrame = encodeBinaryFrameWithIv(key, 'direct-file-chunk', binaryHeader, binaryBody, iv);
const binaryHeaderJson = JSON.stringify(binaryHeader);

/** MoonBit 字符串字面量:JSON 的转义规则与 MoonBit 在这批字符上一致。 */
const mbtString = (value) => JSON.stringify(value);

const lines = [
  '///|',
  '// 由 `moonbit/scripts/gen-envelope-fixture.mjs` 生成,**勿手改**。',
  '//',
  '// 这是 Node 真实封出来的字节(`src/net/wire.ts` 的 encryptMessageWithIv /',
  '// encodeBinaryFrameWithIv),用固定 key/iv 才能复现。`net/envelope_test.mbt`',
  '// 断言两件事:MoonBit 能解开它,且用同一组 key/iv 重新封能逐字节还原。',
  '//',
  '// 改信封格式(`src/net/wire.ts` 或 `net/envelope.mbt`)必须重跑生成脚本:',
  '//   node_modules/.bin/tsx moonbit/scripts/gen-envelope-fixture.mjs',
  '',
  // 用 `pub fn` 而不是 `pub let`:MoonBit 的顶层 `let` 不对外导出,blackbox
  // 测试(独立的 _test.mbt 包)只能看到 pub 函数/类型。
  `pub fn envelope_fixture_key_hex() -> String { ${mbtString(key.toString('hex'))} }`,
  `pub fn envelope_fixture_iv_hex() -> String { ${mbtString(iv.toString('hex'))} }`,
  `pub fn envelope_fixture_text_plain_hex() -> String { ${mbtString(textPlain.toString('hex'))} }`,
  `pub fn envelope_fixture_text_envelope() -> String { ${mbtString(textEnvelope)} }`,
  `pub fn envelope_fixture_binary_hex() -> String { ${mbtString(binaryFrame.toString('hex'))} }`,
  `pub fn envelope_fixture_binary_kind() -> Int { 3 }`,
  `pub fn envelope_fixture_binary_header_json() -> String { ${mbtString(binaryHeaderJson)} }`,
  `pub fn envelope_fixture_binary_body_hex() -> String { ${mbtString(binaryBody.toString('hex'))} }`,
  '',
];

writeFileSync(outPath, lines.join('\n'), 'utf8');
console.log(`wrote ${outPath}`);
console.log(`  text envelope: ${textEnvelope.length} chars`);
console.log(`  binary frame : ${binaryFrame.length} bytes`);
