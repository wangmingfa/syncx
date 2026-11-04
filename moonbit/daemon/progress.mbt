///|
/// status 数据面的同步进度(syncProgress):供侧追踪、速率采样与聚合。
/// 对应 Node `src/peer.ts` 的 getSyncProgress / recordBytes / bytesPerSecond
/// 与 `src/session-manager.ts` 的 getSyncProgress 聚合。
///
/// 分工:
///  - **供侧租约**(ServeLease):「发送中」的判据 —— 对端每拉走一个块就给该
///    路径续一次期,超过 SERVE_LEASE_MS 没有新块即视为传完。用租约而不是
///    「本轮计划推送条数」这种计数器,是因为计数器没有衰减路径:它只在下一次
///    收到对端索引时才被重算,于是卡片会永远停在「传输中 · 发送 N」(2026-09-16
///    两端卡片转圈不停的事故形态之一)。租约天然自愈,过期在聚合时懒清理。
///  - **速率采样**(RatePoint):每块「真正发出 / 真正收下」记一笔(t + 字节数),
///    读取时按滚动窗口平均。本地预填的块不记 —— 那是磁盘读,不是网络传输。
///  - **聚合**(aggregate_sync_progress):收侧从 pending/store 读,供侧从
///    租约读;计数口径是**文件数**而不是块数。
///
/// 收侧追踪不在此文件:在途接收本就是 PeerSession.pending + PartialStore
/// (store.received_bytes 已记账),聚合直接读。

///|
/// 速率采样窗口(毫秒):瞬时速率 = 最近这段时间内实测字节的平均值。与
/// actor 周期泵(500ms)及兜底状态推送周期同阶,保证每次快照都能看到窗口内
/// 的新鲜数据(Node RATE_WINDOW_MS 同值)。
const RATE_WINDOW_MS : Int64 = 5000L

///|
/// 窗口时间跨度的下限(毫秒):刚开传的第一帧,分母若取真实跨度(可能只有几
/// 毫秒)会冒出离谱的瞬时峰值;按至少 1s 平滑(Node RATE_SPAN_FLOOR_MS 同值)。
const RATE_SPAN_FLOOR_MS : Int64 = 1000L

///|
/// 一笔速率采样:「真正发出/真正收下」一块时记(t + 两方向字节数)。
priv struct RatePoint {
  t : Int64
  sent : Int64
  recv : Int64
}

///|
/// 供块租约(路径 → 租约)。对应 Node 的 serving / servingBytes / servedBlocks
/// 三张表合一:last_ms 是租约本体,done/total 是文件级发送进度,served 记录
/// 已供块下标 —— 对端重试同一块时不重复计入(否则进度会虚高)。
priv struct ServeLease {
  /// 最近一次供块时刻(毫秒;每供一块续一次期)。
  mut last_ms : Int64
  /// 按块精确累计的已供字节。
  mut done : Int64
  /// 文件总字节(取本机索引 size;缺 0)。
  mut total : Int64
  /// 已供块下标集合(定长与 CDC 槽位共用;重试去重)。
  served : Map[Int64, Unit]
}

///|
/// 文件级传输进度行(前端 TransferFile;字段名与形态逐字对齐 web/types.ts)。
pub(all) struct TransferFileInfo {
  path : String
  /// "receive" = 本机正从对端拉取;"send" = 本机正供块给对端。
  direction : String
  /// 已传字节数(估算,最后一块可能偏小)。
  bytes_done : Int64
  /// 文件总字节数。
  bytes_total : Int64
  /// 已被「优先同步」点名插队(仅接收方向)。MoonBit 尚未移植点名,恒 false
  /// —— JSON 侧只在 true 时上线该字段,对齐 Node 的可选缺省。
  priority : Bool
}

///|
/// 单目录单会话的同步进度(前端 SyncProgressItem;对应 Node ProgressCounts
/// 加 folder 键)。可选字段(速率 / files)在无值时整个省略 —— 空闲快照保持
/// 最小,差异驱动的 ws 推送不会多推帧。
pub(all) struct SyncProgress {
  folder : String
  /// 在途接收项总数。
  pending : Int
  /// 租约内正被对端拉块的**文件数**(不是块数:一个文件可能被请求几十个块,
  /// 但对用户而言那是「1 个文件在传」)。
  sending : Int
  /// 在途接收项里接收方向的个数(MoonBit 的在途台账全是接收,与 pending 相等;
  /// Node 的 pending 还能挂别的 kind,故两处分开计数)。
  receiving : Int
  /// 瞬时发送速率(字节/秒,滚动窗口平均);None = 窗口内没有发送字节。
  send_rate : Double?
  /// 瞬时接收速率(字节/秒);None = 窗口内没有接收字节。
  receive_rate : Double?
  /// 文件级进度,每个正在传输的文件一条;None = 无传输,快照不凭空变大。
  files : Array[TransferFileInfo]?
}

