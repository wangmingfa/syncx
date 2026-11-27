///|
/// 直发服务的公开面:HTTP 路由与会话接线真正调用的入口。形态对齐 Node
/// `DirectApi` + 会话侧的 handleControl / handleChunk / onPeerOffline /
/// onPeerOnline / failQueued / close。

///|
/// 当前状态快照(收件箱元数据 + 待确认 + 在途),键名 camelCase 对齐前端
/// `DirectData`;正文不进状态,按需另取 /api/direct/inbox/:id/content。
/// zip 恒 false:打包投送 MoonBit 尚未实现,按后端声明而不是按 runtime 猜。
pub fn DirectService::snapshot_json(self : DirectService) -> Json {
  let inbox : Array[Json] = []
  let mut shown = 0
  for item in self.items {
    if shown >= 100 {
      break
    }
    shown += 1
    let map : Map[String, Json] = Map([])
    match item {
      TextItem(t) => {
        map.set("kind", Json::string("text"))
        map.set("id", Json::string(t.id))
        map.set("from", Json::string(t.from))
        map.set("createdAt", Json::number(t.created_at.to_double()))
        map.set("size", Json::number(t.size.to_double()))
        map.set("preview", Json::string(t.preview))
      }
      FileItem(f) => {
        map.set("kind", Json::string("file"))
        map.set("id", Json::string(f.id))
        map.set("from", Json::string(f.from))
        map.set("createdAt", Json::number(f.created_at.to_double()))
        map.set("name", Json::string(f.name))
        map.set("size", Json::number(f.size.to_double()))
        map.set("sha256", Json::string(f.sha256))
        map.set("path", Json::string(f.path))
        if f.external {
          map.set("external", Json::boolean(true))
        }
      }
    }
    inbox.push(Json::object(map))
  }
  let pending : Array[Json] = []
  for _, inc in self.incoming {
    if inc.state != "pending" {
      continue
    }
    let map : Map[String, Json] = Map([])
    map.set("id", Json::string(inc.id))
    map.set("from", Json::string(inc.from))
    map.set("name", Json::string(inc.name))
    map.set("size", Json::number(inc.size.to_double()))
    map.set("sha256", Json::string(inc.sha256))
    map.set("createdAt", Json::number(inc.created_at.to_double()))
    match inc.batch_id {
      Some(batch_id) => map.set("batchId", Json::string(batch_id))
      None => ()
    }
    pending.push(Json::object(map))
  }
  let transfers : Array[Json] = []
  let now = now_ms()
  for _, o in self.outgoing {
    match o.finished_at {
      Some(at) => if now - at >= FINISHED_TTL_MS { continue }
      None => ()
    }
    let map : Map[String, Json] = Map([])
    map.set("id", Json::string(o.id))
    map.set("direction", Json::string("send"))
    map.set("deviceId", Json::string(o.device_id))
    map.set("kind", Json::string(o.kind))
    match o.name {
      Some(name) => map.set("name", Json::string(name))
      None => ()
    }
    map.set("size", Json::number(o.size.to_double()))
    map.set("bytesDone", Json::number(o.bytes_done.to_double()))
    map.set("state", Json::string(o.state))
    match o.error {
      Some(error) => map.set("error", Json::string(error))
      None => ()
    }
    transfers.push(Json::object(map))
  }
  for _, inc in self.incoming {
    if inc.state == "pending" {
      continue
    }
    let map : Map[String, Json] = Map([])
    map.set("id", Json::string(inc.id))
    map.set("direction", Json::string("receive"))
    map.set("deviceId", Json::string(inc.from))
    map.set("kind", Json::string("file"))
    map.set("name", Json::string(inc.name))
    map.set("size", Json::number(inc.size.to_double()))
    map.set("bytesDone", Json::number(inc.bytes_done.to_double()))
    map.set(
      "state",
      Json::string(if inc.state == "paused" { "paused" } else { "transferring" }),
    )
    transfers.push(Json::object(map))
  }
  let map : Map[String, Json] = Map([])
  map.set("inbox", Json::array(inbox))
  map.set("pending", Json::array(pending))
  map.set("transfers", Json::array(transfers))
  map.set("zip", Json::boolean(false))
  Json::object(map)
}

