///|
/// wire 协议:消息模型 + JSON 序列化(对应 Node `src/net/wire.ts` 与 Rust
/// `rust/crates/syncx-net/src/wire.rs`)。本文件只做消息模型,不做传输
/// (加密信封 / 二进制帧 / WebSocket 属于 net 包后续里程碑)。
///
/// 三个必须逐字对齐的地方,顺序即踩坑顺序:
///
/// 1. **`full` 缺省按增量**。旧版对端不发这个字段,而它**确实**会发增量索引。
///    把缺省当全量,就会为「它没提到的本地条目」回推,两端互为回声、无限循环。
///    所以 `full` 用 `Bool?` 承载,只有 `Some(true)` 才按全量解释。
/// 2. **控制消息里的 `version` 是软件版本,不是条目版本向量**。后者叫 `entryVersion`,
///    字段名刻意避开 —— 混用会让读协议的人把版本向量当成软件版本号。
/// 3. **可缺省字段(`Bool?`/`String?`/…)缺省时不能写成 `null`/`false` 上线**,
///    序列化时整个键不出现。旧对端按 `undefined` 分支处理,发 `null` 会让它的
///    `typeof` 判断走进非预期分支。

///|
/// 单条 WebSocket 消息的上限:索引/块传输的上限,防单条巨消息耗尽内存。
pub const MAX_MESSAGE_BYTES : Int64 = 64L * 1024L * 1024L

///|
/// wire 层错误。畸形消息一律抛错,由调用方丢弃整条 —— 线上数据不可信,宽进严出。
pub(all) suberror WireError {
  Malformed(String)
}

///|
pub fn WireError::to_text(self : WireError) -> String {
  match self {
    Malformed(reason) => "wire 消息非法:\{reason}"
  }
}

///|
/// 构造会话建立时的版本宣告(version 取单一来源的 syncx 版本,与
/// Node 侧 `hello` 消息同口径:dev 态由调用方传 "dev" 覆盖)。
///
/// runtime 是编译期事实(本模块就是 MoonBit 后端),写死在这里而不由调用方传:
/// 要冒充别的后端只能直接构造 `Hello`,那是测试的事,不该混进正常入口。
pub fn make_hello(
  from_device_id : String,
  hostname : String?,
  platform : String?,
) -> ControlMessage {
  Hello(
    from_device_id~,
    version=@core.VERSION,
    hostname~,
    platform~,
    runtime=Some("moonbit"),
  )
}

// ==================== 解析辅助(照 Rust serde 的严格口径) ====================
//
// Rust 版用 serde 声明式获得的行为,这里用显式辅助函数复刻:
//   - 必填字段:缺失或类型不对 → Malformed(整条丢弃);
//   - 可缺省字段(Option):缺失 → None,出现但类型不对 → Malformed;
//   - u64 语义字段:负数 → Malformed(serde 对 u64 拒收负数)。
// 唯一的宽进偏差:带小数的数字(如 `3.5`)对 u64 字段按截断处理而不是拒收,
// 与 mtime 的宽进口径一致(见 WireEntry.mtime 注释)。

///|
/// 取必填 String;缺失/非字符串 → Malformed。
fn req_str(map : Map[String, Json], key : String) -> String raise WireError {
  match map.get(key) {
    Some(String(s)) => s
    Some(_) => raise Malformed("字段 \{key} 应为字符串")
    None => raise Malformed("缺少字段 \{key}")
  }
}

///|
/// 取可缺省 String;缺失 → None,出现但非字符串 → Malformed。
fn opt_str(map : Map[String, Json], key : String) -> String? raise WireError {
  match map.get(key) {
    Some(String(s)) => Some(s)
    Some(_) => raise Malformed("字段 \{key} 应为字符串")
    None => None
  }
}

///|
fn req_bool(map : Map[String, Json], key : String) -> Bool raise WireError {
  match map.get(key) {
    Some(True) => true
    Some(False) => false
    Some(_) => raise Malformed("字段 \{key} 应为布尔")
    None => raise Malformed("缺少字段 \{key}")
  }
}

///|
fn opt_bool(map : Map[String, Json], key : String) -> Bool? raise WireError {
  match map.get(key) {
    Some(True) => Some(true)
    Some(False) => Some(false)
    Some(_) => raise Malformed("字段 \{key} 应为布尔")
    None => None
  }
}

///|
/// 取必填 u64(内部 Int64);缺失/非数/负数 → Malformed。
fn req_u64(map : Map[String, Json], key : String) -> Int64 raise WireError {
  match map.get(key) {
    Some(Number(n, ..)) => {
      if n < 0.0 {
        raise Malformed("字段 \{key} 不能为负")
      }
      n.to_int64()
    }
    Some(_) => raise Malformed("字段 \{key} 应为非负整数")
    None => raise Malformed("缺少字段 \{key}")
  }
}

///|
fn opt_u64(map : Map[String, Json], key : String) -> Int64? raise WireError {
  match map.get(key) {
    Some(Number(n, ..)) => {
      if n < 0.0 {
        raise Malformed("字段 \{key} 不能为负")
      }
      Some(n.to_int64())
    }
    Some(_) => raise Malformed("字段 \{key} 应为非负整数")
    None => None
  }
}

///|
/// 取必填 Double(mtime 是浮点毫秒,不能走 u64 口径)。
fn req_f64(map : Map[String, Json], key : String) -> Double raise WireError {
  match map.get(key) {
    Some(Number(n, ..)) => n
    Some(_) => raise Malformed("字段 \{key} 应为数字")
    None => raise Malformed("缺少字段 \{key}")
  }
}

///|
/// 取必填 String 数组。
fn req_str_array(
  map : Map[String, Json],
  key : String,
) -> Array[String] raise WireError {
  match map.get(key) {
    Some(Array(items)) => {
      let out : Array[String] = []
      for item in items {
        match item {
          String(s) => out.push(s)
          _ => raise Malformed("字段 \{key} 应为字符串数组")
        }
      }
      out
    }
    Some(_) => raise Malformed("字段 \{key} 应为字符串数组")
    None => raise Malformed("缺少字段 \{key}")
  }
}

///|
fn opt_str_array(
  map : Map[String, Json],
  key : String,
) -> Array[String]? raise WireError {
  match map.get(key) {
    Some(Array(items)) => {
      let out : Array[String] = []
      for item in items {
        match item {
          String(s) => out.push(s)
          _ => raise Malformed("字段 \{key} 应为字符串数组")
        }
      }
      Some(out)
    }
    Some(_) => raise Malformed("字段 \{key} 应为字符串数组")
    None => None
  }
}

