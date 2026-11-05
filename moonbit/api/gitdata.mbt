///|
/// Git 弹窗数据面路由(「Git 改动 / 提交历史 / 推送」三弹窗的后端数据源)。
/// 解析与读取在 daemon 层(daemon/gitdata.mbt),这里只做:目录定位、参数
/// 校验、形状折算(JSON 字段名与 web/types.ts 逐字对齐)、错误口径翻译
/// (400 带文案,与 Node 路由逐字对齐)。

///|
/// 推送重入闸(单 daemon 单事件循环,check-and-set 之间无 await 点 = 原子;
/// 对齐 Node session-manager 的 gitPushRunning —— 凭据缺失/网络黑洞不能让
/// 整批「一键推送」把弹窗拖死)。
let git_push_guard : Ref[Bool] = Ref(false)

///|
/// 历史重写重入闸(与 push 互斥:重写期间推送被拒、推送期间重写被拒;
/// 对齐 Node 的 gitRewriteRunning ⇄ gitPushRunning 双向检查)。
let git_rewrite_guard : Ref[Bool] = Ref(false)

///|
/// 仓库相对路径的安全闸:拒绝绝对路径、目录穿越与盘符样式的输入。
/// `git show` 不经 resolveSharePath,这里必须自己把好这道门。
fn git_rel_path_error(rel_path : String) -> String? {
  if rel_path == "" || rel_path.has_prefix("/") || rel_path.contains("\\") {
    return Some("非法的文件路径")
  }
  for seg in rel_path.split("/") {
    if seg == ".." {
      return Some("非法的文件路径")
    }
  }
  None
}

///|
/// git 失败 → 文案。「找不到对象」类失败翻译成弹窗能懂的口径:哈希曾被列出
/// 但此刻查不到,几乎总是历史被重写(rebase/amend)或提交被回收;其余失败
/// 原样透出,不冒充「提交不存在」。
fn git_error_text(e : Error) -> String {
  let text = match e {
    @daemon.SpawnFailed(t) => t
    @daemon.GitFailed(t) => t
    other => @debug.to_string(other)
  }
  let lower = text.to_lower()
  let lookup_miss = lower.contains("bad object") ||
    lower.contains("unknown revision") ||
    lower.contains("ambiguous argument") ||
    lower.contains("invalid object name")
  if lookup_miss {
    "提交不存在(可能已被重写或回收)"
  } else {
    text
  }
}

///|
/// 按 folderId 定位共享目录(id 缺省回退 path);不存在回 400(Node 装配层
/// 抛错文案逐字)。
async fn git_folder_of(
  options : ApiOptions,
  folder_id : String,
) -> @core.SharedFolder? {
  let config = load_config(options.config_file)
  find_config_folder(config, folder_id)
}

///|
fn git_change_entry_json(e : @daemon.GitChangeEntry) -> Json {
  let map : Map[String, Json] = Map([])
  map.set("path", Json::string(e.path))
  if e.dir {
    map.set("dir", Json::boolean(true))
  }
  map.set("status", Json::string(e.status))
  match e.orig_path {
    Some(orig) => map.set("origPath", Json::string(orig))
    None => ()
  }
  map.set("staged", Json::boolean(e.staged))
  Json::object(map)
}

///|
fn git_commit_entry_json(e : @daemon.GitCommitEntry) -> Json {
  let map : Map[String, Json] = Map([])
  map.set("hash", Json::string(e.hash))
  map.set("subject", Json::string(e.subject))
  map.set("body", Json::string(e.body))
  map.set("author", Json::string(e.author))
  map.set("date", Json::string(e.date))
  map.set("refs", Json::string(e.refs))
  Json::object(map)
}

///|
fn git_commit_file_entry_json(e : @daemon.GitCommitFileEntry) -> Json {
  let map : Map[String, Json] = Map([])
  map.set("status", Json::string(e.status))
  map.set("path", Json::string(e.path))
  match e.orig_path {
    Some(orig) => map.set("origPath", Json::string(orig))
    None => ()
  }
  Json::object(map)
}

