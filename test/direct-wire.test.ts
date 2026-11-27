import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeBinaryFrame, decodeWireMessage } from '../src/net/wire.js';
import {
  DIRECT_CHUNK_BYTES,
  createDirectService,
  type DirectControlMessage,
  type DirectService,
  type DirectTransport,
} from '../src/direct.js';

/**
 * 直发线上格式的**双向对拍**(ADR-0028)。
 *
 * 语料由 `rust/scripts/gen-direct-wire-fixture.mjs` 用本仓库真实的消息字面量与
 * `JSON.stringify` 生成,固化成 `rust/crates/syncx-net/fixtures/direct-wire.json`：
 *
 *   - Rust 侧(`rust/crates/syncx-net/tests/direct_wire.rs`)断言解码后重新编码
 *     **逐字节还原** —— 钉键序、大小写、可选字段的有无;
 *   - 本文件把这些字节喂回**当前**的状态机 —— 钉字段名没有被悄悄改掉。
 *
 * 两条链各自只对自己的实现负责,合起来才是「Node 发的 Rust 认,Rust 发的 Node 认」。
 * 只做其中一条是不够的:fixture 抄错(字段改名而没重跑脚本)时,Rust 那边照样全绿。
 */

interface ControlCase {
  name: string;
  wire: string;
}

interface Fixture {
  selfInfo: Record<string, string>;
  controls: ControlCase[];
  chunk: { keyHex: string; header: { id: string; seq: number }; bodyBase64: string; frameBase64: string };
}

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'rust',
  'crates',
  'syncx-net',
  'fixtures',
  'direct-wire.json',
);
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture;

