///|
/// 接收落地、删除、冲突与版本快照(对应 Rust `syncx-daemon/src/executor.rs`、
/// Node `src/executor.ts`)这里是**唯一**动本地文件的那一层,两个闸门也只能放在这里:
///
///  1. `resolve_share_path` 的符号链接越界校验。对端可以发来任意相对路径,而共享
///     目录里可能早已有指向目录外的符号链接段 —— 逐段 realpath,任何一段逃出共享
///     根就拒绝。
///  2. 硬忽略的最后一道闸门。上游(规划、扫描、peer)漏了过滤都不该让对端写进本机
///     `.git`,也不该让本机 `.git` 被移进回收站。
///
/// 落地的两条铁律同样在这里:
///  - **先校验再动本地文件**(`apply_conflict` 先验 tmp 内容再 rename 本地文件)。
///    校验不过时把本地文件 rename 成冲突副本,会让原路径变空、下一轮扫描生成
///    墓碑把对端也删掉。
///  - **先写临时文件,fsync 后原子 rename 换入**;写一半崩了也不会污染目标文件。
///
/// 与 Rust 版的刻意偏差:MoonBit 侧暂未移植断点续传中间态(`partial.rs` 的
/// manifest/位图机器),接收以「整份内容 → tmp → 验块 → rename」的简化管线落地;
/// tmp/sidecar 残骸的回收仍由扫描器按 TTL 负责。

///|
/// 每路径保留的版本份数上限的默认值(设置页可调)。
pub const DEFAULT_VERSIONS_PER_PATH : Int32 = 10

///|
/// 执行器错误(与 Rust `ExecutorError` 对应;消息字段全部收拢为 String,
/// 便于上层统一打日志)。
pub(all) suberror ExecutorError {
  /// 文件系统操作失败。
  Io(String)
  /// 索引库错误。
  Store(IndexStoreError)
  /// 越界或不安全的路径(绝对段、越过根的 `..`、符号链接逃逸)。
  UnsafePath(String)
  /// 硬忽略路径(回收站/版本目录解析时绕过,其余一律拒绝)。
  HardIgnored(String)
  /// 接收未收齐。
  Incomplete(String)
  /// 内容与条目不符。
  ContentMismatch(String)
  /// 文件不存在。
  FileNotFound(String)
}

///|
/// 把一段只抛 IndexStoreError 的操作整体包成 ExecutorError。
fn[T] run_store(body : () -> T raise IndexStoreError) -> T raise ExecutorError {
  body() catch {
    e => raise Store(e)
  }
}

///|
/// ExecutorError 的日志/响应文案。路径闸门两类与 Node resolveSharePath 的
/// 抛错文案逐字一致(前端直接展示),其余变体供日志与内部兜底。
pub fn ExecutorError::to_text(self : ExecutorError) -> String {
  match self {
    Io(message) => message
    Store(err) => err.to_text()
    UnsafePath(path) => "unsafe path: \{path}"
    HardIgnored(path) => "hard-ignored path: \{path}"
    Incomplete(message) => message
    ContentMismatch(message) => message
    FileNotFound(path) => "file not found: \{path}"
  }
}

///|
/// 一个共享目录的本地执行器(字段对齐 Rust `LocalExecutor::ExecutorInner`)。
pub(all) struct LocalExecutor {
  /// 共享根(绝对路径)。
  root : String
  /// 回收站目录(共享目录之外,由调用方指定)。
  trash_dir : String
  /// 版本快照目录;None = 不做版本快照。
  versions_dir : String?
  /// 每路径保留的版本份数上限(≥1)。
  versions_per_path : Int32
}

///|
/// `trash_dir` 刻意由调用方传入而不是在共享根下现算:回收站放在共享目录里会在
/// 用户目录中留下常驻痕迹(并被 `git status` 报成未跟踪文件)。`versions_dir`
/// 保护「修改」,回收站保护「删除」;缺省不做版本快照。
pub fn LocalExecutor::new(
  root : String,
  trash_dir : String,
  versions_dir? : String,
  versions_per_path? : Int32,
) -> LocalExecutor {
  {
    root,
    trash_dir,
    versions_dir,
    versions_per_path: match versions_per_path {
      Some(n) => if n < 1 { 1 } else { n }
      None => DEFAULT_VERSIONS_PER_PATH
    },
  }
}

