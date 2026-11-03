///|
/// GitHub Releases 自更新(ADR-0026 §3;对应 Rust `rust/crates/syncx-cli/src/update.rs`)。
///
/// 资产名 `syncx-mbt-v{version}-{target}.tar.gz`(Windows `.zip`),同 Release 附两空格
/// 格式的 `checksums.txt`,SHA-256 校验通过才换入;换入是不可逆的,顺序必须是
/// **先校验再换入**。看门狗流程:旧进程写盘作业文件后 detached 拉起(看门狗同样
/// 是旧二进制),等旧进程退出 → 原子 rename 换入 →(daemon 模式)拉起新进程并
/// 等健康标记 → 超时未写标记则换回 `.old` 并拉回旧进程。
///
/// 与 Rust 版的差异:
///  - MoonBit 没有编译期三元组,TARGET 为运行时探测(经 update_platform.c 的
///    C 宏,目标机上编译时定死 os/arch,再映射到 6 个 target);
///  - tar.gz/zip 解包用系统 `tar` / PowerShell Expand-Archive(与 Rust 的
///    Windows 侧同策略),MoonBit 侧暂无归档库;
///  - HTTP 客户端是 moonbitlang/async/http,没有 reqwest 式的请求级超时参数,
///    卡死场景依赖调用方的外层取消(TODO,见 Rust 侧 TARBALL_TIMEOUT 对应物)。

///|
/// GitHub 仓库(发布页地址由它拼)。
pub const GITHUB_REPO : String = "wangmingfa/syncx"

///|
/// 默认升级通道。
pub const DEFAULT_UPGRADE_TAG : String = "latest"

///|
/// 发布资产里的二进制名(moonbit-release.yml 固定为 syncx-mb)。
pub const BINARY_NAME : String = "syncx-mb"

///|
/// 看门狗等待旧进程退出的时限(优雅关闭通常 <1s,给足余量)。
pub const OLD_EXIT_WAIT_MS : Int64 = 120_000L

///|
/// 换入后等新进程写健康标记的时限:超时视为启动失败 → 换回 `.old`。
pub const HEALTH_MARKER_TIMEOUT_MS : Int64 = 30_000L

///|
/// 健康标记的环境变量名:新 daemon 在控制端口绑定成功后写它。
pub const UPDATE_MARKER_ENV : String = "SYNCX_UPDATE_MARKER"

///|
/// 上传换入时,看门狗等旧进程自行退出的宽限期:HTTP 响应 + 优雅收尾
/// 通常在几百毫秒内完成,超时即 SIGTERM 请它让位。
pub const UPLOAD_KILL_PARENT_GRACE_MS : Int64 = 600L

///|
/// 自更新错误。
pub(all) suberror UpdateError {
  /// 通道名非法。
  InvalidTag(String)
  /// 网络请求 / 响应异常(查询、下载、checksums 获取)。
  Http(String)
  /// 找不到可用 release / 资产,或已是最新版本。
  NoRelease(String)
  /// 校验失败,或该 release 缺校验文件而拒绝换入。
  ChecksumFailed(String)
  /// 平台不支持 / dev 运行态 / 新二进制实跑校验不过。
  Unsupported(String)
  /// 本地 I/O 失败(备份、解包、换入、回滚)。
  Io(String)
}

///|
pub fn UpdateError::to_text(self : UpdateError) -> String {
  match self {
    InvalidTag(reason) => "升级通道非法:\{reason}"
    Http(reason) => "网络请求失败:\{reason}"
    NoRelease(reason) => reason
    ChecksumFailed(reason) => reason
    Unsupported(reason) => reason
    Io(reason) => "本地 I/O 失败:\{reason}"
  }
}

// ---- 平台探测 ----

///|
extern "C" fn c_os_name() -> String = "syncx_os_name"

///|
extern "C" fn c_arch_name() -> String = "syncx_arch_name"

///|
extern "C" fn c_getpid() -> Int32 = "syncx_getpid"

///|
extern "C" fn c_current_exec_path() -> String = "syncx_current_exec_path"

///|
extern "C" fn c_is_process_alive(pid : Int32) -> Int32 = "syncx_is_process_alive"

///|
/// 向指定进程发 SIGTERM(看门狗在宽限期后请旧进程让位;Windows 走
/// TerminateProcess —— 上传换入场景旧进程没有优雅关闭钩子可用)。
extern "C" fn c_send_sigterm(pid : Int32) -> Unit = "syncx_send_sigterm"

///|
/// os 名 + arch → 目标三元组,只对齐 workflow 的 6 个 target,不做模糊匹配
/// (ADR-0026 §3)。探测不到的组合返回 None,由调用方拒绝升级。
pub fn target_triple(os : String, arch : String) -> String? {
  match (os, arch) {
    ("linux", "x86_64") => Some("x86_64-unknown-linux-gnu")
    ("linux", "aarch64") => Some("aarch64-unknown-linux-gnu")
    ("macos", "x86_64") => Some("x86_64-apple-darwin")
    ("macos", "aarch64") => Some("aarch64-apple-darwin")
    ("windows", "x86_64") => Some("x86_64-pc-windows-msvc")
    ("windows", "aarch64") => Some("aarch64-pc-windows-msvc")
    _ => None
  }
}

///|
/// 运行时探测当前目标三元组(等价于 Rust 侧的编译期 `TARGET`)。
pub fn detect_target() -> String raise UpdateError {
  let os = c_os_name()
  let arch = c_arch_name()
  match target_triple(os, arch) {
    Some(triple) => triple
    None =>
      raise Unsupported(
        "当前平台没有对应的发布资产(os=\{os}, arch=\{arch})",
      )
  }
}

