///|
/// git 集成:仓库探测、未提交/未推送状态、自动提交与推送(对应 Node
/// `src/git-monitor.ts` 与 `src/session-manager.ts` 的 git 段;Rust 侧尚无对应
/// 模块,本文件是三端中第二次落地,以 Node 为权威参考)。
///
/// 全部能力经 `moonbitlang/async` 的 process 直接 spawn `git` 子进程并解析
/// stdout(与 Node 侧「不引 libgit2、直接 execFile git」同一取向),不引入
/// 任何 git 库绑定。
///
/// 三条契约,移植时不能简化:
///
///  1. **探测类一律优雅降级**:is_git_repo / get_last_commit_hash /
///     has_uncommitted_changes / count_unpushed_commits / get_commit_info 在
///     git 未安装、非仓库、git 退出非零、输出解析失败时统统返回「无」值
///     (false / None),绝不向上抛 —— git 集成是附加能力,不能因为它拖垮扫描
///     循环(每 5s 一轮)。
///  2. **动作类失败如实报错**:auto_commit / git_push 失败时把 stderr 首行
///     交给调用方,由调用方决定重试(照 Node 的退避重试口径)。
///  3. **syncx 的在途中间态两头都排除**:`git add -A` 与 `git status` 都带
///     `:(exclude)*.syncx-tmp` / `:(exclude)*.syncx-partial` 负向 pathspec,
///     否则大文件传输期间躺在目标旁边的半截内容会被收进仓库历史,几百 MB 的
///     残骸经提交同步给对端。后缀事实来自 core 的 scratch_suffixes(与 Node
///     侧 SCRATCH_SUFFIXES 共用一份口径)。
///
/// spawn 一律带 no_console_window=true,对应 Node 侧的 windowsHide:daemon 被
/// 自更新流程拉起后没有控制台,git.exe 是控制台程序,不压窗口就会每轮扫描闪
/// 两下黑框。

///|
/// git 子进程交互错误(仅动作类向上抛;探测类内部消化)。
pub(all) suberror GitError {
  /// 子进程拉起失败:git 未安装 / 路径不对 / 权限拒绝。
  SpawnFailed(String)
  /// git 退出非零;消息为 stderr 首行(可能为空串)。
  GitFailed(String)
}

///|
/// 「未推送提交」弹窗每目录默认列出的条数上限(照 Node 的 GIT_UNPUSHED_LIMIT)。
pub const GIT_UNPUSHED_LIMIT : Int32 = 50

///|
/// push 是网络操作,给足超时但必须有封顶:凭据缺失 / 网络黑洞不能让「一键推送」
/// 挂死(照 Node 的 GIT_PUSH_TIMEOUT_MS)。
pub const GIT_PUSH_TIMEOUT_MS : Int32 = 120_000

///|
/// git log 的机器可读记录格式:字段以 0x1f 分隔,记录以 NUL 分隔(配 -z)。
/// 正文放在最后一个字段:消息里混入 0x1f 时只是把多余分隔符并回正文,不会挪动
/// 其它字段(见 parse_commit_records)。
const GIT_LOG_FORMAT : String = "%h\u{1f}%an\u{1f}%aI\u{1f}%D\u{1f}%s\u{1f}%b"

///|
/// get_commit_info 的输出哨兵:提交正文理论上是任意文本,行解析会在正文第二行
/// 错位;git 自己的 -z 对 `git log --format` 不适用(只有 diff 侧认 -z),故用
/// 一个用户几乎敲不进消息的分隔串(照 Node 的 ---SYNCX-END---)。
const GIT_LOG_SENTINEL : String = "---SYNCX-END---"

///|
/// Git 提交同步的四种模式(照 Node `config.ts` 的 GitSyncMode)。
///  - Off:不启用(默认)
///  - Send:检测并广播本地提交,但不自动提交对端通知
///  - Receive:收到通知时自动提交,但不广播本地提交(只进不出)
///  - Full:双向 —— 广播本地提交、自动提交对端通知,并向其余对端中继
#derive(Eq)
pub(all) enum GitSyncMode {
  Off
  Send
  Receive
  Full
}

