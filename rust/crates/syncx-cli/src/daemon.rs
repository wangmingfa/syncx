//! daemon 生命周期:控制令牌、pid 文件、status/stop/pause/resume 的实现。
//!
//! 与 Node 侧 `src/daemon.ts` 一一对应,**所有中文文案逐字一致**。这不是洁癖:
//! 两个后端共用同一个数据目录与同一份 pid 文件(见 ADR-0025 第 2 节),用户在
//! 两端之间切换时看到的必须是同一句话,否则「到底停的是哪个进程」永远说不清。
//!
//! 关键约定:
//!  * pid 记录 `{pid, controlPort, backend, version}`,0600,优雅退出时删除;
//!  * `backend` 缺省按 `node` 处理 —— 那是本字段引入前的唯一实现,判成 node 是对的;
//!  * 报错要能指出**对方是谁**,用户才知道该敲 `syncx stop` 还是 `syncx-rs stop`。

use std::io::Write;
use std::path::{Path, PathBuf};

/// pid 文件名。
pub const PID_FILE: &str = "syncx.pid";
/// 默认控制端口。
pub const DEFAULT_CONTROL_PORT: u16 = 8384;
/// 本后端的标识。写进 pid 文件,也是「该用哪条命令停对方」的判据。
pub const BACKEND: &str = "rust";

/// 控制令牌文件名。
pub const TOKEN_FILE: &str = "control.token";

/// pid 文件内容。
#[derive(Debug, Clone, Default)]
pub struct PidRecord {
    pub pid: Option<u32>,
    pub control_port: Option<u16>,
    /// 持有该数据目录的后端实现。`None` = 本字段引入前的旧记录,按 `node` 理解。
    pub backend: Option<String>,
    pub version: Option<String>,
}

impl PidRecord {
    fn to_json(&self) -> serde_json::Value {
        let mut map = serde_json::Map::new();
        if let Some(pid) = self.pid {
            map.insert("pid".to_string(), serde_json::json!(pid));
        }
        if let Some(port) = self.control_port {
            map.insert("controlPort".to_string(), serde_json::json!(port));
        }
        if let Some(backend) = &self.backend {
            map.insert("backend".to_string(), serde_json::json!(backend));
        }
        if let Some(version) = &self.version {
            map.insert("version".to_string(), serde_json::json!(version));
        }
        serde_json::Value::Object(map)
    }

    fn from_json(value: &serde_json::Value) -> Self {
        Self {
            pid: value.get("pid").and_then(|v| v.as_u64()).map(|v| v as u32),
            control_port: value
                .get("controlPort")
                .and_then(|v| v.as_u64())
                .filter(|v| *v <= u16::MAX as u64)
                .map(|v| v as u16),
            backend: value
                .get("backend")
                .and_then(|v| v.as_str())
                .map(|v| v.to_string()),
            version: value
                .get("version")
                .and_then(|v| v.as_str())
                .map(|v| v.to_string()),
        }
    }
}

pub fn pid_file_path(config_dir: &Path) -> PathBuf {
    config_dir.join(PID_FILE)
}

pub fn token_file_path(config_dir: &Path) -> PathBuf {
    config_dir.join(TOKEN_FILE)
}

/// 进程是否存活(信号 0 = 只探测,不发送)。
///
/// Unix 用 `kill(pid, 0)`;Windows 没有等价物,用 OpenProcess 探测(见 `libc` 之外
/// 的 `windows` 分支)。两条路都只回答「这个 pid 上有没有活着的进程」。
pub fn is_process_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        // SAFETY: kill 只读内核状态,参数是普通整数;失败返回 -1 并置 errno。
        unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
    }
    #[cfg(windows)]
    {
        // 没有引入 windows-sys 依赖:cmd 里 `tasklist` 的退出码已足够,且只在
        // stop/status 这两条人工路径上跑一次。
        std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .map(|out| String::from_utf8_lossy(&out.stdout).contains(&pid.to_string()))
            .unwrap_or(false)
    }
}

