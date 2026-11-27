///|
/// 盘上台账三件套:`index.json`(收件箱条目)/ `queue.json`(离线排队)/
/// `resume.json`(跨重启续传)。键名与 Node `src/direct.ts` 的落盘格式逐字
/// 对齐 —— 三端可能先后接管同一份数据目录,谁都不能写出自家才认的形态。
/// 全部容忍坏文件:坏账当作没有,绝不让启动失败卡死主流程。

///|
fn get_str(obj : Map[String, Json], key : String) -> String? {
  match obj.get(key) {
    Some(String(value)) => Some(value)
    _ => None
  }
}

///|
fn get_u64(obj : Map[String, Json], key : String) -> Int64? {
  match obj.get(key) {
    Some(Number(n, ..)) => if n < 0.0 { None } else { Some(n.to_int64()) }
    _ => None
  }
}

///|
fn get_bool(obj : Map[String, Json], key : String) -> Bool? {
  match obj.get(key) {
    Some(True) => Some(true)
    Some(False) => Some(false)
    _ => None
  }
}

///|
/// 原子写盘:先写 `<path>.tmp` 再改名,崩溃不会留下半截台账。
async fn save_json_atomic(path : String, content : String) -> Unit {
  let tmp = "\{path}.tmp"
  @fs.write_file(tmp, content) catch { _ => return }
  @fs.rename(tmp, path) catch { _ => return }
}

///|
async fn remove_quiet(path : String) -> Unit {
  @fs.remove(path) catch { _ => return }
}

///|
/// 收件箱条目 → JSON(与 Node 的对象字面量键序一致)。
fn item_to_json(item : DirectItem) -> Json {
  let map : Map[String, Json] = Map([])
  match item {
    TextItem(t) => {
      map.set("kind", Json::string("text"))
      map.set("id", Json::string(t.id))
      map.set("from", Json::string(t.from))
      map.set("createdAt", Json::number(t.created_at.to_double()))
      map.set("size", Json::number(t.size.to_double()))
      map.set("preview", Json::string(t.preview))
      map.set("path", Json::string(t.path))
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
      // external 只在 true 时出现(Node 的条件展开同口径);MoonBit 恒 false,
      // 不写这个键。
    }
  }
  Json::object(map)
}

///|
/// 从 JSON 解一条收件箱条目(形状不对整条丢弃,与 Node readIndex 同口径)。
fn item_from_json(value : Json) -> DirectItem? {
  let obj = match value {
    Object(fields) => fields
    _ => return None
  }
  let kind = match get_str(obj, "kind") {
    Some(kind) => kind
    None => return None
  }
  let id = match get_str(obj, "id") {
    Some(id) => id
    None => return None
  }
  if !is_safe_id(id) {
    return None
  }
  let from = match get_str(obj, "from") {
    Some(from) => from
    None => return None
  }
  let created_at = match get_u64(obj, "createdAt") {
    Some(at) => at
    None => return None
  }
  let path = match get_str(obj, "path") {
    Some(path) => path
    None => return None
  }
  match kind {
    "text" => {
      let size = match get_u64(obj, "size") {
        Some(size) => size
        None => return None
      }
      let preview = match get_str(obj, "preview") {
        Some(preview) => preview
        None => ""
      }
      Some(
        TextItem({
          id,
          from,
          created_at,
          size,
          preview,
          path,
        }),
      )
    }
    "file" => {
      let name = match get_str(obj, "name") {
        Some(name) => name
        None => return None
      }
      let size = match get_u64(obj, "size") {
        Some(size) => size
        None => return None
      }
      let sha256 = match get_str(obj, "sha256") {
        Some(sha256) => sha256
        None => return None
      }
      Some(
        FileItem({
          id,
          from,
          created_at,
          name,
          size,
          sha256,
          path,
          external: get_bool(obj, "external") == Some(true),
        }),
      )
    }
    _ => None
  }
}