///|
/// 取必填嵌套对象(block-request/response 的 payload)。
fn req_obj(
  map : Map[String, Json],
  key : String,
) -> Map[String, Json] raise WireError {
  match map.get(key) {
    Some(Object(obj)) => obj
    Some(_) => raise Malformed("字段 \{key} 应为对象")
    None => raise Malformed("缺少字段 \{key}")
  }
}

///|
/// 取版本向量:`[[deviceId, counter], ...]`。线上必须是数组对而不是对象
/// —— JS 的 `Map` 序列化就是这个形态,写成对象会让旧对端的
/// `new Map(e.version)` 拿到 `[]`。
fn req_version(
  map : Map[String, Json],
  key : String,
) -> Array[(String, Int64)] raise WireError {
  match map.get(key) {
    Some(Array(items)) => {
      let out : Array[(String, Int64)] = []
      for item in items {
        match item {
          Array(pair) => {
            if pair.length() != 2 {
              raise Malformed("字段 \{key} 的元素必须是二元数组")
            }
            match (pair[0], pair[1]) {
              (String(device), Number(count, ..)) => {
                if count < 0.0 {
                  raise Malformed("字段 \{key} 的计数不能为负")
                }
                out.push((device, count.to_int64()))
              }
              _ =>
                raise Malformed(
                  "字段 \{key} 的元素必须是 [设备ID, 计数]",
                )
            }
          }
          _ => raise Malformed("字段 \{key} 的元素必须是数组对")
        }
      }
      out
    }
    Some(_) => raise Malformed("字段 \{key} 应为数组对")
    None => raise Malformed("缺少字段 \{key}")
  }
}

///|
fn opt_version(
  map : Map[String, Json],
  key : String,
) -> Array[(String, Int64)]? raise WireError {
  match map.get(key) {
    Some(_) => Some(req_version(map, key))
    None => None
  }
}

///|
/// 顶层对象外的 JSON 一律 Malformed。
fn expect_object(
  value : Json,
  what : String,
) -> Map[String, Json] raise WireError {
  match value {
    Object(obj) => obj
    _ => raise Malformed("\{what} 应为 JSON 对象")
  }
}

// ==================== 序列化辅助 ====================

///|
fn set_str(map : Map[String, Json], key : String, v : String) -> Unit {
  map.set(key, Json::string(v))
}

///|
/// 可缺省字段:None 时整个键不出现(绝不发 null,见文件头第 3 条)。
fn set_opt_str(map : Map[String, Json], key : String, v : String?) -> Unit {
  match v {
    Some(s) => map.set(key, Json::string(s))
    None => ()
  }
}

///|
fn set_opt_bool(map : Map[String, Json], key : String, v : Bool?) -> Unit {
  match v {
    Some(b) => map.set(key, Json::boolean(b))
    None => ()
  }
}

///|
fn set_opt_u64(map : Map[String, Json], key : String, v : Int64?) -> Unit {
  match v {
    Some(n) => map.set(key, Json::number(n.to_double()))
    None => ()
  }
}

///|
fn set_str_array(
  map : Map[String, Json],
  key : String,
  v : Array[String],
) -> Unit {
  let arr : Array[Json] = []
  for item in v {
    arr.push(Json::string(item))
  }
  map.set(key, Json::array(arr))
}

///|
fn set_opt_str_array(
  map : Map[String, Json],
  key : String,
  v : Array[String]?,
) -> Unit {
  match v {
    Some(items) => set_str_array(map, key, items)
    None => ()
  }
}

///|
fn set_opt_u64_array(
  map : Map[String, Json],
  key : String,
  v : Array[Int64]?,
) -> Unit {
  match v {
    Some(items) => {
      let arr : Array[Json] = []
      for item in items {
        arr.push(Json::number(item.to_double()))
      }
      map.set(key, Json::array(arr))
    }
    None => ()
  }
}

///|
fn set_opt_version(
  map : Map[String, Json],
  key : String,
  v : Array[(String, Int64)]?,
) -> Unit {
  match v {
    Some(pairs) => {
      let arr : Array[Json] = []
      for pair in pairs {
        arr.push(
          Json::array([Json::string(pair.0), Json::number(pair.1.to_double())]),
        )
      }
      map.set(key, Json::array(arr))
    }
    None => ()
  }
}

///|
/// 控制面消息尾巴上的「自述三元组」:version = syncx 运行版本,
/// hostname / platform 供对端设备卡展示。三者全部可缺省。
fn set_self_info(
  map : Map[String, Json],
  version : String?,
  hostname : String?,
  platform : String?,
  runtime : String?,
) -> Unit {
  set_opt_str(map, "version", version)
  set_opt_str(map, "hostname", hostname)
  set_opt_str(map, "platform", platform)
  set_opt_str(map, "runtime", runtime)
}

///|
fn opt_self_info(
  map : Map[String, Json],
) -> (String?, String?, String?, String?) raise WireError {
  (
    opt_str(map, "version"),
    opt_str(map, "hostname"),
    opt_str(map, "platform"),
    opt_str(map, "runtime"),
  )
}

// ==================== 索引条目(WireEntry) ====================

///|
/// 索引在线上的一条条目。
///
/// 单独定义而不是直接给未来的 core `IndexEntry` 加序列化,原因是线上字段比
/// 内核多一个 `mtime`:
///   - `mtime` 参与 newest-wins 冲突判定,但**不参与**规划与版本比较,
///     所以 core 里没有它(内核只关心「要不要传」,不关心「谁更新」);
///   - 版本向量在线上是 `[[device, count], ...]` 数组而不是对象 —— JS 的 `Map`
///     序列化就是这个形态,写成对象会让旧对端的 `new Map(e.version)` 拿到 `[]`。
pub(all) struct WireEntry {
  path : String
  /// `[[deviceId, counter], ...]`。**顺序有意义**:Node 侧按 Map 迭代顺序写,
  /// 读回来也是这个顺序,保持即可(比较时处处按集合处理,不依赖顺序)。
  version : Array[(String, Int64)]
  size : Int64
  deleted : Bool
  blocks : Array[String]
  /// 文件 mtime(毫秒)。**可能是小数**:Node 侧写的是 `statSync().mtimeMs`,
  /// 在多数文件系统上是带小数的毫秒(NTFS/ext4/APFS 都给分数),`JSON.stringify`
  /// 会原样输出 `1750000000123.456`。按整数解析会让**整条索引**解析失败
  /// —— 连接看着正常、索引一条也收不到。宽进:按 Double 收,比较前再截断。
  mtime : Double
  /// cdh:CDC 块哈希;clens:CDC 块长度。等长且非空才算有效的 CDC 视图。
  cdh : Array[String]?
  clens : Array[Int64]?
} derive(Eq, Debug)