///|
/// 显式暴露派生的 Eq 方法(避免隐式提升告警)。
pub extend GitSyncMode with Eq::{equal, not_equal}

///|
/// 从配置字符串解析 gitSync 模式:缺省、空串与未知值一律按 Off 处理
/// (旧配置缺省 = 尚未设置 = off,照 Node 口径;非法值静默回退而不是抛错,
/// 因为这里读的是盘上配置而非用户输入,设置入口的校验在 API 层)。
pub fn git_sync_mode_of(value : String?) -> GitSyncMode {
  match value {
    Some("send") => Send
    Some("receive") => Receive
    Some("full") => Full
    _ => Off
  }
}

///|
/// 该模式是否检测并广播本地提交('send' / 'full')。
pub fn GitSyncMode::sends(self : GitSyncMode) -> Bool {
  self == Send || self == Full
}

///|
/// 该模式是否对对端提交通知做自动提交('receive' / 'full')。
/// 「pull」在 syncx 的语义里就是这个:收到通知 → 等内容落齐 → 镜像提交,
/// 从不主动 git pull(远端状态由用户自己的 fetch/push 维护)。
pub fn GitSyncMode::receives(self : GitSyncMode) -> Bool {
  self == Receive || self == Full
}

///|
/// 依 gitSync 模式推导的同步策略面:三个开关对应 Node session-manager 里
/// checkGitCommits / flushPendingGitNotify / relayGitCommitNotify 的三处闸门。
#derive(Eq)
pub(all) struct GitSyncPlan {
  /// 扫描末尾检测本地新提交并广播(send / full)。
  watch_local : Bool
  /// 收到对端通知后等接收排空再自动镜像提交(receive / full)。
  auto_commit_remote : Bool
  /// 镜像提交成功后向其余对端中继原始通知(仅 full;receive 只进不出)。
  relay : Bool
}

///|
/// 显式暴露派生的 Eq 方法(避免隐式提升告警)。
pub extend GitSyncPlan with Eq::{equal, not_equal}

///|
/// 推导某模式的同步策略面。
pub fn git_sync_plan(mode : GitSyncMode) -> GitSyncPlan {
  {
    watch_local: mode.sends(),
    auto_commit_remote: mode.receives(),
    relay: mode == Full,
  }
}

///|
/// 一条提交记录(提交历史弹窗 / 未推送列表共用;照 Node 的 GitCommitEntry)。
pub(all) struct GitCommitEntry {
  /// 短哈希(7 位左右,展示与复制用)。
  hash : String
  /// 作者名(git 的 %an)。
  author : String
  /// 作者时间,ISO 8601(git 的 %aI;前端自己本地化展示)。
  date : String
  /// 引用装饰原样串(git 的 %D,如 `HEAD -> main, tag: v1.0`);无引用为空串。
  refs : String
  /// 提交消息首行(subject)。
  subject : String
  /// 提交消息正文(不含首行);空串 = 这笔没有正文。
  body : String
}

///|
/// 两个提交之间的完整信息(照 Node 的 CommitInfo)。
pub(all) struct CommitInfo {
  /// 新提交的完整哈希。
  hash : String
  /// 父提交哈希(用于检测 rebase;合并提交取首父)。
  parent_hash : String
  /// 提交消息首行(subject)。
  message : String
  /// 完整提交消息(含 body)。
  full_message : String
  /// 变更文件列表(相对路径)。
  changed_files : Array[String]
  /// diff stat 输出(信息展示用;拿不到为 None)。
  diff_stat : String?
  /// 本批次**所有**提交的 subject(旧→新,含最后一笔):一轮扫描可能攒下多笔
  /// 提交,镜像侧只落一笔;整批 subject 随通知带过去,接收方在镜像提交的 body
  /// 里保留这批变更的完整脉络(哈希两侧本就不同,消息是唯一可对上的线索)。
  commit_subjects : Array[String]
}

