///|
/// CDC 块请求与供应的黑盒集成测试(真实 /tmp 文件系统):本地预填差集、
/// CDC 供应、响应拒收闸与双实例回环冒烟。判据对齐 Node src/peer.ts。

///|
/// 读回整份文件字节(内容断言用;actor_read_text 只读 4KiB,这里要整份)。
async fn cdc_read_bytes(path : String) -> Bytes? {
  let data = @fs.read_file(path) catch { _ => return None }
  Some(data.binary())
}

///|
/// 造一段伪随机但仍确定性的内容:**不能用周期性重复文本** —— 周期字节流会让
/// 滚动指纹进入固定轨道,几十个状态里可能没有一个命中边界条件,几 MiB 也切
/// 不出第二块(实测 3MiB 单块),CDC 差集随之失效。返回可变副本,便于构造
/// 「同长改写」的 v2。
fn cdc_make_content(total : Int32) -> FixedArray[Byte] {
  let fa : FixedArray[Byte] = FixedArray::make(total, b'\x00')
  // 线性同余生成器(deterministic LCG),字节流无长周期重复
  let mut seed : UInt32 = 0x9E3779B9U
  for i in 0..<total {
    seed = seed * 1664525U + 1013904223U
    fa[i] = (seed >> 24).reinterpret_as_int().to_byte()
  }
  fa
}

///|
/// FixedArray[Byte] → Bytes(视图构造与写盘用)。
fn cdc_bytes(fa : FixedArray[Byte]) -> Bytes {
  Bytes::from_array(fa.exact_view(end=fa.length()))
}

///|
/// 对内容计算与生产同口径的视图(定长块 + CDC 哈希与长度)。
fn cdc_views(content : Bytes) -> (Array[String], Array[String], Array[Int64]) {
  let blocks : Array[String] = []
  let size = content.length()
  let mut off = 0
  while off < size {
    let rest = size - off
    let len = if rest < @core.BLOCK_SIZE { rest } else { @core.BLOCK_SIZE }
    blocks.push(@core.hash_block(content[off:off + len].to_owned()))
    off += len
  }
  let cdh : Array[String] = []
  let clens : Array[Int64] = []
  for (offset, length) in @core.chunk_ranges(content) {
    cdh.push(@core.hash_block(content[offset:offset + length].to_owned()))
    clens.push(length.to_int64())
  }
  (blocks, cdh, clens)
}

///|
/// 取内容按 clens 前缀和的第 slot 个 CDC 块(与供应侧读法一致)。
fn cdc_chunk(content : Bytes, clens : Array[Int64], slot : Int32) -> Bytes {
  let mut offset = 0
  for i in 0..<slot {
    offset += clens[i].to_int()
  }
  let length = clens[slot].to_int()
  content[offset:offset + length].to_owned()
}

///|
/// 本机索引条目里与远端视图的差集:远端 cdh 中本地没有的哈希槽位集合
/// (与 request_missing_chunks 的预填差集同一口径)。
fn cdc_missing_slots(
  remote_cdh : Array[String],
  local_cdh : Array[String],
) -> Array[Int32] {
  let local_set : Map[String, Unit] = Map([])
  for h in local_cdh {
    local_set.set(h, ())
  }
  let out : Array[Int32] = []
  for i in 0..<remote_cdh.length() {
    if !local_set.contains(remote_cdh[i]) {
      out.push(i)
    }
  }
  out
}

