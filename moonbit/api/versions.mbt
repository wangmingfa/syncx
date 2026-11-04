///|
/// 文件版本(时间机器)与回收站的操作面 —— 对齐 Node 同名能力,消除「误删/
/// 误改没有恢复入口」的盘点缺口:
///   - GET  /api/folders/versions?folderId=                版本列表 {versions:[{file,path,size,mtime}]}
///   - POST /api/folders/versions/restore {folderId,file}  恢复到原路径;当前内容先留档(可逆)
///   - POST /api/folders/versions/delete  {folderId,file}  删除单个版本文件(不可逆)
///   - GET  /api/folders/versions/content?folderId&file    单版本内容预览(≤1MB 报 text;\0 判 binary;超限 tooLarge)
///   - GET  /api/trash?folderId=                           回收站列表 {entries:[{file,path,ts,size}]}(新删在前)
///   - POST /api/trash/restore {folderId,file}             副本搬回原路径;同名实体先挪进回收站(可逆)
///   - POST /api/trash/purge   {folderId,file?}            彻底删除;file 缺省 = 清空整个回收站(不可逆)
///
/// 版本/回收站目录在 `<configDir>/{versions,trash}/<indexKey 的 sha1 前 16 位>`,
/// 与索引库同键同哈希(Node config.folderVersionsPath / folderTrashPath 同源),
/// 刻意放在共享目录之外:共享根里的常驻痕迹会被 git status 报成未跟踪文件。
/// 恢复本质是纯文件操作(版本目录/回收站 ↔ 共享根的拷贝与改名),不进 actor
/// 状态;落位后经 ActorHandle 发 Cmd::ScanFolder 触发该目录一轮扫描,把恢复
/// 产生的「本地修改/新增」尽快广播给对端 —— actor 未接(None,api 单测/最小
/// 装配)时降级为不触发,与现有路由一致。

///|
/// 索引键的 16 位十六进制短哈希:sha1(key) 前 16 字符 —— 与 Node/Rust 的
/// folderVersionsPath / folderTrashPath、本仓 cli 层 short_hash 同源;共用同一
/// 数据目录时版本/回收站目录必须同名(cli 装配层 build_folder_specs 同口径)。
pub fn folder_index_hash(key : String) -> String {
  let digest = @lib.sha1(@utf8.encode(key))
  @hex.encode(digest)[0:16].to_owned()
}

///|
/// 按 folderId 定位共享目录(id 缺省回退 path,与 Node folderIdFor 同口径;
/// 找不到由调用方转 400 "folder not found")。
fn find_config_folder(
  config : @core.Config,
  folder_id : String,
) -> @core.SharedFolder? {
  for folder in config.shared_folders {
    if folder.folder_id() == folder_id {
      return Some(folder)
    }
  }
  None
}

///|
/// 某共享目录的版本快照目录:`<configDir>/versions/<indexKey 哈希>`。
fn folder_versions_dir(options : ApiOptions, folder : @core.SharedFolder) -> String {
  "\{config_dir_of(options.config_file)}/versions/\{folder_index_hash(folder.index_key())}"
}

///|
/// 某共享目录的回收站目录:`<configDir>/trash/<indexKey 哈希>`。
fn folder_trash_dir(options : ApiOptions, folder : @core.SharedFolder) -> String {
  "\{config_dir_of(options.config_file)}/trash/\{folder_index_hash(folder.index_key())}"
}

///|
/// 读查询参数(缺参/空串统一按空串处理,调用方判 "")。
fn query_param(event : @mocket.MocketEvent, key : String) -> String {
  match event.req.query().get(key) {
    Some(v) => v
    None => ""
  }
}

///|
/// 逐字符字典序比较器(sort_by 用,-1/0/1)。不能用 String 自带的 `<`:
/// core 的 String 比较是 shortlex(先比长度),与 Node localeCompare 的
/// 逐字符次序不同,列表排序会被长度打乱。
fn cmp_text(a : String, b : String) -> Int32 {
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
/// 版本文件定位结果(Node cli locateVersionFile 的两段校验)。
priv enum VersionLocate {
  Found(String)
  Invalid
  Unsafe
}

///|
/// 版本文件的定位与越界校验:名字必须带 `.syncx-v-` 标记;拼出的相对路径经
/// 词法归一(消解 `.`/`..`)后必须仍在版本目录之内,否则拒绝 —— 防 `..` 逃逸
/// (分隔符 `/`、`\` 两种都切,与 resolve_share_path 同口径;Node 用
/// join+relative 的词法检查,语义一致)。返回归一后的绝对路径。
fn locate_version_file(versions_dir : String, version_file : String) -> VersionLocate {
  if version_file == "" || !version_file.contains(".syncx-v-") {
    return Invalid
  }
  let parts : Array[String] = []
  let current = StringBuilder()
  for c in version_file {
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
        return Unsafe
      }
      let _ = cleaned.remove(cleaned.length() - 1)
      continue
    }
    cleaned.push(segment)
  }
  if cleaned.length() == 0 {
    return Unsafe
  }
  Found("\{versions_dir}/\{cleaned.join("/")}")
}

