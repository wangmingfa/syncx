import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { IndexEntry } from '../index.js';
import type { BlockRequest, BlockResponse } from '../messages.js';
import { encodeIndex, decodeIndex } from '../messages.js';
import type { PeerTransport, SyncPeer, IndexMode } from '../peer.js';
import { RateLimiter } from '../ratelimit.js';
import type { ProgressCounts } from '../status.js';

export type WireMessage =
  /**
   * 索引消息。`full` 声明这条消息的语义:true = 本机索引的完整快照,
   * false/缺省 = 仅包含本轮改动的那几条。
   * 旧版对端不发该字段,而它**确实**会发增量索引,所以缺省必须按增量处理
   * (见 peer.ts 的 IndexMode):当成全量会为「它没提到的本地条目」回推,
   * 两端互为回声、无限循环。旧版对端收到我们多出的字段会直接忽略,不受影响。
   */
  | { type: 'index'; folder: string; payload: string; full?: boolean; relayed?: boolean }
  | { type: 'block-request'; folder: string; payload: BlockRequest }
  | { type: 'block-response'; folder: string; payload: Omit<BlockResponse, 'data'> & { data: string } }
  | { type: 'control'; payload: ControlMessage };

/**
 * 与同步数据无关的「控制面」消息:设备配对请求 与 目录共享邀请,
 * 以及对方的确认回执。它们不绑定某个共享目录,故走独立的 control 通道,
 * 由接收方路由到一个全局处理器(而非按 folder 找 SyncPeer)。
 */