///|
pub extend WireEntry with Eq::{equal, not_equal}

///|
pub extend WireEntry with @moonbitlang/core/debug.Debug::{to_repr}

///|
/// 毫秒截断。负数/NaN 一律归 0(对端不可信,不能让它污染 newest-wins 比较)。
/// NaN 与「值 > 0」比较恒为假,天然归 0;JSON 里也不存在无穷大。
pub fn mtime_ms(value : Double) -> Int64 {
  if value > 0.0 {
    value.to_int64()
  } else {
    0L
  }
}

///|
/// cdh/clens 等长且非空才算有 CDC 视图(与 Node decodeIndex 同一判据);
/// 不满足时两端都要退化掉,绝不半套上线。
pub fn WireEntry::has_cdc_view(self : WireEntry) -> Bool {
  match (self.cdh, self.clens) {
    (Some(h), Some(l)) => h.length() > 0 && h.length() == l.length()
    _ => false
  }
}

///|
/// 清洗后的 CDC 视图:有效则原样返回,无效则两端都是 None。
pub fn WireEntry::cdc_view(self : WireEntry) -> (Array[String]?, Array[Int64]?) {
  if self.has_cdc_view() {
    (self.cdh, self.clens)
  } else {
    (None, None)
  }
}

///|
pub fn WireEntry::to_json(self : WireEntry) -> Json {
  let map : Map[String, Json] = Map([])
  set_str(map, "path", self.path)
  set_opt_version(map, "version", Some(self.version))
  set_opt_u64(map, "size", Some(self.size))
  set_opt_bool(map, "deleted", Some(self.deleted))
  set_opt_str_array(map, "blocks", Some(self.blocks))
  map.set("mtime", Json::number(self.mtime))
  set_opt_str_array(map, "cdh", self.cdh)
  set_opt_u64_array(map, "clens", self.clens)
  Json::object(map)
}

///|
pub fn WireEntry::from_json(value : Json) -> WireEntry raise WireError {
  let obj = expect_object(value, "索引条目")
  {
    path: req_str(obj, "path"),
    version: req_version(obj, "version"),
    size: req_u64(obj, "size"),
    deleted: req_bool(obj, "deleted"),
    blocks: req_str_array(obj, "blocks"),
    mtime: req_f64(obj, "mtime"),
    cdh: opt_str_array(obj, "cdh"),
    clens: match obj.get("clens") {
      Some(Array(items)) => {
        let out : Array[Int64] = []
        for item in items {
          match item {
            Number(n, ..) =>
              if n < 0.0 {
                raise Malformed("字段 clens 不能为负")
              } else {
                out.push(n.to_int64())
              }
            _ => raise Malformed("字段 clens 应为非负整数数组")
          }
        }
        Some(out)
      }
      Some(_) => raise Malformed("字段 clens 应为非负整数数组")
      None => None
    },
  }
}

///|
/// 索引体编码。**空条目也要保留**(`deleted: true` 的那类):它们是删除标记,
/// 过滤掉等于拒绝传播删除,对端会一直把已删文件当「本机独有」回推。
pub fn encode_index(entries : Array[WireEntry]) -> String {
  let arr : Array[Json] = []
  for entry in entries {
    arr.push(entry.to_json())
  }
  Json::array(arr).stringify()
}

///|
/// 索引体解码。畸形数据抛错,由调用方丢弃整条消息 —— 线上数据不可信。
pub fn decode_index(body : String) -> Array[WireEntry] raise WireError {
  let json = @json.parse(body) catch {
    e => raise Malformed("索引体不是合法 JSON:\{e}")
  }
  match json {
    Array(items) => {
      let out : Array[WireEntry] = []
      for item in items {
        out.push(WireEntry::from_json(item))
      }
      out
    }
    _ => raise Malformed("索引体应为 JSON 数组")
  }
}

// ==================== 块请求 / 块响应(文本信封) ====================

///|
/// 块请求(文本信封)。`priority` 只是本端排队决策,收到即忽略,可缺省。
pub(all) struct WireBlockRequest {
  /// deviceId
  device_id : String
  path : String
  /// blockIndex
  block_index : Int64
  hash : String
  priority : Bool?
  cdc : Bool?
} derive(Eq, Debug)

///|
pub extend WireBlockRequest with Eq::{equal, not_equal}

///|
pub extend WireBlockRequest with @moonbitlang/core/debug.Debug::{to_repr}

///|
/// 文本信封里的块响应(块数据 base64)。单独定义而不是复用未来 core 的
/// BlockResponse,因为线上形态不同:core 的版本是文件系统视角(Bytes),
/// 这里是线上视角(data: String,base64)。`cdc` 缺省时整个键不出现 ——
/// Node 侧是 `cdc?: boolean` + `...(cdc === true ? {cdc: true} : {})`,
/// 发 `null` 会让旧对端的 `typeof` 判断走进非预期分支。
pub(all) struct WireBlockResponse {
  /// deviceId
  device_id : String
  path : String
  /// blockIndex
  block_index : Int64
  hash : String
  data : String
  cdc : Bool?
} derive(Eq, Debug)

///|
pub extend WireBlockResponse with Eq::{equal, not_equal}

///|
pub extend WireBlockResponse with @moonbitlang/core/debug.Debug::{to_repr}

///|
pub fn WireBlockRequest::to_json(self : WireBlockRequest) -> Json {
  let map : Map[String, Json] = Map([])
  set_str(map, "deviceId", self.device_id)
  set_str(map, "path", self.path)
  set_opt_u64(map, "blockIndex", Some(self.block_index))
  set_str(map, "hash", self.hash)
  set_opt_bool(map, "priority", self.priority)
  set_opt_bool(map, "cdc", self.cdc)
  Json::object(map)
}

///|
pub fn WireBlockRequest::from_json(
  value : Json,
) -> WireBlockRequest raise WireError {
  WireBlockRequest::from_map(expect_object(value, "块请求"))
}

///|
fn WireBlockRequest::from_map(
  obj : Map[String, Json],
) -> WireBlockRequest raise WireError {
  {
    device_id: req_str(obj, "deviceId"),
    path: req_str(obj, "path"),
    block_index: req_u64(obj, "blockIndex"),
    hash: req_str(obj, "hash"),
    priority: opt_bool(obj, "priority"),
    cdc: opt_bool(obj, "cdc"),
  }
}