// ---- 版本比较 ----

///|
/// 语义化版本比较,规则与 Rust/Node 的 `compare_versions` 一致:先比
/// maj.min.patch,再比预发布(无预发布者大;tag 字典序;迭代号按数值比)。
/// 非法输入按 `0.0.0` 处理而不报错 —— 版本号来自网络,不能因脏数据崩掉。
/// 返回 -1 / 0 / 1。
pub fn compare_semver(a : String, b : String) -> Int32 {
  let ((a1, a2, a3), a_pre) = parse_semver(a)
  let ((b1, b2, b3), b_pre) = parse_semver(b)
  if a1 != b1 {
    return if a1 > b1 { 1 } else { -1 }
  }
  if a2 != b2 {
    return if a2 > b2 { 1 } else { -1 }
  }
  if a3 != b3 {
    return if a3 > b3 { 1 } else { -1 }
  }
  match (a_pre, b_pre) {
    (None, None) => 0
    // 无预发布后缀的更大:1.2.3 > 1.2.3-beta.1
    (None, Some(_)) => 1
    (Some(_), None) => -1
    (Some((a_tag, a_n)), Some((b_tag, b_n))) => {
      // 通道名按字典序(注意:String 的 Compare 是短序 shortlex,长度优先,
      // 这里必须用 lexical_compare 才与 Rust/Node 的字节序一致)
      if a_tag != b_tag {
        return if a_tag.lexical_compare(b_tag) < 0 { -1 } else { 1 }
      }
      if a_n == b_n {
        0
      } else if a_n > b_n {
        1
      } else {
        -1
      }
    }
  }
}

///|
/// 解析为 ((maj, min, patch), (通道, 迭代号)?)。
fn parse_semver(raw : String) -> ((Int32, Int32, Int32), (String, Int32)?) {
  let view : StringView = raw
  let (base, pre) = match view.split_once("-") {
    Some((b, p)) => (b, Some(p))
    None => (view, None)
  }
  let parts : Array[StringView] = base.split(".").collect()
  let num = fn(i : Int32) -> Int32 {
    match parts.get(i) {
      Some(text) =>
        if text.char_length() > 0 && all_digits(text) {
          digits_value(text)
        } else {
          0
        }
      None => 0
    }
  }
  let pre_pair : (String, Int32)? = match pre {
    Some(text) =>
      if text.char_length() == 0 {
        None
      } else {
        match text.split_once(".") {
          // 与 Rust 一致:tag 为空(`-.5`)按「整个后缀、迭代号 0」处理
          Some((tag, n)) =>
            if tag.char_length() == 0 {
              Some((text.to_owned(), 0))
            } else {
              Some((tag.to_owned(), digits_value(n)))
            }
          None => Some((text.to_owned(), 0))
        }
      }
    None => None
  }
  ((num(0), num(1), num(2)), pre_pair)
}

///|
/// 纯十进制字串 → Int;为空或含非数字返回 0(与 Rust 的 parse().unwrap_or(0) 一致)。
fn digits_value(text : StringView) -> Int32 {
  let mut n = 0
  let mut ok = true
  for c in text {
    if c < '0' || c > '9' {
      ok = false
      break
    }
    n = n * 10 + (c.to_int() - '0'.to_int())
  }
  if ok {
    n
  } else {
    0
  }
}

///|
fn all_digits(text : StringView) -> Bool {
  if text.char_length() == 0 {
    return false
  }
  let mut ok = true
  for c in text {
    if c < '0' || c > '9' {
      ok = false
      break
    }
  }
  ok
}

///|
/// 校验并规范化升级通道:缺省/空白 → `latest`;首字符须字母数字,
/// 其余只允许 `.` `_` `-`(与 Rust 的 normalize_upgrade_tag 一致)。
pub fn normalize_upgrade_tag(input : String?) -> String raise UpdateError {
  let tag = match input {
    Some(text) => {
      let trimmed = text.trim()
      if trimmed.char_length() == 0 {
        DEFAULT_UPGRADE_TAG
      } else {
        trimmed.to_owned()
      }
    }
    None => DEFAULT_UPGRADE_TAG
  }
  let mut first : Char? = None
  let mut rest_ok = true
  let mut seen = false
  for c in tag {
    if !seen {
      first = Some(c)
      seen = true
    } else if !is_tag_char(c) {
      rest_ok = false
    }
  }
  let first_ok = match first {
    Some(c) => is_ascii_alnum(c)
    None => false
  }
  if !first_ok || !rest_ok {
    raise InvalidTag(
      "invalid dist-tag: \{tag}(可用通道如 latest / beta / alpha)",
    )
  }
  tag
}

