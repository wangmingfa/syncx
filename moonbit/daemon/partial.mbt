///|
/// 断点续传的落盘中间态。对应 Rust `syncx-daemon/src/partial.rs` 与 Node
/// `src/partial-store.ts`,以及 Rust `executor.rs` 的 `DiskReceiveHandle`。
///
/// 在途内容写进 `<target>.syncx-tmp`,位图与条目指纹写进 `<target>.syncx-partial`
/// (JSON sidecar),成对出现、成对消失。块到达即按**最终偏移**随机写进 tmp,
/// 内存开销是块级而不是文件级;重启后续传从 sidecar 的位图继续,已收的块不再请求。
///
/// **为什么是 sidecar 而不是把位图塞进 tmp 头部**:tmp 的内容必须**就是**最终文件
/// 字节(executor 的 rename 即落地,不做二次搬运),任何头部都会污染它。
///
/// **为什么指纹只看内容不看版本**:续传关心的是「已写进 tmp 的那些块,对当前条目还
/// 成不成立」。块哈希列表 + CDC 视图 + 尺寸三者相同,字节布局就相同,版本向量变不变
/// 都无所谓(对端 revert 回旧内容这种「版本变了内容没变」的情况,续传反而是对的)。
/// 反过来内容一变(哪怕一个块),指纹就变,旧 tmp 整份作废 —— 宁可重传,不可错接。
///
/// 与 Rust 版的刻意偏差:收齐后的落地仍走 MoonBit executor 现有的
/// 「读回整份内容 → land_to_tmp(重写 tmp + fsync + 验块)→ rename」管线
/// (executor 不动),落地瞬间多一遍整读整写;断点续传的收益(断线重连不重传已收块、
/// 崩溃后从位图继续)完整保留。TTL 回收由 scanner 的 `prune_scratch_file` 按
/// 7 天(与 `PARTIAL_TTL_MS` 同值)负责,这里不做时间检查。

///|
/// 续传中间态文件后缀(与 `.syncx-tmp` 成对;扫描器/文件管理器都必须跳过这两个后缀)。
pub const PARTIAL_SUFFIX : String = ".syncx-partial"

///|
/// 在途内容的 tmp 后缀(与 executor `land_to_tmp` 硬编码同值)。
pub const PARTIAL_TMP_SUFFIX : String = ".syncx-tmp"

///|
/// 落多少个块才补写一次位图:写盘是逐块的,位图是批量交代的 —— 中间崩溃最多丢
/// 这么多块的进度,换来的是 sidecar 写放大受控。
const PARTIAL_COMMIT_SLOTS : Int32 = 8

///|
/// 中间态相关错误(收拢为 String 消息,便于上层统一打日志)。
/// 变体名刻意避开 ExecutorError / IndexStoreError 的既有名字
/// (同包内构造器重名会让 `raise Io(...)` 这类裸构造产生歧义)。
pub(all) suberror PartialError {
  /// 文件系统操作失败。
  IoFailed(String)
  /// 中间态数据损坏(manifest 非法、块布局不自洽等)。
  CorruptState(String)
  /// 路径越界或不安全(符号链接逃逸 / 硬忽略)。
  UnsafeTarget(String)
  /// 块内容与声明的哈希不符。
  BlockMismatch(String)
} derive(Debug)

///|
/// derive 出的 Debug 方法只作为 trait 实现使用,不隐式提升为普通方法。
pub extend PartialError with @moonbitlang/core/debug.Debug::{to_repr}

///|
/// 一个目标文件的两个中间态路径:在途内容(tmp)与在途位图(manifest)。
pub(all) struct PartialPaths {
  /// 在途内容:就是最终文件字节,rename 即落地。
  tmp : String
  /// 在途位图 sidecar:记录指纹与已收块位图。
  manifest : String
}

///|
/// 定位 `<target>` 的两个中间态文件。
pub fn partial_paths(target : String) -> PartialPaths {
  {
    tmp: "\{target}\{PARTIAL_TMP_SUFFIX}",
    manifest: "\{target}\{PARTIAL_SUFFIX}",
  }
}