/// 后端实现的命令名:报错文案据此告诉用户该用哪条命令关掉对方。
pub fn backend_stop_hint(backend: Option<&str>) -> &'static str {
    if backend == Some(BACKEND) {
        "syncx-rs stop"
    } else {
        "syncx stop"
    }
}

/// 读 pid 文件;缺失或损坏返回 `None`(调用方用 `PidRecord::default()` 兜底)。
pub fn read_pid_record(config_dir: &Path) -> Option<PidRecord> {
    let text = std::fs::read_to_string(pid_file_path(config_dir)).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    Some(PidRecord::from_json(&value))
}

/// 写 pid 记录(0600)。失败时只告警:pid 文件是给 `stop` 用的便利信息,
/// 写不进去不该拖垮启动。
pub fn write_pid_record(config_dir: &Path, record: &PidRecord) -> std::io::Result<()> {
    let path = pid_file_path(config_dir);
    let body = serde_json::to_string(&record.to_json()).unwrap_or_else(|_| "{}".to_string());
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&path)?;
    file.write_all(body.as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// 删除 pid 文件(优雅退出)。已不存在不算错。
pub fn remove_pid_file(config_dir: &Path) {
    let _ = std::fs::remove_file(pid_file_path(config_dir));
}

/// 把「这个数据目录正被谁占着」渲染成一句可执行的中文提示;没有占用者时返回 `None`。
///
/// 判定口径:pid 存在且进程存活才算占用。pid 文件缺失/损坏/进程已退都是「没人」。
pub fn describe_pid_holder(config_dir: &Path) -> Option<String> {
    let info = read_pid_record(config_dir)?;
    let pid = info.pid?;
    if !is_process_alive(pid) {
        return None;
    }
    let backend = info.backend.as_deref().unwrap_or("node");
    let version = info
        .version
        .as_ref()
        .map(|v| format!(", version={v}"))
        .unwrap_or_default();
    Some(format!(
        "backend={backend}, pid={pid}{version};请先执行 `{}` 再启动本版本",
        backend_stop_hint(info.backend.as_deref())
    ))
}

/// 把秒数格式化成人类可读的运行时长:`45s` / `12m30s` / `3h05m` / `2d04h`。
pub fn format_uptime(seconds: u64) -> String {
    let days = seconds / 86_400;
    let hours = (seconds % 86_400) / 3600;
    let minutes = (seconds % 3600) / 60;
    let secs = seconds % 60;
    if days > 0 {
        return format!("{days}d{hours:02}h");
    }
    if hours > 0 {
        return format!("{hours}h{minutes:02}m");
    }
    if minutes > 0 {
        return format!("{minutes}m{secs:02}s");
    }
    format!("{secs}s")
}

/// 创建(或读取)控制 API 访问令牌,落盘在 `{configDir}/control.token`(0600)。
///
/// 空/纯空白令牌会让「无凭据」也通过常量时间比较(空串 vs 空串恒等),等于把整个
/// 控制 API 开放出去 —— 视同「令牌缺失」重新生成。
pub fn load_or_create_token(config_dir: &Path) -> Result<String, String> {
    let file = token_file_path(config_dir);
    match std::fs::read_to_string(&file) {
        Ok(text) => {
            let token = text.trim().to_string();
            if !token.is_empty() {
                return Ok(token);
            }
            eprintln!("[warn] {} 内容为空,已重新生成令牌", file.display());
        }
        Err(error) if file.exists() => {
            return Err(format!("无法读取控制令牌:{}", error));
        }
        Err(_) => {}
    }

    // 24 字节 hex,与 Node `randomBytes(24).toString('hex')` 同长度同字符集
    let mut raw = [0u8; 24];
    {
        use rand::RngCore;
        rand::thread_rng().fill_bytes(&mut raw);
    }
    let token: String = raw.iter().map(|byte| format!("{byte:02x}")).collect();
    let mut handle = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&file)
        .map_err(|error| format!("无法写入控制令牌({}):{error}", file.display()))?;
    handle
        .write_all(format!("{token}\n").as_bytes())
        .map_err(|error| format!("无法写入控制令牌({}):{error}", file.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600));
    }
    Ok(token)
}

