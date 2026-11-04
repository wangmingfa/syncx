///|
/// 空目录盘点与清理(目录卡「空文件夹」工具)—— 对 Node `src/empty-dirs.ts`
/// 的逐条移植,六个语义点与四条删除安全不变式逐字对齐:
///
///  1. 空 = 子树里**物理上没有任何文件**;文件计内容,符号链接/其它特殊条目也计
///     内容(删除侧绝不 remove 它们,列出来就成了「列出但删不掉」的谎)。
///  2. 忽略规则只决定**报告范围**:被忽略的目录自己不列出(不同步的东西不提示
///     清理),但被忽略目录里的文件照旧算它父级的内容 —— 仅装着 node_modules 的
///     目录不可报告为空(反向对照),否则删除侧会去删一个塞满东西的目录。
///  3. 嵌套共享根是**屏障**:属于别的共享目录的地盘,既不进入、也不列出,且一律
///     计为内容(它的清理归那个共享自己管)。
///  4. 共享根自身永不列出(根为空属于「移除目录」流程的语义)。
///  5. 单次盘点封顶 EMPTY_DIRS_MAX 条,超出置 truncated;结果字典序。
///  6. 删除安全不变式:只 rmdir、从不 unlink(有文件的目录只会失败);每条路径先
///     过 resolve_folder_subpath(目录穿越/软链逃逸闸,对齐 Node resolveFolderSubpath)
///     与嵌套根判定;扫描与删除之间目录可能被塞进东西 —— 删除前 verify_empty 复核、
///     rmdir 前逐层再看一遍,任何文件出现即中止该条并如实带原因。
///
/// 刻意**不触发扫描、不写索引**(目录不是同步实体,扫描器只对文件产生条目/墓碑,
/// 删掉空目录没有任何东西需要广播给对端)—— 与 Node session-manager 注释里同一
/// 个差异理由;版本/回收站端点的 trigger_folder_scan 在这里没有对应物。
///
/// 两个函数对「空」的判据同源:文件/软链等非目录条目、嵌套根、读不动的目录一律
/// 算内容(见 read_dir_tri 与 nested_contains 两个共享原语)。

///|
/// 单次盘点的空目录条数上限:弹窗是给人看的,几千条之外先给数字不给列表。
pub const EMPTY_DIRS_MAX : Int = 2000

///|
/// 盘点结果:空目录(相对共享根的 POSIX 路径)字典序 + 截断标记。
pub(all) struct EmptyDirScanResult {
  dirs : Array[String]
  truncated : Bool
}

///|
/// 删除单条路径的结果;ok=false 时 reason 直接展示给用户解释为什么没删。
pub(all) struct EmptyDirDeleteResult {
  path : String
  ok : Bool
  /// None = 无需解释(删除成功 / 幂等成功);Some = 人能看懂的原因。
  reason : String?
}

///|
/// readdir 的三态(Node 侧以 `code === 'ENOENT'` 区分「刚被外部删掉」与「真的
/// 读不动」,删除侧据此把前者当幂等成功)。
priv enum DirRead {
  Got(Array[String])
  /// ENOENT:目标刚被外部删掉。
  ReadMissing
  /// 其他错误(权限等):读不动。
  ReadFailed
}

///|
async fn read_dir_tri(dir : String) -> DirRead {
  let names = @fs.readdir(dir) catch { e => return read_error_tri(e) }
  Got(names)
}

///|
/// 把 fs 错误分流成「刚被外部删掉 / 读不动」。
fn read_error_tri(e : Error) -> DirRead {
  if is_enoent_error(e) {
    ReadMissing
  } else {
    ReadFailed
  }
}

///|
/// fs 错误是否 ENOENT(目标不存在)。moonbitlang/async 的 OSError 携带平台
/// errno,借官方 is_ENOENT 谓词判定(与 Node `e.code === 'ENOENT'` 同口径)。
fn is_enoent_error(e : Error) -> Bool {
  match e {
    @os_error.OSError(errno, ..) =>
      @os_error.OSError::is_ENOENT(@os_error.OSError(errno, context=""))
    _ => false
  }
}

