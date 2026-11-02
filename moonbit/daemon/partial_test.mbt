///|
/// PartialStore 黑盒测试:真实 /tmp 文件系统。
/// 覆盖:部分落盘 → 重开续传 → 落地校验;损坏 / 指纹不符 manifest 降级;
/// 过期中间态与 scanner 的 TTL 回收对齐;收齐后交给 executor 现有落地管线。

///|
/// 构造一份「传输中」的测试内容:按 1 MiB 定长块切成 n 块(末块可短)。
fn make_content(total : Int32) -> Bytes {
  let unit = @utf8.encode(
    "The quick brown fox jumps over the lazy dog. 0123456789",
  )
  let buf = @buffer.Buffer()
  let mut written = 0
  while written < total {
    buf.write_bytes(unit)
    written += unit.length()
  }
  buf.to_bytes()[0:total].to_owned()
}

///|
/// 与传输条目自洽的 Entry:块哈希由内容逐块算出(size 与 blocks 一致)。
fn partial_entry(path : String, content : Bytes) -> @daemon.Entry {
  let blocks : Array[String] = []
  let size = content.length()
  let mut off = 0
  while off < size {
    let rest = size - off
    let len = if rest < @core.BLOCK_SIZE { rest } else { @core.BLOCK_SIZE }
    blocks.push(@core.hash_block(content[off:off + len].to_owned()))
    off += len
  }
  {
    path,
    version: Map([("dev-x", 1L)]),
    size: size.to_int64(),
    deleted: false,
    blocks,
    cdh: None,
    clens: None,
    mtime: None,
    placeholder: false,
  }
}

///|
/// 取内容的第 i 块(与 slot_layout 同口径:1 MiB 定长,末块可短)。
fn block_slice(content : Bytes, i : Int32) -> Bytes {
  let off = i * @core.BLOCK_SIZE
  let rest = content.length() - off
  let len = if rest < @core.BLOCK_SIZE { rest } else { @core.BLOCK_SIZE }
  content[off:off + len].to_owned()
}

///|
/// 指纹 golden:与 Node `entryFingerprint` / Rust `entry_fingerprint` 逐字节一致
/// —— sha256("100\0aa,bb\0\0",`clens` 之后**没有**尾随分隔符)的十六进制小写。
/// 分隔符个数 / 字段错位都会在这里现形。
test "entry_fingerprint: 与 Node/Rust 逐字节一致" {
  let entry : @daemon.Entry = {
    path: "x.bin",
    version: Map([]),
    size: 100L,
    deleted: false,
    blocks: ["aa", "bb"],
    cdh: None,
    clens: None,
    mtime: None,
    placeholder: false,
  }
  assert_eq(
    @daemon.entry_fingerprint(entry),
    "5c9ef4d638aa3812df531c1f4067427c0cb54e85e8f0940f3f2df841425b6831",
  )
  // 指纹只看内容:version / mtime / path 变化不影响
  let entry2 : @daemon.Entry = {
    path: "other.bin",
    version: Map([("dev", 42L)]),
    size: 100L,
    deleted: false,
    blocks: ["aa", "bb"],
    cdh: None,
    clens: None,
    mtime: Some(123456L),
    placeholder: false,
  }
  assert_eq(@daemon.entry_fingerprint(entry2), @daemon.entry_fingerprint(entry))
  // 内容一变(哪怕一块),指纹必变
  let entry3 : @daemon.Entry = {
    path: "x.bin",
    version: Map([]),
    size: 100L,
    deleted: false,
    blocks: ["aa", "bc"],
    cdh: None,
    clens: None,
    mtime: None,
    placeholder: false,
  }
  assert_true(
    @daemon.entry_fingerprint(entry3) != @daemon.entry_fingerprint(entry),
  )
}

///|
test "SlotBitmap: 置位 / 清位 / 计数 / 满判 / base64 往返 / 坏输入" {
  let bm = @daemon.SlotBitmap::new(10)
  assert_false(bm.has(0))
  assert_eq(bm.count(), 0)
  assert_false(bm.full())
  for i in 0..<10 {
    bm.set(i)
  }
  assert_true(bm.full())
  assert_eq(bm.count(), 10)
  bm.clear(3)
  assert_false(bm.has(3))
  assert_true(bm.has(4))
  assert_eq(bm.count(), 9)
  assert_false(bm.full())
  // 越界安全:置位 / 清位 / 查询一律按缺失处理
  bm.set(99)
  bm.clear(-1)
  assert_false(bm.has(99))
  // base64 往返
  let bm2 = @daemon.SlotBitmap::from_base64(10, bm.to_base64())
  assert_false(bm2.has(3))
  assert_true(bm2.has(4))
  assert_eq(bm2.count(), 9)
  // 长度不符:报错(调用方据此把坏 manifest 当成「没有中间态」)
  let bad_length = try {
    let _ = @daemon.SlotBitmap::from_base64(10, "AAAA")
    true
  } catch {
    _ => false
  }
  assert_false(bad_length)
  // 非法 base64:同样报错
  let bad_base64 = try {
    let _ = @daemon.SlotBitmap::from_base64(10, "!!!")
    true
  } catch {
    _ => false
  }
  assert_false(bad_base64)
}