const dirs: string[] = [];
function tmp(): string {
  const p = mkdtempSync(join(tmpdir(), 'syncx-direct-wire-'));
  dirs.push(p);
  return p;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 从 fixture 里取一条消息(走真实的 `decodeWireMessage`,不是 JSON.parse)。 */
function fixtureMessage(name: string): DirectControlMessage {
  const found = fixture.controls.find((c) => c.name === name);
  if (!found) throw new Error(`fixture 缺 ${name} 的样本`);
  const message = decodeWireMessage(found.wire);
  if (message.type !== 'control') throw new Error(`${name} 应是 control 信封`);
  return message.payload as DirectControlMessage;
}

/** 只记账不回话的通道:对端行为不在本文件的责任范围。 */
const noopTx: DirectTransport = { control: () => true, chunk: () => true };

describe('direct wire fixture (Node → Rust 对拍)', () => {
  it('覆盖六条控制消息,且每条都带身份四键(排在最末)', () => {
    const kinds = new Set<string>();
    for (const item of fixture.controls) {
      const message = decodeWireMessage(item.wire);
      expect(message.type).toBe('control');
      const payload = (message as { payload: Record<string, unknown> }).payload;
      kinds.add(String(payload.kind));
      // withSelfInfo 是展开追加:四个键必须在最后,顺序固定
      expect(Object.keys(payload).slice(-4)).toEqual(['version', 'hostname', 'platform', 'runtime']);
    }
    expect([...kinds].sort()).toEqual([
      'direct-ack',
      'direct-cancel',
      'direct-file-offer',
      'direct-reply',
      'direct-result',
      'direct-text',
    ]);
  });

  it('direct-text:正文原样落进收件箱(含中文 / 换行 / 引号)', () => {
    const b = createDirectService({ configDir: tmp() });
    const message = fixtureMessage('text');
    b.handleControl(message, 'A', noopTx);

    const item = b.snapshot().inbox[0];
    expect(item).toMatchObject({ kind: 'text', from: 'A' });
    // preview 可能是截断后的展示值,这里比对内容本身
    expect(item?.kind === 'text' ? item.preview : '').toContain('第二行 "quoted" & <tag>');
    b.close();
  });

  it('direct-file-offer:成组与单条都认得,且 batchId 只在必要时出现', () => {
    const grouped = createDirectService({ configDir: tmp() });
    const offer = fixtureMessage('file-offer-batch');
    grouped.handleControl(offer, 'A', noopTx);
    expect(grouped.snapshot().pending).toHaveLength(1);
    expect(grouped.snapshot().pending[0]).toMatchObject({
      id: offer.id,
      from: 'A',
      // 五个字段全部被消费:任何一个改名,这里立刻对不上
      name: '季度报表 (1).xlsx',
      size: 3_145_728,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      batchId: 'b-1700000001000-1',
    });
    grouped.close();

    const single = createDirectService({ configDir: tmp() });
    single.handleControl(fixtureMessage('file-offer-single'), 'A', noopTx);
    expect(single.snapshot().pending[0]?.batchId).toBeUndefined();
    single.close();
  });

  it('direct-reply / direct-ack / direct-result / direct-cancel:驱动真实的在途投送', () => {
    // 一条真实出站投送:6 片多一点,足够让 ack 有推进空间、又不会自己跑完
    const data = Buffer.alloc(DIRECT_CHUNK_BYTES * 6 + 17, 9);
    const source = join(tmp(), 'payload.bin');
    writeFileSync(source, data);
    const file = {
      name: 'payload.bin',
      sourcePath: source,
      size: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
    };
    const start = (): { service: DirectService; id: string } => {
      const service = createDirectService({ configDir: tmp() });
      const id = service.sendFile('B', file, noopTx).id;
      return { service, id };
    };
    const stateOf = (service: DirectService, id: string) =>
      service.snapshot().transfers.find((t) => t.id === id);

    // accept:offering → transferring(字段 `accept`)
    {
      const { service, id } = start();
      expect(stateOf(service, id)?.state).toBe('offering');
      service.handleControl({ ...fixtureMessage('reply-accept-fresh'), id }, 'B', noopTx);
      expect(stateOf(service, id)?.state).toBe('transferring');

      // ack:累积确认把已收字节推上去(字段 `seq`,单位是片号)
      service.handleControl({ ...fixtureMessage('ack'), id }, 'B', noopTx);
      expect(stateOf(service, id)?.bytesDone).toBe(3 * DIRECT_CHUNK_BYTES);

      // result ok:收尾(字段 `ok`)
      service.handleControl({ ...fixtureMessage('result-ok'), id }, 'B', noopTx);
      expect(stateOf(service, id)?.state).toBe('done');
      service.close();
    }

    // 拒绝:offering → 失败并带上对端给的原因(字段 `accept` + `reason`)
    {
      const { service, id } = start();
      service.handleControl({ ...fixtureMessage('reply-reject'), id }, 'B', noopTx);
      expect(stateOf(service, id)).toMatchObject({ state: 'failed', error: '对方拒绝了接收' });
      service.close();
    }

    // result 失败:错误文案原样落到 UI(字段 `ok` + `error`)
    {
      const { service, id } = start();
      service.handleControl({ ...fixtureMessage('result-fail'), id }, 'B', noopTx);
      expect(stateOf(service, id)).toMatchObject({ state: 'failed', error: '文件校验失败(sha256 不一致)' });
      service.close();
    }

    // 对端中止:也归到「失败」,原因取自 `reason`(UI 上二者都显示成一条带原因的终态)
    {
      const { service, id } = start();
      service.handleControl({ ...fixtureMessage('cancel'), id }, 'B', noopTx);
      expect(stateOf(service, id)).toMatchObject({ state: 'failed', error: '30 秒没有进展,已放弃' });
      service.close();
    }
  });

  it('direct-file-chunk:与 Rust 解出同一个 kind / 头 / 体', () => {
    const key = Buffer.from(fixture.chunk.keyHex, 'hex');
    const frame = Buffer.from(fixture.chunk.frameBase64, 'base64');
    const decoded = decodeBinaryFrame(key, frame);
    expect(decoded?.kind).toBe('direct-file-chunk');
    expect(decoded?.header).toMatchObject(fixture.chunk.header);
    expect(Object.keys(decoded?.header ?? {})).toEqual(['id', 'seq']);
    expect(decoded?.body.equals(Buffer.from(fixture.chunk.bodyBase64, 'base64'))).toBe(true);
    // 密钥不对必须解不出来(帧体是真加密的,不是裸 JSON)
    expect(decodeBinaryFrame(Buffer.alloc(32, 1), frame)).toBeUndefined();
  });
});