///|
/// 共享目录内的相对路径 → 绝对路径(含越界与硬忽略校验)。
pub async fn LocalExecutor::resolve_path(
  self : LocalExecutor,
  rel_path : String,
) -> String {
  resolve_share_path(self.root, rel_path, false)
}

///|
/// 冲突副本专用:副本命名本身是硬忽略对象,必须绕过硬忽略闸门,
/// 但符号链接越界校验**不受影响**。
async fn LocalExecutor::resolve_conflict_copy_path(
  self : LocalExecutor,
  rel_path : String,
) -> String {
  resolve_share_path(self.root, rel_path, true)
}

///|
/// 把一份已收齐的内容落地并登记索引(下载管线:tmp → fsync → 验块 → rename)。
///
/// `entry` 携带规划定下的最终版本向量;落地后补上盘上 mtime 供扫描免哈希。
pub async fn LocalExecutor::apply_file(
  self : LocalExecutor,
  index : IndexStore,
  entry : Entry,
  content : Bytes,
) -> Unit {
  let target = self.resolve_path(entry.path)
  // 写 tmp + 终验:验不过时目标文件保持原样,tmp 也不留
  let tmp = land_to_tmp(target, entry.blocks, content)
  // 覆盖前把旧内容快照进版本目录(回收站保护「删除」,这里保护「修改」)
  self.snapshot_version(entry.path)
  self.prune_versions(entry.path)
  @fs.rename(tmp, target)
  let mtime = match mtime_ms(target) {
    Some(t) => t
    None => now_ms()
  }
  let stored : Entry = {
    path: entry.path,
    version: entry.version,
    size: entry.size,
    deleted: entry.deleted,
    blocks: entry.blocks,
    cdh: entry.cdh,
    clens: entry.clens,
    mtime: Some(mtime),
    placeholder: false,
  }
  run_store(() => index.save_entry(stored))
}

///|
/// 删除:移入回收站而非硬删(2026-09-15 事故前删除不可恢复),再写墓碑。
pub async fn LocalExecutor::apply_delete(
  self : LocalExecutor,
  index : IndexStore,
  path : String,
  tombstone : Entry,
) -> Unit {
  let target = self.resolve_path(path)
  let kind = @fs.kind(target) catch { _ => @fs.FileKind::Unknown }
  if kind is Regular {
    self.move_to_trash(path)
  }
  run_store(() => index.save_entry(tombstone))
}

///|
/// 双方都改过同一份文件:本地内容保留成 `.sync-conflict-` 副本,远端内容落地。
pub async fn LocalExecutor::apply_conflict(
  self : LocalExecutor,
  index : IndexStore,
  path : String,
  local_entry : Entry,
  remote : Entry,
  content : Bytes,
  remote_device_id : String,
) -> Entry {
  // 双方同时删除:只合并版本向量写墓碑,绝不落盘空文件复活删除
  if local_entry.deleted && remote.deleted {
    let merged : Entry = {
      path,
      version: @core.merge_versions(local_entry.version, remote.version),
      size: 0L,
      deleted: true,
      blocks: [],
      cdh: None,
      clens: None,
      mtime: None,
      placeholder: false,
    }
    run_store(() => index.save_entry(merged))
    return merged
  }

  let target = self.resolve_path(path)
  // 先把远端内容写进 tmp 并终验:校验不过时本地文件保持不动,避免本地被 rename
  // 成冲突副本后原路径变空、下一轮扫描产生墓碑并传播删除。
  let tmp = land_to_tmp(target, remote.blocks, content)
  // 校验通过后才动本地文件:本地内容保留为冲突副本,绝不静默丢弃
  let exists = @fs.exists(target) catch { _ => false }
  if exists {
    let copy_name = self.conflict_copy_name(path, remote_device_id)
    let copy_abs = self.resolve_conflict_copy_path(copy_name)
    @fs.rename(target, copy_abs)
  }
  // 版本快照在本地文件已让路后自然空转(与 Rust finalize 的顺序一致)
  self.snapshot_version(path)
  self.prune_versions(path)
  @fs.rename(tmp, target)
  let mtime = match mtime_ms(target) {
    Some(t) => t
    None => now_ms()
  }
  // 索引记录合并版本(双方修改都保留),并写入落地后的 mtime
  let landed : Entry = {
    path,
    version: @core.merge_versions(local_entry.version, remote.version),
    size: remote.size,
    deleted: false,
    blocks: remote.blocks,
    cdh: remote.cdh,
    clens: remote.clens,
    mtime: Some(mtime),
    placeholder: false,
  }
  run_store(() => index.save_entry(landed))
  landed
}