///|
async test "PartialStore: 部分落盘 → 重开 → 续传 → 落地校验哈希" {
  let root = fresh_dir("resume")
  // 10 块(9 个整 1 MiB + 一个短尾块):跨过 8 块的位图提交阈值,
  // 否则 manifest 还没落盘,重启就无从续起。
  let content = make_content(9 * @core.BLOCK_SIZE + 12345)
  let entry = partial_entry("a/big.bin", content)
  let store = @daemon.PartialStore::begin(root, entry, false)
  assert_eq(store.missing_slots().length(), 10)
  // 一个块都没到:不碰盘(按需创建)
  let tmp_exists = @fs.exists("\{root}/a/big.bin.syncx-tmp") catch {
    _ => false
  }
  assert_false(tmp_exists)
  // 乱序落前两块
  store.append(1, block_slice(content, 1))
  store.append(0, block_slice(content, 0))
  assert_true(store.has(0))
  assert_true(store.has(1))
  assert_false(store.has(2))
  // 错哈希 / 错长度的块:整块拒绝,位图不动
  let wrong_hash = try {
    store.append(2, block_slice(content, 3))
    true
  } catch {
    _ => false
  }
  assert_false(wrong_hash)
  assert_false(store.has(2))
  // 落到第 8 块:位图批量交代(manifest 已在盘上)
  for i in 2..<8 {
    store.append(i, block_slice(content, i))
  }
  let manifest_exists = @fs.exists("\{root}/a/big.bin.syncx-partial") catch {
    _ => false
  }
  assert_true(manifest_exists)
  // 模拟重启:重开 store,从位图续传,已收的 8 块不重传
  let resumed = @daemon.PartialStore::begin(root, entry, false)
  assert_eq(resumed.count(), 8)
  let missing = resumed.missing_slots()
  assert_eq(missing.length(), 2)
  assert_eq(missing[0], 8)
  assert_eq(missing[1], 9)
  // 幂等:重放已收块不重写也不报错
  resumed.append(1, block_slice(content, 1))
  assert_eq(resumed.count(), 8)
  // 只补缺的两块即收齐
  for i in missing {
    resumed.append(i, block_slice(content, i))
  }
  assert_true(resumed.is_full())
  // 读回整份内容:与源内容逐字节一致
  let readback = resumed.read_content()
  assert_eq(readback.length(), content.length())
  assert_eq(@core.hash_block(readback), @core.hash_block(content))
  // 落地成功后清 sidecar:成对消失
  @daemon.remove_partial("\{root}/a/big.bin")
  let sidecar_exists = @fs.exists("\{root}/a/big.bin.syncx-partial") catch {
    _ => false
  }
  assert_false(sidecar_exists)
}

///|
async test "PartialStore: 损坏 manifest 按重头收降级" {
  let root = fresh_dir("corrupt")
  let content = make_content(9 * @core.BLOCK_SIZE + 12345)
  let entry = partial_entry("a/big.bin", content)
  let store = @daemon.PartialStore::begin(root, entry, false)
  for i in 0..<8 {
    store.append(i, block_slice(content, i))
  }
  // 把 manifest 写成垃圾
  @fs.write_file(
    "\{root}/a/big.bin.syncx-partial",
    "{{{不是 JSON",
    create_mode=CreateOrTruncate,
  )
  let resumed = @daemon.PartialStore::begin(root, entry, false)
  assert_eq(resumed.count(), 0)
  assert_eq(resumed.missing_slots().length(), 10)
  // 重头收:第一块到达时截断重建 tmp,后续照常收齐
  for i in 0..<10 {
    resumed.append(i, block_slice(content, i))
  }
  assert_true(resumed.is_full())
  assert_eq(@core.hash_block(resumed.read_content()), @core.hash_block(content))
}

///|
async test "PartialStore: 指纹不符(内容变了)整份作废重收" {
  let root = fresh_dir("fp")
  let content = make_content(9 * @core.BLOCK_SIZE + 12345)
  let entry = partial_entry("a/big.bin", content)
  let store = @daemon.PartialStore::begin(root, entry, false)
  for i in 0..<8 {
    store.append(i, block_slice(content, i))
  }
  // 对端内容变了(这里改尾块长度):指纹必变,旧 tmp 整份作废 ——
  // 宁可重传,不可错接。
  let changed = make_content(9 * @core.BLOCK_SIZE + 4321)
  let entry2 = partial_entry("a/big.bin", changed)
  let resumed = @daemon.PartialStore::begin(root, entry2, false)
  assert_eq(resumed.count(), 0)
  assert_eq(resumed.missing_slots().length(), 10)
  for i in 0..<10 {
    resumed.append(i, block_slice(changed, i))
  }
  assert_true(resumed.is_full())
  assert_eq(@core.hash_block(resumed.read_content()), @core.hash_block(changed))
}