///|
/// 自动提交结果(照 Node 的 AutoCommitResult,外加 skipped 标记)。
pub(all) struct AutoCommitResult {
  /// 提交动作本身是否成功(含「无需提交被跳过」的 success=true)。
  success : Bool
  /// 工作树干净、没有可提交内容而跳过(调用方无须告警)。
  skipped : Bool
  /// 新提交的哈希(真正落了提交时)。
  hash : String?
  /// 失败原因(stderr 首行或异常消息)。
  error : String?
}

///|
/// 单目录 `git push` 的结果;失败时 error 为 stderr 首行(如无上游分支 /
/// 认证失败)。
pub(all) struct GitPushResult {
  ok : Bool
  error : String?
}

///|
/// 跑一条 git 子命令,收集 stdout/stderr 文本。退出码原样返回,非零不在这里
/// 抛(由调用方决定是降级还是报错)。stdout/stderr 按 UTF-8 解码,失败按空串
/// 处理:git 的机器可读输出(-z / --format)不应该是坏字节,真遇到时宁可拿到
/// 空串走降级路径,也不让整条探测链炸掉。
///
/// 公开给测试与上层替换 git 路径(默认调用走 git_run)。
pub async fn run_git(
  bin : String,
  cwd : String,
  args : Array[String],
) -> (Int32, String, String) raise GitError {
  let (code, out, err) = @process.collect_output(
    bin,
    args,
    cwd~,
    no_console_window=true,
  ) catch {
    e => raise SpawnFailed("\{e}")
  }
  let out_text = out.text() catch { _ => "" }
  let err_text = err.text() catch { _ => "" }
  (code, out_text, err_text)
}

///|
/// 内部默认入口:用 PATH 上的 git 跑一条命令,非零退出抛 GitFailed(stderr 首行)。
async fn git_ok(cwd : String, args : Array[String]) -> String raise GitError {
  let (code, out, err) = run_git("git", cwd, args)
  if code != 0 {
    raise GitFailed(first_line(err))
  }
  out
}

///|
/// 取字符串首行;空串回空串(错误消息可能多行,首行已能说明问题)。
fn first_line(s : String) -> String {
  for line in s.split("\n") {
    return line.to_owned()
  }
  ""
}

///|
/// 按分隔符切成非空(去除首尾空白后)的字符串数组。
fn split_nonempty(s : String, sep : String) -> Array[String] {
  let out : Array[String] = []
  for part in s.split(sep) {
    let t = part.trim().to_owned()
    if t != "" {
      out.push(t)
    }
  }
  out
}

///|
/// syncx 在途中间态的负向 pathspec(`:(exclude)*.syncx-tmp` 等):只给负向
/// pathspec 不改变其余语义 —— 实测在仓库子目录里执行带负向 pattern 的
/// `git add -A`,子目录之外的新文件照样被 stage(照 Node 的 SCRATCH_PATHSPECS)。
fn scratch_pathspecs() -> Array[String] {
  let specs : Array[String] = []
  for suffix in @core.scratch_suffixes() {
    specs.push(":(exclude)*\{suffix}")
  }
  specs
}

///|
/// 检测目录是否为 git 仓库(.git 存在即可,目录或 worktree 的文件都算)。
pub async fn is_git_repo(folder : String) -> Bool {
  @fs.exists("\{folder}/.git")
}

///|
/// 获取 HEAD 当前的提交哈希;无提交(空仓库)/ 非仓库 / git 不可用返回 None。
pub async fn get_last_commit_hash(folder : String) -> String? {
  let (code, out, _) = run_git("git", folder, ["rev-parse", "HEAD"]) catch {
    _ => return None
  }
  if code != 0 {
    return None
  }
  let t = out.trim().to_owned()
  if t == "" {
    None
  } else {
    Some(t)
  }
}

