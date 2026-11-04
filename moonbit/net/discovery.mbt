///|
/// mDNS 局域网发现(C FFI 绑定 vendored mdns.h,胶水层在 mdns.c)。
/// 对应 Node `src/net/discovery.ts` 与 Rust `rust/crates/syncx-net/src/discovery.rs`。
///
/// 与两端对齐的记录格式:
///   - 服务名 `_syncx._tcp.local.`,实例名 `<device_id>._syncx._tcp.local.`;
///   - TXT 记录 `deviceId=<device_id>`(Node/Rust 都是从 TXT 里读 deviceId);
///   - SRV target 为 `<hostname>.local.`,TTL 120(Node 侧写的 120,mdns-sd 默认一致);
///   - advertise 同时发服务级(Node 形态)与实例级(mdns-sd 形态)两套 SRV/TXT,
///     外加 PTR,使 Node 与 Rust 对端都能解析。
///
/// 回调语义与 Rust 一致:同一设备(deviceId)只上报一次,地址/端口变化时重新上报;
/// 30 秒周期重播 + 主动查询(mdns.c 线程内,启动头 5 轮每秒一次)。

///|
/// 发现层错误。
pub(all) suberror DiscoveryError {
  StartupFailed(String)
  InvalidDeviceId(String)
}

///|
pub fn DiscoveryError::to_text(self : DiscoveryError) -> String {
  match self {
    StartupFailed(reason) => "mDNS 服务启动失败:\{reason}"
    InvalidDeviceId(reason) => "Device ID 非法:\{reason}"
  }
}

// ==================== C FFI(mdns.c 胶水层) ====================

///|
#borrow(id)
extern "C" fn c_mdns_start(port : Int32, id : Bytes, id_len : Int32) -> Int64 = "syncx_mdns_start"

///|
extern "C" fn c_mdns_stop(handle : Int64) -> Unit = "syncx_mdns_stop"

///|
extern "C" fn c_mdns_kick(handle : Int64) -> Int32 = "syncx_mdns_kick"

///|
#borrow(out)
extern "C" fn c_mdns_poll(
  handle : Int64,
  out : Bytes,
  capacity : Int32,
) -> Int32 = "syncx_mdns_poll"

///|
#borrow(id, host, out)
extern "C" fn c_mdns_build_announce(
  port : Int32,
  id : Bytes,
  id_len : Int32,
  host : Bytes,
  host_len : Int32,
  out : Bytes,
  capacity : Int32,
) -> Int32 = "syncx_mdns_build_announce"

///|
#borrow(id, host, buf)
extern "C" fn c_mdns_verify_announce(
  buf : Bytes,
  len : Int32,
  port : Int32,
  id : Bytes,
  id_len : Int32,
  host : Bytes,
  host_len : Int32,
) -> Int32 = "syncx_mdns_verify_announce"

///|
extern "C" fn c_mdns_msleep(milliseconds : Int32) -> Unit = "syncx_mdns_msleep"

///|
/// 单条发现记录序列化后的最大长度(布局见 mdns.c `syncx_mdns_poll`)。
const MDNS_RECORD_BUF_SIZE : Int32 = 256

///|
/// 构造 announce 报文(诊断/测试用):把完整广播包写进 `out`,返回写入长度,
/// 失败返回 -1。不依赖网络,可在任何环境验证报文格式。
pub fn build_announce_packet(
  port : Int32,
  device_id : String,
  hostname : String,
  out : Bytes,
) -> Int32 {
  let id = @utf8.encode(device_id)
  let host = @utf8.encode(hostname)
  c_mdns_build_announce(
    port,
    id,
    id.length(),
    host,
    host.length(),
    out,
    out.length(),
  )
}

///|
/// 逐记录回解校验 announce 报文(诊断/测试用):名字/类型/端口/TXT/TTL 与
/// 期望一致返回 true。与 `build_announce_packet` 配对,证明序列化正确。
pub fn verify_announce_packet(
  packet : Bytes,
  len : Int32,
  port : Int32,
  device_id : String,
  hostname : String,
) -> Bool {
  let id = @utf8.encode(device_id)
  let host = @utf8.encode(hostname)
  c_mdns_verify_announce(
    packet,
    len,
    port,
    id,
    id.length(),
    host,
    host.length(),
  ) ==
  0
}