///|
pub fn WireBlockResponse::to_json(self : WireBlockResponse) -> Json {
  let map : Map[String, Json] = Map([])
  set_str(map, "deviceId", self.device_id)
  set_str(map, "path", self.path)
  set_opt_u64(map, "blockIndex", Some(self.block_index))
  set_str(map, "hash", self.hash)
  set_str(map, "data", self.data)
  set_opt_bool(map, "cdc", self.cdc)
  Json::object(map)
}

///|
pub fn WireBlockResponse::from_json(
  value : Json,
) -> WireBlockResponse raise WireError {
  WireBlockResponse::from_map(expect_object(value, "块响应"))
}

///|
fn WireBlockResponse::from_map(
  obj : Map[String, Json],
) -> WireBlockResponse raise WireError {
  {
    device_id: req_str(obj, "deviceId"),
    path: req_str(obj, "path"),
    block_index: req_u64(obj, "blockIndex"),
    hash: req_str(obj, "hash"),
    data: req_str(obj, "data"),
    cdc: opt_bool(obj, "cdc"),
  }
}

// ==================== 控制面消息 ====================

///|
/// 与同步数据无关的「控制面」消息:设备配对、目录共享邀请、版本宣告、
/// 内容对比取数、git 提交同步、投递回执等。它们不绑定某个共享目录,
/// 由接收方路由到全局处理器(而非按 folder 找 SyncPeer)。
///
/// 线上格式:顶层 `kind` 判别字段(kebab-case),字段名 camelCase
/// (`offerId`/`fromDeviceId`/`entryVersion`…)。未知 `kind` 解析抛错,
/// 由调用方整条跳过 —— 旧对端会发本端不认识的 kind,连接不能被它掀翻。
pub(all) enum ControlMessage {
  /// offerId
  FolderInvitation(
    offer_id~ : String,
    /// fromDeviceId
    from_device_id~ : String,
    /// folderId
    folder_id~ : String,
    /// folderName
    folder_name~ : String,
    version~ : String?,
    hostname~ : String?,
    platform~ : String?,
    runtime~ : String?
  )
  /// offerId
  FolderInvitationAck(
    offer_id~ : String,
    /// fromDeviceId
    from_device_id~ : String,
    accepted~ : Bool,
    version~ : String?,
    hostname~ : String?,
    platform~ : String?,
    runtime~ : String?
  )
  /// offerId
  PairingRequest(
    offer_id~ : String,
    /// fromDeviceId
    from_device_id~ : String,
    version~ : String?,
    hostname~ : String?,
    platform~ : String?,
    runtime~ : String?
  )
  /// offerId
  PairingAck(
    offer_id~ : String,
    /// fromDeviceId
    from_device_id~ : String,
    accepted~ : Bool,
    version~ : String?,
    hostname~ : String?,
    platform~ : String?,
    runtime~ : String?
  )
  /// 邀请投递回执(控制面「至少一次」的第二道锁):接收方**处理了**
  /// folder-invitation / pairing-request(无论新建待确认、去重命中还是已互信
  /// 跳过)即回此帧,与用户是否决策无关 —— 用户决策走 `*-ack`,可能迟到很久,
  /// 不能驱动重发。发送方(OfferRetryLedger)据此销账。
  /// offerId
  OfferReceipt(
    offer_id~ : String,
    /// fromDeviceId
    from_device_id~ : String,
    version~ : String?,
    hostname~ : String?,
    platform~ : String?,
    runtime~ : String?
  )
  /// 会话建立与共享关系变更时互发的「本机当前与你在同步的目录清单」。
  /// pending_folder_ids:本机仍待确认的、来自对方的目录邀请 id 集合。
  /// fromDeviceId
  FolderSyncList(
    from_device_id~ : String,
    /// folderIds
    folder_ids~ : Array[String],
    /// pendingFolderIds
    pending_folder_ids~ : Array[String]?,
    version~ : String?,
    hostname~ : String?,
    platform~ : String?,
    runtime~ : String?
  )
  /// 会话建立时互发的版本宣告。dev 态(src 直跑)version 为 "dev"。
  /// fromDeviceId
  Hello(
    from_device_id~ : String,
    version~ : String,
    hostname~ : String?,
    platform~ : String?,
    runtime~ : String?
  )
  /// 请求对端的自身安装包(tgz,整包),用于「版本低于对方时从对方升级」。
  /// 仅经握手签名校验过的会话可发。
  /// requestId
  SelfBinaryRequest(
    request_id~ : String,
    /// fromDeviceId
    from_device_id~ : String,
    version~ : String?,
    hostname~ : String?,
    platform~ : String?,
    runtime~ : String?
  )
  /// 对端安装包回传:base64 的整包 tgz + 内容 sha256 指纹;
  /// data 缺省 = 对端无法提供(dev 态或打包失败)。
  /// requestId
  SelfBinaryResponse(
    request_id~ : String,
    /// fromDeviceId
    from_device_id~ : String,
    version~ : String,
    sha256~ : String,
    data~ : String?,
    hostname~ : String?,
    platform~ : String?,
    runtime~ : String?
  )
  /// 内容对比:请求对端把它某个共享目录的索引快照发过来。**全程只读** ——
  /// 不改动任何一端的状态、不触发索引交换(诊断工具不该扰动被观察的系统)。
  /// requestId
  FolderIndexRequest(
    request_id~ : String,
    /// fromDeviceId
    from_device_id~ : String,
    /// folderId
    folder_id~ : String,
    version~ : String?,
    hostname~ : String?,
    platform~ : String?,
    runtime~ : String?
  )
  /// 索引快照分片:seq 从 0 开始,total 为总片数。ignore_lines 与 progress
  /// 每片都带(体量远小于条目本身,冗余一点换「不依赖首片必达」的简单性)。
  /// error 非空表示对端无法提供,此时 entries 缺省。
  /// requestId
  FolderIndexSnapshot(
    request_id~ : String,
    /// fromDeviceId
    from_device_id~ : String,
    /// folderId
    folder_id~ : String,
    seq~ : Int64,
    total~ : Int64,
    entries~ : String?,
    error~ : String?,
    /// ignoreLines
    ignore_lines~ : Array[String]?,
    progress~ : Json?,
    version~ : String?,
    hostname~ : String?,
    platform~ : String?,
    runtime~ : String?
  )
  /// 双栏对比页:向对端索取它某个共享目录里**单个文件的内容**(只读)。
  /// requestId
  FileContentRequest(
    request_id~ : String,
    /// fromDeviceId
    from_device_id~ : String,
    /// folderId
    folder_id~ : String,
    path~ : String,
    version~ : String?,
    hostname~ : String?,
    platform~ : String?,
    runtime~ : String?
  )
  /// 文件内容回传。data 为 base64;error 非空表示对端无法提供,此时 data 缺省。
  /// entry_version 是对端该条目的**版本向量** —— 字段名刻意用 `entryVersion`
  /// 避开 `version`(= syncx 运行版本):两者混用会让读代码的人把版本向量
  /// 当成软件版本号。
  /// requestId
  FileContentResponse(
    request_id~ : String,
    /// fromDeviceId
    from_device_id~ : String,
    /// folderId
    folder_id~ : String,
    path~ : String,
    data~ : String?,
    size~ : Int64?,
    /// entryVersion
    entry_version~ : Array[(String, Int64)]?,
    error~ : String?,
    version~ : String?,
    hostname~ : String?,
    platform~ : String?,
    runtime~ : String?
  )
  /// 双栏对比页的「把本机内容推到对端」:请对端按给定内容落盘,并**采纳给定
  /// 版本**(采纳外部版本让两端版本向量可控地对齐,否则对端下一轮扫描会把
  /// 刚写入的内容判成「本机新编辑」再推回来)。
  /// requestId
  FileContentWrite(
    request_id~ : String,
    /// fromDeviceId
    from_device_id~ : String,
    /// folderId
    folder_id~ : String,
    path~ : String,
    data~ : String,
    /// entryVersion
    entry_version~ : Array[(String, Int64)],
    version~ : String?,
    hostname~ : String?,
    platform~ : String?,
    runtime~ : String?
  )
  /// requestId
  FileContentWriteResult(
    request_id~ : String,
    /// fromDeviceId
    from_device_id~ : String,
    /// folderId
    folder_id~ : String,
    path~ : String,
    ok~ : Bool,
    error~ : String?,
    version~ : String?,
    hostname~ : String?,
    platform~ : String?,
    runtime~ : String?
  )
  /// Git 提交同步:本机在某共享目录检测到新提交,通知对端也执行自动提交。
  /// commit_hash 用于去重;changed_files 与 diff_stat 仅用于日志展示;
  /// commit_subjects 是本批次全部提交的 subject(旧→新,可缺省 = 旧版/单笔)。
  /// 完成镜像提交的对端会把这条通知**原样中继**给它该目录的其余对端。
  /// fromDeviceId
  GitCommitNotify(
    from_device_id~ : String,
    /// folderId
    folder_id~ : String,
    /// commitHash
    commit_hash~ : String,
    /// commitMessage
    commit_message~ : String,
    /// changedFiles
    changed_files~ : Array[String],
    /// diffStat
    diff_stat~ : String?,
    /// commitSubjects
    commit_subjects~ : Array[String]?,
    /// parentHash
    parent_hash~ : String,
    version~ : String?,
    hostname~ : String?,
    platform~ : String?,
    runtime~ : String?
  )
  /// Git 提交通知的投递回执:接收方只要**处理了**这条通知就立刻回此帧,
  /// 与它随后有没有落成一笔镜像提交无关。commit_hash 是通知里那笔原始提交的
  /// 哈希(中继不改写),发送方按它匹配逐目标台账。
  /// fromDeviceId
  GitCommitAck(
    from_device_id~ : String,
    /// folderId
    folder_id~ : String,
    /// commitHash
    commit_hash~ : String,
    version~ : String?,
    hostname~ : String?,
    platform~ : String?,
    runtime~ : String?
  )
} derive(Eq, Debug)

