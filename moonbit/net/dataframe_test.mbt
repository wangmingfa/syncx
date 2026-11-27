///|
/// 数据面帧的翻译层(`net/dataframe.mbt`)测试。
///
/// 两条主线:
///  1. **与 Node 逐字节对拍** —— fixture 由 `moonbit/scripts/gen-envelope-fixture.mjs`
///     用真实的 `encodeIndex` / `encodeBinaryFrameWithIv` 生成。解出来再封回去必须
///     逐字节相同:这既钉住帧头字段与键序,也证明反向(Node 能解 MoonBit 的帧)成立。
///  2. **形状校验** —— 缺 folder、缺 blockIndex、未协商的分片索引一律丢弃。这些
///     分支不会出现在正常链路上,但正是「字段少一个就静默同步不动」的来源。

///|
fn df_key() -> Bytes {
  @hex.decode(@net.envelope_fixture_key_hex()) catch { _ => panic() }
}

///|
fn df_hex(text : String) -> Bytes {
  @hex.decode(text) catch { _ => panic() }
}

///|
/// 取「解出来的数据面消息」;不是 Data 就是测试失败。
fn df_data(inbound : @net.BinaryInbound) -> @net.WireMessage {
  match inbound {
    Data(message) => message
    _ => panic()
  }
}

///|
test "dataframe: 与 Node 对拍(索引帧)" {
  let key = df_key()
  let frame = df_hex(@net.envelope_fixture_index_frame_hex())
  let body = df_hex(@net.envelope_fixture_index_body_hex())
  let message = df_data(@net.decode_inbound_binary(Some(key), frame))
  match message {
    Index(folder~, payload~, full~, relayed~) => {
      assert_eq(folder, "/shared/docs")
      // body 是裸索引 JSON;消息层看到的是等价的 base64(文本路径同形)
      assert_eq(payload, @base64.encode(body))
      assert_eq(full, Some(true))
      assert_eq(relayed, Some(false))
    }
    _ => panic()
  }
  // 用同一个 iv 重封:字节必须与 Node 的产物完全相同(钉键序与可选字段)
  let iv = df_hex(@net.envelope_fixture_index_iv_hex())
  match @net.seal_data_frame(key, message, iv) {
    Some(resealed) => assert_true(resealed == frame)
    None => panic()
  }
}

///|
test "dataframe: 与 Node 对拍(块响应帧)" {
  let key = df_key()
  let frame = df_hex(@net.envelope_fixture_block_frame_hex())
  let body = df_hex(@net.envelope_fixture_block_body_hex())
  let message = df_data(@net.decode_inbound_binary(Some(key), frame))
  match message {
    BlockResponse(folder~, payload~) => {
      assert_eq(folder, "/shared/docs")
      assert_eq(payload.device_id, "FIXTUREDEVICE1")
      assert_eq(payload.path, "docs/报告.md")
      assert_eq(payload.block_index, 2L)
      assert_eq(payload.data, @base64.encode(body))
      // 二进制路径的 cdc 恒为布尔(Node 同形),不是「只在 true 时出现」
      assert_eq(payload.cdc, Some(false))
    }
    _ => panic()
  }
  let iv = df_hex(@net.envelope_fixture_block_iv_hex())
  match @net.seal_data_frame(key, message, iv) {
    Some(resealed) => assert_true(resealed == frame)
    None => panic()
  }
}

///|
test "dataframe: 直发分片交给上层(不进 folder 路由)" {
  let key = df_key()
  let frame = df_hex(@net.envelope_fixture_binary_hex())
  match @net.decode_inbound_binary(Some(key), frame) {
    DirectChunk(decoded) =>
      assert_eq(decoded.kind, @net.BINARY_KIND_DIRECT_CHUNK)
    _ => panic()
  }
}

///|
test "dataframe: 只有数据面消息编成二进制帧" {
  let key = df_key()
  let iv = df_hex(@net.envelope_fixture_index_iv_hex())
  // 控制面 / 块请求 / 索引指纹都没有大 body,换信封只多一次拷贝
  for message in [
    @net.Control(payload=@net.make_hello("DEVX", None, None)),
    @net.BlockRequest(
      folder="/f",
      payload={
        device_id: "DEVX",
        path: "a.txt",
        block_index: 0L,
        hash: "h",
        priority: None,
        cdc: None,
      },
    ),
    @net.IndexFingerprint(folder="/f", fingerprint="fp"),
    @net.IndexAck(folder="/f"),
    @net.IndexRequest(folder="/f"),
  ] {
    assert_true(@net.seal_data_frame(key, message, iv) is None)
  }
}