/// 控制 API 的基址。CLI 侧一律打本机回环 —— 与 Node 的 `http://127.0.0.1:${port}` 一致。
pub fn control_base_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// 从 pid 记录推导控制端口:`--control-port` 覆盖 > pid 记录 > 默认 8384。
pub fn resolve_control_port(override_port: Option<u16>, record: &PidRecord) -> u16 {
    override_port
        .or(record.control_port)
        .unwrap_or(DEFAULT_CONTROL_PORT)
}

/// EACCES(绑定被拒绝)的平台专属提示。返回的行之后由调用方统一追加「换端口」提示。
pub fn eaccess_hints(port: u16) -> Vec<String> {
    if cfg!(target_os = "windows") {
        return vec![
            "Windows 上这通常不是端口被占用,而是被系统保留——Hyper-V/WSL/Docker 依赖的".to_string(),
            "WinNAT 会在每次重启后动态保留一批 TCP 端口段,该端口恰好落在本次保留范围内。".to_string(),
            "  排查:netsh interface ipv4 show excludedportrange protocol=tcp".to_string(),
            "  修复(管理员,永久预占该端口):".to_string(),
            "    net stop winnat".to_string(),
            format!(
                "    netsh int ipv4 add excludedportrange protocol=tcp startport={port} numberofports=1 store=persistent"
            ),
            "    net start winnat".to_string(),
        ];
    }
    if cfg!(target_os = "linux") {
        let mut lines = Vec::new();
        if port < 1024 {
            lines.push(
                "Linux 上绑定 1024 以下特权端口需要 root——建议直接换一个 ≥1024 的端口。"
                    .to_string(),
            );
        } else {
            lines.push(
                "Linux 上绑定被拒绝通常是安全策略拦截(Fedora/RHEL 的 SELinux 常拦截非标端口):"
                    .to_string(),
            );
            lines.push(format!("  SELinux 排查:semanage port -l | grep {port}"));
            lines.push(format!(
                "  SELinux 放行(管理员):semanage port -a -t http_port_t -p tcp {port}"
            ));
        }
        return lines;
    }
    if cfg!(target_os = "macos") {
        return vec![if port < 1024 {
            "macOS 上绑定 1024 以下特权端口需要 root(sudo)——建议直接换一个 ≥1024 的端口。"
                .to_string()
        } else {
            "macOS 上该端口被系统策略拒绝,未占用的情况下可尝试关闭防火墙/安全软件后重试。"
                .to_string()
        }];
    }
    vec!["该端口被系统策略拒绝绑定。".to_string()]
}

/// 控制端口绑定失败时的完整提示(与 Node `listenControl` 的 `[fatal]` 段同形)。
///
/// `detail` 只在「既不是 EACCES 也不是 EADDRINUSE」的分支里出现,带的是操作系统
/// 自己的错误文本 —— Node 那一支同样把 `err.code` / `err.message` 拼进去。
pub fn bind_failure_lines(
    kind: BindFailure,
    host: &str,
    port: u16,
    holder: Option<&str>,
    program: &str,
    detail: &str,
) -> Vec<String> {
    let mut lines = Vec::new();
    match kind {
        BindFailure::AccessDenied => {
            lines.push(format!("[fatal] 控制端口绑定被拒绝(EACCES): {host}:{port}"));
            lines.extend(eaccess_hints(port));
            lines.push(format!("  或换端口启动:{program} start --control-port <其他端口>"));
        }
        BindFailure::AddressInUse => {
            lines.push(format!("[fatal] 控制端口已被占用(EADDRINUSE): {host}:{port}"));
            // 同一个数据目录可能被另一个后端占着:ping 文件里记着对方身份,
            // 据此给出可执行提示;读不到则退回泛指文案。
            if let Some(holder) = holder {
                lines.push(format!("另一个后端正在运行:{holder}"));
            }
            lines.push(format!(
                "可能已有 syncx daemon 在运行(先执行 {program} status / {program} stop),或其他程序占用了该端口;也可用 --control-port 换端口。"
            ));
        }
        BindFailure::Other => {
            lines.push(format!("[fatal] 控制端口绑定失败: {host}:{port} {detail}"));
        }
    }
    lines
}

