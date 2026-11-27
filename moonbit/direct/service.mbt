///|
/// 在途重发槽:分片的内存副本 + 已发时刻 + 重试次数。重发时从磁盘重读
/// (Node 同口径:内存副本可能被上一轮截短)。
priv struct InflightSlot {
  mut body : Bytes
  mut sent_at : Int64
  mut attempts : Int32
}

///|
/// 出站投送(文本 / 文件)。Node `OutgoingTransfer` 的直译;可变字段全部
/// mut,单线程 async 下无锁。
struct Outgoing {
  id : String
  device_id : String
  /// "text" | "file"
  kind : String
  name : String?
  size : Int64
  mut bytes_done : Int64
  mut state : String
  mut error : String?
  created_at : Int64
  mut finished_at : Int64?
  /// 最近一次发出提议的时间:提议超时按它算,续传重发也不会被旧的
  /// createdAt 拖死。
  mut offer_sent_at : Int64
  /// 断点续传中(掉过线):定时器据此重发提议、跳过普通提议超时。
  mut resuming : Bool
  mut paused_at : Int64?
  /// 离线排队:入队时间(按它算 24 小时窗口);发出后清空。
  mut queued_at : Int64?
  /// 排队文本的正文。文本没有本地暂存文件,不留在内存/磁盘上就没法补发。
  mut text : String?
  /// 多文件成组投送的组号;提议(含重发/排队补发)都带上。
  batch_id : String?
  /// 文件专用:分期中的本地暂存文件、指纹、分片账本。
  mut source_path : String?
  mut fd : @fs.File?
  sha256 : String?
  total_chunks : Int64?
  mut acked : Int64
  mut next_seq : Int64
  inflight : Map[Int64, InflightSlot]
  mut last_progress_at : Int64
}

///|
/// 入站投送。Node `IncomingTransfer` 的直译。
struct Incoming {
  id : String
  from : String
  name : String
  size : Int64
  sha256 : String
  created_at : Int64
  tmp_path : String
  /// 接收方在确认时指定的另存目录;None = 落收件箱(MoonBit 恒 None)。
  save_dir : String?
  /// 发送方的多文件组号;同一组的待确认项在 UI 里合并成一张卡。
  batch_id : String?
  /// "pending" | "transferring" | "paused"
  mut state : String
  mut paused_at : Int64?
  mut fd : @fs.File?
  /// 顺序写入时边写边算的指纹;暂停时丢弃,续传时按盘上整片重建。
  mut hash : @core.Sha256?
  mut next_seq : Int64
  total_chunks : Int64
  mut bytes_done : Int64
  /// 已写入的片号(去重;乱序缓存走 buffered,写入即删除并登记)
  received : Map[Int64, Bool]
  buffered : Map[Int64, Bytes]
  mut last_progress_at : Int64
}

///|
/// 直发服务本体。状态全在内存(收件箱条目 / 在途台账),持久化三件套
/// (index/queue/resume)每次状态变更后落盘 —— 与 Node 同一套写盘时机。
pub struct DirectService {
  priv messages_dir : String
  priv files_dir : String
  priv tmp_dir_path : String
  priv index_path : String
  priv queue_path : String
  priv resume_path : String
  priv outgoing : Map[String, Outgoing]
  priv incoming : Map[String, Incoming]
  priv items : Array[DirectItem]
  /// 具备「现取会话通道」的能力 = 支持续传;续传台账因此才有意义。
  priv can_resume : Bool
  /// 关闭中:此时不再接受新的入站动作(控制端口可能已经收了)。
  priv mut closing : Bool
  /// 现取一台设备的直发通道(会话重连后由它拿到新的 transport)。
  priv get_transport : (String) -> DirectTransport?
  /// 群发时多笔投送共用同一份暂存文件:按路径计数,最后一笔结束才删。
  priv source_refs : Map[String, Int32]
  /// 每台设备最近一次探测排队通道的时间(避免每秒都去问一次会话表)。
  priv queued_probe_at : Map[String, Int64]
}

///|
/// 构造服务并恢复盘上台账(收件箱索引 / 离线队列 / 跨重启续传)。
/// `get_transport` 为 None 的最小装配(单测)不支持续传:掉线即失败、
/// 退出即清理,不落 resume.json。
pub async fn DirectService::new(
  config_dir : String,
  get_transport~ : (String) -> DirectTransport? = _ => None
) -> DirectService {
  let root = join_path(config_dir, "inbox")
  let messages_dir = join_path(root, "messages")
  let files_dir = join_path(root, "files")
  let tmp_dir = join_path(root, ".tmp")
  // 目录建不出来先吞掉:真正落地动作会在首次写盘时报错,不在启动时卡死
  for dir in [root, messages_dir, files_dir, tmp_dir] {
    @fs.mkdir(dir, recursive=true, allow_exist=true) catch { _ => () }
  }
  // 先读索引再落结构体:items 字段不可变(数组本身可变,无需整体替换)
  let index_path = join_path(root, "index.json")
  let loaded_items : Array[DirectItem] = read_index(index_path)
  let service = {
    messages_dir,
    files_dir,
    tmp_dir_path: tmp_dir,
    index_path,
    queue_path: join_path(root, "queue.json"),
    resume_path: join_path(root, "resume.json"),
    outgoing: Map([]),
    incoming: Map([]),
    items: loaded_items,
    can_resume: true,
    closing: false,
    get_transport,
    source_refs: Map([]),
    queued_probe_at: Map([]),
  }
  service.load_queue()
  service.load_resume()
  service
}

