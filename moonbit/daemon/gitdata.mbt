///|
/// Git 弹窗数据面原语(「Git 改动 / 提交历史 / 推送」三个弹窗的后端数据源),
/// 对齐 Node `src/git-monitor.ts` 的 getUncommittedChanges / listRecentCommits /
/// listCommitFiles / getCommitParents / readFileAt 五件套。探测类照旧优雅降级,
/// 读取类失败如实上抛(路由转 400;哈希查不到翻译成「提交不存在」口径在 api 层)。

///|
/// 工作区一条未提交变更(目录卡「Git 改动」徽标与详情弹窗的条目)。
pub(all) struct GitChangeEntry {
  /// 相对仓库根的路径(POSIX 分隔);git 折叠的未跟踪目录已去尾斜杠。
  path : String
  /// true = git 把「整棵未跟踪目录」折叠成的这一条记录:没有单文件可对比。
  dir : Bool
  /// "modified" / "added" / "deleted" / "renamed"。
  status : String
  /// renamed 的原路径。
  orig_path : String?
  /// 已 staged(git status 第一列非空且非 ?)。
  staged : Bool
}

///|
/// get_uncommitted_changes 的结果(条目数封顶保命:node_modules 误跟踪时
/// 弹窗树分批渲染受不了几十万条)。
pub(all) struct GitChangesResult {
  entries : Array[GitChangeEntry]
  truncated : Bool
}

///|
/// 「Git 改动」条目数封顶(照 Node GIT_CHANGES_MAX)。
pub const GIT_CHANGES_MAX : Int32 = 2000

///|
/// 提交历史一页的条数与单次请求上限(照 Node GIT_LOG_LIMIT / MAX_GIT_LOG_LIMIT;
/// 上限是**单次请求**的保护,不是分页的一部分)。
pub const GIT_LOG_LIMIT : Int32 = 20

///|
pub const MAX_GIT_LOG_LIMIT : Int32 = 100

///|
/// 提交展开里的一行:该笔提交动了哪个文件、怎么动的。
pub(all) struct GitCommitFileEntry {
  /// git name-status 状态字母(M/A/D/R/C/T 等)。
  status : String
  /// 提交后的路径(改名/复制时为新路径)。
  path : String
  /// 改名/复制时的原路径(status 为 R/C 开头时存在)。
  orig_path : String?
}

///|
/// 任意 rev 的文件读取结果。三种结果必须分清,不能糊成「取不到」:
/// 文件确实不在该 rev(新文件/根提交)归 Absent;对象损坏/超时归 Error ——
/// 谎报成缺失会把人支去查一个不存在的问题(文件明明在盘上)。
pub enum HeadRead {
  Bytes(Bytes)
  Absent
  Error(String)
}

///|
/// 提交哈希的形状闸:git 对象名只可能是 7–40 位十六进制。从源头挡掉以 `-`
/// 开头被 git 当**选项**解析的注入,以及把 rev 表达式当哈希传进来的失误。
pub fn is_commit_hash(hash : String) -> Bool {
  let n = hash.length()
  if n < 7 || n > 40 {
    return false
  }
  for ch in hash {
    let hex = (ch >= '0' && ch <= '9') ||
      (ch >= 'a' && ch <= 'f') ||
      (ch >= 'A' && ch <= 'F')
    if !hex {
      return false
    }
  }
  true
}

///|
/// porcelain XY 两列里的单字符判定辅助。
fn xy_contains(xy : StringView, target : Char) -> Bool {
  for ch in xy {
    if ch == target {
      return true
    }
  }
  false
}

///|
/// 已 staged:第一列非空且非 ?(?? 未跟踪不算 staged)。
fn xy_is_staged(xy : StringView) -> Bool {
  let mut i = 0
  for ch in xy {
    if i >= 1 {
      break
    }
    if ch != ' ' && ch != '?' {
      return true
    }
    i = i + 1
  }
  false
}

