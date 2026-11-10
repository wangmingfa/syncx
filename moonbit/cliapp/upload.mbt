///|
/// 上传安装包换入(对应 Node `src/selfupdate.ts` 的上传管线 + Rust 侧
/// `/api/self-update/upload`;路由面在 api/upload.mbt,本文件是 cli 侧实现)。
///
/// 识别两类 `pack:local` 产物:
///  - npm tgz:顶层 `package/`,含 `package.json` + `dist/syncx.js` → node 包;
///  - 后端包:顶层目录 `syncx-{rs,mbt}-v{semver}-{triple}`,含单二进制
///    `syncx-rs` / `syncx-mb` → rust / moonbit 包。
///
/// 换入语义(与 GitHub Releases 自更新共用看门狗,见 update.mbt):
///  - 只有 rust / moonbit 包能换入(node 包没有可 exec 的单二进制,
///    MoonBit 后端也不携带 node 运行时);
///  - 新二进制解到 `<configDir>/bin/` 下,原可执行文件保持原位
///    (no_swap):跨后端拉起 = exec 包里的二进制,回滚 = 重新拉起本进程;
///  - target 三元组必须与本机一致(防 arm/x64 混装),版本号必须是合法
///    semver —— 二者都来自目录名,解析失败一律拒绝。

///|
/// 上传包大小上界(与 Node 侧 ws 通道上限同口径)。
pub const MAX_UPLOAD_PACKAGE_BYTES : Int32 = 64 * 1024 * 1024

///|
/// 上传包大小下界:低于此值几乎必是损坏/截断的传输结果。
/// (测试构造的小包经 min_bytes 参数放宽,生产走本值。)
pub const MIN_UPLOAD_PACKAGE_BYTES : Int32 = 4096

///|
/// 六个发布目标(与 update.mbt 的 target_triple 同一矩阵)。
pub fn known_target_triples() -> Array[String] {
  [
    "x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu", "x86_64-apple-darwin",
    "aarch64-apple-darwin", "x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc",
  ]
}

///|
/// 解包后的包描述(识别 + 换入共用;`inspect` 路径只取前四个字段)。
pub(all) struct UploadedPackage {
  /// `node | rust | moonbit`。
  backend : String
  /// 包内版本(semver,已校验;后端包取自顶层目录名)。
  version : String
  /// 后端包的目标三元组(node 包为 None)。
  target : String?
  /// npm 包的包名(后端包为 None)。
  name : String?
  /// 解包临时目录(调用方负责清理)。
  work_dir : String
  /// 顶层目录绝对路径。
  root : String
  /// 后端包内二进制绝对路径(node 包为 None)。
  binary : String?
}

///|
/// 后端包顶层目录名 → (后端, 版本, 目标三元组)。
///
/// 形如 `syncx-rs-v0.4.1-aarch64-apple-darwin` /
/// `syncx-mbt-v0.4.1-local.1-x86_64-apple-darwin`(pack-local.mjs 的
/// stage 命名,与 Release 资产名一致)。目标三元组从尾部对 6 个发布目标
/// 匹配 —— 预发布后缀里也可能含 `-`,不能用「第一个 -」切分;剩余部分
/// 必须是合法 semver。
pub fn parse_backend_dir_name(name : String) -> (String, String, String)? {
  // mbt 前缀在前:syncx-mbt-v 与 syncx-rs-v 不重叠,先后只影响可读性
  let (backend, rest) : (String, StringView) = if name.has_prefix("syncx-mbt-v") {
    ("moonbit", name[11:])
  } else if name.has_prefix("syncx-rs-v") {
    ("rust", name[10:])
  } else {
    return None
  }
  for triple in known_target_triples() {
    let suffix : StringView = "-\{triple}"
    if ends_with(rest, suffix) {
      let version = rest[0:rest.length() - suffix.length()].to_owned()
      // 形状对了但版本不合法:直接拒绝,不继续试别的三元组
      //(同一个尾部不可能同时是两个三元组)
      if valid_semver(version) {
        return Some((backend, version, triple))
      }
      return None
    }
  }
  None
}

///|
fn ends_with(text : StringView, suffix : StringView) -> Bool {
  text.length() >= suffix.length() &&
  text[text.length() - suffix.length():] == suffix
}

