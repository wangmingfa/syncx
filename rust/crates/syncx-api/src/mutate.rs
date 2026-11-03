//! 配置变更的**纯数据**实现:目录、设备、全局设置、时段与日历。
//!
//! 这一层对应 Node 侧 `src/devices.ts`。之所以实现在本 crate 而不是经 `ControlOps`
//! 注入:两个后端共用同一份 `config.json` 与同一套目录布局,这些动作必须逐字节一致。
//! 注入会给「Rust 版多写一个字段 / 少写一个默认值」留口子,而这种差异只会在切换后端
//! 之后才显形。
//!
//! 只有**会话侧**的连带动作(重建数据通道、立刻补扫、推送共享邀请)通过
//! [`crate::deps::ControlOps`] 回调 —— 那是装配层才知道怎么做的事。

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::config::{self, Config, ConfigStore, SharedFolder};

/// 一次配置变更的结果。
#[derive(Debug)]
pub enum MutateError {
    /// 请求本身不合法(400),`message` 直接展示给用户。
    Invalid(String),
    /// 配置读写失败(500)。
    Io(std::io::Error),
}

impl std::fmt::Display for MutateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MutateError::Invalid(message) => f.write_str(message),
            MutateError::Io(error) => write!(f, "{error}"),
        }
    }
}

impl From<std::io::Error> for MutateError {
    fn from(error: std::io::Error) -> Self {
        MutateError::Io(error)
    }
}

pub type MutateResult<T> = Result<T, MutateError>;

fn invalid<T>(message: impl Into<String>) -> MutateResult<T> {
    Err(MutateError::Invalid(message.into()))
}

/// 目录路径的规范形式。Node 用 `path.resolve`(消 `.`、消尾斜杠、消 `..`)。
///
/// Rust 的 `canonicalize` 会解析软链并要求路径存在 —— 与 Node 不一致,而且会改变
/// 用户填的路径本身。这里只做**词法归一**:消 `.` 与 `..`、去尾斜杠、保留前缀。
pub fn resolve_path(path: &str) -> PathBuf {
    let raw = Path::new(path);
    let mut out = PathBuf::new();
    for component in raw.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    if out.as_os_str().is_empty() {
        out.push(path);
    }
    out
}

/// 黑名单:系统目录与用户隐私目录。**必须与 Node `buildForbiddenPatterns` 同口径**,
/// 否则「在 Node 上被拦下的 .ssh 目录」在 Rust 上能被加成共享目录,直接泄露私钥。
fn is_forbidden(resolved: &str) -> bool {
    let path = resolved.replace('\\', "/");
    let lower = path.to_ascii_lowercase();

    // Unix:系统根目录
    const SYSTEM_ROOTS: [&str; 12] = [
        "/etc", "/usr", "/bin", "/sbin", "/boot", "/dev", "/proc", "/sys", "/lib", "/lib64",
        "/opt", "/root",
    ];
    for root in SYSTEM_ROOTS {
        if lower == root || lower.starts_with(&format!("{root}/")) {
            return true;
        }
    }
    // /var 整体禁止,但放行 /var/folders 与 /var/tmp(macOS 的 tmpdir 就在前者下面)
    if lower == "/var" {
        return true;
    }
    if let Some(rest) = lower.strip_prefix("/var/") {
        let first = rest.split('/').next().unwrap_or("");
        if first != "folders" && first != "tmp" {
            return true;
        }
    }
    // 用户隐私目录
    const PRIVATE: [&str; 12] = [
        ".ssh", ".ssh2", ".gnupg", ".config", ".local", ".cache", ".aws", ".kube", ".docker",
        ".docker.cfg", "appdata", "",
    ];
    if let Some(rest) = lower.strip_prefix("/home/") {
        if let Some((_, tail)) = rest.split_once('/') {
            let first = tail.split('/').next().unwrap_or("");
            if PRIVATE.contains(&first) {
                return true;
            }
        }
    }
    if lower.contains("/.ssh/") || lower.ends_with("/.ssh") {
        return true;
    }

    // Windows:盘符路径
    if lower.len() >= 3 && lower.as_bytes()[1] == b':' {
        let after_drive = &lower[2..];
        for root in ["/windows", "/programdata", "/program files", "/boot", "/recovery"] {
            if after_drive == root || after_drive.starts_with(&format!("{root}/")) {
                return true;
            }
        }
        if let Some(rest) = after_drive.strip_prefix("/users/") {
            if let Some(user_tail) = rest.split_once('/').map(|(_, tail)| tail) {
                let first = user_tail.split('/').next().unwrap_or("");
                if PRIVATE.contains(&first) {
                    return true;
                }
                // AppData\Roaming|Local|LocalLow\.ssh 等
                if first == "appdata" {
                    let mut parts = user_tail.split('/').skip(1);
                    let scope = parts.next().unwrap_or("");
                    let inner = parts.next().unwrap_or("");
                    if matches!(scope, "roaming" | "local" | "locallocal") && PRIVATE.contains(&inner)
                    {
                        return true;
                    }
                }
            }
        }
    }

    false
}