///|
/// 条目内容指纹:尺寸 + 定长块哈希 + CDC 视图。
///
/// 刻意**不含** version / mtime / path:path 由文件名承载,version 与内容布局无关。
/// 分隔符用 `\u0000` —— 换成逗号会让 `blocks=["a,b"]` 与 `blocks=["a","b"]`
/// 撞同一个指纹。与 Rust `entry_fingerprint` / Node `entryFingerprint` 逐字节一致
/// (sha256(size \0 blocks \0 cdh \0 clens),十六进制小写)。
pub fn entry_fingerprint(entry : Entry) -> String {
  let buf = @buffer.Buffer()
  buf.write_string_utf8(entry.size.to_string())
  buf.write_bytes(b"\x00")
  buf.write_string_utf8(entry.blocks.join(","))
  buf.write_bytes(b"\x00")
  let cdh = match entry.cdh {
    Some(hashes) => hashes.join(",")
    None => ""
  }
  buf.write_string_utf8(cdh)
  buf.write_bytes(b"\x00")
  let clens = match entry.clens {
    Some(lengths) => {
      let parts : Array[String] = []
      for len in lengths {
        parts.push(len.to_string())
      }
      parts.join(",")
    }
    None => ""
  }
  buf.write_string_utf8(clens)
  @core.hash_block(buf.to_bytes())
}

// ==================== 槽位位图 ====================

///|
/// 槽位位图:固定槽位数的 bitset,序列化成 base64(每 bit 一个槽位,1 = 该块已
/// 正确写入 tmp)。位图一旦说「这块在盘上」就必须是真的对 —— 写入前验哈希、
/// 续传时回读自检,两道闸门都在 PartialStore 里。
pub struct SlotBitmap {
  ///
  priv slots : Int32
  ///
  priv bytes : FixedArray[Byte]
}

///|
/// 全零位图。
pub fn SlotBitmap::new(slots : Int32) -> SlotBitmap {
  { slots, bytes: FixedArray::make((slots + 7) / 8, b'\x00'), }
}

///|
/// 从 base64 恢复。长度不符直接报错 —— 调用方据此把坏 manifest 当成「没有中间态」。
pub fn SlotBitmap::from_base64(
  slots : Int32,
  raw : String,
) -> SlotBitmap raise PartialError {
  let decoded = @base64.decode(raw) catch {
    _ => raise CorruptState("位图 base64 非法")
  }
  let expected = (slots + 7) / 8
  if decoded.length() != expected {
    raise CorruptState(
      "位图长度不符:期望 \{expected} 字节,实际 \{decoded.length()}",
    )
  }
  let bytes : FixedArray[Byte] = FixedArray::make(expected, b'\x00')
  for i in 0..<expected {
    bytes[i] = decoded[i]
  }
  { slots, bytes, }
}

///|
/// 该槽位是否已写入。
pub fn SlotBitmap::has(self : SlotBitmap, index : Int32) -> Bool {
  if index < 0 || index >= self.slots {
    return false
  }
  self.bytes[index / 8].land(b'\x01'.shl(index % 8)) != b'\x00'
}

///|
/// 置位(该块已正确写入 tmp)。
pub fn SlotBitmap::set(self : SlotBitmap, index : Int32) -> Unit {
  if index < 0 || index >= self.slots {
    return
  }
  let i = index / 8
  self.bytes[i] = self.bytes[i].lor(b'\x01'.shl(index % 8))
}

///|
/// 清位:续传自检发现某块「位图说写了、盘上内容不对」时,把它退回缺失态重传。
pub fn SlotBitmap::clear(self : SlotBitmap, index : Int32) -> Unit {
  if index < 0 || index >= self.slots {
    return
  }
  let i = index / 8
  self.bytes[i] = self.bytes[i].land(b'\x01'.shl(index % 8).lnot())
}

///|
/// 已置位的槽位数。
pub fn SlotBitmap::count(self : SlotBitmap) -> Int32 {
  let mut total = 0
  for byte in self.bytes {
    let mut b = byte
    for _ in 0..<8 {
      if b.land(b'\x01') != b'\x00' {
        total += 1
      }
      b = b.shr(1)
    }
  }
  total
}

///|
/// 是否全满(收齐)。
pub fn SlotBitmap::full(self : SlotBitmap) -> Bool {
  self.count() == self.slots
}

///|
/// 序列化成 base64。
pub fn SlotBitmap::to_base64(self : SlotBitmap) -> String {
  @base64.encode(
    Bytes::from_array(self.bytes.exact_view(end=self.bytes.length())),
  )
}

