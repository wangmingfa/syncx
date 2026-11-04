///|
/// 空目录盘点与清理的 API 面(对齐 Node `src/api/routes/folders.ts` 两个端点与
/// `src/session-manager.ts` 的装配语义):
///   - GET  /api/folders/empty-dirs?folderId=                 盘点 {dirs, truncated}
///   - POST /api/folders/empty-dirs/delete {folderId, paths}  删除 {results:[{path,ok,reason?}]}
///
/// 刻意**不触发扫描、不碰索引**(目录不是同步实体,删除不产生任何需要广播的
/// 东西,与 Node 同一个差异理由;versions/trash 端点的 trigger_folder_scan 在
/// 这里没有对应物)。删除只 rmdir、绝不删文件,逐条结果带原因。

///|
/// 其它共享根的归一化路径集合(嵌套屏障;语义与 Node nestedRootsFor 一致,
/// 与 daemon actor 扫描装配的嵌套根换算同一口径)。
fn nested_roots_for(config : @core.Config, folder_id : String) -> Array[String] {
  let out : Array[String] = []
  for folder in config.shared_folders {
    if folder.folder_id() != folder_id {
      out.push(@daemon.normalize_path(folder.path))
    }
  }
  out
}

///|
/// 空目录工具用的忽略规则:现读磁盘的 .gitignore(按配置)+ .syncxignore,
/// 与扫描同源(Node emptyDirRulesFor 同装配)。
async fn empty_dir_rules_for(folder : @core.SharedFolder) -> @core.IgnoreRuleset {
  @core.IgnoreRuleset::from_lines(
    @daemon.read_folder_ignore_lines(folder.path, folder.use_gitignore_enabled()),
  )
}

///|
/// GET /api/folders/empty-dirs?folderId=xxx:盘点空文件夹(「空文件夹」弹窗)。
/// 只读。folderId 缺失 → 400 "folderId is required";目录不存在 → 400
/// "共享目录不存在(可能刚被移除)"(Node 装配层抛错文案逐字)。
pub async fn handle_list_empty_dirs(
  options : ApiOptions,
  event : @mocket.MocketEvent,
) -> &Responder {
  let folder_id = query_param(event, "folderId")
  if folder_id == "" {
    return json_error(event, @mocket.BadRequest, "folderId is required")
  }
  let config = load_config(options.config_file)
  let folder = match find_config_folder(config, folder_id) {
    Some(f) => f
    None =>
      return json_error(event, @mocket.BadRequest, "共享目录不存在(可能刚被移除)")
  }
  let scan = @daemon.scan_empty_dirs(
    folder.path,
    empty_dir_rules_for(folder),
    nested_roots_for(config, folder_id),
  )
  let items : Array[Json] = []
  for d in scan.dirs {
    items.push(Json::string(d))
  }
  let map : Map[String, Json] = Map([])
  map.set("dirs", Json::array(items))
  map.set("truncated", Json::boolean(scan.truncated))
  @mocket.HttpResponse(@mocket.OK).json(Json::object(map))
}

///|
/// POST /api/folders/empty-dirs/delete {folderId, paths}:删除勾选的空文件夹。
/// 逐条结果(ok/reason);只 rmdir、绝不删文件,不触发扫描(目录不是同步实体)。
/// folderId 缺失 → 400 "folderId is required";paths 不是非空字符串数组 →
/// 400 "paths must be a non-empty string array";条数超上限 → 400
/// "too many paths (max 2000)"(封顶与扫描上限 EMPTY_DIRS_MAX 同源)。
pub async fn handle_delete_empty_dirs(
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
  let raw_paths : Array[Json] = match obj.get("paths") {
    Some(Array(items)) => items
    _ =>
      return json_error(event, @mocket.BadRequest, "paths must be a non-empty string array")
  }
  if raw_paths.length() == 0 {
    return json_error(event, @mocket.BadRequest, "paths must be a non-empty string array")
  }
  let paths : Array[String] = []
  for item in raw_paths {
    match item {
      String(s) =>
        if s == "" {
          return json_error(
            event,
            @mocket.BadRequest,
            "paths must be a non-empty string array",
          )
        } else {
          paths.push(s)
        }
      _ =>
        return json_error(event, @mocket.BadRequest, "paths must be a non-empty string array")
    }
  }
  if paths.length() > @daemon.EMPTY_DIRS_MAX {
    return json_error(
      event,
      @mocket.BadRequest,
      "too many paths (max \{@daemon.EMPTY_DIRS_MAX})",
    )
  }
  let config = load_config(options.config_file)
  let folder = match find_config_folder(config, folder_id) {
    Some(f) => f
    None =>
      return json_error(event, @mocket.BadRequest, "共享目录不存在(可能刚被移除)")
  }
  let results = @daemon.remove_empty_dirs(
    folder.path,
    paths,
    empty_dir_rules_for(folder),
    nested_roots_for(config, folder_id),
  )
  let mut removed = 0
  let items : Array[Json] = []
  for r in results {
    if r.ok {
      removed += 1
    }
    let item : Map[String, Json] = Map([])
    item.set("path", Json::string(r.path))
    item.set("ok", Json::boolean(r.ok))
    match r.reason {
      // Node JSON.stringify 同口径:无原因时字段不出现
      Some(reason) => item.set("reason", Json::string(reason))
      None => ()
    }
    items.push(Json::object(item))
  }
  if removed > 0 {
    @log.info(
      "empty dirs removed: {Folder} ({Removed}/{Total})",
      [
        Json::string(folder_id),
        Json::number(removed.to_double()),
        Json::number(results.length().to_double()),
      ],
    )
  }
  let map : Map[String, Json] = Map([])
  map.set("results", Json::array(items))
  @mocket.HttpResponse(@mocket.OK).json(Json::object(map))
}