///|
/// GET /api/folders/git-changes?folderId=xxx:工作区未提交变更清单。
/// 现查 git status:徽标计数有一轮扫描的滞后,弹窗打开那一刻必须给准的;
/// 非 git 仓库回 { gitRepo: false },前端给出解释而不是空列表。
pub async fn handle_git_changes(
  options : ApiOptions,
  event : @mocket.MocketEvent,
) -> &Responder {
  let folder_id = query_param(event, "folderId")
  if folder_id == "" {
    return json_error(event, @mocket.BadRequest, "folderId is required")
  }
  let folder = match git_folder_of(options, folder_id) {
    Some(f) => f
    None =>
      return json_error(
        event,
        @mocket.BadRequest,
        "共享目录不存在(可能刚被移除)",
      )
  }
  match @daemon.get_uncommitted_changes(folder.path) {
    None => {
      let map : Map[String, Json] = Map([])
      map.set("entries", Json::array([]))
      map.set("truncated", Json::boolean(false))
      map.set("gitRepo", Json::boolean(false))
      @mocket.HttpResponse(@mocket.OK).json(Json::object(map))
    }
    Some(result) => {
      let items : Array[Json] = []
      for entry in result.entries {
        items.push(git_change_entry_json(entry))
      }
      let map : Map[String, Json] = Map([])
      map.set("entries", Json::array(items))
      map.set("truncated", Json::boolean(result.truncated))
      @mocket.HttpResponse(@mocket.OK).json(Json::object(map))
    }
  }
}

///|
/// GET /api/folders/git-diff?folderId&path:工作区某文件 HEAD 版 vs 盘上当前。
/// 只读,不碰索引、不碰暂存区。
pub async fn handle_git_diff(
  options : ApiOptions,
  event : @mocket.MocketEvent,
) -> &Responder {
  let folder_id = query_param(event, "folderId")
  let rel_path = query_param(event, "path")
  if folder_id == "" || rel_path == "" {
    return json_error(
      event,
      @mocket.BadRequest,
      "folderId and path are required",
    )
  }
  match git_rel_path_error(rel_path) {
    Some(err) => return json_error(event, @mocket.BadRequest, err)
    None => ()
  }
  let folder = match git_folder_of(options, folder_id) {
    Some(f) => f
    None =>
      return json_error(
        event,
        @mocket.BadRequest,
        "共享目录不存在(可能刚被移除)",
      )
  }
  let head = side_from_head_read(
    @daemon.read_file_at(folder.path, "HEAD", rel_path),
    rel_path,
  )
  let worktree = side_from_local_disk(folder.path, rel_path)
  let map : Map[String, Json] = Map([])
  map.set("path", Json::string(rel_path))
  map.set("head", head)
  map.set("worktree", worktree)
  @mocket.HttpResponse(@mocket.OK).json(Json::object(map))
}

///|
/// GET /api/folders/git-log?folderId[&limit=&skip=]:提交历史一页。
/// limit 缺省 20,「查看更多」带 skip 递增;非法 limit/skip 回 400 而不是
/// 静默当默认值 —— 参数打错时静默等于「分页永远停在第一页」,比报错更难查。
pub async fn handle_git_log(
  options : ApiOptions,
  event : @mocket.MocketEvent,
) -> &Responder {
  let folder_id = query_param(event, "folderId")
  if folder_id == "" {
    return json_error(event, @mocket.BadRequest, "folderId is required")
  }
  let raw_limit = query_param(event, "limit")
  let raw_skip = query_param(event, "skip")
  let limit : Int32 = if raw_limit == "" {
    @daemon.GIT_LOG_LIMIT
  } else {
    @string.parse_int(raw_limit) catch {
      _ => -1
    }
  }
  let skip : Int32 = if raw_skip == "" {
    0
  } else {
    @string.parse_int(raw_skip) catch {
      _ => -1
    }
  }
  if limit < 1 || skip < 0 {
    return json_error(
      event,
      @mocket.BadRequest,
      "limit must be a positive integer and skip a non-negative integer",
    )
  }
  let folder = match git_folder_of(options, folder_id) {
    Some(f) => f
    None =>
      return json_error(
        event,
        @mocket.BadRequest,
        "共享目录不存在(可能刚被移除)",
      )
  }
  let clamped = if limit > @daemon.MAX_GIT_LOG_LIMIT {
    @daemon.MAX_GIT_LOG_LIMIT
  } else {
    limit
  }
  let commits = @daemon.list_recent_commits(folder.path, limit=clamped, skip~) catch {
    e => return json_error(event, @mocket.BadRequest, git_error_text(e))
  }
  let items : Array[Json] = []
  let git_repo = commits is Some(_)
  for entry in commits.unwrap_or([]) {
    items.push(git_commit_entry_json(entry))
  }
  let map : Map[String, Json] = Map([])
  map.set("commits", Json::array(items))
  map.set("gitRepo", Json::boolean(git_repo))
  @mocket.HttpResponse(@mocket.OK).json(Json::object(map))
}

