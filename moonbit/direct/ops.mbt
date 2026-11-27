///|
/// 直发状态机的动作面:发送 / 接收 / 确认 / 定时器 / 快照。语义逐条对照
/// Node `src/direct.ts` 的 createDirectService —— 那份实现已经过三端互通
/// 检验,偏离它的每一步都要先在注释里说清为什么。

///|
/// 释放一笔投送对暂存文件的引用;只有群发的最后一笔才真正删文件。
async fn DirectService::release_source(self : DirectService, out : Outgoing) -> Unit {
  let path = match out.source_path {
    Some(path) => path
    None => return
  }
  out.source_path = None
  let left = self.source_refs.get(path).unwrap_or(1) - 1
  if left > 0 {
    self.source_refs.set(path, left)
    return
  }
  self.source_refs.remove(path)
  remove_quiet(path)
}

///|
/// 按**最后一个**点切文件名主干与扩展名("a.b.c" → ("a.b", ".c"));
/// 开头的点不算(隐藏文件 ".bashrc" 主干就是它自己)。
fn split_extension(name : String) -> (String, String) {
  let mut dot = -1
  let mut i = 0
  for ch in name {
    if ch == '.' {
      dot = i
    }
    i += 1
  }
  if dot <= 0 {
    return (name, "")
  }
  let stem = StringBuilder()
  let ext = StringBuilder()
  let mut j = 0
  for ch in name {
    if j < dot {
      stem.write_char(ch)
    } else {
      ext.write_char(ch)
    }
    j += 1
  }
  (stem.to_string(), ext.to_string())
}

///|
/// 收件箱或用户指定目录里的不覆盖落点:同名一律加 (n) 后缀。
async fn unique_file_path(name : String, dir : String) -> String {
  let safe = safe_file_name(name)
  let mut candidate = join_path(dir, safe)
  let mut n = 1
  while (@fs.exists(candidate) catch { _ => false }) {
    let (stem, ext) = split_extension(safe)
    candidate = join_path(dir, "\{stem} (\{n})\{ext}")
    n += 1
  }
  candidate
}

///|
/// 文件提议(首发与续传重发共用同一条消息,id 不变)。
fn offer_message(out : Outgoing) -> @net.ControlMessage {
  @net.ControlMessage::DirectFileOffer(
    id=out.id,
    from_device_id="",
    name=out.name.unwrap_or("未命名文件"),
    size=out.size,
    sha256=out.sha256.unwrap_or(""),
    created_at=out.created_at,
    batch_id=out.batch_id,
    version=None,
    hostname=None,
    platform=None,
    runtime=None,
  )
}

///|
/// 出站投送失败/取消收尾:关句柄、记终态、释放暂存、清台账,必要时通知
/// 对端取消(半截文件让对端自己清)。
async fn DirectService::cancel_outgoing(
  self : DirectService,
  out : Outgoing,
  error : String,
  tx : DirectTransport?,
) -> Unit {
  match out.fd {
    Some(fd) => {
      fd.close()
      out.fd = None
    }
    None => ()
  }
  if out.state != "done" && out.state != "failed" {
    out.state = "failed"
    out.error = Some(error)
  }
  out.finished_at = Some(now_ms())
  self.release_source(out)
  // 排队项失败/超时也要从台账里划掉,否则重启后又把它捞回来。
  self.save_queue()
  self.save_resume()
  if out.state == "failed" {
    match tx {
      Some(tx) => {
        let _ = (tx.control)(
          @net.ControlMessage::DirectCancel(
            id=out.id,
            from_device_id="",
            reason=out.error.unwrap_or("传输失败"),
            version=None,
            hostname=None,
            platform=None,
            runtime=None,
          ),
        ) catch { _ => false }
      }
      None => ()
    }
  }
}

///|
/// 出站投送正常收尾(成功或带错误终止)。
async fn DirectService::finish_outgoing(
  self : DirectService,
  out : Outgoing,
  ok : Bool,
  error : String?,
) -> Unit {
  match out.fd {
    Some(fd) => {
      fd.close()
      out.fd = None
    }
    None => ()
  }
  if ok {
    out.state = "done"
    out.error = None
  } else {
    out.state = "failed"
    out.error = Some(error.unwrap_or("传输失败"))
  }
  out.finished_at = Some(now_ms())
  self.release_source(out)
  self.save_queue()
  self.save_resume()
}

