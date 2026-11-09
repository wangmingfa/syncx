///|
/// 定长分块、SHA-256 与 CDC 内容定义分块(对应 Node `src/blockstore.ts`、
/// Rust `syncx-core/src/blockstore.rs`)。
///
/// CDC 这块是整个移植里**最不能"差不多"**的部分:块哈希写进索引后,
/// 两端按哈希比对内容。边界只要差一个字节,块集合就对不上,症状是
/// "这个文件永远同步不动",而且不崩、不报错、日志干净。
///
/// 两个必须逐位复刻的细节:
///  1. `gear_table` 用 mulberry32 + 固定种子 `0x9e3779b9` 生成 —— 种子一经写入
///     源码即永久冻结,换了表就等于换了协议;
///  2. 滚动指纹**必须带窗口移出项**。只留累入项时,同一个字节被循环移位 32 次
///     后回到原值,改动带来的差分会永久旋转下去而不消失,其后每个边界都跟着错位
///     (ADR-0019 记的"1 字节改写让整文件重传")。
///
/// 32 位算术一律在 UInt64 里做完再掩到低 32 位,避免任何依赖溢出回绕的写法。

///|
/// 定长块大小:1 MiB。**协议常量**,与 Node 侧 `BLOCK_SIZE` 必须一致。
pub const BLOCK_SIZE : Int32 = 1024 * 1024

///|
/// CDC 块长下限:太短的碎片会让哈希列表本身成为索引/线路负担。
pub const CDC_MIN_CHUNK : Int32 = 256 * 1024

///|
/// CDC 块长上限,同时是「单个块响应」的体积上限(接收闸门按此拒绝超大块)。
pub const CDC_MAX_CHUNK : Int32 = 4 * 1024 * 1024

///|
/// 目标平均块长 ≈ 1 MiB(2^20 分之一命中)。
const CDC_MASK : UInt64 = 0xFFFFFUL

///|
/// 指纹窗口宽度:一个字节只对随后这么多字节内的边界判定有影响。
const BUZ_WINDOW : Int32 = 32

///|
/// 低 32 位掩码:所有「u32 语义」的运算都在 UInt64 里做完后用它截断。
const U32_MASK : UInt64 = 0xFFFFFFFFUL

///|
/// 内容指纹滚动表:256 个 32 位值,mulberry32 固定种子确定性生成。
///
/// 种子 `0x9e3779b9`(黄金比例常数)是**协议的一部分**。每次调用重算代价极小
/// (256 次乘法),不缓存。
///
/// 注意 `(1 | a)` 与 `(61 | t)` 里两个按位或不能省 —— 少一个就得到另一张表,
/// 表一换所有 CDC 边界全部错位,两端块集合永远对不上。
fn gear_table() -> FixedArray[UInt64] {
  let table : FixedArray[UInt64] = FixedArray::make(256, 0UL)
  let mut a : UInt64 = 0x9E3779B9UL
  for i in 0..<=255 {
    a = (a + 0x6D2B79F5UL) & U32_MASK
    let mut t = ((a ^ (a >> 15)) * (1UL | a)) & U32_MASK
    t = ((t + (((t ^ (t >> 7)) * (61UL | t)) & U32_MASK)) & U32_MASK) ^ t
    table[i] = (t ^ (t >> 14)) & U32_MASK
  }
  table
}

///|
/// 32 位循环左移 1 位。
fn rotl32(x : UInt64) -> UInt64 {
  ((x << 1) | (x >> 31)) & U32_MASK
}

///|
/// 带窗口移出项的 Buzhash 滚动指纹。
///
/// 折叠式:`fp_i = XOR_{d=0}^{W-1} rot^d(GEAR[b_{i-d}])`,由此得到逐步形式
/// `fp_i = rot1(fp_{i-1}) ^ GEAR[in] ^ rot^W(GEAR[out])`。
/// 32 位整数上 `rot^32` 是恒等,所以移出项就是 `GEAR[out]` 本身。
struct RollingFingerprint {
  gear : FixedArray[UInt64]
  /// 环形缓冲:槽位 `i & (W-1)` 存 W 个字节前进场的那个字节。
  entered : FixedArray[Byte]
  mut fp : UInt64
  mut seen : Int32
}

///|
fn RollingFingerprint::new(gear : FixedArray[UInt64]) -> RollingFingerprint {
  { gear, entered: FixedArray::make(BUZ_WINDOW, b'\x00'), fp: 0UL, seen: 0, }
}