///|
/// 读收件箱索引(坏文件 = 空收件箱)。独立函数:构造服务前就要用它。
async fn read_index(index_path : String) -> Array[DirectItem] {
  let raw = @fs.read_file(index_path) catch { _ => return [] }
  let body = @json.parse(raw.text()) catch { _ => return [] }
  let out : Array[DirectItem] = []
  match body {
    Array(entries) =>
      for entry in entries {
        match item_from_json(entry) {
          Some(item) => out.push(item)
          None => ()
        }
      }
    _ => ()
  }
  out
}

///|
/// 写收件箱索引(写失败只丢一次持久化,内存状态不受影响)。
async fn DirectService::save_index(self : DirectService) -> Unit {
  let arr : Array[Json] = []
  for item in self.items {
    arr.push(item_to_json(item))
  }
  save_json_atomic(self.index_path, Json::array(arr).stringify())
}

///|
/// 排队台账的一条记录(只保留重启后还能原样重投的字段)。
fn queued_record_to_json(o : Outgoing) -> Json {
  let map : Map[String, Json] = Map([])
  map.set("id", Json::string(o.id))
  map.set("deviceId", Json::string(o.device_id))
  map.set("kind", Json::string(o.kind))
  match o.name {
    Some(name) => map.set("name", Json::string(name))
    None => ()
  }
  map.set("size", Json::number(o.size.to_double()))
  map.set("createdAt", Json::number(o.created_at.to_double()))
  map.set(
    "queuedAt",
    Json::number((o.queued_at.unwrap_or(o.created_at)).to_double()),
  )
  match o.kind {
    "text" => map.set("text", Json::string(o.text.unwrap_or("")))
    _ => ()
  }
  match o.source_path {
    Some(path) => map.set("sourcePath", Json::string(path))
    None => ()
  }
  match o.sha256 {
    Some(sha256) => map.set("sha256", Json::string(sha256))
    None => ()
  }
  match o.batch_id {
    Some(batch_id) => map.set("batchId", Json::string(batch_id))
    None => ()
  }
  Json::object(map)
}

///|
/// 写排队台账:只把仍在排队的投送写盘;队列清空直接删文件,免得留下一个
/// 空数组让人误会还有东西在等。
async fn DirectService::save_queue(self : DirectService) -> Unit {
  let mut count = 0
  for _, o in self.outgoing {
    if o.state == "queued" && o.finished_at is None {
      count += 1
    }
  }
  if count == 0 {
    remove_quiet(self.queue_path)
    return
  }
  let arr : Array[Json] = []
  for _, o in self.outgoing {
    if o.state == "queued" && o.finished_at is None {
      arr.push(queued_record_to_json(o))
    }
  }
  save_json_atomic(self.queue_path, Json::array(arr).stringify())
}