///|
/// semver 形状校验:`maj.min.patch` + 可选 `-pre` + 可选 `+build`
/// (与 Node extractAndValidate 的正则、pack-local 的校验同口径)。
pub fn valid_semver(version : String) -> Bool {
  let view : StringView = version
  // 构建元数据(+build):至多一段,字符集受限且非空
  let main : StringView = match view.find("+") {
    Some(i) => {
      let build = view[i + 1:]
      if build.char_length() == 0 || !semver_chars_ok(build) {
        return false
      }
      view[0:i]
    }
    None => view
  }
  // 预发布(-pre):取第一个 `-` 之后全部(pre 内部允许再含 `-`)
  let base : StringView = match main.find("-") {
    Some(i) => {
      let pre = main[i + 1:]
      if pre.char_length() == 0 || !semver_chars_ok(pre) {
        return false
      }
      main[0:i]
    }
    None => main
  }
  // 主版本:恰好三段非空纯数字
  let parts : Array[StringView] = base.split(".").collect()
  if parts.length() != 3 {
    return false
  }
  for part in parts {
    if !all_digits(part) {
      return false
    }
  }
  true
}

///|
/// pre/build 段的合法字符:字母 / 数字 / 点 / 连字符(semver 规范)。
fn semver_chars_ok(text : StringView) -> Bool {
  let mut ok = true
  for c in text {
    if !is_ascii_alnum(c) && c != '.' && c != '-' {
      ok = false
      break
    }
  }
  ok
}

///|
/// 解包失败时清理临时目录并组装错误(每个 Err 出口都走这里,
/// 不留脏目录)。
async fn extract_fail(
  work : String,
  message : String,
) -> Result[UploadedPackage, String] {
  @fs.rmdir(work, recursive=true) catch {
    _ => ()
  }
  Err(message)
}

///|
/// 写入归档并解包到临时目录(tar.gz 用系统 tar,Windows zip 用 PowerShell
/// Expand-Archive —— 与 update.mbt unpack_binary 同策略)。
async fn unpack_archive(work : String, bytes : Bytes) -> Result[Unit, String] {
  let windows = c_os_name() == "windows"
  let archive_path = if windows {
    "\{work}/pkg.zip"
  } else {
    "\{work}/pkg.tar.gz"
  }
  @fs.write_file(archive_path, bytes) catch {
    e => return Err("写入安装包失败:\{e}")
  }
  if windows {
    let code = @process.run(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Expand-Archive -LiteralPath '\{archive_path}' -DestinationPath '\{work}' -Force",
      ],
      inherit_env=true,
    ) catch {
      e => return Err("解压安装包失败(PowerShell Expand-Archive):\{e}")
    }
    if code != 0 {
      return Err("解压安装包失败(PowerShell Expand-Archive)")
    }
  } else {
    let code = @process.run(
      "tar",
      ["-xzf", archive_path, "-C", work],
      inherit_env=true,
    ) catch {
      e => return Err("解压安装包失败(tar):\{e}")
    }
    if code != 0 {
      return Err("解压安装包失败(tar):不是有效的 tar.gz 安装包")
    }
  }
  Ok(())
}

