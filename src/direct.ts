/**
 * 设备间直发(ADR-0028):把一段文本 / 一个文件投到**在线**对端的收件箱。
 *
 * 这一层刻意不认识 socket、不认识共享目录:
 *  - 跨设备只经注入的 DirectTransport(由 session-manager 用已握手、已加密的会话实现);
 *  - 落地全在 `<configDir>/inbox/`,**永不写共享目录**,因此不进索引、不产生版本向量、
 *    不会触发同步冲突或 .sync-conflict 副本;
 *  - 文本与文件都走「接收方确认」:文本直接入箱并回执,文件先提议 + 用户确认后再分片。
 *
 * 归属身份一律用 ws 会话验签过的 hopDeviceId,不信消息体里的 fromDeviceId ——
 * 后者由 withSelfInfo 注入,只携带版本/主机名等展示信息。
 */
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { ControlMessage } from './net/wire.js';

export type DirectControlMessage = Extract<ControlMessage, { kind: `direct-${string}` }>;

/** 会话侧注入的发送口。返回 false 表示会话刚好断了,调用方按失败处理。 */
export interface DirectTransport {
  control(deviceId: string, message: DirectControlMessage): boolean;
  chunk(deviceId: string, id: string, seq: number, data: Buffer): boolean;
}

export interface DirectTextItem {
  kind: 'text';
  id: string;
  from: string;
  createdAt: number;
  size: number;
  /** 状态快照里的短预览;正文按需从 /api/direct/inbox/:id/content 取。 */
  preview: string;
  path: string;
}

export interface DirectFileItem {
  kind: 'file';
  id: string;
  from: string;
  createdAt: number;
  name: string;
  size: number;
  sha256: string;
  path: string;
  /** true = 接收时选择了「另存到指定目录」:path 指向用户目录,删回执不能删文件。 */
  external?: boolean;
}

export type DirectItem = DirectTextItem | DirectFileItem;

/** 一份等用户确认的入站文件提议(状态快照只给元数据,不含字节)。 */
export interface DirectPending {
  id: string;
  from: string;
  name: string;
  size: number;
  sha256: string;
  createdAt: number;
}

export interface DirectTransfer {
  id: string;
  direction: 'send' | 'receive';
  deviceId: string;
  kind: 'text' | 'file';
  name?: string;
  size: number;
  bytesDone: number;
  state: 'offering' | 'transferring' | 'done' | 'failed';
  error?: string;
}

export interface DirectSnapshot {
  inbox: DirectItem[];
  pending: DirectPending[];
  transfers: DirectTransfer[];
}

export interface DirectServiceDeps {
  configDir: string;
  /** 状态变更通知(接到 statusHub.notify,Web UI 走既有 WS 推送)。 */
  onChange?: () => void;
}

/**
 * 控制 API 看到的服务面:只暴露 HTTP 层需要的操作,不把 transport 注入细节漏出去。
 * transport 由 cli 接线处现取会话(离线 / 旧对端时抛错),服务本身只管协议与落盘。
 */
export interface DirectApi {
  snapshot(): DirectSnapshot;
  content(id: string): Promise<{ item: DirectItem; data: Buffer } | undefined>;
  remove(id: string): Promise<boolean>;
  /** saveDir 给出时,收齐后落到该目录而不是收件箱(调用方已完成提权与路径校验)。 */
  reply(id: string, accept: boolean, reason?: string, saveDir?: string): boolean;
  sendText(deviceId: string, text: string): string;
  sendFile(deviceId: string, file: { name: string; sourcePath: string; size: number; sha256: string }): string;
}