///|
/// 取一条收件箱内容;文件返回原始字节,文本返回 UTF-8 字节。
/// 条目不存在或文件已被手工清掉时返回 None(与 Node content 同口径)。
pub async fn DirectService::content(self : DirectService, id : String) -> (DirectItem, Bytes)? {
  let mut found : DirectItem? = None
  for item in self.items {
    if item.id() == id {
      found = Some(item)
      break
    }
  }
  let item = match found {
    Some(item) => item
    None => return None
  }
  let path = match item {
    TextItem(t) => t.path
    FileItem(f) => f.path
  }
  let data = @fs.read_file(path) catch { _ => return None }
  Some((item, data.binary()))
}

///|
/// 删除一条收件箱记录(连同正文;不可逆)。另存过的回执不删真实文件。
pub async fn DirectService::remove(self : DirectService, id : String) -> Bool {
  let mut idx = -1
  for i, item in self.items {
    if item.id() == id {
      idx = i
      break
    }
  }
  if idx < 0 {
    return false
  }
  let item = self.items[idx]
  let _ : DirectItem = self.items.remove(idx)
  self.save_index()
  match item {
    FileItem(f) =>
      if !f.external {
        remove_quiet(f.path)
      }
    _ => ()
  }
  true
}

///|
/// 发起文本直发;目标离线时进队列,等它上线自动投递。文本长度必须在
/// 1 ~ 64KB UTF-8 字节之间。
pub async fn DirectService::send_text(
  self : DirectService,
  device_id : String,
  text : String,
  tx : DirectTransport?,
) -> Result[DirectSendAck, String] {
  let len = @utf8.encode(text).length().to_int64()
  if len == 0L || len > DIRECT_MAX_TEXT_BYTES {
    return Err("文本长度必须在 1 ~ \{DIRECT_MAX_TEXT_BYTES} 字节之间")
  }
  match tx {
    None =>
      match self.check_queue_room(0L) {
        Some(message) => return Err(message)
        None => ()
      }
    Some(_) => ()
  }
  let id = match direct_id("dt") {
    Some(id) => id
    None => return Err("系统熵源不可用,无法生成投送 id")
  }
  let now = now_ms()
  let out : Outgoing = {
    id,
    device_id,
    kind: "text",
    name: None,
    size: len,
    bytes_done: 0L,
    state: match tx {
      Some(_) => "offering"
      None => "queued"
    },
    error: None,
    created_at: now,
    finished_at: None,
    offer_sent_at: now,
    resuming: false,
    paused_at: None,
    queued_at: match tx {
      Some(_) => None
      None => Some(now)
    },
    text: match tx {
      Some(_) => None
      None => Some(text)
    },
    batch_id: None,
    source_path: None,
    fd: None,
    sha256: None,
    total_chunks: None,
    acked: 0L,
    next_seq: 0L,
    inflight: Map([]),
    last_progress_at: now,
  }
  self.new_outgoing(out)
  match tx {
    None => return Ok({ id, queued: true })
    Some(tx) => {
      let _ = (tx.control)(
        @net.ControlMessage::DirectText(
          id=out.id,
          from_device_id="",
          text~,
          created_at=out.created_at,
          version=None,
          hostname=None,
          platform=None,
          runtime=None,
        ),
      ) catch { _ => false }
    }
  }
  Ok({ id, queued: false })
}