///|
/// GET /api/folders/git-commit-files?folderId&hash:某笔提交动了哪些文件
/// (提交历史/推送弹窗展开某笔提交)。
pub async fn handle_git_commit_files(
  options : ApiOptions,
  event : @mocket.MocketEvent,
) -> &Responder {
  let folder_id = query_param(event, "folderId")
  let hash = query_param(event, "hash")
  if folder_id == "" || hash == "" {
    return json_error(
      event,
      @mocket.BadRequest,
      "folderId and hash are required",
    )
  }
  let folder = match git_folder_of(options, folder_id) {
    Some(f) => f
    None =>
      return json_error(
        event,
        @mocket.BadRequest,
        "共享目录不存在(可能刚被移除)",
      )
  }
  let git_repo = @daemon.is_git_repo(folder.path)
  let files : Array[Json] = []
  if git_repo {
    let entries = @daemon.list_commit_files(folder.path, hash) catch {
      e => return json_error(event, @mocket.BadRequest, git_error_text(e))
    }
    for entry in entries {
      files.push(git_commit_file_entry_json(entry))
    }
  }
  let map : Map[String, Json] = Map([])
  map.set("files", Json::array(files))
  map.set("gitRepo", Json::boolean(git_repo))
  @mocket.HttpResponse(@mocket.OK).json(Json::object(map))
}

///|
/// GET /api/folders/git-commit-diff?folderId&hash&path[&origPath]:某笔提交里
/// 某文件的「上一版(首父提交)→ 该提交」对比。origPath 是改名文件在父提交
/// 里的旧路径 —— 不传的话父侧直读新路径会谎报「上一版没有」。
pub async fn handle_git_commit_diff(
  options : ApiOptions,
  event : @mocket.MocketEvent,
) -> &Responder {
  let folder_id = query_param(event, "folderId")
  let hash = query_param(event, "hash")
  let rel_path = query_param(event, "path")
  let orig_path = query_param(event, "origPath")
  if folder_id == "" || hash == "" || rel_path == "" {
    return json_error(
      event,
      @mocket.BadRequest,
      "folderId, hash and path are required",
    )
  }
  match git_rel_path_error(rel_path) {
    Some(err) => return json_error(event, @mocket.BadRequest, err)
    None => ()
  }
  if orig_path != "" {
    match git_rel_path_error(orig_path) {
      Some(err) => return json_error(event, @mocket.BadRequest, err)
      None => ()
    }
  }
  let folder = match git_folder_of(options, folder_id) {
    Some(f) => f
    None =>
      return json_error(
        event,
        @mocket.BadRequest,
        "共享目录不存在(可能刚被移除)",
      )
  }
  if !@daemon.is_git_repo(folder.path) {
    return json_error(event, @mocket.BadRequest, "该目录不是 git 仓库")
  }
  let parents = @daemon.get_commit_parents(folder.path, hash) catch {
    e => return json_error(event, @mocket.BadRequest, git_error_text(e))
  }
  // 左侧 = 首父(「上一版」取主干侧;根提交没有父 → exists:false)
  let left_path = if orig_path != "" { orig_path } else { rel_path }
  let parent_read = match parents.get(0) {
    Some(parent) => @daemon.read_file_at(folder.path, parent, left_path)
    None => @daemon.head_read_absent()
  }
  let commit_read = @daemon.read_file_at(folder.path, hash, rel_path)
  let map : Map[String, Json] = Map([])
  map.set("path", Json::string(rel_path))
  map.set("parent", side_from_head_read(parent_read, left_path))
  map.set("commit", side_from_head_read(commit_read, rel_path))
  @mocket.HttpResponse(@mocket.OK).json(Json::object(map))
}

