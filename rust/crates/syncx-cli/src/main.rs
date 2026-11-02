//! syncx Rust 后端的命令行入口。
//!
//! 子命令的分发顺序与 Node 侧 `src/cli.ts` 的 `run()` **逐条对齐**,顺序本身有语义:
//!
//!  1. `stop` / `pause` / `resume` / `upgrade` 在身份与配置之前处理 —— 对一台从没
//!     跑过 syncx 的机器执行 `stop`,不该凭空创建 `device.key`、`config.json` 之类文件;
//!  2. 之后的命令才读/建身份与配置,并先过落盘格式闸门(`assertFormatVersion`);
//!  3. `status` / `diff` / `install` / `invite` / `join` / `revoke` 都是一次性命令,直接打
//!     印结果后返回;
//!  4. 其余(含省略子命令)进入 daemon 装配层 [`control::assembly::run`]。

mod args;
mod control;
mod daemon;
mod diff;
mod git;
mod install;
mod invite;
mod terminal;
mod update;
mod usage;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use args::Command;
use syncx_api::config::{assert_format_version, folder_index_path, ConfigStore};
use syncx_api::mutate;
use syncx_daemon::IndexStore;

use control::assembly::{self, RunOptions};

/// 版本号来自仓库根 `package.json`(由 `build.rs` 注入)。
/// 这是 ADR-0025 第 3 节的「单一来源」:npm 与 GitHub Release 永远同号。
const VERSION: &str = env!("SYNCX_VERSION");
/// 帮助文本里的程序名。选项与说明与 `syncx` 一致,只有程序名不同。
const PROGRAM: &str = "syncx-rs";

#[tokio::main]
async fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();

    // 看门狗模式(ADR-0025 第 3 节):不出现在帮助文本里,只在自更新时由旧二进制
    // 拉起。它必须先于一切初始化 —— 日志/配置/身份都和它无关,跑完即退。
    if argv.first().map(String::as_str) == Some("--update-swap") {
        let job_path = argv.get(1).cloned().unwrap_or_default();
        std::process::exit(update::run_update_swap(std::path::Path::new(&job_path)));
    }

    // `--help` / `--version` 必须在参数解析之前拦截:它们不是合法子命令,
    // 交给解析器只会落到 `unknown command` 且退出码变成非 0。
    if usage::wants_help(&argv) {
        println!("{}", usage::help_text(PROGRAM, VERSION));
        return;
    }
    let borrowed: Vec<&String> = argv.iter().collect();
    if usage::wants_version(&borrowed) {
        println!("{VERSION}");
        return;
    }

    let parsed = match args::parse_args(&argv) {
        Ok(parsed) => parsed,
        Err(error) => {
            // 参数错误必须非零退出,否则 `syncx status --bogus || exit 1` 这类脚本判断全部失灵
            eprintln!("{error}");
            eprintln!();
            eprintln!("用 `{PROGRAM} --help` 查看用法。");
            std::process::exit(1);
        }
    };

    init_tracing(parsed.log_file.as_deref());
    if let Err(error) = run(parsed).await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

/// 日志:默认 stdout,`--log-file` 时**同时**写文件(与 Node 的 logger 同形)。
///
/// 级别先看 `LOG_LEVEL`(Node 用的就是这个变量),再退回 `RUST_LOG`,最后 `info` ——
/// 两个后端共用同一份运维脚本时不必记两套变量名。
fn init_tracing(log_file: Option<&str>) {
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;

    let filter = tracing_subscriber::EnvFilter::try_from_env("LOG_LEVEL")
        .or_else(|_| tracing_subscriber::EnvFilter::try_from_default_env())
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));

    let registry = tracing_subscriber::registry()
        .with(filter)
        .with(tracing_subscriber::fmt::layer());

    let Some(path) = log_file else {
        registry.init();
        return;
    };
    if let Some(parent) = Path::new(path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        Ok(file) => registry
            .with(
                tracing_subscriber::fmt::layer()
                    .with_ansi(false)
                    .with_writer(std::sync::Mutex::new(file)),
            )
            .init(),
        Err(error) => {
            registry.init();
            tracing::warn!("日志文件 {path} 打开失败({error}),仅输出到标准输出");
        }
    }
}

