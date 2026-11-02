///|
// wire 协议 golden 对齐测试:往返 + 从 Node/Rust 测试抄来的真实线上 JSON。
// 对应 Rust 侧 `rust/crates/syncx-net/tests/handshake.rs` 的
// `wire_json_shape_is_stable` / `index_roundtrip_preserves_cdc_view`
// 与 Node 侧 `test/wire.test.ts` 的块请求/响应样例。

///|
// 构造 → to_json → from_json → 相等,顶层 7 种消息全覆盖。
test "wire: 顶层消息往返" {
  let msgs : Array[@net.WireMessage] = [
    @net.Index(
      folder="/data",
      payload="W10=",
      full=Some(true),
      relayed=Some(false),
    ),
    @net.Index(folder="/data", payload="W10=", full=None, relayed=None),
    @net.IndexFingerprint(folder="/data", fingerprint="sha256:abc"),
    @net.IndexAck(folder="/data"),
    @net.IndexRequest(folder="/data"),
    @net.BlockRequest(folder="/data", payload={
      device_id: "DEV-A",
      path: "a.txt",
      block_index: 3,
      hash: "h1",
      priority: Some(true),
      cdc: Some(true),
    }),
    @net.BlockResponse(folder="/data", payload={
      device_id: "DEV-A",
      path: "a.txt",
      block_index: 3,
      hash: "h1",
      data: "aGVsbG8=",
      cdc: None,
    }),
    @net.Control(
      payload=@net.Hello(
        from_device_id="dev-1",
        version="0.4.0",
        hostname=Some("macbook"),
        platform=Some("darwin"),
      ),
    ),
  ]
  for msg in msgs {
    let back = @net.decode_wire_message(@net.encode_wire_message(msg))
    assert_eq(back, msg)
  }
}

///|
// 控制面 17 种消息全部往返;可缺省字段特意带上值,验证 camelCase 键名
// 与「缺省键不出现」的规则没有互相打架。
test "wire: 控制面消息往返" {
  let msgs : Array[@net.ControlMessage] = [
    @net.FolderInvitation(
      offer_id="o1",
      from_device_id="dev-1",
      folder_id="f1",
      folder_name="照片",
      version=Some("0.4.0"),
      hostname=Some("mba"),
      platform=Some("darwin"),
    ),
    @net.FolderInvitationAck(
      offer_id="o1",
      from_device_id="dev-1",
      accepted=true,
      version=None,
      hostname=None,
      platform=None,
    ),
    @net.PairingRequest(
      offer_id="o2",
      from_device_id="dev-2",
      version=None,
      hostname=None,
      platform=None,
    ),
    @net.PairingAck(
      offer_id="o2",
      from_device_id="dev-2",
      accepted=false,
      version=None,
      hostname=None,
      platform=None,
    ),
    @net.OfferReceipt(
      offer_id="o1",
      from_device_id="dev-1",
      version=None,
      hostname=None,
      platform=None,
    ),
    @net.FolderSyncList(
      from_device_id="dev-1",
      folder_ids=["f1", "f2"],
      pending_folder_ids=Some(["f3"]),
      version=None,
      hostname=None,
      platform=None,
    ),
    @net.Hello(
      from_device_id="dev-1",
      version="dev",
      hostname=Some("mba"),
      platform=Some("win32"),
    ),
    @net.SelfBinaryRequest(
      request_id="r1",
      from_device_id="dev-1",
      version=None,
      hostname=None,
      platform=None,
    ),
    @net.SelfBinaryResponse(
      request_id="r1",
      from_device_id="dev-1",
      version="0.4.0",
      sha256="deadbeef",
      data=None,
      hostname=None,
      platform=None,
    ),
    @net.FolderIndexRequest(
      request_id="r2",
      from_device_id="dev-1",
      folder_id="f1",
      version=None,
      hostname=None,
      platform=None,
    ),
    @net.FolderIndexSnapshot(
      request_id="r2",
      from_device_id="dev-1",
      folder_id="f1",
      seq=0,
      total=2,
      entries=Some("W10="),
      error=None,
      ignore_lines=Some(["node_modules"]),
      progress=Some(Json::object(Map([]))),
      version=None,
      hostname=None,
      platform=None,
    ),
    @net.FileContentRequest(
      request_id="r3",
      from_device_id="dev-1",
      folder_id="f1",
      path="a/b.txt",
      version=None,
      hostname=None,
      platform=None,
    ),
    @net.FileContentResponse(
      request_id="r3",
      from_device_id="dev-1",
      folder_id="f1",
      path="a/b.txt",
      data=Some("YQ=="),
      size=Some(1),
      entry_version=Some([("dev-2", 5)]),
      error=None,
      version=None,
      hostname=None,
      platform=None,
    ),
    @net.FileContentWrite(
      request_id="r4",
      from_device_id="dev-1",
      folder_id="f1",
      path="a/b.txt",
      data="YQ==",
      entry_version=[("dev-2", 5)],
      version=None,
      hostname=None,
      platform=None,
    ),
    @net.FileContentWriteResult(
      request_id="r4",
      from_device_id="dev-1",
      folder_id="f1",
      path="a/b.txt",
      ok=true,
      error=None,
      version=None,
      hostname=None,
      platform=None,
    ),
    @net.GitCommitNotify(
      from_device_id="dev-1",
      folder_id="f1",
      commit_hash="abc123",
      commit_message="fix: x",
      changed_files=["a.txt"],
      diff_stat=Some("1 file changed"),
      commit_subjects=Some(["fix: x"]),
      parent_hash="def456",
      version=None,
      hostname=None,
      platform=None,
    ),
    @net.GitCommitAck(
      from_device_id="dev-1",
      folder_id="f1",
      commit_hash="abc123",
      version=None,
      hostname=None,
      platform=None,
    ),
  ]
  for msg in msgs {
    let back = @net.ControlMessage::from_json(@net.ControlMessage::to_json(msg))
    assert_eq(back, msg)
  }
}