/// `status` 命令的 daemon 段。纯读,不创建/不清理任何文件。
///
/// 三态:
///  * pid 文件不存在 → `daemon: not running`
///  * pid 探活失败 → `daemon: not running (stale pid file)`(清理交给 stop)
///  * 存活 → 两行,第二行给 Web UI 地址;`/health` 拿不到时长不影响「在跑」的结论
pub async fn daemon_status_lines(config_dir: &Path, control_port_override: Option<u16>) -> Vec<String> {
    let pid_file = pid_file_path(config_dir);
    if !pid_file.exists() {
        return vec!["daemon: not running".to_string()];
    }

    // pid 文件损坏:按「没有 pid」处理,与 stale 同等对待
    let info = read_pid_record(config_dir).unwrap_or_default();

    let Some(pid) = info.pid else {
        return vec!["daemon: not running (stale pid file)".to_string()];
    };
    if !is_process_alive(pid) {
        return vec!["daemon: not running (stale pid file)".to_string()];
    }

    let port = resolve_control_port(control_port_override, &info);
    let mut uptime = String::new();
    if let Ok(Some(seconds)) = health_probe(port).await {
        uptime = format!(", up {}", format_uptime(seconds));
    }

    vec![
        format!("daemon: running (pid {pid}{uptime})"),
        format!("control UI: {}", control_base_url(port)),
    ]
}

/// 打 `/health` 拿 uptime。`Ok(None)` = 通了但没给出合法 uptime;
/// `Err` = 连不上/超时(进程活着,只是拿不到时长)。
async fn health_probe(port: u16) -> Result<Option<u64>, ()> {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
    {
        Ok(client) => client,
        Err(_) => return Err(()),
    };
    let response = client
        .get(format!("{}/health", control_base_url(port)))
        .send()
        .await
        .map_err(|_| ())?;
    if !response.status().is_success() {
        // 仍要读掉响应体:Body 未消费时连接不会归还池,CLI 进程会在 run() 返回后挂住
        let _ = response.bytes().await;
        return Ok(None);
    }
    let body: serde_json::Value = match response.json().await {
        Ok(body) => body,
        Err(_) => return Ok(None),
    };
    Ok(body.get("uptime").and_then(|v| v.as_u64()))
}

/// `pause` / `resume`:带令牌打 `POST /api/pause`,令牌通过即证明目标就是本机 daemon。
///
/// 幂等 —— 重复 pause/resume 只是再设一次同样的值。只读 pid 文件与 control.token,
/// 在没跑过的机器上执行不会留下任何文件。
pub async fn pause_daemon(
    config_dir: &Path,
    control_port_override: Option<u16>,
    paused: bool,
) -> Result<String, String> {
    if !pid_file_path(config_dir).exists() {
        return Ok("syncx is not running".to_string());
    }

    // pid 文件损坏:仍按「无端口记录」处理,回退到 override/默认端口试一次
    let info = read_pid_record(config_dir).unwrap_or_default();
    let port = resolve_control_port(control_port_override, &info);

    let token_file = token_file_path(config_dir);
    if !token_file.exists() {
        return Err(format!(
            "找不到控制令牌({}),无法操作 daemon",
            token_file.display()
        ));
    }
    let token = std::fs::read_to_string(&token_file)
        .map_err(|error| format!("无法读取控制令牌:{}", error))?
        .trim()
        .to_string();

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .post(format!("{}/api/pause", control_base_url(port)))
        .bearer_auth(&token)
        .json(&serde_json::json!({ "paused": paused }))
        .send()
        .await
        .map_err(|_| format!("连不上本机 daemon(控制端口 {port});先执行 syncx status 确认它在运行"))?;

    let status = response.status();
    // 读掉响应体:keep-alive 挂着会让 CLI 进程在返回后仍不退出(与 stop 同理)
    let _ = response.bytes().await;
    if !status.is_success() {
        return Err(format!("操作失败(HTTP {})", status.as_u16()));
    }

    Ok(if paused {
        "syncx 已全局暂停:所有目录的数据面停摆,连接与配对照常(syncx resume 恢复)".to_string()
    } else {
        "syncx 已恢复同步".to_string()
    })
}

