///|
/// 设备间直发(ADR-0028)的 MoonBit 移植 —— 把一段文本 / 一个文件投到**在线**
/// 对端的收件箱。语义与 Node `src/direct.ts`、Rust `control/direct.rs` 同一口径:
///
///  - 这一层不认识 socket:跨设备只经注入的 `DirectTransport`(由 cli 装配层
///    用已握手、已加密的会话现取实现);每台设备「有没有活会话」由
///    `get_transport` 现查,服务本身不缓存连接状态。
///  - 落地全在 `<configDir>/inbox/`,**永不写共享目录**,因此不进索引、不产生
///    版本向量、不会触发同步冲突或 `.sync-conflict` 副本。
///  - 文本与文件都走「接收方确认」:文本直接入箱并回执,文件先提议 + 用户
///    确认后再分片。
///  - 目标设备离线时不报错退场,而是先入队(`inbox/queue.json`),等它上线
///    自动投递;队列有 24 小时窗口与条数/字节上限。
///  - 传了一半的传输把半截留在盘上(`inbox/resume.json` 记台账),对端重连、
///    甚至本机 daemon 重启过,都能从已落盘的字节接着传。
///  - 归属身份一律用会话验签过的对端设备 id,不信消息体里的 fromDeviceId。
///
/// 与 Node 的差异(刻意):
///  - 状态推送不做回调:本后端的 WS 状态帧是周期差异驱动(见 api/ws.mbt),
///    快照进了 `status_json` 之后状态变化自然被下一拍推给前端,无需 notify。
///  - zip 打包与「另存到指定目录」(saveTo)未实现,能力按 `zip:false` 申报、
///    对应路由回 503 —— 不支持的字段诚实不上线,而不是装作支持。

///|
/// 单片明文 256KB:与二进制信封的水位相称,重传代价可控。
pub const DIRECT_CHUNK_BYTES : Int64 = 256L * 1024L

///|
/// 在途窗口:4 片 ≈ 1MB,局域网足够跑满而不需要复杂的选择性重传调度。
const DIRECT_WINDOW : Int64 = 4

///|
/// 文本上限(64KB UTF-8 字节,不是字符数)。
pub const DIRECT_MAX_TEXT_BYTES : Int64 = 64L * 1024L

///|
/// 单文件上限 100MB:超过请走共享目录(那是为大数据量设计的路径)。
pub const DIRECT_MAX_FILE_BYTES : Int64 = 100L * 1024L * 1024L

///|
/// 收件箱软配额:超出后拒绝新入站,避免把 daemon 数据目录撑爆。
const DIRECT_INBOX_QUOTA_BYTES : Int64 = 512L * 1024L * 1024L

///|
/// 提议等待用户确认的时限(2 分钟,允许对方起身去点)。
const DIRECT_OFFER_TIMEOUT_MS : Int64 = 120_000L

///|
/// 分片重传间隔:超过 5s 没确认就重发该片。
const DIRECT_RETRY_MS : Int64 = 5_000L

///|
/// 单片最多重传次数(3 次后放弃并 cancel,不留半截文件)。
const DIRECT_MAX_RETRIES : Int32 = 3

///|
/// 完全收不到确认的硬超时(30s)。
const DIRECT_STALL_TIMEOUT_MS : Int64 = 30_000L

///|
/// 乱序分片缓存上限(32 片 = 8MB);超出的片丢弃,发送方会重传。
const MAX_BUFFERED_CHUNKS : Int = 32

///|
/// 已结束的传输记录在快照里保留多久(给 UI 足够时间看到结果)。
const FINISHED_TTL_MS : Int64 = 60_000L

///|
/// 断点续传窗口:链路断开后保留半截文件 / 发送侧暂存这么久,期间对方重连就
/// 从已落盘字节接着传;超时才放弃并清理。10 分钟够覆盖 Wi-Fi 抖动、termux
/// 被系统挂起、对端重启这类常见中断,又不至于让半截文件长期占着收件箱配额。
pub const DIRECT_RESUME_TTL_MS : Int64 = 10L * 60L * 1000L

