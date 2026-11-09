///|
/// 共享目录扫描(对应 Rust `syncx-daemon/src/scanner.rs`、Node `src/scanner.ts`)。
///
/// 这个模块的每一处「绕路」都是事故留下的疤,移植时**不能简化**:
///
///  1. **相对路径用字符串拼接,不用平台 API**。同步协议与索引一律 POSIX 分隔符,
///     Windows 上路径 API 产出 `\`。一旦把 `\` 路径当成索引 key,就会出现
///     「索引里有 `utils/x.mbt`、扫描却得到 `utils\x.mbt`」的错配:每个子目录文件
///     既进 changed(误报修改)又被判为「索引有、盘上无」→ 生成墓碑广播给对端,
///     把对端整棵子目录删掉(2026-09-15 端 251 个文件被误删的根因)。
///  2. **根目录不存在时不做墓碑推断**。盘符卸载 / 权限丢失 / 未挂载时,整棵索引会
///     被当成「已删除」,一次扫描就能把对端数据删空。
///  3. **占位条目永不生成墓碑**。盘上本就没有实体文件,那不是「本地删除」——生成
///     墓碑会把对端的真文件删进回收站(数据丢失级)。
///  4. **硬忽略路径绝不生成墓碑**。墓碑会把「对端也有这份内容」变成对端的一次真实
///     删除,伤疤会传染。
///  5. **嵌套共享根**内的条目既不重扫也不墓碑,交由那个共享自己管理。
///
/// 与 Rust 版的一处刻意偏差:walk 阶段的忽略判定采用 Node 的 `isIgnoredPath`
/// 口径(硬忽略闸门 + 用户规则,见下方 walk 内注释),Rust 的 walk 只判用户规则、
/// 让冲突副本落进 changed;这里按 Rust 源码注释声明的意图(「它们不参与
/// 同步/索引/墓碑」)与 Node 行为对齐。

///|
/// 扫描免哈希快速路径的容忍窗口(毫秒)。
///
/// FAT32 的 mtime 精度是 2 秒,不设容忍就会把「刚写完、时间戳只差几百毫秒」的
/// 文件判成改动。与 Node `MTIME_TOLERANCE_MS`、Rust `MTIME_TOLERANCE_MS`
/// **必须一致** —— 两边判据不同,同一条目在一端「未改动」在另一端「已改动」,
/// 同步轮次会因此对不上。
pub const MTIME_TOLERANCE_MS : Int64 = 2000L

///|
/// 在途中间态的保鲜期(与 Rust `PARTIAL_TTL_MS` 同值):超过它就整对回收。
/// 取 7 天:比任何合理的断线时长都长,又足够短,不至于把盘占死。
pub const PARTIAL_TTL_MS : Int64 = 7L * 24L * 3600L * 1000L

///|
/// 盘上这份文件是否与条目「未改动」。
///
/// 与 Node `isUnchanged` / Rust `StoredEntry::is_unchanged` 逐条对齐:尺寸必须
/// 相等;`mtime` 缺失一律视为**可能已改**(没有时间戳就没有免哈希的依据);
/// mtime **完全一致**才算未改。曾经的「差在容忍窗口内即免检」会把窗口内的
/// 真实改动永久吞掉 —— 扫描落在一次写入完成前(读到中间态且 size 恰好一致)
/// 之后,每轮 |mtime 差| 都只有几十 ms,条目再也不重哈希,本机索引永远宣告
/// 旧哈希,对端索块被哈希闸门拒收,传输死锁(2026-11-09 MoonUI 两文件实测)。
/// 窗口内的抖动(FAT32 粒度、touch、写入竞态)现在落到调用方的「内容哈希对比
/// + 写回新 mtime」路径 —— 一次整文件哈希后 diff 归零,不会每轮重复付。
pub fn Entry::is_unchanged(
  self : Entry,
  size : Int64,
  mtime_ms : Int64,
) -> Bool {
  if size != self.size {
    return false
  }
  match self.mtime {
    None => false
    Some(prev) => mtime_ms == prev
  }
}

///|
/// 墓碑条目:版本向量 +1、内容清空。CDC 视图一并清掉,留着只会白白撑大索引
/// 与线路。
pub fn tombstone_of(entry : Entry, device_id : String) -> Entry {
  {
    path: entry.path,
    version: @core.increment_version(entry.version, device_id),
    size: 0L,
    deleted: true,
    blocks: [],
    cdh: None,
    clens: None,
    mtime: None,
    placeholder: false,
  }
}

