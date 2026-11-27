/**
 * 设备间直发(ADR-0028):把一段文本 / 一个文件投到**在线**对端的收件箱。
 *
 * 这一层刻意不认识 socket、不认识共享目录:
 *  - 跨设备只经注入的 DirectTransport(由 session-manager 用已握手、已加密的会话实现);
 *  - 落地全在 `<configDir>/inbox/`,**永不写共享目录**,因此不进索引、不产生版本向量、
 *    不会触发同步冲突或 .sync-conflict 副本;
 *  - 文本与文件都走「接收方确认」:文本直接入箱并回执,文件先提议 + 用户确认后再分片。
 *  - 目标设备离线时不报错退场,而是先入队(`inbox/queue.json`),等它上线自动投递;
 *    队列有 24 小时窗口与条数/字节上限,免得离线设备把本机磁盘当无限仓库。
 *  - 传了一半的传输把半截留在盘上(`inbox/resume.json` 记台账),对端重连、甚至本机
 *    daemon 重启过,都能从已落盘的字节接着传,不从头再来。
 *
 * 归属身份一律用 ws 会话验签过的 hopDeviceId,不信消息体里的 fromDeviceId ——
 * 后者由 withSelfInfo 注入,只携带版本/主机名等展示信息。
 */
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
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
  /** true = 还没被用户看过:收件箱角标与提醒动画据此点亮。缺省(旧条目)= 已读。 */
  unread?: boolean;
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
  /** 用户亲手点过「接收」的文件直接算已读;缺省不带 = 已读。 */
  unread?: boolean;
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
  /** 同一次「发送 N 个文件」的组号:接收方按它合并成一张卡,一次确认全部。 */
  batchId?: string;
}

export interface DirectTransfer {
  id: string;
  direction: 'send' | 'receive';
  deviceId: string;
  kind: 'text' | 'file';
  name?: string;
  size: number;
  bytesDone: number;
  /**
   * queued = 目标设备离线,内容留在本机排队(入队时排,设备上线自动投递)。
   * paused = 链路断了、半截字节还留着,等对方重连后续传(窗口见 DIRECT_RESUME_TTL_MS)。
   */
  state: 'queued' | 'offering' | 'transferring' | 'paused' | 'done' | 'canceled' | 'failed';
  error?: string;
}

export interface DirectSnapshot {
  inbox: DirectItem[];
  /**
   * 收件箱里未读条数(全部条目,不受 inbox 100 条截断影响)。
   * 旧后端不发这个字段 → 前端按 0 处理,只是没有未读提醒。
   */
  unread: number;
  pending: DirectPending[];
  transfers: DirectTransfer[];
  /**
   * 本后端是否支持「把多个文件打包成一个 zip 再投送」。
   * 前端据此决定要不要显示那个勾选 —— 与 `direct` 字段本身一样,按后端声明而不是
   * 按 runtime 猜(Rust 与 MoonBit 各自报自己的)。
   */
  zip: boolean;
}

export interface DirectServiceDeps {
  configDir: string;
  /** 状态变更通知(接到 statusHub.notify,Web UI 走既有 WS 推送)。 */
  onChange?: () => void;
  /**
   * 现取一台设备的直发通道(会话重连后由它拿到**新的** transport)。
   * 缺省 = 不做断点续传:掉线即失败、退出即清理半截,与旧行为一致
   * (测试与其它嵌入方不必提供;提供了才落 `inbox/resume.json` 台账)。
   */
  getTransport?: (deviceId: string) => DirectTransport | undefined;
}

/**
 * 一次投送的受理结果:queued=true 表示目标离线、内容进了本机队列,
 * 前端据此提示「已排队」而不是「已发出」。
 */
export interface DirectSendAck {
  id: string;
  queued: boolean;
}

/**
 * 控制 API 看到的服务面:只暴露 HTTP 层需要的操作,不把 transport 注入细节漏出去。
 * transport 由 cli 接线处现取会话(离线 / 旧对端时抛错),服务本身只管协议与落盘。
 */