export type ControlMessage =
  | { kind: 'folder-invitation'; offerId: string; fromDeviceId: string; folderId: string; folderName: string; version?: string; hostname?: string; platform?: string }
  | { kind: 'folder-invitation-ack'; offerId: string; fromDeviceId: string; accepted: boolean; version?: string; hostname?: string; platform?: string }
  | { kind: 'pairing-request'; offerId: string; fromDeviceId: string; version?: string; hostname?: string; platform?: string }
  | { kind: 'pairing-ack'; offerId: string; fromDeviceId: string; accepted: boolean; version?: string; hostname?: string; platform?: string }
  /** 会话建立与共享关系变更时互发的「本机当前与你在同步的目录清单」,
   *  接收方据此在 UI 上区分设备标签的 同步中 / 已停止共享 状态。
   *  pendingFolderIds:本机仍待确认的、来自对方的目录邀请 id 集合,
   *  对方据此把标签显示为「待对方确认」而非误判「已停止共享」。
   *  旧版本对端不发送该字段(undefined),接收方按未知处理,退回旧逻辑。 */
  | { kind: 'folder-sync-list'; fromDeviceId: string; folderIds: string[]; pendingFolderIds?: string[]; version?: string; hostname?: string; platform?: string }
  /** 会话建立时互发的版本宣告。dev 态(src 直跑)version 为 'dev'。
   *  hostname 为本机 node:os 主机名,供对端在设备卡 / 配对 / 共享邀请上展示来源主机,
   *  旧版本对端不发送该字段,接收方按 undefined 处理(不展示主机名)。
   *  platform 为本机 process.platform,供对端设备卡 / 顶栏画操作系统图标;与 hostname
   *  同一套兼容口径 —— 旧版本对端不发,接收方按 undefined 处理(退回字母头像)。 */
  | { kind: 'hello'; fromDeviceId: string; version: string; hostname?: string; platform?: string }
  /** 请求对端的自身安装包(tgz,整包),用于「版本低于对方时从对方升级」。
   *  仅经握手签名校验过的会话可发;对端 dev 态时 response.data 为 undefined。 */
  | { kind: 'self-binary-request'; requestId: string; fromDeviceId: string; version?: string; hostname?: string; platform?: string }
  /** 对端安装包回传:base64 的整包 tgz(含 package.json 与 dist/syncx.js)+ 内容
   *  sha256 指纹;data 缺省 = 对端无法提供(dev 态或打包失败)。 */
  | { kind: 'self-binary-response'; requestId: string; fromDeviceId: string; version: string; sha256: string; data?: string; hostname?: string; platform?: string }
  /**
   * 内容对比:请求对端把它某个共享目录的索引快照发过来。**全程只读** ——
   * 不改动任何一端的状态、不触发索引交换。刻意不走「强制重连拿全量索引」那条路:
   * 诊断工具不该扰动被观察的系统,否则用户看到的可能是自己造成的现象。
   * requestId 用于把分片的响应拼回同一次请求(并发多次对比互不干扰)。
   */
  | { kind: 'folder-index-request'; requestId: string; fromDeviceId: string; folderId: string; version?: string; hostname?: string; platform?: string }
  /**
   * 索引快照分片:seq 从 0 开始,total 为总片数。ignoreLines 与 progress 每片都带
   * (体量远小于条目本身,冗余一点换「不依赖首片必达」的简单性)。
   *
   * error 非空表示对端无法提供(未共享给本机、目录不存在等),此时 entries 缺省。
   * progress 让报告能提示「对端正在收 3 个文件,本报告可能含传输中的中间态」——
   * 传输中的文件在索引里已是新版本、盘上却是旧内容,不标注会误导排查方向。
   */
  | { kind: 'folder-index-snapshot'; requestId: string; fromDeviceId: string; folderId: string; seq: number; total: number; entries?: string; error?: string; ignoreLines?: string[]; progress?: ProgressCounts; version?: string; hostname?: string; platform?: string }
  /**
   * 双栏对比页:向对端索取它某个共享目录里**单个文件的内容**(只读)。
   *
   * 与 folder-index-request 一样走「按需索取」,并复用同一道共享关系闸门(见
   * servePeerFile):目录没把对方列进 devices 就一个字节都不给 —— 否则这条通道
   * 会变成绕过共享关系的任意文件读取入口。
   */
  | { kind: 'file-content-request'; requestId: string; fromDeviceId: string; folderId: string; path: string; version?: string; hostname?: string; platform?: string }
  /**
   * 文件内容回传。data 为 base64;error 非空表示对端无法提供(未共享 / 不存在 /
   * 不是文件 / 超过体积上限),此时 data 缺省。
   * entryVersion 是对端该条目的**版本向量** —— 字段名刻意避开 version:控制消息里的
   * version 是「syncx 运行版本」(withSelfInfo 每条都注入),两者混用会让读代码的人
   * 把版本向量当成软件版本号。
   */
  | { kind: 'file-content-response'; requestId: string; fromDeviceId: string; folderId: string; path: string; data?: string; size?: number; entryVersion?: Array<[string, number]>; error?: string; version?: string; hostname?: string; platform?: string }
  /**
   * 双栏对比页的「把本机内容推到对端」:请对端按给定内容落盘,并**采纳给定版本**。
   *
   * 采纳外部给定的版本(而不是让对端自增自己的计数器再扫描发现)是为了让两端的
   * 版本向量可控地对齐:否则对端下一轮扫描会把刚写入的内容判成「本机新编辑」再推回来,
   * 而这一侧又会把它当成远端更新拉一次 —— 一次点击变成两轮无意义传输。
   */
  | { kind: 'file-content-write'; requestId: string; fromDeviceId: string; folderId: string; path: string; data: string; entryVersion: Array<[string, number]>; version?: string; hostname?: string; platform?: string }
  | { kind: 'file-content-write-result'; requestId: string; fromDeviceId: string; folderId: string; path: string; ok: boolean; error?: string; version?: string; hostname?: string; platform?: string }
  /**
   * Git 提交同步:本机在某共享目录检测到新提交,通知对端也执行自动提交。
   * 接收方按 folderId 找到本地目录,执行 git add -A && git commit,使用相同的提交消息。
   * commitHash 用于去重(避免同一提交被多次处理);changedFiles 与 diffStat 仅用于日志展示。
   * 旧版本对端不识别该 kind,直接忽略,不影响既有功能。
   */
  | { kind: 'git-commit-notify'; fromDeviceId: string; folderId: string; commitHash: string; commitMessage: string; changedFiles: string[]; diffStat?: string; parentHash: string; version?: string; hostname?: string; platform?: string };

export function encodeWireMessage(message: WireMessage): string {
  return JSON.stringify(message);
}

export function decodeWireMessage(raw: string): WireMessage {
  return JSON.parse(raw) as WireMessage;
}

/** AES-256-GCM 加密一条消息,输出携带 iv/tag 的 JSON 字符串。 */
export function encryptMessage(key: Buffer, message: WireMessage): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(encodeWireMessage(message), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    type: 'enc',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: enc.toString('base64'),
  });
}

export function decryptMessage(key: Buffer, raw: string): WireMessage {
  const msg = JSON.parse(raw) as { type: string; iv: string; tag: string; data: string };
  if (msg.type !== 'enc') {
    throw new Error('expected encrypted message');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(msg.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(msg.tag, 'base64'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(msg.data, 'base64')),
    decipher.final(),
  ]);
  return decodeWireMessage(plain.toString('utf8'));
}

/**
 * Send-side transport bound to one shared folder: every message carries
 * the folder path so a single socket can multiplex several folders.
 */