///|
async test "PartialStore: 过期中间态由 scanner 按 TTL 整对回收" {
  let root = fresh_dir("ttl")
  let content = make_content(9 * @core.BLOCK_SIZE + 12345)
  let entry = partial_entry("a/big.bin", content)
  let store = @daemon.PartialStore::begin(root, entry, false)
  for i in 0..<8 {
    store.append(i, block_slice(content, i))
  }
  store.abort(keep_partial=true)
  // 快进 8 天:scanner 的 prune_scratch_file 按 tmp 的 mtime 判超期,
  // 整对删掉 tmp 与 sidecar(7 天 TTL,与 PARTIAL_TTL_MS 同源)
  let future = @daemon.now_ms() + @daemon.PARTIAL_TTL_MS + 1L
  let pruned = @daemon.prune_scratch_file(
    "\{root}/a",
    "big.bin.syncx-tmp",
    now=future,
  )
  assert_true(pruned)
  let tmp_exists = @fs.exists("\{root}/a/big.bin.syncx-tmp") catch {
    _ => false
  }
  let sidecar_exists = @fs.exists("\{root}/a/big.bin.syncx-partial") catch {
    _ => false
  }
  assert_false(tmp_exists)
  assert_false(sidecar_exists)
  // 未超期:一个都不动
  let store2 = @daemon.PartialStore::begin(root, entry, false)
  for i in 0..<8 {
    store2.append(i, block_slice(content, i))
  }
  store2.abort(keep_partial=true)
  let kept = @daemon.prune_scratch_file(
    "\{root}/a",
    "big.bin.syncx-tmp",
    now=@daemon.now_ms(),
  )
  assert_false(kept)
}

///|
async test "PartialStore: 收齐后交给 executor 现有落地管线" {
  let root = fresh_dir("land")
  let content = make_content(3 * @core.BLOCK_SIZE / 2)
  let entry = partial_entry("dir/file.bin", content)
  let store = @daemon.PartialStore::begin(root, entry, false)
  for i in 0..<2 {
    store.append(i, block_slice(content, i))
  }
  assert_true(store.is_full())
  // 读回内容,走 executor 的 tmp → fsync → 验块 → rename 管线
  let content_read = store.read_content()
  let index = new_store("land")
  let executor = @daemon.LocalExecutor::new(root, "\{root}-trash")
  executor.apply_file(index, entry, content_read)
  // 目标文件落盘且内容一致;tmp 已被 rename 带走
  let landed = @fs.read_file("\{root}/dir/file.bin").binary()
  assert_eq(@core.hash_block(landed), @core.hash_block(content))
  let tmp_exists = @fs.exists("\{root}/dir/file.bin.syncx-tmp") catch {
    _ => false
  }
  assert_false(tmp_exists)
  // 索引也登记了
  let stored = index.get_entry("dir/file.bin")
  assert_true(stored is Some(_))
  // 落地成功后清 sidecar(与 complete_receive 同口径)
  @daemon.remove_partial("\{root}/dir/file.bin")
  let sidecar_exists = @fs.exists("\{root}/dir/file.bin.syncx-partial") catch {
    _ => false
  }
  assert_false(sidecar_exists)
}

///|
async test "PartialStore: 空文件无块可收,读回为空" {
  let root = fresh_dir("empty")
  let entry = partial_entry("empty.txt", b"")
  let store = @daemon.PartialStore::begin(root, entry, false)
  assert_eq(store.missing_slots().length(), 0)
  assert_true(store.is_full())
  assert_eq(store.read_content().length(), 0)
}

///|
async test "PartialStore: 放弃时保留 / 作废中间态" {
  let root = fresh_dir("abort")
  let content = make_content(@core.BLOCK_SIZE + 100)
  let entry = partial_entry("a/x.bin", content)
  let store = @daemon.PartialStore::begin(root, entry, false)
  store.append(0, block_slice(content, 0))
  // keep_partial:保留中间态供重连续传
  store.abort(keep_partial=true)
  let resumed = @daemon.PartialStore::begin(root, entry, false)
  assert_eq(resumed.count(), 1)
  // 作废:整对删除
  resumed.abort(keep_partial=false)
  let tmp_exists = @fs.exists("\{root}/a/x.bin.syncx-tmp") catch { _ => false }
  let sidecar_exists = @fs.exists("\{root}/a/x.bin.syncx-partial") catch {
    _ => false
  }
  assert_false(tmp_exists)
  assert_false(sidecar_exists)
}

///|
async test "PartialStore: 越界路径拒绝(硬忽略 / 逃逸)" {
  let root = fresh_dir("unsafe")
  let content = make_content(100)
  let entry = partial_entry(".git/config", content)
  let blocked = try {
    let _ = @daemon.PartialStore::begin(root, entry, false)
    true
  } catch {
    _ => false
  }
  assert_false(blocked)
  let escape = partial_entry("../escape.bin", content)
  let blocked2 = try {
    let _ = @daemon.PartialStore::begin(root, escape, false)
    true
  } catch {
    _ => false
  }
  assert_false(blocked2)
}