///|
/// 续传期间重发提议的间隔(对方会话可能还在握手,早发会被丢弃)。
const DIRECT_RESUME_RETRY_MS : Int64 = 3_000L

///|
/// 离线排队窗口:设备这么久都没上线就放弃并把暂存文件清掉。
pub const DIRECT_QUEUE_TTL_MS : Int64 = 24L * 60L * 60L * 1000L

///|
/// 队列条数上限:防止误点「全选」把几十台离线设备的文件都拖进暂存区。
pub const DIRECT_MAX_QUEUED : Int = 20

///|
/// 队列文件总量上限(收件箱配额同量级),超出后拒绝新入队。
pub const DIRECT_QUEUE_MAX_BYTES : Int64 = 512L * 1024L * 1024L

///|
/// 排队项探测通道的间隔:会话事件与入队可能擦肩而过,定时器兜一层。
const DIRECT_QUEUE_PROBE_MS : Int64 = 5_000L

///|
/// 出站投送在快照里保留的条数上限(排队项不可被挤掉,见 new_outgoing)。
const OUTGOING_CAP : Int = 30

///|
/// 会话侧注入的发送口。`control` 返回 false 表示会话刚好断了;`chunk`
/// 同理(分片走 kind 3 二进制信封)。实现见 cli 装配层,服务不缓存连接;
/// 闭包签名可抛错 —— 装配层自己把底层 PeerError 收敛成 false。
pub(all) struct DirectTransport {
  control : async (@net.ControlMessage) -> Bool raise
  chunk : async (String, Int64, Bytes) -> Bool raise
}

///|
/// 收件箱里的一条文本。
pub(all) struct DirectTextItem {
  id : String
  from : String
  created_at : Int64
  size : Int64
  /// 状态快照里的短预览;正文按需从 /api/direct/inbox/:id/content 取。
  preview : String
  path : String
}

///|
/// 收件箱里的一条文件。
pub(all) struct DirectFileItem {
  id : String
  from : String
  created_at : Int64
  name : String
  size : Int64
  sha256 : String
  path : String
  /// true = 接收时选择了「另存到指定目录」:path 指向用户目录,删回执不能删
  /// 文件(MoonBit 尚未支持另存,恒 false;字段保留与 Node/Rust 状态对齐)。
  external : Bool
}

///|
pub(all) enum DirectItem {
  TextItem(DirectTextItem)
  FileItem(DirectFileItem)
}

///|
/// 收件箱条目的创建时刻(两种形态统一取用)。
pub fn DirectItem::created_at(self : DirectItem) -> Int64 {
  match self {
    TextItem(item) => item.created_at
    FileItem(item) => item.created_at
  }
}

///|
/// 收件箱条目的字节量(配额统计用;文本按 UTF-8 字节,文件按落盘大小)。
pub fn DirectItem::size(self : DirectItem) -> Int64 {
  match self {
    TextItem(item) => item.size
    FileItem(item) => item.size
  }
}

///|
pub fn DirectItem::id(self : DirectItem) -> String {
  match self {
    TextItem(item) => item.id
    FileItem(item) => item.id
  }
}

///|
/// 一份等用户确认的入站文件提议(状态快照只给元数据,不含字节)。
pub(all) struct DirectPending {
  id : String
  from : String
  name : String
  size : Int64
  sha256 : String
  created_at : Int64
  /// 同一次「发送 N 个文件」的组号:接收方按它合并成一张卡,一次确认全部。
  batch_id : String?
}

///|
/// 一次投送在快照里的投影。
pub(all) struct DirectTransfer {
  id : String
  /// "send" | "receive"
  direction : String
  device_id : String
  /// "text" | "file"
  kind : String
  name : String?
  size : Int64
  bytes_done : Int64
  /// queued / offering / transferring / paused / done / canceled / failed
  state : String
  error : String?
}

///|
/// 一次投送的受理结果:queued=true 表示目标离线、内容进了本机队列,
/// 前端据此提示「已排队」而不是「已发出」。
pub(all) struct DirectSendAck {
  id : String
  queued : Bool
}
