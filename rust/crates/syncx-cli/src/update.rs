//! 更新检查与自更新。
//!
//! 两条**互不相干**的通道,分别对应两种分发载体:
//!
//!  * **npm 通道**(`check` / `upgrade`):逐条对齐 `src/update-check.ts` 与
//!    `src/upgrade.ts`。由 `syncx-rs upgrade` 子命令与 `/api/self-update/check` 使用,
//!    目的是让 Rust 二进制在**以 npm 形态分发时**仍能自我更新 —— 与 Node 后端同款行为。
//!  * **GitHub Releases 通道**(`install_from_release`):ADR-0025 第 3 节定下的 Rust
//!    原生自更新。资产名 `syncx-rs-v{version}-{target-triple}.tar.gz`(Windows `.zip`),
//!    同 Release 附 `checksums.txt`,用 `self-replace` 原子换入。
//!
//! 两条都**不碰** P2P 互传安装包(`self-binary-request`):Rust 侧不声明该能力,
//! 收到请求回 `data: undefined`(ADR-0025 第 3 节)。

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use syncx_core::version_string;

/// npm 包名(与 `package.json` 一致)。对端互传安装包仍走 npm 安装那条路。
pub const PACKAGE_NAME: &str = "@wangmingfa/syncx";
/// GitHub 仓库(发布页地址由它拼)。
pub const GITHUB_REPO: &str = "wangmingfa/syncx";
/// 默认升级通道。
pub const DEFAULT_UPGRADE_TAG: &str = "latest";

/// 更新包下载超时。
const TARBALL_TIMEOUT: Duration = Duration::from_secs(60);
/// GitHub Release 查询超时。
const RELEASE_TIMEOUT: Duration = Duration::from_secs(20);

/// 一次更新检查的结论(与 Node 的 `UpdateInfo` 同形)。
#[derive(Debug, Clone, serde::Serialize)]
pub struct UpdateInfo {
    /// registry 上的最新版本。
    pub latest: String,
    /// 本机当前版本。
    pub current: String,
    /// 包下载地址。
    #[serde(rename = "tarballUrl")]
    pub tarball_url: String,
    /// 本次查询时间(毫秒)。
    #[serde(rename = "checkedAt")]
    pub checked_at: i64,
}