/// `stop`:优先走控制 API(带令牌),不可达时回退信号。
///
/// 优雅路径优先的原因:Windows 上对其他进程发 SIGTERM 是 TerminateProcess 硬杀,
/// 不会经过优雅退出(关 peer socket、sqlite 索引、配置 watcher)。
/// 返回的是要打印给用户的行(含 `[warn]`),不在这里直接打印,便于测试。
pub async fn stop_daemon(
    config_dir: &Path,
    control_port_override: Option<u16>,
) -> Vec<String> {
    let pid_file = pid_file_path(config_dir);
    if !pid_file.exists() {
        return vec!["syncx is not running".to_string()];
    }

    // pid 文件损坏:按未知处理,下方尽力清理
    let info = read_pid_record(config_dir).unwrap_or_default();
    let port = resolve_control_port(control_port_override, &info);
    let token_file = token_file_path(config_dir);
    let mut lines = Vec::new();

    // 1) 优雅路径:控制 API。令牌认证通过即证明目标就是本机 daemon,不会误杀无关进程
    if token_file.exists() {
        let token = std::fs::read_to_string(&token_file)
            .unwrap_or_default()
            .trim()
            .to_string();
        let graceful = async {
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(5))
                .build()
                .ok()?;
            let response = client
                .post(format!("{}/api/shutdown", control_base_url(port)))
                .bearer_auth(&token)
                .send()
                .await
                .ok()?;
            let status = response.status();
            // 读掉响应体:keep-alive 连接挂着会让 CLI 进程不退出
            let _ = response.bytes().await;
            Some(status.as_u16())
        };

        match graceful.await {
            Some(code) if (200..300).contains(&code) => {
                // daemon 优雅退出时自己删除 pid 文件
                lines.push(format!(
                    "syncx stopped (pid {})",
                    info.pid
                        .map(|pid| pid.to_string())
                        .unwrap_or_else(|| "unknown".to_string())
                ));
                return lines;
            }
            Some(code) => {
                lines.push(format!(
                    "[warn] /api/shutdown returned {code}, falling back to signal"
                ));
            }
            None => lines.push("[warn] control API unreachable, falling back to signal".to_string()),
        }
    }

    // 2) 回退:向 pid 发信号
    match info.pid {
        Some(pid) if is_process_alive(pid) => {
            let _ = terminate_process(pid);
            lines.push(format!("sent SIGTERM to syncx (pid {pid})"));
        }
        _ => lines.push("syncx is not running (stale pid file)".to_string()),
    }
    remove_pid_file(config_dir);
    lines
}

