/**
 * 由 Node 侧生成直发(ADR-0028)的线上格式 fixture:`rust/crates/syncx-net/fixtures/direct-wire.json`。
 *
 * 为什么要对拍:直发的六条控制消息与 `direct-file-chunk` 二进制帧的字段名、键序、
 * 可选字段的有无,全部靠两套手写类型「约定」对齐。名字拼错不会有编译错误,症状只是
 * 对端把消息当成未知 kind 静默丢掉 —— 发出去了、但对方永远不确认。这里把 Node 真正
 * 发上线的那串字节固化下来,Rust 侧解码后重新编码必须**逐字节**还原。
 *
 * 生成:node_modules/.bin/tsx rust/scripts/gen-direct-wire-fixture.mjs
 *
 * 什么时候必须重跑:`src/net/wire.ts` 的 `ControlMessage` union 或 `src/direct.ts` 里
 * 任一条消息字面量改字段(改名、加字段、调顺序)。本文件里的消息字面量是照抄 call
 * site 的,**不是**运行时抓的,抄错了它不会自己发现 —— 但 `test/direct-wire.test.ts`
 * 会把这些字节喂回 Node 的状态机,那时候行为对不上就会红。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodeBinaryFrame, encodeWireMessage } from '../../src/net/wire.js';

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, '../crates/syncx-net/fixtures/direct-wire.json');

/**
 * 会话管理器给每条出站控制消息补的四个字段(`SessionManager.withSelfInfo`)。
 *
 * 值取固定的假数据:Rust 侧要断言的是「这四键排在最后、名字逐字一致」,不是内容。
 * 真机上 hostname 每次不同,写死才能让 fixture 可 diff。
 */
const SELF_INFO = { version: '0.4.4', hostname: 'node-host', platform: 'linux', runtime: 'node' };

/** 二进制帧用固定密钥,否则 fixture 每次都变(Rust 侧也拿它解帧)。 */
const CHUNK_KEY = Buffer.alloc(32, 7);

/** 一个 64 位十六进制指纹:长度与真实 sha256 一致,值本身无所谓。 */
const FAKE_SHA256 =
  '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';

/**
 * 消息字面量:字段顺序照抄 `src/direct.ts` 的 call site。
 * `wire` 是 `sendControlMessage` 真正写上线的那串 JSON(control 信封 + 身份补丁)。
 */
const controls = [
  {
    name: 'text',
    // 1239 行:sendText。中文 + 换行 + 引号,钉住 JSON.stringify 不转义非 ASCII
    message: {
      kind: 'direct-text',
      id: 'dt-1',
      fromDeviceId: '',
      text: '你好，syncx 直发\n第二行 "quoted" & <tag>',
      createdAt: 1_700_000_000_000,
    },
  },
  {
    name: 'file-offer-batch',
    // 744 行:offerMessage,带 batchId(同一批多文件)
    message: {
      kind: 'direct-file-offer',
      id: 'df-1',
      fromDeviceId: '',
      name: '季度报表 (1).xlsx',
      size: 3_145_728,
      sha256: FAKE_SHA256,
      createdAt: 1_700_000_001_000,
      batchId: 'b-1700000001000-1',
    },
  },
  {
    name: 'file-offer-single',
    // 同上但无 batchId:该键必须**整个不出现**,不是 null
    message: {
      kind: 'direct-file-offer',
      id: 'df-2',
      fromDeviceId: '',
      name: 'photo.jpg',
      size: 1,
      sha256: FAKE_SHA256,
      createdAt: 1_700_000_002_000,
    },
  },
  {
    name: 'reply-accept-resume',
    // 817 行:断点续传的接受。offset 出现 = 从该字节数继续,不带 reason
    message: {
      kind: 'direct-reply',
      id: 'df-1',
      fromDeviceId: '',
      accept: true,
      offset: 786_432,
    },
  },
  {
    name: 'reply-accept-fresh',
    // 1159 行:首次接受。没有 offset、没有 reason
    message: { kind: 'direct-reply', id: 'df-2', fromDeviceId: '', accept: true },
  },
  {
    name: 'reply-reject',
    // 1140 行:拒绝。accept=false 时 reason 是给用户看的中文
    message: {
      kind: 'direct-reply',
      id: 'df-3',
      fromDeviceId: '',
      accept: false,
      reason: '对方拒绝了接收',
    },
  },
  {
    name: 'ack',
    // 951 行:累积确认,seq = 下一个期望的片号
    message: { kind: 'direct-ack', id: 'df-1', fromDeviceId: '', seq: 3 },
  },
  {
    name: 'cancel',
    // 697 行:失败/超时中止
    message: {
      kind: 'direct-cancel',
      id: 'df-1',
      fromDeviceId: '',
      reason: '30 秒没有进展,已放弃',
    },
  },
  {
    name: 'result-ok',
    // 986 行:接收方最终回执(文本落箱 / 文件校验通过)
    message: { kind: 'direct-result', id: 'dt-1', fromDeviceId: '', ok: true },
  },
  {
    name: 'result-fail',
    // 958 行:校验失败。ok=false 时 error 必给
    message: {
      kind: 'direct-result',
      id: 'df-1',
      fromDeviceId: '',
      ok: false,
      error: '文件校验失败(sha256 不一致)',
    },
  },
].map(({ name, message }) => ({
  name,
  // 身份字段是展开追加的,位置本来就在最后 —— 抄 withSelfInfo 的写法而不是改写顺序
  wire: encodeWireMessage({ type: 'control', payload: { ...message, ...SELF_INFO } }),
}));

// 二进制分片帧:iv 随机,所以这串字节不可复现 —— 它是一次快照,由两侧共同解码验证,
// 不参与「重新生成后 diff」。
const chunkHeader = { id: 'df-1', seq: 4 };
const chunkBody = Buffer.alloc(700);
for (let i = 0; i < chunkBody.length; i++) chunkBody[i] = i % 251;
const chunkFrame = encodeBinaryFrame(CHUNK_KEY, 'direct-file-chunk', chunkHeader, chunkBody);

const fixture = {
  note: '由 rust/scripts/gen-direct-wire-fixture.mjs 生成;改 src/direct.ts 的消息字段后必须重跑',
  selfInfo: SELF_INFO,
  controls,
  chunk: {
    keyHex: CHUNK_KEY.toString('hex'),
    header: chunkHeader,
    bodyBase64: chunkBody.toString('base64'),
    // iv 随机 ⇒ 每次生成都不同,只作为「两侧都能解」的样本
    frameBase64: chunkFrame.toString('base64'),
  },
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(fixture, null, 2) + '\n');

const kinds = controls.map((c) => JSON.parse(c.wire).payload.kind);
console.log(`写入 ${outPath}`);
console.log(`  控制消息 ${controls.length} 条:${[...new Set(kinds)].join(', ')}`);
console.log(`  分片帧 ${chunkFrame.length} 字节(明文体 ${chunkBody.length})`);