///|
/// 路径闸门的抛错 → 客户端可见消息(文案源在 daemon ExecutorError::to_text,
/// 与 Node resolveSharePath 的抛错文案逐字一致,前端直接展示)。
fn executor_error_message(e : @daemon.ExecutorError) -> String {
  e.to_text()
}

///|
/// 递归确保目录存在(并发创建失败容忍别的进程先建好)。
async fn ensure_dir(dir : String) -> Unit {
  if (@fs.exists(dir) catch { _ => false }) {
    return
  }
  @fs.mkdir(dir, recursive=true, allow_exist=true) catch { _ => () }
}

///|
/// 确保父目录存在(无分隔符则不动)。
async fn ensure_parent_of(path : String) -> Unit {
  match path.rev_find("/") {
    Some(i) => if i > 0 {
      ensure_dir(path[0:i].to_owned())
    }
    None => ()
  }
}

///|
/// 拷贝文件(恢复/留档;None = 成功,Some = 失败消息)。
async fn copy_file_to(src : String, dest : String) -> String? {
  let data = @fs.read_file(src) catch {
    e => return Some("读取 \{src} 失败: \{e}")
  }
  ensure_parent_of(dest)
  @fs.write_file(dest, data, create_mode=CreateOrTruncate) catch {
    e => return Some("写入 \{dest} 失败: \{e}")
  }
  None
}

///|
/// 恢复动作改变了共享目录盘面:经 ActorHandle 触发该目录一轮扫描(对应
/// Node restore 后的 manager.runScan();扫描把恢复产生的本地改动外推广播)。
/// actor 未接时降级为不触发。
fn trigger_folder_scan(options : ApiOptions, folder_id : String) -> Unit {
  match options.actor {
    Some(actor) => {
      let _ = actor.send(@daemon.Cmd::ScanFolder(folder_id))
    }
    None => ()
  }
}

///|
/// 递归列出版本目录下的全部文件(相对 versionsDir,'/' 分隔,保留原相对路径
/// 的目录结构;目录不存在 = 无版本留档,空列表)。
async fn list_version_files(dir : String, prefix : String) -> Array[String] {
  let out : Array[String] = []
  let names = @fs.readdir(dir) catch { _ => return out }
  for name in names {
    let rel = if prefix == "" { name } else { "\{prefix}/\{name}" }
    let child = "\{dir}/\{name}"
    let kind = @fs.kind(child) catch { _ => @fs.FileKind::Unknown }
    if kind is Directory {
      for nested in list_version_files(child, rel) {
        out.push(nested)
      }
    } else if kind is Regular {
      out.push(rel)
    }
  }
  out
}

///|
/// GET /api/folders/versions?folderId=xxx:某目录的文件版本列表(对端覆盖
/// 修改前自动留档,见 executor snapshot_version)。响应 {versions:[{file,
/// path,size,mtime}]},path 主序、file 次序(Node 同款)。
pub async fn handle_list_folder_versions(
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
    None => return json_error(event, @mocket.BadRequest, "folder not found")
  }
  let versions_dir = folder_versions_dir(options, folder)
  let records : Array[(String, String, Int64, Int64)] = []
  for file in list_version_files(versions_dir, "") {
    let abs = "\{versions_dir}/\{file}"
    // 列举与 stat 之间可能被清空/损坏:体积与 mtime 报 0,行仍在(可恢复时再校验)
    let size = @fs.file_size(abs) catch { _ => 0L }
    let mtime = match @daemon.mtime_ms(abs) {
      Some(t) => t
      None => 0L
    }
    records.push((file, @daemon.version_original_path(file), size, mtime))
  }
  records.sort_by((a, b) => {
    let by_path = cmp_text(a.1, b.1)
    if by_path != 0 {
      by_path
    } else {
      cmp_text(a.0, b.0)
    }
  })
  let items : Array[Json] = []
  for (file, path, size, mtime) in records {
    let item : Map[String, Json] = Map([])
    item.set("file", Json::string(file))
    item.set("path", Json::string(path))
    item.set("size", Json::number(size.to_double()))
    item.set("mtime", Json::number(mtime.to_double()))
    items.push(Json::object(item))
  }
  let map : Map[String, Json] = Map([])
  map.set("versions", Json::array(items))
  @mocket.HttpResponse(@mocket.OK).json(Json::object(map))
}