///|
pub extend ControlMessage with Eq::{equal, not_equal}

///|
pub extend ControlMessage with @moonbitlang/core/debug.Debug::{to_repr}

///|
pub fn ControlMessage::to_json(self : ControlMessage) -> Json {
  match self {
    FolderInvitation(
      offer_id~,
      from_device_id~,
      folder_id~,
      folder_name~,
      version~,
      hostname~,
      platform~,
      runtime~
    ) => {
      let map : Map[String, Json] = Map([])
      set_str(map, "kind", "folder-invitation")
      set_str(map, "offerId", offer_id)
      set_str(map, "fromDeviceId", from_device_id)
      set_str(map, "folderId", folder_id)
      set_str(map, "folderName", folder_name)
      set_self_info(map, version, hostname, platform, runtime)
      Json::object(map)
    }
    FolderInvitationAck(
      offer_id~,
      from_device_id~,
      accepted~,
      version~,
      hostname~,
      platform~,
      runtime~
    ) => {
      let map : Map[String, Json] = Map([])
      set_str(map, "kind", "folder-invitation-ack")
      set_str(map, "offerId", offer_id)
      set_str(map, "fromDeviceId", from_device_id)
      set_opt_bool(map, "accepted", Some(accepted))
      set_self_info(map, version, hostname, platform, runtime)
      Json::object(map)
    }
    PairingRequest(
      offer_id~,
      from_device_id~,
      version~,
      hostname~,
      platform~,
      runtime~
    ) => {
      let map : Map[String, Json] = Map([])
      set_str(map, "kind", "pairing-request")
      set_str(map, "offerId", offer_id)
      set_str(map, "fromDeviceId", from_device_id)
      set_self_info(map, version, hostname, platform, runtime)
      Json::object(map)
    }
    PairingAck(
      offer_id~,
      from_device_id~,
      accepted~,
      version~,
      hostname~,
      platform~,
      runtime~
    ) => {
      let map : Map[String, Json] = Map([])
      set_str(map, "kind", "pairing-ack")
      set_str(map, "offerId", offer_id)
      set_str(map, "fromDeviceId", from_device_id)
      set_opt_bool(map, "accepted", Some(accepted))
      set_self_info(map, version, hostname, platform, runtime)
      Json::object(map)
    }
    OfferReceipt(
      offer_id~,
      from_device_id~,
      version~,
      hostname~,
      platform~,
      runtime~
    ) => {
      let map : Map[String, Json] = Map([])
      set_str(map, "kind", "offer-receipt")
      set_str(map, "offerId", offer_id)
      set_str(map, "fromDeviceId", from_device_id)
      set_self_info(map, version, hostname, platform, runtime)
      Json::object(map)
    }
    FolderSyncList(
      from_device_id~,
      folder_ids~,
      pending_folder_ids~,
      version~,
      hostname~,
      platform~,
      runtime~
    ) => {
      let map : Map[String, Json] = Map([])
      set_str(map, "kind", "folder-sync-list")
      set_str(map, "fromDeviceId", from_device_id)
      set_str_array(map, "folderIds", folder_ids)
      set_opt_str_array(map, "pendingFolderIds", pending_folder_ids)
      set_self_info(map, version, hostname, platform, runtime)
      Json::object(map)
    }
    Hello(from_device_id~, version~, hostname~, platform~, runtime~) => {
      let map : Map[String, Json] = Map([])
      set_str(map, "kind", "hello")
      set_str(map, "fromDeviceId", from_device_id)
      set_str(map, "version", version)
      set_self_info(map, None, hostname, platform, runtime)
      Json::object(map)
    }
    SelfBinaryRequest(
      request_id~,
      from_device_id~,
      version~,
      hostname~,
      platform~,
      runtime~
    ) => {
      let map : Map[String, Json] = Map([])
      set_str(map, "kind", "self-binary-request")
      set_str(map, "requestId", request_id)
      set_str(map, "fromDeviceId", from_device_id)
      set_self_info(map, version, hostname, platform, runtime)
      Json::object(map)
    }
    SelfBinaryResponse(
      request_id~,
      from_device_id~,
      version~,
      sha256~,
      data~,
      hostname~,
      platform~,
      runtime~
    ) => {
      let map : Map[String, Json] = Map([])
      set_str(map, "kind", "self-binary-response")
      set_str(map, "requestId", request_id)
      set_str(map, "fromDeviceId", from_device_id)
      set_str(map, "version", version)
      set_str(map, "sha256", sha256)
      set_opt_str(map, "data", data)
      set_opt_str(map, "hostname", hostname)
      set_opt_str(map, "platform", platform)
      set_opt_str(map, "runtime", runtime)
      Json::object(map)
    }
    FolderIndexRequest(
      request_id~,
      from_device_id~,
      folder_id~,
      version~,
      hostname~,
      platform~,
      runtime~
    ) => {
      let map : Map[String, Json] = Map([])
      set_str(map, "kind", "folder-index-request")
      set_str(map, "requestId", request_id)
      set_str(map, "fromDeviceId", from_device_id)
      set_str(map, "folderId", folder_id)
      set_self_info(map, version, hostname, platform, runtime)
      Json::object(map)
    }
    FolderIndexSnapshot(
      request_id~,
      from_device_id~,
      folder_id~,
      seq~,
      total~,
      entries~,
      error~,
      ignore_lines~,
      progress~,
      version~,
      hostname~,
      platform~,
      runtime~
    ) => {
      let map : Map[String, Json] = Map([])
      set_str(map, "kind", "folder-index-snapshot")
      set_str(map, "requestId", request_id)
      set_str(map, "fromDeviceId", from_device_id)
      set_str(map, "folderId", folder_id)
      set_opt_u64(map, "seq", Some(seq))
      set_opt_u64(map, "total", Some(total))
      set_opt_str(map, "entries", entries)
      set_opt_str(map, "error", error)
      set_opt_str_array(map, "ignoreLines", ignore_lines)
      match progress {
        Some(p) => map.set("progress", p)
        None => ()
      }
      set_self_info(map, version, hostname, platform, runtime)
      Json::object(map)
    }
    FileContentRequest(
      request_id~,
      from_device_id~,
      folder_id~,
      path~,
      version~,
      hostname~,
      platform~,
      runtime~
    ) => {
      let map : Map[String, Json] = Map([])
      set_str(map, "kind", "file-content-request")
      set_str(map, "requestId", request_id)
      set_str(map, "fromDeviceId", from_device_id)
      set_str(map, "folderId", folder_id)
      set_str(map, "path", path)
      set_self_info(map, version, hostname, platform, runtime)
      Json::object(map)
    }
    FileContentResponse(
      request_id~,
      from_device_id~,
      folder_id~,
      path~,
      data~,
      size~,
      entry_version~,
      error~,
      version~,
      hostname~,
      platform~,
      runtime~
    ) => {
      let map : Map[String, Json] = Map([])
      set_str(map, "kind", "file-content-response")
      set_str(map, "requestId", request_id)
      set_str(map, "fromDeviceId", from_device_id)
      set_str(map, "folderId", folder_id)
      set_str(map, "path", path)
      set_opt_str(map, "data", data)
      set_opt_u64(map, "size", size)
      set_opt_version(map, "entryVersion", entry_version)
      set_opt_str(map, "error", error)
      set_self_info(map, version, hostname, platform, runtime)
      Json::object(map)
    }
    FileContentWrite(
      request_id~,
      from_device_id~,
      folder_id~,
      path~,
      data~,
      entry_version~,
      version~,
      hostname~,
      platform~,
      runtime~
    ) => {
      let map : Map[String, Json] = Map([])
      set_str(map, "kind", "file-content-write")
      set_str(map, "requestId", request_id)
      set_str(map, "fromDeviceId", from_device_id)
      set_str(map, "folderId", folder_id)
      set_str(map, "path", path)
      set_str(map, "data", data)
      set_opt_version(map, "entryVersion", Some(entry_version))
      set_self_info(map, version, hostname, platform, runtime)
      Json::object(map)
    }
    FileContentWriteResult(
      request_id~,
      from_device_id~,
      folder_id~,
      path~,
      ok~,
      error~,
      version~,
      hostname~,
      platform~,
      runtime~
    ) => {
      let map : Map[String, Json] = Map([])
      set_str(map, "kind", "file-content-write-result")
      set_str(map, "requestId", request_id)
      set_str(map, "fromDeviceId", from_device_id)
      set_str(map, "folderId", folder_id)
      set_str(map, "path", path)
      set_opt_bool(map, "ok", Some(ok))
      set_opt_str(map, "error", error)
      set_self_info(map, version, hostname, platform, runtime)
      Json::object(map)
    }
    GitCommitNotify(
      from_device_id~,
      folder_id~,
      commit_hash~,
      commit_message~,
      changed_files~,
      diff_stat~,
      commit_subjects~,
      parent_hash~,
      version~,
      hostname~,
      platform~,
      runtime~
    ) => {
      let map : Map[String, Json] = Map([])
      set_str(map, "kind", "git-commit-notify")
      set_str(map, "fromDeviceId", from_device_id)
      set_str(map, "folderId", folder_id)
      set_str(map, "commitHash", commit_hash)
      set_str(map, "commitMessage", commit_message)
      set_str_array(map, "changedFiles", changed_files)
      set_opt_str(map, "diffStat", diff_stat)
      set_opt_str_array(map, "commitSubjects", commit_subjects)
      set_str(map, "parentHash", parent_hash)
      set_self_info(map, version, hostname, platform, runtime)
      Json::object(map)
    }
    GitCommitAck(
      from_device_id~,
      folder_id~,
      commit_hash~,
      version~,
      hostname~,
      platform~,
      runtime~
    ) => {
      let map : Map[String, Json] = Map([])
      set_str(map, "kind", "git-commit-ack")
      set_str(map, "fromDeviceId", from_device_id)
      set_str(map, "folderId", folder_id)
      set_str(map, "commitHash", commit_hash)
      set_self_info(map, version, hostname, platform, runtime)
      Json::object(map)
    }
  }
}