///|
/// 发起文件直发;sourcePath 是已落在**非共享暂存区**的完整文件(路由层
/// 负责把上传体落到那里并算好指纹)。目标离线时进队列。batchId 把同一次
/// 多文件投送的几条提议串起来(缺省 = 各算各的)。
pub async fn DirectService::send_file(
  self : DirectService,
  device_id : String,
  file_name : String,
  source_path : String,
  size : Int64,
  sha256 : String,
  tx : DirectTransport?,
  batch_id~ : String? = None,
) -> Result[DirectSendAck, String] {
  if size <= 0L || size > DIRECT_MAX_FILE_BYTES {
    return Err("文件大小必须在 1 ~ \{DIRECT_MAX_FILE_BYTES} 字节之间")
  }
  if !is_sha256_hex(sha256) {
    return Err("文件指纹格式不正确")
  }
  match tx {
    None =>
      match self.check_queue_room(size) {
        Some(message) => return Err(message)
        None => ()
      }
    Some(_) => ()
  }
  let id = match direct_id("df") {
    Some(id) => id
    None => return Err("系统熵源不可用,无法生成投送 id")
  }
  let now = now_ms()
  let normalized_batch = match batch_id {
    Some(b) => if is_safe_id(b) { Some(b) } else { None }
    None => None
  }
  let out : Outgoing = {
    id,
    device_id,
    kind: "file",
    name: Some(safe_file_name(file_name)),
    size,
    bytes_done: 0L,
    state: match tx {
      Some(_) => "offering"
      None => "queued"
    },
    error: None,
    created_at: now,
    finished_at: None,
    offer_sent_at: now,
    resuming: false,
    paused_at: None,
    queued_at: match tx {
      Some(_) => None
      None => Some(now)
    },
    text: None,
    batch_id: normalized_batch,
    source_path: Some(source_path),
    fd: None,
    sha256: Some(sha256),
    total_chunks: Some((size + DIRECT_CHUNK_BYTES - 1L) / DIRECT_CHUNK_BYTES),
    acked: 0L,
    next_seq: 0L,
    inflight: Map([]),
    last_progress_at: now,
  }
  self.new_outgoing(out)
  match tx {
    None => return Ok({ id, queued: true })
    Some(tx) => {
      let _ = (tx.control)(offer_message(out)) catch { _ => false }
    }
  }
  Ok({ id, queued: false })
}

///|
/// 登记一笔新投送:进台账 + 暂存引用计数 + 容量裁剪(排队项不可被挤掉)
/// + 排队项落盘。
async fn DirectService::new_outgoing(self : DirectService, out : Outgoing) -> Unit {
  self.outgoing.set(out.id, out)
  match out.source_path {
    Some(path) => {
      let left = self.source_refs.get(path).unwrap_or(0) + 1
      self.source_refs.set(path, left)
    }
    None => ()
  }
  // 只保留最近若干条,免得状态快照无限增长。排队项不能被顺手挤掉 ——
  // 那是用户明确交代要等设备上线的东西,只有它自己的超时/取消才算数。
  if self.outgoing.length() > OUTGOING_CAP {
    let mut oldest : Outgoing? = None
    for _, o in self.outgoing {
      if o.state == "queued" {
        continue
      }
      match oldest {
        Some(current) =>
          if o.created_at < current.created_at {
            oldest = Some(o)
          }
        None => oldest = Some(o)
      }
    }
    match oldest {
      Some(victim) => {
        self.release_source(victim)
        self.outgoing.remove(victim.id)
      }
      None => ()
    }
  }
  if out.state == "queued" {
    self.save_queue()
  }
}