/// 采集共享根身份指纹(dev + ino)。拿不到就返回 `None` —— 运行期退化为结构守卫,
/// 而不是凭空信任一个不存在的身份。
pub fn read_folder_identity(root: &Path) -> Option<Value> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let meta = std::fs::metadata(root).ok()?;
        if !meta.is_dir() || meta.ino() == 0 {
            return None;
        }
        return Some(serde_json::json!({
            "dev": meta.dev().to_string(),
            "ino": meta.ino().to_string(),
        }));
    }
    #[allow(unreachable_code)]
    None
}

fn short_id() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 6];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

/// 添加共享目录;已存在则合并设备列表。返回是否**自动创建**了目录。
pub fn add_folder(
    store: &ConfigStore,
    path: &str,
    devices: &[String],
    id: Option<&str>,
    receive_only: bool,
) -> MutateResult<bool> {
    if path.is_empty() {
        return invalid("请填写共享目录路径");
    }
    if !Path::new(path).is_absolute() {
        return invalid(format!(
            "「{path}」不是本机绝对路径。共享目录只能填本机目录(每台设备各填各的,不填其它设备的路径)"
        ));
    }
    let resolved = resolve_path(path);
    let resolved_str = resolved.to_string_lossy().to_string();
    if is_forbidden(&resolved_str) {
        return invalid(format!(
            "该目录不允许作为共享目录(系统目录或用户隐私目录,如 .ssh):「{resolved_str}」"
        ));
    }

    let mut created = false;
    match std::fs::metadata(&resolved) {
        Ok(meta) => {
            if !meta.is_dir() {
                return invalid(format!(
                    "该路径已存在,但不是目录(无法作为共享目录):「{resolved_str}」"
                ));
            }
        }
        Err(_) => {
            std::fs::create_dir_all(&resolved)?;
            created = true;
        }
    }
    let identity = read_folder_identity(&resolved);

    store.mutate(|config| {
        add_folder_to(
            config,
            &resolved_str,
            devices,
            id,
            false,
            receive_only,
            identity.clone(),
        )
        .map_err(std::io::Error::other)
        .map(|_| true)
    })?;
    Ok(created)
}

/// 在已加载的 config 上登记一个目录(不做磁盘 IO,由调用方持有临界区)。
fn add_folder_to(
    config: &mut Config,
    resolved: &str,
    devices: &[String],
    id: Option<&str>,
    remote: bool,
    receive_only: bool,
    identity: Option<Value>,
) -> Result<bool, String> {
    // 任意两个共享目录之间都不允许物理嵌套:嵌套会让同一批文件参与两份索引与
    // 版本向量,产生 fan-in 与同步歧义。
    for folder in &config.shared_folders {
        let existing = resolve_path(&folder.path);
        let existing_str = existing.to_string_lossy().to_string();
        if existing_str == resolved {
            continue;
        }
        let nested = resolved.starts_with(&format!("{existing_str}/"))
            || existing_str.starts_with(&format!("{resolved}/"));
        if nested {
            return Err(format!(
                "共享目录之间不能互相嵌套:「{resolved}」与「{existing_str}」存在包含关系(任一方向都不允许)"
            ));
        }
    }

    if let Some(existing) = config
        .shared_folders
        .iter_mut()
        .find(|folder| resolve_path(&folder.path).to_string_lossy() == resolved)
    {
        // 同路径、不同 id 是矛盾请求:会让 wire 按 id 路由错乱,或两条同 id 目录共用索引库。
        if let Some(id) = id {
            if existing.folder_id() != id {
                return Err(format!(
                    "「{resolved}」已经是共享目录(目录 ID 为 {}),不能在同一路径上改用另一个目录 ID({id})",
                    existing.folder_id()
                ));
            }
        }
        let mut merged: Vec<String> = existing.devices.clone();
        for device in devices {
            if !merged.contains(device) {
                merged.push(device.clone());
            }
        }
        existing.devices = merged;
        return Ok(false);
    }

    let final_id = id.map(|value| value.to_string()).unwrap_or_else(short_id);
    if config
        .shared_folders
        .iter()
        .any(|folder| folder.folder_id() == final_id)
    {
        return Err(format!("目录 ID「{final_id}」已被另一个共享目录占用"));
    }
    config.shared_folders.push(SharedFolder {
        path: resolved.to_string(),
        devices: devices.to_vec(),
        id: Some(final_id),
        remote: if remote { Some(true) } else { None },
        receive_only: if receive_only { Some(true) } else { None },
        // 新条目 = 新目录实例:索引库按 instanceId 命名,于是「移除后重加」只会
        // 打开一个全新空库,结构上不可能继承上一轮的旧条目/旧墓碑(2026-09-15 事故)。
        instance_id: Some(short_id()),
        folder_identity: identity,
        ..Default::default()
    });
    Ok(true)
}

/// 按路径移除共享目录。`purge_index` 时一并删除索引库文件(含 SQLite sidecar)。
pub fn remove_folder(store: &ConfigStore, path: &str, purge_index: bool) -> MutateResult<()> {
    let resolved = resolve_path(path).to_string_lossy().to_string();
    let mut removed_key: Option<String> = None;
    store.mutate(|config| {
        if let Some(target) = config
            .shared_folders
            .iter()
            .find(|folder| resolve_path(&folder.path).to_string_lossy() == resolved)
        {
            removed_key = Some(target.index_key());
        }
        config
            .shared_folders
            .retain(|folder| resolve_path(&folder.path).to_string_lossy() != resolved);
        Ok::<_, std::io::Error>(true)
    })?;
    if purge_index {
        if let Some(key) = removed_key {
            purge_folder_index(&store.config_dir(), &key);
        }
    }
    Ok(())
}