///|
/// 启动时恢复离线队列。暂存文件不见了的条目直接丢(比如被手工清了 .tmp),
/// 不能留一条永远发不出去的记录。
async fn DirectService::load_queue(self : DirectService) -> Unit {
  let raw = @fs.read_file(self.queue_path) catch { _ => return }
  let body = @json.parse(raw.text()) catch { _ => return }
  let entries = match body {
    Array(entries) => entries
    _ => return
  }
  for entry in entries {
    let obj = match entry {
      Object(fields) => fields
      _ => continue
    }
    let id = match get_str(obj, "id") {
      Some(id) => id
      None => continue
    }
    if !is_safe_id(id) {
      continue
    }
    let device_id = match get_str(obj, "deviceId") {
      Some(device_id) => device_id
      None => continue
    }
    let size = match get_u64(obj, "size") {
      Some(size) => size
      None => continue
    }
    let created_at = match get_u64(obj, "createdAt") {
      Some(at) => at
      None => continue
    }
    let queued_at = match get_u64(obj, "queuedAt") {
      Some(at) => at
      None => continue
    }
    let kind = match get_str(obj, "kind") {
      Some(kind) => kind
      None => continue
    }
    let mut text : String? = None
    let mut source_path : String? = None
    let mut sha256 : String? = None
    match kind {
      "text" => {
        let t = match get_str(obj, "text") {
          Some(t) => t
          None => continue
        }
        if t == "" {
          continue
        }
        text = Some(t)
      }
      "file" => {
        let path = match get_str(obj, "sourcePath") {
          Some(path) => path
          None => continue
        }
        let hash = match get_str(obj, "sha256") {
          Some(hash) => hash
          None => continue
        }
        if !(@fs.exists(path) catch { _ => false }) {
          continue
        }
        source_path = Some(path)
        sha256 = Some(hash)
      }
      _ => continue
    }
    let out : Outgoing = {
      id,
      device_id,
      kind,
      name: get_str(obj, "name"),
      size,
      bytes_done: 0L,
      state: "queued",
      error: None,
      created_at,
      finished_at: None,
      offer_sent_at: queued_at,
      resuming: false,
      paused_at: None,
      queued_at: Some(queued_at),
      text,
      batch_id: get_str(obj, "batchId"),
      source_path,
      fd: None,
      sha256,
      total_chunks: match kind {
        "file" => Some((size + DIRECT_CHUNK_BYTES - 1L) / DIRECT_CHUNK_BYTES)
        _ => None
      },
      acked: 0L,
      next_seq: 0L,
      inflight: Map([]),
      last_progress_at: now_ms(),
    }
    match out.source_path {
      Some(path) => {
        let left = self.source_refs.get(path).unwrap_or(0) + 1
        self.source_refs.set(path, left)
      }
      None => ()
    }
    self.outgoing.set(out.id, out)
  }
}

///|
/// 跨重启续传台账的一条出站记录。
fn resume_out_to_json(o : Outgoing, paused_at : Int64) -> Json {
  let map : Map[String, Json] = Map([])
  map.set("id", Json::string(o.id))
  map.set("deviceId", Json::string(o.device_id))
  map.set("name", Json::string(o.name.unwrap_or("")))
  map.set("size", Json::number(o.size.to_double()))
  map.set("sha256", Json::string(o.sha256.unwrap_or("")))
  map.set("sourcePath", Json::string(o.source_path.unwrap_or("")))
  map.set("createdAt", Json::number(o.created_at.to_double()))
  map.set("bytesDone", Json::number(o.bytes_done.to_double()))
  map.set("pausedAt", Json::number(paused_at.to_double()))
  match o.batch_id {
    Some(batch_id) => map.set("batchId", Json::string(batch_id))
    None => ()
  }
  Json::object(map)
}

///|
/// 跨重启续传台账的一条入站记录(半截文件按 id 命名,路径不必存)。
fn resume_in_to_json(inc : Incoming, paused_at : Int64) -> Json {
  let map : Map[String, Json] = Map([])
  map.set("id", Json::string(inc.id))
  map.set("from", Json::string(inc.from))
  map.set("name", Json::string(inc.name))
  map.set("size", Json::number(inc.size.to_double()))
  map.set("sha256", Json::string(inc.sha256))
  map.set("createdAt", Json::number(inc.created_at.to_double()))
  map.set("bytesDone", Json::number(inc.bytes_done.to_double()))
  map.set("pausedAt", Json::number(paused_at.to_double()))
  match inc.save_dir {
    Some(dir) => map.set("saveDir", Json::string(dir))
    None => ()
  }
  match inc.batch_id {
    Some(batch_id) => map.set("batchId", Json::string(batch_id))
    None => ()
  }
  Json::object(map)
}