async fn run(parsed: args::ParsedArgs) -> Result<(), String> {
    let config_path = config_path_of(&parsed);
    let config_dir = config_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    std::fs::create_dir_all(&config_dir)
        .map_err(|error| format!("数据目录 {} 创建失败:{error}", config_dir.display()))?;

    let command = parsed.command.unwrap_or(Command::Start);

    // —— 运行期操作:只读 pid / 令牌,不在没跑过的机器上留下任何文件 ——
    match command {
        Command::Stop => {
            for line in daemon::stop_daemon(&config_dir, parsed.control_port).await {
                println!("{line}");
            }
            return Ok(());
        }
        Command::Pause | Command::Resume => {
            let line =
                daemon::pause_daemon(&config_dir, parsed.control_port, command == Command::Pause)
                    .await?;
            println!("{line}");
            return Ok(());
        }
        Command::Upgrade => {
            // 探测「daemon 是否在跑」要看 pid 文件,路径必须跟着 --config/--config-dir 走
            let pid_file = daemon::pid_file_path(&config_dir);
            update::run_upgrade(
                parsed.positionals.first().map(String::as_str),
                &update::UpgradeIo {
                    log: &|line: &str| println!("{line}"),
                    error: &|line: &str| eprintln!("{line}"),
                },
                Some(&pid_file),
                // CLI 只换入不重启:重启涉及端口交接与健康观察,由用户自行决定
                None,
            )?;
            return Ok(());
        }
        _ => {}
    }

    let identity =
        Arc::new(load_or_create_identity(&config_dir).map_err(|error| error.to_string())?);
    let store = ConfigStore::new(&config_path);
    let config = store.load();

    // 落盘格式闸门:必须在打开任何 index-*.db、写任何数据文件**之前**。
    if let Err(error) = assert_format_version(&config) {
        eprintln!("[fatal] {error}");
        std::process::exit(1);
    }
    // 首次运行先写出默认配置:热重载依赖这个文件存在(Windows 上对不存在的路径
    // 开始监听会同步抛 ENOENT)。
    if !config_path.exists() {
        store
            .save(&config)
            .map_err(|error| format!("配置文件 {} 写入失败:{error}", config_path.display()))?;
    }

    match command {
        Command::Status => {
            print_status(
                &config_dir,
                parsed.control_port,
                &identity.device_id,
                &store,
            )
            .await;
            return Ok(());
        }
        Command::Diff => {
            run_diff_command(&parsed, &config_dir, &store, &identity.device_id).await?;
            return Ok(());
        }
        Command::Install => {
            let executable = std::env::current_exe()
                .map(|path| path.display().to_string())
                .map_err(|error| format!("拿不到当前可执行文件路径:{error}"))?;
            println!(
                "{}",
                install::render_for_platform(&install::InstallTarget {
                    executable,
                    config_path: config_path.display().to_string(),
                })
            );
            return Ok(());
        }
        Command::Invite => {
            let Some(folder_path) = parsed.positionals.first() else {
                return Err("usage: syncx invite <folder-path>".to_string());
            };
            if !config
                .shared_folders
                .iter()
                .any(|folder| same_path(&folder.path, folder_path))
            {
                return Err(format!("该目录尚未配置为共享目录:「{folder_path}」"));
            }
            let code = invite::create_invite_code(&identity, folder_path, invite::now_ms())
                .map_err(|error| error.to_string())?;
            println!("{code}");
            return Ok(());
        }
        Command::Join => {
            let (Some(code), Some(local_path)) =
                (parsed.positionals.first(), parsed.positionals.get(1))
            else {
                return Err("usage: syncx join <invite-code> <local-path>".to_string());
            };
            let payload = invite::parse_invite_code(code, Some(&config_dir), invite::now_ms())
                .map_err(|error| error.to_string())?;
            // 接收映射:remote=true,启用「接收映射之间不能嵌套」的约束
            mutate::add_folder(
                &store,
                local_path,
                std::slice::from_ref(&payload.device_id),
                None,
                true,
            )
            .map_err(|error| error.to_string())?;
            println!(
                "paired with device {} (invited folder {})",
                payload.device_id, payload.folder
            );
            println!("shared folder added: {local_path}");
            // 关系是双向的:本机已信任对方,但对方还没把本机加进白名单
            let reciprocal = invite::create_invite_code(&identity, local_path, invite::now_ms())
                .map_err(|error| error.to_string())?;
            println!();
            println!(
                "share this code with {} so they can whitelist you:",
                payload.device_id
            );
            println!("{reciprocal}");
            return Ok(());
        }
        Command::Revoke => {
            let Some(code) = parsed.positionals.first() else {
                return Err("usage: syncx revoke <invite-code>".to_string());
            };
            invite::revoke_invite_code(&config_dir, code)
                .map_err(|error| format!("吊销失败:{error}"))?;
            println!("invitation code revoked: {code}");
            return Ok(());
        }
        _ => {}
    }

    // —— 启动 daemon ——
    let token = daemon::load_or_create_token(&config_dir)?;
    let mut options = RunOptions::new(
        &config_path,
        Arc::clone(&identity),
        token,
        VERSION,
        // dev 构建(debug)没有可替换的发布产物,自更新一律拒绝;release 才允许
        cfg!(debug_assertions),
    );
    options.control_host = parsed
        .host
        .clone()
        .unwrap_or_else(|| "127.0.0.1".to_string());
    options.control_port = parsed.control_port.unwrap_or(daemon::DEFAULT_CONTROL_PORT);
    options.peer_port = parsed.port;
    options.log_file = parsed.log_file.as_ref().map(PathBuf::from);
    assembly::run(options).await
}