///|
test "dataframe: 路径与块号的形状校验" {
  let key = df_key()
  let iv = df_hex(@net.envelope_fixture_index_iv_hex())
  // 缺 folder:Node 侧会掉进 peers.get('') 的静默丢弃,这里提前挡住
  let no_folder : Map[String, Json] = Map([])
  no_folder.set("full", Json::boolean(true))
  let frame = @net.encode_binary_frame(key, @net.BINARY_KIND_INDEX, no_folder, b"[]") catch { _ => panic() }
  assert_true(@net.decode_inbound_binary(Some(key), frame) is Dropped)
  // 缺 blockIndex:给个默认值会让上层当成「未知块」反复重试,不如当坏帧丢掉
  let no_index : Map[String, Json] = Map([])
  no_index.set("folder", Json::string("/f"))
  let frame = @net.encode_binary_frame(key, @net.BINARY_KIND_BLOCK_RESPONSE, no_index, b"x") catch { _ => panic() }
  assert_true(@net.decode_inbound_binary(Some(key), frame) is Dropped)
  // 未宣告 index-chunk1 的对端不该发分片索引:整帧丢弃,别把一片当整份
  let chunked : Map[String, Json] = Map([])
  chunked.set("folder", Json::string("/f"))
  chunked.set("seq", Json::number(1.0))
  chunked.set("total", Json::number(3.0))
  let frame = @net.encode_binary_frame(key, @net.BINARY_KIND_INDEX, chunked, b"[]") catch { _ => panic() }
  assert_true(@net.decode_inbound_binary(Some(key), frame) is Dropped)
  // 单片的 total=1 等价于整份,照常接收
  let single : Map[String, Json] = Map([])
  single.set("folder", Json::string("/f"))
  single.set("seq", Json::number(0.0))
  single.set("total", Json::number(1.0))
  let frame = @net.encode_binary_frame(key, @net.BINARY_KIND_INDEX, single, b"[]") catch { _ => panic() }
  assert_true(@net.decode_inbound_binary(Some(key), frame) is Data(_))
  let _ = iv
}

///|
test "dataframe: 明文模式没有会话密钥,二进制帧一律丢弃" {
  let frame = df_hex(@net.envelope_fixture_index_frame_hex())
  assert_true(@net.decode_inbound_binary(None, frame) is Dropped)
}

///|
test "dataframe: 索引与块响应往返(带中文路径)" {
  let key = df_key()
  let entries = b"[{\"path\":\"\xe4\xb8\xad\xe6\x96\x87.txt\"}]"
  let index_message = @net.Index(
    folder="/往来/资料",
    payload=@base64.encode(entries),
    full=Some(false),
    relayed=None,
  )
  let frame = match @net.encode_data_frame(key, index_message) {
    Some(frame) => frame
    None => panic()
  }
  match @net.decode_inbound_binary(Some(key), frame) {
    Data(Index(folder~, payload~, full~, relayed~)) => {
      assert_eq(folder, "/往来/资料")
      assert_true(payload == @base64.encode(entries))
      // relayed 缺省 → 二进制路径归一成 false(语义等价,线上一律带布尔)
      assert_eq(full, Some(false))
      assert_eq(relayed, Some(false))
    }
    _ => panic()
  }
  let block_message = @net.BlockResponse(
    folder="/往来/资料",
    payload={
      device_id: "DEVA",
      path: "中文.txt",
      block_index: 0L,
      hash: "h",
      data: @base64.encode(b"hello"),
      cdc: Some(true),
    },
  )
  let frame2 = match @net.encode_data_frame(key, block_message) {
    Some(frame) => frame
    None => panic()
  }
  match @net.decode_inbound_binary(Some(key), frame2) {
    Data(BlockResponse(folder~, payload~)) => {
      assert_eq(folder, "/往来/资料")
      assert_eq(payload.path, "中文.txt")
      assert_true(payload.data == @base64.encode(b"hello"))
      assert_eq(payload.cdc, Some(true))
    }
    _ => panic()
  }
}
