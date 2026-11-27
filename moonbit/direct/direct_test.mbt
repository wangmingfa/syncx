///|
// 直发服务状态机黑盒测试:/tmp 真实文件系统,两台服务(两台「设备」)用
// 捕获式通道人工接线 —— A 的出站帧喂给 B 的 handle_control / handle_chunk,
// B 的出站帧喂回 A,即一条与真机同形的闭环。覆盖:文本落箱与上限、文件
// 提议/接受/分片/指纹验收/落箱、离线排队与取消、待确认来源查询。

///|
/// 捕获式直发通道:出站帧全记下来,由测试逐条接线到对端(串行,与线上
/// 单连接顺序一致)。
struct FakeLink {
  controls : Array[@net.ControlMessage]
  chunks : Array[(String, Int64, Bytes)]
}

///|
fn FakeLink::new() -> FakeLink {
  { controls: [], chunks: [] }
}

///|
fn FakeLink::transport(self : FakeLink) -> @direct.DirectTransport {
  {
    control: msg => {
      self.controls.push(msg)
      true
    },
    chunk: (id, seq, data) => {
      self.chunks.push((id, seq, data))
      true
    },
  }
}

///|
/// 直发分片帧头(handle_chunk 只看这两个键;repr 钉住整数形式)。
fn chunk_header(id : String, seq : Int64) -> Map[String, Json] {
  let map : Map[String, Json] = Map([])
  map.set("id", Json::string(id))
  map.set("seq", Json::number(seq.to_double(), repr=seq.to_string()))
  map
}

///|
fn json_field(v : Json, key : String) -> Json? {
  match v {
    @json.Object(fields) => fields.get(key)
    _ => None
  }
}

///|
fn json_array_field(v : Json, key : String) -> Array[Json] {
  match json_field(v, key) {
    Some(@json.Array(items)) => items
    _ => []
  }
}

///|
fn json_str(v : Json?) -> String {
  match v {
    Some(@json.String(s)) => s
    _ => ""
  }
}

///|
async fn direct_fresh_root(tag : String) -> String {
  let root = "/tmp/syncx-mb-direct-\{tag}-\{@async.now()}"
  @fs.mkdir(root, recursive=true, allow_exist=true)
  root
}

///|
/// 落一个暂存源文件(路由层职责的替身),返回路径。
async fn direct_stage_file(root : String, content : Bytes) -> String {
  let path = "\{root}/staged-\{@async.now()}"
  @fs.write_file(path, content)
  path
}

///|
async test "direct: 文本闭环 —— 对端入箱、预览、正文、删除" {
  let root_a = direct_fresh_root("ta")
  let root_b = direct_fresh_root("tb")
  let link_ba = FakeLink::new()
  let a = @direct.DirectService::new(root_a) catch { _ => panic() }
  let b = @direct.DirectService::new(root_b) catch { _ => panic() }
  let ack = match a.send_text("DEV-B", "你好，直发。", Some(link_ba.transport())) {
    Ok(ack) => ack
    Err(message) => abort("send_text 失败:\{message}")
  }
  assert_false(ack.queued)
  // A 的出站文本帧喂给 B
  assert_eq(link_ba.controls.length(), 1)
  match link_ba.controls[0] {
    @net.DirectText(id~, text~, ..) => {
      b.handle_control(
        @net.DirectText(
          id~,
          from_device_id="DEV-A",
          text~,
          created_at=1L,
          version=None,
          hostname=None,
          platform=None,
          runtime=None,
        ),
        "DEV-A",
        link_ba.transport(),
      ) catch { _ => () }
    }
    other => abort("A 发出的不是 direct-text:\{other.to_json().stringify()}")
  }
  // B 的回执(直发 result)已发出;收件箱一条、预览含正文开头
  assert_eq(link_ba.controls.length(), 2)
  let snap = b.snapshot_json()
  let inbox = json_array_field(snap, "inbox")
  assert_eq(inbox.length(), 1)
  assert_eq(json_str(json_field(inbox[0], "kind")), "text")
  assert_eq(json_str(json_field(inbox[0], "from")), "DEV-A")
  let item_id = json_str(json_field(inbox[0], "id"))
  assert_true(item_id != "")
  let content = match b.content(item_id) {
    Some((_, data)) => @utf8.decode_lossy(data)
    None => abort("收件箱条目取不到正文")
  }
  assert_eq(content, "你好，直发。")
  // 删除即清盘
  assert_true(b.remove(item_id) catch { _ => false })
  assert_eq(json_array_field(b.snapshot_json(), "inbox").length(), 0)
}

///|
async test "direct: 文本超上限被拒(64KB)" {
  let root = direct_fresh_root("tl")
  let service = @direct.DirectService::new(root) catch { _ => panic() }
  let too_long = "x".repeat(65537)
  match service.send_text("DEV-B", too_long, Some(FakeLink::new().transport())) {
    Ok(_) => abort("超上限文本不该发送成功")
    Err(_) => ()
  }
}