// ==================== manifest ====================

///|
/// 落盘的中间态清单(与 Rust serde 序列化同字段名:snake_case)。
pub(all) struct PartialManifest {
  /// 结构版本:将来字段变更时拒绝旧文件(直接作废重传,不做迁移)。
  v : Int32
  ///
  fingerprint : String
  ///
  cdc : Bool
  ///
  slots : Int32
  /// 位图的 base64(每 bit 一个槽位,1 = 该块已正确写入 tmp)。
  bitmap : String
  ///
  started_at : Int64
  ///
  updated_at : Int64
}

///|
/// manifest 序列化为 JSON(字段名与 Rust serde 默认输出一致)。
fn PartialManifest::to_json(self : PartialManifest) -> Json {
  let map : Map[String, Json] = Map([])
  map.set("v", Json::number(self.v.to_double()))
  map.set("fingerprint", Json::string(self.fingerprint))
  map.set("cdc", Json::boolean(self.cdc))
  map.set("slots", Json::number(self.slots.to_double()))
  map.set("bitmap", Json::string(self.bitmap))
  map.set("started_at", Json::number(self.started_at.to_double()))
  map.set("updated_at", Json::number(self.updated_at.to_double()))
  Json::object(map)
}

///|
/// 读 manifest;不存在 / 损坏 / 结构与期望不符一律返回 `None`
/// (调用方按「无中间态」处理)。**不查 TTL**:超期残骸由扫描器的
/// `prune_scratch_file` 按 tmp 的 mtime 整对回收。
pub async fn read_manifest(
  path : String,
  fingerprint~ : String,
  cdc~ : Bool,
  slots~ : Int32,
) -> PartialManifest? {
  let text = @utf8.decode_lossy(@fs.read_file(path).binary()) catch {
    _ => return None
  }
  let obj = try {
    match @json.parse(text) {
      Object(o) => o
      _ => return None
    }
  } catch {
    _ => return None
  }
  let v = match obj.get("v") {
    Some(Number(n, ..)) => n.to_int()
    _ => return None
  }
  if v != 1 {
    return None
  }
  let fp = match obj.get("fingerprint") {
    Some(String(s)) => s
    _ => return None
  }
  if fp != fingerprint {
    return None
  }
  let m_cdc = match obj.get("cdc") {
    Some(True) => true
    Some(False) => false
    _ => return None
  }
  if m_cdc != cdc {
    return None
  }
  let m_slots = match obj.get("slots") {
    Some(Number(n, ..)) => n.to_int()
    _ => return None
  }
  if m_slots != slots {
    return None
  }
  let bitmap = match obj.get("bitmap") {
    Some(String(s)) => s
    _ => return None
  }
  let started_at = match obj.get("started_at") {
    Some(Number(n, ..)) => n.to_int64()
    _ => return None
  }
  let updated_at = match obj.get("updated_at") {
    Some(Number(n, ..)) => n.to_int64()
    _ => return None
  }
  // 构造一次位图以校验 base64 与长度;坏的就当没有
  try {
    let _ = SlotBitmap::from_base64(slots, bitmap)
  } catch {
    _ => return None
  }
  Some({
    v,
    fingerprint: fp,
    cdc: m_cdc,
    slots: m_slots,
    bitmap,
    started_at,
    updated_at,
  })
}

///|
/// 写 manifest(整文件覆盖)。
pub async fn write_manifest(
  path : String,
  manifest : PartialManifest,
) -> Unit raise PartialError {
  let text = manifest.to_json().stringify()
  @fs.write_file(path, @utf8.encode(text), create_mode=CreateOrTruncate) catch {
    e => raise IoFailed("写 manifest 失败(\{path}): \{e}")
  }
}

///|
/// 成对删除 tmp 与 manifest(作废 / 落地完成后调用)。
///
/// 删不掉也无妨:下次重开 store 会再试,扫描器也会跳过这两个后缀 ——
/// 所以这里吞掉错误,不让清理失败影响调用方的终态处理。
pub async fn remove_partial(target : String) -> Unit {
  let paths = partial_paths(target)
  @fs.remove(paths.tmp) catch {
    _ => ()
  }
  @fs.remove(paths.manifest) catch {
    _ => ()
  }
}

// ==================== PartialStore:磁盘接收句柄 ====================