///|
/// 预填差集主路径:本机持有旧版本(v1,盘上实体 + 索引带 CDC 视图),对端
/// 推来新版本(v2,中部同长改写)。共享块直接从本地读出,只对变化的槽位
/// 发 CDC 块请求;回答后落地内容与新版本逐字节一致。
async test "cdc 接收: 本地预填差集,只对变化槽位发请求" {
  let v1_fa = cdc_make_content(3 * 1024 * 1024)
  let v1 = cdc_bytes(v1_fa)
  // 中部同长改写 64 字节:CDC 边界由内容决定,只有覆盖改动的那一块变哈希
  let v2_fa = v1_fa.copy()
  for i in 0..<64 {
    v2_fa[1024 * 1024 + 512 + i] = (200 + i % 50).to_byte()
  }
  let v2 = cdc_bytes(v2_fa)
  let (_, cdh1, _) = cdc_views(v1)
  let (blocks2, cdh2, clens2) = cdc_views(v2)
  let missing = cdc_missing_slots(cdh2, cdh1)
  // 中部 64 字节改写不该打散整个布局:变化槽位必须是少数
  assert_true(
    missing.length() > 0 && missing.length() <= 2,
    msg="中部小改应只变化少数 CDC 槽位",
  )
  let root = actor_fresh_root("cdc-prefill")
  let _ = @fs.write_file("\{root}/big.bin", v1, create_mode=CreateOrTruncate)
  let spec = actor_make_spec(root)
  @async.with_task_group() <| group => {
    let handle = @daemon.start_session_actor(group, "dev-a", [spec])
    let _ = handle.send(@daemon.Cmd::ScanFolder("f1"))
    let _ = handle.sync_snapshot()
    let sink : @async.Queue[@daemon.Outbound] = @async.Queue(kind=Unbounded)
    let _ = handle.send(
      @daemon.Cmd::PeerOpen(folder="f1", remote_device_id="dev-b", sink~),
    )
    let _ = sink.get() // 指纹帧
    // 初始交换兜底由真实墙钟驱动:单实例测试无人应答指纹,PeerOpen 2s 后
    // 周期泵必发一次兜底全量;慢步骤(如 2MiB 异或改写)会让它插进后面
    // 「出站只许某类帧」的严格断言。注入一拍快进让它确定性地发完并消费掉
    // (恰此一帧),后续计数窗口内不再有协议帧。
    let _ = handle.send(@daemon.Cmd::PollTimeouts(now=@daemon.now_ms() + 3000L))
    let _ = handle.sync_snapshot()
    match sink.get() {
      @daemon.Outbound::Entries(..) => () // 兜底全量帧,恰此一帧
      _ => fail("兜底快进后应恰有一帧全量索引")
    }
    let remote : Array[@net.WireEntry] = [
      {
        path: "big.bin",
        version: [("dev-a", 1L), ("dev-b", 2L)],
        size: v2.length().to_int64(),
        deleted: false,
        blocks: blocks2,
        mtime: 0.0,
        cdh: Some(cdh2),
        clens: Some(clens2),
      },
    ]
    let _ = handle.send(
      @daemon.Cmd::PeerMessage(
        folder="f1",
        remote_device_id="dev-b",
        message=actor_index_message("f1", remote, full=false),
      ),
    )
    let _ = handle.send(@daemon.Cmd::ApplyPlan("f1"))
    // 出站的块请求恰好是变化槽位,口径全为 CDC
    let got : Array[@net.WireBlockRequest] = []
    for _ in 0..<missing.length() {
      match sink.get() {
        @daemon.Outbound::BlockRequest(req) => got.push(req)
        _ => fail("应为 CDC 块请求")
      }
    }
    assert_true(actor_try_peek(sink) is None)
    assert_eq(got.length(), missing.length())
    for i in 0..<got.length() {
      let slot = missing[i]
      assert_eq(got[i].block_index, slot.to_int64())
      assert_eq(got[i].hash, cdh2[slot])
      assert_eq(got[i].cdc, Some(true))
    }
    // 逐槽回答变化块 → 落地,内容与 v2 一致(共享块从未过网络)
    for i in 0..<missing.length() {
      let slot = missing[i]
      let _ = handle.send(
        @daemon.Cmd::PeerMessage(
          folder="f1",
          remote_device_id="dev-b",
          message=@net.WireMessage::BlockResponse(folder="f1", payload={
            device_id: "dev-b",
            path: "big.bin",
            block_index: slot.to_int64(),
            hash: cdh2[slot],
            data: @base64.encode(cdc_chunk(v2, clens2, slot)),
            cdc: Some(true),
          }),
        ),
      )
    }
    let snap = handle.sync_snapshot()
    assert_eq(snap.folders[0].entries, 1L)
    assert_eq(cdc_read_bytes("\{root}/big.bin"), Some(v2))
    let _ = handle.send(@daemon.Cmd::Shutdown)
    ()
  }
}