///|
fn is_ascii_alnum(c : Char) -> Bool {
  (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
}

///|
fn is_tag_char(c : Char) -> Bool {
  is_ascii_alnum(c) || c == '.' || c == '_' || c == '-'
}

// ---- 资产与校验 ----

///|
/// 资产名拼装:`syncx-mbt-v{version}-{target}.tar.gz`(Windows `.zip`)。
/// 二进制按名匹配,不做模糊匹配(ADR-0026 §3)。
pub fn asset_name(version : String, target : String) -> String {
  let ext = if target.contains("windows") { "zip" } else { "tar.gz" }
  "syncx-mbt-v\{version}-\{target}.\{ext}"
}

///|
/// 解析 `checksums.txt`(sha256sum 输出):每行 `<hash>  <文件名>`,
/// 二进制模式名前带 `*`。返回文件名对应的 sha256(小写);没有条目返回 None。
pub fn parse_checksums(text : String, filename : String) -> String? {
  for line in text.split("\n") {
    match checksum_line(line) {
      Some((hash, name)) => {
        let bare = if name.has_prefix("*") { name[1:].to_owned() } else { name }
        if bare == filename {
          return Some(to_lower_hex(hash))
        }
      }
      None => ()
    }
  }
  None
}

///|
/// 单行 → (hash, 文件名)。按任意个空格切前两个非空 token(官方格式是两个
/// 空格,这里稍宽松:匹配仍要求文件名精确相等,不影响严格性)。
fn checksum_line(line : StringView) -> (String, String)? {
  let tokens : Array[String] = []
  for piece in line.split(" ") {
    let trimmed = piece.trim()
    if trimmed.char_length() > 0 {
      tokens.push(trimmed.to_owned())
    }
  }
  match (tokens.get(0), tokens.get(1)) {
    (Some(hash), Some(name)) => Some((hash, name))
    _ => None
  }
}

///|
fn to_lower_hex(text : String) -> String {
  let buf = StringBuilder()
  for c in text {
    buf.write_char(c.to_ascii_lowercase())
  }
  buf.to_string()
}

// ---- Release 查询 ----

///|
/// 一个可下载的 Release 资产。
pub(all) struct ReleaseAsset {
  /// 版本号(tag_name 去掉前导 `v`)。
  version : String
  /// 资产下载地址。
  url : String
  /// 同 Release 的 checksums.txt 下载地址;缺失时拒绝换入。
  checksums_url : String?
}

///|
fn json_get(value : Json, key : String) -> Json? {
  match value {
    Object(map) => map.get(key)
    _ => None
  }
}

///|
fn json_str(value : Json, key : String) -> String? {
  match json_get(value, key) {
    Some(String(s)) => Some(s)
    _ => None
  }
}

///|
fn json_bool(value : Json, key : String) -> Bool? {
  match json_get(value, key) {
    Some(True) => Some(true)
    Some(False) => Some(false)
    _ => None
  }
}

///|
/// 从 releases 列表里挑出符合通道的那一条。
///
/// `latest` 通道只要正式版(非 prerelease 且版本号不含 `-`);指定通道
/// (如 `beta`)按版本名里是否含 `-{channel}` 过滤,取 **最高版本** ——
/// 排序用 `compare_semver`,不用 API 返回顺序(那个按创建时间,重发时会乱)。
/// draft 一律跳过。
pub fn pick_release(releases : Array[Json], channel : String?) -> ReleaseAsset? {
  let candidates : Array[(String, Json)] = []
  for release in releases {
    let tag_name = match json_str(release, "tag_name") {
      Some(name) => name
      None => continue
    }
    // 去掉前导 v(可能有多个,与 Rust trim_start_matches 一致)
    let mut version = tag_name
    while version.has_prefix("v") {
      version = version[1:].to_owned()
    }
    let prerelease = json_bool(release, "prerelease").unwrap_or(false)
    let draft = json_bool(release, "draft").unwrap_or(false)
    if draft {
      continue
    }
    match channel {
      // 指定通道:按版本名里的 `-{channel}` 过滤(如 beta → 0.6.0-beta.1)
      Some(ch) =>
        if ch != DEFAULT_UPGRADE_TAG && version.contains("-\{ch}") {
          candidates.push((version, release))
        }
      // latest 通道:只要正式版
      _ =>
        if !prerelease && !version.contains("-") {
          candidates.push((version, release))
        }
    }
  }
  // 取最高版本(手动扫最大,避免依赖列表项的既有顺序)
  let mut best : (String, Json)? = None
  for candidate in candidates {
    best = match best {
      None => Some(candidate)
      Some((best_version, _)) =>
        if compare_semver(candidate.0, best_version) > 0 {
          Some(candidate)
        } else {
          best
        }
    }
  }
  let (version, release) = match best {
    Some(pair) => pair
    None => return None
  }
  // 在资产列表里按名匹配本机资产与 checksums.txt
  let assets = match json_get(release, "assets") {
    Some(Array(items)) => items
    _ => return None
  }
  let target = detect_target() catch { _ => return None }
  let wanted = asset_name(version, target)
  let mut url : String? = None
  let mut checksums_url : String? = None
  for asset in assets {
    let name = match json_str(asset, "name") {
      Some(n) => n
      None => continue
    }
    let download = json_str(asset, "browser_download_url")
    if name == wanted {
      url = download
    } else if name == "checksums.txt" {
      checksums_url = download
    }
  }
  match url {
    Some(u) => Some({ version, url: u, checksums_url, })
    None => None
  }
}

///|
/// GitHub API 请求头:必须带 User-Agent,缺了会被 403。
fn ua_headers() -> Map[@http.CaseInsensitiveString, String] {
  let headers : Map[@http.CaseInsensitiveString, String] = Map([])
  headers.set("User-Agent", "syncx-mb/\{@core.VERSION}")
  headers
}

///|
/// 查 GitHub Release:latest 走 `/releases/latest`,预发布通道取列表
/// (`/releases?per_page=30`)再按 `pick_release` 挑。
pub async fn fetch_release(channel : String?) -> ReleaseAsset {
  let tag = normalize_upgrade_tag(channel)
  let url = if tag == DEFAULT_UPGRADE_TAG {
    "https://api.github.com/repos/\{GITHUB_REPO}/releases/latest"
  } else {
    "https://api.github.com/repos/\{GITHUB_REPO}/releases?per_page=30"
  }
  let headers = ua_headers()
  let (res, data) = @http.get(url, headers~) catch {
    e => raise Http("release 查询失败:\{e}")
  }
  if !(res.code is (200..<300)) {
    raise Http("release 查询失败(HTTP \{res.code})")
  }
  let body = data.text() catch { _ => raise Http("release 返回结构异常") }
  let json = @json.parse(body) catch {
    _ => raise Http("release 返回结构异常")
  }
  let releases : Array[Json] = if tag == DEFAULT_UPGRADE_TAG {
    [json]
  } else {
    match json {
      Array(items) => items
      _ => [json]
    }
  }
  let target = detect_target()
  match pick_release(releases, Some(tag)) {
    Some(asset) => asset
    None =>
      raise NoRelease("没有找到可用的 release(通道 \{tag},\{target})")
  }
}

///|
/// 一次更新检查的结论(与 Node 的 `UpdateInfo` 同形;`tarball_url` 沿用
/// 前端已有字段名,填的是该 Release 的资产下载地址)。
pub(all) struct UpdateInfo {
  latest : String
  current : String
  tarball_url : String
}

///|
/// 查一次更新;成功返回本次结论。
pub async fn check_for_update() -> UpdateInfo {
  let asset = fetch_release(None)
  { latest: asset.version, current: @core.VERSION, tarball_url: asset.url, }
}

// ---- 安装与换入 ----

///|
/// daemon 侧升级时的重启参数:原 argv + 原工作目录 + 日志文件。
pub(all) struct UpdateRestart {
  args : Array[String]
  cwd : String?
  log_file : String?
}

///|
/// 下载并校验、换入、重启。顺序不能改:**先校验再换入** —— 换入是原子的
/// 但不可逆(旧包只剩 `.old`),一个损坏的包被换进去,进程就再也起不来了。
///
/// `restart` 为 `None` 时是 CLI 升级:只换入,重启交给用户;为 `Some` 时
/// 是 daemon 触发的升级,看门狗换入后拉起新进程并等健康标记。
pub async fn install_from_release(
  channel : String?,
  restart : UpdateRestart?,
) -> String {
  if @core.VERSION == "dev" {
    raise Unsupported("dev 运行态不支持自更新")
  }
  let asset = fetch_release(channel)
  let tag = normalize_upgrade_tag(channel)
  if compare_semver(@core.VERSION, asset.version) >= 0 {
    raise NoRelease(
      "已是最新版本 \{asset.version}(\{tag} 通道),无需升级",
    )
  }
  // 下载归档
  let headers = ua_headers()
  let (res, data) = @http.get(asset.url, headers~) catch {
    e => raise Http("更新包下载失败:\{e}")
  }
  if !(res.code is (200..<300)) {
    raise Http("更新包下载失败(HTTP \{res.code})")
  }
  let bytes = data.binary()
  if bytes.length() == 0 {
    raise Http("更新包下载内容为空")
  }
  // 校验:同 Release 附 checksums.txt,比对 SHA-256。缺校验文件时拒绝换入 ——
  // 「没有校验就换入」等于把下载链路当成可信,而它正是本环节要防的。
  let checksums_url = match asset.checksums_url {
    Some(url) => url
    None =>
      raise ChecksumFailed(
        "该 release 未提供 checksums.txt,拒绝换入未校验的包",
      )
  }
  let expected = fetch_checksum(checksums_url, file_name_of_url(asset.url))
  let actual = @hex.encode(@net.sha256(bytes).clamped_view())
  if actual != expected {
    raise ChecksumFailed(
      "更新包指纹校验失败(期望 \{head12(expected)},实际 \{head12(actual)}),已放弃升级",
    )
  }
  // 解包到执行文件旁边,并实跑校验版本号 —— 换入不可逆,一个起不来的
  // 二进制换进去,这台机器就再也没机会自更新了。
  let exe = c_current_exec_path()
  if exe == "" {
    raise Io("找不到当前可执行文件路径")
  }
  let staging = unpack_binary(bytes, exe)
  let printed = binary_version(staging) catch { _ => None }
  match printed {
    Some(printed) =>
      if !printed.contains(asset.version) {
        raise Unsupported(
          "新二进制版本不符(期望 \{asset.version},实际输出 \{printed}),已放弃升级",
        )
      }
    None =>
      raise Unsupported("新二进制无法执行(\{staging}),已放弃升级")
  }
  spawn_update_swap(exe, staging, asset.version, restart)
  asset.version
}

///|
/// 取 checksums.txt 里指定文件的 sha256(小写)。
async fn fetch_checksum(url : String, filename : String) -> String {
  let headers = ua_headers()
  let (res, data) = @http.get(url, headers~) catch {
    e => raise Http("checksums.txt 下载失败:\{e}")
  }
  if !(res.code is (200..<300)) {
    raise Http("checksums.txt 下载失败(HTTP \{res.code})")
  }
  let text = data.text() catch { _ => raise Http("checksums.txt 内容异常") }
  match parse_checksums(text, filename) {
    Some(hash) => hash
    None =>
      raise ChecksumFailed("checksums.txt 里没有 \{filename} 的条目")
  }
}

///|
fn head12(hash : String) -> String {
  if hash.char_length() > 12 {
    hash[0:12].to_owned()
  } else {
    hash
  }
}

///|
/// URL 最后一段作为文件名(`/` 分隔)。
fn file_name_of_url(url : String) -> String {
  let mut idx = -1
  let mut i = 0
  for c in url {
    if c == '/' {
      idx = i
    }
    i = i + 1
  }
  if idx < 0 {
    return url
  }
  url[idx + 1:].to_owned()
}

///|
/// 把更新包解到执行文件旁边(rename 要求同盘),返回待换入的 staging 路径。
///
/// tar.gz 用系统 `tar` 解,zip 用 PowerShell Expand-Archive(与 Rust 的
/// Windows 侧同策略)。解包后只按**文件名**挑二进制 —— 归档内路径结构由
/// 发布脚本决定,按路径挑会在发布脚本改名后失效。
async fn unpack_binary(archive : Bytes, current_exe : String) -> String {
  let dir = match parent_dir(current_exe) {
    Some(d) => d
    None => raise Io("找不到可执行文件所在目录")
  }
  let staging = "\{dir}/.syncx-update-\{c_getpid()}.bin"
  let temp = @fs.tmpdir(prefix="syncx-unpack") catch {
    e => raise Io("创建临时目录失败:\{e}")
  }
  let windows = c_os_name() == "windows"
  let archive_path = if windows {
    "\{temp}/update.zip"
  } else {
    "\{temp}/update.tar.gz"
  }
  @fs.write_file(archive_path, archive) catch {
    e => raise Io("写入更新包失败:\{e}")
  }
  if windows {
    let code = @process.run(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Expand-Archive -LiteralPath '\{archive_path}' -DestinationPath '\{temp}' -Force",
      ],
      inherit_env=true,
    ) catch {
      e => raise Io("解压更新包失败(PowerShell Expand-Archive):\{e}")
    }
    if code != 0 {
      raise Io("解压更新包失败(PowerShell Expand-Archive)")
    }
  } else {
    let code = @process.run(
      "tar",
      ["-xzf", archive_path, "-C", temp],
      inherit_env=true,
    ) catch {
      e => raise Io("解压更新包失败(tar):\{e}")
    }
    if code != 0 {
      raise Io("解压更新包失败(tar)")
    }
  }
  let wanted = if windows { "\{BINARY_NAME}.exe" } else { BINARY_NAME }
  let found = match find_file_named(temp, wanted) {
    Some(path) => path
    None => raise Io("更新包里找不到可执行文件 \{wanted}")
  }
  let content = @fs.read_file(found) catch {
    e => raise Io("拷贝 staging 失败:\{e}")
  }
  @fs.write_file(staging, content.binary()) catch {
    e => raise Io("写入 staging 失败:\{e}")
  }
  // Unix 上补执行位(0755);Windows 没有这一步
  if !windows {
    @fs.chmod(staging, 493) catch {
      _ => ()
    }
  }
  staging
}