///|
/// 处理经会话验签归属后的控制消息。身份一律用 from(会话对端),不信消息体。
pub async fn DirectService::handle_control(
  self : DirectService,
  message : @net.ControlMessage,
  from : String,
  tx : DirectTransport,
) -> Unit {
  match message {
    DirectText(id~, text~, ..) => {
      if !is_safe_id(id) {
        return
      }
      let len = @utf8.encode(text).length().to_int64()
      if len == 0L || len > DIRECT_MAX_TEXT_BYTES {
        return
      }
      if self.outgoing.contains(id) || self.incoming.contains(id) {
        return
      }
      let saved = self.add_text_item(from, text) catch { _ => None }
      match saved {
        Some(_) => ()
        None => return
      }
      let _ = (tx.control)(
        @net.ControlMessage::DirectResult(
          id~,
          from_device_id="",
          ok=true,
          error=None,
          version=None,
          hostname=None,
          platform=None,
          runtime=None,
        ),
      ) catch { _ => false }
    }
    DirectFileOffer(id~, name~, size~, sha256~, created_at~, batch_id~, ..) => {
      if !is_safe_id(id) {
        return
      }
      match self.incoming.get(id) {
        Some(paused) => {
          // 同一 id 又来一次 = 对端重连后重新提议:能接着传就静默继续;
          // 接不上就按新提议重来。
          if paused.state == "paused" {
            if self.resume_incoming(paused, size, sha256, from, tx) {
              return
            }
            self.cleanup_incoming(paused)
          } else {
            return
          }
        }
        None => ()
      }
      if size <= 0L || size > DIRECT_MAX_FILE_BYTES || !is_sha256_hex(sha256) {
        return
      }
      // 收件箱配额:只统计已落盘条目,在途的各自有暂存上限兜着
      let mut used : Int64 = 0L
      for item in self.items {
        used += item.size()
      }
      if used + size > DIRECT_INBOX_QUOTA_BYTES {
        let _ = (tx.control)(
          @net.ControlMessage::DirectResult(
            id~,
            from_device_id="",
            ok=false,
            error=Some("本机收件箱空间不足"),
            version=None,
            hostname=None,
            platform=None,
            runtime=None,
          ),
        ) catch { _ => false }
        return
      }
      let normalized_batch = match batch_id {
        Some(b) => if is_safe_id(b) { Some(b) } else { None }
        None => None
      }
      let inc : Incoming = {
        id,
        from,
        name: safe_file_name(name),
        size,
        sha256,
        created_at: if created_at > 0L { created_at } else { now_ms() },
        tmp_path: join_path(self.tmp_dir_path, "in-\{id}"),
        save_dir: None,
        batch_id: normalized_batch,
        state: "pending",
        paused_at: None,
        fd: None,
        hash: None,
        next_seq: 0L,
        total_chunks: (size + DIRECT_CHUNK_BYTES - 1L) / DIRECT_CHUNK_BYTES,
        bytes_done: 0L,
        received: Map([]),
        buffered: Map([]),
        last_progress_at: now_ms(),
      }
      self.incoming.set(id, inc)
    }
    DirectReply(id~, accept~, reason~, offset~, ..) => {
      let out = match self.outgoing.get(id) {
        Some(out) => out
        None => return
      }
      if out.device_id != from || out.state != "offering" {
        return
      }
      if !accept {
        self.finish_outgoing(out, false, Some(reason.unwrap_or("对方拒绝了这次发送")))
        return
      }
      if out.fd is Some(_) || out.total_chunks is None {
        return
      }
      // 续传:接收方告诉我们它已经落盘多少字节,从对应片号接着发。
      // 只认「本轮就是续传」的 offset —— 新投送若收到非 0 偏移,说明对方
      // 状态不干净,直接失败。
      match offset {
        Some(offset) if offset != 0L => {
          let usable = out.resuming &&
            offset > 0L &&
            offset % DIRECT_CHUNK_BYTES == 0L &&
            offset < out.size
          if !usable {
            self.finish_outgoing(out, false, Some("续传位置不合法"))
            return
          }
          out.acked = offset / DIRECT_CHUNK_BYTES
          out.next_seq = out.acked
          out.bytes_done = offset
          out.inflight.clear()
        }
        _ => ()
      }
      out.state = "transferring"
      out.resuming = false
      out.paused_at = None
      out.last_progress_at = now_ms()
      self.save_resume()
      let source_path = match out.source_path {
        Some(path) => path
        None => return
      }
      let file = @fs.open(source_path, mode=ReadOnly) catch {
        e => {
          self.finish_outgoing(out, false, Some("打开待发文件失败:\{e}"))
          return
        }
      }
      out.fd = Some(file)
      self.pump(out, tx)
    }
    DirectAck(id~, seq~, ..) => {
      let out = match self.outgoing.get(id) {
        Some(out) => out
        None => return
      }
      if out.device_id != from || out.state != "transferring" {
        return
      }
      let total = out.total_chunks.unwrap_or(0L)
      if seq <= out.acked || seq > total {
        return
      }
      out.acked = seq
      let progressed = seq * DIRECT_CHUNK_BYTES
      out.bytes_done = if progressed > out.size { out.size } else { progressed }
      out.last_progress_at = now_ms()
      let stale : Array[Int64] = []
      for s, _ in out.inflight {
        if s < seq {
          stale.push(s)
        }
      }
      for s in stale {
        out.inflight.remove(s)
      }
      self.pump(out, tx)
    }
    DirectResult(id~, ok~, error~, ..) => {
      let out = match self.outgoing.get(id) {
        Some(out) => out
        None => return
      }
      if out.device_id != from {
        return
      }
      self.finish_outgoing(out, ok, error)
    }
    DirectCancel(id~, reason~, ..) => {
      match self.incoming.get(id) {
        Some(inc) =>
          if inc.from == from {
            self.cleanup_incoming(inc)
          }
        None => ()
      }
      match self.outgoing.get(id) {
        Some(out) =>
          if out.device_id == from && out.state != "done" && out.state != "failed" {
            self.finish_outgoing(out, false, Some(reason))
          }
        None => ()
      }
    }
    _ => return
  }
}