///|
/// 检查工作区是否有未提交的变更(含未跟踪文件;syncx 在途中间态排除)。
/// true 表示有变更可以提交。任何失败按「无变更」处理,不让扫描循环抛错。
pub async fn has_uncommitted_changes(folder : String) -> Bool {
  let (code, out, _) = run_git(
    "git",
    folder,
    ["status", "--porcelain", "--", ..scratch_pathspecs()],
  ) catch {
    _ => return false
  }
  if code != 0 {
    return false
  }
  out.trim() != ""
}

///|
/// 解析 `git log -z --format=<GIT_LOG_FORMAT>` 的输出:记录以 NUL 分隔,
/// 字段以 0x1f 分隔;正文放最后一个字段,消息里真混入 0x1f 时也只是把多余
/// 分隔符并回正文而不是丢内容(照 Node 的 parseCommitRecords)。
fn parse_commit_records(out : String) -> Array[GitCommitEntry] {
  let entries : Array[GitCommitEntry] = []
  for rec in out.split("\u{0}") {
    if rec == "" {
      continue
    }
    let fields : Array[String] = []
    for part in rec.split("\u{1f}") {
      fields.push(part.to_owned())
    }
    let field = (i : Int32) => {
      match fields.get(i) {
        Some(v) => v
        None => ""
      }
    }
    // 正文是最后一个字段:5 之后的都并回正文
    let mut body = ""
    for i in 5..<fields.length() {
      if i > 5 {
        body = body + "\u{1f}"
      }
      body = body + fields[i]
    }
    entries.push({
      hash: field(0),
      author: field(1),
      date: field(2),
      refs: field(3),
      subject: field(4),
      body: body.trim().to_owned(),
    })
  }
  entries
}

///|
/// 读取当前分支尚未推送的提交(`@{upstream}..HEAD`,新→旧,最多 limit 条)。
/// None = 不是 git 仓库 / 未设置上游 / 读取失败 —— 调用方据此不显示徽标。
/// 只与本地远程跟踪引用比较,绝不 fetch(不产生网络请求、不改动任何引用)。
pub async fn list_unpushed_commits(
  folder : String,
  limit~ : Int32 = GIT_UNPUSHED_LIMIT,
) -> Array[GitCommitEntry]? {
  if !is_git_repo(folder) {
    return None
  }
  let out = git_ok(folder, [
    "log",
    "-n",
    "\{limit}",
    "-z",
    "--no-color",
    "--no-show-signature",
    "--format=\{GIT_LOG_FORMAT}",
    "@{upstream}..HEAD",
  ]) catch {
    _ => return None
  }
  Some(parse_commit_records(out))
}

///|
/// 统计当前分支尚未推送的提交数(与本机记录的上游分支比较,
/// `git rev-list --count '@{upstream}..HEAD'`)。None = 不是仓库 / 未设上游 /
/// 读取失败,调用方据此不挂「未推送 N」徽标。
pub async fn count_unpushed_commits(folder : String) -> Int32? {
  // 非仓库直查 .git:不闸的话,嵌在别的仓库内的 plain 目录会让 git 向上回溯、
  // 数到外层仓库的提交 —— 与「非仓库回 None」的契约不符。
  if !is_git_repo(folder) {
    return None
  }
  let out = git_ok(folder, ["rev-list", "--count", "@{upstream}..HEAD"]) catch {
    _ => return None
  }
  try {
    let n = @string.parse_int(out.trim())
    if n >= 0 {
      Some(n)
    } else {
      None
    }
  } catch {
    _ => None
  }
}