/// 删除索引库主文件与 sidecar。失败静默:daemon 仍持有连接时(尤其 Windows)
/// 删不掉,由重载后的清理路径兜底。
fn purge_folder_index(config_dir: &Path, key: &str) {
    let db = config_dir.join(format!("index-{}.db", config::short_hash(key)));
    for suffix in ["", "-journal", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", db.display()));
    }
}

/// 按 `folderId` 定位并改一个目录。找不到返回 400(与 Node 的 throw 一致)。
fn edit_folder<F>(store: &ConfigStore, folder_id: &str, edit: F) -> MutateResult<()>
where
    F: FnOnce(&mut SharedFolder) -> Result<(), String>,
{
    let mut missing = false;
    store.mutate(|config| {
        let Some(folder) = config
            .shared_folders
            .iter_mut()
            .find(|folder| folder.folder_id() == folder_id)
        else {
            missing = true;
            return Ok::<_, std::io::Error>(false);
        };
        if let Err(message) = edit(folder) {
            return Err(std::io::Error::other(message));
        }
        Ok(true)
    })?;
    if missing {
        return invalid(format!("未找到共享目录:「{folder_id}」"));
    }
    Ok(())
}

/// 按路径定位并改一个目录(路径维度的接口:`/api/folders/devices`、`/gitignore`)。
fn edit_folder_by_path<F>(store: &ConfigStore, path: &str, edit: F) -> MutateResult<()>
where
    F: FnOnce(&mut SharedFolder) -> Result<(), String>,
{
    let resolved = resolve_path(path).to_string_lossy().to_string();
    let mut missing = false;
    store.mutate(|config| {
        let Some(folder) = config
            .shared_folders
            .iter_mut()
            .find(|folder| resolve_path(&folder.path).to_string_lossy() == resolved)
        else {
            missing = true;
            return Ok::<_, std::io::Error>(false);
        };
        if let Err(message) = edit(folder) {
            return Err(std::io::Error::other(message));
        }
        Ok(true)
    })?;
    if missing {
        return invalid(format!("该目录尚未配置为共享目录:「{path}」"));
    }
    Ok(())
}

pub fn set_folder_devices(store: &ConfigStore, path: &str, devices: &[String]) -> MutateResult<()> {
    let mut deduped: Vec<String> = Vec::new();
    for device in devices {
        if !deduped.contains(device) {
            deduped.push(device.clone());
        }
    }
    edit_folder_by_path(store, path, move |folder| {
        folder.devices = deduped;
        Ok(())
    })
}

pub fn set_folder_gitignore(store: &ConfigStore, path: &str, enabled: bool) -> MutateResult<()> {
    edit_folder_by_path(store, path, move |folder| {
        folder.use_gitignore = Some(enabled);
        Ok(())
    })
}

pub fn set_folder_paused(store: &ConfigStore, folder_id: &str, paused: bool) -> MutateResult<()> {
    edit_folder(store, folder_id, move |folder| {
        folder.paused = Some(paused);
        Ok(())
    })
}

pub fn set_global_paused(store: &ConfigStore, paused: bool) -> MutateResult<()> {
    store.mutate(|config| {
        config.paused = Some(paused);
        Ok::<_, std::io::Error>(true)
    })?;
    Ok(())
}

/// 设置某目录的同步时段。清洗在 `syncx_core::schedule`(与 Node 同一套归一规则)。
pub fn set_folder_schedule(
    store: &ConfigStore,
    folder_id: &str,
    schedule: Option<Value>,
) -> MutateResult<()> {
    let normalized = schedule.and_then(|value| syncx_core::schedule::normalize_schedule(&value));
    edit_folder(store, folder_id, move |folder| {
        folder.schedule = normalized;
        Ok(())
    })
}

/// 设置 git 提交同步模式。`off` 存成 `None` 而不是字面量 `"off"`,与「从未设置过」
/// 保持同一形态;同时清空上次 HEAD 基线与两份待投递台账,改模式一律按「重新启用」处理。
pub fn set_folder_git_sync(store: &ConfigStore, folder_id: &str, mode: &str) -> MutateResult<()> {
    if !matches!(mode, "off" | "send" | "receive" | "full") {
        return invalid(format!("git 同步模式应为 off / send / receive / full:「{mode}」"));
    }
    let stored = if mode == "off" {
        None
    } else {
        Some(mode.to_string())
    };
    edit_folder(store, folder_id, move |folder| {
        folder.git_sync = stored;
        folder.git_last_commit_hash = None;
        folder.git_relay_pending = None;
        folder.git_broadcast_pending = None;
        Ok(())
    })
}

/// 冲突策略。`keep-both` 是默认语义,存成 `None` 而非字面量。
pub fn set_folder_conflict_policy(
    store: &ConfigStore,
    folder_id: &str,
    policy: &str,
) -> MutateResult<()> {
    if !matches!(policy, "keep-both" | "newest-wins" | "local-wins") {
        return invalid(format!(
            "冲突策略应为 keep-both / newest-wins / local-wins:「{policy}」"
        ));
    }
    let stored = if policy == "keep-both" {
        None
    } else {
        Some(policy.to_string())
    };
    edit_folder(store, folder_id, move |folder| {
        folder.conflict_policy = stored;
        Ok(())
    })
}