///|
/// 入站投送清理:关句柄、丢乱序缓存、删半截文件、摘台账。
async fn DirectService::cleanup_incoming(self : DirectService, inc : Incoming) -> Unit {
  match inc.fd {
    Some(fd) => {
      fd.close()
      inc.fd = None
    }
    None => ()
  }
  inc.buffered.clear()
  remove_quiet(inc.tmp_path)
  self.incoming.remove(inc.id)
  self.save_resume()
}

///|
/// 暂停入站传输:关句柄、留半截文件,等对方重连后从已落盘字节继续。
/// 指纹对象不能续接:续传时按磁盘上已有的整片字节重建。
async fn DirectService::pause_incoming(self : DirectService, inc : Incoming) -> Unit {
  match inc.fd {
    Some(fd) => {
      fd.close()
      inc.fd = None
    }
    None => ()
  }
  inc.buffered.clear()
  inc.received.clear()
  inc.hash = None
  inc.state = "paused"
  inc.paused_at = Some(now_ms())
  self.save_resume()
}

///|
/// 暂停出站传输:关句柄、留暂存文件与已确认片号,等重连后重新提议。
async fn DirectService::pause_outgoing(self : DirectService, out : Outgoing) -> Unit {
  match out.fd {
    Some(fd) => {
      fd.close()
      out.fd = None
    }
    None => ()
  }
  out.inflight.clear()
  out.state = "paused"
  out.resuming = true
  out.paused_at = Some(now_ms())
  out.error = None
  self.save_resume()
}

///|
/// 只重算前 bytes 个字节的指纹:续传不重读整份文件,但必须与一次性哈希等价。
/// 读不下去 = None(半截文件被动过,不再相信)。
async fn rebuild_hash(file : @fs.File, bytes : Int64) -> @core.Sha256? {
  let hash = @core.Sha256::new()
  let piece = 1024 * 1024
  let mut pos : Int64 = 0L
  while pos < bytes {
    let mut want = bytes - pos
    if want > piece.to_int64() {
      want = piece.to_int64()
    }
    let data = file.read_exactly_at(want.to_int(), position=pos) catch { _ => return None }
    hash.update(data, 0, data.length())
    pos += data.length().to_int64()
  }
  Some(hash)
}

///|
/// 对端重连后重新提议:若本机已有同 id 的半截文件且内容一致,直接从这里继续,
/// **不再让用户确认一次**(他早就确认过这次接收)。返回 false 表示无法续传,
/// 调用方按普通新提议处理。
async fn DirectService::resume_incoming(
  self : DirectService,
  inc : Incoming,
  size : Int64,
  sha256 : String,
  from : String,
  tx : DirectTransport,
) -> Bool {
  // name 不参与续传判定:同 id 的内容以 size/sha256 为准(Node 同口径)
  if inc.from != from || inc.sha256 != sha256 || inc.size != size {
    return false
  }
  let offset = inc.bytes_done
  // 落盘永远是整片顺序写,所以可续传的位置必然对齐到片边界;对不齐就不再
  // 相信这份半截。
  if offset % DIRECT_CHUNK_BYTES != 0L || offset >= inc.size {
    return false
  }
  let file = @fs.open(inc.tmp_path, mode=ReadWrite) catch { _ => return false }
  let hash = match rebuild_hash(file, offset) {
    Some(hash) => hash
    None => {
      file.close()
      return false
    }
  }
  inc.fd = Some(file)
  inc.hash = Some(hash)
  inc.next_seq = offset / DIRECT_CHUNK_BYTES
  inc.state = "transferring"
  inc.paused_at = None
  inc.last_progress_at = now_ms()
  // 已经接上了:从台账里撤掉,别让重启后的自己以为它还停在那儿。
  self.save_resume()
  let _ = (tx.control)(
    @net.ControlMessage::DirectReply(
      id=inc.id,
      from_device_id="",
      accept=true,
      reason=None,
      offset=Some(offset),
      version=None,
      hostname=None,
      platform=None,
      runtime=None,
    ),
  ) catch { _ => false }
  true
}

///|
/// 新会话就绪:对这台设备所有暂停中的投送重新提议一次。
async fn DirectService::reoffer_paused(
  self : DirectService,
  device_id : String,
  tx : DirectTransport,
) -> Unit {
  let now = now_ms()
  let batch : Array[Outgoing] = []
  for _, out in self.outgoing {
    if out.device_id == device_id && out.resuming {
      batch.push(out)
    }
  }
  for out in batch {
    // 刚开始的这几秒内不抢跑:定时器与 on_peer_online 可能同时到,别一轮发两次。
    if now - out.offer_sent_at < 1_000L && out.state == "offering" {
      continue
    }
    out.state = "offering"
    out.offer_sent_at = now
    let _ = (tx.control)(offer_message(out)) catch { _ => false }
  }
}