///|
/// 吃进一个字节,返回滚动后的指纹。
fn RollingFingerprint::step(self : RollingFingerprint, byte : Byte) -> UInt64 {
  let i = self.seen
  self.seen += 1
  let slot = i % BUZ_WINDOW
  // 窗口还在填(前 W 个字节)时没有移出项
  let removal = if i >= BUZ_WINDOW {
    self.gear[self.entered[slot].to_uint().reinterpret_as_int()]
  } else {
    0UL
  }
  self.entered[slot] = byte
  self.fp = rotl32(self.fp) ^
    self.gear[byte.to_uint().reinterpret_as_int()] ^
    removal
  self.fp
}

///|
/// 按内容定义边界切块。返回每块的 `(offset, length)`,不复制字节。
///
/// 规则:距上一边界不足 `CDC_MIN_CHUNK` 不判边界;此后逐字节滚动指纹,
/// 低 20 位全 0 即收块(期望平均 ≈1 MiB),达 `CDC_MAX_CHUNK` 强制收块;
/// EOF 就是边界(末块可短)。
pub fn chunk_ranges(data : Bytes) -> Array[(Int32, Int32)] {
  let chunks : Array[(Int32, Int32)] = []
  let len = data.length()
  if len == 0 {
    return chunks
  }
  let buz = RollingFingerprint::new(gear_table())
  let mut start = 0
  for i in 0..<len {
    let fp = buz.step(data[i])
    let chunk_len = i + 1 - start
    let cut = (chunk_len >= CDC_MIN_CHUNK && (fp & CDC_MASK) == 0UL) ||
      chunk_len >= CDC_MAX_CHUNK ||
      i + 1 == len
    if cut {
      chunks.push((start, chunk_len))
      start = i + 1
    }
  }
  chunks
}

///|
/// 定长分块:按 `BLOCK_SIZE` 直接切片,返回 `(offset, length)`。
pub fn split_ranges(data_len : Int32) -> Array[(Int32, Int32)] {
  let blocks : Array[(Int32, Int32)] = []
  let mut offset = 0
  while offset < data_len {
    let rest = data_len - offset
    let len = if BLOCK_SIZE < rest { BLOCK_SIZE } else { rest }
    blocks.push((offset, len))
    offset += len
  }
  blocks
}

// ==================== SHA-256 ====================

// SHA-256 轮常量(协议公开常量,与任何实现一致)。
// 表与初始向量在 new 时重建:不在顶层持有,避免依赖全局初始化顺序。

///|
fn sha256_k() -> FixedArray[UInt32] {
  let k : FixedArray[UInt32] = FixedArray::make(64, 0)
  let vals : Array[UInt32] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]
  for i in 0..<64 {
    k[i] = vals[i]
  }
  k
}

///|
fn sha256_rotr(x : UInt32, n : Int32) -> UInt32 {
  (x >> n) | (x << (32 - n))
}

///|
/// 流式 SHA-256。逐段喂字节,`hex()` 收尾取十六进制摘要(小写)。
struct Sha256 {
  h : FixedArray[UInt32]
  /// 轮常量表:new 时建一次。原先在 process_block 里每块重建,
  /// 64KB 就是 1024 次表分配 + 初始化(实测占掉约三成耗时)。
  k : FixedArray[UInt32]
  buf : FixedArray[Byte]
  mut buf_len : Int32
  /// 已处理字节数
  mut total : Int64
}

///|
fn Sha256::new() -> Sha256 {
  let h : FixedArray[UInt32] = FixedArray::make(8, 0)
  let init : Array[UInt32] = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]
  for i in 0..<8 {
    h[i] = init[i]
  }
  {
    h,
    k: sha256_k(),
    buf: FixedArray::make(64, b'\x00'),
    buf_len: 0,
    total: 0L,
  }
}