pub fn set_folder_on_demand(store: &ConfigStore, folder_id: &str, on: bool) -> MutateResult<()> {
    edit_folder(store, folder_id, move |folder| {
        folder.on_demand = if on { Some(true) } else { None };
        Ok(())
    })
}

/// 镜像自动提交是否剔除 Co-Authored-By 尾注行。关闭存 `None` 而不是字面量
/// `false`:与 gitSync / conflictPolicy 的「关闭即未设置」同一形态,缺省行为不变。
pub fn set_folder_git_strip_co_authored(
    store: &ConfigStore,
    folder_id: &str,
    on: bool,
) -> MutateResult<()> {
    edit_folder(store, folder_id, move |folder| {
        folder.git_strip_co_authored = if on { Some(true) } else { None };
        Ok(())
    })
}

pub fn set_folder_on_demand_dir(
    store: &ConfigStore,
    folder_id: &str,
    rel_path: &str,
    on: bool,
) -> MutateResult<()> {
    let normalized = rel_path
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string();
    if normalized.is_empty() {
        return invalid("path is required");
    }
    edit_folder(store, folder_id, move |folder| {
        let mut current = folder.on_demand_dirs.clone().unwrap_or_default();
        if on {
            if !current.contains(&normalized) {
                current.push(normalized);
            }
        } else {
            current.retain(|path| path != &normalized);
        }
        folder.on_demand_dirs = if current.is_empty() { None } else { Some(current) };
        Ok(())
    })
}

pub fn set_folder_paused_file(
    store: &ConfigStore,
    folder_id: &str,
    rel_path: &str,
    paused: bool,
) -> MutateResult<()> {
    let normalized = rel_path.replace('\\', "/");
    edit_folder(store, folder_id, move |folder| {
        let mut current = folder.paused_files.clone().unwrap_or_default();
        if paused {
            if !current.contains(&normalized) {
                current.push(normalized);
            }
        } else {
            current.retain(|path| path != &normalized);
        }
        folder.paused_files = if current.is_empty() { None } else { Some(current) };
        Ok(())
    })
}

/// 端到端加密口令 / 不可信名单。键出现才改。
pub fn set_folder_e2e(
    store: &ConfigStore,
    folder_id: &str,
    passphrase: Option<Option<&str>>,
    untrusted: Option<Option<Vec<String>>>,
) -> MutateResult<()> {
    edit_folder(store, folder_id, move |folder| {
        if let Some(value) = passphrase {
            match value {
                None => {
                    // 清除密钥连带清空名单:没密钥的名单是死配置,留着只会在
                    // 下次误设口令时突然生效。
                    folder.e2e_key = None;
                    folder.e2e_untrusted = None;
                }
                Some(text) => {
                    if text.len() < 4 || text.len() > 512 {
                        return Err("端到端口令长度应为 4–512 字符".to_string());
                    }
                    folder.e2e_key = Some(derive_e2e_key(text)?);
                }
            }
        }
        if let Some(list) = untrusted {
            match list {
                None => folder.e2e_untrusted = None,
                Some(ids) => {
                    if folder.e2e_key.is_none() {
                        return Err("请先设置端到端口令,再标记不可信节点".to_string());
                    }
                    let mut clean: Vec<String> = Vec::new();
                    for id in &ids {
                        let trimmed = id.trim().to_string();
                        if !trimmed.is_empty() && !clean.contains(&trimmed) {
                            clean.push(trimmed);
                        }
                    }
                    if clean.len() > 100 {
                        return Err("不可信节点过多(上限 100)".to_string());
                    }
                    for id in &clean {
                        if !folder.devices.contains(id) {
                            return Err(format!("设备尚未共享该目录,不能标记为不可信:「{id}」"));
                        }
                    }
                    folder.e2e_untrusted = if clean.is_empty() { None } else { Some(clean) };
                }
            }
        }
        Ok(())
    })
}

/// 口令 → 落盘密钥。参数与 Node `deriveE2EKey` 一致(N=2^15, r=8, p=1, keylen=32),
/// 否则同一个口令在两端派生出的密钥不同,加密视图直接对不上。
fn derive_e2e_key(passphrase: &str) -> Result<Value, String> {
    use rand::RngCore;
    let mut salt = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut salt);
    let params = scrypt::Params::new(15, 8, 1, 32).map_err(|e| e.to_string())?;
    let mut key = [0u8; 32];
    scrypt::scrypt(passphrase.as_bytes(), &salt, &params, &mut key)
        .map_err(|e| e.to_string())?;
    use base64::Engine;
    let engine = base64::engine::general_purpose::STANDARD;
    Ok(serde_json::json!({
        "salt": engine.encode(salt),
        "key": engine.encode(key),
    }))
}