///|
/// 解包并识别上传的安装包。成功后 `work_dir` 由调用方清理。
///
/// 识别依据是**包内容**:上传请求体只有原始字节、没有文件名,顶层结构
/// 是唯一可信来源(npm tgz 顶层 `package/`,后端包顶层
/// `syncx-{rs,mbt}-v*-<triple>/`)。
pub async fn extract_package(
  bytes : Bytes,
  min_bytes~ : Int32 = MIN_UPLOAD_PACKAGE_BYTES,
) -> Result[UploadedPackage, String] {
  if bytes.length() < min_bytes {
    return Err(
      "安装包仅 \{bytes.length()} 字节,疑似损坏(应为 pack:local 产物),已放弃",
    )
  }
  if bytes.length() > MAX_UPLOAD_PACKAGE_BYTES {
    return Err(
      "安装包 \{bytes.length()} 字节超出上限,疑似损坏,已放弃",
    )
  }
  let work = @fs.tmpdir(prefix="syncx-upload") catch {
    e => return Err("创建临时目录失败:\{e}")
  }
  match unpack_archive(work, bytes) {
    Err(message) => return extract_fail(work, message)
    Ok(_) => ()
  }
  let entries : Array[String] = @fs.readdir(work) catch {
    _ => return extract_fail(work, "读取解包结果失败")
  }
  // npm tgz:顶层 package/ + package.json + dist/syncx.js
  if entries.contains("package") {
    let root = "\{work}/package"
    return inspect_node_package(work, root)
  }
  // 后端包:顶层 syncx-{rs,mbt}-v*-<triple>/ + 单二进制
  for name in entries {
    match parse_backend_dir_name(name) {
      Some((backend, version, triple)) =>
        return inspect_backend_package(
          work,
          "\{work}/\{name}",
          backend,
          version,
          triple,
        )
      None => ()
    }
  }
  extract_fail(
    work, "无法识别的安装包:顶层应为 package/(npm 包)或 syncx-rs / syncx-mbt 安装包目录",
  )
}

///|
/// npm tgz 结构校验(文案与 Node extractAndValidate 逐字一致)。
async fn inspect_node_package(
  work : String,
  root : String,
) -> Result[UploadedPackage, String] {
  let pkg_path = "\{root}/package.json"
  if !(@fs.exists(pkg_path) catch { _ => false }) {
    return extract_fail(
      work, "更新包缺少 package.json,结构异常,已放弃升级",
    )
  }
  let raw = @fs.read_file(pkg_path) catch {
    _ =>
      return extract_fail(
        work, "更新包 package.json 无法解析,已放弃升级",
      )
  }
  let json = @json.parse(
    raw.text() catch {
      _ =>
        return extract_fail(
          work, "更新包 package.json 无法解析,已放弃升级",
        )
    },
  ) catch {
    _ =>
      return extract_fail(
        work, "更新包 package.json 无法解析,已放弃升级",
      )
  }
  let obj = match json {
    Object(obj) => obj
    _ =>
      return extract_fail(
        work, "更新包 package.json 无法解析,已放弃升级",
      )
  }
  let name = match obj.get("name") {
    Some(String(name)) => name
    _ => ""
  }
  if name != "@wangmingfa/syncx" && name != "syncx" {
    return extract_fail(work, "更新包包名异常(\{name}),已放弃升级")
  }
  let version = match obj.get("version") {
    Some(String(v)) => v.trim().to_owned()
    _ => ""
  }
  if !valid_semver(version) {
    let shown = if version == "" { "(缺失)" } else { version }
    return extract_fail(
      work,
      "更新包版本号异常(\{shown}),已放弃升级",
    )
  }
  let bundle = "\{root}/dist/syncx.js"
  if !(@fs.exists(bundle) catch { _ => false }) {
    return extract_fail(
      work, "更新包缺少 dist/syncx.js,结构异常,已放弃升级",
    )
  }
  Ok({
    backend: "node",
    version,
    target: None,
    name: Some(name),
    work_dir: work,
    root,
    binary: None,
  })
}

///|
/// 后端包结构校验:target 必须与本机一致(防 arm/x64 混装),
/// 二进制必须真实存在且非空。
async fn inspect_backend_package(
  work : String,
  root : String,
  backend : String,
  version : String,
  triple : String,
) -> Result[UploadedPackage, String] {
  let current = detect_target() catch {
    e => return extract_fail(work, UpdateError::to_text(e))
  }
  if triple != current {
    return extract_fail(
      work,
      "安装包目标平台(\{triple})与本机(\{current})不符,已放弃换入(防 arm/x64 混装)",
    )
  }
  let binary_name = backend_binary_name(backend)
  let binary = "\{root}/\{binary_name}"
  if !(@fs.exists(binary) catch { _ => false }) {
    return extract_fail(
      work,
      "安装包缺少可执行文件 \{binary_name},结构异常,已放弃换入",
    )
  }
  let size = @fs.file_size(binary) catch {
    _ =>
      return extract_fail(
        work, "读取安装包内二进制失败,已放弃换入",
      )
  }
  if size <= 0 {
    return extract_fail(
      work, "安装包内二进制为空,疑似损坏,已放弃换入",
    )
  }
  Ok({
    backend,
    version,
    target: Some(triple),
    name: None,
    work_dir: work,
    root,
    binary: Some(binary),
  })
}