///|
/// 扫描结果。字段语义与 Node 的 `ScanDiff` / Rust 的 `ScanDiff` 一一对应。
pub(all) struct ScanDiff {
  /// 新增或内容变化的相对路径(需重新索引并发送)
  changed : Array[String]
  /// 本地已删除文件的墓碑条目(需传播)
  tombstones : Array[Entry]
  /// 本轮实际看到的文件数(已排除忽略/硬忽略/临时件,不含嵌套共享根内的文件)。
  ///
  /// 供上层做结构性守卫:无法校验目录身份时,「一个文件都没看到、却要删东西」
  /// 是目录未挂载或被换掉的典型形态,此时必须拒绝执行这批删除。
  files_seen : Int32
  /// 盘上残留的冲突副本数(硬忽略、不进索引,但目录卡徽标要报数)
  conflict_count : Int32
}

///|
fn empty_diff() -> ScanDiff {
  { changed: [], tombstones: [], files_seen: 0, conflict_count: 0, }
}

///|
/// 相对路径一律由「父级相对目录 + 文件名」以 `/` 拼接(见模块注释第 1 条)。
fn rel_of(rel_dir : String, name : String) -> String {
  if rel_dir == "" {
    name
  } else {
    "\{rel_dir}/\{name}"
  }
}

///|
/// 拼接绝对路径:根末尾已带分隔符时不重复。
fn join_path(base : String, rel : String) -> String {
  if rel == "" {
    base
  } else if base.has_suffix("/") {
    "\{base}\{rel}"
  } else {
    "\{base}/\{rel}"
  }
}

///|
/// 词法归一路径:不解析符号链接(与 Node 的 `resolve` 同语义),但要去掉
/// `.` / `..`。归一结果统一以 `/` 分隔,供嵌套共享根比对。
pub fn normalize_path(path : String) -> String {
  let absolute = path.has_prefix("/")
  let parts : Array[String] = []
  for seg in path.split("/") {
    if seg == "" || seg == "." {
      continue
    }
    if seg == ".." {
      // 与 Rust 版同口径:弹不出去(已在根上)时直接丢弃该段
      if parts.length() > 0 {
        let _ = parts.remove(parts.length() - 1)
      }
      continue
    }
    parts.push(seg.to_owned())
  }
  let joined = parts.join("/")
  if absolute {
    "/\{joined}"
  } else if joined == "" {
    "."
  } else {
    joined
  }
}

///|
/// 取文件的 mtime(毫秒);不存在 / 拿不到时间戳返回 None。
pub async fn mtime_ms(path : String) -> Int64? {
  try {
    let (sec, ns) = @fs.mtime(path)
    Some(sec * 1000L + ns.to_int64() / 1000000L)
  } catch {
    _ => None
  }
}

///|
/// 当前毫秒时间戳(与 Node `Date.now()` / Rust `now_ms` 同口径)。
pub fn now_ms() -> Int64 {
  @async.now()
}

///|
/// 逐块比对盘上内容与索引里的定长块哈希,**首处不符立刻返回**。
///
/// 扫描每轮对每个已索引文件都要问一次「内容变了没」,既不该整读、也不该把后面
/// 的块读完。长度或任一块哈希对不上即 false。空哈希列表直接通过(空文件)。
pub async fn blocks_match_on_disk(
  abs : String,
  expected : Array[String],
) -> Bool {
  if expected.length() == 0 {
    return true
  }
  let file = @fs.open(abs, mode=ReadOnly) catch { _ => return false }
  defer file.close()
  let window : FixedArray[Byte] = FixedArray::make(@core.BLOCK_SIZE, b'\x00')
  let mut count = 0
  let mut eof = false
  while !eof {
    // 必须循环读满:单次短读是 POSIX 允许的正常返回,拿半截窗口去验哈希会把
    // **写对了的块**误判成不符。
    let mut filled = 0
    while filled < window.length() {
      let n = file.read(window, offset=filled, max_len=window.length() - filled)
      if n <= 0 {
        eof = true
        break
      }
      filled += n
    }
    if filled == 0 {
      break // 盘上比索引短:交给下面的长度判断
    }
    if count >= expected.length() {
      return false // 盘上比索引长
    }
    let slice = Bytes::from_array(window.exact_view(end=filled))
    if @core.hash_block(slice) != expected[count] {
      return false
    }
    count += 1
  }
  count == expected.length()
}