/// 版本比较:语义与 `src/upgrade.ts` 的 `compareVersions` 一致
/// (先比 maj.min.patch,再比预发布;预发布迭代号按数值比)。
///
/// 非法输入按 `0.0.0` 处理而不报错 —— 版本号来自网络,不能因脏数据崩掉检查流程。
pub fn compare_versions(a: &str, b: &str) -> i32 {
    let parse = |raw: &str| -> ((u64, u64, u64), Option<(String, u64)>) {
        let mut parts = raw.splitn(2, '-');
        let base = parts.next().unwrap_or("");
        let pre_raw = parts.next();
        let numbers: Vec<&str> = base.split('.').collect();
        let num = |index: usize| -> u64 {
            numbers
                .get(index)
                .filter(|text| !text.is_empty() && text.chars().all(|c| c.is_ascii_digit()))
                .and_then(|text| text.parse().ok())
                .unwrap_or(0)
        };
        let pre = pre_raw
            .filter(|text| !text.is_empty())
            .map(|text| match text.find('.') {
                Some(index) if index > 0 => {
                    let tag = text[..index].to_string();
                    let n = text[index + 1..].parse().unwrap_or(0);
                    (tag, n)
                }
                _ => (text.to_string(), 0),
            });
        ((num(0), num(1), num(2)), pre)
    };

    let (a_nums, a_pre) = parse(a);
    let (b_nums, b_pre) = parse(b);
    if a_nums != b_nums {
        return match a_nums.cmp(&b_nums) {
            std::cmp::Ordering::Greater => 1,
            std::cmp::Ordering::Less => -1,
            std::cmp::Ordering::Equal => 0,
        };
    }
    match (a_pre, b_pre) {
        (None, None) => 0,
        // 无预发布后缀的更大:1.2.3 > 1.2.3-beta.1
        (None, Some(_)) => 1,
        (Some(_), None) => -1,
        (Some((a_tag, a_n)), Some((b_tag, b_n))) => {
            if a_tag != b_tag {
                return if a_tag < b_tag { -1 } else { 1 };
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

/// 校验并规范化升级通道(dist-tag)。
pub fn normalize_upgrade_tag(input: Option<&str>) -> Result<String, String> {
    let tag = input
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_UPGRADE_TAG);
    let mut chars = tag.chars();
    let first_ok = chars
        .next()
        .map(|c| c.is_ascii_alphanumeric())
        .unwrap_or(false);
    let rest_ok = tag
        .chars()
        .skip(1)
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if !first_ok || !rest_ok {
        return Err(format!(
            "invalid dist-tag: {tag}(可用通道如 latest / beta / alpha)"
        ));
    }
    Ok(tag.to_string())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 查一次更新;成功返回本次结论(`latest` / `current` / `tarballUrl` / `checkedAt`)。
///
/// Rust 形态按 ADR-0025 第 3 节从 **GitHub Releases** 取版本,不再查 npm registry。
/// `tarballUrl` 沿用前端已有的字段名,填的是该 Release 的资产下载地址。
pub async fn check_for_update() -> Result<UpdateInfo, String> {
    let asset = fetch_release(None).await?;
    Ok(UpdateInfo {
        latest: asset.version,
        current: version_string().to_string(),
        tarball_url: asset.url,
        checked_at: now_ms(),
    })
}

/// `check_for_update` 的同步包装,供同步的 [`ControlOps`](syncx_api::deps::ControlOps) 使用。
///
/// 三条约束必须同时满足:调用方在 tokio 运行时内、可以阻塞、且不占住工作线程。
/// `block_in_place` + `Handle::block_on` 正是为此而设 —— 直接 `block_on` 会 panic
/// (`Cannot start a runtime from within a runtime`),放独立 runtime 又会多一套线程池。
pub fn check_for_update_blocking() -> Result<UpdateInfo, String> {
    bridge(async { check_for_update().await })
}

/// 在同步上下文里等一个 async future。
///
/// 不在 tokio 运行时里(例如单元测试直接调用)时退回到临时 runtime:
/// `block_in_place` 只在 multi-thread runtime 内合法,没有运行时它会 panic。
pub fn bridge<F, T>(future: F) -> Result<T, String>
where
    F: std::future::Future<Output = Result<T, String>>,
{
    match tokio::runtime::Handle::try_current() {
        Ok(handle) => Ok(tokio::task::block_in_place(|| handle.block_on(future))?),
        Err(_) => {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|error| error.to_string())?;
            runtime.block_on(future)
        }
    }
}

/// 查询某 dist-tag 当前指向的版本:`npm view <pkg>@<tag> version`。
///
/// 走 npm CLI 而不是 registry API,与 Node 侧一致 —— dist-tag 的解析规则
/// (含 `next` / 自定义通道)只有 npm 自己说了算,自己拼 URL 会漂移。
pub fn fetch_tag_version(tag: &str) -> Option<String> {
    let mut command = std::process::Command::new("npm");
    command.args(["view", &format!("{PACKAGE_NAME}@{tag}"), "version"]);
    #[cfg(windows)]
    {
        // Windows 上 npm 是 npm.cmd,必须经 cmd 解析才能找到
        command = std::process::Command::new("cmd");
        command.args([
            "/C",
            "npm",
            "view",
            &format!("{PACKAGE_NAME}@{tag}"),
            "version",
        ]);
    }
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let first = text.lines().next().unwrap_or("").trim().to_string();
    if first.is_empty() {
        None
    } else {
        Some(first)
    }
}

/// 本机是否有 daemon 在跑(pid 文件存在且记录的进程存活)。
pub fn is_daemon_running(pid_file: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(pid_file) else {
        return false;
    };
    let Ok(record) = serde_json::from_str::<serde_json::Value>(&text) else {
        return false;
    };
    match record.get("pid").and_then(|value| value.as_u64()) {
        Some(pid) => crate::daemon::is_process_alive(pid as u32),
        None => false,
    }
}

/// `upgrade` 子命令的输出回调。CLI 直接打 stdout/stderr,测试可注入。
pub struct UpgradeIo<'a> {
    pub log: &'a dyn Fn(&str),
    pub error: &'a dyn Fn(&str),
}

/// 执行升级:查通道版本 → 比较 → 从 GitHub Releases 下载、校验、换入。
///
/// `restart` 语义见 [`install_from_release`]:daemon 触发的升级传原 argv
/// (换入后看门狗拉起新进程并等健康标记),CLI 传 `None`(只换入,不重启)。
pub fn run_upgrade(
    tag_input: Option<&str>,
    io: &UpgradeIo<'_>,
    pid_file: Option<&Path>,
    restart: Option<UpdateRestart>,
) -> Result<(), String> {
    let daemon_mode = restart.is_some();
    let tag = normalize_upgrade_tag(tag_input)?;
    let current = version_string();
    (io.log)(&format!("当前版本: {current}"));
    (io.log)(&format!("查询通道 {tag} 的最新版本..."));

    let channel = if tag == DEFAULT_UPGRADE_TAG {
        None
    } else {
        Some(tag.as_str())
    };
    let asset = bridge(fetch_release(channel)).map_err(|error| {
        // 查询失败要落 stderr:stdout 常被调用方当结果读,把网络错误混进去会污染它
        (io.error)(&format!("查询 {tag} 通道失败:{error}"));
        error
    })?;
    if current != "unknown" && compare_versions(current, &asset.version) >= 0 {
        (io.log)(&format!(
            "已是最新版本 {}({tag} 通道),无需升级",
            asset.version
        ));
        return Ok(());
    }
    (io.log)(&format!(
        "{current} → {}({tag} 通道),开始下载...",
        asset.version
    ));
    if let Some(pid_file) = pid_file {
        if is_daemon_running(pid_file) {
            (io.log)("提示: 检测到 daemon 正在运行。换入后需重启 daemon 才生效。");
        }
    }

    let version = bridge(install_from_release(channel, restart)).map_err(|error| {
        (io.error)(&format!("安装失败:{error}"));
        error
    })?;
    if daemon_mode {
        (io.log)(&format!(
            "已换入 {version},旧进程退出后自动重启并做健康校验(失败自动回滚)"
        ));
    } else {
        (io.log)(&format!(
            "升级完成: {version}。正在运行的 daemon 需重启后才生效(syncx stop && syncx start)。"
        ));
    }
    Ok(())
}

/* ------------------------------ GitHub Releases ------------------------------ */

/// 编译期目标三元组。资产名用它拼装,不做模糊匹配(ADR-0025 第 3 节)。
pub const TARGET: &str = env!("TARGET_TRIPLE");

/// 一个可下载的 Release 资产。
#[derive(Debug, Clone)]
pub struct ReleaseAsset {
    pub version: String,
    pub url: String,
    pub checksums_url: Option<String>,
}

fn asset_name(version: &str) -> String {
    let ext = if cfg!(windows) { "zip" } else { "tar.gz" };
    format!("syncx-rs-v{version}-{TARGET}.{ext}")
}

/// 从 `releases()` 列表里挑出符合通道的那一条。
///
/// `latest` 取 `GET /releases/latest`;预发布通道取 **`prerelease=true` 的最高版本**。
/// 排序用 [`compare_versions`],不用 API 返回顺序 —— 那个顺序按创建时间,重发时会乱。
fn pick_release(releases: &[serde_json::Value], tag: Option<&str>) -> Option<ReleaseAsset> {
    let mut candidates: Vec<(String, &serde_json::Value)> = Vec::new();
    for release in releases {
        let Some(tag_name) = release.get("tag_name").and_then(|v| v.as_str()) else {
            continue;
        };
        let version = tag_name.trim_start_matches('v').to_string();
        let prerelease = release
            .get("prerelease")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let draft = release
            .get("draft")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if draft {
            continue;
        }
        match tag {
            // 指定通道:按 tag 名前缀过滤(如 `beta` → `v0.6.0-beta.1`)
            Some(channel) if channel != "latest" => {
                if version.contains(&format!("-{channel}")) {
                    candidates.push((version, release));
                }
            }
            // latest 通道:只要正式版
            _ => {
                if !prerelease && !version.contains('-') {
                    candidates.push((version, release));
                }
            }
        }
    }
    candidates.sort_by(|a, b| compare_versions(&b.0, &a.0).cmp(&0));
    let (version, release) = candidates.into_iter().next()?;
    let assets = release.get("assets").and_then(|v| v.as_array())?;
    let wanted = asset_name(&version);
    let mut url = None;
    let mut checksums_url = None;
    for asset in assets {
        let Some(name) = asset.get("name").and_then(|v| v.as_str()) else {
            continue;
        };
        let download = asset
            .get("browser_download_url")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string());
        if name == wanted {
            url = download.clone();
        } else if name == "checksums.txt" {
            checksums_url = download;
        }
    }
    Some(ReleaseAsset {
        version,
        url: url?,
        checksums_url,
    })
}

/// 查 GitHub Release(ADR-0025 第 3 节的版本查询环节)。
pub async fn fetch_release(tag: Option<&str>) -> Result<ReleaseAsset, String> {
    let client = reqwest::Client::builder()
        .timeout(RELEASE_TIMEOUT)
        // GitHub API 要求 UA;缺了会被 403
        .user_agent(format!("syncx-rs/{}", version_string()))
        .build()
        .map_err(|error| error.to_string())?;
    let channel = tag.unwrap_or(DEFAULT_UPGRADE_TAG);
    let url = if channel == DEFAULT_UPGRADE_TAG {
        format!("https://api.github.com/repos/{GITHUB_REPO}/releases/latest")
    } else {
        format!("https://api.github.com/repos/{GITHUB_REPO}/releases?per_page=30")
    };
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "release 查询失败(HTTP {})",
            response.status().as_u16()
        ));
    }
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|_| "release 返回结构异常".to_string())?;
    let releases = if channel == DEFAULT_UPGRADE_TAG {
        vec![body]
    } else {
        body.as_array().cloned().unwrap_or_default()
    };
    let asset = pick_release(&releases, tag)
        .ok_or_else(|| format!("没有找到可用的 release(通道 {channel},{TARGET})"))?;
    Ok(asset)
}

