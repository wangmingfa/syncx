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
  /** paused = 链路断了、半截字节还留着,等对方重连后续传(窗口见 DIRECT_RESUME_TTL_MS)。 */
  state: 'offering' | 'transferring' | 'paused' | 'done' | 'failed';
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
  /**
   * 现取一台设备的直发通道(会话重连后由它拿到**新的** transport)。
   * 缺省 = 不做断点续传:掉线即失败,与旧行为一致(测试与其它嵌入方不必提供)。
   */
  getTransport?: (deviceId: string) => DirectTransport | undefined;
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
/**
 * 断点续传窗口:链路断开后保留半截文件 / 发送侧暂存这么久,期间对方重连就从
 * 已落盘字节接着传;超时才放弃并清理。10 分钟够覆盖 Wi-Fi 抖动、termux 被系统
 * 挂起、对端重启这类常见中断,又不至于让半截文件长期占着收件箱配额。
 */
export const DIRECT_RESUME_TTL_MS = 10 * 60 * 1000;
/** 续传期间重发提议的间隔(对方会话可能还在握手,早发会被丢弃)。 */
const DIRECT_RESUME_RETRY_MS = 3_000;

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
  /** 最近一次发出提议的时间:提议超时按它算,续传重发也不会被旧的 createdAt 拖死。 */
  offerSentAt: number;
  /** 断点续传中(掉过线):定时器据此重发提议、跳过普通提议超时。 */
  resuming?: boolean;
  pausedAt?: number;
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
  state: 'pending' | 'transferring' | 'paused';
  pausedAt?: number;
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
  /** 连接掉线:在途传输转为暂停(半截字节保留),等重连续传;无续传能力时直接失败。 */
  onPeerOffline(deviceId: string): void;
  /** 新会话建立:把暂停中的投送重新提议一次(没有暂停项时是空操作)。 */
  onPeerOnline(deviceId: string, tx: DirectTransport): void;
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

  /** 文件提议(首发与续传重发共用同一条消息,id 不变)。 */
  function offerMessage(out: OutgoingTransfer): DirectControlMessage {
    return {
      kind: 'direct-file-offer',
      id: out.id,
      fromDeviceId: '',
      name: out.name ?? '未命名文件',
      size: out.size,
      sha256: out.sha256 ?? '',
      createdAt: out.createdAt,
    };
  }

  /** 暂停入站传输:关句柄、留半截文件,等对方重连后从已落盘字节继续。 */
  function pauseIncoming(inc: IncomingTransfer): void {
    if (inc.fd !== undefined) {
      try { closeSync(inc.fd); } catch { /* 已关闭 */ }
      inc.fd = undefined;
    }
    inc.buffered.clear();
    inc.received.clear();
    // Hash 对象既不能序列化也不能"接续";续传时按磁盘上已有的整片字节重建。
    inc.hash = undefined;
    inc.state = 'paused';
    inc.pausedAt = Date.now();
    notify();
  }

  /** 只重算前 bytes 个字节的指纹:续传不重读整份文件,但必须与一次性哈希等价。 */
  function rebuildHash(fd: number, bytes: number): ReturnType<typeof createHash> {
    const hash = createHash('sha256');
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let pos = 0;
    while (pos < bytes) {
      const want = Math.min(buf.length, bytes - pos);
      const n = readSync(fd, buf, 0, want, pos);
      if (n <= 0) throw new Error('半截文件读取失败');
      hash.update(buf.subarray(0, n));
      pos += n;
    }
    return hash;
  }

  /**
   * 对端重连后重新提议:若本机已有同 id 的半截文件且内容一致,直接从这里继续,
   * **不再让用户确认一次**(他早就确认过这次接收)。返回 false 表示无法续传,
   * 调用方按普通新提议处理。
   */
  function resumeIncoming(
    inc: IncomingTransfer,
    message: Extract<DirectControlMessage, { kind: 'direct-file-offer' }>,
    from: string,
    tx: DirectTransport,
  ): boolean {
    if (inc.from !== from || inc.sha256 !== message.sha256 || inc.size !== message.size) return false;
    const offset = inc.bytesDone;
    // 落盘永远是整片顺序写,所以可续传的位置必然对齐到片边界;对不齐就不再相信这份半截。
    if (offset % DIRECT_CHUNK_BYTES !== 0 || offset >= inc.size) return false;
    let fd: number | undefined;
    try {
      fd = openSync(inc.tmpPath, 'r+');
      const hash = rebuildHash(fd, offset);
      inc.fd = fd;
      inc.hash = hash;
    } catch {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* 已关闭 */ } }
      return false;
    }
    inc.nextSeq = offset / DIRECT_CHUNK_BYTES;
    inc.state = 'transferring';
    inc.pausedAt = undefined;
    inc.lastProgressAt = Date.now();
    tx.control(from, { kind: 'direct-reply', id: inc.id, fromDeviceId: '', accept: true, offset });
    notify();
    return true;
  }

  /** 暂停出站传输:关句柄、留暂存文件与已确认片号,等重连后重新提议。 */
  function pauseOutgoing(out: OutgoingTransfer): void {
    if (out.fd !== undefined) {
      try { closeSync(out.fd); } catch { /* 已关闭 */ }
      out.fd = undefined;
    }
    out.inflight.clear();
    out.state = 'paused';
    out.resuming = true;
    out.pausedAt = Date.now();
    out.error = undefined;
    notify();
  }

  /** 新会话就绪:对这台设备所有暂停中的投送重新提议一次。 */
  function reofferPaused(deviceId: string, tx: DirectTransport | undefined): void {
    if (!tx) return;
    const now = Date.now();
    for (const out of outgoing.values()) {
      if (out.deviceId !== deviceId || !out.resuming) continue;
      // 刚开始的这几秒内不抢跑:定时器与 onPeerOnline 可能同时到,别一轮发两次。
      if (now - out.offerSentAt < 1_000 && out.state === 'offering') continue;
      out.state = 'offering';
      out.offerSentAt = now;
      lastTx.set(out.id, tx);
      sendControl(tx, out.deviceId, offerMessage(out));
    }
    notify();
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
        // 会话刚好断了:有续传能力就留半截等重连,否则按旧的快速失败。
        if (deps.getTransport) pauseOutgoing(out);
        else cancelOutgoing(out, '会话已断开', tx);
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

  function newOutgoing(partial: Omit<OutgoingTransfer, 'bytesDone' | 'state' | 'createdAt' | 'offerSentAt' | 'acked' | 'nextSeq' | 'inflight' | 'lastProgressAt'>): OutgoingTransfer {
    const out: OutgoingTransfer = {
      ...partial,
      bytesDone: 0,
      state: 'offering',
      createdAt: Date.now(),
      offerSentAt: Date.now(),
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

  // 兜底表:超时探测 + 分片重发 + 续传重提议。unref,不拖住 daemon 退出。
  timer = setInterval(() => {
    const now = Date.now();
    const resumedDevices = new Set<string>();
    for (const out of [...outgoing.values()]) {
      if (out.resuming) {
        // 续传窗口内一直重发提议:对方的会话可能还在握手,早发的会被丢弃。
        if (now - (out.pausedAt ?? now) > DIRECT_RESUME_TTL_MS) {
          cancelOutgoing(out, '设备离线时间过长,已中止发送');
          continue;
        }
        if (out.state !== 'transferring' && !resumedDevices.has(out.deviceId)
          && now - out.offerSentAt >= DIRECT_RESUME_RETRY_MS) {
          resumedDevices.add(out.deviceId);
          reofferPaused(out.deviceId, deps.getTransport?.(out.deviceId));
        }
        continue;
      }
      if (out.state === 'offering' && now - out.offerSentAt > DIRECT_OFFER_TIMEOUT_MS) {
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
      if (inc.state === 'paused' && now - (inc.pausedAt ?? now) > DIRECT_RESUME_TTL_MS) {
        cleanupIncoming(inc);
        notify();
        continue;
      }
      if (inc.state === 'transferring' && now - inc.lastProgressAt > DIRECT_STALL_TIMEOUT_MS) {
        // 会话还挂着却没进展(对端假死):丢弃半截,等它重连后重新提议。
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
          ...[...incoming.values()].filter((i) => i.state !== 'pending').map((i): DirectTransfer => ({
            id: i.id,
            direction: 'receive',
            deviceId: i.from,
            kind: 'file',
            name: i.name,
            size: i.size,
            bytesDone: i.bytesDone,
            state: i.state === 'paused' ? 'paused' : 'transferring',
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
          if (!isSafeId(message.id)) return;
          const paused = incoming.get(message.id);
          if (paused) {
            // 同一 id 又来一次 = 对端重连后重新提议:能接着传就静默继续;接不上就按新提议重来。
            if (paused.state === 'paused' && resumeIncoming(paused, message, from, tx)) return;
            if (paused.state !== 'paused') return;
            cleanupIncoming(paused);
            notify();
          }
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
          // 续传:接收方告诉我们它已经落盘多少字节,从对应片号接着发。
          // 只认「本轮就是续传」的 offset —— 新投送若收到非 0 偏移,说明对方状态不干净,直接失败。
          const offset = message.offset ?? 0;
          if (offset !== 0) {
            const usable = out.resuming === true
              && Number.isInteger(offset)
              && offset > 0
              && offset % DIRECT_CHUNK_BYTES === 0
              && offset < out.size;
            if (!usable) {
              finishOutgoing(out, false, '续传位置不合法');
              return;
            }
            out.acked = offset / DIRECT_CHUNK_BYTES;
            out.nextSeq = out.acked;
            out.bytesDone = offset;
            out.inflight.clear();
          }
          out.state = 'transferring';
          out.resuming = false;
          out.pausedAt = undefined;
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
      // 同一设备可能有多条连接(主会话 + 备份):断掉的也许只是备份,在途传输仍活在
      // 另一条上。此时什么都不该动 —— 否则一次无关的 close 就会把健康的传输打成暂停。
      if (deps.getTransport?.(deviceId)) return;
      for (const inc of [...incoming.values()]) {
        if (inc.from !== deviceId) continue;
        // 已经收了一部分:留半截等重连续传;还没开始收的提议随会话一起作废。
        if (inc.state === 'transferring') {
          pauseIncoming(inc);
        } else {
          cleanupIncoming(inc);
          notify();
        }
      }
      for (const out of [...outgoing.values()]) {
        if (out.deviceId !== deviceId || out.state === 'done' || out.state === 'failed') continue;
        if (out.resuming) continue; // 已经在等重连,不重复处理
        // 只有「真传过字节」且嵌入方提供了现取通道的能力才值得等重连;
        // 否则保持旧的快速失败,免得半截暂存挂着没人接手。
        if (out.state === 'transferring' && deps.getTransport) {
          pauseOutgoing(out);
        } else {
          cancelOutgoing(out, '设备已离线');
        }
      }
      for (const [id, out] of outgoing) {
        if (out.deviceId === deviceId) lastTx.delete(id);
      }
    },

    onPeerOnline(deviceId, tx) {
      reofferPaused(deviceId, tx);
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