///|
/// 收集两个提交之间的信息。from_hash 起始(不含),to_hash 结束(含)。
/// 任何失败返回 None(照 Node:getCommitInfo 整体 try/catch 回 null)。
pub async fn get_commit_info(
  folder : String,
  from_hash : String,
  to_hash : String,
) -> CommitInfo? {
  let range = "\{from_hash}..\{to_hash}"
  let log_out = git_ok(folder, [
    "log",
    "--format=%H%n%P%n%s%n%b%n\{GIT_LOG_SENTINEL}",
    range,
  ]) catch {
    _ => return None
  }
  // 每个提交由哨兵分隔;trim 不能省:分隔符之后的 entry 带前导换行
  let entries = split_nonempty(log_out, GIT_LOG_SENTINEL)
  if entries.is_empty() {
    return None
  }
  // 整批提交的 subject,旧→新(git log 输出为新→旧,故倒序收集)。
  // 哨兵之前的首个 entry 里,行 2 是 subject。
  let mut subjects : Array[String] = []
  for entry in entries {
    let lines = split_nonempty(entry, "\n")
    match lines.get(2) {
      Some(s) => subjects.push(s)
      None => ()
    }
  }
  // git log 输出为新→旧,倒序收集成旧→新
  subjects = subjects.rev()
  // 取第一个 entry(git log 输出为新→旧,它就是最新的那笔):hash、消息、
  // 变更清单才不会错位到批次里最旧的一笔。
  let last = entries[0]
  let lines = split_nonempty(last, "\n")
  if lines.length() < 3 {
    return None
  }
  let hash = lines[0]
  // 父哈希行可能带多个父(合并提交),取首段
  let parent_hash = first_token(lines[1])
  let message = lines[2]
  let full_message = join_lines_from(lines, 2)
  // 变更文件列表(diff --name-only 对空范围正常退出)
  let diff_out = git_ok(folder, ["diff", "--name-only", range]) catch {
    _ => return None
  }
  let changed_files = split_nonempty(diff_out, "\n")
  // diff stat 可选:拿不到不影响主流程
  let diff_stat = try {
    let stat = git_ok(folder, ["diff", "--stat", range]).trim().to_owned()
    if stat == "" {
      None
    } else {
      Some(stat)
    }
  } catch {
    _ => None
  }
  Some({
    hash,
    parent_hash,
    message,
    full_message,
    changed_files,
    diff_stat,
    commit_subjects: subjects,
  })
}

///|
/// 取字符串首个非空白片段(父哈希行 `hash p1 [p2 ...]` 取首段用)。
fn first_token(s : String) -> String {
  for part in s.trim().split(" ") {
    if part != "" {
      return part.to_owned()
    }
  }
  ""
}

///|
/// 把 lines 从 start 起用换行接回一个字符串(完整提交消息 = 首行 + 正文)。
fn join_lines_from(lines : Array[String], start : Int32) -> String {
  let mut out = ""
  for i in start..<lines.length() {
    if i > start {
      out = out + "\n"
    }
    out = out + lines[i]
  }
  out
}

///|
/// 行是否匹配 /co-?authored-by/i:大小写不敏感,`co` 与 `authored` 之间的
/// 连字符可有可无(`Co-Authored-By` / `coauthored-by` 都算)。正则未锚定,
/// 故语义就是「行内出现即命中」—— git 尾注带缩进或署名后缀时照样剔除。
fn is_co_authored_line(line : String) -> Bool {
  let lower = line.to_lower()
  lower.contains("co-authored-by") || lower.contains("coauthored-by")
}

///|
/// 对组装出的最终镜像提交消息剔除 Co-Authored-By 行(目录设置
/// gitStripCoAuthored 开启时启用)。规则(三端契约,与前端目录设置同名):
///  - 匹配 /co-?authored-by/i 的**整行**剔除,不只首行 —— 对端由 AI 生成的
///    提交可能带一整组尾注;
///  - 剔除后不留连续空行尾巴:尾注通常成组躺在消息末尾,只删行不裁尾会留下
///    悬空的空行结尾。正文内部的空行保持原样;
///  - 没有命中行时原样返回(逐字节不变),不因开关开启而改写干净消息。
pub fn strip_co_authored_lines(message : String) -> String {
  let kept : Array[String] = []
  let mut removed = false
  for line in message.split("\n") {
    let owned = line.to_owned()
    if is_co_authored_line(owned) {
      removed = true
      continue
    }
    kept.push(owned)
  }
  if !removed {
    return message
  }
  // 裁掉尾部连续空行(尾巴)
  while kept.length() > 0 && kept[kept.length() - 1].trim() == "" {
    let _ = kept.pop()
  }
  kept.join("\n")
}