// ==================== Device ID 判定与 TXT 解析(纯函数) ====================

///|
/// 判定 Device ID 形状:10 个 base32 字符(`[A-Z2-7]`)。
/// 与 Node 的正则 `[A-Z2-7]{10}`、Rust 的 `is_device_id` 同一判据。
pub fn is_device_id(text : String) -> Bool {
  let bytes = @utf8.encode(text)
  if bytes.length() != 10 {
    return false
  }
  for i in 0..<bytes.length() {
    let v = bytes.at(i).to_int()
    let upper = v >= 0x41 && v <= 0x5A
    let digit = v >= 0x32 && v <= 0x37
    if !upper && !digit {
      return false
    }
  }
  true
}

///|
/// 从 TXT 记录文本里提取 deviceId(`deviceId=XXXXXXXXXX`,大小写不敏感的 key,
/// 值必须恰好是合法的 10 字符 Device ID)。对应 Node 的
/// `text.match(/deviceId=([A-Z2-7]{10})/)`。
pub fn extract_device_id_from_txt(text : String) -> String? {
  let data = @utf8.encode(text)
  let marker = @utf8.encode("deviceId=")
  let marker_len = marker.length()
  if data.length() < marker_len + 10 {
    return None
  }
  let limit = data.length() - marker_len - 10
  let mut start = 0
  while start <= limit {
    let mut hit = true
    for j in 0..<marker_len {
      if data.at(start + j) != marker.at(j) {
        hit = false
        break
      }
    }
    if hit {
      let candidate = decode_utf8_range(data, start + marker_len, 10)
      if is_device_id(candidate) {
        return Some(candidate)
      }
    }
    start = start + 1
  }
  None
}

///|
/// UTF-8 解码 Bytes 的 [start, start+len) 区间,失败返回空串。
fn decode_utf8_range(buf : Bytes, start : Int32, len : Int32) -> String {
  if len <= 0 {
    return ""
  }
  @utf8.decode(buf.exact_view(start~, end=start + len).to_owned()) catch {
    _ => ""
  }
}

// ==================== 对端记录与发现服务 ====================

///|
/// 发现到的对端。
#derive(Eq, Debug)
pub(all) struct DiscoveredPeer {
  device_id : String
  /// SRV target 的裸值(去掉结尾 `.local.` 的点),不保证可解析,只作展示。
  host : String
  port : Int32
  /// 收到这个 mDNS 包的**源 IP**(与 Node 的 rinfo.address、Rust 的发包源 IP 同语义);
  /// 空串表示未知(比如测试注入)。
  address : String
}

///|
pub extend DiscoveredPeer with Eq::{equal, not_equal}

///|
pub extend DiscoveredPeer with @moonbitlang/core/debug.Debug::{to_repr}

///|
/// 正在运行的发现服务。stop 之后所有方法变 no-op(防 use-after-close,同 sqlite.Db)。
pub(all) struct Discovery {
  mut handle : Int64
  device_id : String
  /// deviceId → "host:port" 指纹,同一设备反复广播不重复上报(Rust 同款去重)。
  mut seen : Map[String, String]
}

///|
/// 启动广播与发现:在 `_syncx._tcp.local.` 上宣告本机(实例名 = device_id,
/// TXT = `deviceId=<device_id>`,SRV 端口 = `port`),同时持续监听同服务名下的
/// 对端广播。组播环境不可用(沙箱 / 无网)时抛 `StartupFailed`。
pub fn advertise(
  port : Int32,
  device_id : String,
) -> Discovery raise DiscoveryError {
  if !is_device_id(device_id) {
    raise InvalidDeviceId(
      "应为 10 个 base32 字符 [A-Z2-7],实际 \"\{device_id}\"",
    )
  }
  let encoded = @utf8.encode(device_id)
  let handle = c_mdns_start(port, encoded, encoded.length())
  if handle == 0L {
    raise StartupFailed(
      "mDNS 组播 socket 创建失败(5353 端口或组播权限不可用)",
    )
  }
  { handle, device_id, seen: Map([]), }
}

///|
/// 立即补一轮 advertise + query(网络恢复 / 测试收敛用)。
pub fn Discovery::kick(self : Discovery) -> Unit {
  if self.handle == 0L {
    return
  }
  let _ = c_mdns_kick(self.handle)
}