///|
/// 在目录树里按文件名找文件(发布归档只有一层 stage 目录,浅搜即命中)。
async fn find_file_named(dir : String, name : String) -> String? {
  let mut found : String? = None
  @fs.walk(
    dir,
    fn(d, files) {
      for f in files {
        if f == name {
          found = Some("\{d}/\{f}")
        }
      }
    },
    allow_failure=true,
  ) catch {
    _ => ()
  }
  found
}

///|
/// 实跑 `<exe> --version`,返回输出(失败/无法执行返回 None)。
async fn binary_version(exe : String) -> String? {
  let (code, out) = @process.collect_stdout(exe, ["--version"]) catch {
    _ => return None
  }
  if code != 0 {
    return None
  }
  let text = out.text() catch { _ => return None }
  Some(text.trim().to_owned())
}

///|
/// 一次自更新的全部交接信息。由旧进程写盘,看门狗(同样是旧二进制)读取执行:
/// 换入与回滚的代码永远来自**旧**版本 —— 新二进制若有启动级缺陷,它自己没有
/// 资格参与对自己的回滚判定。
pub(all) struct UpdateJob {
  /// 要等它退出的旧进程(发起升级的那个进程)。
  parent_pid : Int32
  /// 解包并校验过的新二进制(staging)。
  staging : String
  /// 被替换的目标(当前可执行文件)。
  exe : String
  /// 换入前的备份(`exe.old`),回滚源。
  old_exe : String
  /// 新进程健康后要写的标记文件(换入前先清掉,防上一轮残留误判)。
  marker : String
  /// 看门狗的结果文件(排障用,内容是 JSON)。
  done : String
  /// `None` = CLI 升级:只换入不拉起,重启交给用户。
  restart_args : Array[String]?
  restart_cwd : String?
  log_file : String?
  wait_ms : Int64
  verify_ms : Int64
  version : String
  /// daemon 模式拉起的目标二进制(缺省 = exe,即换入后的自身路径)。
  /// 上传换入(跨后端)用它指向数据目录 bin/ 下的新后端二进制。
  restart_exe : String?
  /// true = 跨后端上传换入:不动 exe 文件(新二进制在 restart_exe),
  /// 回滚 = 重新拉起原 exe。发布路径(GitHub Releases)恒为 false。
  no_swap : Bool
  /// >0 时:等旧进程这么多毫秒还没退出,就向它发 SIGTERM 请它让位
  /// (上传换入路径用:旧进程响应完 HTTP 后没有别的退出机制;
  ///  0 = 不发,发布路径不变 —— CLI 升级由用户自己重启)。
  kill_parent_ms : Int64
}