///|
// Rust `wire_json_shape_is_stable` 的 golden:full 缺省时线上不得出现
// "full" 键;显式 Some(true) 时必须是 `"full":true`。
test "wire: index 的 full 缺省按增量(golden)" {
  // 显式全量:与 Rust serde 输出逐字节一致
  let full = @net.decode_wire_message(
    "{\"type\":\"index\",\"folder\":\"/x\",\"payload\":\"[]\",\"full\":true}",
  )
  assert_eq(
    full,
    @net.Index(folder="/x", payload="[]", full=Some(true), relayed=None),
  )
  assert_true(full.is_full_index())
  // 缺省(旧版对端):按增量,绝不能按全量
  let incremental = @net.decode_wire_message(
    "{\"type\":\"index\",\"folder\":\"/x\",\"payload\":\"[]\"}",
  )
  assert_eq(
    incremental,
    @net.Index(folder="/x", payload="[]", full=None, relayed=None),
  )
  assert_true(!incremental.is_full_index())
  // Some(false) 也是增量
  let explicit = @net.Index(
    folder="/x",
    payload="[]",
    full=Some(false),
    relayed=None,
  )
  assert_true(!explicit.is_full_index())
  // 缺省序列化时 "full" 键整个不出现 —— 发 null 会让旧对端走进非预期分支
  let text = @net.encode_wire_message(
    @net.Index(folder="/x", payload="[]", full=None, relayed=None),
  )
  assert_true(!text.contains("\"full\""))
  assert_true(!text.contains("\"relayed\""))
  // 显式 Some(true) 时键必须在
  let text = @net.encode_wire_message(
    @net.Index(folder="/x", payload="[]", full=Some(true), relayed=None),
  )
  assert_true(text.contains("\"full\":true"))
}