///|
/// 组装镜像提交的提交信息(照 Node 的 composeMirrorCommitMessage):正文用本批
/// 最后一笔的 full_message,多于一笔时把其余提交的 subject(旧→新)附在 body ——
/// 一笔镜像提交里保留整批提交脉络(哈希两侧本就不同,消息是唯一可对上的线索)。
/// 单笔、或通知缺 commitSubjects(旧版对端)时与原消息一致,不多冗余。
/// `strip~` 对应目录设置 gitStripCoAuthored(缺省 false = 行为不变):开启时对
/// 组装完成的最终消息剔除 Co-Authored-By 尾注行(见 strip_co_authored_lines)。
pub fn compose_mirror_commit_message(
  full_message : String,
  commit_subjects : Array[String],
  strip~ : Bool = false,
) -> String {
  let rest : Array[String] = []
  if commit_subjects.length() > 1 {
    for i in 0..<(commit_subjects.length() - 1) {
      let s = commit_subjects[i].trim()
      if s != "" {
        rest.push(s.to_owned())
      }
    }
  }
  let composed = if rest.is_empty() {
    full_message
  } else {
    "\{full_message}\n\n\{rest.join("\n")}"
  }
  if strip {
    strip_co_authored_lines(composed)
  } else {
    composed
  }
}

///|
/// 变更清单的日志描述(照 Node 口径:数量 + 前 10 个文件名,超出截断)。
pub fn git_files_desc(changed : Array[String]) -> String {
  if changed.length() == 0 {
    return "无文件变更"
  }
  let head : Array[String] = []
  for i in 0..<changed.length() {
    if i >= 10 {
      break
    }
    head.push(changed[i])
  }
  let tail = if changed.length() > 10 { " …" } else { "" }
  "\{changed.length()} 个文件: \{head.join(", ")}\{tail}"
}