///|
pub fn UpdateJob::to_json(self : UpdateJob) -> Json {
  let map : Map[String, Json] = Map([])
  map.set("parent_pid", Json::number(self.parent_pid.to_double()))
  map.set("staging", Json::string(self.staging))
  map.set("exe", Json::string(self.exe))
  map.set("old_exe", Json::string(self.old_exe))
  map.set("marker", Json::string(self.marker))
  map.set("done", Json::string(self.done))
  match self.restart_args {
    Some(args) => {
      let arr : Array[Json] = []
      for arg in args {
        arr.push(Json::string(arg))
      }
      map.set("restart_args", Json::array(arr))
    }
    None => map.set("restart_args", Json::null())
  }
  match self.restart_cwd {
    Some(cwd) => map.set("restart_cwd", Json::string(cwd))
    None => map.set("restart_cwd", Json::null())
  }
  match self.log_file {
    Some(f) => map.set("log_file", Json::string(f))
    None => map.set("log_file", Json::null())
  }
  map.set("wait_ms", Json::number(self.wait_ms.to_double()))
  map.set("verify_ms", Json::number(self.verify_ms.to_double()))
  map.set("version", Json::string(self.version))
  match self.restart_exe {
    Some(exe) => map.set("restart_exe", Json::string(exe))
    None => map.set("restart_exe", Json::null())
  }
  map.set("no_swap", Json::boolean(self.no_swap))
  map.set("kill_parent_ms", Json::number(self.kill_parent_ms.to_double()))
  Json::object(map)
}