///|
/// 处理一个直发文件分片帧(会话已解密、已按连接归属)。
pub async fn DirectService::handle_chunk(
  self : DirectService,
  header : Map[String, Json],
  body : Bytes,
  from : String,
  tx : DirectTransport,
) -> Unit {
  let id = match header.get("id") {
    Some(String(value)) => value
    _ => return
  }
  let seq = match header.get("seq") {
    Some(Number(n, ..)) => n.to_int64()
    _ => return
  }
  if !is_safe_id(id) || seq < 0L {
    return
  }
  let inc = match self.incoming.get(id) {
    Some(inc) => inc
    None => return
  }
  if inc.from != from || inc.state != "transferring" {
    return
  }
  if seq >= inc.total_chunks {
    return
  }
  let len = body.length().to_int64()
  if len == 0L || len > DIRECT_CHUNK_BYTES {
    return
  }
  if seq * DIRECT_CHUNK_BYTES + len > inc.size {
    return
  }
  if seq < inc.next_seq {
    // 重复片:只回当前期望,绝不把字节写第二遍
    let _ = (tx.control)(
      @net.ControlMessage::DirectAck(
        id=inc.id,
        from_device_id="",
        seq=inc.next_seq,
        version=None,
        hostname=None,
        platform=None,
        runtime=None,
      ),
    ) catch { _ => false }
    return
  }
  if inc.received.contains(seq) {
    return
  }
  if seq > inc.next_seq {
    if inc.buffered.length() < MAX_BUFFERED_CHUNKS {
      inc.buffered.set(seq, body)
    }
    let _ = (tx.control)(
      @net.ControlMessage::DirectAck(
        id=inc.id,
        from_device_id="",
        seq=inc.next_seq,
        version=None,
        hostname=None,
        platform=None,
        runtime=None,
      ),
    ) catch { _ => false }
    return
  }
  inc.received.set(seq, true)
  inc.buffered.set(seq, body)
  self.write_sequential(inc, tx)
}

///|
/// 单条待确认项的确认/拒绝。批量入口也走这里 —— 两条路径分叉过一次就很难对齐。
async fn DirectService::reply_one(
  self : DirectService,
  inc : Incoming,
  accept : Bool,
  tx : DirectTransport,
  reason~ : String? = None,
) -> Bool {
  if inc.state != "pending" {
    return false
  }
  if !accept {
    let _ = (tx.control)(
      @net.ControlMessage::DirectReply(
        id=inc.id,
        from_device_id="",
        accept=false,
        reason=Some(reason.unwrap_or("对方拒绝了接收")),
        offset=None,
        version=None,
        hostname=None,
        platform=None,
        runtime=None,
      ),
    ) catch { _ => false }
    self.cleanup_incoming(inc)
    return true
  }
  inc.state = "transferring"
  inc.last_progress_at = now_ms()
  let file = @fs.open(inc.tmp_path, mode=WriteOnly, create_mode=CreateOrTruncate) catch {
    e => {
      let _ = (tx.control)(
        @net.ControlMessage::DirectResult(
          id=inc.id,
          from_device_id="",
          ok=false,
          error=Some("创建临时文件失败:\{e}"),
          version=None,
          hostname=None,
          platform=None,
          runtime=None,
        ),
      ) catch { _ => false }
      self.cleanup_incoming(inc)
      return true
    }
  }
  inc.fd = Some(file)
  inc.hash = Some(@core.Sha256::new())
  self.save_resume()
  let _ = (tx.control)(
    @net.ControlMessage::DirectReply(
      id=inc.id,
      from_device_id="",
      accept=true,
      reason=None,
      offset=None,
      version=None,
      hostname=None,
      platform=None,
      runtime=None,
    ),
  ) catch { _ => false }
  true
}