/// 发 SIGTERM。Unix 走 libc;Windows 上没有信号语义,直接 taskkill 硬杀
/// (sqlite 在崩溃安全模式下,与 Node 的注释同口径)。
fn terminate_process(pid: u32) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        // SAFETY: 参数是普通整数,失败返回 -1 并置 errno
        let code = unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
        if code == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }
    #[cfg(windows)]
    {
        std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F"])
            .output()
            .map(|_| ())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BindFailure {
    AccessDenied,
    AddressInUse,
    Other,
}

/// 把 `std::io::Error` 归到三种绑定失败之一。
pub fn classify_bind_error(error: &std::io::Error) -> BindFailure {
    match error.kind() {
        std::io::ErrorKind::PermissionDenied => BindFailure::AccessDenied,
        std::io::ErrorKind::AddrInUse => BindFailure::AddressInUse,
        _ => BindFailure::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "syncx-cli-daemon-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn uptime_matches_node_formats() {
        assert_eq!(format_uptime(45), "45s");
        assert_eq!(format_uptime(750), "12m30s");
        assert_eq!(format_uptime(11_100), "3h05m");
        assert_eq!(format_uptime(187_200), "2d04h");
    }

    #[test]
    fn backend_stop_hint_names_the_other_binary() {
        assert_eq!(backend_stop_hint(Some("rust")), "syncx-rs stop");
        assert_eq!(backend_stop_hint(Some("node")), "syncx stop");
        assert_eq!(backend_stop_hint(None), "syncx stop");
    }

    #[test]
    fn pid_record_round_trips_and_keeps_unknown_keys_out() {
        let dir = temp_dir("pid");
        let record = PidRecord {
            pid: Some(4242),
            control_port: Some(9000),
            backend: Some("rust".to_string()),
            version: Some("0.5.0".to_string()),
        };
        write_pid_record(&dir, &record).unwrap();
        let raw = std::fs::read_to_string(pid_file_path(&dir)).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed["pid"], 4242);
        assert_eq!(parsed["controlPort"], 9000);
        assert_eq!(parsed["backend"], "rust");
        assert_eq!(parsed["version"], "0.5.0");

        let read = read_pid_record(&dir).unwrap();
        assert_eq!(read.pid, Some(4242));
        assert_eq!(read.backend.as_deref(), Some("rust"));
        remove_pid_file(&dir);
        assert!(read_pid_record(&dir).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn dead_pid_is_not_a_holder() {
        let dir = temp_dir("holder");
        // pid 1 之外的超大 pid 几乎不可能存活;真活着也只影响这一条断言的可测性
        write_pid_record(
            &dir,
            &PidRecord {
                pid: Some(4_000_000_000),
                control_port: Some(8384),
                backend: Some("node".to_string()),
                version: None,
            },
        )
        .unwrap();
        assert_eq!(describe_pid_holder(&dir), None);
        // 损坏的 pid 文件同样视为「没人」
        std::fs::write(pid_file_path(&dir), "{not json").unwrap();
        assert_eq!(describe_pid_holder(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_token_file_is_regenerated_with_warning() {
        let dir = temp_dir("token");
        std::fs::write(token_file_path(&dir), "   \n").unwrap();
        let token = load_or_create_token(&dir).unwrap();
        assert_eq!(token.len(), 48, "24 字节 hex");
        assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
        // 再次读取必须稳定(不能每次都重新生成)
        assert_eq!(load_or_create_token(&dir).unwrap(), token);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn control_port_resolution_order() {
        let record = PidRecord {
            control_port: Some(9000),
            ..Default::default()
        };
        assert_eq!(resolve_control_port(Some(1234), &record), 1234);
        assert_eq!(resolve_control_port(None, &record), 9000);
        assert_eq!(
            resolve_control_port(None, &PidRecord::default()),
            DEFAULT_CONTROL_PORT
        );
    }

    #[test]
    fn addr_in_use_message_names_the_holder() {
        let lines = bind_failure_lines(
            BindFailure::AddressInUse,
            "127.0.0.1",
            8384,
            Some("backend=node, pid=42"),
            "syncx-rs",
            "",
        );
        assert_eq!(lines[0], "[fatal] 控制端口已被占用(EADDRINUSE): 127.0.0.1:8384");
        assert_eq!(lines[1], "另一个后端正在运行:backend=node, pid=42");
        assert!(lines[2].contains("syncx-rs status"));
    }
}