///|
// Rust golden:控制消息里版本向量字段名必须是 `entryVersion`,
// 且线上形态是数组对 `[["dev",3]]` 而不是对象。
test "wire: entryVersion 拼写与数组对形态(golden)" {
  let msg = @net.decode_wire_message(
    "{\"type\":\"control\",\"payload\":{\"kind\":\"file-content-write\",\"requestId\":\"r\",\"fromDeviceId\":\"d\",\"folderId\":\"f\",\"path\":\"/a\",\"data\":\"AA==\",\"entryVersion\":[[\"dev\",3]]}}",
  )
  let expected = @net.Control(
    payload=@net.FileContentWrite(
      request_id="r",
      from_device_id="d",
      folder_id="f",
      path="/a",
      data="AA==",
      entry_version=[("dev", 3)],
      version=None,
      hostname=None,
      platform=None,
    ),
  )
  assert_eq(msg, expected)
  let text = @net.encode_wire_message(msg)
  assert_true(text.contains("\"entryVersion\""))
  assert_true(text.contains("[[\"dev\",3]]"))
}

///|
// Node `wire.test.ts` 的 golden:block-request / block-response 的线上字段。
test "wire: 块请求与块响应(golden)" {
  let req = @net.decode_wire_message(
    "{\"type\":\"block-request\",\"folder\":\"main\",\"payload\":{\"deviceId\":\"DEV-A\",\"path\":\"a.txt\",\"blockIndex\":0,\"hash\":\"h1\"}}",
  )
  assert_eq(
    req,
    @net.BlockRequest(folder="main", payload={
      device_id: "DEV-A",
      path: "a.txt",
      block_index: 0,
      hash: "h1",
      priority: None,
      cdc: None,
    }),
  )
  let resp = @net.decode_wire_message(
    "{\"type\":\"block-response\",\"folder\":\"main\",\"payload\":{\"deviceId\":\"DEV-A\",\"path\":\"a.txt\",\"blockIndex\":0,\"hash\":\"h1\",\"data\":\"aGVsbG8=\"}}",
  )
  assert_eq(
    resp,
    @net.BlockResponse(folder="main", payload={
      device_id: "DEV-A",
      path: "a.txt",
      block_index: 0,
      hash: "h1",
      data: "aGVsbG8=",
      cdc: None,
    }),
  )
  // cdc 缺省时序列化不得出现 "cdc": null
  let text = @net.encode_wire_message(resp)
  assert_true(!text.contains("\"cdc\""))
  // cdc = Some(true) 时键要上线
  let with_cdc = @net.BlockResponse(folder="main", payload={
    device_id: "DEV-A",
    path: "a.txt",
    block_index: 0,
    hash: "h1",
    data: "aGVsbG8=",
    cdc: Some(true),
  })
  let text = @net.encode_wire_message(with_cdc)
  assert_true(text.contains("\"cdc\":true"))
  assert_true(@net.decode_wire_message(text) == with_cdc)
}

///|
// hello golden:version 必填,hostname/platform 可缺省。
test "wire: hello 控制消息(golden)" {
  let msg = @net.decode_wire_message(
    "{\"type\":\"control\",\"payload\":{\"kind\":\"hello\",\"fromDeviceId\":\"dev-1\",\"version\":\"0.4.0\",\"hostname\":\"mba\",\"platform\":\"darwin\"}}",
  )
  assert_eq(
    msg,
    @net.Control(
      payload=@net.Hello(
        from_device_id="dev-1",
        version="0.4.0",
        hostname=Some("mba"),
        platform=Some("darwin"),
      ),
    ),
  )
  // 旧版本对端不发 hostname/platform:按缺省解析,不报错
  let msg = @net.decode_wire_message(
    "{\"type\":\"control\",\"payload\":{\"kind\":\"hello\",\"fromDeviceId\":\"dev-1\",\"version\":\"0.4.0\"}}",
  )
  assert_eq(
    msg,
    @net.Control(
      payload=@net.Hello(
        from_device_id="dev-1",
        version="0.4.0",
        hostname=None,
        platform=None,
      ),
    ),
  )
}