/// 配置文件路径。`--config` 优先于 `--config-dir`,都没有则 `~/.syncx/config.json`。
fn config_path_of(parsed: &args::ParsedArgs) -> PathBuf {
    if let Some(path) = &parsed.config_path {
        return PathBuf::from(path);
    }
    if let Some(dir) = &parsed.config_dir {
        return PathBuf::from(dir).join("config.json");
    }
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_default();
    home.join(".syncx").join("config.json")
}

/// 路径是否指向同一处。与 Node 的 `resolve(a) === resolve(b)` 同为词法归一。
fn same_path(left: &str, right: &str) -> bool {
    mutate::resolve_path(left) == mutate::resolve_path(right)
}

/// `status`:daemon 概况 + 设备 id + 每个目录的文件数与墓碑数。
async fn print_status(
    config_dir: &Path,
    control_port: Option<u16>,
    device_id: &str,
    store: &ConfigStore,
) {
    for line in daemon::daemon_status_lines(config_dir, control_port).await {
        println!("{line}");
    }
    let config = store.load();
    println!("device: {device_id}");
    println!("shared folders: {}", config.shared_folders.len());
    for folder in &config.shared_folders {
        let index_path = folder_index_path(config_dir, folder);
        // 读不出来就报 0:status 是诊断命令,不该因为一个坏库整条命令失败
        let (files, tombstones) = match IndexStore::open(&index_path) {
            Ok(index) => match index.list_entries() {
                Ok(entries) => {
                    let tombstones = entries.iter().filter(|entry| entry.deleted).count();
                    (entries.len() - tombstones, tombstones)
                }
                Err(_) => (0, 0),
            },
            Err(_) => (0, 0),
        };
        println!("  {}: {files} files, {tombstones} tombstones", folder.path);
    }
}