/// 添加已知设备(幂等)。`address` 非空时同时写入 `peers` 并规范化。
pub fn add_device(
    store: &ConfigStore,
    device_id: &str,
    address: Option<&str>,
) -> MutateResult<()> {
    if device_id.is_empty() {
        return invalid("请填写设备 ID");
    }
    if let Some(address) = address {
        if !address.is_empty() && !address.to_ascii_lowercase().starts_with("ws://") {
            return invalid(format!("对端地址必须以 ws:// 开头:「{address}」"));
        }
    }
    let address = address.filter(|value| !value.is_empty()).map(|value| {
        config::normalize_peer_url(value)
    });
    store.mutate(|config| {
        if !config.known_devices.iter().any(|d| d.id == device_id) {
            config.known_devices.push(crate::config::DeviceConfig {
                id: device_id.to_string(),
                ..Default::default()
            });
        }
        if let Some(address) = &address {
            if !config.peers.contains(address) {
                config.peers.push(address.clone());
            }
        }
        Ok::<_, std::io::Error>(true)
    })?;
    Ok(())
}

/// 移除已知设备,同时从各目录的设备列表里摘除。
pub fn remove_device(store: &ConfigStore, device_id: &str) -> MutateResult<()> {
    store.mutate(|config| {
        config.known_devices.retain(|device| device.id != device_id);
        for folder in &mut config.shared_folders {
            folder.devices.retain(|id| id != device_id);
        }
        Ok::<_, std::io::Error>(true)
    })?;
    Ok(())
}

/// 全局设置补丁。`Value::Null` = 清除(回默认);键不出现 = 不改。
///
/// 逐键显式处理的写法意味着**新增设置项必须在这里补一行** —— 否则请求 200 却静默无效。
pub fn set_global_settings(store: &ConfigStore, patch: &serde_json::Map<String, Value>) -> MutateResult<()> {
    let mut validation_error: Option<String> = None;
    store.mutate(|config| {
        if let Some(value) = patch.get("maxSendKbps") {
            let parsed = sanitize_number(value, 0, "发送带宽上限");
            match parsed {
                Err(message) => {
                    validation_error = Some(message);
                    return Ok(false);
                }
                Ok(v) => {
                    // 0 与 null 都归一为「不限速」,配置里不留 0 值
                    config.max_send_kbps = v.filter(|n| *n != 0);
                }
            }
        }
        if let Some(value) = patch.get("versionsPerPath") {
            match sanitize_number(value, 1, "每路径版本份数") {
                Err(message) => {
                    validation_error = Some(message);
                    return Ok(false);
                }
                Ok(v) => config.versions_per_path = v,
            }
        }
        if let Some(value) = patch.get("historyMaxEvents") {
            match sanitize_number(value, 1, "历史记录保留上限") {
                Err(message) => {
                    validation_error = Some(message);
                    return Ok(false);
                }
                Ok(v) => config.history_max_events = v,
            }
        }
        if let Some(value) = patch.get("batteryPauseThreshold") {
            match sanitize_number(value, 1, "低电量阈值") {
                Err(message) => {
                    validation_error = Some(message);
                    return Ok(false);
                }
                Ok(Some(n)) if n > 99 => {
                    validation_error = Some("低电量阈值必须为 1–99 的整数".to_string());
                    return Ok(false);
                }
                Ok(v) => config.battery_pause_threshold = v,
            }
        }
        if let Some(value) = patch.get("webhookUrl") {
            let text = value.as_str().unwrap_or("").trim().to_string();
            if !text.is_empty() && !text.to_ascii_lowercase().starts_with("http://")
                && !text.to_ascii_lowercase().starts_with("https://")
            {
                validation_error = Some(format!("Webhook 地址须以 http:// 或 https:// 开头:「{text}」"));
                return Ok(false);
            }
            if text.len() > 500 {
                validation_error = Some("Webhook 地址过长(最多 500 字符)".to_string());
                return Ok(false);
            }
            config.webhook_url = if text.is_empty() { None } else { Some(text) };
        }
        if let Some(value) = patch.get("webhookSecret") {
            let text = value.as_str().unwrap_or("").trim().to_string();
            if text.len() > 200 {
                validation_error = Some("Webhook 密钥过长(最多 200 字符)".to_string());
                return Ok(false);
            }
            config.webhook_secret = if text.is_empty() { None } else { Some(text) };
        }
        if let Some(value) = patch.get("pauseOnMeteredNetwork") {
            config.pause_on_metered_network = if value.as_bool() == Some(true) {
                Some(true)
            } else {
                None
            };
        }
        if let Some(value) = patch.get("pauseOnLowBattery") {
            config.pause_on_low_battery = if value.as_bool() == Some(true) {
                Some(true)
            } else {
                None
            };
        }
        if let Some(value) = patch.get("shareEnabled") {
            // 关闭时清掉在册记录:否则配置里残留可用令牌记录,与「关即失效」矛盾
            config.share_enabled = if value.as_bool() == Some(true) {
                Some(true)
            } else {
                None
            };
            if config.share_enabled != Some(true) {
                config.shares = None;
            }
        }
        if let Some(value) = patch.get("syncSchedule") {
            config.sync_schedule = if value.is_null() {
                None
            } else {
                syncx_core::schedule::normalize_schedule(value)
            };
        }
        if let Some(value) = patch.get("holidayAutoFetch") {
            config.holiday_auto_fetch = if value.as_bool() == Some(false) {
                Some(false)
            } else {
                None
            };
        }
        if let Some(value) = patch.get("fsWatchEnabled") {
            // 缺省开:补丁里只有显式 false 才落盘为关;true/null 都归回默认开
            config.fs_watch_enabled = if value.as_bool() == Some(false) {
                Some(false)
            } else {
                None
            };
        }
        if let Some(value) = patch.get("fsWatchFallbackScanSecs") {
            match sanitize_number(value, 10, "兜底全扫间隔(秒)") {
                Err(message) => {
                    validation_error = Some(message);
                    return Ok(false);
                }
                Ok(v) => config.fs_watch_fallback_scan_secs = v,
            }
        }
        if let Some(value) = patch.get("holidaySourceUrl") {
            let text = value.as_str().unwrap_or("").trim().to_string();
            if !text.is_empty() && !text.contains("{year}") {
                validation_error =
                    Some("节假日源地址必须含 {year} 占位(如 https://…/{year}.json)".to_string());
                return Ok(false);
            }
            if !text.is_empty() && !text.to_ascii_lowercase().starts_with("https://") {
                validation_error = Some("节假日源地址必须是 https://".to_string());
                return Ok(false);
            }
            if text.len() > 300 {
                validation_error = Some("节假日源地址过长(最多 300 字符)".to_string());
                return Ok(false);
            }
            config.holiday_source_url = if text.is_empty() { None } else { Some(text) };
        }
        Ok::<_, std::io::Error>(true)
    })?;
    if let Some(message) = validation_error {
        return invalid(message);
    }
    Ok(())
}