///|
/// 执行自动提交:git add -A && git commit -m <message>(在途中间态挡在外面)。
/// 使用 --allow-empty 兜底:判定有无变更与 add 之间工作树可能被他程序改回,
/// 保证提交命令本身不因竞态失败(照 Node 语义)。失败时 error 为 stderr 首行。
///
/// 失败探测(与 Node git-monitor.ts autoCommit 的修复口径一致):提交命令
/// 报错只说明「进程没按成功路径退出」,提交对象可能早已落盘(慢盘 fsync /
/// post-commit hook 卡顿)。此时若按失败重试,重试前的变更判定会被「同步仍在
/// 继续」的新变更糊弄过去,同一镜像消息再吞一笔 —— 把第一次成功提交之后到达
/// 的修改也吞进同一笔。因此提交阶段失败后先比对 HEAD:前进了且 `git log -1
/// --format=%B`(trim 后)与本次消息一致 = 实际成功,按成功结算;消息不一致
/// (并发了他程序提交)保守按失败走原路 —— 账目归调用方的基线/通知逻辑管。
/// 本形态的 git 调用(run_git)无超时,不存在「超时误判失败」,但「提交已
/// 落盘而命令报错」的中间态失败同理成立,故做此最小等价探测。
///
/// 范围收敛(changed_files,对齐 Node 55b1c35 契约):镜像提交只 stage 通知
/// 宣称的那批文件(含删除 —— `add -A -- path` 同样登记删除),绝不再
/// `add -A` 全吞 —— 否则「回声通知未结清 + 用户并发改动」时,用户的未提交
/// 修改会被旧通知的消息打包带走(实测 2026-11-04 回声吞变更事故)。清单为空
/// (旧对端没给清单)才退回全量兜底。内容已在本地(staged 无差异)时仍落
/// --allow-empty 空提交:两端提交链对齐是既有契约,范围收敛后空提交不再吞
/// 任何内容,链上多一笔镜像记录无害。
pub async fn auto_commit(
  folder : String,
  message : String,
  changed_files~ : Array[String] = [],
) -> AutoCommitResult {
  let fail = (err : String) => {
    success: false,
    skipped: false,
    hash: None,
    error: Some(err),
  }
  // 基线 HEAD:提交阶段失败后的「实际成功」探测用它判前进
  let before_head = get_last_commit_hash(folder)
  // stage:有清单按清单精确 stage,无清单退回全量;两种路径都把 syncx 的
  // 在途中间态挡在外面(负向 pathspec / 精确清单不冲突)。add 阶段失败不
  // 探测:提交还没跑,HEAD 不可能因本次提交前进(探测也只会落回失败,白花
  // 两笔 git 调用),直接按失败上报。
  let paths : Array[String] = {
    let trimmed : Array[String] = []
    for path in changed_files {
      let t = path.trim().to_owned()
      if t != "" {
        trimmed.push(t)
      }
    }
    if trimmed.length() > 0 {
      trimmed
    } else {
      scratch_pathspecs()
    }
  }
  let (add_code, _, add_err) = run_git(
    "git",
    folder,
    ["add", "-A", "--", ..paths],
  ) catch {
    SpawnFailed(m) => return fail("git 拉起失败:\{m}")
    GitFailed(m) => return fail(m)
  }
  if add_code != 0 {
    return fail(
      if first_line(add_err) != "" {
        first_line(add_err)
      } else {
        "git add 失败(退出码 \{add_code})"
      },
    )
  }
  // 提交:参数数组形式,不走 shell,无注入面。失败走 HEAD 探测再定成败
  let (commit_code, _, commit_err) = run_git("git", folder, [
    "commit", "-m", message, "--allow-empty",
  ]) catch {
    SpawnFailed(m) =>
      // 拉起失败 = 进程根本没跑,提交不可能落盘;探测兜一道仍按保守口径
      return commit_failed_probe(
        folder,
        before_head,
        message,
        "git 拉起失败:\{m}",
      )
    GitFailed(m) => return commit_failed_probe(folder, before_head, message, m)
  }
  if commit_code != 0 {
    let err_text = if first_line(commit_err) != "" {
      first_line(commit_err)
    } else {
      "git commit 失败(退出码 \{commit_code})"
    }
    return commit_failed_probe(folder, before_head, message, err_text)
  }
  // 新提交哈希:rev-parse 在 commit 之后失败极罕见,如实报错而非静默
  let hash = get_last_commit_hash(folder) catch { _ => None }
  { success: true, skipped: false, hash, error: None, }
}

///|
/// 提交阶段失败后的「实际成功」探测:HEAD 前进了(相对 before_head;空仓库
/// 基线为 None 时首个提交也算前进)且 HEAD 消息与本次一致 = 提交实际成功,
/// 按成功结算;否则一律静默回落「按失败上报」(探测自身的任何失败也如此,
/// 与 Node 口径一致)。
async fn commit_failed_probe(
  folder : String,
  before_head : String?,
  message : String,
  err : String,
) -> AutoCommitResult {
  let after_head = get_last_commit_hash(folder)
  match after_head {
    Some(after) => {
      let advanced = match before_head {
        Some(before) => after != before
        None => true
      }
      if advanced && head_message_matches(folder, message) {
        return {
          success: true,
          skipped: false,
          hash: Some(after),
          error: None,
        }
      }
    }
    None => ()
  }
  { success: false, skipped: false, hash: None, error: Some(err), }
}

///|
/// HEAD 的完整提交正文(%B)与本次消息是否一致(两侧 trim 后比对)。
/// 读取失败(非仓库 / git 不可用等)一律按不一致处理,保守回落失败。
async fn head_message_matches(folder : String, message : String) -> Bool {
  let (code, out, _) = run_git("git", folder, ["log", "-1", "--format=%B"]) catch {
    _ => return false
  }
  if code != 0 {
    return false
  }
  out.trim().to_owned() == message.trim().to_owned()
}