///|
async test "direct: 离线排队与取消" {
  let root = direct_fresh_root("tq")
  let service = @direct.DirectService::new(root) catch { _ => panic() }
  // 无通道 = 对端离线:进队列
  let ack = match service.send_text("DEV-B", "排队的文本", None) {
    Ok(ack) => ack
    Err(message) => abort("排队发送失败:\{message}")
  }
  assert_true(ack.queued)
  // 排队项不可被容量裁剪挤掉,也不可重复入箱:取消后重复取消 = NotFound
  assert_true(service.cancel_queued(ack.id) catch { _ => false })
  assert_false(service.cancel_queued(ack.id) catch { _ => true })
  // 取消是终态(非失败):快照里保留 60s,状态 canceled
  let rows = json_array_field(service.snapshot_json(), "transfers")
  assert_eq(rows.length(), 1)
  assert_eq(json_str(json_field(rows[0], "state")), "canceled")
}

///|
async test "direct: 文件分片闭环 —— 提议/接受/分片/累积水位/指纹验收/落箱" {
  let root_a = direct_fresh_root("fa")
  let root_b = direct_fresh_root("fb")
  let link_ab = FakeLink::new()
  let link_ba = FakeLink::new()
  let a = @direct.DirectService::new(root_a) catch { _ => panic() }
  let b = @direct.DirectService::new(root_b) catch { _ => panic() }
  // 744000 字节 = 62 字符 ASCII 模式串 × 12000:3 个分片
  // (256KB + 256KB + 188KB),窗口 4 一轮发完
  let base = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
  let content = @utf8.encode(base.repeat(12000))
  let sha256 = @lib.bytes_to_hex(@lib.sha256(content))
  let staged = direct_stage_file(root_a, content)
  let ack = match a.send_file(
    "DEV-B",
    "季度报表.xlsx",
    staged,
    content.length().to_int64(),
    sha256,
    Some(link_ab.transport()),
  ) {
    Ok(ack) => ack
    Err(message) => abort("send_file 失败:\{message}")
  }
  // A 的提议喂给 B:进入待确认台账,回执(accept)已发出
  let mut offer : @net.ControlMessage? = None
  for frame in link_ab.controls {
    match frame {
      @net.DirectFileOffer(..) => offer = Some(frame)
      _ => ()
    }
  }
  let offer = match offer {
    Some(offer) => offer
    None => abort("A 没发出 direct-file-offer")
  }
  b.handle_control(offer, "DEV-A", link_ba.transport()) catch { _ => () }
  assert_eq(json_array_field(b.snapshot_json(), "pending").length(), 1)
  // 待确认来源查询:回执路由的寻址兜底
  assert_eq(b.pending_from(ack.id, ""), Some("DEV-A"))
  // B 侧用户确认接收(API /api/direct/reply 的正式路径):回执入 link_ba
  let accepted = b.reply(ack.id, true, link_ba.transport()) catch { _ => false }
  assert_true(accepted)
  // B 的 accept 喂回 A:开始泵分片
  let mut reply : @net.ControlMessage? = None
  for frame in link_ba.controls {
    match frame {
      @net.DirectReply(..) => reply = Some(frame)
      _ => ()
    }
  }
  let reply = match reply {
    Some(reply) => reply
    None => abort("B 没回 direct-reply")
  }
  a.handle_control(reply, "DEV-B", link_ab.transport()) catch { _ => () }
  // A 泵出的分片逐片喂给 B(顺序即到达序)
  let chunks = link_ab.chunks
  assert_eq(chunks.length(), 3)
  // 分片逐片喂给 B(顺序即到达序);B 的回帧(前两片各一个累积 ack、
  // 末片只回 result)再喂回 A 推进水位 —— 与真机接线一致
  let mut acks = 0
  let mut results = 0
  for i in 0..<chunks.length() {
    let (id, seq, data) = chunks[i]
    b.handle_chunk(chunk_header(id, seq), data, "DEV-A", link_ba.transport()) catch {
      _ => ()
    }
    for frame in link_ba.controls {
      match frame {
        @net.DirectAck(..) => {
          a.handle_control(frame, "DEV-B", link_ab.transport()) catch { _ => () }
          acks += 1
        }
        @net.DirectResult(..) => {
          a.handle_control(frame, "DEV-B", link_ab.transport()) catch { _ => () }
          results += 1
        }
        _ => ()
      }
    }
    link_ba.controls.clear()
  }
  assert_eq(acks, 2)
  assert_eq(results, 1)
  // 收件箱一条:文件、字节数、指纹、正文逐字节一致
  let inbox = json_array_field(b.snapshot_json(), "inbox")
  assert_eq(inbox.length(), 1)
  assert_eq(json_str(json_field(inbox[0], "kind")), "file")
  assert_eq(json_str(json_field(inbox[0], "name")), "季度报表.xlsx")
  assert_eq(json_str(json_field(inbox[0], "sha256")), sha256)
  let item_id = json_str(json_field(inbox[0], "id"))
  let received = match b.content(item_id) {
    Some((_, data)) => data
    None => abort("收件箱文件取不到正文")
  }
  assert_eq(received.length(), content.length())
  for i in 0..<content.length() {
    if received[i] != content[i] {
      abort("第 \{i} 字节不一致:分片写盘走形")
    }
  }
  // A 侧台账:该笔投送已 done(终态保留 60s,快照可见)
  let mut done = false
  for row in json_array_field(a.snapshot_json(), "transfers") {
    if json_str(json_field(row, "id")) == ack.id {
      assert_eq(json_str(json_field(row, "state")), "done")
      done = true
    }
  }
  assert_true(done)
}