/// `diff <folder-path> [--device <id>]`:经本机 daemon 的控制 API 取对比结果。
///
/// 令牌**只读不建**:诊断命令不该在没启动过的机器上凭空创建文件。
/// 对比必须由 daemon 做 —— 对端索引要经活会话索取,CLI 进程自己没有连接。
async fn run_diff_command(
    parsed: &args::ParsedArgs,
    config_dir: &Path,
    store: &ConfigStore,
    self_device_id: &str,
) -> Result<(), String> {
    let target = parsed
        .positionals
        .first()
        .ok_or_else(|| "usage: syncx diff <folder-path> [--device <id>]".to_string())?;
    let config = store.load();
    let folder = config
        .shared_folders
        .iter()
        .find(|folder| same_path(&folder.path, target))
        .ok_or_else(|| format!("不是已配置的共享目录: {target}"))?;
    let devices: Vec<String> = match &parsed.device {
        Some(device) => vec![device.clone()],
        None => folder.devices.clone(),
    };
    if devices.is_empty() {
        return Err("该目录还没有指派任何设备,无从对比".to_string());
    }

    let token_file = daemon::token_file_path(config_dir);
    if !token_file.exists() {
        return Err("找不到控制令牌,syncx 似乎从未在这台机器上启动过".to_string());
    }
    let token = std::fs::read_to_string(&token_file)
        .map_err(|error| format!("控制令牌读取失败:{error}"))?
        .trim()
        .to_string();
    // pid 文件缺失/损坏时仍按默认端口试一次,连不上时下面给出可操作的提示
    let record = daemon::read_pid_record(config_dir).unwrap_or_default();
    let port = daemon::resolve_control_port(parsed.control_port, &record);

    let client = reqwest::Client::builder()
        // 比 daemon 等对端快照的 20s 上限再宽一点,让 daemon 自己的超时先报出来
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|error| format!("HTTP 客户端创建失败:{error}"))?;

    for device in &devices {
        if devices.len() > 1 {
            println!("===== 对端 {device} =====");
        }
        let response = client
            .get(format!(
                "{}/api/folders/diff?folderId={}&device={}",
                daemon::control_base_url(port),
                url_encode(&folder.folder_id()),
                url_encode(device),
            ))
            .bearer_auth(&token)
            .send()
            .await
            .map_err(|_| {
                format!("连不上本机 daemon(控制端口 {port});先执行 syncx status 确认它在运行")
            })?;
        let status = response.status();
        let body: serde_json::Value = response
            .json()
            .await
            .map_err(|error| format!("daemon 响应无法解析:{error}"))?;
        if !status.is_success() {
            let message = body
                .get("error")
                .and_then(|value| value.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| format!("对比失败(HTTP {})", status.as_u16()));
            return Err(message);
        }
        let report = diff::parse_diff_response(&body)?;
        for line in report.format(self_device_id) {
            println!("{line}");
        }
    }
    Ok(())
}

/// 查询参数转义。目录 id 一般安全,但用户给的设备 id 可能带任意字符。
fn url_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// 读/建 `<configDir>/device.key`。
///
/// 文件形态与 Node 完全一致(`{deviceId, publicKey, privateKey}`,两把 PEM 键名驼峰),
/// 否则同一台机器在两个后端下会是两台不同设备 —— 不报错,只是既有配对关系全部失效。
fn load_or_create_identity(
    config_dir: &Path,
) -> Result<syncx_net::DeviceIdentity, Box<dyn std::error::Error>> {
    use std::io::Write;
    let path = config_dir.join("device.key");
    if let Ok(text) = std::fs::read_to_string(&path) {
        if let Ok(record) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(private_key) = record.get("privateKey").and_then(|value| value.as_str()) {
                return Ok(syncx_net::DeviceIdentity::from_private_key_pem(
                    private_key,
                )?);
            }
        }
        return Err(format!("device.key 已损坏:{}", path.display()).into());
    }

    let identity = syncx_net::DeviceIdentity::generate();
    let record = serde_json::json!({
        "deviceId": identity.device_id,
        "publicKey": identity.public_key_pem,
        "privateKey": identity.private_key_pem,
    });
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&path)?;
    file.write_all(serde_json::to_string_pretty(&record)?.as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    tracing::info!("设备身份已生成:{} ({})", identity.device_id, path.display());
    Ok(identity)
}