///|
/// 上传换入主流程:识别 → 按包类型分流。npm tgz 走「npm 覆盖 + 看门狗
/// 拉起 node 入口」(install_node_package);后端二进制包走「解包到
/// <configDir>/bin/ + 看门狗 exec」(install_backend_binary + 交接)。
///
/// 成功返回将要换入的版本号;此时看门狗已经 detached 拉起,本进程会在
/// 宽限期后被 SIGTERM(见 update.mbt 的 kill_parent_ms)。dev 运行态一律
/// 拒绝(与 api 层的 dev 门同一文案,双保险)。
pub async fn perform_upload_swap(
  bytes : Bytes,
  config_dir : String,
  min_bytes~ : Int32 = MIN_UPLOAD_PACKAGE_BYTES,
  npm_cmd~ : String = "npm",
) -> Result[String, String] {
  if @core.VERSION == "dev" {
    return Err(
      "开发模式下不支持升级功能（运行态为 dev，无单文件运行时可替换）",
    )
  }
  let pkg = match extract_package(bytes, min_bytes~) {
    Ok(pkg) => pkg
    Err(message) => return Err(message)
  }
  if pkg.backend == "node" {
    // node 包:npm install -g 覆盖安装,看门狗拉起新装的 node 入口
    let version = pkg.version
    @fs.rmdir(pkg.work_dir, recursive=true) catch {
      _ => ()
    }
    return install_node_package(bytes, config_dir, version, npm_cmd~)
  }
  let dest = match install_backend_binary(pkg, config_dir) {
    Ok(dest) => dest
    Err(message) => {
      @fs.rmdir(pkg.work_dir, recursive=true) catch {
        _ => ()
      }
      return Err(message)
    }
  }
  let version = pkg.version
  // 解包产物已用不上(二进制已拷进 bin/),清掉临时目录
  @fs.rmdir(pkg.work_dir, recursive=true) catch {
    _ => ()
  }
  let current_exe = c_current_exec_path()
  if current_exe == "" {
    return Err("找不到当前可执行文件路径,已放弃换入")
  }
  spawn_upload_swap(
    current_exe,
    dest,
    version,
    build_update_restart(@env.args()),
  ) catch {
    e => return Err(UpdateError::to_text(e))
  }
  Ok(version)
}

///|
/// npm 命令的跨平台调用参数:Windows 上 npm 是 npm.cmd,须经 cmd /C
/// (与 Rust 端 install_tarball 同策略)。
fn npm_argv(
  windows : Bool,
  npm_cmd : String,
  args : Array[String],
) -> (String, Array[String]) {
  if windows {
    let argv : Array[String] = ["/C", npm_cmd]
    for arg in args {
      argv.push(arg)
    }
    ("cmd", argv)
  } else {
    (npm_cmd, args)
  }
}

///|
/// 用系统 npm 覆盖安装本地 tgz(`npm install -g <tgz>`):它同时更新
/// 安装目录与 bin 链接,是从 MoonBit 切回 Node 的最稳通道(与 Rust 端
/// install_tarball 同一做法)。npm 缺失/失败时明确报错,不半途换入。
pub async fn npm_install_global(
  tgz_path : String,
  npm_cmd~ : String = "npm",
) -> Result[Unit, String] {
  let (program, args) = npm_argv(c_os_name() == "windows", npm_cmd, [
    "install", "-g", tgz_path,
  ])
  let code = @process.run(program, args, inherit_env=true) catch {
    e =>
      return Err(
        "npm install -g 失败(无法启动 npm,本机可能未安装 Node.js/npm):\{e}",
      )
  }
  if code != 0 {
    return Err("npm install -g 失败(退出码 \{code})")
  }
  Ok(())
}