///|
/// 写续传台账:内容全部由内存状态推导 —— 每个改变状态的入口写完就调它,
/// 不必在别处维护镜像。没内容就删文件,免得留下一份空账让人误会。
/// 传输中也要记:进程被 kill -9 时没有 close() 可走,只能靠这一笔。
async fn DirectService::save_resume(self : DirectService) -> Unit {
  if !self.can_resume {
    return
  }
  let outs : Array[Json] = []
  for _, o in self.outgoing {
    let has_file_meta = o.kind == "file" &&
      o.source_path is Some(_) &&
      o.sha256 is Some(_) &&
      o.name is Some(_)
    if !has_file_meta {
      continue
    }
    let transferring = o.state == "transferring" ||
      o.state == "paused" ||
      o.resuming
    if !transferring {
      continue
    }
    // 排队项走 queue.json:它等的是设备上线,和「传了一半」是两回事。
    if o.queued_at is Some(_) {
      continue
    }
    let paused_at = o.paused_at.unwrap_or(now_ms())
    outs.push(resume_out_to_json(o, paused_at))
  }
  let ins : Array[Json] = []
  for _, inc in self.incoming {
    // 待确认的提议不记:它还需要用户点头,重启后重新提议更干净。
    if inc.state == "pending" {
      continue
    }
    let paused_at = inc.paused_at.unwrap_or(now_ms())
    ins.push(resume_in_to_json(inc, paused_at))
  }
  if outs.length() == 0 && ins.length() == 0 {
    remove_quiet(self.resume_path)
    return
  }
  let map : Map[String, Json] = Map([])
  map.set("v", Json::number(1.0))
  map.set("outgoing", Json::array(outs))
  map.set("incoming", Json::array(ins))
  save_json_atomic(self.resume_path, Json::object(map).stringify())
}

