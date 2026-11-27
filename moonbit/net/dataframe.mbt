///|
/// 数据面帧的二进制形态:索引与块响应。
///
/// **为什么要有这一层**:文本信封要把块字节先 base64(填 `data` 字段)、再把整条
/// JSON 加密后 base64,线体积约 **1.78 倍**;二进制信封把裸字节直接当 body,
/// 约 **1.0 倍**。大块传输(256KB 一块、几十上百块)的差距是实打实的带宽与
/// 内存拷贝,Node 与 Rust 早就切过去了。
///
/// 分工与 Node `src/net/wire.ts` 的 `encodeIndexFrame` / `sendBlockResponse`
/// 一致:只换**编码方式**,不换语义 —— 帧头里放定位用的元数据,body 放裸字节。
/// 接收侧解出来后翻译成与文本路径**等价**的 `WireMessage`,所以 actor/daemon
/// 层完全不必知道对端用的是哪种信封(这一步的代价是入站多做一次 base64,
/// 换来线体积降 44%;要让 actor 直吃 `Bytes` 需改 `WireBlockResponse`,留待后续)。
///
/// 帧种类编号与 Node `BINARY_KIND_TO_BYTE`、Rust `BinaryFrameKind` 同值 ——
/// 1 块响应、2 索引、3 直发文件分片。
pub const BINARY_KIND_BLOCK_RESPONSE : Int = 1

///|
pub const BINARY_KIND_INDEX : Int = 2

///|
pub const BINARY_KIND_DIRECT_CHUNK : Int = 3

///|
/// 入站二进制帧的去向。
///
/// 分三类而不是「返回 WireMessage?」:直发分片不属于任何共享目录,不能被翻译
/// 成 wire 消息(它会掉进 `folder` 路由的静默丢弃),必须原样交给上层;而坏帧
/// 与它必须区分开 —— 混在一起时日志里会看不出「对端发了个我不认识的帧」。
pub(all) enum BinaryInbound {
  /// 数据面消息(索引 / 块响应),已翻译成与文本路径等价的消息。
  Data(WireMessage)
  /// 直发文件分片(kind 3):不带 folder,原样交给上层。
  DirectChunk(BinaryFrame)
  /// 坏帧 / 形状不合规:丢弃,不断链(对端不可信,与文本路径同策略)。
  Dropped
}

///|
/// 从帧头取字符串(缺失或非字符串一律空串)。
fn header_text(header : Map[String, Json], key : String) -> String {
  match header.get(key) {
    Some(String(value)) => value
    _ => ""
  }
}

///|
/// 从帧头取布尔(缺省 = false,与 Node 的 `=== true` 判定同口径)。
fn header_bool(header : Map[String, Json], key : String) -> Bool {
  match header.get(key) {
    Some(True) => true
    _ => false
  }
}

///|
/// 从帧头取非负整数(缺失/非数/负数一律 None)。
fn header_u64(header : Map[String, Json], key : String) -> Int64? {
  match header.get(key) {
    Some(Number(n, ..)) => if n < 0.0 { None } else { Some(n.to_int64()) }
    _ => None
  }
}

///|
/// 把数据面消息编成二进制帧(确定性 iv,供跨语言对拍与测试)。
///
/// 非数据面消息(控制面 / 块请求 / 索引指纹…)返回 None —— 它们没有大 body,
/// 换信封只多一次拷贝,调用方据此回落文本路径。
///
/// 帧头字段与键序照抄 Node:
///  - 索引 `{folder, full, relayed}`;
///  - 块响应 `{folder, deviceId, path, blockIndex, hash, cdc}`(cdc 恒为布尔,
///    文本路径才是「只在 true 时出现」)。
pub fn seal_data_frame(
  key : Bytes,
  message : WireMessage,
  iv : Bytes,
) -> Bytes? {
  match message {
    Index(folder~, payload~, full~, relayed~) => {
      // payload 是 base64(索引 JSON):二进制路径要的是原始字节
      let body = @base64.decode(payload) catch { _ => return None }
      let header : Map[String, Json] = Map([])
      set_str(header, "folder", folder)
      header.set("full", Json::boolean(full == Some(true)))
      header.set("relayed", Json::boolean(relayed == Some(true)))
      encode_binary_frame_at(key, BINARY_KIND_INDEX, header, body, iv)
    }
    BlockResponse(folder~, payload~) => {
      let body = @base64.decode(payload.data) catch { _ => return None }
      let header : Map[String, Json] = Map([])
      set_str(header, "folder", folder)
      set_str(header, "deviceId", payload.device_id)
      set_str(header, "path", payload.path)
      set_opt_u64(header, "blockIndex", Some(payload.block_index))
      set_str(header, "hash", payload.hash)
      header.set("cdc", Json::boolean(payload.cdc == Some(true)))
      encode_binary_frame_at(key, BINARY_KIND_BLOCK_RESPONSE, header, body, iv)
    }
    _ => None
  }
}