///|
/// 定位 npm 全局安装后的 syncx 入口:`npm root -g` →
/// `<root>/@wangmingfa/syncx/dist/syncx.js`。启动时由看门狗以
/// `node <入口> <原参数>` 拉起,不依赖 bin 链接的形态(Windows 的
/// .cmd 无法直接 exec)。
pub async fn resolve_global_syncx_entry(
  npm_cmd~ : String = "npm",
) -> Result[String, String] {
  let (program, args) = npm_argv(c_os_name() == "windows", npm_cmd, [
    "root", "-g",
  ])
  let (code, out) = @process.collect_stdout(program, args, inherit_env=true) catch {
    e =>
      return Err(
        "定位全局安装目录失败(npm root -g 无法执行,本机可能未安装 Node.js/npm):\{e}",
      )
  }
  if code != 0 {
    return Err("定位全局安装目录失败(npm root -g 退出码 \{code})")
  }
  let text = out.text() catch { _ => return Err("npm root -g 输出异常") }
  let root = text.trim().to_owned()
  if root == "" {
    return Err("npm root -g 输出为空")
  }
  let entry = "\{root}/@wangmingfa/syncx/dist/syncx.js"
  if !(@fs.exists(entry) catch { _ => false }) {
    return Err(
      "npm 安装完成但找不到入口 \{entry},已放弃切换(请检查 npm 全局 prefix)",
    )
  }
  Ok(entry)
}

///|
/// 从原启动参数里解析控制端口(--control-port,缺省 8384),拼出健康
/// 判定地址:node 后端不写健康标记,看门狗轮询 /health 判活。
pub fn control_port_of_args(args : Array[String]) -> Int32 {
  let mut i = 0
  while i + 1 < args.length() {
    if args[i] == "--control-port" {
      let port = @string.parse_int(args[i + 1]) catch { _ => -1 }
      if port >= 1 && port <= 65535 {
        return port
      }
    }
    i += 1
  }
  DEFAULT_CONTROL_PORT
}

///|
pub fn health_url_of_args(args : Array[String]) -> String {
  "http://127.0.0.1:\{control_port_of_args(args)}/health"
}

///|
/// npm tgz 换入(切回 Node):tgz 落盘到 `<configDir>/update/` →
/// `npm install -g` → 定位新装的 dist/syncx.js → 看门狗拉起
/// `node <入口> <原参数>`(健康判定走 /health 轮询,超时回滚原
/// MoonBit 二进制)。npm 不可用/安装失败时直接报错,不写交接作业。
async fn install_node_package(
  bytes : Bytes,
  config_dir : String,
  version : String,
  npm_cmd~ : String = "npm",
) -> Result[String, String] {
  // 1) tgz 落盘(npm 只吃文件路径;放数据目录 update/ 下,与 Rust 同布局)
  let update_dir = "\{config_dir}/update"
  @fs.mkdir(update_dir, recursive=true, allow_exist=true) catch {
    e => return Err("创建目录失败(\{update_dir}):\{e}")
  }
  let tgz_path = "\{update_dir}/\{@async.now()}.tgz"
  @fs.write_file(tgz_path, bytes) catch {
    e => return Err("写入安装包失败(\{tgz_path}):\{e}")
  }
  // 2) npm 覆盖安装(缺 npm 时在这里明确报错,不半途换入)
  match npm_install_global(tgz_path, npm_cmd~) {
    Ok(_) => ()
    Err(message) => return Err(message)
  }
  // 3) 定位新装的 node 入口
  let entry = match resolve_global_syncx_entry(npm_cmd~) {
    Ok(entry) => entry
    Err(message) => return Err(message)
  }
  // 4) 交接看门狗:拉起 `node <入口> <原参数>`,健康判定轮询 /health
  let current_exe = c_current_exec_path()
  if current_exe == "" {
    return Err("找不到当前可执行文件路径,已放弃切换")
  }
  let base_args : Array[String] = if argv_has_program() {
    let argv = @env.args()
    argv[1:].to_owned()
  } else {
    []
  }
  let restart_args : Array[String] = [entry]
  for arg in base_args {
    restart_args.push(arg)
  }
  spawn_upload_swap(
    current_exe,
    "node",
    version,
    { args: restart_args, cwd: None, log_file: log_file_of_args(base_args), },
    health_url=Some(health_url_of_args(base_args)),
  ) catch {
    e => return Err(UpdateError::to_text(e))
  }
  Ok(version)
}

