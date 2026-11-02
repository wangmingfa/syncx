//! CLI 参数解析与重连退避策略(纯函数,无 daemon 状态)。
//!
//! 逐条对齐 Node 侧 `src/args.ts` —— 包括**错误文案**。手写解析而不是用 clap:
//! clap 的错误文案是它自己的(`unexpected argument '--foo' found`),而
//! `unknown command: foo` / `unknown option: --foo` 已经是跨后端契约的一部分
//! (两套脚本、两处测试都认这两句)。少一层抽象比多一层"差不多"更安全。

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    Start,
    Stop,
    Status,
    Install,
    Invite,
    Join,
    Revoke,
    Upgrade,
    Diff,
    Pause,
    Resume,
}

impl Command {
    fn parse(raw: &str) -> Option<Self> {
        Some(match raw {
            "start" => Command::Start,
            "stop" => Command::Stop,
            "status" => Command::Status,
            "install" => Command::Install,
            "invite" => Command::Invite,
            "join" => Command::Join,
            "revoke" => Command::Revoke,
            "upgrade" => Command::Upgrade,
            "diff" => Command::Diff,
            "pause" => Command::Pause,
            "resume" => Command::Resume,
            _ => return None,
        })
    }
}

/// 解析结果。缺省值(端口、地址)留给装配层补,不在这里造事实。
#[derive(Debug, Clone, Default)]
pub struct ParsedArgs {
    pub command: Option<Command>,
    /// 位置参数(invite/join/diff 的参数)。
    pub positionals: Vec<String>,
    pub config_path: Option<String>,
    /// 数据目录:取 `<dir>/config.json` 作为配置文件(`--config` 优先)。
    pub config_dir: Option<String>,
    pub port: Option<u16>,
    pub control_port: Option<u16>,
    pub host: Option<String>,
    pub log_file: Option<String>,
    /// `diff` 的目标对端设备 id;缺省对比该目录指派的全部设备。
    pub device: Option<String>,
    /// dev 模式:vite dev server 基址。
    pub dev_vite_url: Option<String>,
    /// `--expose-control` 是否出现(回环闸门用)。
    pub expose_control: bool,
}

/// 控制 API 可安全绑定的回环地址;非回环地址必须显式 `--expose-control`。
pub const LOOPBACK_HOSTS: [&str; 3] = ["127.0.0.1", "::1", "localhost"];

/// 断线重连退避基数与上限(指数退避 1s、2s、4s…,封顶 30s)。
pub const RECONNECT_BASE_MS: u64 = 1000;
pub const RECONNECT_MAX_MS: u64 = 30_000;
/// 无网络时的重连退避下限。
pub const NETWORK_OFFLINE_BACKOFF_MS: u64 = 300_000;

/// 断线重连退避延迟:`attempts` 为已连续失败次数。第 0 次立即重试。
pub fn reconnect_delay_ms(attempts: u32) -> u64 {
    if attempts == 0 {
        return 0;
    }
    let shift = (attempts - 1).min(16);
    (RECONNECT_BASE_MS << shift).min(RECONNECT_MAX_MS)
}

/// 在网感知的退避:无网络时抬到 [`NETWORK_OFFLINE_BACKOFF_MS`] 下限。
pub fn offline_aware_reconnect_delay(delay_ms: u64, network_online: bool) -> u64 {
    if network_online {
        delay_ms
    } else {
        delay_ms.max(NETWORK_OFFLINE_BACKOFF_MS)
    }
}

/// `--dev-vite` 的基址校验。Node 用 `new URL(value)` 抛错,这里只要「有 scheme 与 host」
/// 就等价:两条路都拒绝把一段随意文本当基址,错误时机也一致(解析参数时,而不是首次代理时)。
fn validate_dev_vite(value: &str) -> Result<(), String> {
    let rest = value
        .strip_prefix("http://")
        .or_else(|| value.strip_prefix("https://"));
    match rest {
        Some(rest) if !rest.is_empty() && !rest.starts_with('/') => Ok(()),
        _ => Err(format!("Invalid URL: {value}")),
    }
}