/// `null` → 清除;非数字或小于下限 → 拒绝。设置页的输入必须可解释,不能静默吞掉。
fn sanitize_number(value: &Value, min: u64, label: &str) -> Result<Option<u64>, String> {
    if value.is_null() {
        return Ok(None);
    }
    let number = value
        .as_f64()
        .filter(|n| n.is_finite())
        .ok_or_else(|| format!("{label}必须为不小于 {min} 的整数"))?;
    let floored = number.floor();
    if floored < min as f64 {
        return Err(format!("{label}必须为不小于 {min} 的整数"));
    }
    Ok(Some(floored as u64))
}

/// 临时放行时段约束。写入**到期时刻**而非剩余时长,重启后仍按同一时刻收住。
/// 只解时段,不解手动暂停与电源守卫。`minutes <= 0` = 取消。
pub fn set_schedule_override(store: &ConfigStore, minutes: f64) -> MutateResult<Option<i64>> {
    if !minutes.is_finite() {
        return invalid("临时放行时长必须是分钟数");
    }
    if minutes <= 0.0 {
        store.mutate(|config| {
            config.schedule_override_until = None;
            Ok::<_, std::io::Error>(true)
        })?;
        return Ok(None);
    }
    // 上限 24 小时:「临时」就是临时,长期约束请直接改全局时段
    let capped = minutes.floor().min(24.0 * 60.0) as i64;
    let until = crate::auth::now_ms() + capped * 60_000;
    store.mutate(|config| {
        config.schedule_override_until = Some(until);
        Ok::<_, std::io::Error>(true)
    })?;
    Ok(Some(until))
}

/// 手动覆盖某天的日历身份。`None` = 撤销覆盖。
pub fn set_calendar_override(
    store: &ConfigStore,
    date: &str,
    day_type: Option<&str>,
) -> MutateResult<()> {
    if !is_real_date_key(date) {
        return invalid(format!("日期格式应为真实存在的 YYYY-MM-DD:「{date}」"));
    }
    if let Some(kind) = day_type {
        if kind != "workday" && kind != "holiday" {
            return invalid(format!("日历身份只能是 workday / holiday / null:「{kind}」"));
        }
    }
    let date = date.to_string();
    let day_type = day_type.map(|value| value.to_string());
    store.mutate(|config| {
        let mut overrides = config.calendar_overrides.clone().unwrap_or_default();
        match &day_type {
            None => {
                overrides.remove(&date);
            }
            Some(kind) => {
                overrides.insert(date.clone(), kind.clone());
            }
        }
        config.calendar_overrides = if overrides.is_empty() {
            None
        } else {
            Some(overrides)
        };
        Ok::<_, std::io::Error>(true)
    })?;
    Ok(())
}

/// `YYYY-MM-DD` 且是真实存在的日期(2 月 30 日不算)。
fn is_real_date_key(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return false;
    }
    let Ok(year) = value[0..4].parse::<i32>() else {
        return false;
    };
    let Ok(month) = value[5..7].parse::<u32>() else {
        return false;
    };
    let Ok(day) = value[8..10].parse::<u32>() else {
        return false;
    };
    if !(1..=12).contains(&month) || day == 0 {
        return false;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let max_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    day <= max_day
}