///|
/// GET /api/folders/git-unpushed[?folderId]:尚未推送到上游的提交(「Git 推送」
/// 弹窗数据源)。只读盘上的 git(取本机记录的上游,绝不 fetch);只返回
/// 「此刻确实有未推送提交」的目录 —— 与「未推送 N」徽标同一口径。现查的同时
/// 把徽标缓存对齐到现查值(含归零):弹窗所列与徽标当场一致,不必等下一轮
/// 30s 徽标循环(对齐 Node listUnpushedByFolder)。
pub async fn handle_git_unpushed(
  options : ApiOptions,
  event : @mocket.MocketEvent,
) -> &Responder {
  let folder_id = query_param(event, "folderId")
  let config = load_config(options.config_file)
  let folders : Array[@core.SharedFolder] = if folder_id == "" {
    config.shared_folders
  } else {
    match find_config_folder(config, folder_id) {
      Some(f) => [f]
      None =>
        return json_error(
          event,
          @mocket.BadRequest,
          "共享目录不存在(可能刚被移除)",
        )
    }
  }
  // 徽标缓存基线:有差异才回写(actor 单测等未接 actor 的装配直接跳过)
  let cache : Map[String, Int32] = Map([])
  match options.actor {
    Some(handle) =>
      for row in handle.snapshot().folders {
        cache.set(row.id, row.git_unpushed)
      }
    None => ()
  }
  let rows : Array[Json] = []
  for folder in folders {
    let total = @daemon.count_unpushed_commits(folder.path)
    let observed = total.unwrap_or(0)
    if cache.get(folder.folder_id()).unwrap_or(0) != observed {
      match options.actor {
        Some(handle) => {
          let _ = handle.send(
            @daemon.Cmd::GitUnpushedObserved(
              folder=folder.folder_id(),
              total=observed,
            ),
          )
        }
        None => ()
      }
    }
    match total {
      Some(n) =>
        if n > 0 {
          // 列表读取失败(与 count 同生共死,留个兜底)时仍列目录:total 准确、列表空
          let commits = @daemon.list_unpushed_commits(folder.path).unwrap_or([])
          let items : Array[Json] = []
          for entry in commits {
            items.push(git_commit_entry_json(entry))
          }
          let row : Map[String, Json] = Map([])
          row.set("folderId", Json::string(folder.folder_id()))
          row.set("path", Json::string(folder.path))
          row.set("total", Json::number(n.to_double()))
          row.set("commits", Json::array(items))
          row.set("truncated", Json::boolean(n > @daemon.GIT_UNPUSHED_LIMIT))
          rows.push(Json::object(row))
        }
      None => ()
    }
  }
  let map : Map[String, Json] = Map([])
  map.set("folders", Json::array(rows))
  @mocket.HttpResponse(@mocket.OK).json(Json::object(map))
}