///|
pub fn ControlMessage::from_json(
  value : Json,
) -> ControlMessage raise WireError {
  ControlMessage::from_map(expect_object(value, "控制面消息"))
}

///|
fn ControlMessage::from_map(
  obj : Map[String, Json],
) -> ControlMessage raise WireError {
  let kind = req_str(obj, "kind")
  match kind {
    "folder-invitation" => {
      let (version, hostname, platform, runtime) = opt_self_info(obj)
      FolderInvitation(
        offer_id=req_str(obj, "offerId"),
        from_device_id=req_str(obj, "fromDeviceId"),
        folder_id=req_str(obj, "folderId"),
        folder_name=req_str(obj, "folderName"),
        version~,
        hostname~,
        platform~,
        runtime~,
      )
    }
    "folder-invitation-ack" => {
      let (version, hostname, platform, runtime) = opt_self_info(obj)
      FolderInvitationAck(
        offer_id=req_str(obj, "offerId"),
        from_device_id=req_str(obj, "fromDeviceId"),
        accepted=req_bool(obj, "accepted"),
        version~,
        hostname~,
        platform~,
        runtime~,
      )
    }
    "pairing-request" => {
      let (version, hostname, platform, runtime) = opt_self_info(obj)
      PairingRequest(
        offer_id=req_str(obj, "offerId"),
        from_device_id=req_str(obj, "fromDeviceId"),
        version~,
        hostname~,
        platform~,
        runtime~,
      )
    }
    "pairing-ack" => {
      let (version, hostname, platform, runtime) = opt_self_info(obj)
      PairingAck(
        offer_id=req_str(obj, "offerId"),
        from_device_id=req_str(obj, "fromDeviceId"),
        accepted=req_bool(obj, "accepted"),
        version~,
        hostname~,
        platform~,
        runtime~,
      )
    }
    "offer-receipt" => {
      let (version, hostname, platform, runtime) = opt_self_info(obj)
      OfferReceipt(
        offer_id=req_str(obj, "offerId"),
        from_device_id=req_str(obj, "fromDeviceId"),
        version~,
        hostname~,
        platform~,
        runtime~,
      )
    }
    "folder-sync-list" => {
      let (version, hostname, platform, runtime) = opt_self_info(obj)
      FolderSyncList(
        from_device_id=req_str(obj, "fromDeviceId"),
        folder_ids=req_str_array(obj, "folderIds"),
        pending_folder_ids=opt_str_array(obj, "pendingFolderIds"),
        version~,
        hostname~,
        platform~,
        runtime~,
      )
    }
    "hello" => {
      let (_, hostname, platform, runtime) = opt_self_info(obj)
      Hello(
        from_device_id=req_str(obj, "fromDeviceId"),
        version=req_str(obj, "version"),
        hostname~,
        platform~,
        runtime~,
      )
    }
    "self-binary-request" => {
      let (version, hostname, platform, runtime) = opt_self_info(obj)
      SelfBinaryRequest(
        request_id=req_str(obj, "requestId"),
        from_device_id=req_str(obj, "fromDeviceId"),
        version~,
        hostname~,
        platform~,
        runtime~,
      )
    }
    "self-binary-response" => {
      let (_, hostname, platform, runtime) = opt_self_info(obj)
      SelfBinaryResponse(
        request_id=req_str(obj, "requestId"),
        from_device_id=req_str(obj, "fromDeviceId"),
        version=req_str(obj, "version"),
        sha256=req_str(obj, "sha256"),
        data=opt_str(obj, "data"),
        hostname~,
        platform~,
        runtime~,
      )
    }
    "folder-index-request" => {
      let (version, hostname, platform, runtime) = opt_self_info(obj)
      FolderIndexRequest(
        request_id=req_str(obj, "requestId"),
        from_device_id=req_str(obj, "fromDeviceId"),
        folder_id=req_str(obj, "folderId"),
        version~,
        hostname~,
        platform~,
        runtime~,
      )
    }
    "folder-index-snapshot" => {
      let (version, hostname, platform, runtime) = opt_self_info(obj)
      FolderIndexSnapshot(
        request_id=req_str(obj, "requestId"),
        from_device_id=req_str(obj, "fromDeviceId"),
        folder_id=req_str(obj, "folderId"),
        seq=req_u64(obj, "seq"),
        total=req_u64(obj, "total"),
        entries=opt_str(obj, "entries"),
        error=opt_str(obj, "error"),
        ignore_lines=opt_str_array(obj, "ignoreLines"),
        progress=obj.get("progress"),
        version~,
        hostname~,
        platform~,
        runtime~,
      )
    }
    "file-content-request" => {
      let (version, hostname, platform, runtime) = opt_self_info(obj)
      FileContentRequest(
        request_id=req_str(obj, "requestId"),
        from_device_id=req_str(obj, "fromDeviceId"),
        folder_id=req_str(obj, "folderId"),
        path=req_str(obj, "path"),
        version~,
        hostname~,
        platform~,
        runtime~,
      )
    }
    "file-content-response" => {
      let (version, hostname, platform, runtime) = opt_self_info(obj)
      FileContentResponse(
        request_id=req_str(obj, "requestId"),
        from_device_id=req_str(obj, "fromDeviceId"),
        folder_id=req_str(obj, "folderId"),
        path=req_str(obj, "path"),
        data=opt_str(obj, "data"),
        size=opt_u64(obj, "size"),
        entry_version=opt_version(obj, "entryVersion"),
        error=opt_str(obj, "error"),
        version~,
        hostname~,
        platform~,
        runtime~,
      )
    }
    "file-content-write" => {
      let (version, hostname, platform, runtime) = opt_self_info(obj)
      FileContentWrite(
        request_id=req_str(obj, "requestId"),
        from_device_id=req_str(obj, "fromDeviceId"),
        folder_id=req_str(obj, "folderId"),
        path=req_str(obj, "path"),
        data=req_str(obj, "data"),
        entry_version=req_version(obj, "entryVersion"),
        version~,
        hostname~,
        platform~,
        runtime~,
      )
    }
    "file-content-write-result" => {
      let (version, hostname, platform, runtime) = opt_self_info(obj)
      FileContentWriteResult(
        request_id=req_str(obj, "requestId"),
        from_device_id=req_str(obj, "fromDeviceId"),
        folder_id=req_str(obj, "folderId"),
        path=req_str(obj, "path"),
        ok=req_bool(obj, "ok"),
        error=opt_str(obj, "error"),
        version~,
        hostname~,
        platform~,
        runtime~,
      )
    }
    "git-commit-notify" => {
      let (version, hostname, platform, runtime) = opt_self_info(obj)
      GitCommitNotify(
        from_device_id=req_str(obj, "fromDeviceId"),
        folder_id=req_str(obj, "folderId"),
        commit_hash=req_str(obj, "commitHash"),
        commit_message=req_str(obj, "commitMessage"),
        changed_files=req_str_array(obj, "changedFiles"),
        diff_stat=opt_str(obj, "diffStat"),
        commit_subjects=opt_str_array(obj, "commitSubjects"),
        parent_hash=req_str(obj, "parentHash"),
        version~,
        hostname~,
        platform~,
        runtime~,
      )
    }
    "git-commit-ack" => {
      let (version, hostname, platform, runtime) = opt_self_info(obj)
      GitCommitAck(
        from_device_id=req_str(obj, "fromDeviceId"),
        folder_id=req_str(obj, "folderId"),
        commit_hash=req_str(obj, "commitHash"),
        version~,
        hostname~,
        platform~,
        runtime~,
      )
    }
    _ => raise Malformed("未知控制面消息 kind:\{kind}")
  }
}