///|
/// 冲突自动策略 local-wins / newest-wins:磁盘一字不动,只把合并后的版本向量
/// 写进索引。合并结果支配双方,对端下一轮会判「本地较新」并主动来拉,收敛由协议完成。
pub fn LocalExecutor::apply_conflict_keep_local(
  _ : LocalExecutor,
  index : IndexStore,
  local_entry : Entry,
  remote : Entry,
) -> Entry raise ExecutorError {
  let keep : Entry = {
    path: local_entry.path,
    version: @core.merge_versions(local_entry.version, remote.version),
    size: local_entry.size,
    deleted: local_entry.deleted,
    blocks: local_entry.blocks,
    cdh: local_entry.cdh,
    clens: local_entry.clens,
    mtime: local_entry.mtime,
    placeholder: local_entry.placeholder,
  }
  run_store(() => index.save_entry(keep))
  keep
}

///|
/// 按需同步:只写索引库(带块哈希的占位条目),文件系统一字不动。
pub fn LocalExecutor::apply_placeholder(
  _ : LocalExecutor,
  index : IndexStore,
  entry : Entry,
) -> Unit raise ExecutorError {
  let stored : Entry = {
    path: entry.path,
    version: entry.version,
    size: entry.size,
    deleted: entry.deleted,
    blocks: entry.blocks,
    cdh: entry.cdh,
    clens: entry.clens,
    mtime: None,
    placeholder: true,
  }
  run_store(() => index.save_entry(stored))
}

///|
/// 发送前(重新)计算条目:流式算定长块与 CDC 视图,版本向量 +1。
pub async fn LocalExecutor::apply_send(
  self : LocalExecutor,
  index : IndexStore,
  path : String,
  device_id : String,
) -> Entry {
  let target = self.resolve_path(path)
  let kind = @fs.kind(target) catch { _ => @fs.FileKind::Unknown }
  if !(kind is Regular) {
    raise FileNotFound(path)
  }
  // 流式算视图:定长块与 CDC 块一次读盘一起扫出来。不再整读 —— 整读把整个文件
  // 搬进内存,这是 Node 侧 `hashFileViews` 的分界点。
  let views = hash_file_views(target)
  let previous = run_store(() => index.get_entry(path))
  let mtime = mtime_ms(target)
  let previous_version : Map[String, Int64] = match previous {
    Some(e) => e.version
    None => Map([])
  }
  let updated : Entry = {
    path,
    version: @core.increment_version(previous_version, device_id),
    size: views.size,
    deleted: false,
    blocks: views.blocks,
    // 空文件没有块可言:cdh/clens 留空,与「无 CDC 视图」同口径
    cdh: if views.cdh.length() == 0 {
      None
    } else {
      Some(views.cdh)
    },
    clens: if views.clens.length() == 0 {
      None
    } else {
      Some(views.clens)
    },
    mtime,
    placeholder: false,
  }
  run_store(() => index.save_entry(updated))
  updated
}

///|
/// 接收对端文件前的冷启动保护:本机盘上已有同名文件、但本机索引尚未记录该路径
/// (目录刚加入 / daemon 刚启动、首扫未跑即遭「热」对端推送)时,把本机原文件
/// 保留为 `.sync-conflict-<ts>-<remoteDeviceId>` 副本,让出原路径给对端版本落地。
///
/// 返回 true = 已保留副本(原路径已让出)。**路径不安全时抛错,由调用方兜底成
/// 「不保护、照常覆盖」** —— 保护只是防丢数据的增强,不该阻断接收。
pub async fn LocalExecutor::preserve_local_as_conflict(
  self : LocalExecutor,
  path : String,
  remote_device_id : String,
) -> Bool {
  let target = self.resolve_path(path)
  let kind = @fs.kind(target) catch { _ => @fs.FileKind::Unknown }
  if !(kind is Regular) {
    return false
  }
  let copy_name = self.conflict_copy_name(path, remote_device_id)
  let copy_abs = self.resolve_conflict_copy_path(copy_name)
  @fs.rename(target, copy_abs)
  true
}