///|
/// POST /api/folders/versions/restore {folderId,file}:把某个版本恢复回共享
/// 目录原路径。当前内容会先拷一份进版本目录(恢复动作可逆);落位后触发该
/// 目录扫描。请求/响应形态与 Node 同款:成功 200 {ok:true};缺参 400
/// "folderId and file are required";版本缺失 400 "version not found"。
pub async fn handle_restore_folder_version(
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
    None => return json_error(event, @mocket.BadRequest, "folderId and file are required")
  }
  let file = match non_empty_string(obj, "file") {
    Some(f) => f
    None => return json_error(event, @mocket.BadRequest, "folderId and file are required")
  }
  let config = load_config(options.config_file)
  let folder = match find_config_folder(config, folder_id) {
    Some(f) => f
    None => return json_error(event, @mocket.BadRequest, "folder not found")
  }
  let versions_dir = folder_versions_dir(options, folder)
  let abs = match locate_version_file(versions_dir, file) {
    Found(abs) => abs
    Invalid => return json_error(event, @mocket.BadRequest, "invalid version file")
    Unsafe => return json_error(event, @mocket.BadRequest, "unsafe version file")
  }
  let kind = @fs.kind(abs) catch { _ => @fs.FileKind::Unknown }
  if !(@fs.exists(abs) catch { _ => false }) || !(kind is Regular) {
    return json_error(event, @mocket.BadRequest, "version not found")
  }
  let rel_path = @daemon.version_original_path(file)
  let dest = @daemon.resolve_share_path(folder.path, rel_path, false) catch {
    e => return json_error(event, @mocket.BadRequest, executor_error_message(e))
  }
  // 当前内容先留档进版本目录,恢复动作本身可逆(Node 同款)
  let dest_kind = @fs.kind(dest) catch { _ => @fs.FileKind::Unknown }
  if dest_kind is Regular {
    ensure_dir(versions_dir)
    let stamp = @daemon.base36(@daemon.now_ms())
    let mut n = 0
    let mut backup = "\{versions_dir}/\{rel_path}.syncx-v-\{stamp}"
    while (@fs.exists(backup) catch { _ => false }) {
      n += 1
      backup = "\{versions_dir}/\{rel_path}.syncx-v-\{stamp}.\{n}"
    }
    match copy_file_to(dest, backup) {
      Some(err) => return json_error(event, @mocket.BadRequest, "恢复失败: \{err}")
      None => ()
    }
  }
  match copy_file_to(abs, dest) {
    Some(err) => return json_error(event, @mocket.BadRequest, "恢复失败: \{err}")
    None => ()
  }
  trigger_folder_scan(options, folder_id)
  @mocket.HttpResponse(@mocket.OK).json(ok_true())
}

///|
/// POST /api/folders/versions/delete {folderId,file}:删除单个版本文件(不可
/// 逆,前端二次确认)。Node rmSync 同款:删除失败(含不存在)回 400。
pub async fn handle_delete_folder_version(
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
    None => return json_error(event, @mocket.BadRequest, "folderId and file are required")
  }
  let file = match non_empty_string(obj, "file") {
    Some(f) => f
    None => return json_error(event, @mocket.BadRequest, "folderId and file are required")
  }
  let config = load_config(options.config_file)
  let folder = match find_config_folder(config, folder_id) {
    Some(f) => f
    None => return json_error(event, @mocket.BadRequest, "folder not found")
  }
  let abs = match locate_version_file(folder_versions_dir(options, folder), file) {
    Found(abs) => abs
    Invalid => return json_error(event, @mocket.BadRequest, "invalid version file")
    Unsafe => return json_error(event, @mocket.BadRequest, "unsafe version file")
  }
  @fs.remove(abs) catch {
    _ => return json_error(event, @mocket.BadRequest, "删除失败")
  }
  @mocket.HttpResponse(@mocket.OK).json(ok_true())
}