/** 单片明文 256KB:与二进制信封的水位相称,重传代价可控。 */
export const DIRECT_CHUNK_BYTES = 256 * 1024;
/** 在途窗口:4 片 ≈ 1MB,局域网足够跑满而不需要复杂的选择性重传调度。 */
const DIRECT_WINDOW = 4;
/** 文本上限(64KB UTF-8 字节,不是字符数)。 */
export const DIRECT_MAX_TEXT_BYTES = 64 * 1024;
/** 单文件上限 100MB:超过请走共享目录(那是为大数据量设计的路径)。 */
export const DIRECT_MAX_FILE_BYTES = 100 * 1024 * 1024;
/** 收件箱软配额:超出后拒绝新入站,避免把 daemon 数据目录撑爆。 */
const DIRECT_INBOX_QUOTA_BYTES = 512 * 1024 * 1024;
/** 提议等待用户确认的时限(2 分钟,允许对方起身去点)。 */
const DIRECT_OFFER_TIMEOUT_MS = 120_000;
/** 分片重传间隔:超过 5s 没确认就重发该片。 */
const DIRECT_RETRY_MS = 5_000;
/** 单片最多重传次数(3 次后放弃并 cancel,不留半截文件)。 */
const DIRECT_MAX_RETRIES = 3;
/** 完全收不到确认的硬超时(30s)。 */
const DIRECT_STALL_TIMEOUT_MS = 30_000;
/** 乱序分片缓存上限(32 片 = 8MB);超出的片丢弃,发送方会重传。 */
const MAX_BUFFERED_CHUNKS = 32;
/** 已结束的传输记录在快照里保留多久(给 UI 足够时间看到结果)。 */
const FINISHED_TTL_MS = 60_000;

interface OutgoingTransfer {
  id: string;
  deviceId: string;
  kind: 'text' | 'file';
  name?: string;
  size: number;
  bytesDone: number;
  state: DirectTransfer['state'];
  error?: string;
  createdAt: number;
  finishedAt?: number;
  /** 文件专用:分期中的本地暂存文件、指纹、分片账本。 */
  sourcePath?: string;
  fd?: number;
  sha256?: string;
  totalChunks?: number;
  acked: number;
  nextSeq: number;
  inflight: Map<number, { body: Buffer; sentAt: number; attempts: number }>;
  lastProgressAt: number;
}

interface IncomingTransfer {
  id: string;
  from: string;
  name: string;
  size: number;
  sha256: string;
  createdAt: number;
  tmpPath: string;
  /** 接收方在确认时指定的另存目录;undefined = 落收件箱。 */
  saveDir?: string;
  state: 'pending' | 'transferring';
  fd?: number;
  hash?: ReturnType<typeof createHash>;
  nextSeq: number;
  totalChunks: number;
  bytesDone: number;
  received: Set<number>;
  buffered: Map<number, Buffer>;
  lastProgressAt: number;
}

function directId(prefix: string): string {
  return `${prefix}-${randomBytes(8).toString('hex')}`;
}

/** 文件名只取 basename 并去掉控制字符;重名由落盘时加序号兜底。 */
function safeFileName(input: string): string {
  const base = input.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '_').trim();
  return (cleaned || '未命名文件').slice(0, 180);
}

function isSafeId(id: string): boolean {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(id);
}

export interface DirectService {
  /** 当前状态快照(收件箱元数据 + 待确认 + 在途),供 status 下发。 */
  snapshot(): DirectSnapshot;
  /** 取一条收件箱内容;文件返回原始字节,文本返回 UTF-8 字节。 */
  content(id: string): Promise<{ item: DirectItem; data: Buffer } | undefined>;
  /** 删除一条收件箱记录(连同正文;不可逆)。 */
  remove(id: string): Promise<boolean>;
  /** 发起文本直发,返回投送 id;实际结果经 state.transfers 确认。 */
  sendText(deviceId: string, text: string, tx: DirectTransport): string;
  /** 发起文件直发;sourcePath 是已落在**非共享暂存区**的完整文件。 */
  sendFile(
    deviceId: string,
    file: { name: string; sourcePath: string; size: number; sha256: string },
    tx: DirectTransport,
  ): string;
  /** 处理经会话验签归属后的控制消息。 */
  handleControl(message: DirectControlMessage, from: string, tx: DirectTransport): void;
  /** 处理一个直发文件分片帧(会话已解密、已按连接归属)。 */
  handleChunk(frame: { header: Record<string, unknown>; body: Buffer }, from: string, tx: DirectTransport): void;
  /** 接收方确认 / 拒绝一个待确认文件;saveDir 给出时落到用户目录而非收件箱。 */
  reply(id: string, accept: boolean, tx: DirectTransport, reason?: string, saveDir?: string): boolean;
  /** 连接掉线:失败与之相关的传输、清理临时文件(不再尝试发 cancel)。 */
  onPeerOffline(deviceId: string): void;
  /** daemon 关闭:停表并清理。 */
  close(): void;
}