///|
/// POST /api/folders/git-push { folderId }:推送单个目录(推送弹窗按目录顺序
/// 逐个调用)。网络操作最长 120s;已有推送进行中 → 400(前端记为该行失败)。
/// 推完现查回写徽标缓存,推送按钮旁的「未推送 N」当场收敛。
pub async fn handle_git_push(
  options : ApiOptions,
  event : @mocket.MocketEvent,
) -> &Responder {
  let body = match parse_json_body(event) {
    Some(body) => body
    None => return json_error(event, @mocket.BadRequest, "invalid json body")
  }
  let obj = match body {
    Object(obj) => obj
    _ => return json_error(event, @mocket.BadRequest, "invalid json body")
  }
  let folder_id = match non_empty_string(obj, "folderId") {
    Some(id) => id
    None => return json_error(event, @mocket.BadRequest, "folderId is required")
  }
  let folder = match git_folder_of(options, folder_id) {
    Some(f) => f
    None =>
      return json_error(
        event,
        @mocket.BadRequest,
        "共享目录不存在(可能刚被移除)",
      )
  }
  if !@daemon.is_git_repo(folder.path) {
    return json_error(event, @mocket.BadRequest, "该目录不是 git 仓库")
  }
  if git_push_guard.val {
    return json_error(
      event,
      @mocket.BadRequest,
      "已有推送正在进行,请稍候",
    )
  }
  git_push_guard.val = true
  let result = @daemon.git_push(folder.path)
  git_push_guard.val = false
  let fallback = match result.error {
    Some(err) => err
    None => "?"
  }
  match result {
    { ok: true, .. } =>
      @log.info("git push ok: \{folder.folder_id()} (\{folder.path})", [])
    { ok: false, error: _, } =>
      @log.warn(
        "git push failed: \{folder.folder_id()} (\{folder.path}): \{fallback}",
        [],
      )
  }
  // 现查回写徽标缓存(推送成功归零 / 失败保持),与弹窗当场一致
  let observed = @daemon.count_unpushed_commits(folder.path).unwrap_or(0)
  match options.actor {
    Some(handle) => {
      let _ = handle.send(
        @daemon.Cmd::GitUnpushedObserved(
          folder=folder.folder_id(),
          total=observed,
        ),
      )
    }
    None => ()
  }
  let map : Map[String, Json] = Map([])
  map.set("ok", Json::boolean(result.ok))
  match result.error {
    Some(err) => map.set("error", Json::string(err))
    None => ()
  }
  @mocket.HttpResponse(@mocket.OK).json(Json::object(map))
}

///|
/// 剔除的主体流程(重入闸已在外层同步段置位;所有失败走 Err,由调用方在
/// 单一出口把闸清掉 —— MoonBit 无 try/finally,收拢出口替代 finally)。
async fn strip_coauthored_inner(
  options : ApiOptions,
  folder_id : String,
) -> Result[Json, String] {
  println("STRIP:enter")
  let folder = match git_folder_of(options, folder_id) {
    Some(f) => f
    None => return Err("共享目录不存在(可能刚被移除)")
  }
  println("STRIP:repo-ok")
  if !@daemon.is_git_repo(folder.path) {
    return Err("该目录不是 git 仓库")
  }
  println("STRIP:is-repo")
  // 先单独确认上游存在:区分「未设置上游」(结构性不可用)与区间为空(正常态)
  println("STRIP:upstream-check")
  if @daemon.get_upstream_commit_hash(folder.path) is None {
    return Err(
      "未设置上游分支(远程未配置或从未推送),没有可剔除的未推送区间",
    )
  }
  // 预统计:区间内哪些提交的消息会被剔除规则改写(与重写过滤器同一条规则)
  let messages = match
    @daemon.list_raw_commit_messages(folder.path, "@{upstream}..HEAD") {
    Some(m) => m
    None => return Err("读取未推送提交失败")
  }
  if messages.length() == 0 {
    let map : Map[String, Json] = Map([])
    map.set("ok", Json::boolean(true))
    map.set("stripped", Json::number(0))
    map.set("rewritten", Json::number(0))
    return Ok(Json::object(map))
  }
  let mut stripped = 0
  for message in messages {
    if @daemon.strip_co_authored_lines(message) != message {
      stripped = stripped + 1
    }
  }
  // 工作区必须干净(syncx 在途中间态照旧豁免)才动历史:重写期间叠加未提交
  // 改动,会把中间态一起写进重写后的历史
  println("STRIP:dirty-check")
  if @daemon.has_uncommitted_changes(folder.path) {
    return Err(
      "工作区有未提交的变更,请先提交或暂存后再剔除",
    )
  }
  println("STRIP:rewriting")
  let result = @daemon.rewrite_commit_messages(folder.path, "@{upstream}..HEAD")
  if !result.ok {
    return Err(result.error.unwrap_or("git 历史重写失败"))
  }
  @log.info(
    "git strip co-authored ok: \{folder_id} (\{folder.path}): \{stripped}/\{messages.length()} 提交被剔除尾注",
    [],
  )
  // 重写只改消息,提交个数不变;计数照常重算(与 push 收尾同一套)
  let observed = @daemon.count_unpushed_commits(folder.path).unwrap_or(0)
  match options.actor {
    Some(handle) => {
      let _ = handle.send(
        @daemon.Cmd::GitUnpushedObserved(folder=folder_id, total=observed),
      )
      // 基线推进到重写后的 HEAD:旧基线哈希已不在分支上,滞留会让下一轮扫描
      // 把整个重写区间误判成「新提交」再广播一遍给对端
      match @daemon.get_last_commit_hash(folder.path) {
        Some(head) => {
          let _ = handle.send(
            @daemon.Cmd::GitBaseline(folder=folder_id, hash=head),
          )
        }
        None => ()
      }
    }
    None => ()
  }
  let map : Map[String, Json] = Map([])
  map.set("ok", Json::boolean(true))
  map.set("stripped", Json::number(stripped.to_double()))
  map.set("rewritten", Json::number(messages.length().to_double()))
  Ok(Json::object(map))
}