///|
/// 设备上线:把为它排队的文本/文件按入队顺序补发。
/// 控制帧发失败说明会话又断了,该条退回队列(不重置入队时间,24 小时窗口照算)。
async fn DirectService::flush_queued(
  self : DirectService,
  device_id : String,
  tx : DirectTransport,
) -> Unit {
  let now = now_ms()
  // 按 createdAt 排序(入队顺序):收集后插入排序,条数 ≤ 20,平方代价可忽略。
  let batch : Array[Outgoing] = []
  for _, out in self.outgoing {
    if out.device_id == device_id && out.state == "queued" {
      batch.push(out)
    }
  }
  if batch.length() == 0 {
    return
  }
  // 简单插入排序(按 createdAt 升序)
  for i in 1..<batch.length() {
    let key = batch[i]
    let mut j = i - 1
    while j >= 0 && batch[j].created_at > key.created_at {
      batch[j + 1] = batch[j]
      j -= 1
    }
    batch[j + 1] = key
  }
  for out in batch {
    // 先置状态再发:文本的 result 可能在同一拍里就回来(直接判 done),
    // 发完再改状态会把已完成覆盖回 offering。
    out.state = "offering"
    out.offer_sent_at = now
    out.queued_at = None
    // 正文先取走再发:发送失败时还回去(24 小时窗口照原样算)。
    let text = out.text
    if out.kind == "text" {
      out.text = None
    }
    let sent = match out.kind {
      "text" =>
        (tx.control)(
          @net.ControlMessage::DirectText(
            id=out.id,
            from_device_id="",
            text=text.unwrap_or(""),
            created_at=out.created_at,
            version=None,
            hostname=None,
            platform=None,
            runtime=None,
          ),
        ) catch { _ => false }
      _ => (tx.control)(offer_message(out)) catch { _ => false }
    }
    if !sent {
      // 控制帧没出去:退回队列,正文还回去。
      out.state = "queued"
      if out.kind == "text" {
        out.text = text
      }
    }
  }
  self.save_queue()
}

///|
/// 新入队前的头寸检查:条数与总字节数都要留余量,别把暂存区当仓库用。
/// 返回 None = 有余位;Some(文案) = 满,HTTP 层直接下发。
fn DirectService::check_queue_room(self : DirectService, extra_bytes : Int64) -> String? {
  let mut count = 0
  let mut bytes : Int64 = 0L
  for _, o in self.outgoing {
    if o.state == "queued" {
      count += 1
      if o.kind == "file" {
        bytes += o.size
      }
    }
  }
  if count >= DIRECT_MAX_QUEUED {
    return Some("离线排队已满(\{DIRECT_MAX_QUEUED} 条),请等设备上线或先取消一些")
  }
  if bytes + extra_bytes > DIRECT_QUEUE_MAX_BYTES {
    return Some("离线排队的文件总量已满(512 MB),请等设备上线或先取消一些")
  }
  None
}

///|
/// 推进发送窗口:从磁盘读片、登记在途、按窗口上限发出。
async fn DirectService::pump(
  self : DirectService,
  out : Outgoing,
  tx : DirectTransport,
) -> Unit {
  if out.state != "transferring" || out.fd is None || out.total_chunks is None {
    return
  }
  let total = out.total_chunks.unwrap_or(0L)
  let fd = match out.fd {
    Some(fd) => fd
    None => return
  }
  while out.next_seq < total && out.next_seq - out.acked < DIRECT_WINDOW {
    let seq = out.next_seq
    out.next_seq += 1
    // 最后一片可能短于整片:按 size 算出确切长度,读不到即文件被动过
    let remaining = out.size - seq * DIRECT_CHUNK_BYTES
    let len = if remaining < DIRECT_CHUNK_BYTES { remaining } else { DIRECT_CHUNK_BYTES }
    if len <= 0L {
      self.cancel_outgoing(out, "待发文件在传输中被改动,已中止", Some(tx))
      return
    }
    let data = fd.read_exactly_at(len.to_int(), position=seq * DIRECT_CHUNK_BYTES) catch {
      e => {
        self.cancel_outgoing(out, "读取待发文件失败:\{e}", Some(tx))
        return
      }
    }
    if data.length().to_int64() != len {
      self.cancel_outgoing(out, "待发文件在传输中被改动,已中止", Some(tx))
      return
    }
    out.inflight.set(
      seq,
      { body: data, sent_at: now_ms(), attempts: 1 },
    )
    let sent = (tx.chunk)(out.id, seq, data) catch { _ => false }
    if !sent {
      // 会话刚好断了:有续传能力就留半截等重连,否则按旧的快速失败。
      if self.can_resume {
        self.pause_outgoing(out)
      } else {
        self.cancel_outgoing(out, "会话已断开", Some(tx))
      }
      return
    }
  }
}