/// 下载并校验、换入、重启。
///
/// 顺序不能改:**先校验再换入** —— 换入是原子的但不可逆(旧包只剩 `.old`),
/// 一个损坏的包被换进去,进程就再也起不来了。
///
/// `restart` 携带 daemon 的原始 argv / 工作目录 / 日志文件:换入成功后由看门狗
/// 拉起新 daemon 并等它的健康标记;CLI 直接调用时传 `None`,看门狗只做换入,
/// 重启交给用户(与 `run_upgrade` 的提示文案一致)。
pub async fn install_from_release(
    tag: Option<&str>,
    restart: Option<UpdateRestart>,
) -> Result<String, String> {
    if version_string() == "dev" {
        return Err("dev 运行态不支持自更新".to_string());
    }
    let asset = fetch_release(tag).await?;
    if compare_versions(version_string(), &asset.version) >= 0 {
        return Err(format!(
            "已是最新版本 {}({} 通道),无需升级",
            asset.version,
            tag.unwrap_or(DEFAULT_UPGRADE_TAG)
        ));
    }

    let client = reqwest::Client::builder()
        .timeout(TARBALL_TIMEOUT)
        .user_agent(format!("syncx-rs/{}", version_string()))
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(&asset.url)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "更新包下载失败(HTTP {})",
            response.status().as_u16()
        ));
    }
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    if bytes.is_empty() {
        return Err("更新包下载内容为空".to_string());
    }

    // 校验:同 Release 附 checksums.txt,比对 SHA-256。缺校验文件时拒绝换入 ——
    // 「没有校验就换入」等于把下载链路当成可信,而它正是本环节要防的。
    if let Some(checksums_url) = &asset.checksums_url {
        let expected = fetch_checksum(&client, checksums_url, &asset).await?;
        let actual = sha256_hex(&bytes);
        if actual != expected {
            return Err(format!(
                "更新包指纹校验失败(期望 {}…,实际 {}…),已放弃升级",
                &expected[..12.min(expected.len())],
                &actual[..12.min(actual.len())]
            ));
        }
    } else {
        return Err("该 release 未提供 checksums.txt,拒绝换入未校验的包".to_string());
    }

    let current_exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let staging = unpack_binary(&bytes, &current_exe)?;
    // 实跑校验:新二进制必须能跑出宣告的版本号。换入是不可逆的,一个起不来的
    // 二进制换进去,这台机器就再也没机会自更新了 —— 这道闸必须挡在换入之前。
    match binary_version(&staging) {
        Some(printed) if printed == asset.version => {}
        Some(printed) => {
            return Err(format!(
                "新二进制版本不符(期望 {expected},实际输出 {printed}),已放弃升级",
                expected = asset.version
            ))
        }
        None => return Err(format!("新二进制无法执行({staging:?}),已放弃升级")),
    }
    spawn_update_swap(&current_exe, staging, asset.version.clone(), restart)?;
    Ok(asset.version)
}