///|
/// 把其它共享根的路径整理成「严格含于 root_abs 之内」的比较集合,供嵌套屏障判定。
/// 两级形式都收:字面归一形式(与配置一致)与 realpath 形式(配置路径经软链时也
/// 能对上真实位置);共享根已不存在则只留字面形式(Node buildNestedSet 同款)。
///
/// 必须滤掉 root_abs 自己与**祖先/外层的**共享根:外层共享根本就把本目录整棵跳过,
/// 不约束本目录内部的删除 —— 不滤掉的话整个工具直接瘫痪(Node 同款防御)。
async fn build_nested_set(root_abs : String, nested_roots : Array[String]) -> Array[String] {
  let set : Array[String] = []
  for nr in nested_roots {
    let forms : Array[String] = [normalize_path(nr)]
    let real = @fs.realpath(nr) catch { _ => "" }
    if real != "" && real != forms[0] {
      forms.push(real)
    }
    for f in forms {
      if f != root_abs && f.has_prefix("\{root_abs}/") && !set.contains(f) {
        set.push(f)
      }
    }
  }
  set
}

///|
/// abs 是否命中嵌套共享根集合(两侧都按归一形式比较)。
fn nested_contains(nested : Array[String], abs : String) -> Bool {
  let target = normalize_path(abs)
  for nr in nested {
    if nr == target {
      return true
    }
  }
  false
}

///|
/// readdir 的容错封装:失败返回 None(调用方按「读不动 = 保守当有内容」处理)。
async fn read_dir_entries(dir : String) -> (Array[String], Bool) {
  let names = @fs.readdir(dir) catch { _ => return ([], true) }
  (names, false)
}

///|
/// 显式栈 DFS 的遍历帧(对齐 Node 递归 walk 的顺序与推送时机;async 函数不保证
/// 可递归,与扫描器同理由改写为显式栈)。
priv struct EmptyWalkFrame {
  abs : String
  rel : String
  /// 自身(或祖先)已被忽略规则命中:整棵不在同步范围,目录自身不报告。
  ignored : Bool
  names : Array[String]
  mut cursor : Int
  mut has_content : Bool
}

///|
/// 盘点共享目录里的空目录。只读、不起 git、不写任何东西、不触发扫描。
///
/// - `rules` 忽略规则(装配口径与扫描同源,见 read_folder_ignore_lines)。
/// - `nested_roots` 其它共享目录的根路径。严格含于本目录内的会作为屏障:
///   不进入、不列出、计为内容。
/// - `limit` 单次盘点的条数上限(默认 EMPTY_DIRS_MAX;超出置 truncated)。
pub async fn scan_empty_dirs(
  root : String,
  rules : @core.IgnoreRuleset,
  nested_roots : Array[String],
  limit~ : Int = EMPTY_DIRS_MAX,
) -> EmptyDirScanResult {
  let nested = build_nested_set(normalize_path(root), nested_roots)
  let dirs : Array[String] = []
  let mut truncated = false
  let stack : Array[EmptyWalkFrame] = []
  let (root_names, root_failed) = read_dir_entries(root)
  if !root_failed {
    // 根读不动(权限等):无法证明为空就不许被删,保守当有内容(Node 返回 true)
    stack.push({
      abs: root,
      rel: "",
      ignored: false,
      names: root_names,
      cursor: 0,
      has_content: false,
    })
  }
  while stack.length() > 0 {
    let frame = stack[stack.length() - 1]
    if frame.cursor >= frame.names.length() {
      // 帧收尾:向父级回报内容;空且自身未被忽略才列入(忽略规则只决定报告范围)
      let _ = stack.remove(stack.length() - 1)
      if stack.length() > 0 {
        let parent = stack[stack.length() - 1]
        if frame.has_content {
          parent.has_content = true
        } else if !frame.ignored {
          if dirs.length() < limit {
            dirs.push(frame.rel)
          } else {
            truncated = true
          }
        }
      }
      continue
    }
    let name = frame.names[frame.cursor]
    frame.cursor += 1
    let abs = join_path(frame.abs, name)
    let rel = rel_of(frame.rel, name)
    // lstat 口径:文件、符号链接、其它特殊条目一律算内容 —— 软链指向目录时也
    // 不是 Directory,不会递归进去、不会被列出(与 Node dirent / 扫描器一致);
    // 判定不了(Unknown)一律按「算内容」保守处理
    let kind = @fs.kind(abs, follow_symlink=false) catch { _ => @fs.FileKind::Unknown }
    if !(kind is Directory) {
      frame.has_content = true
      continue
    }
    if nested_contains(nested, abs) {
      // 别的共享目录的地盘:屏障,不进入、计内容
      frame.has_content = true
      continue
    }
    let ignored = frame.ignored || @core.is_hard_ignored(rel) || rules.is_ignored(rel, true)
    let (names, failed) = read_dir_entries(abs)
    stack.push({
      abs,
      rel,
      ignored,
      names,
      cursor: 0,
      // 读不动:无法证明为空 → 保守当有内容
      has_content: failed,
    })
  }
  dirs.sort_by(cmp_lexical)
  { dirs, truncated, }
}