///|
/// 冲突副本文件名:`<base>.sync-conflict-<ts36>[-<seq36>]-<deviceId><ext>`,
/// 同一毫秒多次冲突靠序号避碰;命名可被 core 的 CONFLICT_COPY_PATTERN 反解。
async fn LocalExecutor::conflict_copy_name(
  self : LocalExecutor,
  path : String,
  remote_device_id : String,
) -> String {
  let ext = split_ext(path)
  let ts = base36(now_ms())
  let mut n = 0L
  let mut candidate = ""
  while true {
    let seq = if n > 0L { "-\{base36(n)}" } else { "" }
    candidate = "\{ext.0}.sync-conflict-\{ts}\{seq}-\{remote_device_id}\{ext.1}"
    let occupied = try {
      let abs = self.resolve_conflict_copy_path(candidate)
      @fs.exists(abs)
    } catch {
      _ => false // 占用探测自身出错按未占用处理
    }
    // 序号到 1000 强制返回,防止死循环
    if n >= 1000L || !occupied {
      break
    }
    n += 1L
  }
  candidate
}

///|
/// 把待删除文件移入回收站(共享目录之外),保留原相对路径结构。
/// 同文件系统走 rename(瞬时、原子);跨文件系统或文件被占用时退化为拷贝后删 ——
/// 绝不静默丢弃。
async fn LocalExecutor::move_to_trash(
  self : LocalExecutor,
  rel_path : String,
) -> Unit {
  let target = resolve_share_path(self.root, rel_path, false)
  let kind = @fs.kind(target) catch { _ => @fs.FileKind::Unknown }
  if !(kind is Regular) {
    return // 已经不在了:删除照样要写墓碑
  }
  ensure_dir(self.trash_dir)
  let stamp = base36(now_ms())
  let mut dest = "\{self.trash_dir}/\{rel_path}.\{stamp}"
  let mut n = 0
  while true {
    let occupied = @fs.exists(dest) catch { _ => false }
    if !occupied {
      break
    }
    n += 1
    dest = "\{self.trash_dir}/\{rel_path}.\{stamp}.\{n}"
  }
  ensure_parent(dest)
  let renamed = try {
    @fs.rename(target, dest)
    true
  } catch {
    _ => false
  }
  if !renamed {
    // 跨文件系统 / 被占用:拷贝后删,失败如实上抛
    copy_file(target, dest)
    @fs.remove(target) catch {
      e => raise Io("\{rel_path}: \{e}")
    }
  }
}

///|
/// 覆盖本机现存文件前把旧内容快照进版本目录。快照绝不能让原文件消失:
/// rename 失败退化为拷贝,原文件保持原样随后照常被覆盖。
async fn LocalExecutor::snapshot_version(
  self : LocalExecutor,
  rel_path : String,
) -> Unit {
  let versions_dir = match self.versions_dir {
    Some(d) => d
    None => return
  }
  let target = resolve_share_path(self.root, rel_path, false)
  let kind = @fs.kind(target) catch { _ => @fs.FileKind::Unknown }
  if !(kind is Regular) {
    return
  }
  ensure_dir(versions_dir)
  let stamp = base36(now_ms())
  let mut dest = "\{versions_dir}/\{rel_path}.syncx-v-\{stamp}"
  let mut n = 0
  while true {
    let occupied = @fs.exists(dest) catch { _ => false }
    if !occupied {
      break
    }
    n += 1
    dest = "\{versions_dir}/\{rel_path}.syncx-v-\{stamp}.\{n}"
  }
  ensure_parent(dest)
  let renamed = try {
    @fs.rename(target, dest)
    true
  } catch {
    _ => false
  }
  if !renamed {
    copy_file(target, dest)
  }
}