/* ---------------- 自换入看门狗(ADR-0025 第 3 节) ---------------- */

/// 看门狗等待旧进程退出的时限(优雅关闭通常 <1s,给足余量)。
pub const OLD_EXIT_WAIT_MS: u64 = 120_000;
/// 换入后等新进程写健康标记的时限:控制端口绑上即写,超时视为启动失败 → 换回 `.old`。
pub const HEALTH_MARKER_TIMEOUT_MS: u64 = 30_000;
/// 健康标记的环境变量名:新 daemon 在控制端口绑定成功后写它。
pub const UPDATE_MARKER_ENV: &str = "SYNCX_UPDATE_MARKER";

/// daemon 侧升级时的重启参数:原 argv + 原工作目录 + 日志文件。
#[derive(Debug, Clone)]
pub struct UpdateRestart {
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub log_file: Option<PathBuf>,
}

/// 一次自更新的全部交接信息。由旧进程写盘,看门狗(同样是旧二进制)读取执行:
/// 换入与回滚的代码永远来自**旧**版本 —— 新二进制若有启动级缺陷,它自己没有
/// 资格参与对自己的回滚判定。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateJob {
    /// 要等它退出的旧进程(发起升级的那个进程)。
    pub parent_pid: u32,
    /// 解包并校验过的新二进制(staging)。
    pub staging: PathBuf,
    /// 被替换的目标(当前可执行文件)。
    pub exe: PathBuf,
    /// 换入前的备份(`exe.old`),回滚源。
    pub old_exe: PathBuf,
    /// 新进程健康后要写的标记文件(换入前先清掉,防上一轮残留误判)。
    pub marker: PathBuf,
    /// 看门狗的结果文件(排障用,内容是 JSON)。
    pub done: PathBuf,
    /// `None` = CLI 升级:只换入不拉起,重启交给用户。
    pub restart_args: Option<Vec<String>>,
    pub restart_cwd: Option<PathBuf>,
    pub log_file: Option<PathBuf>,
    pub wait_ms: u64,
    pub verify_ms: u64,
    pub version: String,
}