export interface DirectApi {
  snapshot(): DirectSnapshot;
  content(id: string): Promise<{ item: DirectItem; data: Buffer } | undefined>;
  remove(id: string): Promise<boolean>;
  /** 把所有未读条目标成已读;返回改动的条数。 */
  markInboxRead(): number;
  /** saveDir 给出时,收齐后落到该目录而不是收件箱(调用方已完成提权与路径校验)。 */
  reply(id: string, accept: boolean, reason?: string, saveDir?: string): boolean;
  sendText(deviceId: string, text: string): DirectSendAck;
  /** batchId 把同一次多文件投送的几条提议串起来(缺省 = 各算各的)。 */
  sendFile(deviceId: string, file: { name: string; sourcePath: string; size: number; sha256: string }, batchId?: string): DirectSendAck;
  /** 按组一次性确认/拒绝:返回处理的条数(0 = 该组已不存在)。 */
  replyBatch(batchId: string, accept: boolean, reason?: string, saveDir?: string): number;
  /** 取消一条还在排队的投送(暂存文件一并回收);不是排队态返回 false。 */
  cancelQueued(id: string): boolean;
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
/**
 * 离线排队窗口:设备这么久都没上线就放弃并把暂存文件清掉。
 * 24 小时覆盖「白天发,对方晚上才开机」这类正常场景,又不让半截队列长期占盘。
 */
export const DIRECT_QUEUE_TTL_MS = 24 * 60 * 60 * 1000;
/** 队列条数上限:防止误点「全选」把几十台离线设备的文件都拖进暂存区。 */
export const DIRECT_MAX_QUEUED = 20;
/** 队列文件总量上限(收件箱配额同量级),超出后拒绝新入队。 */
export const DIRECT_QUEUE_MAX_BYTES = 512 * 1024 * 1024;
/** 排队项探测通道的间隔:会话事件与入队可能擦肩而过,定时器兜一层。 */
const DIRECT_QUEUE_PROBE_MS = 5_000;
/**
 * 在线直发文本的重发节奏:控制帧写进 socket 不等于对方收到(半开连接下会静默丢),
 * 5 秒没等到回执就重发,最多 2 次。接收端按消息 id 去重,重发不会落成两条。
 */
const DIRECT_TEXT_RETRY_MS = 5_000;
const DIRECT_TEXT_MAX_RETRIES = 2;

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
  /** 离线排队:入队时间(按它算 24 小时窗口);发出后清空。 */
  queuedAt?: number;
  /** 排队文本的正文。文本没有本地暂存文件,不留在内存/磁盘上就没法补发。 */
  text?: string;
  /** 在线文本已重发次数(等回执期间的兜底重发);排队补发不计入。 */
  textRetries?: number;
  /** 多文件成组投送的组号;提议(含重发/排队补发)都带上,接收方据此合并展示。 */
  batchId?: string;
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
  /** 发送方的多文件组号;同一组的待确认项在 UI 里合并成一张卡。 */
  batchId?: string;
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
  /** 把所有未读条目标成已读(打开收件箱即视为看过);返回改动的条数。 */
  markInboxRead(): number;
  /** 发起文本直发;没有 tx(目标离线)时进队列,等它上线自动投递。 */
  sendText(deviceId: string, text: string, tx?: DirectTransport): DirectSendAck;
  /** 发起文件直发;sourcePath 是已落在**非共享暂存区**的完整文件。没有 tx 时进队列。 */
  sendFile(
    deviceId: string,
    file: { name: string; sourcePath: string; size: number; sha256: string },
    tx?: DirectTransport,
    batchId?: string,
  ): DirectSendAck;
  /** 处理经会话验签归属后的控制消息。 */
  handleControl(message: DirectControlMessage, from: string, tx: DirectTransport): void;
  /** 处理一个直发文件分片帧(会话已解密、已按连接归属)。 */
  handleChunk(frame: { header: Record<string, unknown>; body: Buffer }, from: string, tx: DirectTransport): void;
  /** 接收方确认 / 拒绝一个待确认文件;saveDir 给出时落到用户目录而非收件箱。 */
  reply(id: string, accept: boolean, tx: DirectTransport, reason?: string, saveDir?: string): boolean;
  /** 按 batchId 成组确认:同一次多文件投送的几条提议一起处理,返回条数。 */
  replyBatch(batchId: string, accept: boolean, tx: DirectTransport, reason?: string, saveDir?: string): number;
  /** 连接掉线:在途传输转为暂停(半截字节保留),等重连续传;无续传能力时直接失败。 */
  onPeerOffline(deviceId: string): void;
  /** 新会话建立:把暂停中的投送重新提议一次,并补发离线期间排队的内容(无对应项时是空操作)。 */
  onPeerOnline(deviceId: string, tx: DirectTransport): void;
  /**
   * 设备上来了却发不了(版本过旧 / 已不在互信列表):把为它排队的条目立刻判失败。
   * 不这样做的话,用户要等满 24 小时窗口才收到一句「设备未上线」。
   */
  failQueued(deviceId: string, reason: string): void;
  /** 用户主动取消排队:只对 `queued` 生效,回收暂存文件并从台账里划掉。 */
  cancelQueued(id: string): boolean;
  /**
   * daemon 关闭:停表。具备续传能力时,传了一半的进出站传输转成暂停、半截与暂存
   * 文件留在盘上(下次启动接着传);其余状态照旧清理。
   */
  close(): void;
}