export function makePeerTransport(
  socket: WebSocket,
  key: Buffer,
  folderPath: string,
  rateLimiter?: RateLimiter,
): PeerTransport {
  const limiter = rateLimiter ?? new RateLimiter(0);
  // 限速发送队列(数组):令牌等待天然串行 —— 每条消息都在轮到自己时重新评估
  // 等待,不会基于同一令牌快照同时醒来造成约 2 倍速率的突发发送。
  // 「优先同步」的块响应插到队首(见 enqueue 的 priority),让被大队列卡住的
  // 小文件越过普通消息先走;限速语义不变(插队不省令牌,只换个位置等)。
  const outbox: Array<{ data: string; priority: boolean }> = [];
  let draining = false;

  async function drainOutbox(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (outbox.length > 0) {
        const item = outbox.shift()!;
        const bytes = Buffer.byteLength(item.data);
        const wait = limiter.waitTime(bytes);
        if (wait > 0) {
          await new Promise((resolve) => setTimeout(resolve, wait));
        }
        // 等待后重新评估并消耗令牌;超大消息(超过桶容量)无法一次消耗,
        // 清空桶后照常发送,避免其完全绕过限速。
        if (!limiter.tryConsume(bytes)) {
          limiter.drain();
        }
        socket.send(item.data);
      }
    } finally {
      draining = false;
    }
  }

  /** 按限速发送一条消息:入队(priority = true 插队到队首)并由 drain 循环串行发出。 */
  function sendRateLimited(data: string, priority = false): void {
    if (priority) {
      outbox.unshift({ data, priority: true });
    } else {
      outbox.push({ data, priority: false });
    }
    void drainOutbox();
  }

  return {
    sendEntries(entries: IndexEntry[], mode: IndexMode, opts?: { relayed?: boolean }): void {
      sendRateLimited(
        encryptMessage(key, {
          type: 'index',
          folder: folderPath,
          payload: encodeIndex(entries).toString('base64'),
          full: mode === 'full',
          relayed: opts?.relayed === true,
        }),
      );
    },
    sendBlockRequest(request: BlockRequest): void {
      sendRateLimited(encryptMessage(key, { type: 'block-request', folder: folderPath, payload: request }));
    },
    sendBlockResponse(response: BlockResponse, opts?: { priority?: boolean }): void {
      // 响应上线前不带 priority:它只是本端排队决策(源块请求的标记),对端无需感知
      const { priority: _drop, ...payload } = response as BlockResponse & { priority?: boolean };
      sendRateLimited(
        encryptMessage(key, {
          type: 'block-response',
          folder: folderPath,
          payload: { ...payload, data: response.data.toString('base64') },
        }),
        opts?.priority === true,
      );
    },
  };
}

/** 经已建立的会话密钥,发送一条 control 控制面消息(不绑定任何目录)。 */
export function sendControlMessage(socket: WebSocket, key: Buffer, message: ControlMessage): void {
  socket.send(encryptMessage(key, { type: 'control', payload: message }));
}

/**
 * Receive-side dispatcher: decrypts incoming wire messages and routes each
 * message to the SyncPeer registered for its folder. `control` 类型的消息
 * (配对请求 / 目录共享邀请 / 确认回执)路由到 onControl,不经过 folder 路由。
 *
 * `takePending`(可选,客户端连接侧用):握手完成到本函数挂载分发器之间有微任务
 * 间隙,服务端常在 kx 应答的同一 tick 里连发 hello/invitation/list,这些帧若无人
 * 监听会被 EventEmitter 静默丢弃 —— 偶发「收不到目录邀请」的根因。connectPeer 在
 * 握手完成瞬间转入缓冲模式暂存这些帧(见其 takePendingFrames 注释),这里先注册
 * 实时监听、再同步回放缓冲帧:缓冲帧只可能在注册实时监听前 emit 完,两路不重叠
 * 不漏发,且回放保序(缓冲的帧都更早到达)。服务端入站侧同步完成挂载,无此窗口,
 * 不传该参数。
 */
export function attachPeerMessages(
  peers: Map<string, SyncPeer>,
  socket: WebSocket,
  key: Buffer,
  onControl?: (message: ControlMessage) => void,
  takePending?: () => Buffer[],
): void {
  const dispatch = (data: Buffer): void => {
    const raw = data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data as Buffer);
    let message: WireMessage;
    try {
      message = decryptMessage(key, raw.toString('utf8'));
    } catch {
      return; // 解密/认证失败(篡改或噪声),忽略
    }
    if (message.type === 'control') {
      onControl?.(message.payload);
      return;
    }
    const peer = peers.get(message.folder);
    if (!peer) return;
    switch (message.type) {
      case 'index':
        // 缺省(旧对端不发该字段)按增量处理,理由见 WireMessage 上 index 的注释
        void peer.onPeerIndex(decodeIndex(Buffer.from(message.payload, 'base64')), {
          full: message.full === true,
          relayed: message.relayed === true,
        });
        break;
      case 'block-request':
        peer.onBlockRequest(message.payload);
        break;
      case 'block-response':
        void peer.onBlockResponse({
          ...message.payload,
          data: Buffer.from(message.payload.data, 'base64'),
        });
        break;
    }
  };
  socket.on('message', dispatch);
  if (takePending) {
    for (const frame of takePending()) dispatch(frame);
  }
}
