///|
/// CLI 参数解析(语义对齐 Node `src/args.ts`)。
///
/// MoonBit 后端只实现 `start` 一个子命令面:其他已知命令(stop/status/…)
/// 给出「尚未实现」的明确报错,未知命令与未知选项直接拒绝;参数错误必须
/// 走非零退出码(Node 同款,否则脚本/CI 的 `|| exit 1` 判断全部失灵)。

///|
/// CLI 层错误(启动编排各环节的致命错误统一形态)。
pub(all) suberror CliError {
  Fatal(String)
}

///|
pub fn CliError::to_text(self : CliError) -> String {
  match self {
    Fatal(message) => message
  }
}

///|
/// 已知子命令集合(与 Node `COMMANDS` 一致;当前仅 start 可执行)。
pub let known_commands : Array[String] = [
  "start", "stop", "status", "install", "invite", "join", "revoke", "upgrade", "diff",
  "pause", "resume",
]

///|
/// 控制 API 可安全绑定的回环地址;非回环地址必须显式 `--expose-control`
/// (明文 HTTP 暴露到 LAN 会被嗅探 token,与 Node 同口径强制拦截)。
pub let loopback_hosts : Array[String] = ["127.0.0.1", "::1", "localhost"]

///|
/// 控制 API 默认端口(Node/Rust 同值)。
pub const DEFAULT_CONTROL_PORT : Int32 = 8384

///|
/// peer 数据面默认监听端口(Rust `DEFAULT_PEER_PORT` 同值)。
pub const DEFAULT_PEER_PORT : Int32 = 22000

///|
/// `start` 的参数面。全部可缺省:config 缺省回 `~/.syncx/config.json`,
/// 端口缺省由启动编排层取默认值(控制口 8384 / peer 口 22000)。
pub(all) struct StartArgs {
  /// `--config`:完整配置文件路径;与 `--config-dir` 同时给出时优先。
  mut config_path : String?
  /// `--config-dir`:数据目录(取 `<dir>/config.json` 作为配置文件)。
  mut config_dir : String?
  /// `--host`:控制 API 绑定地址,缺省 127.0.0.1。
  mut host : String?
  /// `--port`:peer 数据面监听端口,缺省 22000。
  mut port : Int32?
  /// `--control-port`:控制 API 端口,缺省 8384。
  mut control_port : Int32?
  /// `--log-file`:日志文件路径;缺省仅输出到 stdout。
  mut log_file : String?
  /// `--dev-vite`:vite dev server 基址(dev 态判定用)。
  mut dev_vite_url : String?
  /// `--expose-control`:允许控制 API 绑定非回环地址。
  mut expose_control : Bool
  /// 位置参数(start 语义下应恒为空,保留以便与 Node 的解析器同形)。
  positionals : Array[String]
}

///|
/// 解析 `start` 参数。`argv` 不含程序名,也不含子命令本身
/// (子命令由 main 剥离后再进入这里)。报错文案与 Node 逐字对齐。
pub fn parse_start_args(argv : Array[String]) -> Result[StartArgs, String] {
  let args : StartArgs = {
    config_path: None,
    config_dir: None,
    host: None,
    port: None,
    control_port: None,
    log_file: None,
    dev_vite_url: None,
    expose_control: false,
    positionals: [],
  }
  let mut i = 0
  while i < argv.length() {
    let flag = argv[i]
    if flag == "--config" {
      match take_value(argv, i, flag) {
        Ok((v, next_i)) => {
          args.config_path = Some(v)
          i = next_i
        }
        Err(e) => return Err(e)
      }
    } else if flag == "--config-dir" {
      match take_value(argv, i, flag) {
        Ok((v, next_i)) => {
          args.config_dir = Some(v)
          i = next_i
        }
        Err(e) => return Err(e)
      }
    } else if flag == "--host" {
      match take_value(argv, i, flag) {
        Ok((v, next_i)) => {
          args.host = Some(v)
          i = next_i
        }
        Err(e) => return Err(e)
      }
    } else if flag == "--log-file" {
      match take_value(argv, i, flag) {
        Ok((v, next_i)) => {
          args.log_file = Some(v)
          i = next_i
        }
        Err(e) => return Err(e)
      }
    } else if flag == "--dev-vite" {
      match take_value(argv, i, flag) {
        Ok((v, next_i)) => {
          // 与 Node 侧 `new URL(value)` 同职责:非法基址当场报错,
          // 而不是等某次请求代理时才炸。
          if !valid_vite_url(v) {
            return Err("invalid --dev-vite url: \{v}")
          }
          args.dev_vite_url = Some(v)
          i = next_i
        }
        Err(e) => return Err(e)
      }
    } else if flag == "--port" || flag == "--control-port" {
      match take_value(argv, i, flag) {
        Ok((v, next_i)) =>
          match parse_port(v) {
            Ok(p) => {
              if flag == "--port" {
                args.port = Some(p)
              } else {
                args.control_port = Some(p)
              }
              i = next_i
            }
            Err(_) => return Err("invalid \{flag}: \{v}")
          }
        Err(e) => return Err(e)
      }
    } else if flag == "--expose-control" {
      args.expose_control = true
      i += 1
    } else if flag.has_prefix("-") {
      return Err("unknown option: \{flag}")
    } else {
      args.positionals.push(flag)
      i += 1
    }
  }
  // 控制 API 暴露防护(与 Node 同文案):非回环地址必须显式 --expose-control。
  match args.host {
    Some(host) =>
      if !loopback_hosts.contains(host) && !args.expose_control {
        return Err(
          "--host \{host} exposes the control API over plain HTTP on the LAN; pass --expose-control to allow it",
        )
      }
    None => ()
  }
  Ok(args)
}