///|
/// 启动时恢复跨重启续传。三种情况直接丢弃(连同它的半截文件):
///  - 过了续传窗口(10 分钟)—— 半截已经没有意义,还占着收件箱配额;
///  - 出站的暂存文件 / 入站的半截文件不见了(被手工清过 `.tmp`);
///  - 入站半截不是整片对齐(落盘永远顺序整片写,对不齐说明文件被别的东西动过)。
async fn DirectService::load_resume(self : DirectService) -> Unit {
  if !self.can_resume {
    return
  }
  let raw = @fs.read_file(self.resume_path) catch { _ => return }
  let body = @json.parse(raw.text()) catch { _ => return }
  let obj = match body {
    Object(fields) => fields
    _ => return
  }
  let now = now_ms()
  let dead_sources : Array[String] = []
  match obj.get("outgoing") {
    Some(Array(entries)) =>
      for entry in entries {
        let fields = match entry {
          Object(fields) => fields
          _ => continue
        }
        let id = match get_str(fields, "id") {
          Some(id) => id
          None => continue
        }
        if !is_safe_id(id) {
          continue
        }
        let device_id = match get_str(fields, "deviceId") {
          Some(device_id) => device_id
          None => continue
        }
        let name = match get_str(fields, "name") {
          Some(name) => name
          None => continue
        }
        let size = match get_u64(fields, "size") {
          Some(size) if size > 0L => size
          _ => continue
        }
        let sha256 = match get_str(fields, "sha256") {
          Some(sha256) if is_sha256_hex(sha256) => sha256
          _ => continue
        }
        let source_path = match get_str(fields, "sourcePath") {
          Some(path) => path
          None => continue
        }
        let created_at = match get_u64(fields, "createdAt") {
          Some(at) => at
          None => continue
        }
        let bytes_done = match get_u64(fields, "bytesDone") {
          Some(bytes) if bytes >= 0L => bytes
          _ => continue
        }
        let paused_at = match get_u64(fields, "pausedAt") {
          Some(at) => at
          None => continue
        }
        let fresh = now - paused_at <= DIRECT_RESUME_TTL_MS
        let usable = fresh &&
          bytes_done < size &&
          (@fs.exists(source_path) catch { _ => false })
        if !usable {
          dead_sources.push(source_path)
          continue
        }
        let acked = bytes_done / DIRECT_CHUNK_BYTES
        let out : Outgoing = {
          id,
          device_id,
          kind: "file",
          name: Some(name),
          size,
          bytes_done,
          state: "paused",
          error: None,
          created_at,
          // 一启动就允许重发提议:重启本身就是「刚断过线」,没必要再等 3 秒。
          finished_at: None,
          offer_sent_at: paused_at,
          resuming: true,
          paused_at: Some(paused_at),
          queued_at: None,
          text: None,
          batch_id: get_str(fields, "batchId"),
          source_path: Some(source_path),
          fd: None,
          sha256: Some(sha256),
          total_chunks: Some((size + DIRECT_CHUNK_BYTES - 1L) / DIRECT_CHUNK_BYTES),
          acked,
          next_seq: acked,
          inflight: Map([]),
          last_progress_at: now,
        }
        self.outgoing.set(out.id, out)
        let left = self.source_refs.get(source_path).unwrap_or(0) + 1
        self.source_refs.set(source_path, left)
      }
    _ => ()
  }
  // 统一清理过期条目的暂存文件(群发会共用同一份路径)
  for path in dead_sources {
    if self.source_refs.contains(path) {
      continue // 还有存活条目在用它(群发暂存共用)
    }
    remove_quiet(path)
  }
  match obj.get("incoming") {
    Some(Array(entries)) =>
      for entry in entries {
        let fields = match entry {
          Object(fields) => fields
          _ => continue
        }
        let id = match get_str(fields, "id") {
          Some(id) => id
          None => continue
        }
        if !is_safe_id(id) {
          continue
        }
        let from = match get_str(fields, "from") {
          Some(from) => from
          None => continue
        }
        let name = match get_str(fields, "name") {
          Some(name) => name
          None => continue
        }
        let size = match get_u64(fields, "size") {
          Some(size) if size > 0L => size
          _ => continue
        }
        let sha256 = match get_str(fields, "sha256") {
          Some(sha256) if is_sha256_hex(sha256) => sha256
          _ => continue
        }
        let created_at = match get_u64(fields, "createdAt") {
          Some(at) => at
          None => continue
        }
        let paused_at = match get_u64(fields, "pausedAt") {
          Some(at) => at
          None => continue
        }
        let tmp_path = join_path(self.tmp_dir_path, "in-\{id}")
        let on_disk = @fs.file_size(tmp_path) catch { _ => -1L }
        if on_disk <= 0L {
          continue
        }
        let mtime = (@fs.mtime(tmp_path) catch { _ => (0L, 0) }).0
        // 半截文件最后一次被写的时间才是「它还活着」的真实证据:台账里的
        // pausedAt 对「传到一半被硬杀」的那笔只到开始时刻,长传输会因此被误判过期。
        let anchor = if paused_at > mtime { paused_at } else { mtime }
        let fresh = now - anchor <= DIRECT_RESUME_TTL_MS
        // 必须是「整片且没满」:满了却没落盘说明崩在校验/rename 之间,重来更省事。
        let resumable = fresh &&
          on_disk > 0L &&
          on_disk % DIRECT_CHUNK_BYTES == 0L &&
          on_disk < size
        if !resumable {
          remove_quiet(tmp_path)
          continue
        }
        let inc : Incoming = {
          id,
          from,
          name,
          size,
          sha256,
          created_at,
          tmp_path,
          save_dir: get_str(fields, "saveDir"),
          batch_id: get_str(fields, "batchId"),
          state: "paused",
          paused_at: Some(paused_at),
          fd: None,
          hash: None,
          next_seq: on_disk / DIRECT_CHUNK_BYTES,
          total_chunks: (size + DIRECT_CHUNK_BYTES - 1L) / DIRECT_CHUNK_BYTES,
          bytes_done: on_disk,
          received: Map([]),
          buffered: Map([]),
          last_progress_at: now,
        }
        self.incoming.set(inc.id, inc)
      }
    _ => ()
  }
  // 丢弃过的条目不要留在文件里,否则下次启动又把它们捞出来判一遍。
  self.save_resume()
}