///|
/// 扫描一个共享目录树,与索引对比,产出需要重新索引/发送的路径与墓碑。
///
/// `nested_roots` 是其它共享目录的归一化绝对根:本树中命中其中任一条的子目录视为
/// 「嵌套共享根」,既不递归进去索引、也不为其中文件产生墓碑 —— 否则同一批文件会被
/// 两个共享重复扫描/同步,跳过后又会误把对方已同步的文件墓碑删除。
pub async fn scan_folder(
  root : String,
  index : IndexStore,
  rules : @core.IgnoreRuleset,
  device_id : String,
  nested_roots : Array[String],
) -> ScanDiff {
  // 根目录不存在 / 不是目录:不做任何墓碑推断(见模块注释第 2 条)
  let root_kind = @fs.kind(root) catch { _ => @fs.FileKind::Unknown }
  if !(root_kind is Directory) {
    return empty_diff()
  }
  // 一次性把索引装进内存:每轮扫描都要对每个已索引文件问一次「改了没」,
  // 逐条查询会把「一次 SQLite 往返」放大到「一次每个文件」。
  let existing = index.list_entries()
  let by_path : Map[String, Entry] = Map([])
  for e in existing {
    by_path.set(e.path, e)
  }
  let resolved_nested : Array[String] = []
  for nr in nested_roots {
    resolved_nested.push(normalize_path(nr))
  }
  let changed : Array[String] = []
  let seen : Map[String, Bool] = Map([])
  let mut conflict_count = 0
  // 迭代式遍历(显式队列):MoonBit 的 async 函数不保证可递归,扫描树本来也
  // 不依赖遍历顺序(changed/tombstone 均与顺序无关)。
  let queue : Array[(String, String)] = [(root, "")]
  let mut cursor = 0
  while cursor < queue.length() {
    let (dir, rel_dir) = queue[cursor]
    cursor += 1
    let names = @fs.readdir(dir) catch {
      _ => [] // 目录已被删除
    }
    for name in names {
      let abs = join_path(dir, name)
      let rel = rel_of(rel_dir, name)
      // 不跟随符号链接:Rust 版 file_type() 同语义 —— 链接既不是目录也不是文件,
      // 直接跳过(链接目标由共享外的世界负责)。
      let kind = @fs.kind(abs, follow_symlink=false) catch {
        _ => @fs.FileKind::Unknown
      }
      match kind {
        Directory => {
          // 嵌套共享根:本目录树(父/外层)不递归进去,其中文件交由那个共享自己同步
          let abs_norm = normalize_path(abs)
          let mut nested = false
          for nr in resolved_nested {
            if nr == abs_norm {
              nested = true
              break
            }
          }
          if nested {
            continue
          }
          if @core.is_hard_ignored(rel) || rules.is_ignored(rel, true) {
            continue
          }
          queue.push((abs, rel))
        }
        Regular => {
          // 接收中间态(在途 tmp + 位图 sidecar):不参与索引/宣告,顺带回收过期残骸。
          // 非中间态的目录项不付这个 stat —— 回收函数自己按后缀短路。
          if @core.is_scratch_segment(name) {
            let _ = prune_scratch_file(dir, name)
            continue
          }
          // 冲突副本被硬忽略跳过,但先计数供目录卡徽标(它们不参与同步/索引/墓碑)
          if @core.is_conflict_copy_name(name) {
            conflict_count += 1
          }
          if @core.is_hard_ignored(rel) || rules.is_ignored(rel, false) {
            continue
          }
          seen.set(rel, true)
          if is_changed(index, by_path, rel, abs) {
            changed.push(rel)
          }
        }
        _ => continue // 符号链接 / 套接字 / 管道等一律不碰
      }
    }
  }
  // 索引中有、本地文件已不存在的非墓碑条目 → 墓碑
  let tombstones : Array[Entry] = []
  let root_norm = normalize_path(root)
  let root_prefix = if root_norm == "/" { "/" } else { "\{root_norm}/" }
  for entry in existing {
    if entry.deleted || seen.contains(entry.path) {
      continue
    }
    // 占位条目:盘上本就没有实体(见模块注释第 3 条)
    if entry.placeholder {
      continue
    }
    // 硬忽略路径绝不生成墓碑(第 4 条)
    if @core.is_hard_ignored(entry.path) {
      continue
    }
    // 用户级忽略规则命中的条目同样不生成墓碑:本机不再扫描它,也就无从判断它是否
    // 真的被删除;而墓碑会让对端执行真实删除。
    if rules.is_ignored(entry.path, false) {
      continue
    }
    // 嵌套共享根内的既有条目:本次扫描既不重扫也不墓碑(第 5 条)。
    // 仅当被保护的根是当前扫描根的**后代**时才跳过 —— 若它是当前根的祖先/同级,
    // 该根自己的删除必须由它自己的扫描负责,在这里按前缀命中会吞掉整棵子树的删除。
    let abs_entry = normalize_path(join_path(root, entry.path))
    let mut nested_hit = false
    for nr in resolved_nested {
      if nr == root_norm {
        continue
      }
      if !nr.has_prefix(root_prefix) {
        continue
      }
      if abs_entry == nr || abs_entry.has_prefix("\{nr}/") {
        nested_hit = true
        break
      }
    }
    if nested_hit {
      continue
    }
    tombstones.push(tombstone_of(entry, device_id))
  }
  { changed, tombstones, files_seen: seen.length(), conflict_count, }
}