///|
/// verify_empty 的三态:空 / 目录刚被外部删掉(幂等成功)/ 挡住了(带原因)。
priv enum EmptyProbe {
  Empty
  ProbeMissing
  Blocked(String)
}

///|
/// 复核用的栈帧。
priv struct ProbeFrame {
  abs : String
  names : Array[String]
  mut cursor : Int
}

///|
/// 删除前的复核:递归重走一遍,确认现在仍然没有任何文件、也没有嵌套共享根。
/// 扫描快照可能已经过时(用户在别的窗口往目录里放了东西之类),这一步是删除前的
/// 最后一道感知闸;真正的防删死闸在 rmdir_bottom_up(它连 rmdir 都会失败)。
async fn verify_empty(abs : String, nested : Array[String]) -> EmptyProbe {
  let names = match read_dir_tri(abs) {
    Got(names) => names
    // 目录刚被外部删掉 = 幂等成功(Node ENOENT 同语义)
    ReadMissing => return ProbeMissing
    ReadFailed => return Blocked("目录不可读,跳过")
  }
  let stack : Array[ProbeFrame] = [{ abs, names, cursor: 0 }]
  while stack.length() > 0 {
    let frame = stack[stack.length() - 1]
    if frame.cursor >= frame.names.length() {
      let _ = stack.remove(stack.length() - 1)
      continue
    }
    let name = frame.names[frame.cursor]
    frame.cursor += 1
    let child = join_path(frame.abs, name)
    let kind = @fs.kind(child, follow_symlink=false) catch { _ => @fs.FileKind::Unknown }
    if !(kind is Directory) {
      // 文件/软链等一切非目录条目:任何文件出现即中止该条
      return Blocked("目录内现在有文件,跳过")
    }
    if nested_contains(nested, child) {
      return Blocked("目录内还有其它共享目录,跳过")
    }
    match read_dir_tri(child) {
      Got(child_names) => stack.push({ abs: child, names: child_names, cursor: 0 })
      // 子层刚被外部删掉:整条按幂等成功(Node 把 ENOENT 一路上抛同语义)
      ReadMissing => return ProbeMissing
      ReadFailed => return Blocked("目录不可读,跳过")
    }
  }
  Empty
}

///|
/// 「删除时目录内容有变化」的统一中止原因(Node RMDIR_FILE 逐字)。
const RMDIR_FILE : String = "删除时目录内容有变化,未完成(未删除任何文件)"