// ==================== 顶层 wire 消息 ====================

///|
/// 顶层 wire 消息(文本信封的明文体)。`index` 的 `full` 刻意做成 `Bool?`
/// 而不是 `Bool`,让「缺省」这一状态在类型上就可见,调用方必须显式决定
/// 怎么解释它(见文件头第 1 条)。
pub(all) enum WireMessage {
  Index(
    folder~ : String,
    /// 索引条目清单的 JSON(base64 后的字符串;二进制信封里是裸 body)
    payload~ : String,
    /// true = 本机索引的完整快照;缺省/Some(false) = 仅本轮改动
    full~ : Bool?,
    relayed~ : Bool?
  )
  IndexFingerprint(folder~ : String, fingerprint~ : String)
  IndexAck(folder~ : String)
  IndexRequest(folder~ : String)
  BlockRequest(folder~ : String, payload~ : WireBlockRequest)
  BlockResponse(folder~ : String, payload~ : WireBlockResponse)
  Control(payload~ : ControlMessage)
} derive(Eq, Debug)

///|
pub extend WireMessage with Eq::{equal, not_equal}

///|
pub extend WireMessage with @moonbitlang/core/debug.Debug::{to_repr}

///|
/// 这条索引消息是否应当按**全量**语义规划。
///
/// 唯一正确的读法:**只有明确 `full == Some(true)` 才是全量**。`None`(旧对端)
/// 与 `Some(false)` 都按增量处理,否则两端会无限互推。
pub fn WireMessage::is_full_index(self : WireMessage) -> Bool {
  match self {
    Index(full~, ..) => full == Some(true)
    _ => false
  }
}