///|
/// 一个在途接收的落盘句柄(对应 Rust `DiskReceiveHandle`)。
///
/// 块到达即按最终偏移随机写进 `<target>.syncx-tmp`,位图与指纹落在
/// `<target>.syncx-partial`。中间态按需创建:一个块都没到就不碰盘。
/// 收齐后由调用方读回内容交给 executor 现有的落地管线。
pub struct PartialStore {
  /// 目标文件绝对路径(tmp = target + ".syncx-tmp")。
  priv target : String
  priv manifest_path : String
  priv fingerprint : String
  priv cdc : Bool
  /// 本次口径的块哈希(CDC 或定长)。
  priv hashes : Array[String]
  /// 各块的最终偏移与长度。
  priv offsets : Array[Int64]
  priv lengths : Array[Int64]
  priv bitmap : SlotBitmap
  /// 已收字节数(进度统计)。
  priv mut received_bytes : Int64
  priv started_at : Int64
  /// 打开的 tmp 写句柄(按需创建;收尾必须关闭,否则 Windows 上 rename 不动)。
  priv mut file : @fs.File?
  /// 自上次写位图以来新落的块数。
  priv mut dirty : Int32
}

///|
/// 块哈希清单:定长块直接用 `blocks`;CDC 块用 `cdh`(且必须与 `clens` 等长)。
fn slot_hashes(entry : Entry, cdc : Bool) -> Array[String] raise PartialError {
  if cdc {
    match entry.cdh {
      Some(hashes) =>
        match entry.clens {
          Some(lens) =>
            if hashes.length() != lens.length() {
              raise CorruptState("\{entry.path} 的 clens 与 cdh 不等长")
            } else {
              hashes
            }
          None => raise CorruptState("\{entry.path} 缺少 clens")
        }
      None => raise CorruptState("\{entry.path} 缺少 cdh")
    }
  } else {
    entry.blocks
  }
}

///|
/// 块布局:定长块按 `min(BLOCK_SIZE, size - offset)` 切;CDC 块按 `clens` 顺序铺。
fn slot_layout(
  entry : Entry,
  cdc : Bool,
  slots : Int32,
) -> (Array[Int64], Array[Int64]) raise PartialError {
  let offsets : Array[Int64] = []
  let lengths : Array[Int64] = []
  let mut total = 0L
  for i in 0..<slots {
    offsets.push(total)
    let len = if cdc {
      match entry.clens {
        Some(lens) => lens[i]
        None => raise CorruptState("\{entry.path} 缺少 clens")
      }
    } else {
      // 条目声明的尺寸与块布局不自洽(恶意 / 损坏数据):宁可拒收,不可错铺
      let rest = entry.size - total
      if rest <= 0L {
        raise CorruptState("\{entry.path} 的 size 与块数不自洽")
      }
      if rest < @core.BLOCK_SIZE.to_int64() {
        rest
      } else {
        @core.BLOCK_SIZE.to_int64()
      }
    }
    lengths.push(len)
    total += len
  }
  (offsets, lengths)
}

///|
/// 从 manifest 恢复续传位图并自检;任何一步不合(损坏 / 指纹不符 / 块读不满 /
/// 哈希对不上)都按「无中间态」处理 —— 返回 None,由调用方从零重收。
/// 自检逐槽回读验哈希:半截块(崩在写中间)、被别的进程改过的区间清位退回重传。
///
/// 必须循环读满:单次定位读的短读是 POSIX 允许的正常返回,拿短读去验哈希会把
/// **写对了的槽位**误判成坏块清位重传。宁可多读一遍盘,不可把坏块当成已收。
async fn resume_bitmap(
  tmp : String,
  manifest_path : String,
  fingerprint~ : String,
  cdc~ : Bool,
  hashes : Array[String],
  offsets : Array[Int64],
  lengths : Array[Int64],
) -> (SlotBitmap, Int64)? {
  let prev = match
    read_manifest(manifest_path, fingerprint~, cdc~, slots=hashes.length()) {
    Some(m) => m
    None => return None
  }
  let bitmap = SlotBitmap::from_base64(prev.slots, prev.bitmap) catch {
    _ => return None
  }
  let file = @fs.open(tmp, mode=ReadOnly) catch { _ => return None }
  defer file.close()
  for i in 0..<hashes.length() {
    if !bitmap.has(i) {
      continue
    }
    let want = lengths[i].to_int()
    let buf : FixedArray[Byte] = FixedArray::make(want, b'\x00')
    let mut filled = 0
    let mut broken = false
    while filled < want {
      let n = file.read_at(
        buf,
        position=offsets[i] + filled.to_int64(),
        offset=filled,
        len=want - filled,
      ) catch {
        _ => -1
      }
      if n <= 0 {
        broken = true
        break
      }
      filled += n
    }
    if broken ||
      @core.hash_block(Bytes::from_array(buf.exact_view(end=filled))) !=
      hashes[i] {
      bitmap.clear(i)
    }
  }
  Some((bitmap, prev.started_at))
}