///|
/// 接收方确认 / 拒绝一个待确认文件。返回是否处理了一条(不存在/非待确认
/// 返回 false)。
pub async fn DirectService::reply(
  self : DirectService,
  id : String,
  accept : Bool,
  tx : DirectTransport,
  reason~ : String? = None,
) -> Bool {
  match self.incoming.get(id) {
    Some(inc) => self.reply_one(inc, accept, tx, reason~)
    None => false
  }
}

///|
/// 按 batchId 成组确认:同一次多文件投送的几条提议一起处理,返回条数。
pub async fn DirectService::reply_batch(
  self : DirectService,
  batch_id : String,
  accept : Bool,
  tx : DirectTransport,
  reason~ : String? = None,
) -> Int {
  if !is_safe_id(batch_id) {
    return 0
  }
  // 一组只属于一个发送方(组号由发送端每次发送生成)。显式按 from 收紧:
  // 万一两个对端撞了组号,也只处理当前会话这台设备的,不会把 accept 发给别人。
  let mut first_from : String? = None
  for _, inc in self.incoming {
    if inc.batch_id == Some(batch_id) && inc.state == "pending" {
      first_from = Some(inc.from)
      break
    }
  }
  let from = match first_from {
    Some(from) => from
    None => return 0
  }
  // 按到达顺序处理:虽然传输会并行,拒绝/接受的先后仍与发送方的选择顺序一致。
  let group : Array[Incoming] = []
  for _, inc in self.incoming {
    if inc.batch_id == Some(batch_id) && inc.state == "pending" && inc.from == from {
      group.push(inc)
    }
  }
  group.sort_by(cmp_by_created)
  let mut handled = 0
  for inc in group {
    if self.reply_one(inc, accept, tx, reason~) {
      handled += 1
    }
  }
  handled
}

///|
/// created_at 升序的插入比较器(reply_batch 用;条数 ≤ 20,不引排序器)。
fn cmp_by_created(a : Incoming, b : Incoming) -> Int {
  if a.created_at < b.created_at {
    -1
  } else if a.created_at > b.created_at {
    1
  } else {
    0
  }
}

///|
/// 连接掉线:在途传输转为暂停(半截字节保留),等重连续传;无续传能力时
/// 直接失败。同一设备可能有多条连接:断掉的也许只是备份 —— 现取通道还有
/// 效就什么都不动,别把健康传输打成暂停。
pub async fn DirectService::on_peer_offline(self : DirectService, device_id : String) -> Unit {
  if ((self.get_transport)(device_id)) is Some(_) {
    return
  }
  let incs : Array[Incoming] = []
  for _, inc in self.incoming {
    if inc.from == device_id {
      incs.push(inc)
    }
  }
  for inc in incs {
    // 已经收了一部分:留半截等重连续传;还没开始收的提议随会话一起作废。
    if inc.state == "transferring" {
      self.pause_incoming(inc)
    } else {
      self.cleanup_incoming(inc)
    }
  }
  let outs : Array[Outgoing] = []
  for _, out in self.outgoing {
    if out.device_id == device_id && out.state != "done" && out.state != "failed" {
      outs.push(out)
    }
  }
  for out in outs {
    if out.resuming {
      continue // 已经在等重连,不重复处理
    }
    // 排队项本来就在等设备上线,链路断不断都与它无关,继续排着。
    if out.state == "queued" {
      continue
    }
    // 只有「真传过字节」且具备现取通道能力才值得等重连;否则保持旧的快速
    // 失败,免得半截暂存挂着没人接手。
    if out.state == "transferring" && self.can_resume {
      self.pause_outgoing(out)
    } else {
      self.cancel_outgoing(out, "设备已离线", None)
    }
  }
}

///|
/// 新会话建立:把暂停中的投送重新提议一次,并补发离线期间排队的内容
/// (无对应项时是空操作)。
pub async fn DirectService::on_peer_online(
  self : DirectService,
  device_id : String,
  tx : DirectTransport,
) -> Unit {
  // 先补发离线期间排下的内容,再处理掉线续传 —— 两者的 id 不会重叠,顺序只为可读。
  self.flush_queued(device_id, tx)
  self.reoffer_paused(device_id, tx)
}