///|
/// 该文件相对索引是否「已改动」。免哈希快速路径与内容哈希回退的分支顺序必须与
/// Node 的 `walk` / Rust 的 `is_changed` 完全一致 —— 顺序反了会把「仅 mtime 变化」
/// 当成内容变化,每轮扫描都产生一次无意义的外推。
async fn is_changed(
  index : IndexStore,
  by_path : Map[String, Entry],
  rel : String,
  abs : String,
) -> Bool {
  let prev = match by_path.get(rel) {
    Some(e) => e
    None => return true // 索引里没有 → 新文件
  }
  if prev.deleted {
    return true // 墓碑之后又出现了同名文件
  }
  let size = @fs.file_size(abs) catch {
    _ => return false // 文件在扫描途中被删:本轮跳过,下一轮按墓碑处理
  }
  let mtime = match mtime_ms(abs) {
    Some(t) => t
    None => return true // 拿不到时间戳就没有免哈希依据
  }
  // 免哈希快速路径:大小与 mtime 完全一致才视为未改动;容忍窗口内的 mtime
  // 抖动落到下面的内容哈希确认(FAT32 粒度、写入竞态都只付一次哈希)
  if prev.is_unchanged(size, mtime) {
    return false
  }
  // 大小相同但 mtime 变化(或旧数据无 mtime)才做内容哈希对比
  if size == prev.size && blocks_match_on_disk(abs, prev.blocks) {
    // 内容未变仅 mtime 变化:写回新 mtime,把 diff 归零 —— 否则容忍窗口内的
    // 抖动会每轮重复整文件哈希。mtime 不在同步协议内,不递增版本、不触发广播。
    match prev.mtime {
      None => save_mtime(index, prev, mtime)
      Some(old) => if mtime != old { save_mtime(index, prev, mtime) }
    }
    return false
  }
  true
}

///|
/// 把仅 mtime 变化的条目写回索引(失败忽略:下一轮扫描会再试)。
fn save_mtime(index : IndexStore, prev : Entry, mtime : Int64) -> Unit {
  let updated : Entry = {
    path: prev.path,
    version: prev.version,
    size: prev.size,
    deleted: prev.deleted,
    blocks: prev.blocks,
    cdh: prev.cdh,
    clens: prev.clens,
    mtime: Some(mtime),
    placeholder: prev.placeholder,
  }
  index.save_entry(updated) catch {
    _ => ()
  }
}

///|
/// 扫描器遍历到中间态文件时顺手做的回收:超期就删掉**整对**(tmp 与 sidecar
/// 同进同出)。判据用 tmp 自己的 mtime:在途接收每落一块 mtime 就更新一次,
/// 7 天不动 = 确实没人续它;而「没有 sidecar 的孤儿 tmp」连 `updatedAt` 都没有,
/// 却正是最需要回收的那种残骸。
///
/// 删不掉(被别的管线攥着 / 已消失)不报错:留到下一轮扫描再试。
pub async fn prune_scratch_file(
  dir_abs : String,
  name : String,
  now~ : Int64 = now_ms(),
) -> Bool {
  let lower = name.to_lower()
  let suffixes = @core.scratch_suffixes()
  let mut suffix = ""
  for s in suffixes {
    if lower.has_suffix(s) {
      suffix = s
      break
    }
  }
  if suffix == "" {
    return false
  }
  let abs = join_path(dir_abs, name)
  let mtime = match mtime_ms(abs) {
    Some(t) => t
    None => return false // 扫描途中它已经消失
  }
  if now - mtime <= PARTIAL_TTL_MS {
    return false
  }
  // 去掉后缀得到目标文件本体:tmp 与它的 sidecar 一起回收,不留半对
  let target_name = name[0:name.length() - suffix.length()].to_owned()
  let sidecar = "\{join_path(dir_abs, target_name)}\{partial_suffix()}"
  @fs.remove(abs) catch {
    _ => ()
  }
  @fs.remove(sidecar) catch {
    _ => ()
  }
  match (@fs.exists(abs) catch { _ => true }) {
    false => true
    true => false
  }
}

///|
/// 在途位图 sidecar 的后缀(与 `.syncx-tmp` 成对,见 Rust `PARTIAL_SUFFIX`)。
fn partial_suffix() -> String {
  ".syncx-partial"
}