/// 接受目录共享邀请:把对端的 `folderId` 落到本机某个共享目录。
pub fn accept_folder_invitation(
    store: &ConfigStore,
    folder_id: &str,
    device_id: &str,
    local_path: Option<&str>,
    receive_only: bool,
) -> MutateResult<()> {
    // 同 id 复用:直接并入设备列表,id 天然一致
    let by_id = store
        .load()
        .shared_folders
        .iter()
        .any(|folder| folder.folder_id() == folder_id);
    if by_id {
        return edit_folder(store, folder_id, |folder| {
            if !folder.devices.contains(&device_id.to_string()) {
                folder.devices.push(device_id.to_string());
            }
            if receive_only {
                folder.receive_only = Some(true);
            }
            Ok(())
        });
    }

    let Some(target) = local_path.map(str::trim).filter(|value| !value.is_empty()) else {
        return invalid("请填写本机落地目录,用于接受这个共享邀请");
    };
    if !Path::new(target).is_absolute() {
        return invalid(format!(
            "「{target}」不是本机绝对路径。共享目录只能填本机目录(每台设备各填各的,不填其它设备的路径)"
        ));
    }
    let resolved = resolve_path(target);
    let resolved_str = resolved.to_string_lossy().to_string();
    if is_forbidden(&resolved_str) {
        return invalid(format!(
            "该目录不允许作为共享目录(系统目录或用户隐私目录,如 .ssh):「{resolved_str}」"
        ));
    }

    // 同路径、不同 id → 对齐 id(否则对端按 folderId 推送会找不到本机目录,静默不同步)
    let by_path = store.load().shared_folders.iter().any(|folder| {
        resolve_path(&folder.path).to_string_lossy() == resolved_str
    });
    if by_path {
        let taken = store.load().shared_folders.iter().any(|folder| {
            folder.folder_id() == folder_id
                && resolve_path(&folder.path).to_string_lossy() != resolved_str
        });
        if taken {
            return invalid(format!("目录 ID「{folder_id}」已被另一个共享目录占用"));
        }
        let resolved_for_edit = resolved_str.clone();
        store.mutate(|config| {
            let Some(folder) = config
                .shared_folders
                .iter_mut()
                .find(|folder| resolve_path(&folder.path).to_string_lossy() == resolved_for_edit)
            else {
                return Ok::<_, std::io::Error>(false);
            };
            folder.id = Some(folder_id.to_string());
            if !folder.devices.contains(&device_id.to_string()) {
                folder.devices.push(device_id.to_string());
            }
            folder.remote = Some(true);
            if receive_only {
                folder.receive_only = Some(true);
            }
            Ok(true)
        })?;
        return Ok(());
    }

    if !resolved.exists() {
        std::fs::create_dir_all(&resolved)?;
    }
    // 只对新实例采集:新实例索引为空,采集是安全的;既有实例若处于「盘未挂载」
    // 的坏状态,贸然采集就把坏状态当成正常身份记了下来。
    let identity = read_folder_identity(&resolved);
    store.mutate(|config| {
        add_folder_to(
            config,
            &resolved_str,
            &[device_id.to_string()],
            Some(folder_id),
            true,
            receive_only,
            identity.clone(),
        )
        .map_err(std::io::Error::other)
        .map(|_| true)
    })?;
    Ok(())
}

/// 重新采集目录身份指纹(「目录不可信」时的人工确认)。
pub fn re_adopt_folder_identity(store: &ConfigStore, folder_id: &str) -> MutateResult<Value> {
    let folder = store
        .load()
        .folder(folder_id)
        .cloned()
        .ok_or_else(|| MutateError::Invalid(format!("未找到共享目录:「{folder_id}」")))?;
    let root = PathBuf::from(&folder.path);
    let Some(current) = read_folder_identity(&root) else {
        return invalid(format!("目录不可读,无法采集身份指纹:「{}」", folder.path));
    };
    // 人工确认 = 把当前 dev 记入可接受集合(A/B 分区来回跳的设备号只确认一次)
    let dev = current["dev"].as_str().unwrap_or("").to_string();
    let mut accepted: Vec<String> = folder
        .folder_identity
        .as_ref()
        .and_then(|identity| identity.get("devs"))
        .and_then(|value| value.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|value| value.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    if !dev.is_empty() {
        accepted.retain(|value| value != &dev);
        accepted.push(dev);
        if accepted.len() > 8 {
            accepted.remove(0);
        }
    }
    let record = serde_json::json!({
        "dev": current["dev"],
        "ino": current["ino"],
        "devs": accepted,
    });
    edit_folder(store, folder_id, move |folder| {
        folder.folder_identity = Some(record);
        Ok(())
    })?;
    Ok(current)
}

/// 该目录的身份校验结论:`ok` / `missing` / `changed` / `remounted` / `remounted-known` / `unknown`。
pub fn folder_identity_verdict(folder: &SharedFolder) -> &'static str {
    let Some(root) = Some(PathBuf::from(&folder.path)) else {
        return "unknown";
    };
    let Some(current) = read_folder_identity(&root) else {
        return "missing";
    };
    let Some(recorded) = folder.folder_identity.as_ref() else {
        return "unknown";
    };
    let same = |key: &str| {
        recorded.get(key).and_then(|value| value.as_str()) == current.get(key).and_then(|v| v.as_str())
    };
    if same("dev") && same("ino") {
        return "ok";
    }
    if !same("ino") {
        return "changed";
    }
    // ino 未变、dev 变:同一文件系统被重新挂载的典型指纹
    let current_dev = current["dev"].as_str().unwrap_or("");
    let accepted = recorded
        .get("devs")
        .and_then(|value| value.as_array())
        .map(|list| list.iter().any(|value| value.as_str() == Some(current_dev)))
        .unwrap_or(false);
    if accepted {
        "remounted-known"
    } else {
        "remounted"
    }
}