///|
/// 设备上来了却发不了(版本过旧 / 已不在互信列表):把为它排队的条目立刻
/// 判失败。不这样做的话,用户要等满 24 小时窗口才收到一句「设备未上线」。
pub async fn DirectService::fail_queued(self : DirectService, device_id : String, reason : String) -> Unit {
  let outs : Array[Outgoing] = []
  for _, out in self.outgoing {
    if out.device_id == device_id && out.state == "queued" {
      outs.push(out)
    }
  }
  for out in outs {
    self.cancel_outgoing(out, reason, None)
  }
}

///|
/// 用户主动取消排队:只对 `queued` 生效,回收暂存文件并从台账里划掉。
/// 用户主动取消不是「失败」:单独一个终态,UI 才不会把它染成红色错误。
pub async fn DirectService::cancel_queued(self : DirectService, id : String) -> Bool {
  let out = match self.outgoing.get(id) {
    Some(out) => out
    None => return false
  }
  if out.state != "queued" {
    return false
  }
  match out.fd {
    Some(fd) => {
      fd.close()
      out.fd = None
    }
    None => ()
  }
  out.state = "canceled"
  out.error = None
  out.finished_at = Some(now_ms())
  self.release_source(out)
  self.save_queue()
  true
}

///|
/// daemon 关闭:停表。具备续传能力时,传了一半的进出站传输转成暂停、半截
/// 与暂存文件留在盘上(下次启动接着传);其余状态照旧清理。
pub async fn DirectService::close(self : DirectService) -> Unit {
  self.closing = true
  let incs : Array[Incoming] = []
  for _, inc in self.incoming {
    incs.push(inc)
  }
  for inc in incs {
    // 传了一半的入站传输:转暂停、把半截留在盘上,下次启动接着收 —— 重启
    // 一次不该让几十 MB 白传。一个字节都还没写的提议没有续传价值,照旧清掉。
    let keep_half = self.can_resume &&
      inc.bytes_done > 0L &&
      (inc.state == "transferring" || inc.state == "paused")
    if keep_half {
      self.pause_incoming(inc)
      continue
    }
    self.cleanup_incoming(inc)
  }
  let outs : Array[Outgoing] = []
  for _, out in self.outgoing {
    outs.push(out)
  }
  for out in outs {
    match out.fd {
      Some(fd) => {
        fd.close()
        out.fd = None
      }
      None => ()
    }
    // 排队项要跨重启:暂存文件与 queue.json 都得原样留着,下次启动接着等。
    if out.state == "queued" {
      continue
    }
    // 出站同理:传了一半(或已经在等重连)的保留暂存文件,重启后重新提议,
    // 从对方给的偏移继续。终态照旧回收。
    let keep_half = self.can_resume &&
      out.kind == "file" &&
      out.finished_at is None &&
      (out.state == "transferring" || out.resuming)
    if keep_half {
      self.pause_outgoing(out)
      continue
    }
    self.release_source(out)
  }
  self.save_resume()
  self.source_refs.clear()
  self.queued_probe_at.clear()
}

///|
/// 兜底定时器:每秒一拍 —— 提议超时 / 分片重发 / 续传重提议 / 队列探测 /
/// 终态清理。装配层用 spawn_bg 起它(daemon 活着它就活着)。
pub async fn DirectService::run_timer(self : DirectService) -> Unit {
  for ;; {
    @async.sleep(1)
    if self.closing {
      return
    }
    self.timer_tick()
  }
}