///|
/// 顺序落盘 + 推进窗口 + 验收。只在「下一片已在缓存」时推进;每写一片就
/// 推进哈希,与发送方对整份文件的指纹可比。
async fn DirectService::write_sequential(
  self : DirectService,
  inc : Incoming,
  tx : DirectTransport,
) -> Unit {
  let fd = match inc.fd {
    Some(fd) => fd
    None => return
  }
  let hash = match inc.hash {
    Some(hash) => hash
    None => return
  }
  while inc.buffered.contains(inc.next_seq) {
    let body = match inc.buffered.get(inc.next_seq) {
      Some(body) => body
      None => break
    }
    inc.buffered.remove(inc.next_seq)
    let written = fd.write_at(body.exact_view(), position=inc.bytes_done) catch {
      e => {
        let _ = (tx.control)(
          @net.ControlMessage::DirectCancel(
            id=inc.id,
            from_device_id="",
            reason="本机写入失败:\{e}",
            version=None,
            hostname=None,
            platform=None,
            runtime=None,
          ),
        ) catch { _ => false }
        self.cleanup_incoming(inc)
        return
      }
    }
    ignore(written)
    hash.update(body, 0, body.length())
    inc.bytes_done += body.length().to_int64()
    inc.next_seq += 1
    inc.last_progress_at = now_ms()
  }
  // 未收齐才回累积 ack。最后一片必须只回 direct-result:
  // ack 会让发送方在同一个调用栈里继续 pump,而本函数尚未 digest —— 重入会二次消费哈希。
  if inc.bytes_done != inc.size {
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
  // 收齐:先关句柄再校验。
  fd.close()
  inc.fd = None
  let digest = hash.hex()
  if digest != inc.sha256 {
    let _ = (tx.control)(
      @net.ControlMessage::DirectResult(
        id=inc.id,
        from_device_id="",
        ok=false,
        error=Some("文件校验失败(sha256 不一致)"),
        version=None,
        hostname=None,
        platform=None,
        runtime=None,
      ),
    ) catch { _ => false }
    self.cleanup_incoming(inc)
    return
  }
  let final_path = unique_file_path(inc.name, inc.save_dir.unwrap_or(self.files_dir))
  @fs.rename(inc.tmp_path, final_path) catch {
    e => {
      let _ = (tx.control)(
        @net.ControlMessage::DirectResult(
          id=inc.id,
          from_device_id="",
          ok=false,
          error=Some("落盘失败:\{e}"),
          version=None,
          hostname=None,
          platform=None,
          runtime=None,
        ),
      ) catch { _ => false }
      self.cleanup_incoming(inc)
      return
    }
  }
  self.items.insert(
    0,
    FileItem({
      id: inc.id,
      from: inc.from,
      created_at: inc.created_at,
      name: inc.name,
      size: inc.size,
      sha256: inc.sha256,
      path: final_path,
      // 另存到用户目录时收件箱只留回执;删回执绝不删用户盘上的真实文件。
      // MoonBit 恒落收件箱,external 恒 false。
      external: false,
    }),
  )
  self.save_index()
  self.incoming.remove(inc.id)
  let _ = (tx.control)(
    @net.ControlMessage::DirectResult(
      id=inc.id,
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

///|
/// 收一条文本进收件箱(Node addTextItem 同口径:文件名 + 预览 + 正文落盘)。
/// 落盘失败返回 None,调用方不回执 —— 发送方会按超时判失败。
async fn DirectService::add_text_item(self : DirectService, from : String, text : String) -> String? {
  let id = match direct_id("dt") {
    Some(id) => id
    None => return None
  }
  let data = @utf8.encode(text)
  let path = join_path(self.messages_dir, "\{id}.txt")
  @fs.write_file(path, text) catch { _ => return None }
  // 预览取前 120 个字符(Node [...text].slice(0, 120) 同口径)
  let sb = StringBuilder()
  let mut n = 0
  for ch in text {
    if n >= 120 {
      break
    }
    sb.write_char(ch)
    n += 1
  }
  let item : DirectItem = TextItem({
    id,
    from,
    created_at: now_ms(),
    size: data.length().to_int64(),
    preview: sb.to_string(),
    path,
  })
  self.items.insert(0, item)
  self.save_index()
  Some(id)
}