export function createDirectService(deps: DirectServiceDeps): DirectService {
  const root = join(deps.configDir, 'inbox');
  const messagesDir = join(root, 'messages');
  const filesDir = join(root, 'files');
  const tmpDir = join(root, '.tmp');
  const indexPath = join(root, 'index.json');
  /** 离线排队台账:只存还在排队的内容,daemon 重启后照原样恢复。 */
  const queuePath = join(root, 'queue.json');
  /** 跨重启续传台账:只存「传了一半、还能接着传」的进出站条目。 */
  const resumePath = join(root, 'resume.json');
  for (const dir of [root, messagesDir, filesDir, tmpDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  const outgoing = new Map<string, OutgoingTransfer>();
  const incoming = new Map<string, IncomingTransfer>();
  /** 每个投送最近一次使用的 transport,供定时重发用(会话切书时随之更新)。 */
  const lastTx = new Map<string, DirectTransport>();
  /** 群发时多笔投送共用同一份暂存文件:按路径计数,最后一笔结束才删。 */
  const sourceRefs = new Map<string, number>();
  /** 每台设备最近一次探测排队通道的时间(避免每秒都去问一次会话表)。 */
  const queuedProbeAt = new Map<string, number>();
  /**
   * 具备「现取会话通道」的能力 = 这台 daemon 支持续传;续传台账因此才有意义。
   * 嵌入方(测试)不提供时保持旧语义:掉线即失败、退出即清理,不额外落盘。
   */
  const canResume = !!deps.getTransport;
  /** 关闭中:此时不再向状态推送广播(控制端口可能已经收了)。 */
  let closing = false;
  let items: DirectItem[] = readIndex();
  // 上次没来得及投出去的离线队列:恢复成 queued 状态,等会话建立后自动补发。
  loadQueue();
  // 上次退出时还没传完的进出站传输:恢复成 paused,等对方重连/重新提议接着传。
  loadResume();
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

  /** 排队台账的一条记录:只保留重启后还能原样重投的字段。 */
  interface QueuedRecord {
    id: string;
    deviceId: string;
    kind: 'text' | 'file';
    name?: string;
    size: number;
    createdAt: number;
    queuedAt: number;
    text?: string;
    sourcePath?: string;
    sha256?: string;
    batchId?: string;
  }

  function readQueue(): QueuedRecord[] {
    try {
      const parsed = JSON.parse(readFileSync(queuePath, 'utf8')) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((v): v is QueuedRecord => {
        if (typeof v !== 'object' || v === null) return false;
        const q = v as Record<string, unknown>;
        if (!isSafeId(q.id as string) || typeof q.deviceId !== 'string' || typeof q.size !== 'number') return false;
        if (typeof q.createdAt !== 'number' || typeof q.queuedAt !== 'number') return false;
        if (q.kind === 'text') return typeof q.text === 'string' && (q.text as string).length > 0;
        if (q.kind !== 'file') return false;
        return typeof q.sourcePath === 'string' && typeof q.sha256 === 'string';
      });
    } catch {
      return [];
    }
  }

  /**
   * 只把仍在排队的投送写盘(在途/已结束的不需要恢复)。
   * 队列清空时直接删文件,免得留下一个空数组让人误会还有东西在等。
   */
  function saveQueue(): void {
    const queued = [...outgoing.values()].filter((o) => o.state === 'queued' && !o.finishedAt);
    if (!queued.length) {
      try { rmSync(queuePath, { force: true }); } catch { /* 没有就是没有 */ }
      return;
    }
    const records: QueuedRecord[] = queued.map((o) => ({
      id: o.id,
      deviceId: o.deviceId,
      kind: o.kind,
      ...(o.name ? { name: o.name } : {}),
      size: o.size,
      createdAt: o.createdAt,
      queuedAt: o.queuedAt ?? o.createdAt,
      ...(o.kind === 'text' ? { text: o.text ?? '' } : {}),
      ...(o.sourcePath ? { sourcePath: o.sourcePath } : {}),
      ...(o.sha256 ? { sha256: o.sha256 } : {}),
      ...(o.batchId ? { batchId: o.batchId } : {}),
    }));
    const tmp = `${queuePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(records, null, 2), 'utf8');
    renameSync(tmp, queuePath);
  }

  /**
   * 启动时恢复离线队列。暂存文件不见了的条目直接丢(比如被手工清了 .tmp),
   * 不能留一条永远发不出去的记录。
   */
  function loadQueue(): void {
    for (const q of readQueue()) {
      if (q.kind === 'file' && (!q.sourcePath || !existsSync(q.sourcePath))) continue;
      const out: OutgoingTransfer = {
        id: q.id,
        deviceId: q.deviceId,
        kind: q.kind,
        ...(q.name ? { name: q.name } : {}),
        size: q.size,
        bytesDone: 0,
        state: 'queued',
        createdAt: q.createdAt,
        offerSentAt: q.queuedAt,
        queuedAt: q.queuedAt,
        ...(q.text ? { text: q.text } : {}),
        ...(q.sourcePath ? { sourcePath: q.sourcePath } : {}),
        ...(q.sha256 ? { sha256: q.sha256 } : {}),
        ...(q.batchId ? { batchId: q.batchId } : {}),
        ...(q.kind === 'file' ? { totalChunks: Math.ceil(q.size / DIRECT_CHUNK_BYTES) } : {}),
        acked: 0,
        nextSeq: 0,
        inflight: new Map(),
        lastProgressAt: Date.now(),
      };
      outgoing.set(out.id, out);
      if (out.sourcePath) sourceRefs.set(out.sourcePath, (sourceRefs.get(out.sourcePath) ?? 0) + 1);
    }
  }

  /** 跨重启续传台账的一条出站记录:暂存文件与已确认字节都在盘上,重启后接着发。 */
  interface ResumeOutRecord {
    id: string;
    deviceId: string;
    name: string;
    size: number;
    sha256: string;
    sourcePath: string;
    createdAt: number;
    bytesDone: number;
    pausedAt: number;
    batchId?: string;
  }

  /** 跨重启续传台账的一条入站记录:半截文件按 id 命名(`.tmp/in-<id>`),路径不必存。 */
  interface ResumeInRecord {
    id: string;
    from: string;
    name: string;
    size: number;
    sha256: string;
    createdAt: number;
    bytesDone: number;
    pausedAt: number;
    saveDir?: string;
    batchId?: string;
  }

  function readResume(): { outgoing: ResumeOutRecord[]; incoming: ResumeInRecord[] } {
    const empty = { outgoing: [], incoming: [] };
    try {
      const parsed = JSON.parse(readFileSync(resumePath, 'utf8')) as unknown;
      if (typeof parsed !== 'object' || parsed === null) return empty;
      const body = parsed as Record<string, unknown>;
      const outs = Array.isArray(body.outgoing) ? body.outgoing : [];
      const ins = Array.isArray(body.incoming) ? body.incoming : [];
      return {
        outgoing: outs.filter((v): v is ResumeOutRecord => {
          if (typeof v !== 'object' || v === null) return false;
          const r = v as Record<string, unknown>;
          return isSafeId(r.id as string)
            && typeof r.deviceId === 'string'
            && typeof r.name === 'string'
            && typeof r.size === 'number' && r.size > 0
            && typeof r.sha256 === 'string' && /^[a-f0-9]{64}$/.test(r.sha256)
            && typeof r.sourcePath === 'string'
            && typeof r.createdAt === 'number'
            && typeof r.bytesDone === 'number' && r.bytesDone >= 0
            && typeof r.pausedAt === 'number';
        }),
        incoming: ins.filter((v): v is ResumeInRecord => {
          if (typeof v !== 'object' || v === null) return false;
          const r = v as Record<string, unknown>;
          return isSafeId(r.id as string)
            && typeof r.from === 'string'
            && typeof r.name === 'string'
            && typeof r.size === 'number' && r.size > 0
            && typeof r.sha256 === 'string' && /^[a-f0-9]{64}$/.test(r.sha256)
            && typeof r.createdAt === 'number'
            && typeof r.bytesDone === 'number' && r.bytesDone >= 0
            && typeof r.pausedAt === 'number';
        }),
      };
    } catch {
      return empty;
    }
  }

  /**
   * 台账只在「有半截东西能接着传」时存在:没内容就删文件,免得留下一份空账让人误会。
   * 内容全部由内存状态推导 —— 每个改变状态的入口写完就调它,不必在别处维护镜像。
   */
  function saveResume(): void {
    if (!canResume) return;
    const outs: ResumeOutRecord[] = [];
    for (const o of outgoing.values()) {
      if (o.kind !== 'file' || !o.sourcePath || !o.sha256 || !o.name) continue;
      // 传输中也要记:进程被 kill -9 时没有 close() 可走,只能靠这一笔。
      // 发送侧存下的进度是「对端确认过的字节」,真正从哪儿续由接收方说了算。
      if (o.state !== 'transferring' && o.state !== 'paused' && !o.resuming) continue;
      // 排队项走 queue.json:它等的是设备上线,和「传了一半」是两回事。
      if (o.queuedAt) continue;
      outs.push({
        id: o.id,
        deviceId: o.deviceId,
        name: o.name,
        size: o.size,
        sha256: o.sha256,
        sourcePath: o.sourcePath,
        createdAt: o.createdAt,
        bytesDone: o.bytesDone,
        // 传输中崩掉的没有 pausedAt:用「写下这一笔的时刻」当锚点,
        // 续传窗口从「最后一次确认它还活着」算起,而不是从用户点发送算起。
        pausedAt: o.pausedAt ?? Date.now(),
        ...(o.batchId ? { batchId: o.batchId } : {}),
      });
    }
    const ins: ResumeInRecord[] = [];
    for (const inc of incoming.values()) {
      // 待确认的提议不记:它还需要用户点头,重启后重新提议更干净。
      if (inc.state === 'pending') continue;
      ins.push({
        id: inc.id,
        from: inc.from,
        name: inc.name,
        size: inc.size,
        sha256: inc.sha256,
        createdAt: inc.createdAt,
        bytesDone: inc.bytesDone,
        pausedAt: inc.pausedAt ?? Date.now(),
        ...(inc.saveDir ? { saveDir: inc.saveDir } : {}),
        ...(inc.batchId ? { batchId: inc.batchId } : {}),
      });
    }
    if (!outs.length && !ins.length) {
      try { rmSync(resumePath, { force: true }); } catch { /* 没有就是没有 */ }
      return;
    }
    const tmp = `${resumePath}.tmp`;
    writeFileSync(tmp, JSON.stringify({ v: 1, outgoing: outs, incoming: ins }, null, 2), 'utf8');
    renameSync(tmp, resumePath);
  }

  /**
   * 启动时恢复跨重启续传。三种情况直接丢弃(连同它的半截文件):
   *  - 过了续传窗口(10 分钟)—— 半截已经没有意义,还占着收件箱配额;
   *  - 出站的暂存文件 / 入站的半截文件不见了(被手工清过 `.tmp`);
   *  - 入站半截不是整片对齐(落盘永远顺序整片写,对不齐说明文件被别的东西动过)。
   */
  function loadResume(): void {
    if (!canResume) return;
    const now = Date.now();
    const { outgoing: outs, incoming: ins } = readResume();

    /** 出站:先登记存活条目,再统一清理过期条目的暂存文件(群发会共用同一份路径)。 */
    const deadSources: string[] = [];
    for (const r of outs) {
      const fresh = now - r.pausedAt <= DIRECT_RESUME_TTL_MS;
      const usable = fresh && r.bytesDone < r.size && existsSync(r.sourcePath);
      if (!usable) {
        deadSources.push(r.sourcePath);
        continue;
      }
      const acked = Math.floor(r.bytesDone / DIRECT_CHUNK_BYTES);
      const out: OutgoingTransfer = {
        id: r.id,
        deviceId: r.deviceId,
        kind: 'file',
        name: r.name,
        size: r.size,
        bytesDone: r.bytesDone,
        state: 'paused',
        createdAt: r.createdAt,
        // 一启动就允许重发提议:重启本身就是「刚断过线」,没必要再等 3 秒。
        offerSentAt: r.pausedAt,
        resuming: true,
        pausedAt: r.pausedAt,
        sha256: r.sha256,
        sourcePath: r.sourcePath,
        totalChunks: Math.ceil(r.size / DIRECT_CHUNK_BYTES),
        acked,
        nextSeq: acked,
        inflight: new Map(),
        lastProgressAt: now,
        ...(r.batchId ? { batchId: r.batchId } : {}),
      };
      outgoing.set(out.id, out);
      if (out.sourcePath) sourceRefs.set(out.sourcePath, (sourceRefs.get(out.sourcePath) ?? 0) + 1);
    }
    for (const path of deadSources) {
      if (sourceRefs.has(path)) continue; // 还有存活条目在用它(群发暂存共用)
      try { rmSync(path, { force: true }); } catch { /* 已经不在了 */ }
    }

    for (const r of ins) {
      const tmpPath = join(tmpDir, `in-${r.id}`);
      let onDisk = 0;
      let mtime = 0;
      try {
        const st = statSync(tmpPath);
        onDisk = st.size;
        mtime = st.mtimeMs;
      } catch { continue; }
      // 半截文件最后一次被写的时间才是「它还活着」的真实证据:台账里的 pausedAt
      // 对「传到一半被硬杀」的那一笔只到开始时刻,长传输会因此被误判成过期。
      const fresh = now - Math.max(r.pausedAt, mtime) <= DIRECT_RESUME_TTL_MS;
      // 必须是「整片且没满」:满了却没落盘说明崩在校验/rename 之间,重来更省事。
      const resumable = fresh && onDisk > 0 && onDisk % DIRECT_CHUNK_BYTES === 0 && onDisk < r.size;
      if (!resumable) {
        try { rmSync(tmpPath, { force: true }); } catch { /* 已经不在了 */ }
        continue;
      }
      incoming.set(r.id, {
        id: r.id,
        from: r.from,
        name: r.name,
        size: r.size,
        sha256: r.sha256,
        createdAt: r.createdAt,
        tmpPath,
        ...(r.saveDir ? { saveDir: r.saveDir } : {}),
        ...(r.batchId ? { batchId: r.batchId } : {}),
        state: 'paused',
        pausedAt: r.pausedAt,
        nextSeq: onDisk / DIRECT_CHUNK_BYTES,
        totalChunks: Math.ceil(r.size / DIRECT_CHUNK_BYTES),
        bytesDone: onDisk,
        received: new Set(),
        buffered: new Map(),
        lastProgressAt: now,
      });
    }
    // 丢弃过的条目不要留在文件里,否则下次启动又把它们捞出来判一遍。
    saveResume();
  }

  function notify(): void {
    if (closing) return;
    deps.onChange?.();
  }

  function sendControl(tx: DirectTransport, to: string, message: DirectControlMessage): boolean {
    return tx.control(to, message);
  }

  /** 一条 direct-text 控制帧:首发/重发/排队补发共用同一形状与同一 id,接收端据此去重。 */
  function textControl(out: OutgoingTransfer): DirectControlMessage {
    return { kind: 'direct-text', id: out.id, fromDeviceId: '', text: out.text ?? '', createdAt: out.createdAt };
  }

  /** 在线发送没写出去(会话刚断):转为离线排队,等上线由 flushQueued 补发,不静默丢内容。 */
  function requeueText(out: OutgoingTransfer): void {
    out.state = 'queued';
    out.queuedAt = Date.now();
    out.offerSentAt = out.queuedAt;
    out.textRetries = 0;
    saveQueue();
    notify();
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
    out.text = undefined;
    releaseSource(out);
    // 排队项失败/超时也要从台账里划掉,否则重启后又把它捞回来。
    saveQueue();
    saveResume();
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
    out.text = undefined;
    releaseSource(out);
    saveQueue();
    saveResume();
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
    saveResume();
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
      ...(out.batchId ? { batchId: out.batchId } : {}),
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
    saveResume();
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
    // 已经接上了:从台账里撤掉,别让重启后的自己以为它还停在那儿。
    saveResume();
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
    saveResume();
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

  /**
   * 设备上线:把为它排队的文本/文件按入队顺序补发。
   * 控制帧发失败说明会话又断了,该条退回队列(不重置入队时间,24 小时窗口照算)。
   */
  function flushQueued(deviceId: string, tx: DirectTransport): void {
    const now = Date.now();
    const batch = [...outgoing.values()]
      .filter((o) => o.deviceId === deviceId && o.state === 'queued')
      .sort((a, b) => a.createdAt - b.createdAt);
    if (!batch.length) return;
    for (const out of batch) {
      lastTx.set(out.id, tx);
      // 先置状态再发:文本的 result 可能在同一调用栈里就回来(直接判 done),
      // 发完再改状态会把已完成覆盖回 offering。
      out.state = 'offering';
      out.offerSentAt = now;
      // 正文留在 out 上直到回执:等回执的超时重发要靠它,不然补发只能发一条空文本。
      const sent = out.kind === 'text'
        ? sendControl(tx, deviceId, textControl(out))
        : sendControl(tx, deviceId, offerMessage(out));
      if (!sent) {
        // 控制帧没出去:退回队列(queuedAt 原样保留,24 小时窗口照算)。
        out.state = 'queued';
      }
    }
    saveQueue();
    notify();
  }

  /** 新入队前的头寸检查:条数与总字节数都要留余量,别把暂存区当仓库用。 */
  function checkQueueRoom(extraBytes: number): void {
    const queued = [...outgoing.values()].filter((o) => o.state === 'queued');
    if (queued.length >= DIRECT_MAX_QUEUED) {
      throw new Error(`离线排队已满(${DIRECT_MAX_QUEUED} 条),请等设备上线或先取消一些`);
    }
    const bytes = queued.reduce((sum, o) => sum + (o.kind === 'file' ? o.size : 0), 0);
    if (bytes + extraBytes > DIRECT_QUEUE_MAX_BYTES) {
      throw new Error('离线排队的文件总量已满(512 MB),请等设备上线或先取消一些');
    }
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

  /** id 取发送方的消息 id:重发是同一个 id,落盘前按它去重,才不会存成两条。 */
  function addTextItem(from: string, text: string, id = directId('dt')): void {
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
      unread: true,
    };
    items.unshift(item);
    saveIndex();
  }

  function newOutgoing(
    partial: Omit<OutgoingTransfer, 'bytesDone' | 'state' | 'createdAt' | 'offerSentAt' | 'acked' | 'nextSeq' | 'inflight' | 'lastProgressAt'>,
    queued = false,
  ): OutgoingTransfer {
    const now = Date.now();
    const out: OutgoingTransfer = {
      ...partial,
      bytesDone: 0,
      state: queued ? 'queued' : 'offering',
      createdAt: now,
      offerSentAt: now,
      ...(queued ? { queuedAt: now } : {}),
      acked: 0,
      nextSeq: 0,
      inflight: new Map(),
      lastProgressAt: now,
    };
    outgoing.set(out.id, out);
    if (out.sourcePath) {
      sourceRefs.set(out.sourcePath, (sourceRefs.get(out.sourcePath) ?? 0) + 1);
    }
    // 只保留最近若干条,免得状态快照无限增长。排队项不能被顺手挤掉 ——
    // 那是用户明确交代要等设备上线的东西,只有它自己的超时/取消才算数。
    if (outgoing.size > 30) {
      const oldestEvictable = [...outgoing.values()]
        .filter((o) => o.state !== 'queued')
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      if (oldestEvictable) {
        releaseSource(oldestEvictable);
        outgoing.delete(oldestEvictable.id);
      }
    }
    if (queued) saveQueue();
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
      if (out.kind === 'text' && !out.resuming && out.state === 'offering'
        && now - out.offerSentAt >= DIRECT_TEXT_RETRY_MS
        && (out.textRetries ?? 0) < DIRECT_TEXT_MAX_RETRIES) {
        // 帧写进 socket 不等于对方收到(半开连接会静默丢):没回执就重发同一 id。
        const tx = deps.getTransport?.(out.deviceId) ?? lastTx.get(out.id);
        if (!tx) {
          // 对端已经掉线:转成离线排队,上线后由 flushQueued 补发。
          requeueText(out);
          continue;
        }
        out.textRetries = (out.textRetries ?? 0) + 1;
        out.offerSentAt = now;
        lastTx.set(out.id, tx);
        // 重发也写不出去 = 会话肯定是死的,别再等 120 秒判超时,直接转排队等重连。
        if (!sendControl(tx, out.deviceId, textControl(out))) requeueText(out);
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
    // 排队项:超窗口就放弃;否则定期探一次现取通道,兜住「会话建立早于入队」的竞态。
    for (const out of [...outgoing.values()]) {
      if (out.state !== 'queued') continue;
      if (now - (out.queuedAt ?? out.createdAt) > DIRECT_QUEUE_TTL_MS) {
        cancelOutgoing(out, '设备 24 小时内未上线,已取消发送');
        continue;
      }
      if (now - (queuedProbeAt.get(out.deviceId) ?? 0) < DIRECT_QUEUE_PROBE_MS) continue;
      queuedProbeAt.set(out.deviceId, now);
      const tx = deps.getTransport?.(out.deviceId);
      if (tx) flushQueued(out.deviceId, tx);
    }
  }, 1000);
  timer.unref();

  /** 单条待确认项的确认/拒绝。批量入口也走这里 —— 两条路径分叉过一次就很难对齐。 */
  function replyOne(inc: IncomingTransfer, accept: boolean, tx: DirectTransport, reason?: string, saveDir?: string): boolean {
    if (inc.state !== 'pending') return false;
    if (!accept) {
      tx.control(inc.from, { kind: 'direct-reply', id: inc.id, fromDeviceId: '', accept: false, reason: reason ?? '对方拒绝了接收' });
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
      tx.control(inc.from, { kind: 'direct-result', id: inc.id, fromDeviceId: '', ok: false, error: `创建临时文件失败:${err instanceof Error ? err.message : String(err)}` });
      cleanupIncoming(inc);
      notify();
      return true;
    }
    saveResume();
    tx.control(inc.from, { kind: 'direct-reply', id: inc.id, fromDeviceId: '', accept: true });
    notify();
    return true;
  }

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
        unread: items.reduce((n, i) => n + (i.unread ? 1 : 0), 0),
        pending: [...incoming.values()]
          .filter((i) => i.state === 'pending')
          .map((i) => ({
            id: i.id,
            from: i.from,
            name: i.name,
            size: i.size,
            sha256: i.sha256,
            createdAt: i.createdAt,
            ...(i.batchId ? { batchId: i.batchId } : {}),
          })),
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
        // 能力声明:Node 后端有 zip 打包(ADR-0028 第 16 条)。
        zip: true,
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

    markInboxRead() {
      let changed = 0;
      for (const item of items) {
        if (!item.unread) continue;
        delete item.unread;
        changed++;
      }
      if (changed) {
        saveIndex();
        notify();
      }
      return changed;
    },

    sendText(deviceId, text, tx) {
      const len = Buffer.byteLength(text, 'utf8');
      if (len === 0 || len > DIRECT_MAX_TEXT_BYTES) {
        throw new Error(`文本长度必须在 1 ~ ${DIRECT_MAX_TEXT_BYTES} 字节之间`);
      }
      // 没有会话 = 设备离线:存进队列,等它上线后由 flushQueued 补发。
      if (!tx) checkQueueRoom(0);
      const out = newOutgoing({ id: directId('dt'), deviceId, kind: 'text', size: len, text }, !tx);
      if (!tx) return { id: out.id, queued: true };
      lastTx.set(out.id, tx);
      if (!sendControl(tx, deviceId, textControl(out))) {
        // 帧没写出去:不报「已发出」,转成排队让设备上线后自动补发。
        requeueText(out);
        return { id: out.id, queued: true };
      }
      return { id: out.id, queued: false };
    },

    sendFile(deviceId, file, tx, batchId) {
      if (file.size <= 0 || file.size > DIRECT_MAX_FILE_BYTES) {
        throw new Error(`文件大小必须在 1 ~ ${DIRECT_MAX_FILE_BYTES} 字节之间`);
      }
      if (!/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('文件指纹格式不正确');
      if (!tx) checkQueueRoom(file.size);
      const out = newOutgoing({
        id: directId('df'),
        deviceId,
        kind: 'file',
        name: safeFileName(file.name),
        size: file.size,
        sourcePath: file.sourcePath,
        sha256: file.sha256,
        totalChunks: Math.ceil(file.size / DIRECT_CHUNK_BYTES),
        ...(batchId && isSafeId(batchId) ? { batchId } : {}),
      }, !tx);
      if (!tx) return { id: out.id, queued: true };
      lastTx.set(out.id, tx);
      sendControl(tx, deviceId, offerMessage(out));
      return { id: out.id, queued: false };
    },

    handleControl(message, from, tx) {
      switch (message.kind) {
        case 'direct-text': {
          const len = Buffer.byteLength(message.text ?? '', 'utf8');
          if (!isSafeId(message.id) || len === 0 || len > DIRECT_MAX_TEXT_BYTES) return;
          // 发送方等不到回执会重发同一条:已经落过盘就只补回执,不能存成两份。
          if (items.some((i) => i.id === message.id)) {
            tx.control(from, { kind: 'direct-result', id: message.id, fromDeviceId: '', ok: true });
            return;
          }
          if (outgoing.has(message.id) || incoming.has(message.id)) return;
          addTextItem(from, message.text, message.id);
          tx.control(from, { kind: 'direct-result', id: message.id, fromDeviceId: '', ok: true });
          // 文本没有后续帧:不在这里推一次状态,对端 UI 的未读角标与到件提示只能等下一轮别的推送。
          notify();
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
          const batchId = typeof message.batchId === 'string' && isSafeId(message.batchId) ? message.batchId : undefined;
          incoming.set(message.id, {
            id: message.id,
            from,
            name: safeFileName(message.name ?? ''),
            size: message.size,
            sha256: message.sha256,
            createdAt: message.createdAt || Date.now(),
            ...(batchId ? { batchId } : {}),
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
          saveResume();
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
      if (!inc) return false;
      return replyOne(inc, accept, tx, reason, saveDir);
    },

    replyBatch(batchId, accept, tx, reason, saveDir) {
      if (!isSafeId(batchId)) return 0;
      // 一组只属于一个发送方(组号由发送端每次发送生成)。显式按 from 收紧:
      // 万一两个对端撞了组号,也只处理当前会话这台设备的,不会把 accept 发给别人。
      const first = [...incoming.values()].find((i) => i.batchId === batchId && i.state === 'pending');
      if (!first) return 0;
      // 按到达顺序处理:虽然传输会并行,拒绝/接受的先后仍与发送方的选择顺序一致。
      const group = [...incoming.values()]
        .filter((i) => i.batchId === batchId && i.state === 'pending' && i.from === first.from)
        .sort((a, b) => a.createdAt - b.createdAt);
      let handled = 0;
      for (const inc of group) {
        if (replyOne(inc, accept, tx, reason, saveDir)) handled++;
      }
      return handled;
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
        // 排队项本来就在等设备上线,链路断不断都与它无关,继续排着。
        if (out.state === 'queued') continue;
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
      // 先补发离线期间排下的内容,再处理掉线续传 —— 两者的 id 不会重叠,顺序只为可读。
      flushQueued(deviceId, tx);
      reofferPaused(deviceId, tx);
    },

    failQueued(deviceId, reason) {
      for (const out of [...outgoing.values()]) {
        if (out.deviceId === deviceId && out.state === 'queued') cancelOutgoing(out, reason);
      }
    },

    cancelQueued(id) {
      const out = outgoing.get(id);
      if (!out || out.state !== 'queued') return false;
      // 用户主动取消不是「失败」:单独一个终态,UI 才不会把它染成红色错误。
      if (out.fd !== undefined) {
        try { closeSync(out.fd); } catch { /* 已关闭 */ }
        out.fd = undefined;
      }
      out.state = 'canceled';
      out.error = undefined;
      out.finishedAt = Date.now();
      releaseSource(out);
      saveQueue();
      notify();
      return true;
    },

    close() {
      closing = true;
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      for (const inc of [...incoming.values()]) {
        // 传了一半的入站传输:转暂停、把半截留在盘上,下次启动接着收 —— 重启一次
        // 不该让几十 MB 白传。一个字节都还没写的提议没有续传价值,照旧清掉。
        if (canResume && inc.bytesDone > 0 && (inc.state === 'transferring' || inc.state === 'paused')) {
          pauseIncoming(inc);
          continue;
        }
        cleanupIncoming(inc);
      }
      for (const out of outgoing.values()) {
        if (out.fd !== undefined) {
          try { closeSync(out.fd); } catch { /* 已关闭 */ }
        }
        // 排队项要跨重启:暂存文件与 queue.json 都得原样留着,下次启动接着等。
        if (out.state === 'queued') continue;
        // 出站同理:传了一半(或已经在等重连)的保留暂存文件,重启后重新提议,
        // 从对方给的偏移继续。终态照旧回收。
        if (canResume && out.kind === 'file' && !out.finishedAt && (out.state === 'transferring' || out.resuming)) {
          pauseOutgoing(out);
          continue;
        }
        releaseSource(out);
      }
      saveResume();
      sourceRefs.clear();
      lastTx.clear();
      queuedProbeAt.clear();
    },
  };
}