///|
/// 预填的信任边界:本地文件在扫描与规划之间被改写(盘上内容与索引声明
/// 不再一致)时,读出的块哈希验证不过,全部槽位回退网络请求 —— 宁可重传,
/// 不可错接。
async test "cdc 接收: 本地文件被改写后预填失败,整份回退网络请求" {
  let v1_fa = cdc_make_content(2 * 1024 * 1024)
  let v1 = cdc_bytes(v1_fa)
  let v2_fa = v1_fa.copy()
  for i in 0..<64 {
    v2_fa[512 * 1024 + i] = (100 + i % 50).to_byte()
  }
  let v2 = cdc_bytes(v2_fa)
  let (blocks2, cdh2, clens2) = cdc_views(v2)
  let root = actor_fresh_root("cdc-fallback")
  let _ = @fs.write_file("\{root}/big.bin", v1, create_mode=CreateOrTruncate)
  let spec = actor_make_spec(root)
  @async.with_task_group() <| group => {
    let handle = @daemon.start_session_actor(group, "dev-a", [spec])
    let _ = handle.send(@daemon.Cmd::ScanFolder("f1"))
    let _ = handle.sync_snapshot()
    // 扫描之后、规划之前,盘上文件被改写(索引还停在 v1 的声明)
    let garbage = cdc_make_content(2 * 1024 * 1024)
    for i in 0..<garbage.length() {
      garbage[i] = garbage[i].lxor(b'\xa5')
    }
    let _ = @fs.write_file(
      "\{root}/big.bin",
      cdc_bytes(garbage),
      create_mode=CreateOrTruncate,
    )
    let sink : @async.Queue[@daemon.Outbound] = @async.Queue(kind=Unbounded)
    let _ = handle.send(
      @daemon.Cmd::PeerOpen(folder="f1", remote_device_id="dev-b", sink~),
    )
    let _ = sink.get() // 指纹帧
    // 初始交换兜底由真实墙钟驱动:单实例测试无人应答指纹,PeerOpen 2s 后
    // 周期泵必发一次兜底全量;慢步骤(如 2MiB 异或改写)会让它插进后面
    // 「出站只许某类帧」的严格断言。注入一拍快进让它确定性地发完并消费掉
    // (恰此一帧),后续计数窗口内不再有协议帧。
    let _ = handle.send(@daemon.Cmd::PollTimeouts(now=@daemon.now_ms() + 3000L))
    let _ = handle.sync_snapshot()
    match sink.get() {
      @daemon.Outbound::Entries(..) => () // 兜底全量帧,恰此一帧
      _ => fail("兜底快进后应恰有一帧全量索引")
    }
    let remote : Array[@net.WireEntry] = [
      {
        path: "big.bin",
        version: [("dev-a", 1L), ("dev-b", 2L)],
        size: v2.length().to_int64(),
        deleted: false,
        blocks: blocks2,
        mtime: 0.0,
        cdh: Some(cdh2),
        clens: Some(clens2),
      },
    ]
    let _ = handle.send(
      @daemon.Cmd::PeerMessage(
        folder="f1",
        remote_device_id="dev-b",
        message=actor_index_message("f1", remote, full=false),
      ),
    )
    let _ = handle.send(@daemon.Cmd::ApplyPlan("f1"))
    // 屏障:快照回执 = ApplyPlan(含预填与请求发出)已处理完
    let _ = handle.sync_snapshot()
    // 共享块也验证不过:全部槽位走网络
    let mut requests = 0
    while true {
      match actor_try_peek(sink) {
        Some(@daemon.Outbound::BlockRequest(req)) => {
          assert_eq(req.cdc, Some(true))
          requests += 1
        }
        Some(_) => fail("出站帧不是块请求")
        None => break
      }
    }
    assert_eq(requests, cdh2.length())
    let _ = handle.send(@daemon.Cmd::Shutdown)
    ()
  }
}