///|
pub fn WireMessage::to_json(self : WireMessage) -> Json {
  match self {
    Index(folder~, payload~, full~, relayed~) => {
      let map : Map[String, Json] = Map([])
      set_str(map, "type", "index")
      set_str(map, "folder", folder)
      set_str(map, "payload", payload)
      set_opt_bool(map, "full", full)
      set_opt_bool(map, "relayed", relayed)
      Json::object(map)
    }
    IndexFingerprint(folder~, fingerprint~) => {
      let map : Map[String, Json] = Map([])
      set_str(map, "type", "index-fingerprint")
      set_str(map, "folder", folder)
      set_str(map, "fingerprint", fingerprint)
      Json::object(map)
    }
    IndexAck(folder~) => {
      let map : Map[String, Json] = Map([])
      set_str(map, "type", "index-ack")
      set_str(map, "folder", folder)
      Json::object(map)
    }
    IndexRequest(folder~) => {
      let map : Map[String, Json] = Map([])
      set_str(map, "type", "index-request")
      set_str(map, "folder", folder)
      Json::object(map)
    }
    BlockRequest(folder~, payload~) => {
      let map : Map[String, Json] = Map([])
      set_str(map, "type", "block-request")
      set_str(map, "folder", folder)
      map.set("payload", payload.to_json())
      Json::object(map)
    }
    BlockResponse(folder~, payload~) => {
      let map : Map[String, Json] = Map([])
      set_str(map, "type", "block-response")
      set_str(map, "folder", folder)
      map.set("payload", payload.to_json())
      Json::object(map)
    }
    Control(payload~) => {
      let map : Map[String, Json] = Map([])
      set_str(map, "type", "control")
      map.set("payload", payload.to_json())
      Json::object(map)
    }
  }
}

///|
pub fn WireMessage::from_json(value : Json) -> WireMessage raise WireError {
  let obj = expect_object(value, "wire 消息")
  match req_str(obj, "type") {
    "index" =>
      Index(
        folder=req_str(obj, "folder"),
        payload=req_str(obj, "payload"),
        full=opt_bool(obj, "full"),
        relayed=opt_bool(obj, "relayed"),
      )
    "index-fingerprint" =>
      IndexFingerprint(
        folder=req_str(obj, "folder"),
        fingerprint=req_str(obj, "fingerprint"),
      )
    "index-ack" => IndexAck(folder=req_str(obj, "folder"))
    "index-request" => IndexRequest(folder=req_str(obj, "folder"))
    "block-request" =>
      BlockRequest(
        folder=req_str(obj, "folder"),
        payload=WireBlockRequest::from_map(req_obj(obj, "payload")),
      )
    "block-response" =>
      BlockResponse(
        folder=req_str(obj, "folder"),
        payload=WireBlockResponse::from_map(req_obj(obj, "payload")),
      )
    "control" =>
      Control(payload=ControlMessage::from_map(req_obj(obj, "payload")))
    ty => raise Malformed("未知消息类型 \{ty}")
  }
}

///|
/// 文本信封编码。
pub fn encode_wire_message(message : WireMessage) -> String {
  message.to_json().stringify()
}

///|
/// 文本信封解码。畸形消息抛错,由调用方丢弃 —— 线上数据不可信,
/// 不能像 Node 那样 `JSON.parse` 后直接当合法类型用。
pub fn decode_wire_message(raw : String) -> WireMessage raise WireError {
  let json = @json.parse(raw) catch {
    e => raise Malformed("不是合法 JSON:\{e}")
  }
  WireMessage::from_json(json)
}