/// 当前配置里所有目录的路径(供 API 的「全部目录」口径)。
pub fn folder_ids(config: &Config) -> Vec<String> {
    config
        .shared_folders
        .iter()
        .map(|folder| folder.folder_id())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store(tag: &str) -> (ConfigStore, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "syncx-api-mutate-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let store = ConfigStore::new(dir.join("config.json"));
        store.save(&Config::new()).unwrap();
        (store, dir)
    }

    #[test]
    fn forbidden_paths_match_node() {
        assert!(is_forbidden("/etc"));
        assert!(is_forbidden("/etc/passwd"));
        assert!(is_forbidden("/var/lib"));
        assert!(is_forbidden("/home/me/.ssh"));
        assert!(is_forbidden("/home/me/.ssh2"));
        // 临时目录必须放行,否则 macOS 上的测试全挂
        assert!(!is_forbidden("/var/folders/xx/T"));
        assert!(!is_forbidden("/var/tmp"));
        assert!(!is_forbidden("/home/me/Documents"));
        assert!(!is_forbidden("/opt2/data"), "/opt2 不是 /opt");
        assert!(is_forbidden("/opt/data"));
    }

    #[test]
    fn add_folder_creates_and_rejects_nested() {
        let (store, dir) = temp_store("nested");
        let root = dir.join("shared");
        let created = add_folder(&store, root.to_str().unwrap(), &[], None, false).unwrap();
        assert!(created, "不存在的目录应被自动创建");

        let nested = root.join("inner");
        let error = add_folder(&store, nested.to_str().unwrap(), &[], None, false).unwrap_err();
        assert!(error.to_string().contains("不能互相嵌套"), "{error}");

        // 同路径再添加:合并,不新增条目
        let again = add_folder(&store, root.to_str().unwrap(), &["dev1".into()], None, false).unwrap();
        assert!(!again);
        let config = store.load();
        assert_eq!(config.shared_folders.len(), 1);
        assert_eq!(config.shared_folders[0].devices, vec!["dev1".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn add_folder_rejects_relative_and_files() {
        let (store, dir) = temp_store("bad");
        assert!(add_folder(&store, "relative/path", &[], None, false).is_err());
        let file = dir.join("a-file");
        std::fs::write(&file, b"x").unwrap();
        let error = add_folder(&store, file.to_str().unwrap(), &[], None, false).unwrap_err();
        assert!(error.to_string().contains("不是目录"), "{error}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn global_settings_validation() {
        let (store, dir) = temp_store("settings");
        let mut patch = serde_json::Map::new();
        patch.insert("maxSendKbps".into(), serde_json::json!(0));
        set_global_settings(&store, &patch).unwrap();
        assert_eq!(store.load().max_send_kbps, None, "0 归一为不限速");

        let mut bad = serde_json::Map::new();
        bad.insert("webhookUrl".into(), serde_json::json!("ftp://x"));
        assert!(set_global_settings(&store, &bad).is_err());

        let mut share = serde_json::Map::new();
        share.insert("shareEnabled".into(), serde_json::json!(false));
        set_global_settings(&store, &share).unwrap();
        assert_eq!(store.load().share_enabled, None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn fs_watch_settings_validation() {
        // 关闭监听:只有显式 false 落盘
        let (store, dir) = temp_store("fs-watch");
        let mut off = serde_json::Map::new();
        off.insert("fsWatchEnabled".into(), serde_json::json!(false));
        set_global_settings(&store, &off).unwrap();
        assert_eq!(store.load().fs_watch_enabled, Some(false));
        assert!(!store.load().fs_watch_enabled());

        // true / null 归回默认开(不落盘)
        let mut on = serde_json::Map::new();
        on.insert("fsWatchEnabled".into(), serde_json::json!(true));
        set_global_settings(&store, &on).unwrap();
        assert_eq!(store.load().fs_watch_enabled, None);
        assert!(store.load().fs_watch_enabled());

        // 兜底间隔:合法值落盘;低于下限拒绝;null 回默认
        let mut secs = serde_json::Map::new();
        secs.insert("fsWatchFallbackScanSecs".into(), serde_json::json!(300));
        set_global_settings(&store, &secs).unwrap();
        assert_eq!(store.load().fs_watch_fallback_scan_secs, Some(300));
        let mut tiny = serde_json::Map::new();
        tiny.insert("fsWatchFallbackScanSecs".into(), serde_json::json!(3));
        assert!(set_global_settings(&store, &tiny).is_err(), "低于下限必须报错而非静默吞掉");
        let mut clear = serde_json::Map::new();
        clear.insert("fsWatchFallbackScanSecs".into(), serde_json::json!(null));
        set_global_settings(&store, &clear).unwrap();
        assert_eq!(store.load().fs_watch_fallback_scan_secs, None);
        assert_eq!(store.load().fs_watch_fallback_scan_secs(), 600);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn date_key_validation() {
        assert!(is_real_date_key("2024-02-29"));
        assert!(!is_real_date_key("2023-02-29"));
        assert!(!is_real_date_key("2024-13-01"));
        assert!(!is_real_date_key("2024-1-01"));
    }

    #[test]
    fn resolve_normalizes_dot_segments() {
        assert_eq!(
            resolve_path("/a/b/../c/").to_string_lossy(),
            "/a/c"
        );
        assert_eq!(resolve_path("/a/./b").to_string_lossy(), "/a/b");
    }
}
