///|
// 直发(ADR-0028)线上格式对拍。fixture 由 moonbit/scripts/gen-direct-fixture.mjs
// 生成,数据源与 Rust 共用 rust/crates/syncx-net/fixtures/direct-wire.json
// (Node 直发线上格式的唯一事实源)。改 src/direct.ts / src/net/wire.ts 的
// 消息字段后必须重跑生成脚本,三后端一起刷新,别只做一边。
//
// 控制消息断言「解码 → 重编码逐字节还原」—— 这同时证明反向可用:字段名、
// 键序、数字格式、可选字段的有无,任何一处对不上,对端只会把消息当成未知
// kind 静默丢掉。分片帧的 iv 随机,只断言「与 Node 同 key 能解开,头与体
// 逐字节一致」(与 Rust fixture 同一策略)。

///|
test "direct wire: Node 的六类控制消息解码后重编码逐字节还原" {
  for pair in @net.direct_wire_controls() {
    let (name, wire) = pair
    let decoded = @net.decode_wire_message(wire) catch {
      e => abort("\{name}: Node wire 解码失败:\{@net.WireError::to_text(e)}")
    }
    assert_eq(@net.encode_wire_message(decoded), wire)
  }
}

///|
test "direct wire: 可选字段的有无与数值精度不走形" {
  for pair in @net.direct_wire_controls() {
    let (name, wire) = pair
    let decoded = @net.decode_wire_message(wire) catch {
      _ => abort("\{name}: 解码失败")
    }
    match (name, decoded) {
      ("text", @net.Control(payload=@net.DirectText(text~, ..))) =>
        // 中文 + 换行 + 引号:钉住 JSON 字符串转义与 UTF-8 多字节不走形
        assert_eq(text, "你好，syncx 直发\n第二行 \"quoted\" & <tag>")
      ("file-offer-batch", @net.Control(payload=@net.DirectFileOffer(size~, batch_id=Some(_), ..))) =>
        assert_eq(size, 3145728L)
      // 该键必须整个不出现,不是 null
      ("file-offer-single", @net.Control(payload=@net.DirectFileOffer(size~, batch_id=None, ..))) =>
        assert_eq(size, 1L)
      // offset 出现 = 断点续传,从该字节数继续
      ("reply-accept-resume", @net.Control(payload=@net.DirectReply(offset=Some(offset), ..))) =>
        assert_eq(offset, 786432L)
      ("reply-accept-fresh", @net.Control(payload=@net.DirectReply(offset=None, reason=None, ..))) => ()
      ("reply-reject", @net.Control(payload=@net.DirectReply(accept=false, reason=Some(_), ..))) => ()
      // 累积水位:seq = 下一个期望的片号
      ("ack", @net.Control(payload=@net.DirectAck(seq~, ..))) => assert_eq(seq, 3L)
      ("cancel", @net.Control(payload=@net.DirectCancel(reason~, ..))) =>
        assert_eq(reason, "30 秒没有进展,已放弃")
      ("result-ok", @net.Control(payload=@net.DirectResult(ok=true, error=None, ..))) => ()
      ("result-fail", @net.Control(payload=@net.DirectResult(ok=false, error=Some(_), ..))) => ()
      (other, _) => abort("fixture 里有测试没覆盖的用例:\{other}")
    }
  }
}

///|
test "direct wire: 分片帧与 Node 同 key 解码,头与体逐字节一致" {
  let key = @hex.decode(@net.direct_wire_chunk_key_hex()) catch { _ => panic() }
  let frame = @base64.decode(@net.direct_wire_chunk_frame_b64()) catch { _ => panic() }
  let decoded = match @net.decode_binary_frame(key, frame) {
    Some(data) => data
    None => abort("Node 的分片帧解不开:信封布局/密钥派生与 Node 不一致")
  }
  assert_eq(decoded.kind, @net.BINARY_KIND_DIRECT_CHUNK)
  match decoded.header.get("id") {
    Some(String(id)) => assert_eq(id, @net.direct_wire_chunk_id())
    _ => abort("分片帧头缺 id")
  }
  match decoded.header.get("seq") {
    Some(Number(n, ..)) => assert_eq(n, @net.direct_wire_chunk_seq().to_double())
    _ => abort("分片帧头缺 seq")
  }
  let body = @base64.decode(@net.direct_wire_chunk_body_b64()) catch { _ => panic() }
  // Bytes 没有 Eq/Show 实现:长度 + 逐字节比对
  assert_eq(decoded.body.length(), body.length())
  for i in 0..<body.length() {
    if decoded.body[i] != body[i] {
      abort("分片体第 \{i} 字节不一致")
    }
  }
}