///|
fn job_str(map : Map[String, Json], key : String) -> String? {
  match map.get(key) {
    Some(String(s)) => Some(s)
    _ => None
  }
}

///|
fn job_opt_str(map : Map[String, Json], key : String) -> String? {
  match map.get(key) {
    Some(String(s)) => Some(s)
    _ => None
  }
}

///|
fn job_opt_args(map : Map[String, Json], key : String) -> Array[String]? {
  match map.get(key) {
    Some(Array(items)) => {
      let out : Array[String] = []
      for item in items {
        match item {
          String(s) => out.push(s)
          _ => ()
        }
      }
      Some(out)
    }
    _ => None
  }
}

///|
fn job_num(map : Map[String, Json], key : String) -> Double {
  match map.get(key) {
    Some(Number(n, ..)) => n
    _ => 0.0
  }
}

///|
pub fn UpdateJob::from_json(value : Json) -> UpdateJob? {
  let map = match value {
    Object(map) => map
    _ => return None
  }
  let staging = match job_str(map, "staging") {
    Some(s) => s
    None => return None
  }
  let exe = match job_str(map, "exe") {
    Some(s) => s
    None => return None
  }
  let old_exe = match job_str(map, "old_exe") {
    Some(s) => s
    None => return None
  }
  let marker = match job_str(map, "marker") {
    Some(s) => s
    None => return None
  }
  let done = match job_str(map, "done") {
    Some(s) => s
    None => return None
  }
  let version = match job_str(map, "version") {
    Some(s) => s
    None => return None
  }
  Some({
    parent_pid: job_num(map, "parent_pid").to_int(),
    staging,
    exe,
    old_exe,
    marker,
    done,
    restart_args: job_opt_args(map, "restart_args"),
    restart_cwd: job_opt_str(map, "restart_cwd"),
    log_file: job_opt_str(map, "log_file"),
    wait_ms: job_num(map, "wait_ms").to_int64(),
    verify_ms: job_num(map, "verify_ms").to_int64(),
    version,
    // 新字段缺省:旧版本二进制写出的作业文件仍可执行(发布路径行为不变)
    restart_exe: job_opt_str(map, "restart_exe"),
    no_swap: map.get("no_swap") is Some(True),
    kill_parent_ms: job_num(map, "kill_parent_ms").to_int64(),
  })
}

///|
/// 换入前的准备:备份当前二进制为 `.old`(覆盖上一轮),写作业文件,
/// detached 拉起看门狗。本进程(旧进程)到这里就返回:真正的换入要等它
/// 退出 —— 正在运行的自己就是被替换对象,Windows 上必须先放掉句柄。
async fn spawn_update_swap(
  exe : String,
  staging : String,
  version : String,
  restart : UpdateRestart?,
) -> Unit {
  let old_exe = sibling_with_suffix(exe, ".old")
  // 备份旧二进制:这是回滚的唯一来源
  let content = @fs.read_file(exe) catch {
    e => raise Io("备份当前二进制失败:\{e}")
  }
  @fs.write_file(old_exe, content) catch {
    e => raise Io("备份当前二进制失败:\{e}")
  }
  let work = @fs.tmpdir(prefix="syncx-update") catch {
    e => raise Io("创建作业目录失败:\{e}")
  }
  let job : UpdateJob = {
    parent_pid: c_getpid(),
    staging,
    exe,
    old_exe,
    marker: "\{work}/healthy",
    done: "\{work}/done.json",
    restart_args: match restart {
      Some(r) => Some(r.args)
      None => None
    },
    restart_cwd: match restart {
      Some(r) => r.cwd
      None => None
    },
    log_file: match restart {
      Some(r) => r.log_file
      None => None
    },
    wait_ms: OLD_EXIT_WAIT_MS,
    verify_ms: HEALTH_MARKER_TIMEOUT_MS,
    version,
    // 发布路径:拉起换入后的自身路径,不请旧进程让位(CLI/用户自关)
    restart_exe: None,
    no_swap: false,
    kill_parent_ms: 0L,
  }
  let job_path = "\{work}/job.json"
  write_job_and_spawn_watchdog(job, job_path, exe)
}