///|
/// CDC 供应:按本机 clens 前缀和定位读块,响应回填真实哈希与 cdc 回显;
/// 越界槽位 / 本机无视图 / 墓碑一律静默忽略(对端超时重试兜底)。
async test "cdc 供应: 按前缀和供块回填真实哈希,无视图与墓碑静默忽略" {
  let v1_fa = cdc_make_content(2 * 1024 * 1024)
  let v1 = cdc_bytes(v1_fa)
  let (_, cdh1, clens1) = cdc_views(v1)
  let root = actor_fresh_root("cdc-serve")
  let _ = @fs.write_file("\{root}/big.bin", v1, create_mode=CreateOrTruncate)
  let spec = actor_make_spec(root)
  @async.with_task_group() <| group => {
    let handle = @daemon.start_session_actor(group, "dev-a", [spec])
    let _ = handle.send(@daemon.Cmd::ScanFolder("f1"))
    let _ = handle.sync_snapshot()
    let sink : @async.Queue[@daemon.Outbound] = @async.Queue(kind=Unbounded)
    let _ = handle.send(
      @daemon.Cmd::PeerOpen(folder="f1", remote_device_id="dev-b", sink~),
    )
    let _ = sink.get() // 指纹帧
    // 初始交换兜底由真实墙钟驱动:单实例测试无人应答指纹,PeerOpen 2s 后
    // 周期泵必发一次兜底全量;慢步骤(如 2MiB 异或改写)会让它插进后面
    // 「出站只许某类帧」的严格断言。注入一拍快进让它确定性地发完并消费掉
    // (恰此一帧),后续计数窗口内不再有协议帧。
    let _ = handle.send(@daemon.Cmd::PollTimeouts(now=@daemon.now_ms() + 3000L))
    let _ = handle.sync_snapshot()
    match sink.get() {
      @daemon.Outbound::Entries(..) => () // 兜底全量帧,恰此一帧
      _ => fail("兜底快进后应恰有一帧全量索引")
    }
    // 选中间槽位(内容 2MiB 期望 ≥1 个 CDC 块;槽数随内容浮动,取末槽兜底)
    let slot = if cdh1.length() > 1 { 1 } else { 0 }
    let req : @net.WireBlockRequest = {
      device_id: "dev-b",
      path: "big.bin",
      block_index: slot.to_int64(),
      hash: cdh1[slot],
      priority: None,
      cdc: Some(true),
    }
    let _ = handle.send(
      @daemon.Cmd::PeerMessage(
        folder="f1",
        remote_device_id="dev-b",
        message=@net.WireMessage::BlockRequest(folder="f1", payload=req),
      ),
    )
    let _ = handle.sync_snapshot()
    match sink.get() {
      @daemon.Outbound::BlockResponse(resp) => {
        assert_eq(resp.block_index, slot.to_int64())
        // 回填真实哈希(= cdh[slot]),不是 request.hash 的回显
        assert_eq(resp.hash, cdh1[slot])
        assert_eq(resp.cdc, Some(true))
        assert_eq(@base64.decode(resp.data), cdc_chunk(v1, clens1, slot))
      }
      _ => fail("应为块响应")
    }
    // 对端认知错位(request.hash 是旧的):仍按真实哈希供应,接收端校验兜底
    let stale : @net.WireBlockRequest = { ..req, hash: "stale-hash", }
    let _ = handle.send(
      @daemon.Cmd::PeerMessage(
        folder="f1",
        remote_device_id="dev-b",
        message=@net.WireMessage::BlockRequest(folder="f1", payload=stale),
      ),
    )
    let _ = handle.sync_snapshot()
    match sink.get() {
      @daemon.Outbound::BlockResponse(resp) => assert_eq(resp.hash, cdh1[slot])
      _ => fail("错位请求也应供应")
    }
    // 越界槽位:静默忽略
    let oob : @net.WireBlockRequest = {
      ..req,
      block_index: cdh1.length().to_int64(),
    }
    let _ = handle.send(
      @daemon.Cmd::PeerMessage(
        folder="f1",
        remote_device_id="dev-b",
        message=@net.WireMessage::BlockRequest(folder="f1", payload=oob),
      ),
    )
    // 本机索引没有这条路径:静默忽略
    let absent : @net.WireBlockRequest = { ..req, path: "no-such.bin", }
    let _ = handle.send(
      @daemon.Cmd::PeerMessage(
        folder="f1",
        remote_device_id="dev-b",
        message=@net.WireMessage::BlockRequest(folder="f1", payload=absent),
      ),
    )
    let _ = handle.sync_snapshot()
    assert_true(actor_try_peek(sink) is None)
    // 墓碑:静默忽略
    let _ = @fs.remove("\{root}/big.bin")
    let _ = handle.send(@daemon.Cmd::ScanFolder("f1"))
    let _ = handle.sync_snapshot()
    let tomb_req : @net.WireBlockRequest = { ..req, hash: "whatever", }
    let _ = handle.send(
      @daemon.Cmd::PeerMessage(
        folder="f1",
        remote_device_id="dev-b",
        message=@net.WireMessage::BlockRequest(folder="f1", payload=tomb_req),
      ),
    )
    let _ = handle.sync_snapshot()
    assert_true(actor_try_peek(sink) is None)
    let _ = handle.send(@daemon.Cmd::Shutdown)
    ()
  }
}