/// 换入前的准备:备份当前二进制为 `.old`,写作业文件,detached 拉起看门狗。
///
/// 本进程(旧进程)只负责到这里就返回:真正的换入要等它退出 —— 正在运行的
/// 自己就是被替换对象,Unix 上换文件无碍,Windows 上必须先放掉句柄。
fn spawn_update_swap(
    exe: &Path,
    staging: PathBuf,
    version: String,
    restart: Option<UpdateRestart>,
) -> Result<(), String> {
    let old_exe = sibling_with_suffix(exe, ".old");
    // 备份旧二进制(覆盖上一轮留下的备份):这是回滚的唯一来源
    std::fs::copy(exe, &old_exe).map_err(|error| format!("备份当前二进制失败:{error}"))?;

    let work =
        std::env::temp_dir().join(format!("syncx-update-{}-{}", std::process::id(), now_ms()));
    std::fs::create_dir_all(&work).map_err(|error| error.to_string())?;
    let job = UpdateJob {
        parent_pid: std::process::id(),
        staging,
        exe: exe.to_path_buf(),
        old_exe,
        marker: work.join("healthy"),
        done: work.join("done.json"),
        restart_args: restart.as_ref().map(|r| r.args.clone()),
        restart_cwd: restart.as_ref().map(|r| r.cwd.clone()),
        log_file: restart.as_ref().and_then(|r| r.log_file.clone()),
        wait_ms: OLD_EXIT_WAIT_MS,
        verify_ms: HEALTH_MARKER_TIMEOUT_MS,
        version,
    };
    let job_path = work.join("job.json");
    std::fs::write(
        &job_path,
        serde_json::to_vec(&job).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;

    // 看门狗 = 当前(旧)二进制的一个 detached 进程;stdio 全关,它只写 done 文件
    let mut command = std::process::Command::new(exe);
    command.arg("--update-swap").arg(&job_path);
    detach(&mut command);
    command
        .spawn()
        .map_err(|error| format!("拉起换入看门狗失败:{error}"))?;
    Ok(())
}

/// 看门狗主流程:`--update-swap <job.json>` 的实现。
///
/// 等旧进程退出 → 原子换入 →(daemon 模式)拉起新进程并等健康标记 →
/// 超时未写则换回 `.old` 并拉回旧进程。任何失败都写进 done 文件后非零退出。
pub fn run_update_swap(job_path: &Path) -> i32 {
    let job: UpdateJob = match std::fs::read(job_path)
        .map_err(|error| error.to_string())
        .and_then(|bytes| serde_json::from_slice(&bytes).map_err(|error| error.to_string()))
    {
        Ok(job) => job,
        Err(error) => {
            eprintln!("update-swap: 读取作业文件失败:{error}");
            return 1;
        }
    };
    let done = |body: serde_json::Value| {
        let _ = std::fs::write(&job.done, body.to_string());
    };

    // 1) 等旧进程退出:它是被替换对象的持有者(Windows 上换不掉还开着的 exe)
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(job.wait_ms);
    while crate::daemon::is_process_alive(job.parent_pid) {
        if std::time::Instant::now() >= deadline {
            done(serde_json::json!({
                "ok": false,
                "error": "旧进程未在时限内退出,放弃换入",
            }));
            return 1;
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
    }

    // 2) 原子换入(失败保留 .old:exe 未被破坏,下次启动再试)
    if let Err(error) = self_replace::self_replace(&job.staging) {
        done(serde_json::json!({ "ok": false, "error": format!("换入失败:{error}") }));
        return 1;
    }

    // 3) CLI 模式:换入即完成(新二进制已在换入前实跑校验过),不拉起 daemon
    let Some(restart_args) = job.restart_args.clone() else {
        let _ = std::fs::remove_file(&job.old_exe);
        done(serde_json::json!({ "ok": true, "mode": "cli", "version": job.version }));
        return 0;
    };

    // 4) daemon 模式:拉起新进程,等健康标记(先清旧标记,防上一轮残留误判)
    let _ = std::fs::remove_file(&job.marker);
    let child = match spawn_restarted(&job, &restart_args) {
        Ok(child) => child,
        Err(error) => {
            // 拉不起来是「换入成功但启动失败」的形态之一:走回滚,不留孤儿 .old
            if let Err(rollback) = rollback(&job, &restart_args) {
                done(serde_json::json!({
                    "ok": false,
                    "rolledBack": true,
                    "rollbackError": rollback,
                    "error": error,
                }));
            } else {
                done(serde_json::json!({
                    "ok": false,
                    "rolledBack": true,
                    "error": error,
                }));
            }
            return 1;
        }
    };

    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(job.verify_ms);
    while !job.marker.exists() {
        if std::time::Instant::now() >= deadline {
            // 新进程没在时限内报到:它要么立即退了,要么起不来。换回旧版并拉回
            if let Err(rollback) = rollback(&job, &restart_args) {
                done(serde_json::json!({
                    "ok": false,
                    "rolledBack": true,
                    "rollbackError": rollback,
                    "error": "新进程未在时限内写健康标记",
                }));
            } else {
                done(serde_json::json!({
                    "ok": false,
                    "rolledBack": true,
                    "error": "新进程未在时限内写健康标记",
                }));
            }
            return 1;
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
    }
    // 子进程是 detached 常驻进程,不 wait —— 看门狗的职责到「标记已写」为止
    drop(child);
    let _ = std::fs::remove_file(&job.marker);
    let _ = std::fs::remove_file(&job.old_exe);
    done(serde_json::json!({ "ok": true, "mode": "daemon", "version": job.version }));
    0
}

/// 换回 `.old` 并拉回旧进程。返回回滚过程的错误(如实进 done 文件)。
fn rollback(job: &UpdateJob, restart_args: &[String]) -> Result<(), String> {
    self_replace::self_replace(&job.old_exe).map_err(|error| format!("回滚换入失败:{error}"))?;
    spawn_restarted(job, restart_args)
        .map(|_| ())
        .map_err(|error| format!("回滚后拉起旧进程失败:{error}"))
}

/// 以原 argv 与原工作目录拉起 daemon,env 里带上健康标记路径。
/// stdout/stderr 接到日志文件(启动期的 panic 不能进 /dev/null,否则排障一片黑)。
fn spawn_restarted(
    job: &UpdateJob,
    restart_args: &[String],
) -> Result<std::process::Child, String> {
    let mut command = std::process::Command::new(&job.exe);
    command
        .args(restart_args)
        .env(UPDATE_MARKER_ENV, &job.marker)
        .stdin(std::process::Stdio::null());
    if let Some(cwd) = &job.restart_cwd {
        command.current_dir(cwd);
    }
    match &job.log_file {
        Some(log_file) => {
            if let Ok(handle) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(log_file)
            {
                // 启动期的 panic / 日志必须有去处(沿用 Node updater 的教训):
                // 接到日志文件,而不是进 /dev/null
                let stdout: std::process::Stdio =
                    handle.try_clone().map_err(|e| e.to_string())?.into();
                let stderr: std::process::Stdio = handle.into();
                command.stdout(stdout);
                command.stderr(stderr);
            }
        }
        None => {
            command.stdout(std::process::Stdio::null());
            command.stderr(std::process::Stdio::null());
        }
    }
    detach(&mut command);
    command
        .spawn()
        .map_err(|error| format!("拉起新进程失败:{error}"))
}

/// detach:Unix 上自成进程组(setsid),Windows 上 DETACHED_PROCESS。
/// 不 detach 的话,CLI 一退出看门狗会被一起带走。
fn detach(command: &mut std::process::Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
}

/// 同目录下加后缀的兄弟路径:`/usr/local/bin/syncx-rs` → `/usr/local/bin/syncx-rs.old`。
fn sibling_with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    path.with_file_name(format!("{name}{suffix}"))
}

/// 实跑 `<exe> --version`,返回输出(空 = 启动失败/超时)。
fn binary_version(exe: &Path) -> Option<String> {
    std::process::Command::new(exe)
        .arg("--version")
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

async fn fetch_checksum(
    client: &reqwest::Client,
    url: &str,
    asset: &ReleaseAsset,
) -> Result<String, String> {
    let text = client
        .get(url)
        .send()
        .await
        .map_err(|error| error.to_string())?
        .text()
        .await
        .map_err(|error| error.to_string())?;
    let wanted = asset.url.rsplit('/').next().unwrap_or_default().to_string();
    for line in text.lines() {
        // 格式:`<sha256>  <文件名>`
        let mut parts = line.split_whitespace();
        let (Some(hash), Some(name)) = (parts.next(), parts.next()) else {
            continue;
        };
        if name.trim_start_matches('*') == wanted {
            return Ok(hash.to_ascii_lowercase());
        }
    }
    Err(format!("checksums.txt 里没有 {wanted} 的条目"))
}

/// 把更新包解到执行文件旁边(`self-replace` 要求同盘),返回待换入的可执行文件路径。
fn unpack_binary(bytes: &[u8], current_exe: &Path) -> Result<PathBuf, String> {
    let dir = current_exe
        .parent()
        .ok_or("找不到可执行文件所在目录")?
        .to_path_buf();
    let staging = dir.join(format!(".syncx-update-{}.bin", std::process::id()));
    let exe_name = current_exe
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "syncx-rs".to_string());

    if cfg!(windows) {
        // Windows 资产是 .zip:用 `tar`? 不行,zip 得自己解。用 flate2 + 手工 central directory
        // 代价太高,而 Windows 自带 PowerShell 的 Expand-Archive 覆盖所有支持的版本。
        let temp_dir = std::env::temp_dir().join(format!("syncx-update-{}", std::process::id()));
        std::fs::create_dir_all(&temp_dir).map_err(|error| error.to_string())?;
        let zip_path = temp_dir.join("update.zip");
        std::fs::write(&zip_path, bytes).map_err(|error| error.to_string())?;
        let status = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &format!(
                    "Expand-Archive -LiteralPath '{}' -DestinationPath '{}' -Force",
                    zip_path.display(),
                    temp_dir.display()
                ),
            ])
            .status()
            .map_err(|error| error.to_string())?;
        if !status.success() {
            return Err("解压更新包失败(PowerShell Expand-Archive)".to_string());
        }
        let found = find_file_named(&temp_dir, &exe_name)
            .or_else(|| find_file_named(&temp_dir, "syncx-rs.exe"))
            .ok_or_else(|| "更新包里找不到可执行文件".to_string())?;
        std::fs::copy(&found, &staging).map_err(|error| error.to_string())?;
    } else {
        let decoder = flate2::read::GzDecoder::new(bytes);
        let mut archive = tar::Archive::new(decoder);
        let entries = archive.entries().map_err(|error| error.to_string())?;
        let mut written = false;
        for entry in entries {
            let mut entry = entry.map_err(|error| error.to_string())?;
            let path = entry
                .path()
                .map_err(|error| error.to_string())?
                .to_path_buf();
            let name = path
                .file_name()
                .map(|value| value.to_string_lossy().to_string())
                .unwrap_or_default();
            if name != exe_name && name != "syncx-rs" {
                continue;
            }
            // 只按文件名挑:归档内路径结构由发布脚本决定,按路径挑会在改名后失效
            let mut out = std::fs::File::create(&staging).map_err(|error| error.to_string())?;
            std::io::copy(&mut entry, &mut out).map_err(|error| error.to_string())?;
            written = true;
            break;
        }
        if !written {
            return Err(format!("更新包里找不到 {exe_name}"));
        }
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&staging, std::fs::Permissions::from_mode(0o755));
    }
    Ok(staging)
}