///|
fn Sha256::process_block(self : Sha256, block : FixedArray[Byte]) -> Unit {
  let k = self.k
  let w : FixedArray[UInt32] = FixedArray::make(64, 0)
  for i in 0..<16 {
    let j = i * 4
    w[i] = (block[j].to_uint() << 24) |
      (block[j + 1].to_uint() << 16) |
      (block[j + 2].to_uint() << 8) |
      block[j + 3].to_uint()
  }
  for i in 16..<64 {
    let s0 = sha256_rotr(w[i - 15], 7) ^
      sha256_rotr(w[i - 15], 18) ^
      (w[i - 15] >> 3)
    let s1 = sha256_rotr(w[i - 2], 17) ^
      sha256_rotr(w[i - 2], 19) ^
      (w[i - 2] >> 10)
    // UInt32 加法按 2^32 回绕,正是 SHA-256 要的语义,无需再逐次掩码
    w[i] = w[i - 16] + s0 + w[i - 7] + s1
  }
  let mut a = self.h[0]
  let mut b = self.h[1]
  let mut c = self.h[2]
  let mut d = self.h[3]
  let mut e = self.h[4]
  let mut f = self.h[5]
  let mut g = self.h[6]
  let mut hh = self.h[7]
  for i in 0..<64 {
    let s1 = sha256_rotr(e, 6) ^ sha256_rotr(e, 11) ^ sha256_rotr(e, 25)
    // ch = (e & f) ^ (!e & g),改写成无按位取反的等价形式
    let ch = g ^ (e & (f ^ g))
    let temp1 = hh + s1 + ch + k[i] + w[i]
    let s0 = sha256_rotr(a, 2) ^ sha256_rotr(a, 13) ^ sha256_rotr(a, 22)
    let maj = (a & b) ^ (a & c) ^ (b & c)
    let temp2 = s0 + maj
    hh = g
    g = f
    f = e
    e = d + temp1
    d = c
    c = b
    b = a
    a = temp1 + temp2
  }
  self.h[0] = self.h[0] + a
  self.h[1] = self.h[1] + b
  self.h[2] = self.h[2] + c
  self.h[3] = self.h[3] + d
  self.h[4] = self.h[4] + e
  self.h[5] = self.h[5] + f
  self.h[6] = self.h[6] + g
  self.h[7] = self.h[7] + hh
}

///|
/// 喂入一段字节(区间 `[start, start + len)`)。
fn Sha256::update(
  self : Sha256,
  data : Bytes,
  start : Int32,
  len : Int32,
) -> Unit {
  self.total += len.to_int64()
  let mut i = start
  let end = start + len
  while i < end {
    let take = {
      let room = 64 - self.buf_len
      let rest = end - i
      if room < rest {
        room
      } else {
        rest
      }
    }
    for j in 0..<take {
      self.buf[self.buf_len + j] = data[i + j]
    }
    self.buf_len += take
    i += take
    if self.buf_len == 64 {
      self.process_block(self.buf)
      self.buf_len = 0
    }
  }
}

///|
/// 收尾(padding + 末块),返回十六进制小写摘要。
fn Sha256::hex(self : Sha256) -> String {
  // 消息长度(位)大端 8 字节
  let bits = self.total * 8L
  // padding:0x80 + 若干 0x00,直到长度 ≡ 56 (mod 64)
  self.buf[self.buf_len] = b'\x80'
  self.buf_len += 1
  if self.buf_len > 56 {
    while self.buf_len < 64 {
      self.buf[self.buf_len] = b'\x00'
      self.buf_len += 1
    }
    self.process_block(self.buf)
    self.buf_len = 0
  }
  while self.buf_len < 56 {
    self.buf[self.buf_len] = b'\x00'
    self.buf_len += 1
  }
  for i in 0..<8 {
    self.buf[56 + i] = ((bits >> ((7 - i) * 8)) & 0xFFL)
      .reinterpret_as_uint64()
      .to_byte()
  }
  self.process_block(self.buf)
  let digits = "0123456789abcdef".to_array()
  let sb = StringBuilder()
  for i in 0..<8 {
    let word = self.h[i]
    let mut shift : Int32 = 28
    while shift >= 0 {
      let nib = ((word >> shift) & 0xF).reinterpret_as_int()
      sb.write_char(digits[nib])
      shift -= 4
    }
  }
  sb.to_string()
}

///|
/// 单块 SHA-256(十六进制小写),与 Node 侧 `hashBlock` 同口径。
pub fn hash_block(block : Bytes) -> String {
  let hasher = Sha256::new()
  hasher.update(block, 0, block.length())
  hasher.hex()
}

///|
/// 一次流式扫描得到的整份文件视图。对应 Node 侧 `FileViews`。
///
/// 三个视图必须来自**同一次读取**:分开读会让文件在两遍之间被改动,
/// 定长块与 CDC 块描述的是两份不同的字节,接收端按 CDC 取块、按定长验完整性,
/// 必然对不上。
pub(all) struct FileViews {
  size : Int64
  /// 定长块哈希(旧对端只认这个)。
  blocks : Array[String]
  /// CDC 块哈希;空文件为 `[]`。
  cdh : Array[String]
  /// CDC 块长,与 `cdh` 一一对应。
  clens : Array[Int64]
}