///|
/// 自底向上删除一棵**只含目录**的树:先递归清子目录,子目录全清掉后 rmdir 自己。
/// 返回 None = 删净(或本来就没了);Some = 中止原因。
///
/// 任何一个非目录条目(文件/软链)都会让该条立刻失败 —— 只 rmdir、从不 unlink,
/// 「绝不删文件」由结构保证,不靠调用方守规矩。实现为「预序收集 + 逆序 rmdir」:
/// 收集阶段逐层 readdir 确认「确无文件」,此时尚未删除任何东西,比 Node 的递归版
/// 略保守(Node 中途失败可能已删掉更早处理的空兄弟目录;两版留下的中间态都只含
/// 本就为空的目录,无害,用户重扫再删一次即可)。
async fn rmdir_bottom_up(abs : String, nested : Array[String]) -> String? {
  let order : Array[String] = []
  match read_dir_tri(abs) {
    Got(names) => {
      let stack : Array[ProbeFrame] = [{ abs, names, cursor: 0 }]
      while stack.length() > 0 {
        let frame = stack[stack.length() - 1]
        if frame.cursor >= frame.names.length() {
          let _ = stack.remove(stack.length() - 1)
          continue
        }
        let name = frame.names[frame.cursor]
        frame.cursor += 1
        let child = join_path(frame.abs, name)
        let kind = @fs.kind(child, follow_symlink=false) catch {
          _ => @fs.FileKind::Unknown
        }
        if !(kind is Directory) {
          return Some(RMDIR_FILE)
        }
        if nested_contains(nested, child) {
          return Some("目录内出现其它共享目录,已中止")
        }
        match read_dir_tri(child) {
          Got(child_names) => {
            // 预序:父先于子入列,逆序 rmdir 即子先于父
            order.push(child)
            stack.push({ abs: child, names: child_names, cursor: 0 })
          }
          // 子层刚被外部删掉:视为已删,继续(Node ENOENT → null 同语义)
          ReadMissing => ()
          ReadFailed => return Some("目录不可读,跳过")
        }
      }
    }
    // 已经不在了 = 目标达成
    ReadMissing => return None
    ReadFailed => return Some("目录不可读,跳过")
  }
  // 逆序 rmdir 收集到的子目录;任何失败(ENOTEMPTY = 复核后有东西被放进来、
  // EACCES 等)都中止整条并如实说 —— 没删成不许装作删成了
  let mut i = order.length() - 1
  while i >= 0 {
    let dir = order[i]
    @fs.rmdir(dir) catch {
      e =>
        // ENOENT:已经不在了 = 目标达成(Node 同语义),继续上一条
        if !is_enoent_error(e) {
          return Some(RMDIR_FILE)
        }
    }
    i -= 1
  }
  // 最后 rmdir 自己(Node 递归版的收尾 rmdirSync(abs))
  @fs.rmdir(abs) catch {
    e =>
      if !is_enoent_error(e) {
        return Some(RMDIR_FILE)
      }
  }
  None
}

///|
/// resolve_folder_subpath 的四态:解析成功 / 路径不安全(Node PathUnsafeError
/// 文案)/ 已不存在(幂等成功)/ 不可达。
priv enum SubpathResolve {
  /// realpath(仍在共享根之内)。
  Found(String)
  /// PathUnsafeError 文案,原样作为删除结果的原因展示。
  Unsafe(String)
  /// ENOENT:路径(或其软链链路)已不存在。
  PathMissing
  /// 其他 realpath 失败(权限等)。
  PathUnreachable
}