///|
/// GET /api/folders/versions/content?folderId=&file=:读取单个版本文件内容
/// (时间机器:任意两版对比)。超大/二进制只回状态不回内容,与 Node 同一口径:
/// 超 1MB → {exists:true,size,tooLarge:true};含 \0 → {exists:true,size,
/// binary:true};否则 {exists:true,size,text}。
pub async fn handle_folder_version_content(
  options : ApiOptions,
  event : @mocket.MocketEvent,
) -> &Responder {
  let folder_id = query_param(event, "folderId")
  let file = query_param(event, "file")
  if folder_id == "" || file == "" {
    return json_error(event, @mocket.BadRequest, "folderId and file are required")
  }
  let config = load_config(options.config_file)
  let folder = match find_config_folder(config, folder_id) {
    Some(f) => f
    None => return json_error(event, @mocket.BadRequest, "folder not found")
  }
  let abs = match locate_version_file(folder_versions_dir(options, folder), file) {
    Found(abs) => abs
    Invalid => return json_error(event, @mocket.BadRequest, "invalid version file")
    Unsafe => return json_error(event, @mocket.BadRequest, "unsafe version file")
  }
  let kind = @fs.kind(abs) catch { _ => @fs.FileKind::Unknown }
  if !(@fs.exists(abs) catch { _ => false }) || !(kind is Regular) {
    let map : Map[String, Json] = Map([])
    map.set("exists", Json::boolean(false))
    return @mocket.HttpResponse(@mocket.OK).json(Json::object(map))
  }
  let size = @fs.file_size(abs) catch { _ => 0L }
  if size > 1000000L {
    let map : Map[String, Json] = Map([])
    map.set("exists", Json::boolean(true))
    map.set("size", Json::number(size.to_double()))
    map.set("tooLarge", Json::boolean(true))
    return @mocket.HttpResponse(@mocket.OK).json(Json::object(map))
  }
  let content = @fs.read_file(abs) catch {
    _ => return json_error(event, @mocket.BadRequest, "读取版本内容失败")
  }
  let bytes = content.binary()
  let map : Map[String, Json] = Map([])
  map.set("exists", Json::boolean(true))
  map.set("size", Json::number(size.to_double()))
  let mut binary = false
  for b in bytes {
    if b == b'\x00' {
      binary = true
      break
    }
  }
  if binary {
    map.set("binary", Json::boolean(true))
  } else {
    map.set("text", Json::string(@utf8.decode_lossy(bytes.exact_view())))
  }
  @mocket.HttpResponse(@mocket.OK).json(Json::object(map))
}

///|
/// 递归解析回收站目录为 (file, relPath, ts) 列表(目录不存在 → 空)。只收
/// 命名能反解的副本(与 Node listTrashRefs 同口径:混杂的非副本文件不列)。
async fn list_trash_refs(
  dir : String,
  prefix : String,
) -> Array[(String, String, Int64)] {
  let out : Array[(String, String, Int64)] = []
  let names = @fs.readdir(dir) catch { _ => return out }
  for name in names {
    let rel = if prefix == "" { name } else { "\{prefix}/\{name}" }
    let child = "\{dir}/\{name}"
    let kind = @fs.kind(child) catch { _ => @fs.FileKind::Unknown }
    if kind is Directory {
      for nested in list_trash_refs(child, rel) {
        out.push(nested)
      }
    } else if kind is Regular {
      match @daemon.parse_trash_name(rel) {
        Some((rel_path, ts)) => out.push((rel, rel_path, ts))
        None => ()
      }
    }
  }
  out
}

///|
/// GET /api/trash?folderId=:列出已删副本(新删在前)。响应
/// {entries:[{file,path,ts,size}]};size 取不到报 0,行仍在(可还原时再校验)。
pub async fn handle_list_folder_trash(
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
    None => return json_error(event, @mocket.BadRequest, "folder not found")
  }
  let trash_dir = folder_trash_dir(options, folder)
  let records : Array[(String, String, Int64, Int64)] = []
  for (file, rel_path, ts) in list_trash_refs(trash_dir, "") {
    let size = @fs.file_size("\{trash_dir}/\{file}") catch { _ => 0L }
    records.push((file, rel_path, ts, size))
  }
  records.sort_by((a, b) => if a.2 > b.2 {
    -1
  } else if a.2 < b.2 {
    1
  } else {
    0
  })
  let items : Array[Json] = []
  for (file, rel_path, ts, size) in records {
    let item : Map[String, Json] = Map([])
    item.set("file", Json::string(file))
    item.set("path", Json::string(rel_path))
    item.set("ts", Json::number(ts.to_double()))
    item.set("size", Json::number(size.to_double()))
    items.push(Json::object(item))
  }
  let map : Map[String, Json] = Map([])
  map.set("entries", Json::array(items))
  @mocket.HttpResponse(@mocket.OK).json(Json::object(map))
}