///|
/// 开启(或续上)一个在途接收:
///  - manifest 有效且 tmp 还在 → 从位图继续(自检清掉名不副实的槽位);
///  - 其余情况(无 manifest / 损坏 / 指纹或槽位数不符 / tmp 丢失)→ 全新接收,
///    第一个块到达时才截断重建 tmp。
pub async fn PartialStore::begin(
  root : String,
  entry : Entry,
  cdc : Bool,
) -> PartialStore raise PartialError {
  let target = resolve_share_path(root, entry.path, false) catch {
    e => raise UnsafeTarget("\{entry.path}: \{@debug.to_string(e)}")
  }
  let paths = partial_paths(target)
  let hashes = slot_hashes(entry, cdc)
  let slots = hashes.length()
  let (offsets, lengths) = slot_layout(entry, cdc, slots)
  let fingerprint = entry_fingerprint(entry)
  // 只认「manifest 说得清这份内容」:tmp 长度不做等式校验 —— 长度不符的槽位在
  // 自检里一律读不满,自动清位,末尾还有 executor 的验块闸门兜底。
  let tmp_exists = @fs.exists(paths.tmp) catch { _ => false }
  let resumed : (SlotBitmap, Int64)? = if tmp_exists && slots > 0 {
    // resume_bitmap 理论上不抛(内部全兜),仍按「无中间态」兜一层竞态异常
    resume_bitmap(
      paths.tmp,
      paths.manifest,
      fingerprint~,
      cdc~,
      hashes,
      offsets,
      lengths,
    ) catch {
      _ => None
    }
  } else {
    None
  }
  let (bitmap, started_at) = match resumed {
    Some(pair) => pair
    None => (SlotBitmap::new(slots), now_ms())
  }
  let mut received = 0L
  for i in 0..<slots {
    if bitmap.has(i) {
      received += lengths[i]
    }
  }
  {
    target,
    manifest_path: paths.manifest,
    fingerprint,
    cdc,
    hashes,
    offsets,
    lengths,
    bitmap,
    received_bytes: received,
    started_at,
    file: None,
    dirty: 0,
  }
}

///|
/// 该槽位是否已正确写入。
pub fn PartialStore::has(self : PartialStore, index : Int32) -> Bool {
  self.bitmap.has(index)
}

///|
/// 已收槽位数。
pub fn PartialStore::count(self : PartialStore) -> Int32 {
  self.bitmap.count()
}

///|
/// 已收字节数(进度统计)。
pub fn PartialStore::received_bytes(self : PartialStore) -> Int64 {
  self.received_bytes
}

///|
/// 目标文件绝对路径(落地后清 sidecar 用)。
pub fn PartialStore::target_path(self : PartialStore) -> String {
  self.target
}

///|
/// 还缺哪些块(重连后只请求这些)。
pub fn PartialStore::missing_slots(self : PartialStore) -> Array[Int32] {
  let out : Array[Int32] = []
  for i in 0..<self.hashes.length() {
    if !self.bitmap.has(i) {
      out.push(i)
    }
  }
  out
}

///|
/// 是否已收齐。
pub fn PartialStore::is_full(self : PartialStore) -> Bool {
  self.bitmap.full()
}