///|
/// 把相对路径解析到共享根下的绝对路径,并做三级防越界(Node resolveFolderSubpath
/// 逐条对齐,文案逐字):
/// 1. 字面校验 —— 拒绝 NUL、反斜杠归一为正斜杠后不得以盘符/根开头;
/// 2. 归一校验 —— resolve 后必须仍落在根内(处理 ../ 等);
/// 3. 软链校验 —— realpath 后必须仍落在根的 realpath 内(处理目录内部软链指到外面)。
/// 返回根内 realpath;路径不存在按 ENOENT 交由调用方幂等处理。
async fn resolve_folder_subpath(root_real : String, rel : String) -> SubpathResolve {
  if rel.contains_char('\u{0}') {
    return Unsafe("路径包含非法字符")
  }
  // 反斜杠归一为正斜杠(Node replace(/\\/g, '/') 同口径)
  let normalized = StringBuilder()
  for c in rel {
    if c == '\\' {
      normalized.write_char('/')
    } else {
      normalized.write_char(c)
    }
  }
  let norm = normalized.to_string()
  let chars = norm.to_array()
  if norm.has_prefix("/") {
    return Unsafe("必须是共享目录内的相对路径")
  }
  if chars.length() >= 2 && chars[1] == ':' && is_ascii_alpha(chars[0]) {
    return Unsafe("必须是共享目录内的相对路径")
  }
  // 归一:resolve 后必须仍在根内(.. 弹出根由 normalize_path 钳到根上,再被
  // 包含检查拦下 —— 与 Node resolvePath 的钳制语义一致)
  let abs = if norm == "" || norm == "." {
    root_real
  } else {
    normalize_path("\{root_real}/\{norm}")
  }
  if abs != root_real && !abs.has_prefix("\{root_real}/") {
    return Unsafe("路径越出共享目录")
  }
  let real = @fs.realpath(abs) catch {
    e =>
      if is_enoent_error(e) {
        return PathMissing
      } else {
        return PathUnreachable
      }
  }
  if real != root_real && !real.has_prefix("\{root_real}/") {
    return Unsafe("路径经软链越出共享目录")
  }
  Found(real)
}