///|
/// 变更触发的自动提交:工作树干净时跳过(不产空提交日志噪声),否则照
/// auto_commit 落一笔。Node 侧由调用方先用 hasUncommittedChanges 判定,
/// 这里收拢为一个原子入口,消掉「判定与提交之间工作树翻转」的竞态窗口
/// —— 翻转成脏了正好提交,翻转变净则 skip,两种结果都正确。
pub async fn auto_commit_if_dirty(
  folder : String,
  message : String,
) -> AutoCommitResult {
  if !has_uncommitted_changes(folder) {
    return { success: true, skipped: true, hash: None, error: None, }
  }
  auto_commit(folder, message)
}

///|
/// 对目录执行 `git push`:推当前分支到它配置的上游,不带 -u、不 fetch、
/// 不改变其余语义。GIT_TERMINAL_PROMPT=0 让缺凭据时 git 立刻报错,而不是
/// 等一个永远不会出现的终端输入。
pub async fn git_push(
  folder : String,
  timeout_ms~ : Int32 = GIT_PUSH_TIMEOUT_MS,
) -> GitPushResult {
  let (code, _, err) = @async.with_timeout(timeout_ms, () => {
    @process.collect_output(
      "git",
      ["push"],
      extra_env=Map([("GIT_TERMINAL_PROMPT", "0")]),
      cwd=folder,
      no_console_window=true,
    )
  }) catch {
    // 超时被杀时 stderr 可能是空的;这里统一给一句能定位的文案
    _ =>
      return {
        ok: false,
        error: Some(
          "git push 失败(超时 >\{timeout_ms / 1000}s 或拉起失败)",
        ),
      }
  }
  if code != 0 {
    // 超时被杀时 stderr 可能是空的,不能只交空串
    let err_text = err.text() catch { _ => "" }
    let line = first_line(err_text)
    return {
      ok: false,
      error: Some(
        if line != "" {
          line
        } else {
          "git push 失败(退出码 \{code})"
        },
      ),
    }
  }
  { ok: true, error: None, }
}

///|
/// 单目录的 git 观察器:记住上次看到的 HEAD 基线,扫描末尾调用
/// check_new_commit 即可发现「两次扫描之间产生的新提交」(定时/变更触发,
/// 复用扫描节拍,不额外起定时器 —— 照 Node checkGitCommits 的口径)。
/// last_hash 对应 Node 落盘字段 gitLastCommitHash;持久化由上层 config 负责。
pub(all) struct GitWatcher {
  /// 共享目录绝对路径。
  root : String
  /// 该目录的 gitSync 模式(观察器本身不闸模式,策略由调用方套;
  /// 配置热重载就地更新)。
  mut mode : GitSyncMode
  /// 上次观测到的 HEAD 提交哈希;None = 尚未建立基线或当前不是仓库。
  mut last_hash : String?
}

///|
pub fn GitWatcher::new(root : String, mode : GitSyncMode) -> GitWatcher {
  { root, mode, last_hash: None, }
}

///|
/// 检测自上次调用以来是否产生了新提交:
///  - 非仓库:清掉基线(免得日后重建仓库时拿旧哈希去比对),返回 None;
///  - 空仓库 / 无 HEAD:返回 None;
///  - 无基线(首次启用 / 重启后配置里没有):只记录基线不广播 —— 这是
///    「绝不重放历史提交」的兜底,首次启用时把整段历史推出去才是真灾难;
///  - HEAD 与基线相同:返回 None;
///  - 有新提交:返回 CommitInfo,并把基线推进到新 HEAD(照 Node 口径:
///    基线在检测当轮推进,送达保证交给上层待回执台账)。
pub async fn GitWatcher::check_new_commit(self : GitWatcher) -> CommitInfo? {
  if !is_git_repo(self.root) {
    self.last_hash = None
    return None
  }
  let current = get_last_commit_hash(self.root)
  match current {
    None => None
    Some(h) =>
      match self.last_hash {
        None => {
          self.last_hash = Some(h)
          None
        }
        Some(prev) => {
          if prev == h {
            return None
          }
          let info = get_commit_info(self.root, prev, h)
          self.last_hash = Some(h)
          info
        }
      }
  }
}