///|
/// 响应拒收闸(对齐 Node handleBlockResponse):越界索引、哈希不符、超过
/// 口径上限的超长块一律丢弃,且不污染中间态 —— 随后的正确响应照常落地。
async test "cdc 接收: 越界 / 哈希不符 / 超长响应被拒,不污染中间态" {
  let v1_fa = cdc_make_content(2 * 1024 * 1024)
  let v1 = cdc_bytes(v1_fa)
  let v2_fa = v1_fa.copy()
  for i in 0..<64 {
    v2_fa[1536 * 1024 + i] = (50 + i % 40).to_byte()
  }
  let v2 = cdc_bytes(v2_fa)
  let (blocks2, cdh2, clens2) = cdc_views(v2)
  let (_, cdh_v1, _) = cdc_views(v1)
  let missing = cdc_missing_slots(cdh2, cdh_v1)
  let root = actor_fresh_root("cdc-reject")
  let _ = @fs.write_file("\{root}/big.bin", v1, create_mode=CreateOrTruncate)
  let spec = actor_make_spec(root)
  @async.with_task_group() <| group => {
    let handle = @daemon.start_session_actor(group, "dev-a", [spec])
    let _ = handle.send(@daemon.Cmd::ScanFolder("f1"))
    let _ = handle.sync_snapshot()
    let sink : @async.Queue[@daemon.Outbound] = @async.Queue(kind=Unbounded)
    let _ = handle.send(
      @daemon.Cmd::PeerOpen(folder="f1", remote_device_id="dev-b", sink~),
    )
    let _ = sink.get() // 指纹帧
    // 初始交换兜底由真实墙钟驱动:单实例测试无人应答指纹,PeerOpen 2s 后
    // 周期泵必发一次兜底全量;慢步骤(如 2MiB 异或改写)会让它插进后面
    // 「出站只许某类帧」的严格断言。注入一拍快进让它确定性地发完并消费掉
    // (恰此一帧),后续计数窗口内不再有协议帧。
    let _ = handle.send(@daemon.Cmd::PollTimeouts(now=@daemon.now_ms() + 3000L))
    let _ = handle.sync_snapshot()
    match sink.get() {
      @daemon.Outbound::Entries(..) => () // 兜底全量帧,恰此一帧
      _ => fail("兜底快进后应恰有一帧全量索引")
    }
    let remote : Array[@net.WireEntry] = [
      {
        path: "big.bin",
        version: [("dev-a", 1L), ("dev-b", 2L)],
        size: v2.length().to_int64(),
        deleted: false,
        blocks: blocks2,
        mtime: 0.0,
        cdh: Some(cdh2),
        clens: Some(clens2),
      },
    ]
    let _ = handle.send(
      @daemon.Cmd::PeerMessage(
        folder="f1",
        remote_device_id="dev-b",
        message=actor_index_message("f1", remote, full=false),
      ),
    )
    let _ = handle.send(@daemon.Cmd::ApplyPlan("f1"))
    // 收下全部 missing 请求帧
    let got : Array[@net.WireBlockRequest] = []
    for _ in 0..<missing.length() {
      match sink.get() {
        @daemon.Outbound::BlockRequest(req) => got.push(req)
        _ => fail("应为 CDC 块请求")
      }
    }
    let first = got[0]
    let slot = first.block_index.to_int()
    // 越界索引(按 CDC 口径的槽数判,不看定长 blocks)
    let _ = handle.send(
      @daemon.Cmd::PeerMessage(
        folder="f1",
        remote_device_id="dev-b",
        message=@net.WireMessage::BlockResponse(folder="f1", payload={
          device_id: "dev-b",
          path: "big.bin",
          block_index: cdh2.length().to_int64(),
          hash: first.hash,
          data: @base64.encode(cdc_chunk(v2, clens2, slot)),
          cdc: Some(true),
        }),
      ),
    )
    // 哈希不符:拿一个不可能成立的哈希冒充期望哈希
    let _ = handle.send(
      @daemon.Cmd::PeerMessage(
        folder="f1",
        remote_device_id="dev-b",
        message=@net.WireMessage::BlockResponse(folder="f1", payload={
          device_id: "dev-b",
          path: "big.bin",
          block_index: first.block_index,
          hash: "not-the-expected-hash",
          data: @base64.encode(cdc_chunk(v2, clens2, slot)),
          cdc: Some(true),
        }),
      ),
    )
    // 超长:数据超过 CDC_MAX_CHUNK,哈希验证之前就该被拦
    let oversized : FixedArray[Byte] = FixedArray::make(
      @core.CDC_MAX_CHUNK + 64,
      b'\x07',
    )
    let _ = handle.send(
      @daemon.Cmd::PeerMessage(
        folder="f1",
        remote_device_id="dev-b",
        message=@net.WireMessage::BlockResponse(folder="f1", payload={
          device_id: "dev-b",
          path: "big.bin",
          block_index: first.block_index,
          hash: first.hash,
          data: @base64.encode(cdc_bytes(oversized)),
          cdc: Some(true),
        }),
      ),
    )
    let snap = handle.sync_snapshot()
    // 三个坏响应全部被拒:未落地、接收仍挂着、中间态没被污染
    assert_eq(snap.folders[0].entries, 1L)
    assert_eq(snap.folders[0].in_flight_receives, 1)
    // 正确响应随后照常落地:坏响应没有污染拼装布局
    for i in 0..<got.length() {
      let s = got[i].block_index.to_int()
      let _ = handle.send(
        @daemon.Cmd::PeerMessage(
          folder="f1",
          remote_device_id="dev-b",
          message=@net.WireMessage::BlockResponse(folder="f1", payload={
            device_id: "dev-b",
            path: "big.bin",
            block_index: got[i].block_index,
            hash: cdh2[s],
            data: @base64.encode(cdc_chunk(v2, clens2, s)),
            cdc: Some(true),
          }),
        ),
      )
    }
    let snap2 = handle.sync_snapshot()
    assert_eq(snap2.folders[0].entries, 1L)
    assert_eq(snap2.folders[0].in_flight_receives, 0)
    assert_eq(cdc_read_bytes("\{root}/big.bin"), Some(v2))
    let _ = handle.send(@daemon.Cmd::Shutdown)
    ()
  }
}