/// 解析 argv(**不含**程序名与 help/version 开关,那两个由 main 先处理)。
pub fn parse_args(argv: &[String]) -> Result<ParsedArgs, String> {
    let mut result = ParsedArgs::default();
    let raw_command = argv.first().map(String::as_str).unwrap_or("start");
    result.command = Some(Command::parse(raw_command).ok_or_else(|| {
        format!("unknown command: {raw_command}")
    })?);

    let rest = argv.get(1..).unwrap_or(&[]);
    let mut index = 0usize;
    while index < rest.len() {
        let flag = rest[index].as_str();
        // 取值型开关:缺值按「缺省」处理,与 Node 的 undefined 同义(不报错)
        let value = rest.get(index + 1).cloned();
        match flag {
            "--config" => {
                result.config_path = value;
                index += 2;
            }
            "--config-dir" => {
                result.config_dir = value;
                index += 2;
            }
            "--port" => {
                result.port = Some(parse_port("--port", value.as_deref())?);
                index += 2;
            }
            "--control-port" => {
                result.control_port = Some(parse_port("--control-port", value.as_deref())?);
                index += 2;
            }
            "--host" => {
                result.host = value;
                index += 2;
            }
            "--log-file" => {
                result.log_file = value;
                index += 2;
            }
            "--device" => {
                result.device = value;
                index += 2;
            }
            "--dev-vite" => {
                if let Some(url) = value.as_deref() {
                    validate_dev_vite(url)?;
                }
                result.dev_vite_url = value;
                index += 2;
            }
            "--expose-control" => {
                result.expose_control = true;
                index += 1;
            }
            other if other.starts_with('-') => {
                return Err(format!("unknown option: {other}"));
            }
            other => {
                result.positionals.push(other.to_string());
                index += 1;
            }
        }
    }

    // 控制 API 暴露防护:非回环地址把控制端点以明文 HTTP 暴露到 LAN,token 可被嗅探。
    if let Some(host) = &result.host {
        if !LOOPBACK_HOSTS.contains(&host.as_str()) && !result.expose_control {
            return Err(format!(
                "--host {host} exposes the control API over plain HTTP on the LAN; pass --expose-control to allow it"
            ));
        }
    }

    Ok(result)
}

/// 端口解析。Node 是 `Number(value)`,非法值会在 `listen` 时才炸;这里提前拒绝,
/// 错误文案带上开关名,用户能直接看出是哪个参数写错了。
fn parse_port(flag: &str, value: Option<&str>) -> Result<u16, String> {
    let Some(raw) = value else {
        return Err(format!("{flag} requires a port number"));
    };
    raw.trim()
        .parse::<u16>()
        .map_err(|_| format!("invalid {flag}: {raw}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn empty_argv_defaults_to_start() {
        let parsed = parse_args(&[]).unwrap();
        assert_eq!(parsed.command, Some(Command::Start));
        assert!(parsed.positionals.is_empty());
    }

    #[test]
    fn unknown_command_and_option_texts_match_node() {
        assert_eq!(
            parse_args(&argv(&["nope"])).unwrap_err(),
            "unknown command: nope"
        );
        assert_eq!(
            parse_args(&argv(&["status", "--nope"])).unwrap_err(),
            "unknown option: --nope"
        );
    }

    #[test]
    fn non_loopback_host_requires_expose_control() {
        let error = parse_args(&argv(&["start", "--host", "0.0.0.0"])).unwrap_err();
        assert_eq!(
            error,
            "--host 0.0.0.0 exposes the control API over plain HTTP on the LAN; pass --expose-control to allow it"
        );
        let parsed = parse_args(&argv(&["start", "--host", "0.0.0.0", "--expose-control"])).unwrap();
        assert_eq!(parsed.host.as_deref(), Some("0.0.0.0"));
        assert!(parsed.expose_control);
    }

    #[test]
    fn positionals_and_flags_can_interleave() {
        let parsed = parse_args(&argv(&["join", "code123", "D:/sync", "--port", "22001"])).unwrap();
        assert_eq!(parsed.positionals, vec!["code123", "D:/sync"]);
        assert_eq!(parsed.port, Some(22001));
    }

    #[test]
    fn reconnect_backoff_matches_node_sequence() {
        assert_eq!(reconnect_delay_ms(0), 0);
        assert_eq!(reconnect_delay_ms(1), 1000);
        assert_eq!(reconnect_delay_ms(2), 2000);
        assert_eq!(reconnect_delay_ms(3), 4000);
        assert_eq!(reconnect_delay_ms(10), 30_000);
        assert_eq!(offline_aware_reconnect_delay(2000, false), 300_000);
        assert_eq!(offline_aware_reconnect_delay(2000, true), 2000);
    }

    #[test]
    fn dev_vite_requires_url_shape() {
        assert!(parse_args(&argv(&["start", "--dev-vite", "127.0.0.1:5173"])).is_err());
        assert!(parse_args(&argv(&["start", "--dev-vite", "http://127.0.0.1:5173"])).is_ok());
    }
}