///|
/// 盘点工作区的未提交变更(含未跟踪文件;syncx 在途中间态照旧排除)。
/// 返回 None = 不是 git 仓库 / git 不可用,调用方据此不显示徽标、弹窗给解释。
/// 解析口径与 Node getUncommittedChanges 一致:`-z` NUL 分隔,改名/复制跟两个
/// 记录(新路径 + 原路径),未跟踪目录折叠记录去尾斜杠并打 dir 标记。
pub async fn get_uncommitted_changes(folder : String) -> GitChangesResult? {
  if !is_git_repo(folder) {
    return None
  }
  let (code, out, _) = run_git(
    "git",
    folder,
    ["status", "--porcelain", "-z", "--", ..scratch_pathspecs()],
  ) catch {
    _ => return None
  }
  if code != 0 {
    return None
  }
  let records : Array[StringView] = []
  for rec in out.split("\u{0}") {
    if rec != "" {
      records.push(rec)
    }
  }
  let entries : Array[GitChangeEntry] = []
  let mut i = 0
  while i < records.length() {
    let rec = records[i]
    // 每条记录:XY<空格>path(X=暂存区列,Y=工作区列,?? = 未跟踪)
    let xy = rec[0:2]
    let mut path = ""
    if rec.length() > 3 {
      path = rec[3:rec.length()].to_owned()
    }
    if path == "" {
      i = i + 1
      continue
    }
    // 尾斜杠在这里去掉:留着的话前端按 '/' 切段建树会切出空名字的行
    let is_dir = path.has_suffix("/")
    if is_dir {
      path = path[0:path.length() - 1].to_owned()
    }
    let mut orig_path : String? = None
    if xy_contains(xy, 'R') || xy_contains(xy, 'C') {
      i = i + 1
      if i < records.length() {
        orig_path = Some(records[i].to_owned())
      }
    }
    // 归类优先级:删除 > 重命名/复制 > 新增 > 修改;?? 恒为 added
    let xy_text = xy.to_owned()
    let status = if xy_contains(xy, 'D') {
      "deleted"
    } else if orig_path is Some(_) {
      "renamed"
    } else if xy_contains(xy, 'A') || xy_text == "??" {
      "added"
    } else {
      "modified"
    }
    entries.push({
      path,
      dir: is_dir,
      status,
      orig_path,
      staged: xy_is_staged(xy),
    })
    if entries.length() >= GIT_CHANGES_MAX {
      return Some({ entries, truncated: true, })
    }
    i = i + 1
  }
  Some({ entries, truncated: false, })
}

///|
/// 最近提交历史一页(「Git 提交历史」弹窗数据源)。None = 不是 git 仓库。
/// `--skip` 与 `-n` 都是 git log 自己的分页参数,不在这里切数组。
/// 空仓库(还没有任何提交)git log 以 128 退出:是「没有提交」而非「读取失败」
/// —— 用 rev-parse 复核(stderr 文案随 locale 变化,不可靠),回空列表空态。
pub async fn list_recent_commits(
  folder : String,
  limit~ : Int32 = GIT_LOG_LIMIT,
  skip~ : Int32 = 0,
) -> Array[GitCommitEntry]? {
  if !is_git_repo(folder) {
    return None
  }
  let skip_args : Array[String] = if skip > 0 {
    ["--skip", "\{skip}"]
  } else {
    []
  }
  let out = git_ok(
    folder,
    [
      "log",
      "-n",
      "\{limit}",
      ..skip_args,
      "-z",
      "--no-color",
      "--no-show-signature",
      "--format=\{GIT_LOG_FORMAT}",
    ],
  ) catch {
    e =>
      match get_last_commit_hash(folder) {
        Some(_) => raise e
        None => return Some([])
      }
  }
  Some(parse_commit_records(out))
}