///|
/// 写盘作业文件并 detached 拉起看门狗(看门狗 = `watchdog_exe --update-swap
/// <job.json>`,发布路径与上传路径都用**旧**二进制,保证换入/回滚代码
/// 永远来自旧版本)。
async fn write_job_and_spawn_watchdog(
  job : UpdateJob,
  job_path : String,
  watchdog_exe : String,
) -> Unit raise UpdateError {
  @fs.write_file(job_path, job.to_json().stringify()) catch {
    e => raise Io("写入更新作业文件失败:\{e}")
  }
  // 看门狗 = 当前(旧)二进制的一个 detached 进程;结果走 done 文件
  let _ = @process.spawn_orphan(
    watchdog_exe,
    ["--update-swap", job_path],
    inherit_env=true,
  ) catch {
    e => raise Io("拉起换入看门狗失败:\{e}")
  }
  ()
}

///|
/// 上传换入的交接(跨后端):不替换任何文件 —— 新二进制已在数据目录
/// `<configDir>/bin/` 下(`new_exe`),看门狗等本进程退出后直接从它
/// 拉起新后端;超时未写健康标记则重新拉起本进程(原 exe 原封未动,
/// 回滚零成本)。`kill_parent_ms` 负责在 HTTP 响应冲出内核缓冲之后
/// 请本进程让位。
pub async fn spawn_upload_swap(
  current_exe : String,
  new_exe : String,
  version : String,
  restart : UpdateRestart,
) -> Unit raise UpdateError {
  let work = @fs.tmpdir(prefix="syncx-update") catch {
    e => raise Io("创建作业目录失败:\{e}")
  }
  let job : UpdateJob = {
    parent_pid: c_getpid(),
    staging: new_exe,
    exe: current_exe,
    old_exe: sibling_with_suffix(current_exe, ".old"),
    marker: "\{work}/healthy",
    done: "\{work}/done.json",
    restart_args: Some(restart.args),
    restart_cwd: restart.cwd,
    log_file: restart.log_file,
    wait_ms: OLD_EXIT_WAIT_MS,
    verify_ms: HEALTH_MARKER_TIMEOUT_MS,
    version,
    restart_exe: Some(new_exe),
    no_swap: true,
    kill_parent_ms: UPLOAD_KILL_PARENT_GRACE_MS,
  }
  let job_path = "\{work}/job.json"
  write_job_and_spawn_watchdog(job, job_path, current_exe)
}

///|
/// 看门狗主流程:`--update-swap <job.json>` 的实现。
///
/// 等旧进程退出 → 原子换入 →(daemon 模式)拉起新进程并等健康标记 →
/// 超时未写则换回 `.old` 并拉回旧进程。任何失败都写进 done 文件后非零退出。
/// 返回值是看门狗进程的退出码。
pub async fn run_update_swap(job_path : String) -> Int32 {
  let job = match load_job(job_path) {
    Some(job) => job
    None => {
      println("update-swap: 读取作业文件失败:\{job_path}")
      return 1
    }
  }
  // 1) 等旧进程退出:它是被替换对象的持有者(Windows 上换不掉还开着的 exe)。
  //    上传换入路径(kill_parent_ms > 0)在宽限期后发 SIGTERM 兜底:旧进程
  //    响应完 HTTP 后没有别的退出机制,由本看门狗(detached,不受旧进程
  //    生命周期影响)在响应大概率已冲出内核缓冲之后请它让位。
  let exit_deadline = @async.now() + job.wait_ms
  let kill_at = if job.kill_parent_ms > 0 {
    @async.now() + job.kill_parent_ms
  } else {
    0L
  }
  let mut kill_sent = false
  while c_is_process_alive(job.parent_pid) != 0 {
    if @async.now() >= exit_deadline {
      write_done(job.done, false, "旧进程未在时限内退出,放弃换入")
      return 1
    }
    if kill_at > 0 && !kill_sent && @async.now() >= kill_at {
      c_send_sigterm(job.parent_pid)
      kill_sent = true
    }
    @async.sleep(300)
  }
  // 2) 原子换入(失败保留 .old:exe 未被破坏,下次启动再试)。
  //    跨后端上传换入(no_swap)跳过:新二进制在 restart_exe(数据目录
  //    bin/ 下),原可执行文件保持原位 —— 回滚就是重新拉起它。
  if job.no_swap {
    ()
  } else {
    @fs.rename(job.staging, job.exe, replace=true) catch {
      e => {
        write_done(job.done, false, "换入失败:\{e}")
        return 1
      }
    }
  }
  // 3) CLI 模式:换入即完成(新二进制已在换入前实跑校验过),不拉起 daemon
  let restart_args = match job.restart_args {
    Some(args) => args
    None => {
      if !job.no_swap {
        @fs.remove(job.old_exe) catch {
          _ => ()
        }
      }
      write_done_ok(job.done, "cli", job.version)
      return 0
    }
  }
  // 4) daemon 模式:先清旧标记,再拉起新进程(失败即回滚,不留孤儿 .old)。
  //    拉起目标:上传换入用包里的二进制,发布路径是换入后的自身路径。
  @fs.remove(job.marker) catch {
    _ => ()
  }
  let new_exe = job.restart_exe.unwrap_or(job.exe)
  match
    spawn_restarted(
      new_exe,
      restart_args,
      job.restart_cwd,
      job.marker,
      job.log_file,
    ) {
    Err(error) => {
      rollback(
        job.exe,
        job.old_exe,
        restart_args,
        job.restart_cwd,
        job.marker,
        job.log_file,
        job.no_swap,
      ) catch {
        rollback_error => {
          write_done_rollback(job.done, Some("\{rollback_error}"), error)
          return 1
        }
      }
      write_done_rollback(job.done, None, error)
      return 1
    }
    Ok(_) => ()
  }
  // 5) 等健康标记;超时说明新进程起不来,换回旧版并拉回
  let marker_deadline = @async.now() + job.verify_ms
  while !@fs.exists(job.marker) {
    if @async.now() >= marker_deadline {
      rollback(
        job.exe,
        job.old_exe,
        restart_args,
        job.restart_cwd,
        job.marker,
        job.log_file,
        job.no_swap,
      ) catch {
        rollback_error => {
          write_done_rollback(
            job.done,
            Some("\{rollback_error}"),
            "新进程未在时限内写健康标记",
          )
          return 1
        }
      }
      write_done_rollback(
        job.done,
        None,
        "新进程未在时限内写健康标记",
      )
      return 1
    }
    @async.sleep(300)
  }
  // 子进程是 detached 常驻进程,不 wait —— 职责到「标记已写」为止
  @fs.remove(job.marker) catch {
    _ => ()
  }
  @fs.remove(job.old_exe) catch {
    _ => ()
  }
  write_done_ok(job.done, "daemon", job.version)
  0
}