///|
/// 取一个带值选项的取值。返回 (取值, 下一个下标);缺值报错。
fn take_value(
  argv : Array[String],
  i : Int32,
  flag : String,
) -> Result[(String, Int32), String] {
  if i + 1 >= argv.length() {
    return Err("缺少 \{flag} 的取值")
  }
  Ok((argv[i + 1], i + 2))
}

///|
/// 解析端口取值:必须是 1..65535 的整数(Node 侧靠 listen 报错,
/// 这里提前到解析层,启动日志更可指向)。
fn parse_port(text : String) -> Result[Int32, String] {
  let port = @string.parse_int(text) catch { _ => return Err(text) }
  if port < 1 || port > 65535 {
    return Err(text)
  }
  Ok(port)
}

///|
/// vite 基址最小校验:必须是 http(s):// 开头且 host 非空。
/// Node 用 URL 构造器做完整校验,MoonBit 侧没有等价物,取其要害:
/// 协议头 + 非空 host(端口/路径交给后续代理逻辑)。
fn valid_vite_url(url : String) -> Bool {
  let rest = if url.has_prefix("http://") {
    url[7:].to_owned()
  } else if url.has_prefix("https://") {
    url[8:].to_owned()
  } else {
    return false
  }
  // host 非空:第一个 `/`、`:` 之前必须有字符。
  let host = match rest.find("/") {
    Some(i) => rest[0:i].to_owned()
    None =>
      match rest.find(":") {
        Some(i) => rest[0:i].to_owned()
        None => rest
      }
  }
  host != ""
}

///|
/// dev 态判定:`--dev-vite` 显式开启,或 dist/web 不存在(与 Node 的
/// 「无 dist 降级」同语义)。`dist_missing` 由启动编排在异步上下文里
/// 用 `@fs.exists` 探测后传入(本函数保持纯函数,可直接单测)。
pub fn is_dev_mode(args : StartArgs, dist_missing : Bool) -> Bool {
  args.dev_vite_url is Some(_) || dist_missing
}

///|
/// 配置文件路径解析:`--config` 优先于 `--config-dir`,都缺省回
/// `~/.syncx/config.json`(与 Node `run()` 的口径逐字一致)。
pub fn resolve_config_path(args : StartArgs) -> String {
  match args.config_path {
    Some(path) => path
    None =>
      match args.config_dir {
        Some(dir) => "\{dir}/config.json"
        None => default_config_path()
      }
  }
}

///|
/// 默认配置路径 `~/.syncx/config.json`(HOME 缺失退相对路径,仅测试场景)。
pub fn default_config_path() -> String {
  let home = @env.get_env_var("HOME").unwrap_or("")
  if home == "" {
    ".syncx/config.json"
  } else {
    "\{home}/.syncx/config.json"
  }
}

///|
/// 路径的目录部分(最后一个 `/` 之前;无 `/` 回 ".")。
/// 身份/令牌/索引等数据一律放在配置文件所在目录(与 Node 一致)。
pub fn parent_dir_of(path : String) -> String {
  match path.rev_find("/") {
    Some(i) => if i == 0 { "/" } else { path[0:i].to_owned() }
    None => "."
  }
}