///|
/// POST /api/trash/restore {folderId,file}:回收站副本搬回原路径;同名实体
/// 已在(还原期间新建/同步来)时先挪进回收站 —— 还原动作本身可逆。落位后
/// 触发该目录扫描,还原作为「本地新增/修改」广播给对端。
pub async fn handle_restore_folder_trash(
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
  let file = match non_empty_string(obj, "file") {
    Some(f) => f
    None => return json_error(event, @mocket.BadRequest, "file is required")
  }
  let config = load_config(options.config_file)
  let folder = match find_config_folder(config, folder_id) {
    Some(f) => f
    None => return json_error(event, @mocket.BadRequest, "folder not found")
  }
  let trash_dir = folder_trash_dir(options, folder)
  // 越界防护(../ 与绝对路径都会被拒);trash_dir 作根,副本留在配置目录侧
  let src = @daemon.resolve_share_path(trash_dir, file, false) catch {
    e => return json_error(event, @mocket.BadRequest, executor_error_message(e))
  }
  let kind = @fs.kind(src) catch { _ => @fs.FileKind::Unknown }
  if !(@fs.exists(src) catch { _ => false }) || !(kind is Regular) {
    return json_error(event, @mocket.BadRequest, "回收站里没有这个副本")
  }
  // file 形如 <relPath>.<ts36>[.<n>](list_trash_refs 保留目录层级),整体
  // 反解:与 executor move_to_trash 的命名严格互逆
  let normalized = {
    let sb = StringBuilder()
    for c in file {
      if c == '\\' {
        sb.write_char('/')
      } else {
        sb.write_char(c)
      }
    }
    sb.to_string()
  }
  let rel_path = match @daemon.parse_trash_name(normalized) {
    Some((rel_path, _)) => rel_path
    None => return json_error(event, @mocket.BadRequest, "回收站副本命名无法识别")
  }
  if rel_path == "" {
    // 反解出空路径 = 目标是共享根本身;Node 此处无守卫(会把整个共享目录
    // rename 进回收站),这里拒绝而不沿用该坑
    return json_error(event, @mocket.BadRequest, "回收站副本命名无法识别")
  }
  let dest = @daemon.resolve_share_path(folder.path, rel_path, false) catch {
    e => return json_error(event, @mocket.BadRequest, executor_error_message(e))
  }
  if (@fs.exists(dest) catch { _ => false }) {
    // 同名实体先挪进回收站。Node 用裸时间戳无碰撞环(同毫秒连还原会覆盖
    // 既有留档),这里与 executor move_to_trash 同款加碰撞序号,绝不覆盖
    let stamp = @daemon.base36(@daemon.now_ms())
    let mut n = 0
    let mut backup = "\{trash_dir}/\{rel_path}.\{stamp}"
    while (@fs.exists(backup) catch { _ => false }) {
      n += 1
      backup = "\{trash_dir}/\{rel_path}.\{stamp}.\{n}"
    }
    ensure_parent_of(backup)
    @fs.rename(dest, backup) catch {
      e => return json_error(event, @mocket.BadRequest, "回收站还原失败: \{e}")
    }
  }
  ensure_parent_of(dest)
  @fs.rename(src, dest) catch {
    e => return json_error(event, @mocket.BadRequest, "回收站还原失败: \{e}")
  }
  trigger_folder_scan(options, folder_id)
  @mocket.HttpResponse(@mocket.OK).json(ok_true())
}

///|
/// POST /api/trash/purge {folderId,file?}:彻底删除。file 缺省/空 = 清空该
/// 目录整个回收站(不可逆);指定 file 只清单个副本,不存在报 400。
pub async fn handle_purge_folder_trash(
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
  let file = match obj.get("file") {
    Some(String(s)) => Some(s)
    Some(_) => return json_error(event, @mocket.BadRequest, "file must be a string")
    None => None
  }
  let config = load_config(options.config_file)
  let folder = match find_config_folder(config, folder_id) {
    Some(f) => f
    None => return json_error(event, @mocket.BadRequest, "folder not found")
  }
  let trash_dir = folder_trash_dir(options, folder)
  match file {
    Some("") =>
      // file 缺省/空 = 清空整个回收站(rmSync recursive force 同款,尽力而为)
      @fs.rmdir(trash_dir, recursive=true) catch { _ => () }
    Some(f) => {
      let target = @daemon.resolve_share_path(trash_dir, f, false) catch {
        e => return json_error(event, @mocket.BadRequest, executor_error_message(e))
      }
      if !(@fs.exists(target) catch { _ => false }) {
        return json_error(event, @mocket.BadRequest, "回收站里没有这个副本")
      }
      @fs.remove(target) catch {
        e => return json_error(event, @mocket.BadRequest, "回收站清理失败: \{e}")
      }
    }
    None =>
      @fs.rmdir(trash_dir, recursive=true) catch { _ => () }
  }
  @mocket.HttpResponse(@mocket.OK).json(ok_true())
}