///|
/// 某笔提交动了哪些文件(`git show --format= --name-status -z -M`)。
/// 失败(提交不存在/对象损坏等)如实上抛;空数组 = 干净的合并提交(不是失败)。
/// 必须带 -z:文本模式会把非 ASCII 路径转成 `"\344..."` 八进制转义没法用;
/// -z 下普通条目两段一组 `status\0path\0`,改名/复制三段一组 `R100\0旧\0新`。
pub async fn list_commit_files(
  folder : String,
  hash : String,
) -> Array[GitCommitFileEntry] {
  if !is_commit_hash(hash) {
    raise GitFailed("非法的提交哈希")
  }
  let (code, out, err) = run_git("git", folder, [
    "show", "--format=", "--name-status", "-z", "-M", "--no-color", hash,
  ])
  if code != 0 {
    raise GitFailed(first_line(err))
  }
  let fields : Array[StringView] = []
  for f in out.split("\u{0}") {
    fields.push(f)
  }
  let entries : Array[GitCommitFileEntry] = []
  let mut i = 0
  while i < fields.length() {
    let status = fields[i]
    // 尾部:最后一个记录以 \0 结尾,split 后残留空串,直接收尾
    if status == "" {
      break
    }
    let mut status_first : Char = '\u{0}'
    for ch in status {
      status_first = ch
      break
    }
    if status_first == 'R' || status_first == 'C' {
      // 三段一组:旧路径在前,path 取提交后的新路径
      if i + 2 >= fields.length() {
        break
      }
      let orig_path = fields[i + 1].to_owned()
      let new_path = fields[i + 2].to_owned()
      if new_path == "" {
        break
      }
      entries.push({
        status: status.to_owned(),
        path: new_path,
        orig_path: Some(orig_path),
      })
      i = i + 3
    } else {
      if i + 1 >= fields.length() {
        break
      }
      let path = fields[i + 1].to_owned()
      if path == "" {
        break
      }
      entries.push({ status: status.to_owned(), path, orig_path: None, })
      i = i + 2
    }
  }
  entries
}

///|
/// 某笔提交的父提交列表(`git rev-list --parents -n 1`)。空数组 = 根提交;
/// 合并提交有两个以上父 —— 「上一版」的语义取**首父**(主干侧),调用方决定。
pub async fn get_commit_parents(
  folder : String,
  hash : String,
) -> Array[String] {
  if !is_commit_hash(hash) {
    raise GitFailed("非法的提交哈希")
  }
  let out = git_ok(folder, ["rev-list", "--parents", "-n", "1", hash])
  // 输出形如 `<hash> <parent1> [parent2 ...]`,首段是提交自己
  let parts : Array[String] = []
  for p in out.trim().split(" ") {
    if p != "" {
      parts.push(p.to_owned())
    }
  }
  let parents : Array[String] = []
  for i in 1..<parts.length() {
    parents.push(parts[i])
  }
  parents
}

///|
/// GitError → 文案(读侧兜底用;子进程拉起失败与 git 退出非零同权)。
fn git_error_text(e : GitError) -> String {
  match e {
    SpawnFailed(t) => t
    GitFailed(t) => t
  }
}

///|
/// 带字节输出的 git 子进程(read_file_at 专用:内容必须逐字节保真,
/// 文本版会把二进制文件读坏)。
async fn run_git_bytes(
  cwd : String,
  args : Array[String],
) -> (Int32, Bytes, String) raise GitError {
  let (code, out, err) = @process.collect_output(
    "git",
    args,
    cwd~,
    no_console_window=true,
  ) catch {
    e => raise SpawnFailed("\{e}")
  }
  let err_text = err.text() catch { _ => "" }
  (code, out.binary(), err_text)
}

///|
/// 读取某文件在任意 rev(HEAD 或某个提交哈希)里的字节。
/// relPath 必须是仓库相对路径且不含目录穿越 —— 由调用方(路由层)把门。
pub async fn read_file_at(
  folder : String,
  rev : String,
  rel_path : String,
) -> HeadRead {
  let (code, bytes, err) = run_git_bytes(folder, ["show", "\{rev}:\{rel_path}"]) catch {
    e => return Error(git_error_text(e))
  }
  if code == 0 {
    return Bytes(bytes)
  }
  if err.contains("does not exist in") ||
    err.contains("exists on disk, but not in") {
    return Absent
  }
  // 取第一行:多行 inflate 错误里第一行已能说明「读取失败」
  let first = first_line(err)
  Error(if first == "" { "git 读取失败" } else { first })
}

///|
/// 跨包构造辅助(api 侧「没有父提交」的父侧缺省):变体作为值在跨包上下文
/// 需要类型限定,这里给一个免争议的入口。
pub fn head_read_absent() -> HeadRead {
  Absent
}