fn find_file_named(dir: &Path, name: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.file_name().map(|value| value == name).unwrap_or(false) {
            return Some(path);
        }
        if path.is_dir() {
            if let Some(found) = find_file_named(&path, name) {
                return Some(found);
            }
        }
    }
    None
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// 打包自身可执行文件(供 `/api/self-update/upload` 之外的对端互传使用)。
///
/// Node 侧会真的打一个 tgz 出来供低版本对端拉取;Rust 侧按 ADR-0025 第 3 节
/// **不声明该能力**,因此这里返回 `None`,对端收到 `data: undefined` 照常走 GitHub。
pub fn pack_self() -> Option<Vec<u8>> {
    None
}

/// 上传包预检:读出 `package/package.json` 的 `name` / `version`,与当前版本比对。
pub fn inspect_package(tgz: &[u8]) -> Result<serde_json::Value, String> {
    let decoder = flate2::read::GzDecoder::new(tgz);
    let mut archive = tar::Archive::new(decoder);
    let entries = archive.entries().map_err(|error| error.to_string())?;
    for entry in entries {
        let mut entry = entry.map_err(|error| error.to_string())?;
        let path = entry
            .path()
            .map_err(|error| error.to_string())?
            .to_path_buf();
        if !path.ends_with("package.json") {
            continue;
        }
        let mut text = String::new();
        entry
            .read_to_string(&mut text)
            .map_err(|error| error.to_string())?;
        let parsed: serde_json::Value = serde_json::from_str(&text)
            .map_err(|_| "安装包里的 package.json 无法解析".to_string())?;
        let name = parsed.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let version = parsed.get("version").and_then(|v| v.as_str()).unwrap_or("");
        if name != PACKAGE_NAME {
            return Err(format!("不是 {PACKAGE_NAME} 的安装包(实际为 {name})"));
        }
        if version.is_empty() {
            return Err("安装包缺少 version 字段".to_string());
        }
        return Ok(serde_json::json!({
            "version": version,
            "name": name,
            "current": version_string(),
        }));
    }
    Err("安装包里找不到 package.json".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compare_versions_matches_node_rules() {
        assert_eq!(compare_versions("1.2.3", "1.2.3"), 0);
        assert_eq!(compare_versions("1.2.4", "1.2.3"), 1);
        assert_eq!(compare_versions("1.3.0", "1.2.9"), 1);
        // 正式版大于同号预发布
        assert_eq!(compare_versions("1.2.3", "1.2.3-beta.1"), 1);
        assert_eq!(compare_versions("1.2.3-beta.1", "1.2.3"), -1);
        // 预发布迭代号按数值比
        assert_eq!(compare_versions("1.2.3-beta.10", "1.2.3-beta.9"), 1);
        assert_eq!(compare_versions("1.2.3-alpha", "1.2.3-beta"), -1);
        // 脏数据不 panic
        assert_eq!(compare_versions("", ""), 0);
        assert_eq!(compare_versions("x.y.z", "1.0.0"), -1);
    }

    #[test]
    fn upgrade_tag_validation_matches_node() {
        assert_eq!(normalize_upgrade_tag(None).unwrap(), "latest");
        assert_eq!(normalize_upgrade_tag(Some("  ")).unwrap(), "latest");
        assert_eq!(normalize_upgrade_tag(Some("beta")).unwrap(), "beta");
        assert_eq!(
            normalize_upgrade_tag(Some("bad tag")).unwrap_err(),
            "invalid dist-tag: bad tag(可用通道如 latest / beta / alpha)"
        );
        assert!(normalize_upgrade_tag(Some("-leading")).is_err());
    }

    #[test]
    fn asset_name_uses_target_triple() {
        let name = asset_name("0.6.1");
        assert!(name.starts_with("syncx-rs-v0.6.1-"));
        assert!(name.ends_with(if cfg!(windows) { ".zip" } else { ".tar.gz" }));
        assert!(name.contains(TARGET));
    }

    #[test]
    fn pick_release_ignores_drafts_and_prereleases_on_latest() {
        let releases = vec![
            serde_json::json!({
                "tag_name": "v0.7.0-beta.1",
                "prerelease": true,
                "draft": false,
                "assets": [{ "name": asset_name("0.7.0-beta.1"), "browser_download_url": "https://x/beta" },
                           { "name": "checksums.txt", "browser_download_url": "https://x/sums" }],
                "html_url": "https://gh/beta"
            }),
            serde_json::json!({
                "tag_name": "v0.6.2",
                "prerelease": false,
                "draft": false,
                "assets": [{ "name": asset_name("0.6.2"), "browser_download_url": "https://x/stable" },
                           { "name": "checksums.txt", "browser_download_url": "https://x/sums" }],
                "html_url": "https://gh/stable"
            }),
            serde_json::json!({
                "tag_name": "v0.9.0",
                "prerelease": false,
                "draft": true,
                "assets": [],
                "html_url": "https://gh/draft"
            }),
        ];
        let latest = pick_release(&releases, None).unwrap();
        assert_eq!(latest.version, "0.6.2");
        assert_eq!(latest.url, "https://x/stable");
        assert_eq!(latest.checksums_url.as_deref(), Some("https://x/sums"));

        let beta = pick_release(&releases, Some("beta")).unwrap();
        assert_eq!(beta.version, "0.7.0-beta.1");
    }

    #[test]
    fn pick_release_prefers_highest_prerelease_not_list_order() {
        let releases = vec![
            serde_json::json!({
                "tag_name": "v0.7.0-beta.2",
                "prerelease": true,
                "assets": [{ "name": asset_name("0.7.0-beta.2"), "browser_download_url": "https://x/2" }],
            }),
            serde_json::json!({
                "tag_name": "v0.7.0-beta.10",
                "prerelease": true,
                "assets": [{ "name": asset_name("0.7.0-beta.10"), "browser_download_url": "https://x/10" }],
            }),
        ];
        // 字典序会把 beta.2 排在 beta.10 之前;必须按数值取 10
        assert_eq!(
            pick_release(&releases, Some("beta")).unwrap().url,
            "https://x/10"
        );
    }

    #[test]
    fn pack_self_is_absent_by_design() {
        // ADR-0025 第 3 节:Rust 不声明 self-binary 能力
        assert!(pack_self().is_none());
    }
}

#[cfg(test)]
mod update_swap_tests {
    use super::*;

    #[test]
    fn update_job_round_trips_through_json() {
        let job = UpdateJob {
            parent_pid: 42,
            staging: PathBuf::from("/tmp/staging.bin"),
            exe: PathBuf::from("/usr/local/bin/syncx-rs"),
            old_exe: PathBuf::from("/usr/local/bin/syncx-rs.old"),
            marker: PathBuf::from("/tmp/marker"),
            done: PathBuf::from("/tmp/done.json"),
            restart_args: Some(vec!["start".to_string(), "--port".to_string()]),
            restart_cwd: Some(PathBuf::from("/home/user")),
            log_file: Some(PathBuf::from("/tmp/syncx.log")),
            wait_ms: 1000,
            verify_ms: 2000,
            version: "0.5.0".to_string(),
        };
        let bytes = serde_json::to_vec(&job).unwrap();
        let back: UpdateJob = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(back.parent_pid, 42);
        assert_eq!(
            back.restart_args,
            Some(vec!["start".to_string(), "--port".to_string()])
        );
        assert_eq!(back.version, "0.5.0");
    }

    #[test]
    fn old_backup_path_is_sibling_with_suffix() {
        assert_eq!(
            sibling_with_suffix(Path::new("/usr/local/bin/syncx-rs"), ".old"),
            PathBuf::from("/usr/local/bin/syncx-rs.old")
        );
        assert_eq!(
            sibling_with_suffix(Path::new("C:\\bin\\syncx-rs.exe"), ".old"),
            PathBuf::from("C:\\bin\\syncx-rs.exe.old")
        );
    }

    #[test]
    fn binary_version_rejects_unexecutable() {
        // 不可执行的文件 → None(换入前的实跑校验就靠它拒掉坏包)
        let dir = std::env::temp_dir().join(format!("syncx-update-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let fake = dir.join("not-a-binary");
        std::fs::write(&fake, b"junk").unwrap();
        assert_eq!(binary_version(&fake), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