export function createDirectService(deps: DirectServiceDeps): DirectService {
  const root = join(deps.configDir, 'inbox');
  const messagesDir = join(root, 'messages');
  const filesDir = join(root, 'files');
  const tmpDir = join(root, '.tmp');
  const indexPath = join(root, 'index.json');
  for (const dir of [root, messagesDir, filesDir, tmpDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  const outgoing = new Map<string, OutgoingTransfer>();
  const incoming = new Map<string, IncomingTransfer>();
  /** 每个投送最近一次使用的 transport,供定时重发用(会话切书时随之更新)。 */
  const lastTx = new Map<string, DirectTransport>();
  /** 群发时多笔投送共用同一份暂存文件:按路径计数,最后一笔结束才删。 */
  const sourceRefs = new Map<string, number>();
  let items: DirectItem[] = readIndex();
  let timer: ReturnType<typeof setInterval> | undefined;

  function readIndex(): DirectItem[] {
    try {
      const parsed = JSON.parse(readFileSync(indexPath, 'utf8')) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((v): v is DirectItem => {
        if (typeof v !== 'object' || v === null) return false;
        const item = v as Record<string, unknown>;
        return (
          (item.kind === 'text' || item.kind === 'file') &&
          isSafeId(item.id as string) &&
          typeof item.from === 'string' &&
          typeof item.createdAt === 'number' &&
          typeof item.path === 'string'
        );
      });
    } catch {
      return [];
    }
  }

  function saveIndex(): void {
    const tmp = `${indexPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(items, null, 2), 'utf8');
    renameSync(tmp, indexPath);
  }

  function notify(): void {
    deps.onChange?.();
  }

  function sendControl(tx: DirectTransport, to: string, message: DirectControlMessage): void {
    tx.control(to, message);
  }

  /** 释放一笔投送对暂存文件的引用;只有群发的最后一笔才真正删文件。 */
  function releaseSource(out: OutgoingTransfer): void {
    const path = out.sourcePath;
    if (!path) return;
    out.sourcePath = undefined;
    const left = (sourceRefs.get(path) ?? 1) - 1;
    if (left > 0) {
      sourceRefs.set(path, left);
      return;
    }
    sourceRefs.delete(path);
    try { rmSync(path, { force: true }); } catch { /* 清理失败不影响状态 */ }
  }

  function cancelOutgoing(out: OutgoingTransfer, error: string, tx?: DirectTransport): void {
    if (out.fd !== undefined) {
      try { closeSync(out.fd); } catch { /* 已关闭 */ }
      out.fd = undefined;
    }
    if (out.state !== 'done' && out.state !== 'failed') {
      out.state = 'failed';
      out.error = error;
    }
    out.finishedAt = Date.now();
    releaseSource(out);
    if (tx && out.state === 'failed') {
      sendControl(tx, out.deviceId, { kind: 'direct-cancel', id: out.id, fromDeviceId: '', reason: error });
    }
    notify();
  }

  function finishOutgoing(out: OutgoingTransfer, ok: boolean, error?: string): void {
    if (out.fd !== undefined) {
      try { closeSync(out.fd); } catch { /* 已关闭 */ }
      out.fd = undefined;
    }
    out.state = ok ? 'done' : 'failed';
    out.error = ok ? undefined : (error ?? '传输失败');
    out.finishedAt = Date.now();
    releaseSource(out);
    notify();
  }

  function cleanupIncoming(inc: IncomingTransfer): void {
    if (inc.fd !== undefined) {
      try { closeSync(inc.fd); } catch { /* 已关闭 */ }
      inc.fd = undefined;
    }
    inc.buffered.clear();
    try { rmSync(inc.tmpPath, { force: true }); } catch { /* 清理失败不影响状态 */ }
    incoming.delete(inc.id);
  }

  /** 收件箱或用户指定目录里的不覆盖落点:同名一律加 (n) 后缀。 */
  function uniqueFilePath(name: string, dir = filesDir): string {
    const safe = safeFileName(name);
    let candidate = join(dir, safe);
    let n = 1;
    while (existsSync(candidate)) {
      const dot = safe.lastIndexOf('.');
      const stem = dot > 0 ? safe.slice(0, dot) : safe;
      const ext = dot > 0 ? safe.slice(dot) : '';
      candidate = join(dir, `${stem} (${n++})${ext}`);
    }
    return candidate;
  }

  function pump(out: OutgoingTransfer, tx: DirectTransport): void {
    if (out.state !== 'transferring' || out.fd === undefined || out.totalChunks === undefined) return;
    while (out.nextSeq < out.totalChunks && out.nextSeq - out.acked < DIRECT_WINDOW) {
      const seq = out.nextSeq++;
      const body = Buffer.allocUnsafe(DIRECT_CHUNK_BYTES);
      let n: number;
      try {
        n = readSync(out.fd, body, 0, body.length, seq * DIRECT_CHUNK_BYTES);
      } catch (err) {
        cancelOutgoing(out, `读取待发文件失败:${err instanceof Error ? err.message : String(err)}`, tx);
        return;
      }
      if (n <= 0) {
        cancelOutgoing(out, '待发文件在传输中被改动,已中止', tx);
        return;
      }
      const data = n === body.length ? body : body.subarray(0, n);
      out.inflight.set(seq, { body: data, sentAt: Date.now(), attempts: 1 });
      if (!tx.chunk(out.deviceId, out.id, seq, data)) {
        cancelOutgoing(out, '会话已断开', tx);
        return;
      }
    }
  }

  function writeSequential(inc: IncomingTransfer, tx: DirectTransport): void {
    if (inc.fd === undefined || inc.hash === undefined) return;
    while (inc.buffered.has(inc.nextSeq)) {
      const body = inc.buffered.get(inc.nextSeq)!;
      inc.buffered.delete(inc.nextSeq);
      try {
        const written = writeSync(inc.fd, body, 0, body.length, inc.bytesDone);
        if (written !== body.length) throw new Error('short write');
      } catch (err) {
        tx.control(inc.from, {
          kind: 'direct-cancel',
          id: inc.id,
          fromDeviceId: '',
          reason: `本机写入失败:${err instanceof Error ? err.message : String(err)}`,
        });
        cleanupIncoming(inc);
        notify();
        return;
      }
      inc.hash.update(body);
      inc.bytesDone += body.length;
      inc.nextSeq++;
      inc.lastProgressAt = Date.now();
    }
    // 未收齐才回累积 ack。最后一片必须只回 direct-result:
    // ack 会让发送方在同一个调用栈里继续 pump,而本函数尚未 digest —— 重入会二次消费哈希。
    if (inc.bytesDone !== inc.size) {
      sendControl(tx, inc.from, { kind: 'direct-ack', id: inc.id, fromDeviceId: '', seq: inc.nextSeq });
      return;
    }
    // 收齐:先关句柄再校验。哈希按落盘顺序算,与发送方对整份文件的指纹可比。
    try { closeSync(inc.fd); } catch { /* 已关闭 */ }
    inc.fd = undefined;
    if (inc.hash.digest('hex') !== inc.sha256) {
      tx.control(inc.from, { kind: 'direct-result', id: inc.id, fromDeviceId: '', ok: false, error: '文件校验失败(sha256 不一致)' });
      cleanupIncoming(inc);
      notify();
      return;
    }
    const finalPath = uniqueFilePath(inc.name, inc.saveDir ?? filesDir);
    try {
      renameSync(inc.tmpPath, finalPath);
    } catch (err) {
      tx.control(inc.from, { kind: 'direct-result', id: inc.id, fromDeviceId: '', ok: false, error: `落盘失败:${err instanceof Error ? err.message : String(err)}` });
      cleanupIncoming(inc);
      notify();
      return;
    }
    items.unshift({
      kind: 'file',
      id: inc.id,
      from: inc.from,
      createdAt: inc.createdAt,
      name: inc.name,
      size: inc.size,
      sha256: inc.sha256,
      path: finalPath,
      // 另存到用户目录时收件箱只留回执;删回执绝不删用户盘上的真实文件。
      ...(inc.saveDir ? { external: true } : {}),
    });
    saveIndex();
    incoming.delete(inc.id);
    tx.control(inc.from, { kind: 'direct-result', id: inc.id, fromDeviceId: '', ok: true });
    notify();
  }

  function addTextItem(from: string, text: string): void {
    const id = directId('dt');
    const data = Buffer.from(text, 'utf8');
    const path = join(messagesDir, `${id}.txt`);
    writeFileSync(path, data);
    const item: DirectTextItem = {
      kind: 'text',
      id,
      from,
      createdAt: Date.now(),
      size: data.length,
      preview: [...text].slice(0, 120).join(''),
      path,
    };
    items.unshift(item);
    saveIndex();
  }

  function newOutgoing(partial: Omit<OutgoingTransfer, 'bytesDone' | 'state' | 'createdAt' | 'acked' | 'nextSeq' | 'inflight' | 'lastProgressAt'>): OutgoingTransfer {
    const out: OutgoingTransfer = {
      ...partial,
      bytesDone: 0,
      state: 'offering',
      createdAt: Date.now(),
      acked: 0,
      nextSeq: 0,
      inflight: new Map(),
      lastProgressAt: Date.now(),
    };
    outgoing.set(out.id, out);
    if (out.sourcePath) {
      sourceRefs.set(out.sourcePath, (sourceRefs.get(out.sourcePath) ?? 0) + 1);
    }
    // 只保留最近若干条,免得状态快照无限增长
    if (outgoing.size > 30) {
      const oldest = [...outgoing.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
      if (oldest) {
        releaseSource(oldest);
        outgoing.delete(oldest.id);
      }
    }
    notify();
    return out;
  }

  /** 重发:从磁盘重读该片(内存里的副本可能被上一轮 subarray 截短)。 */
  function resend(out: OutgoingTransfer, seq: number): void {
    const slot = out.inflight.get(seq);
    const tx = lastTx.get(out.id);
    if (!slot || !tx || out.fd === undefined) return;
    let n: number;
    try {
      n = readSync(out.fd, slot.body, 0, slot.body.length, seq * DIRECT_CHUNK_BYTES);
    } catch {
      cancelOutgoing(out, '重读待发文件失败', tx);
      return;
    }
    if (n <= 0) {
      cancelOutgoing(out, '待发文件在传输中被改动,已中止', tx);
      return;
    }
    slot.body = n === slot.body.length ? slot.body : slot.body.subarray(0, n);
    tx.chunk(out.deviceId, out.id, seq, slot.body);
  }

  // 兜底表:超时探测 + 分片重发。unref,不拖住 daemon 退出。
  timer = setInterval(() => {
    const now = Date.now();
    for (const out of [...outgoing.values()]) {
      if (out.state === 'offering' && now - out.createdAt > DIRECT_OFFER_TIMEOUT_MS) {
        cancelOutgoing(out, '对方未在 2 分钟内确认');
        continue;
      }
      if (out.state !== 'transferring') continue;
      if (now - out.lastProgressAt > DIRECT_STALL_TIMEOUT_MS) {
        cancelOutgoing(out, '对方长时间没有确认,已中止');
        continue;
      }
      for (const [seq, slot] of [...out.inflight]) {
        if (now - slot.sentAt < DIRECT_RETRY_MS) continue;
        if (slot.attempts >= DIRECT_MAX_RETRIES) {
          cancelOutgoing(out, `第 ${seq + 1} 片重试 ${DIRECT_MAX_RETRIES} 次仍未确认`);
          break;
        }
        slot.attempts++;
        slot.sentAt = now;
        resend(out, seq);
      }
    }
    for (const inc of [...incoming.values()]) {
      if (inc.state === 'transferring' && now - inc.lastProgressAt > DIRECT_STALL_TIMEOUT_MS) {
        cleanupIncoming(inc);
        notify();
      }
    }
    for (const [id, out] of outgoing) {
      if (out.finishedAt && now - out.finishedAt > FINISHED_TTL_MS) {
        outgoing.delete(id);
        lastTx.delete(id);
      }
    }
  }, 1000);
  timer.unref();

  return {
    snapshot() {
      const transfer = (o: OutgoingTransfer): DirectTransfer => ({
        id: o.id,
        direction: 'send',
        deviceId: o.deviceId,
        kind: o.kind,
        ...(o.name ? { name: o.name } : {}),
        size: o.size,
        bytesDone: o.bytesDone,
        state: o.state,
        ...(o.error ? { error: o.error } : {}),
      });
      return {
        inbox: items.slice(0, 100).map((i) => ({ ...i })),
        pending: [...incoming.values()]
          .filter((i) => i.state === 'pending')
          .map((i) => ({ id: i.id, from: i.from, name: i.name, size: i.size, sha256: i.sha256, createdAt: i.createdAt })),
        transfers: [
          ...[...outgoing.values()].filter((o) => !o.finishedAt || Date.now() - o.finishedAt < FINISHED_TTL_MS).map(transfer),
          ...[...incoming.values()].filter((i) => i.state === 'transferring').map((i): DirectTransfer => ({
            id: i.id,
            direction: 'receive',
            deviceId: i.from,
            kind: 'file',
            name: i.name,
            size: i.size,
            bytesDone: i.bytesDone,
            state: 'transferring',
          })),
        ],
      };
    },

    async content(id) {
      const item = items.find((i) => i.id === id);
      if (!item) return undefined;
      try {
        return { item: { ...item }, data: await fs.readFile(item.path) };
      } catch {
        return undefined;
      }
    },

    async remove(id) {
      const idx = items.findIndex((i) => i.id === id);
      if (idx < 0) return false;
      const [item] = items.splice(idx, 1);
      saveIndex();
      if (item && item.kind === 'file' && !item.external) {
        try { await fs.rm(item.path, { force: true }); } catch { /* 清理失败不影响索引 */ }
      }
      notify();
      return true;
    },

    sendText(deviceId, text, tx) {
      const len = Buffer.byteLength(text, 'utf8');
      if (len === 0 || len > DIRECT_MAX_TEXT_BYTES) {
        throw new Error(`文本长度必须在 1 ~ ${DIRECT_MAX_TEXT_BYTES} 字节之间`);
      }
      const out = newOutgoing({ id: directId('dt'), deviceId, kind: 'text', size: len });
      lastTx.set(out.id, tx);
      sendControl(tx, deviceId, {
        kind: 'direct-text',
        id: out.id,
        fromDeviceId: '',
        text,
        createdAt: out.createdAt,
      });
      return out.id;
    },

    sendFile(deviceId, file, tx) {
      if (file.size <= 0 || file.size > DIRECT_MAX_FILE_BYTES) {
        throw new Error(`文件大小必须在 1 ~ ${DIRECT_MAX_FILE_BYTES} 字节之间`);
      }
      if (!/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('文件指纹格式不正确');
      const out = newOutgoing({
        id: directId('df'),
        deviceId,
        kind: 'file',
        name: safeFileName(file.name),
        size: file.size,
        sourcePath: file.sourcePath,
        sha256: file.sha256,
        totalChunks: Math.ceil(file.size / DIRECT_CHUNK_BYTES),
      });
      lastTx.set(out.id, tx);
      sendControl(tx, deviceId, {
        kind: 'direct-file-offer',
        id: out.id,
        fromDeviceId: '',
        name: out.name!,
        size: out.size,
        sha256: file.sha256,
        createdAt: out.createdAt,
      });
      return out.id;
    },

    handleControl(message, from, tx) {
      switch (message.kind) {
        case 'direct-text': {
          const len = Buffer.byteLength(message.text ?? '', 'utf8');
          if (!isSafeId(message.id) || len === 0 || len > DIRECT_MAX_TEXT_BYTES) return;
          if (outgoing.has(message.id) || incoming.has(message.id)) return;
          addTextItem(from, message.text);
          tx.control(from, { kind: 'direct-result', id: message.id, fromDeviceId: '', ok: true });
          break;
        }
        case 'direct-file-offer': {
          if (!isSafeId(message.id) || incoming.has(message.id)) return;
          if (!Number.isFinite(message.size) || message.size <= 0 || message.size > DIRECT_MAX_FILE_BYTES) return;
          if (!/^[a-f0-9]{64}$/.test(message.sha256 ?? '')) return;
          const used = items.reduce((sum, i) => sum + i.size, 0);
          if (used + message.size > DIRECT_INBOX_QUOTA_BYTES) {
            tx.control(from, { kind: 'direct-result', id: message.id, fromDeviceId: '', ok: false, error: '本机收件箱空间不足' });
            return;
          }
          incoming.set(message.id, {
            id: message.id,
            from,
            name: safeFileName(message.name ?? ''),
            size: message.size,
            sha256: message.sha256,
            createdAt: message.createdAt || Date.now(),
            tmpPath: join(tmpDir, `in-${message.id}`),
            state: 'pending',
            nextSeq: 0,
            totalChunks: Math.ceil(message.size / DIRECT_CHUNK_BYTES),
            bytesDone: 0,
            received: new Set(),
            buffered: new Map(),
            lastProgressAt: Date.now(),
          });
          notify();
          break;
        }
        case 'direct-reply': {
          const out = outgoing.get(message.id);
          if (!out || out.deviceId !== from || out.state !== 'offering') return;
          if (!message.accept) {
            finishOutgoing(out, false, message.reason || '对方拒绝了这次发送');
            return;
          }
          if (out.fd !== undefined || out.totalChunks === undefined) return;
          out.state = 'transferring';
          out.lastProgressAt = Date.now();
          lastTx.set(out.id, tx);
          try {
            out.fd = openSync(out.sourcePath!, 'r');
          } catch (err) {
            finishOutgoing(out, false, `打开待发文件失败:${err instanceof Error ? err.message : String(err)}`);
            return;
          }
          pump(out, tx);
          break;
        }
        case 'direct-ack': {
          const out = outgoing.get(message.id);
          if (!out || out.deviceId !== from || out.state !== 'transferring') return;
          if (!Number.isInteger(message.seq) || message.seq <= out.acked || message.seq > (out.totalChunks ?? 0)) return;
          out.acked = message.seq;
          out.bytesDone = Math.min(out.size, message.seq * DIRECT_CHUNK_BYTES);
          out.lastProgressAt = Date.now();
          for (const seq of [...out.inflight.keys()]) {
            if (seq < message.seq) out.inflight.delete(seq);
          }
          pump(out, tx);
          break;
        }
        case 'direct-result': {
          const out = outgoing.get(message.id);
          if (!out || out.deviceId !== from) return;
          finishOutgoing(out, message.ok === true, message.error);
          break;
        }
        case 'direct-cancel': {
          const inc = incoming.get(message.id);
          if (inc && inc.from === from) {
            cleanupIncoming(inc);
            notify();
          }
          const out = outgoing.get(message.id);
          if (out && out.deviceId === from && out.state !== 'done' && out.state !== 'failed') {
            finishOutgoing(out, false, message.reason || '对方已取消');
          }
          break;
        }
      }
    },

    handleChunk(frame, from, tx) {
      const id = frame.header.id;
      const seq = frame.header.seq;
      if (!isSafeId(id as string) || !Number.isInteger(seq)) return;
      const inc = incoming.get(id as string);
      if (!inc || inc.from !== from || inc.state !== 'transferring') return;
      const n = seq as number;
      if (n < 0 || n >= inc.totalChunks) return;
      const body = frame.body;
      if (body.length === 0 || body.length > DIRECT_CHUNK_BYTES) return;
      if (n * DIRECT_CHUNK_BYTES + body.length > inc.size) return;
      if (n < inc.nextSeq) {
        // 重复片:只回当前期望,绝不把字节写第二遍
        sendControl(tx, from, { kind: 'direct-ack', id: inc.id, fromDeviceId: '', seq: inc.nextSeq });
        return;
      }
      if (inc.received.has(n)) return;
      if (n > inc.nextSeq) {
        if (inc.buffered.size < MAX_BUFFERED_CHUNKS) inc.buffered.set(n, body);
        sendControl(tx, from, { kind: 'direct-ack', id: inc.id, fromDeviceId: '', seq: inc.nextSeq });
        return;
      }
      inc.received.add(n);
      inc.buffered.set(n, body);
      writeSequential(inc, tx);
    },

    reply(id, accept, tx, reason, saveDir) {
      const inc = incoming.get(id);
      if (!inc || inc.state !== 'pending') return false;
      if (!accept) {
        tx.control(inc.from, { kind: 'direct-reply', id, fromDeviceId: '', accept: false, reason: reason ?? '对方拒绝了接收' });
        cleanupIncoming(inc);
        notify();
        return true;
      }
      // 只在真正开始接收时记下另存目录;拒绝路径完全不碰用户文件系统。
      inc.saveDir = saveDir;
      inc.state = 'transferring';
      inc.lastProgressAt = Date.now();
      try {
        inc.fd = openSync(inc.tmpPath, 'w');
        inc.hash = createHash('sha256');
      } catch (err) {
        tx.control(inc.from, { kind: 'direct-result', id, fromDeviceId: '', ok: false, error: `创建临时文件失败:${err instanceof Error ? err.message : String(err)}` });
        cleanupIncoming(inc);
        notify();
        return true;
      }
      tx.control(inc.from, { kind: 'direct-reply', id, fromDeviceId: '', accept: true });
      notify();
      return true;
    },

    onPeerOffline(deviceId) {
      for (const inc of [...incoming.values()]) {
        if (inc.from === deviceId) {
          cleanupIncoming(inc);
          notify();
        }
      }
      for (const out of [...outgoing.values()]) {
        if (out.deviceId === deviceId && out.state !== 'done' && out.state !== 'failed') {
          cancelOutgoing(out, '设备已离线');
        }
      }
      for (const [id, out] of outgoing) {
        if (out.deviceId === deviceId) lastTx.delete(id);
      }
    },

    close() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      for (const inc of [...incoming.values()]) cleanupIncoming(inc);
      for (const out of outgoing.values()) {
        if (out.fd !== undefined) {
          try { closeSync(out.fd); } catch { /* 已关闭 */ }
        }
        releaseSource(out);
      }
      sourceRefs.clear();
      lastTx.clear();
    },
  };
}