///|
/// 上传暂存目录(收件箱 `.tmp`;路由层把上传体先落到这里)。
pub fn DirectService::tmp_dir(self : DirectService) -> String {
  self.tmp_dir_path
}

///|
/// 新的上传暂存路径 `<tmp>/out-<16hex>`;熵源不可用 = None(调用方回 500
/// 口径)。独立成方法:api 层不引 net 包,熵源仍走本包这一个窄口。
pub fn DirectService::new_staging_path(self : DirectService) -> String? {
  match direct_id("out") {
    Some(id) => Some(join_path(self.tmp_dir_path, id))
    None => None
  }
}

///|
/// 待确认提议的来源设备:单条按 id、成组按 batchId(收 api 层 reply 路由
/// 的「回执通道按谁寻址」兜底查询 —— 快照里的 from 就是它)。
pub fn DirectService::pending_from(
  self : DirectService,
  id : String,
  batch_id : String,
) -> String? {
  if batch_id != "" {
    for _, entry in self.incoming {
      match entry.batch_id {
        Some(current) =>
          if current == batch_id {
            return Some(entry.from)
          }
        None => ()
      }
    }
    return None
  }
  match self.incoming.get(id) {
    Some(entry) => Some(entry.from)
    None => None
  }
}

///|
/// 现在时刻(毫秒;墙钟,与 Node Date.now / @daemon.now_ms 同源)。
fn now_ms() -> Int64 {
  @async.now()
}

///|
/// 本地路径拼接(本层路径只在本机用,直接 `<a>/<b>`)。
fn join_path(a : String, b : String) -> String {
  if a.has_suffix("/") {
    "\{a}\{b}"
  } else {
    "\{a}/\{b}"
  }
}

///|
/// 投送 id:`<prefix>-<16 hex>`(Node 同形)。熵源不可用 = None,调用方转
/// 失败文案。
fn direct_id(prefix : String) -> String? {
  let raw = @net.random_bytes(8)
  if raw.length() != 8 {
    return None
  }
  Some("\{prefix}-\{bytes_hex(raw)}")
}

///|
/// 16 字节 → 32 位十六进制小写(mooncry 的一次性摘要 + 转换)。
fn bytes_hex(data : Bytes) -> String {
  @lib.bytes_to_hex(data)
}

///|
/// 文件名只取 basename 并去掉控制字符;重名由落盘时加序号兜底。
fn safe_file_name(input : String) -> String {
  // basename:最后一个路径分隔符之后的部分(两种分隔符都认)
  let mut base = ""
  for part in input.split("/") {
    base = part.to_owned()
  }
  for part in input.split("\\") {
    base = part.to_owned()
  }
  let sb = StringBuilder()
  for ch in base {
    let code = ch.to_int()
    if code < 0x20 || code == 0x7f {
      sb.write_char('_')
    } else {
      sb.write_char(ch)
    }
  }
  let cleaned = sb.to_string().trim().to_owned()
  if cleaned == "" {
    "未命名文件"
  } else if cleaned.length() > 180 {
    // 按字符数截断(180 字符是展示上限,不是安全边界)
    let sb2 = StringBuilder()
    let mut n = 0
    for ch in cleaned {
      if n >= 180 {
        break
      }
      sb2.write_char(ch)
      n += 1
    }
    sb2.to_string()
  } else {
    cleaned
  }
}

///|
/// id / batchId 的合法性闸:只认字母数字下划线短横线,≤64 字符
/// (它们直接拼进落盘路径,不能给穿越留门)。api 层校验批次号也用它。
pub fn is_safe_id(id : String) -> Bool {
  if id == "" || id.length() > 64 {
    return false
  }
  for ch in id {
    let ok = (ch >= 'a' && ch <= 'z') ||
      (ch >= 'A' && ch <= 'Z') ||
      (ch >= '0' && ch <= '9') ||
      ch == '_' ||
      ch == '-'
    if !ok {
      return false
    }
  }
  true
}

///|
/// 整份文件指纹必须是 64 位十六进制小写(它要和落盘重算的值逐字比较)。
fn is_sha256_hex(value : String) -> Bool {
  if value.length() != 64 {
    return false
  }
  for ch in value {
    let ok = (ch >= 'a' && ch <= 'f') || (ch >= '0' && ch <= '9')
    if !ok {
      return false
    }
  }
  true
}