///|
/// 流式文件视图计算器:逐段喂字节,末尾 `finish()` 取结果。
///
/// 语义与 Node 侧 `hashFileViews` 逐字节等价:定长视图按 1 MiB 窗口独立
/// 哈希;CDC 视图的滚动指纹跨窗口连续(移出项要读到前 32 字节的进场记录),
/// 块哈希用一个持续的 SHA-256 按片段喂 —— SHA-256 本身是流式折叠,分段
/// update 与整体 update 同值,边界落在窗口中间也只换个片段。
///
/// EOF 那一边界不在字节循环里判,而是 `finish()` 收尾:这样长度恰为窗口整数倍时
/// 也不会漏末块。
pub(all) struct ViewHasher {
  buz : RollingFingerprint
  /// 未凑满一个窗口的尾部字节(定长窗口,非 CDC 窗口)。
  partial : FixedArray[Byte]
  mut partial_len : Int32
  blocks : Array[String]
  cdh : Array[String]
  clens : Array[Int64]
  /// 已处理字节数,即多窗口处理时当前窗口的全局起始偏移。
  mut size : Int32
  /// 当前 CDC 块的全局起点。
  mut chunk_start : Int32
  chunk_hash : Sha256
}

///|
pub fn ViewHasher::new() -> ViewHasher {
  {
    buz: RollingFingerprint::new(gear_table()),
    partial: FixedArray::make(BLOCK_SIZE, b'\x00'),
    partial_len: 0,
    blocks: [],
    cdh: [],
    clens: [],
    size: 0,
    chunk_start: 0,
    chunk_hash: Sha256::new(),
  }
}

///|
/// 喂入一段字节。凑满一个 `BLOCK_SIZE` 窗口就处理掉,余量留到下次。
pub fn ViewHasher::push(self : ViewHasher, bytes : Bytes) -> Unit {
  let mut i = 0
  let end = bytes.length()
  while i < end {
    let take = {
      let room = BLOCK_SIZE - self.partial_len
      let rest = end - i
      if room < rest {
        room
      } else {
        rest
      }
    }
    for j in 0..<take {
      self.partial[self.partial_len + j] = bytes[i + j]
    }
    self.partial_len += take
    i += take
    if self.partial_len < BLOCK_SIZE {
      break
    }
    let window = Bytes::from_array(self.partial.exact_view())
    self.partial_len = 0
    self.flush_window(window)
  }
}

///|
/// 处理一个窗口(可能短于 `BLOCK_SIZE`:只有 EOF 才短)。
fn ViewHasher::flush_window(self : ViewHasher, window : Bytes) -> Unit {
  self.blocks.push(hash_block(window))
  let mut seg_start = 0
  for j in 0..<window.length() {
    let fp = self.buz.step(window[j])
    let chunk_len = self.size + j + 1 - self.chunk_start
    let cut = (chunk_len >= CDC_MIN_CHUNK && (fp & CDC_MASK) == 0UL) ||
      chunk_len >= CDC_MAX_CHUNK
    if cut {
      self.chunk_hash.update(window, seg_start, j + 1 - seg_start)
      let digest = self.chunk_hash.hex()
      self.cdh.push(digest)
      self.clens.push(chunk_len.to_int64())
      // 重开一个 SHA-256 给下一块
      self.chunk_hash.reset()
      self.chunk_start = self.size + j + 1
      seg_start = j + 1
    }
  }
  self.chunk_hash.update(window, seg_start, window.length() - seg_start)
  self.size += window.length()
}

///|
fn Sha256::reset(self : Sha256) -> Unit {
  let fresh = Sha256::new()
  for i in 0..<8 {
    self.h[i] = fresh.h[i]
  }
  self.buf_len = 0
  self.total = 0L
}

///|
/// 收尾:处理残留窗口,并把最后一个未收的 CDC 块按 EOF 边界收下。
pub fn ViewHasher::finish(self : ViewHasher) -> FileViews {
  if self.partial_len > 0 {
    let window = Bytes::from_array(
      self.partial.exact_view(end=self.partial_len),
    )
    self.partial_len = 0
    self.flush_window(window)
  }
  if self.chunk_start < self.size {
    let digest = self.chunk_hash.hex()
    self.cdh.push(digest)
    self.clens.push((self.size - self.chunk_start).to_int64())
  }
  {
    size: self.size.to_int64(),
    blocks: self.blocks,
    cdh: self.cdh,
    clens: self.clens,
  }
}