///|
/// POST /api/folders/git-strip-coauthored-unpushed { folderId }:一键剔除未推送
/// 提交里的 Co-Authored-By 行(filter-branch 重写未推送区间的提交消息,哈希会
/// 变)。响应 { ok, stripped, rewritten };400 带原因;区间为空 → ok 且 0/0。
/// 入场闸先于一切 await 置位(Node gitRewriteStarting 同款):重入判定必须
/// 发生在调用返回之前的同步段里,否则并发第二发会跟着跑重写。
pub async fn handle_git_strip_coauthored_unpushed(
  options : ApiOptions,
  event : @mocket.MocketEvent,
) -> &Responder {
  let body = match parse_json_body(event) {
    Some(body) => body
    None => return json_error(event, @mocket.BadRequest, "invalid json body")
  }
  let obj = match body {
    Object(obj) => obj
    _ => return json_error(event, @mocket.BadRequest, "invalid json body")
  }
  let folder_id = match non_empty_string(obj, "folderId") {
    Some(id) => id
    None => return json_error(event, @mocket.BadRequest, "folderId is required")
  }
  // 同步段:检查双向互斥闸并置位重写闸(其后第一个 await 之前不会被切走)
  if git_push_guard.val {
    return json_error(
      event,
      @mocket.BadRequest,
      "已有推送正在进行,请稍候",
    )
  }
  if git_rewrite_guard.val {
    return json_error(
      event,
      @mocket.BadRequest,
      "已有提交信息剔除正在进行,请稍候",
    )
  }
  git_rewrite_guard.val = true
  let outcome = strip_coauthored_inner(options, folder_id)
  println("STRIP:guard-release")
  git_rewrite_guard.val = false
  match outcome {
    Ok(json) => @mocket.HttpResponse(@mocket.OK).json(json)
    Err(reason) => return json_error(event, @mocket.BadRequest, reason)
  }
}

// ==================== 「自动提交失败」弹窗(status / 锁 / retry) ====================