///|
/// 记一笔速率采样并顺手剪掉窗口外的旧点(读写两处都先剪,窗口长度有界)。
fn record_rate(
  session : PeerSession,
  sent : Int64,
  recv : Int64,
  now : Int64,
) -> Unit {
  session.rate_samples.push({ t: now, sent, recv })
  while session.rate_samples.length() > 0 &&
        now - session.rate_samples[0].t > RATE_WINDOW_MS {
    let _ = session.rate_samples.remove(0)
  }
}

///|
/// 窗口内的平均速率(字节/秒,Math.round 口径);窗口里没有该方向的字节时
/// 返回 0(聚合据此省略字段,空闲快照保持与旧版同形)。
fn rate_bytes_per_second(
  session : PeerSession,
  is_send : Bool,
  now : Int64,
) -> Double {
  while session.rate_samples.length() > 0 &&
        now - session.rate_samples[0].t > RATE_WINDOW_MS {
    let _ = session.rate_samples.remove(0)
  }
  if session.rate_samples.length() == 0 {
    return 0.0
  }
  let mut sum = 0L
  for point in session.rate_samples {
    sum += if is_send { point.sent } else { point.recv }
  }
  let span = now - session.rate_samples[0].t
  let span_ms : Int64 = if span < RATE_SPAN_FLOOR_MS {
    RATE_SPAN_FLOOR_MS
  } else {
    span
  }
  // Math.round:正数域 floor(x + 0.5) 与 Node 同值
  (sum.to_double() / (span_ms.to_double() / 1000.0) + 0.5).floor()
}

///|
/// 供块记账:该路径进「发送中」并续租约;文件级已供字节按块去重累计。
/// total 取本机索引 size,缺 0 时保留旧值(对齐 Node `rec.total = total || rec.total`)。
fn mark_served(
  session : PeerSession,
  path : String,
  slot : Int64,
  plain_len : Int64,
  total : Int64,
  now : Int64,
) -> Unit {
  let lease = match session.serving.get(path) {
    Some(l) => l
    None => {
      let fresh : ServeLease = { last_ms: 0L, done: 0L, total: 0L, served: Map([]) }
      session.serving.set(path, fresh)
      fresh
    }
  }
  lease.last_ms = now
  if !lease.served.contains(slot) {
    lease.served.set(slot, ())
    lease.done += plain_len
    if total > 0L {
      lease.total = total
    }
  }
}

///|
/// 单目录单会话的进度聚合(对齐 Node SyncPeer.getSyncProgress):
///   - pending = 在途接收项总数;接收行的 bytesDone 问句柄 —— 本地预填与
///     断点续传接上的旧进度同样计入,因为它们都是真的落在了 tmp 里;
///   - sending = 租约内的供块文件数,过期租约就地清理(连同字节账,对齐
///     Node 在 getSyncProgress 里的懒清理);
///   - 速率按需携带:窗口内没有该方向的字节时字段省略。
/// 上层(publish)按「三项全零即丢弃」过滤,仅非零项进状态。
fn aggregate_sync_progress(
  folder : String,
  session : PeerSession,
  now : Int64,
) -> SyncProgress {
  let files : Array[TransferFileInfo] = []
  for path, pending in session.pending {
    files.push({
      path,
      direction: "receive",
      bytes_done: pending.store.received_bytes(),
      bytes_total: pending.entry.size,
      priority: false,
    })
  }
  let receiving = session.pending.length()
  let mut sending = 0
  let stale : Array[String] = []
  for path, lease in session.serving {
    if now - lease.last_ms > SERVE_LEASE_MS {
      stale.push(path)
      continue
    }
    sending += 1
    files.push({
      path,
      direction: "send",
      bytes_done: lease.done,
      bytes_total: lease.total,
      priority: false,
    })
  }
  for path in stale {
    let _ = session.serving.remove(path)
  }
  let send_rate = rate_bytes_per_second(session, true, now)
  let receive_rate = rate_bytes_per_second(session, false, now)
  {
    folder,
    pending: receiving,
    sending,
    receiving,
    send_rate: if send_rate > 0.0 { Some(send_rate) } else { None },
    receive_rate: if receive_rate > 0.0 { Some(receive_rate) } else { None },
    files: if files.length() > 0 { Some(files) } else { None },
  }
}