///|
async fn load_job(job_path : String) -> UpdateJob? {
  let data = @fs.read_file(job_path) catch { _ => return None }
  let text = data.text() catch { _ => return None }
  let json = @json.parse(text) catch { _ => return None }
  UpdateJob::from_json(json)
}

///|
/// 以原 argv 与原工作目录拉起 daemon,env 里带上健康标记路径。
/// stdout/stderr 接到日志文件(启动期的 panic 不能进 /dev/null,否则排障
/// 一片黑);失败返回错误文本。
async fn spawn_restarted(
  exe : String,
  args : Array[String],
  cwd : String?,
  marker : String,
  log_file : String?,
) -> Result[Unit, String] {
  let env : Map[String, String] = Map([])
  env.set(UPDATE_MARKER_ENV, marker)
  let cwd_view : StringView? = match cwd {
    Some(c) => Some(c[:])
    None => None
  }
  match log_file {
    Some(path) => {
      let out = @process.redirect_to_file(path, append=true) catch {
        e => return Err("拉起新进程失败:\{e}")
      }
      let _ = @process.spawn_orphan(
        exe,
        args,
        extra_env=env,
        cwd?=cwd_view,
        stdout=out,
        stderr=out,
        inherit_env=true,
      ) catch {
        e => return Err("拉起新进程失败:\{e}")
      }
      Ok(())
    }
    None => {
      let _ = @process.spawn_orphan(
        exe,
        args,
        extra_env=env,
        cwd?=cwd_view,
        inherit_env=true,
      ) catch {
        e => return Err("拉起新进程失败:\{e}")
      }
      Ok(())
    }
  }
}

///|
/// 换回 `.old` 并拉回旧进程。跨后端上传换入(no_swap)没有动过 exe,
/// 直接重新拉起它即可。
async fn rollback(
  exe : String,
  old_exe : String,
  restart_args : Array[String],
  restart_cwd : String?,
  marker : String,
  log_file : String?,
  no_swap : Bool,
) -> Unit {
  if !no_swap {
    @fs.rename(old_exe, exe, replace=true) catch {
      e => raise Io("回滚换入失败:\{e}")
    }
  }
  match spawn_restarted(exe, restart_args, restart_cwd, marker, log_file) {
    Ok(_) => ()
    Err(error) => raise Io("回滚后拉起旧进程失败:\{error}")
  }
}

///|
/// 看门狗结果落盘(排障用,内容是 JSON)。
async fn write_done(done : String, ok : Bool, error : String) -> Unit {
  let map : Map[String, Json] = Map([])
  map.set("ok", Json::boolean(ok))
  map.set("error", Json::string(error))
  @fs.write_file(done, Json::object(map).stringify()) catch {
    _ => ()
  }
}

///|
async fn write_done_ok(done : String, mode : String, version : String) -> Unit {
  let map : Map[String, Json] = Map([])
  map.set("ok", Json::boolean(true))
  map.set("mode", Json::string(mode))
  map.set("version", Json::string(version))
  @fs.write_file(done, Json::object(map).stringify()) catch {
    _ => ()
  }
}

///|
async fn write_done_rollback(
  done : String,
  rollback_error : String?,
  error : String,
) -> Unit {
  let map : Map[String, Json] = Map([])
  map.set("ok", Json::boolean(false))
  map.set("rolledBack", Json::boolean(true))
  match rollback_error {
    Some(e) => map.set("rollbackError", Json::string(e))
    None => ()
  }
  map.set("error", Json::string(error))
  @fs.write_file(done, Json::object(map).stringify()) catch {
    _ => ()
  }
}

// ---- 路径工具 ----

///|
/// 同路径加后缀:`/usr/local/bin/syncx-mb` → `/usr/local/bin/syncx-mb.old`。
/// Windows 的 `\` 与 Unix 的 `/` 都按分隔符处理。
pub fn sibling_with_suffix(path : String, suffix : String) -> String {
  "\{path}\{suffix}"
}

///|
/// 父目录(`/a/b/syncx-mb` → `/a/b`);没有分隔符返回 None。
fn parent_dir(path : String) -> String? {
  let mut idx = -1
  let mut i = 0
  for c in path {
    if c == '/' || c == '\\' {
      idx = i
    }
    i = i + 1
  }
  if idx <= 0 {
    return None
  }
  Some(path[0:idx].to_owned())
}