///|
/// 本进程 argv 是否带程序名(@env.args 的口径:第一个元素是程序名)。
fn argv_has_program() -> Bool {
  let argv = @env.args()
  argv.length() > 0
}

///|
/// 后端对应的二进制名(Windows 带 .exe;与发布 workflow / pack-local 一致)。
fn backend_binary_name(backend : String) -> String {
  let base = if backend == "rust" { "syncx-rs" } else { "syncx-mb" }
  if c_os_name() == "windows" {
    "\{base}.exe"
  } else {
    base
  }
}

///|
/// 只读预检:识别 + 读出版本/目标/包名,临时目录用完即清。
/// 返回 api 包的结论类型(路由层直接序列化)。
pub async fn inspect_uploaded_package(
  bytes : Bytes,
  min_bytes~ : Int32 = MIN_UPLOAD_PACKAGE_BYTES,
) -> Result[@api.InspectedPackage, String] {
  match extract_package(bytes, min_bytes~) {
    Ok(pkg) => {
      let info : @api.InspectedPackage = {
        backend: pkg.backend,
        version: pkg.version,
        target: pkg.target,
        name: pkg.name,
      }
      @fs.rmdir(pkg.work_dir, recursive=true) catch {
        _ => ()
      }
      Ok(info)
    }
    Err(message) => Err(message)
  }
}

///|
/// 把包里的二进制安装到 `<configDir>/bin/`(临时文件 + 原子 rename:
/// 目标可能正是上一轮换入、当前正在运行的二进制,直接写会 ETXTBSY),
/// 再实跑 `--version` 校验。换入不可逆的防线在这一步 —— 一个起不来的
/// 二进制换进去,这台机器就再也没机会自更新了。
pub async fn install_backend_binary(
  pkg : UploadedPackage,
  config_dir : String,
) -> Result[String, String] {
  let binary = match pkg.binary {
    Some(binary) => binary
    None => return Err("安装包内没有可执行文件,已放弃换入")
  }
  let bin_dir = "\{config_dir}/bin"
  @fs.mkdir(bin_dir, recursive=true, allow_exist=true) catch {
    e => return Err("创建目录失败(\{bin_dir}):\{e}")
  }
  let dest = "\{bin_dir}/\{backend_binary_name(pkg.backend)}"
  let tmp = "\{dest}.tmp"
  let content = @fs.read_file(binary) catch {
    e => return Err("读取安装包内二进制失败:\{e}")
  }
  @fs.write_file(tmp, content) catch {
    e => return Err("写入二进制失败(\{tmp}):\{e}")
  }
  // Unix 补执行位(0755);Windows 没有这一步
  if c_os_name() != "windows" {
    @fs.chmod(tmp, 493) catch {
      _ => ()
    }
  }
  @fs.rename(tmp, dest, replace=true) catch {
    e => {
      @fs.remove(tmp) catch {
        _ => ()
      }
      return Err("二进制落位失败(\{dest}):\{e}")
    }
  }
  // 实跑校验:版本号必须与包声明一致
  let printed = binary_version(dest) catch { _ => None }
  match printed {
    Some(printed) =>
      if !printed.contains(pkg.version) {
        Err(
          "新二进制版本不符(期望 \{pkg.version},实际输出 \{printed}),已放弃换入",
        )
      } else {
        Ok(dest)
      }
    None => Err("新二进制无法执行(\{dest}),已放弃换入")
  }
}

///|
/// 从进程 argv 折算重启参数:args = 原 argv 去掉程序名(新后端以同样的
/// 参数面启动:`start --config <路径> ...`);--log-file 单独挑出来给
/// 看门狗接新进程的 stdout/stderr(Node updater 同款)。
pub fn build_update_restart(argv : Array[String]) -> UpdateRestart {
  let args : Array[String] = if argv.length() > 0 {
    argv[1:].to_owned()
  } else {
    []
  }
  { args, cwd: None, log_file: log_file_of_args(args), }
}

///|
fn log_file_of_args(args : Array[String]) -> String? {
  let mut i = 0
  while i + 1 < args.length() {
    if args[i] == "--log-file" {
      return Some(args[i + 1])
    }
    i += 1
  }
  None
}