///|
fn is_ascii_alpha(c : Char) -> Bool {
  (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

///|
/// 删除若干空目录(弹窗里勾选的那批)。逐条独立处理并返回结果,不做整批原子 ——
/// 一条被拒不应连累其余条。
///
/// 每条路径的闸门顺序(任一不过即 ok:false 并带上人能看懂的原因):
///  1. resolve_folder_subpath:目录穿越 / 绝对路径 / 软链逃逸 → 拒(文案逐字);
///  2. 等于共享根本身 → 拒(根本为空属于「移除目录」的事);
///  3. 命中忽略规则/硬忽略 → 拒(已不在同步范围,扫描也不会列它);
///  4. 属于其它共享根 → 拒;
///  5. verify_empty 复核 + rmdir_bottom_up 自底向上删。
/// 路径已不存在(重复请求被前一条带走 / 外部已删)→ ok:true 幂等。
pub async fn remove_empty_dirs(
  root : String,
  rel_paths : Array[String],
  rules : @core.IgnoreRuleset,
  nested_roots : Array[String],
) -> Array[EmptyDirDeleteResult] {
  let results : Array[EmptyDirDeleteResult] = []
  // 共享根都不在了:如实报失败,而不是逐条假称「已删除」(realpath 不会返回空串)
  let root_real = @fs.realpath(root) catch { _ => "" }
  if root_real == "" {
    for p in rel_paths {
      results.push({ path: p, ok: false, reason: Some("共享目录不存在或不可读") })
    }
    return results
  }
  let nested = build_nested_set(root_real, nested_roots)
  // 深路径先处理:父与子都被勾选时,子先删、父的复核自然放行(整条链一次清完);
  // 同深度按字典序,保证结果顺序确定(Node 同款排序)。
  let sorted : Array[String] = []
  for p in rel_paths {
    sorted.push(p)
  }
  sorted.sort_by((a, b) => {
    let da = path_depth(a)
    let db = path_depth(b)
    if da != db {
      db - da
    } else {
      cmp_lexical(a, b)
    }
  })
  for rel in sorted {
    let abs = match resolve_folder_subpath(root_real, rel) {
      Found(abs) => abs
      Unsafe(message) => {
        results.push({ path: rel, ok: false, reason: Some(message) })
        continue
      }
      // 路径已不存在(重复请求被前一条带走 / 外部已删)→ 幂等成功
      PathMissing => {
        results.push({ path: rel, ok: true, reason: None })
        continue
      }
      PathUnreachable => {
        results.push({ path: rel, ok: false, reason: Some("路径不可达") })
        continue
      }
    }
    if abs == root_real {
      results.push({ path: rel, ok: false, reason: Some("不能删除共享目录本身") })
      continue
    }
    if @core.is_hard_ignored(rel) || rules.is_ignored(rel, true) {
      results.push({
        path: rel,
        ok: false,
        reason: Some("已不在同步范围内(被忽略规则命中),跳过"),
      })
      continue
    }
    if nested_contains(nested, abs) {
      results.push({ path: rel, ok: false, reason: Some("属于其它共享目录,跳过") })
      continue
    }
    match verify_empty(abs, nested) {
      Blocked(reason) => {
        results.push({ path: rel, ok: false, reason: Some(reason) })
        continue
      }
      ProbeMissing => {
        results.push({ path: rel, ok: true, reason: None })
        continue
      }
      Empty => ()
    }
    match rmdir_bottom_up(abs, nested) {
      Some(err) => results.push({ path: rel, ok: false, reason: Some(err) })
      None => results.push({ path: rel, ok: true, reason: None })
    }
  }
  results
}

///|
/// Node `rel.split('/').length` 的段数口径(空串也算一段)。
fn path_depth(rel : String) -> Int32 {
  let mut n : Int32 = 1
  for c in rel {
    if c == '/' {
      n += 1
    }
  }
  n
}

///|
/// 逐字符字典序比较器(sort_by 用,-1/0/1)。不能用 String 自带的比较:
/// core 的 String 比较是 shortlex(先比长度),与 Node 默认 sort 的逐单元次序
/// 不同;与 api/versions.mbt 的 cmp_text 同一套实现。
fn cmp_lexical(a : String, b : String) -> Int32 {
  let ca = a.to_array()
  let cb = b.to_array()
  let n = if ca.length() < cb.length() { ca.length() } else { cb.length() }
  for i in 0..<n {
    let x = ca[i]
    let y = cb[i]
    if x != y {
      return if x < y { -1 } else { 1 }
    }
  }
  if ca.length() < cb.length() {
    -1
  } else if ca.length() > cb.length() {
    1
  } else {
    0
  }
}

///|
/// 空目录工具用的忽略规则行(Node session-manager emptyDirRulesFor →
/// readFolderIgnoreLines 的 MoonBit 口径):内置默认行 + 根 `.gitignore`(按
/// useGitignore 配置)+ `.syncxignore`,后读的覆盖先读的。
///
/// 与 Node 的既有差距(全仓状态,非本模块引入):Node 还会递归并入子目录
/// `.gitignore`(readNestedGitignoreLines 改写成根相对模式);MoonBit 侧目前
/// 没有任何装配点读嵌套 gitignore(cli 装载规则处同样留空,见 cli/entry.mbt),
/// 这里同样只读根文件。硬忽略名单另有独立闸门(is_hard_ignored),负向规则解不开。
pub async fn read_folder_ignore_lines(
  folder_path : String,
  use_gitignore : Bool,
) -> Array[String] {
  let lines : Array[String] = []
  for name in @core.hard_ignore_names() {
    lines.push(name) // 内置默认(与 Node BUILTIN_IGNORE_LINES 同名单)
  }
  if use_gitignore {
    for line in read_ignore_lines("\{folder_path}/.gitignore") {
      lines.push(line)
    }
  }
  for line in read_ignore_lines("\{folder_path}/.syncxignore") {
    lines.push(line)
  }
  lines
}

///|
/// 读单个忽略文件的行;不存在/不可读返回空(目录可能刚创建,Node 同口径)。
async fn read_ignore_lines(path : String) -> Array[String] {
  let text = @fs.read_file(path) catch { _ => return [] }
  let out : Array[String] = []
  for seg in text.text().split("\n") {
    out.push(seg.to_owned())
  }
  out
}