///|
// 索引条目往返 + Rust `index_roundtrip_preserves_cdc_view` 的口径:
// mtime 可能是小数毫秒(必须按 Double 收);cdh/clens 等长且非空才保留。
test "wire: 索引条目往返与 CDC 视图口径" {
  let entries : Array[@net.WireEntry] = [
    {
      path: "/a",
      version: [("devA", 2)],
      size: 10,
      deleted: false,
      blocks: ["b1"],
      mtime: 1750000000123.456,
      cdh: Some(["h1"]),
      clens: Some([10]),
    },
    // cdh/clens 不等长:has_cdc_view 必须为假(宽进严出)
    {
      path: "/b",
      version: [("devA", 2)],
      size: 1,
      deleted: false,
      blocks: [],
      mtime: 1700000001.0,
      cdh: Some(["h1", "h2"]),
      clens: Some([1]),
    },
    // 删除标记:空 blocks 也必须原样保留(拒绝传播删除 = 已删文件被回推)
    {
      path: "/c",
      version: [("devA", 9)],
      size: 0,
      deleted: true,
      blocks: [],
      mtime: 1700000002.0,
      cdh: None,
      clens: None,
    },
  ]
  let back = @net.decode_index(@net.encode_index(entries))
  assert_eq(back, entries)
  assert_true(back[0].has_cdc_view())
  assert_true(!back[1].has_cdc_view())
  let (cdh, clens) = back[1].cdc_view()
  assert_eq(cdh, None)
  assert_eq(clens, None)
  assert_eq(@net.mtime_ms(back[0].mtime), 1750000000123L)
  assert_eq(@net.mtime_ms(-1.5), 0L)
  // golden:小数毫秒必须原样解析,不能让整条索引解析失败
  let decoded = @net.decode_index(
    "[{\"path\":\"/a\",\"version\":[[\"devA\",2]],\"size\":10,\"deleted\":false,\"blocks\":[\"b1\"],\"mtime\":1750000000123.456,\"cdh\":[\"h1\"],\"clens\":[10]}]",
  )
  assert_eq(decoded[0].mtime, 1750000000123.456)
}

///|
// 畸形输入必须抛错而不是 panic:坏 JSON、未知 type、未知 kind、
// 必填字段缺失、字段类型不对、版本向量非数组对。
test "wire: 畸形消息抛错" {
  let rejects : Array[String] = [
    // 不是 JSON
    "{oops",
    // JSON 但不是对象
     "[1,2,3]",
    // 未知 type
     "{\"type\":\"nope\"}",
    // 必填字段缺失
     "{\"type\":\"index\"}",
    // 字段类型不对(full 是字符串)
     "{\"type\":\"index\",\"folder\":\"/x\",\"payload\":\"[]\",\"full\":\"yes\"}",
    // 未知 kind
     "{\"type\":\"control\",\"payload\":{\"kind\":\"from-the-future\"}}",
    // payload 缺失
     "{\"type\":\"control\"}",
    // 版本向量不是数组对
     "{\"path\":\"/a\",\"version\":{\"devA\":2},\"size\":1,\"deleted\":false,\"blocks\":[],\"mtime\":1}",
    // u64 字段为负
     "{\"type\":\"block-request\",\"folder\":\"m\",\"payload\":{\"deviceId\":\"d\",\"path\":\"p\",\"blockIndex\":-1,\"hash\":\"h\"}}",
  ]
  for raw in rejects {
    let failed = try {
      let _ = @net.decode_wire_message(raw)
      false
    } catch {
      _ => true
    }
    assert_true(failed)
  }
  // 索引体不是数组也必须拒收
  let failed = try {
    let _ = @net.decode_index("{\"path\":\"/a\"}")
    false
  } catch {
    _ => true
  }
  assert_true(failed)
}