///|
/// 定时器的一拍(拆出来供测试注入时间推进)。
async fn DirectService::timer_tick(self : DirectService) -> Unit {
  let now = now_ms()
  let resumed_devices : Map[String, Bool] = Map([])
  let outs : Array[Outgoing] = []
  for _, out in self.outgoing {
    outs.push(out)
  }
  for out in outs {
    if out.resuming {
      // 续传窗口内一直重发提议:对方的会话可能还在握手,早发的会被丢弃。
      let anchor = out.paused_at.unwrap_or(now)
      if now - anchor > DIRECT_RESUME_TTL_MS {
        self.cancel_outgoing(out, "设备离线时间过长,已中止发送", None)
        continue
      }
      let due = out.state != "transferring" &&
        !resumed_devices.contains(out.device_id) &&
        now - out.offer_sent_at >= DIRECT_RESUME_RETRY_MS
      if due {
        resumed_devices.set(out.device_id, true)
        match (self.get_transport)(out.device_id) {
          Some(tx) => self.reoffer_paused(out.device_id, tx)
          None => ()
        }
      }
      continue
    }
    if out.state == "offering" && now - out.offer_sent_at > DIRECT_OFFER_TIMEOUT_MS {
      self.cancel_outgoing(out, "对方未在 2 分钟内确认", None)
      continue
    }
    if out.state != "transferring" {
      continue
    }
    if now - out.last_progress_at > DIRECT_STALL_TIMEOUT_MS {
      self.cancel_outgoing(out, "对方长时间没有确认,已中止", None)
      continue
    }
    // 分片重发:超 5s 没确认就重读磁盘重发;3 次仍不确认整笔放弃。
    let slots : Array[(Int64, InflightSlot)] = []
    for seq, slot in out.inflight {
      slots.push((seq, slot))
    }
    let mut gave_up = false
    for pair in slots {
      let (seq, slot) = pair
      if now - slot.sent_at < DIRECT_RETRY_MS {
        continue
      }
      if slot.attempts >= DIRECT_MAX_RETRIES {
        self.cancel_outgoing(
          out,
          "第 \{seq + 1L} 片重试 \{DIRECT_MAX_RETRIES} 次仍未确认",
          None,
        )
        gave_up = true
        break
      }
      slot.attempts += 1
      slot.sent_at = now
      self.resend(out, seq)
    }
    ignore(gave_up)
  }
  let incs : Array[Incoming] = []
  for _, inc in self.incoming {
    incs.push(inc)
  }
  for inc in incs {
    if inc.state == "paused" {
      let anchor = inc.paused_at.unwrap_or(now)
      if now - anchor > DIRECT_RESUME_TTL_MS {
        self.cleanup_incoming(inc)
        continue
      }
    }
    if inc.state == "transferring" && now - inc.last_progress_at > DIRECT_STALL_TIMEOUT_MS {
      // 会话还挂着却没进展(对端假死):丢弃半截,等它重连后重新提议。
      self.cleanup_incoming(inc)
    }
  }
  // 终态记录过期清理(给 UI 足够时间看到结果)
  let expired : Array[String] = []
  for id, out in self.outgoing {
    match out.finished_at {
      Some(at) => if now - at > FINISHED_TTL_MS { expired.push(id) }
      None => ()
    }
  }
  for id in expired {
    self.outgoing.remove(id)
  }
  // 排队项:超窗口就放弃;否则定期探一次现取通道,兜住「会话建立早于入队」的竞态。
  let queued : Array[Outgoing] = []
  for _, out in self.outgoing {
    if out.state == "queued" {
      queued.push(out)
    }
  }
  for out in queued {
    let anchor = out.queued_at.unwrap_or(out.created_at)
    if now - anchor > DIRECT_QUEUE_TTL_MS {
      self.cancel_outgoing(out, "设备 24 小时内未上线,已取消发送", None)
      continue
    }
    let last_probe = self.queued_probe_at.get(out.device_id).unwrap_or(0L)
    if now - last_probe < DIRECT_QUEUE_PROBE_MS {
      continue
    }
    self.queued_probe_at.set(out.device_id, now)
    match (self.get_transport)(out.device_id) {
      Some(tx) => self.flush_queued(out.device_id, tx)
      None => ()
    }
  }
}

///|
/// 重发一片:从磁盘重读(内存里的副本可能被上一轮截短)。
async fn DirectService::resend(self : DirectService, out : Outgoing, seq : Int64) -> Unit {
  let slot = match out.inflight.get(seq) {
    Some(slot) => slot
    None => return
  }
  let fd = match out.fd {
    Some(fd) => fd
    None => return
  }
  let tx = match (self.get_transport)(out.device_id) {
    Some(tx) => tx
    None => return
  }
  let data = fd.read_exactly_at(slot.body.length(), position=seq * DIRECT_CHUNK_BYTES) catch {
    _ => {
      self.cancel_outgoing(out, "重读待发文件失败", None)
      return
    }
  }
  if data.length() == 0 {
    self.cancel_outgoing(out, "待发文件在传输中被改动,已中止", None)
    return
  }
  slot.body = data
  let _ = (tx.chunk)(out.id, seq, data) catch { _ => false }
}
