import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { request } from 'node:http';
import { CAP_DIRECT1, PEER_CAPS } from '../src/handshake.js';
import { decodeBinaryFrame, encodeBinaryFrame } from '../src/net/wire.js';
import { createDirectService, DIRECT_CHUNK_BYTES, type DirectService, type DirectTransport } from '../src/direct.js';
import { createControlServer } from '../src/api.js';

const dirs: string[] = [];
function tmp(): string {
  const p = mkdtempSync(join(tmpdir(), 'syncx-direct-'));
  dirs.push(p);
  return p;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 两个服务经内存 transport 互联:模拟已握手会话里的控制帧与二进制帧往返。 */
function pair(a: DirectService, b: DirectService, tamper = false): { txA: DirectTransport; txB: DirectTransport } {
  const mk = (from: DirectService, to: DirectService, fromId: string, toId: string): DirectTransport => ({
    control: (_deviceId, message) => {
      to.handleControl({ ...message, fromDeviceId: fromId }, fromId, mk(to, from, toId, fromId));
      return true;
    },
    chunk: (_deviceId, id, seq, data) => {
      const body = tamper && seq === 0 ? Buffer.from(data) : data;
      if (tamper && seq === 0) body[0] = (body[0] ?? 0) ^ 0xff;
      to.handleChunk({ header: { id, seq }, body }, fromId, mk(to, from, toId, fromId));
      return true;
    },
  });
  return { txA: mk(a, b, 'A', 'B'), txB: mk(b, a, 'B', 'A') };
}

describe('device direct transfer', () => {
  it('能力宣告与二进制帧:direct1 在册,分片帧可往返', () => {
    expect(PEER_CAPS).toContain(CAP_DIRECT1);
    const key = Buffer.alloc(32, 7);
    const body = Buffer.from('hello chunk');
    const frame = encodeBinaryFrame(key, 'direct-file-chunk', { id: 'df-1', seq: 3 }, body);
    const decoded = decodeBinaryFrame(key, frame);
    expect(decoded?.kind).toBe('direct-file-chunk');
    expect(decoded?.header).toMatchObject({ id: 'df-1', seq: 3 });
    expect(decoded?.body.equals(body)).toBe(true);
    // 未知帧种类必须静默丢弃:旧对端遇到新帧时靠这条路径保持兼容
    expect(decodeBinaryFrame(Buffer.alloc(32, 9), frame)).toBeUndefined();
  });

  it('文本:落到对方收件箱,发送方收到回执后标记完成', () => {
    const a = createDirectService({ configDir: tmp() });
    const b = createDirectService({ configDir: tmp() });
    const { txA } = pair(a, b);
    const id = a.sendText('B', '你好，syncx 直发', txA);

    expect(b.snapshot().inbox).toHaveLength(1);
    expect(b.snapshot().inbox[0]).toMatchObject({ kind: 'text', from: 'A', preview: '你好，syncx 直发' });
    expect(a.snapshot().transfers.find((t) => t.id === id)?.state).toBe('done');
    a.close();
    b.close();
  });

  it('文件:超过一片的内容按序重组,逐字节一致且指纹正确', () => {
    const a = createDirectService({ configDir: tmp() });
    const b = createDirectService({ configDir: tmp() });
    const { txA, txB } = pair(a, b);
    const source = join(tmp(), 'source.bin');
    const data = Buffer.alloc(DIRECT_CHUNK_BYTES * 2 + 123);
    for (let i = 0; i < data.length; i++) data[i] = i % 251;
    writeFileSync(source, data);
    const sha256 = createHash('sha256').update(data).digest('hex');

    const id = a.sendFile('B', { name: 'sub/dir/测试.bin', sourcePath: source, size: data.length, sha256 }, txA);
    // 文件名按 basename 清洗,不保留来源路径
    expect(a.snapshot().transfers[0]?.name).toBe('测试.bin');
    expect(b.snapshot().pending[0]?.id).toBe(id);
    expect(b.reply(id, true, txB)).toBe(true);

    const item = b.snapshot().inbox[0];
    expect(item?.kind).toBe('file');
    expect(item && 'name' in item ? item.name : '').toBe('测试.bin');
    const received = readFileSync(item!.path ?? '');
    expect(received.length).toBe(data.length);
    expect(received.equals(data)).toBe(true);
    expect(a.snapshot().transfers.find((t) => t.id === id)?.state).toBe('done');
    expect(b.snapshot().pending).toHaveLength(0);
    a.close();
    b.close();
  });

  it('群发共用暂存文件:最后一笔结束才删除', () => {
    const a = createDirectService({ configDir: tmp() });
    const source = join(tmp(), 'shared.bin');
    const data = Buffer.from('shared payload');
    writeFileSync(source, data);
    const tx: DirectTransport = { control: () => true, chunk: () => true };
    const file = {
      name: 'shared.bin',
      sourcePath: source,
      size: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
    };
    const idB = a.sendFile('B', file, tx);
    const idC = a.sendFile('C', file, tx);
    expect(existsSync(source)).toBe(true);
    a.handleControl({ kind: 'direct-result', id: idB, fromDeviceId: '', ok: true }, 'B', tx);
    expect(existsSync(source)).toBe(true);
    a.handleControl({ kind: 'direct-result', id: idC, fromDeviceId: '', ok: true }, 'C', tx);
    expect(existsSync(source)).toBe(false);
    a.close();
  });

  it('拒绝:不收字节,发送方标记为失败', () => {
    const a = createDirectService({ configDir: tmp() });
    const b = createDirectService({ configDir: tmp() });
    const { txA, txB } = pair(a, b);
    const source = join(tmp(), 'x.txt');
    writeFileSync(source, 'hello');
    const id = a.sendFile('B', {
      name: 'x.txt',
      sourcePath: source,
      size: 5,
      sha256: createHash('sha256').update('hello').digest('hex'),
    }, txA);
    expect(b.reply(id, false, txB, '现在不方便')).toBe(true);
    expect(b.snapshot().inbox).toHaveLength(0);
    expect(b.snapshot().pending).toHaveLength(0);
    expect(a.snapshot().transfers.find((t) => t.id === id)).toMatchObject({ state: 'failed', error: '现在不方便' });
    a.close();
    b.close();
  });

  it('指纹不符:接收方回执失败且不落收件箱', () => {
    const a = createDirectService({ configDir: tmp() });
    const b = createDirectService({ configDir: tmp() });
    const { txA, txB } = pair(a, b, true);
    const source = join(tmp(), 'bad.bin');
    const data = Buffer.alloc(1024, 0x41);
    writeFileSync(source, data);
    const id = a.sendFile('B', {
      name: 'bad.bin',
      sourcePath: source,
      size: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
    }, txA);
    expect(b.reply(id, true, txB)).toBe(true);
    expect(b.snapshot().inbox).toHaveLength(0);
    expect(a.snapshot().transfers.find((t) => t.id === id)?.error).toContain('校验失败');
    a.close();
    b.close();
  });

  it('HTTP:直发路由走登录门,GET inbox 只下发元数据', async () => {
    const sent: string[] = [];
    const server = createControlServer({
      token: 'secret',
      configDir: tmp(),
      getStatus: () => ({}),
      direct: {
        snapshot: () => ({ inbox: [{ kind: 'text', id: 'dt-1', from: 'AAAA', createdAt: 1, size: 2, preview: '你好', path: '/tmp/dt-1.txt' }], pending: [], transfers: [] }),
        content: async () => undefined,
        remove: async () => true,
        reply: () => true,
        sendText: (deviceId, text) => { sent.push(`${deviceId}:${text}`); return `dt-${deviceId}`; },
        sendFile: () => 'df-2',
      },
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;
    const get = (path: string, body?: object, method = 'GET', token = 'secret'): Promise<{ status: number; text: string }> =>
      new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : undefined;
        const req = request(
          { host: '127.0.0.1', port, path, method, headers: { Authorization: `Bearer ${token}`, ...(payload ? { 'Content-Type': 'application/json' } : {}) } },
          (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { text += c; });
            res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
          },
        );
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
      });

    expect((await get('/api/direct/inbox', undefined, 'GET', 'wrong')).status).toBe(401);
    const inbox = await get('/api/direct/inbox');
    expect(inbox.status).toBe(200);
    expect(JSON.parse(inbox.text)).toMatchObject({ inbox: [{ preview: '你好' }] });
    const sentRes = await get('/api/direct/text', { deviceId: 'AAAA', text: 'hi' }, 'POST');
    expect(sentRes.status).toBe(200);
    const batchRes = await get('/api/direct/text', { deviceIds: ['AAAA', 'BBBB'], text: 'batch' }, 'POST');
    expect(batchRes.status).toBe(200);
    expect(JSON.parse(batchRes.text).results).toMatchObject([
      { deviceId: 'AAAA', id: 'dt-AAAA' },
      { deviceId: 'BBBB', id: 'dt-BBBB' },
    ]);
    expect(sent).toEqual(['AAAA:hi', 'AAAA:batch', 'BBBB:batch']);
    server.close();
  });

  it('HTTP:文件上传按流暂存,daemon 侧计算指纹,大小不符直接拒绝', async () => {
    let captured: { name: string; size: number; sha256: string; sourcePath: string } | undefined;
    const sentTo: string[] = [];
    const configDir = tmp();
    const server = createControlServer({
      token: 'secret',
      configDir,
      getStatus: () => ({}),
      direct: {
        snapshot: () => ({ inbox: [], pending: [], transfers: [] }),
        content: async () => undefined,
        remove: async () => true,
        reply: () => true,
        sendText: () => 'dt-x',
        sendFile: (deviceId, file) => { captured = file; sentTo.push(deviceId); return `df-${deviceId}`; },
      },
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;
    const post = (path: string, body: Buffer): Promise<{ status: number; text: string }> =>
      new Promise((resolve, reject) => {
        const req = request(
          { host: '127.0.0.1', port, path, method: 'POST', headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length) } },
          (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { text += c; });
            res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
          },
        );
        req.on('error', reject);
        req.end(body);
      });

    const data = Buffer.alloc(700 * 1024, 0x5a);
    const expected = createHash('sha256').update(data).digest('hex');
    const ok = await post(`/api/direct/file?deviceIds=AAAA&deviceIds=BBBB&name=${encodeURIComponent('包 名.bin')}&size=${data.length}`, data);
    expect(ok.status, ok.text).toBe(200);
    expect(sentTo).toEqual(['AAAA', 'BBBB']);
    expect(JSON.parse(ok.text).results).toMatchObject([
      { deviceId: 'AAAA', id: 'df-AAAA' },
      { deviceId: 'BBBB', id: 'df-BBBB' },
    ]);
    expect(captured?.name).toBe('包 名.bin');
    expect(captured?.size).toBe(data.length);
    expect(captured?.sha256).toBe(expected);
    expect(readFileSync(captured!.sourcePath).equals(data)).toBe(true);

    const bad = await post('/api/direct/file?deviceId=AAAA&name=x.bin&size=10', data);
    expect(bad.status).toBe(400);
    server.close();
  });
});