///|
/// 端到端冒烟(双实例真实 WS 回环):大文件首轮全量同步(本机无实体,按
/// 定长口径拉全量);改文件中部一小段再扫,第二轮只传输变化的 CDC 槽位。
/// 断言刻意宽容(槽位数上限 4、全部请求带 CDC 口径),避开边界漂移敏感的
/// 精确断言。
async test "cdc 回环冒烟: 第二轮只传变化槽位" {
  let root_b = actor_fresh_root("cdc-e2e-b")
  let v1_fa = cdc_make_content(3 * 1024 * 1024)
  let v1 = cdc_bytes(v1_fa)
  let _ = @fs.write_file("\{root_b}/big.bin", v1, create_mode=CreateOrTruncate)
  let root_a = actor_fresh_root("cdc-e2e-a")
  actor_mkdir(root_a)
  let spec_a = actor_make_spec(root_a)
  let spec_b = actor_make_spec(root_b)
  @async.with_task_group() <| group => {
    let env = actor_loop_start(group, spec_a, spec_b)
    assert_true(
      actor_wait_until(() => env.handle_b.snapshot().folders[0].peers == 1),
    )
    // 首轮全量:B 的 3MiB 走定长口径落到 A(本机无条目,无差集可算)
    let _ = env.handle_b.send(@daemon.Cmd::ScanFolder("f1"))
    let mut landed_v1 = false
    for _ in 0..<200 {
      if cdc_read_bytes("\{root_a}/big.bin") == Some(v1) {
        landed_v1 = true
        break
      }
      @async.sleep(50)
    }
    assert_true(landed_v1, msg="首轮应完整落地 v1")
    env.requests.clear()
    // 等过扫描器的 mtime 容忍窗口(MTIME_TOLERANCE_MS=2s,FAT32 兼容):
    // 2026-11-09 起窗口内抖动已改为内容哈希确认,不再吞改动 —— 保留等待
    // 只为测试节奏稳定,不再承担正确性
    @async.sleep(2300)
    // 第二轮:中部同长改写 64 字节 → 只传变化的 CDC 槽位
    let v2_fa = v1_fa.copy()
    for i in 0..<64 {
      v2_fa[1024 * 1024 + 4096 + i] = (128 + i % 64).to_byte()
    }
    let v2 = cdc_bytes(v2_fa)
    let _ = @fs.write_file(
      "\{root_b}/big.bin",
      v2,
      create_mode=CreateOrTruncate,
    )
    let _ = env.handle_b.send(@daemon.Cmd::ScanFolder("f1"))
    let mut landed_v2 = false
    for _ in 0..<200 {
      if cdc_read_bytes("\{root_a}/big.bin") == Some(v2) {
        landed_v2 = true
        break
      }
      @async.sleep(50)
    }
    assert_true(landed_v2, msg="第二轮应落地 v2")
    // 内容落地即本轮传输已结束;再等一拍确认没有额外请求尾巴
    @async.sleep(100)
    let _ = env.handle_a.sync_snapshot()
    let mut joined = ""
    for record in env.requests {
      joined = joined + record + ","
    }
    assert_true(
      env.requests.length() >= 1 && env.requests.length() <= 4,
      msg="第二轮只应传输变化的槽位,实际 \{env.requests.length()} 条: \{joined}",
    )
    for record in env.requests {
      assert_true(
        record.contains("#true"),
        msg="第二轮请求应全部为 CDC 口径: \{record}",
      )
    }
    actor_loop_stop(env)
  }
}