///|
/// 排空当前积压的发现记录,对每个**新**对端(未见过的 deviceId,或地址/端口
/// 发生变化的)调用一次 `on_peer_found`。非阻塞;上层周期调用即可。
pub fn Discovery::browse(
  self : Discovery,
  on_peer_found : (DiscoveredPeer) -> Unit,
) -> Unit {
  if self.handle == 0L {
    return
  }
  let buf = Bytes::make(MDNS_RECORD_BUF_SIZE, (0).to_byte())
  let _ = self.drain_new_peers(buf, on_peer_found)
}

///|
/// 阻塞等待下一个**新**对端,超时(毫秒)返回 None。测试与上层「首发现」场景用。
pub fn Discovery::browse_wait(
  self : Discovery,
  timeout_ms : Int32,
) -> DiscoveredPeer? raise DiscoveryError {
  if self.handle == 0L {
    raise StartupFailed("发现服务已停止")
  }
  let buf = Bytes::make(MDNS_RECORD_BUF_SIZE, (0).to_byte())
  let mut found : DiscoveredPeer? = None
  let step = 50
  let mut remaining = timeout_ms
  while true {
    let _ = self.drain_new_peers(buf, fn(peer) {
      match found {
        None => found = Some(peer)
        Some(_) => ()
      }
    })
    match found {
      Some(_) => break
      None => ()
    }
    if remaining <= 0 {
      break
    }
    let sleep = if remaining < step { remaining } else { step }
    c_mdns_msleep(sleep)
    remaining = remaining - sleep
  }
  found
}

///|
/// 关闭发现服务:先广播 goodbye(TTL=0,对端尽快认为我们下线),再停线程关 socket。
pub fn Discovery::stop(self : Discovery) -> Unit {
  if self.handle == 0L {
    return
  }
  c_mdns_stop(self.handle)
  self.handle = 0L
}

///|
/// 排空队列并把新对端经 `on_peer` 上报;返回是否有新对端。
fn Discovery::drain_new_peers(
  self : Discovery,
  buf : Bytes,
  on_peer : (DiscoveredPeer) -> Unit,
) -> Bool {
  let mut any = false
  let mut n = c_mdns_poll(self.handle, buf, MDNS_RECORD_BUF_SIZE)
  while n > 0 {
    match parse_peer_record(buf, n) {
      Some(peer) =>
        if self.report_new_peer(peer) {
          any = true
          on_peer(peer)
        }
      None => ()
    }
    n = c_mdns_poll(self.handle, buf, MDNS_RECORD_BUF_SIZE)
  }
  any
}

///|
/// 去重上报判定:跳过自身与形状非法的 id;同一 deviceId 且 host:port 未变不重复上报。
fn Discovery::report_new_peer(self : Discovery, peer : DiscoveredPeer) -> Bool {
  if peer.device_id == self.device_id {
    return false
  }
  if !is_device_id(peer.device_id) {
    return false
  }
  let fingerprint = "\{peer.host}:\{peer.port}"
  if self.seen.get(peer.device_id) == Some(fingerprint) {
    return false
  }
  self.seen.set(peer.device_id, fingerprint)
  true
}

///|
/// 反序列化 C 层记录(layout 见 mdns.c `syncx_mdns_poll`):非法布局返回 None。
fn parse_peer_record(buf : Bytes, n : Int32) -> DiscoveredPeer? {
  let mut pos = 0
  if n < 4 {
    return None
  }
  let id_len = buf.at(pos).to_int()
  pos = pos + 1
  if id_len <= 0 || pos + id_len > n {
    return None
  }
  let device_id = decode_utf8_range(buf, pos, id_len)
  pos = pos + id_len
  if pos >= n {
    return None
  }
  let host_len = buf.at(pos).to_int()
  pos = pos + 1
  if host_len < 0 || pos + host_len > n {
    return None
  }
  let host = decode_utf8_range(buf, pos, host_len)
  pos = pos + host_len
  if pos + 2 > n {
    return None
  }
  let port = (buf.at(pos).to_int() << 8) | buf.at(pos + 1).to_int()
  pos = pos + 2
  let address = decode_utf8_range(buf, pos, n - pos)
  Some({ device_id, host, port, address, })
}