///|
/// 写入一个槽位(乱序安全、重复幂等)。落盘前逐块验哈希:位图一旦说
/// 「这块已在盘上」就必须是真的对,续传与终验才敢信。
pub async fn PartialStore::append(
  self : PartialStore,
  index : Int32,
  data : Bytes,
) -> Unit raise PartialError {
  if index < 0 || index >= self.hashes.length() {
    raise CorruptState(
      "块索引越界: \{index}(共 \{self.hashes.length()} 块)",
    )
  }
  if self.bitmap.has(index) {
    return // 重复响应:幂等,不重写也不重复计数
  }
  if @core.hash_block(data) != self.hashes[index] {
    raise BlockMismatch("块哈希不符: 第 \{index} 块")
  }
  if data.length() != self.lengths[index].to_int() {
    raise BlockMismatch(
      "块长度不符: 第 \{index} 块期望 \{self.lengths[index]} 字节,实际 \{data.length()}",
    )
  }
  let file = self.ensure_file()
  file.write_at(data, position=self.offsets[index]) catch {
    e =>
      raise IoFailed("写入 \{self.target}\{PARTIAL_TMP_SUFFIX} 失败: \{e}")
  }
  self.bitmap.set(index)
  self.received_bytes += data.length().to_int64()
  self.dirty += 1
  if self.dirty >= PARTIAL_COMMIT_SLOTS || self.bitmap.full() {
    self.commit()
  }
}

///|
/// 磁盘中间态按需创建:第一个块到达才开句柄。自认为已有内容(续传)时不能截断,
/// 否则等于把断点续传删了。
async fn PartialStore::ensure_file(
  self : PartialStore,
) -> @fs.File raise PartialError {
  match self.file {
    Some(f) => f
    None => {
      ensure_parent(self.target) catch {
        e => raise IoFailed("创建父目录失败(\{self.target}): \{e}")
      }
      let create_mode : @fs.CreateMode = if self.bitmap.count() > 0 {
        OpenOrCreate
      } else {
        CreateOrTruncate
      }
      let file = @fs.open(
        self.target + PARTIAL_TMP_SUFFIX,
        mode=ReadWrite,
        create_mode~,
      ) catch {
        e =>
          raise IoFailed(
            "打开 \{self.target}\{PARTIAL_TMP_SUFFIX} 失败: \{e}",
          )
      }
      self.file = Some(file)
      file
    }
  }
}

///|
/// 关掉写句柄(幂等)。Windows 上句柄不关就 rename / 删不掉。
fn PartialStore::close_file(self : PartialStore) -> Unit {
  match self.file {
    Some(f) => {
      f.close()
      self.file = None
    }
    None => ()
  }
}

///|
/// 先 fsync 字节,再写位图:位图说「已写」的块必须已经真在盘上,崩溃后位图才可信。
/// sync 失败就不写位图(宁可重传这几块,不可谎报进度)。
async fn PartialStore::commit(self : PartialStore) -> Unit noraise {
  if self.dirty == 0 {
    return
  }
  match self.file {
    Some(f) => {
      let synced = try {
        f.sync()
        true
      } catch {
        _ => false
      }
      if !synced {
        return
      }
    }
    None => return
  }
  let manifest : PartialManifest = {
    v: 1,
    fingerprint: self.fingerprint,
    cdc: self.cdc,
    slots: self.hashes.length(),
    bitmap: self.bitmap.to_base64(),
    started_at: self.started_at,
    updated_at: now_ms(),
  }
  write_manifest(self.manifest_path, manifest) catch {
    _ => () // 位图写失败:进度丢了这几块,接收不受影响
  }
  self.dirty = 0
}

///|
/// 读回已收齐的内容(交给 executor 现有的 tmp → fsync → 验块 → rename 管线落地)。
/// 读之前关掉写句柄:executor 会重写同一路径的 tmp,开着句柄 Windows 上会撞锁。
/// 空文件没有 tmp 可读,直接返回空字节。
pub async fn PartialStore::read_content(
  self : PartialStore,
) -> Bytes raise PartialError {
  self.close_file()
  if self.hashes.length() == 0 {
    return b""
  }
  let data = @fs.read_file("\{self.target}\{PARTIAL_TMP_SUFFIX}") catch {
    e =>
      raise IoFailed("读取 \{self.target}\{PARTIAL_TMP_SUFFIX} 失败: \{e}")
  }
  data.binary()
}

///|
/// 放弃本次接收:保留中间态供下次续传,或整对作废。
pub async fn PartialStore::abort(
  self : PartialStore,
  keep_partial~ : Bool,
) -> Unit {
  if self.file is Some(_) {
    if keep_partial {
      self.commit()
    }
    self.close_file()
  }
  if !keep_partial {
    remove_partial(self.target)
  }
}
