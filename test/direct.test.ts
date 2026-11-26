import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { request } from 'node:http';
import { CAP_DIRECT1, PEER_CAPS } from '../src/handshake.js';
import { decodeBinaryFrame, encodeBinaryFrame } from '../src/net/wire.js';
import { createDirectService, DIRECT_CHUNK_BYTES, DIRECT_MAX_QUEUED, type DirectService, type DirectTransport } from '../src/direct.js';
import { resolveDirectSaveDir } from '../src/direct-save-path.js';
import { signSession, sessionSecret } from '../src/auth.js';
import { ELEVATE_COOKIE } from '../src/api/helpers.js';
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
    const id = a.sendText('B', '你好，syncx 直发', txA).id;

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

    const id = a.sendFile('B', { name: 'sub/dir/测试.bin', sourcePath: source, size: data.length, sha256 }, txA).id;
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
    const idB = a.sendFile('B', file, tx).id;
    const idC = a.sendFile('C', file, tx).id;
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
    }, txA).id;
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
    }, txA).id;
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
        sendText: (deviceId, text) => { sent.push(`${deviceId}:${text}`); return { id: `dt-${deviceId}`, queued: false }; },
        sendFile: () => ({ id: 'df-2', queued: false }),
        cancelQueued: () => true,
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
        sendText: () => ({ id: 'dt-x', queued: false }),
        sendFile: (deviceId, file) => { captured = file; sentTo.push(deviceId); return { id: `df-${deviceId}`, queued: false }; },
        cancelQueued: () => true,
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

  it('另存到指定目录:文件落到用户目录,删回执不动真实文件', async () => {
    const a = createDirectService({ configDir: tmp() });
    const bConfig = tmp();
    const b = createDirectService({ configDir: bConfig });
    const { txA, txB } = pair(a, b);
    const source = join(tmp(), 'save-me.txt');
    const target = tmp();
    const data = Buffer.from('save to my folder');
    writeFileSync(source, data);
    const id = a.sendFile('B', {
      name: 'save-me.txt',
      sourcePath: source,
      size: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
    }, txA).id;
    expect(b.reply(id, true, txB, undefined, target)).toBe(true);

    const item = b.snapshot().inbox[0];
    expect(item?.kind).toBe('file');
    expect(item && 'external' in item ? item.external : false).toBe(true);
    expect(item?.path?.startsWith(target)).toBe(true);
    expect(readFileSync(item!.path ?? '')).toEqual(data);
    // 收件箱里不该再留一份原文件
    expect(existsSync(join(bConfig, 'inbox', 'files', 'save-me.txt'))).toBe(false);
    expect(a.snapshot().transfers.find((t) => t.id === id)?.state).toBe('done');

    expect(await b.remove(id!)).toBe(true);
    expect(existsSync(item!.path ?? '')).toBe(true);
    a.close();
    b.close();
  });

  it('另存路径校验:挡住相对路径、共享目录、数据目录、系统目录', () => {
    const base = tmp();
    const configDir = join(base, 'config');
    const shared = join(base, 'shared');
    const home = join(base, 'home');
    const downloads = join(home, 'Downloads');
    for (const d of [configDir, join(configDir, 'inbox'), shared, join(shared, 'sub'), home, downloads]) mkdirSync(d, { recursive: true });
    const opts = { configDir, sharedFolders: [shared], platform: 'darwin' as const, homeDir: home };

    expect(resolveDirectSaveDir(downloads, opts)).toBe(realpathSync(downloads));
    expect(() => resolveDirectSaveDir('Downloads', opts)).toThrow(/绝对路径/);
    expect(() => resolveDirectSaveDir(shared, opts)).toThrow(/共享目录/);
    expect(() => resolveDirectSaveDir(join(shared, 'sub'), opts)).toThrow(/共享目录/);
    expect(() => resolveDirectSaveDir(join(configDir, 'inbox'), opts)).toThrow(/数据目录/);
    expect(() => resolveDirectSaveDir(home, opts)).toThrow(/主目录/);
    expect(() => resolveDirectSaveDir('/etc', opts)).toThrow(/系统目录/);
    expect(() => resolveDirectSaveDir(join(base, 'missing'), opts)).toThrow(/不存在/);
  });

  it('HTTP:另存必须提权,服务端校验失败回中文原因', async () => {
    let captured: string | undefined;
    const configDir = tmp();
    const server = createControlServer({
      token: 'secret',
      configDir,
      getStatus: () => ({}),
      directSavePath: (input) => {
        if (input === '/bad') throw new Error('不能保存到已共享目录');
        return `/validated:${input}`;
      },
      direct: {
        snapshot: () => ({ inbox: [], pending: [], transfers: [] }),
        content: async () => undefined,
        remove: async () => true,
        reply: (_id, _accept, _reason, saveDir) => { captured = saveDir; return true; },
        sendText: () => ({ id: 'dt-x', queued: false }),
        sendFile: () => ({ id: 'df-x', queued: false }),
        cancelQueued: () => true,
      },
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;
    const post = (body: object, cookie?: string): Promise<{ status: number; text: string }> =>
      new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const req = request(
          {
            host: '127.0.0.1', port, path: '/api/direct/reply', method: 'POST',
            headers: {
              Authorization: 'Bearer secret', 'Content-Type': 'application/json',
              ...(cookie ? { Cookie: cookie } : {}),
            },
          },
          (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { text += c; });
            res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
          },
        );
        req.on('error', reject);
        req.end(payload);
      });
    const cookie = `${ELEVATE_COOKIE}=${signSession(
      { via: 'elevate', sub: 'su', exp: Date.now() + 600_000 },
      sessionSecret('secret|elevate'),
    )}`;

    const denied = await post({ id: 'df-1', accept: true, saveTo: '/downloads' });
    expect(denied.status).toBe(403);
    expect(captured).toBeUndefined();

    const ok = await post({ id: 'df-1', accept: true, saveTo: '/downloads' }, cookie);
    expect(ok.status, ok.text).toBe(200);
    expect(captured).toBe('/validated:/downloads');

    const badPath = await post({ id: 'df-1', accept: true, saveTo: '/bad' }, cookie);
    expect(badPath.status).toBe(400);
    expect(JSON.parse(badPath.text).error).toContain('共享目录');

    const rejectWithDir = await post({ id: 'df-1', accept: false, saveTo: '/downloads' }, cookie);
    expect(rejectWithDir.status).toBe(400);
    server.close();
  });

  it('断点续传:掉线保留半截,重连后从已落盘字节继续', () => {
    // 一条可以「断」的链路:第一片送达后立刻断开,模拟传到一半 Wi-Fi 掉线。
    const link = { up: true };
    const sent: number[] = [];
    const mk = (from: DirectService, to: DirectService, fromId: string, toId: string): DirectTransport => ({
      control: (_deviceId, message) => {
        if (!link.up) return false;
        to.handleControl({ ...message, fromDeviceId: fromId }, fromId, mk(to, from, toId, fromId));
        return true;
      },
      chunk: (_deviceId, id, seq, data) => {
        if (!link.up) return false;
        if (fromId === 'A') sent.push(seq);
        // 第一片送达后链路立刻断:这一片的 ack 回不去,后续分片也发不出。
        if (seq === 0) link.up = false;
        to.handleChunk({ header: { id, seq }, body: data }, fromId, mk(to, from, toId, fromId));
        return true;
      },
    });

    let txA: DirectTransport;
    const a = createDirectService({
      configDir: tmp(),
      // 有「现取通道」的能力才允许暂停等待重连;这里用它模拟会话重建。
      getTransport: () => (link.up ? txA : undefined),
    });
    const bConfig = tmp();
    const b = createDirectService({ configDir: bConfig });
    txA = mk(a, b, 'A', 'B');
    const txB = mk(b, a, 'B', 'A');

    const source = join(tmp(), 'resume.bin');
    const data = Buffer.alloc(DIRECT_CHUNK_BYTES * 2 + 123);
    for (let i = 0; i < data.length; i++) data[i] = (i * 7) % 251;
    writeFileSync(source, data);
    const id = a.sendFile('B', {
      name: 'resume.bin',
      sourcePath: source,
      size: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
    }, txA).id;
    expect(b.snapshot().pending).toHaveLength(1);

    // 接收方确认后开始传;第一片送达即断链,发送方转入暂停而不是直接失败。
    expect(b.reply(id, true, txB)).toBe(true);
    expect(a.snapshot().transfers.find((t) => t.id === id)?.state).toBe('paused');
    // 收件箱里还没有成品,半截也不该出现在待确认里
    expect(b.snapshot().inbox).toHaveLength(0);
    expect(b.snapshot().pending).toHaveLength(0);

    // 两端的 socket 随后都会关掉:接收方也转暂停,且已落盘的那一片不丢
    a.onPeerOffline('B');
    b.onPeerOffline('A');
    expect(a.snapshot().transfers.find((t) => t.id === id)?.state).toBe('paused');
    const recvPaused = b.snapshot().transfers.find((t) => t.direction === 'receive');
    expect(recvPaused?.state).toBe('paused');
    expect(recvPaused?.bytesDone).toBe(DIRECT_CHUNK_BYTES);
    expect(sent).toEqual([0]);

    // 重连:发送方重新提议,接收方按已落盘字节回 offset,双方从第二片接着传。
    sent.length = 0;
    link.up = true;
    a.onPeerOnline('B', txA);
    // 只补发剩下两片,而不是从 0 重来
    expect(sent).toEqual([1, 2]);

    const item = b.snapshot().inbox[0];
    expect(item?.kind).toBe('file');
    const received = readFileSync(item!.path ?? '');
    expect(received.length).toBe(data.length);
    expect(received.equals(data)).toBe(true);
    expect(a.snapshot().transfers.find((t) => t.id === id)?.state).toBe('done');
    // 续传完成后不留半截临时文件
    expect(existsSync(join(bConfig, 'inbox', '.tmp', `in-${id}`))).toBe(false);
    a.close();
    b.close();
  });

  it('续传偏移只在本轮续传时生效:新投送带非 0 偏移直接失败', () => {
    const a = createDirectService({ configDir: tmp() });
    const source = join(tmp(), 'fresh.bin');
    const data = Buffer.alloc(DIRECT_CHUNK_BYTES * 2);
    writeFileSync(source, data);
    const tx: DirectTransport = { control: () => true, chunk: () => true };
    const id = a.sendFile('B', {
      name: 'fresh.bin',
      sourcePath: source,
      size: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
    }, tx).id;
    // 对方声称已经落盘一片,但本机这笔还没暂停过 → 不能信,直接失败(否则会静默丢一段)。
    a.handleControl({ kind: 'direct-reply', id, fromDeviceId: '', accept: true, offset: DIRECT_CHUNK_BYTES }, 'B', tx);
    const t = a.snapshot().transfers.find((x) => x.id === id);
    expect(t?.state).toBe('failed');
    expect(t?.error).toContain('续传位置不合法');
    a.close();
  });

  it('离线排队:文本先进本机队列,设备上线后自动补发', () => {
    const configDir = tmp();
    const a = createDirectService({ configDir });
    const b = createDirectService({ configDir: tmp() });
    // 没有 tx = 目标离线:不报错,进队列
    const ack = a.sendText('B', '等你上线再看', undefined);
    expect(ack.queued).toBe(true);
    expect(a.snapshot().transfers.find((t) => t.id === ack.id)).toMatchObject({ state: 'queued', kind: 'text' });
    expect(b.snapshot().inbox).toHaveLength(0);
    const queueFile = join(configDir, 'inbox', 'queue.json');
    expect(JSON.parse(readFileSync(queueFile, 'utf8'))).toMatchObject([{ id: ack.id, deviceId: 'B', kind: 'text', text: '等你上线再看' }]);

    // 设备离线事件不该把排队项打成失败
    a.onPeerOffline('B');
    expect(a.snapshot().transfers.find((t) => t.id === ack.id)?.state).toBe('queued');

    // 会话建立:自动补发,落对方收件箱并回执
    const { txA } = pair(a, b);
    a.onPeerOnline('B', txA);
    const textItem = b.snapshot().inbox[0];
    expect(textItem?.kind === 'text' ? textItem.preview : '').toBe('等你上线再看');
    expect(a.snapshot().transfers.find((t) => t.id === ack.id)?.state).toBe('done');
    // 队列台账随之清空
    expect(existsSync(queueFile)).toBe(false);
    a.close();
    b.close();
  });

  it('离线排队跨重启:暂存文件与台账都保留,重启后仍能投递', () => {
    const configDir = tmp();
    const bConfig = tmp();
    const source = join(tmp(), 'queued.bin');
    const data = Buffer.alloc(DIRECT_CHUNK_BYTES + 321);
    for (let i = 0; i < data.length; i++) data[i] = (i * 3) % 251;
    writeFileSync(source, data);
    const sha256 = createHash('sha256').update(data).digest('hex');

    const a1 = createDirectService({ configDir });
    const ack = a1.sendFile('B', { name: 'queued.bin', sourcePath: source, size: data.length, sha256 }, undefined);
    expect(ack.queued).toBe(true);
    a1.close();
    // 关闭 daemon 不能把排队项的暂存文件删掉,否则重启后队列指向空文件
    expect(existsSync(source)).toBe(true);

    const b = createDirectService({ configDir: bConfig });
    const a2 = createDirectService({ configDir });
    expect(a2.snapshot().transfers.find((t) => t.id === ack.id)).toMatchObject({ state: 'queued', name: 'queued.bin' });

    const { txA, txB } = pair(a2, b);
    a2.onPeerOnline('B', txA);
    expect(b.snapshot().pending[0]?.id).toBe(ack.id);
    expect(b.reply(ack.id, true, txB)).toBe(true);
    const item = b.snapshot().inbox[0];
    expect(readFileSync(item!.path ?? '').equals(data)).toBe(true);
    expect(a2.snapshot().transfers.find((t) => t.id === ack.id)?.state).toBe('done');
    // 投递成功后暂存文件才回收
    expect(existsSync(source)).toBe(false);
    a2.close();
    b.close();
  });

  it('离线排队有上限:条数满了直接拒绝,不让暂存区无限膨胀', () => {
    const a = createDirectService({ configDir: tmp() });
    for (let i = 0; i < DIRECT_MAX_QUEUED; i++) {
      expect(a.sendText('B', `第 ${i} 条`, undefined).queued).toBe(true);
    }
    expect(() => a.sendText('B', '再来一条', undefined)).toThrow(/排队已满/);
    a.close();
  });

  it('取消排队:回收暂存文件并记为已取消(不是失败)', () => {
    const configDir = tmp();
    const source = join(tmp(), 'cancel.bin');
    const data = Buffer.from('cancel me');
    writeFileSync(source, data);
    const a = createDirectService({ configDir });
    const ack = a.sendFile('B', {
      name: 'cancel.bin',
      sourcePath: source,
      size: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
    }, undefined);
    expect(existsSync(source)).toBe(true);
    expect(a.cancelQueued(ack.id)).toBe(true);
    expect(a.snapshot().transfers.find((t) => t.id === ack.id)).toMatchObject({ state: 'canceled' });
    expect(existsSync(source)).toBe(false);
    expect(existsSync(join(configDir, 'inbox', 'queue.json'))).toBe(false);
    // 已经结束的投送不能再取消
    expect(a.cancelQueued(ack.id)).toBe(false);
    a.close();
  });

  it('设备上线却不支持直发:排队项立刻失败,不必等满 24 小时', () => {
    const configDir = tmp();
    const a = createDirectService({ configDir });
    const ack = a.sendText('B', '排着的东西', undefined);
    a.failQueued('B', '对方版本不支持直发(请升级到支持 direct1 的版本)');
    expect(a.snapshot().transfers.find((t) => t.id === ack.id)).toMatchObject({
      state: 'failed',
      error: '对方版本不支持直发(请升级到支持 direct1 的版本)',
    });
    expect(existsSync(join(configDir, 'inbox', 'queue.json'))).toBe(false);
    a.close();
  });
});