///|
/// 同一路径的版本超过上限时删最旧。
///
/// 按文件名排序近似按时间排序 —— stamp 是单调递增的 base36 时间戳,同一路径下
/// 字典序即时间序。版本文件保留了原相对路径的目录结构,所以必须在「relPath 的
/// 父目录」里按 basename 前缀筛 —— 只扫顶层会漏掉所有嵌套路径,上限对它们失效
/// (无界增长)。
async fn LocalExecutor::prune_versions(
  self : LocalExecutor,
  rel_path : String,
) -> Unit {
  let versions_dir = match self.versions_dir {
    Some(d) => d
    None => return
  }
  // relPath 拆成父目录 + basename
  let chars = rel_path.to_array()
  let mut slash = -1
  for i in 0..<chars.length() {
    if chars[i] == '/' {
      slash = i
    }
  }
  let (dir_rel, name) = if slash < 0 {
    ("", rel_path)
  } else {
    (
      rel_path[0:slash].to_owned(),
      rel_path[slash + 1:rel_path.length()].to_owned(),
    )
  }
  let dir = if dir_rel == "" {
    versions_dir
  } else {
    "\{versions_dir}/\{dir_rel}"
  }
  let prefix = "\{name}.syncx-v-"
  let names = @fs.readdir(dir) catch {
    _ => return // 版本目录还没建等异常:修剪是 best-effort
  }
  let matched : Array[String] = []
  for n in names {
    if n.has_prefix(prefix) {
      matched.push(n)
    }
  }
  if matched.length() <= self.versions_per_path {
    return
  }
  matched.sort()
  let remove_count = matched.length() - self.versions_per_path
  for i in 0..<remove_count {
    // 单个失败留给下次快照再试
    @fs.remove("\{dir}/\{matched[i]}") catch {
      _ => ()
    }
  }
}

// ==================== 路径与文件工具 ====================

///|
/// 解析共享目录内的相对路径,做符号链接越界校验与硬忽略闸门。
///
/// `allow_hard_ignored` 仅供冲突处理链路使用(副本本身就是硬忽略对象);
/// 符号链接越界守卫**不受该选项影响**,永远生效。协议路径一律 `/` 分隔,但
/// Windows 调用方可能传来 `\` —— 两种都要切分。
pub async fn resolve_share_path(
  root : String,
  rel_path : String,
  allow_hard_ignored : Bool,
) -> String raise ExecutorError {
  if !allow_hard_ignored && @core.is_hard_ignored(rel_path) {
    raise HardIgnored(rel_path)
  }
  // 词法归一,拒绝越过根的 `..`
  let parts : Array[String] = []
  let current = StringBuilder()
  for c in rel_path {
    if c == '/' || c == '\\' {
      parts.push(current.to_string())
      current.reset()
    } else {
      current.write_char(c)
    }
  }
  parts.push(current.to_string())
  let cleaned : Array[String] = []
  for segment in parts {
    if segment == "" || segment == "." {
      continue
    }
    if segment == ".." {
      if cleaned.length() == 0 {
        raise UnsafePath(rel_path)
      }
      let _ = cleaned.remove(cleaned.length() - 1)
      continue
    }
    cleaned.push(segment)
  }
  let abs = if cleaned.length() == 0 {
    root
  } else {
    join_paths(root, cleaned.join("/"))
  }
  // 根目录可能不存在(刚配置尚未创建 / 运行中被删除):此时任何候选段也不可能存在
  // (祖先链断了),越界检查自然跳过;根恢复后恢复完整校验。
  let root_real = @fs.realpath(root) catch { _ => return abs }
  let mut ancestor = root
  for part in cleaned {
    ancestor = join_paths(ancestor, part)
    let exists = @fs.exists(ancestor) catch { _ => false }
    if !exists {
      continue
    }
    let resolved = @fs.realpath(ancestor) catch { _ => continue }
    if !within_root(resolved, root_real) {
      raise UnsafePath(rel_path)
    }
  }
  abs
}

///|
/// resolved 是否仍在 root_real 之内(含相等;root_real 为 `/` 时一切绝对路径都在内,
/// 与 Rust `Path::starts_with` 的按段语义一致)。
fn within_root(resolved : String, root_real : String) -> Bool {
  if resolved == root_real {
    return true
  }
  if root_real == "/" {
    return true
  }
  resolved.has_prefix("\{root_real}/")
}

///|
/// root + "/" + rel(容忍 root 末尾已带分隔符)。
fn join_paths(root : String, rel : String) -> String {
  if root.has_suffix("/") {
    "\{root}\{rel}"
  } else {
    "\{root}/\{rel}"
  }
}