///|
/// 封一帧(确定性 iv 的内层;失败返回 None 而不是抛错 —— 调用方只需要知道
/// 「这条消息编不成二进制帧」,回落文本路径即可)。
fn encode_binary_frame_at(
  key : Bytes,
  kind : Int,
  header : Map[String, Json],
  body : Bytes,
  iv : Bytes,
) -> Bytes? {
  let packed = seal_binary_frame(key, kind, header, body, iv) catch {
    _ => return None
  }
  Some(packed)
}

///|
/// 把数据面消息编成二进制帧(iv 取系统熵源)。
///
/// 编不成(消息不是数据面 / body 的 base64 坏了 / 熵源不可用)返回 None,
/// 调用方回落文本信封 —— **不能**在这里抛错:发送路径上的一个可降级问题
/// 不该让整条连接的动作失败。
pub fn encode_data_frame(
  key : Bytes,
  message : WireMessage,
) -> Bytes? {
  let iv = c_random_bytes(ENVELOPE_IV_LEN)
  if iv.length() != ENVELOPE_IV_LEN {
    return None
  }
  seal_data_frame(key, message, iv)
}

///|
/// 解一帧入站二进制数据:数据面帧翻译成等价消息,直发分片原样交出,坏帧丢弃。
///
/// `session_key` 为 None(明文回环模式)时没有密钥,一律 Dropped ——
/// 明文模式不存在二进制信封。
pub fn decode_inbound_binary(
  session_key : Bytes?,
  frame : Bytes,
) -> BinaryInbound {
  let key = match session_key {
    Some(key) => key
    None => return Dropped
  }
  let decoded = match decode_binary_frame(key, frame) {
    Some(decoded) => decoded
    None => return Dropped
  }
  if decoded.kind == BINARY_KIND_DIRECT_CHUNK {
    return DirectChunk(decoded)
  }
  // 分片索引(header 带 seq/total)本端**没有宣告** index-chunk1,对端不该发;
  // 真收到就整帧丢弃 —— 按非分片处理会把一片当成整份索引,规划出残缺的远端
  // 视图(比丢弃更难查:同步看起来正常,只是有些文件永远不过去)。
  match header_u64(decoded.header, "total") {
    Some(total) =>
      if total > 1 {
        return Dropped
      }
    None => ()
  }
  let folder = header_text(decoded.header, "folder")
  if folder == "" {
    return Dropped
  }
  match decoded.kind {
    BINARY_KIND_INDEX =>
      Data(
        Index(
          folder=folder,
          payload=@base64.encode(decoded.body),
          full=Some(header_bool(decoded.header, "full")),
          relayed=Some(header_bool(decoded.header, "relayed")),
        ),
      )
    BINARY_KIND_BLOCK_RESPONSE => {
      // 块号缺失 = 形状不合规:给个 -1 会让上层当成「未知块」反复重试。
      let block_index = match header_u64(decoded.header, "blockIndex") {
        Some(n) => n
        None => return Dropped
      }
      Data(
        BlockResponse(
          folder=folder,
          payload={
            device_id: header_text(decoded.header, "deviceId"),
            path: header_text(decoded.header, "path"),
            block_index,
            hash: header_text(decoded.header, "hash"),
            data: @base64.encode(decoded.body),
            cdc: Some(header_bool(decoded.header, "cdc")),
          },
        ),
      )
    }
    _ => Dropped
  }
}