///|
/// GET /api/folders/git-commit-status?folderId:「自动提交失败」弹窗的数据源。
/// 台账部分来自镜像提供器(cli 注入;None = 未接镜像,回 pending:false 的
/// 缺省形状),lock 现查 —— 打开弹窗 / 每次操作后都要反映盘上事实,不使用
/// 错误文案里那一刻的路径快照(对齐 Node getGitAutoCommitStatus)。
pub async fn handle_git_commit_status(
  options : ApiOptions,
  event : @mocket.MocketEvent,
) -> &Responder {
  let folder_id = query_param(event, "folderId")
  if folder_id == "" {
    return json_error(event, @mocket.BadRequest, "folderId is required")
  }
  let folder = match git_folder_of(options, folder_id) {
    Some(f) => f
    None =>
      return json_error(
        event,
        @mocket.BadRequest,
        "共享目录不存在(可能刚被移除)",
      )
  }
  let map : Map[String, Json] = Map([])
  match options.git_commit_status {
    Some(provider) =>
      match provider(folder_id) {
        // 镜像台账部分原样并入(pending/commitMessage/changedFiles/attempts/
        // maxAttempts/retryAt/givenUp/error)
        Some(part) =>
          match part {
            Object(fields) =>
              for key, value in fields {
                map.set(key, value)
              }
            _ => ()
          }
        None => ()
      }
    None => {
      // 未接镜像:pending:false 的缺省形状(maxAttempts 与 cli 侧
      // GIT_AUTO_COMMIT_MAX_ATTEMPTS 同值;跨包常量不走反向依赖)
      map.set("pending", Json::boolean(false))
      map.set("changedFiles", Json::array([]))
      map.set("attempts", Json::number(0))
      map.set("maxAttempts", Json::number(5))
      map.set("givenUp", Json::boolean(false))
    }
  }
  match @daemon.find_index_lock(folder.path) {
    Some(lock) => {
      let lm : Map[String, Json] = Map([])
      lm.set("path", Json::string(lock.path))
      lm.set("size", Json::number(lock.size.to_double()))
      lm.set("mtimeMs", Json::number(lock.mtime_ms.to_double()))
      map.set("lock", Json::object(lm))
    }
    None => map.set("lock", Json::null())
  }
  @mocket.HttpResponse(@mocket.OK).json(Json::object(map))
}

///|
/// POST /api/folders/git-index-lock/delete { folderId }:删除残留的 index.lock。
/// 只删 git 指认的那一个文件,不接收调用方路径;用户须先确认没有其它 git 进程
/// 在操作(弹窗里有二次确认)。删完不清错误横幅 —— 这一笔仍未提交。
pub async fn handle_git_index_lock_delete(
  options : ApiOptions,
  event : @mocket.MocketEvent,
) -> &Responder {
  let body = match parse_json_body(event) {
    Some(body) => body
    None => return json_error(event, @mocket.BadRequest, "invalid json body")
  }
  let obj = match body {
    Object(obj) => obj
    _ => return json_error(event, @mocket.BadRequest, "invalid json body")
  }
  let folder_id = match non_empty_string(obj, "folderId") {
    Some(id) => id
    None => return json_error(event, @mocket.BadRequest, "folderId is required")
  }
  let folder = match git_folder_of(options, folder_id) {
    Some(f) => f
    None =>
      return json_error(
        event,
        @mocket.BadRequest,
        "共享目录不存在(可能刚被移除)",
      )
  }
  let result = @daemon.remove_index_lock(folder.path)
  let map : Map[String, Json] = Map([])
  map.set("ok", Json::boolean(result.ok))
  match result.path {
    Some(p) => map.set("path", Json::string(p))
    None => ()
  }
  match result.removed {
    Some(removed) => map.set("removed", Json::boolean(removed))
    None => ()
  }
  match result.error {
    Some(err) => map.set("error", Json::string(err))
    None => ()
  }
  @mocket.HttpResponse(@mocket.OK).json(Json::object(map))
}

///|
/// POST /api/folders/git-commit-retry { folderId }:手动重试自动提交。
/// 仍走完整结算闸门(在途接收/索引交换/暂停),被挡时如实回报「仍被延后」。
pub async fn handle_git_commit_retry(
  options : ApiOptions,
  event : @mocket.MocketEvent,
) -> &Responder {
  match options.git_commit_retry {
    None => {
      // 503 短路前必须排空请求体:mocket 的 MemoryReader 写协程要等 body
      // 被消费才收尾,丢着不管会卡住事件循环(见 routes.mbt drain_body 注释)
      drain_body(event)
      return json_error(
        event,
        @mocket.ServiceUnavailable,
        "镜像台账未接线",
      )
    }
    Some(retry) => {
      let body = match parse_json_body(event) {
        Some(body) => body
        None =>
          return json_error(event, @mocket.BadRequest, "invalid json body")
      }
      let obj = match body {
        Object(obj) => obj
        _ => return json_error(event, @mocket.BadRequest, "invalid json body")
      }
      let folder_id = match non_empty_string(obj, "folderId") {
        Some(id) => id
        None =>
          return json_error(event, @mocket.BadRequest, "folderId is required")
      }
      let result = retry(folder_id)
      @mocket.HttpResponse(@mocket.OK).json(result)
    }
  }
}