///|
/// 写入 tmp 并做块哈希终验。成功返回 tmp 路径(由调用方 rename 换入);
/// 失败清理 tmp 后抛错,目标文件一字未动。
async fn land_to_tmp(
  target : String,
  expected_blocks : Array[String],
  content : Bytes,
) -> String {
  ensure_parent(target)
  let tmp = "\{target}.syncx-tmp"
  // fsync 后才允许 rename:字节没刷盘就换入,崩溃后是一份看似完整的坏文件
  @fs.write_file(tmp, content, create_mode=CreateOrTruncate, sync=Full)
  // 位图/长度说齐了还要盘上内容真对得上:块哈希对不上整份作废,绝不带病换入
  if !blocks_match_on_disk(tmp, expected_blocks) {
    @fs.remove(tmp) catch {
      _ => ()
    }
    raise ContentMismatch(target)
  }
  tmp
}

///|
/// 递归确保目录存在(并发创建失败后复查,容忍别的进程先建好)。
async fn ensure_dir(dir : String) -> Unit {
  let exists = @fs.exists(dir) catch { _ => false }
  if exists {
    return
  }
  let created = try {
    @fs.mkdir(dir, recursive=true, allow_exist=true)
    true
  } catch {
    _ => false
  }
  if !created {
    // 并发场景下可能有其它进程/测试同时创建,失败后复查
    let recheck = @fs.exists(dir) catch { _ => false }
    if !recheck {
      abort("创建目录失败: \{dir}")
    }
  }
}

///|
/// 确保父目录存在(无分隔符则不动)。
async fn ensure_parent(path : String) -> Unit {
  let chars = path.to_array()
  let mut slash = -1
  for i in 0..<chars.length() {
    if chars[i] == '/' {
      slash = i
    }
  }
  if slash <= 0 {
    return
  }
  ensure_dir(path[0:slash].to_owned())
}

///|
/// 拷贝文件(回收站/版本目录跨文件系统时的退化路径)。
async fn copy_file(src : String, dest : String) -> Unit {
  let data = @fs.read_file(src) catch {
    e => raise Io("读取 \{src} 失败: \{e}")
  }
  ensure_parent(dest)
  @fs.write_file(dest, data, create_mode=CreateOrTruncate) catch {
    e => raise Io("写入 \{dest} 失败: \{e}")
  }
}

///|
/// 流式计算一份文件的定长块与 CDC 视图(内存峰值 = 一个窗口)。
pub async fn hash_file_views(path : String) -> @core.FileViews {
  let file = @fs.open(path, mode=ReadOnly) catch {
    e => raise Io("打开 \{path} 失败: \{e}")
  }
  defer file.close()
  let hasher = @core.ViewHasher::new()
  // 64 KiB 窗口:ViewHasher 内部按 1 MiB 收拢定长块,窗口边界跨段喂入不影响结果
  let buf : FixedArray[Byte] = FixedArray::make(64 * 1024, b'\x00')
  while true {
    let n = file.read(buf)
    if n == 0 {
      break
    }
    hasher.push(Bytes::from_array(buf.exact_view(end=n)))
  }
  hasher.finish()
}

///|
/// Node `path.extname` 的等价实现:只看 basename 的最后一个点;点开头且无其它点
/// (`.gitignore`)则为空。返回 (base, ext),ext 含点。
pub fn split_ext(path : String) -> (String, String) {
  let chars = path.to_array()
  let mut name_start = 0
  for i in 0..<chars.length() {
    if chars[i] == '/' {
      name_start = i + 1
    }
  }
  let mut dot = -1
  for i in name_start..<chars.length() {
    if chars[i] == '.' {
      dot = i
    }
  }
  // 点即首字符且名字里没有别的点 → 无扩展名
  if dot < 0 || dot == name_start {
    return (path, "")
  }
  (path[0:dot].to_owned(), path[dot:path.length()].to_owned())
}

///|
/// base36 时间戳(与 Node 的 `Date.now().toString(36)` 同形态,仅用于文件名排序)。
pub fn base36(value : Int64) -> String {
  if value <= 0L {
    return "0"
  }
  let alphabet = "0123456789abcdefghijklmnopqrstuvwxyz".to_array()
  let digits : Array[Char] = []
  let mut v = value
  while v > 0L {
    digits.push(alphabet[(v % 36L).to_int()])
    v = v / 36L
  }
  let sb = StringBuilder()
  let mut i = digits.length() - 1
  while i >= 0 {
    sb.write_char(digits[i])
    i -= 1
  }
  sb.to_string()
}
