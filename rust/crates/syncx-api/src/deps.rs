//! 服务端依赖注入。
//!
//! 与 Node 的 `ControlServerDeps` 一一对应,但**分成两层**:
//!
//!  * **纯数据/纯文件系统**的能力(配置读写、历史、回收站、版本、忽略规则、分享、
//!    目录内文件浏览)**不注入**,由本 crate 直接实现 —— 它们只依赖 `config.json`
//!    与磁盘布局,两边后端必须逐字节一致,注入反而给漂移留了口子。
//!  * **需要活着的会话**的能力(状态快照、重新扫描、对端 RPC、自更新、配对码、PTY)
//!    经 [`ControlOps`] 注入:这些只有 daemon/CLI 装配层知道怎么回答。
//!
//! 没有注入的能力一律按「不可用」处理,路由回 503 —— 与 Node 里 `if (!deps.x)` 的
//! 分支同款,前端据此显示对应的提示,而不是看到一个空数组以为「本来就没有」。

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use serde_json::Value;

use crate::auth::SessionAuth;
use crate::config::ConfigStore;
use crate::history::HistoryStore;
use crate::share::ShareStore;
use crate::status::TrafficStats;
use crate::ws::StatusHub;

/// 一次动作的失败原因。`Unavailable` 与 `Failed` 分开是因为路由的状态码不同
/// (503 vs 400),靠错误字符串判断太脆。
#[derive(Debug, Clone)]
pub enum OpError {
    /// 本次装配没提供这项能力。
    Unavailable,
    /// 有能力,但这次调用失败(原因原样透给前端)。
    Failed(String),
}

impl OpError {
    pub fn message(&self) -> String {
        match self {
            OpError::Unavailable => "not available".to_string(),
            OpError::Failed(message) => message.clone(),
        }
    }
}

impl From<std::io::Error> for OpError {
    fn from(error: std::io::Error) -> Self {
        OpError::Failed(error.to_string())
    }
}

impl From<String> for OpError {
    fn from(message: String) -> Self {
        OpError::Failed(message)
    }
}

/// 前端直接展示 `error.message`,所以 `Display` 与 [`Self::message`] 输出一致:
/// 两者若分叉,同一个失败会因调用点不同而给用户两套文案。
impl std::fmt::Display for OpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OpError::Unavailable => f.write_str("not available"),
            OpError::Failed(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for OpError {}

pub type OpResult<T> = Result<T, OpError>;

/// 需要活着的会话才能回答的能力。全部有默认实现(一律 `Unavailable`),
/// 装配层只覆盖它真正支持的那些 —— 未覆盖的端点自动落到 503/404 分支。
pub trait ControlOps: Send + Sync {
    // ---- 状态与生命周期 ----
    /// 本机配对信息(deviceId + 数据面端口 + 局域网地址)。
    fn paircode(&self) -> OpResult<Value> {
        Err(OpError::Unavailable)
    }
    fn rescan(&self) -> OpResult<()> {
        Err(OpError::Unavailable)
    }
    fn reconnect(&self, _device_id: &str) -> OpResult<()> {
        Err(OpError::Unavailable)
    }
    /// 优雅关闭。返回后由装配层真正退出进程。
    fn shutdown(&self) -> OpResult<()> {
        Err(OpError::Unavailable)
    }
    /// 检查更新;`Ok(None)` = 无可用更新。
    fn check_for_update(&self) -> OpResult<Option<Value>> {
        Err(OpError::Unavailable)
    }
    fn self_update_npm(&self) -> OpResult<String> {
        Err(OpError::Unavailable)
    }
    fn self_update_from_device(&self, _device_id: &str) -> OpResult<String> {
        Err(OpError::Unavailable)
    }
    /// 上传包预检:返回 `{version,name,current}`。
    fn inspect_package(&self, _tgz: &[u8]) -> OpResult<Value> {
        Err(OpError::Unavailable)
    }
    fn self_update_upload(&self, _tgz: &[u8]) -> OpResult<String> {
        Err(OpError::Unavailable)
    }

    // ---- 数据面动作 ----
    fn prioritize_transfer(&self, _folder_id: &str, _path: &str) -> OpResult<()> {
        Err(OpError::Unavailable)
    }
    fn materialize(&self, _folder_id: &str, _path: &str) -> OpResult<()> {
        Err(OpError::Unavailable)
    }
    /// 按需同步的占位文件(`path` 相对共享根)。盘上不存在,所以列举时必须由索引
    /// 补进「未下载」行;默认空表 = 没有按需同步,列举结果与盘面完全一致。
    fn list_placeholders(&self, _folder_id: &str) -> Vec<(String, u64)> {
        Vec::new()
    }

    // ---- 待确认项(配对 / 目录邀请) ----
    /// 确认一项。目录邀请要在校验通过**之后**才允许置 accepted:先置状态后建目录,
    /// 失败时卡片已消失,用户失去重试入口。
    fn accept_offer(
        &self,
        _offer_id: &str,
        _local_path: Option<&str>,
        _receive_only: bool,
    ) -> OpResult<()> {
        Err(OpError::Unavailable)
    }
    fn decline_offer(&self, _offer_id: &str) -> OpResult<()> {
        Err(OpError::Unavailable)
    }
    fn restore_offer(&self, _offer_id: &str) -> OpResult<()> {
        Err(OpError::Unavailable)
    }

    // ---- 与对端通信的只读/写入 ----
    fn diff_folder(&self, _folder_id: &str, _device_id: &str) -> OpResult<Value> {
        Err(OpError::Unavailable)
    }
    fn compare_folder(&self, _folder_id: &str, _device_id: &str) -> OpResult<Value> {
        Err(OpError::Unavailable)
    }
    fn read_file_pair(&self, _folder_id: &str, _device_id: &str, _path: &str) -> OpResult<Value> {
        Err(OpError::Unavailable)
    }
    fn apply_file_sync(
        &self,
        _folder_id: &str,
        _device_id: &str,
        _path: &str,
        _direction: &str,
        _content: Option<String>,
    ) -> OpResult<()> {
        Err(OpError::Unavailable)
    }
    fn rollback(&self, _folder_id: &str, _target_ts: i64, _dry_run: bool) -> OpResult<Value> {
        Err(OpError::Unavailable)
    }

    // ---- git ----
    fn git_changes(&self, _folder_id: &str) -> OpResult<Value> {
        Err(OpError::Unavailable)
    }
    fn git_diff(&self, _folder_id: &str, _path: &str) -> OpResult<Value> {
        Err(OpError::Unavailable)
    }
    fn git_log(&self, _folder_id: &str) -> OpResult<Value> {
        Err(OpError::Unavailable)
    }
    fn git_commit_files(&self, _folder_id: &str, _hash: &str) -> OpResult<Value> {
        Err(OpError::Unavailable)
    }
    fn git_commit_diff(
        &self,
        _folder_id: &str,
        _hash: &str,
        _path: &str,
        _orig_path: Option<&str>,
    ) -> OpResult<Value> {
        Err(OpError::Unavailable)
    }
    fn git_unpushed(&self, _folder_id: Option<&str>) -> OpResult<Value> {
        Err(OpError::Unavailable)
    }
    fn git_push(&self, _folder_id: &str) -> OpResult<Value> {
        Err(OpError::Unavailable)
    }
    /// 剔除某目录未推送提交消息里的 Co-Authored-By 行(git 历史重写)。
    ///
    /// 响应契约与 Node 同名:`{ok:true, stripped, rewritten}`。
    fn git_strip_coauthored_unpushed(&self, _folder_id: &str) -> OpResult<Value> {
        Err(OpError::Unavailable)
    }
    fn git_auto_commit_status(&self, _folder_id: &str) -> OpResult<Value> {
        Err(OpError::Unavailable)
    }
    fn git_delete_index_lock(&self, _folder_id: &str) -> OpResult<Value> {
        Err(OpError::Unavailable)
    }
    fn git_retry_auto_commit(&self, _folder_id: &str) -> OpResult<Value> {
        Err(OpError::Unavailable)
    }

    // ---- 分享 / 邀请的会话侧协同 ----
    /// 创建目录后向在线对端推送共享邀请(纯配置动作由本 crate 完成)。
    fn after_folder_change(&self, _folder_id: &str) {}

    /// 新信任一台设备之后:对端若已在线,立刻补发配对请求与既有目录邀请,
    /// 不必等它下次重连(与 Node `notifyPairingIntent` 同职责)。
    fn after_device_trusted(&self, _device_id: &str) {}
    /// 接受目录邀请后让新目录立刻挂上同步通道。
    fn reload_config(&self) {}

    fn webhook_test(&self) -> OpResult<()> {
        Err(OpError::Unavailable)
    }

    /// 开一条终端会话。`None` = 本次装配没有终端,升级请求直接拒掉。
    ///
    /// 真正的 PTY 生命周期(子进程、闲置门、绝对上限、收割)在装配层;这里只交出
    /// 一条双工通道,免得「没有收割的 PTY」被误当成可用能力。
    fn open_terminal(&self) -> Option<TerminalLink> {
        None
    }
}

/// 一条终端会话的双工通道。
///
/// 字段公开是因为 `select!` 要同时借用输出端与输入端,包一层 getter 只会逼调用方
/// 分两段拆。语义:
///  * `inbound` —— 前端键入交给 shell(原始文本帧);
///  * `output` —— shell 的输出帧(已是 JSON 文本,与 Node 的 `{t:'out',data}` 同形);
///  * `shutdown` —— 连接收尾时收割子进程。
pub struct TerminalLink {
    pub inbound: tokio::sync::mpsc::UnboundedSender<String>,
    pub output: tokio::sync::mpsc::UnboundedReceiver<String>,
    pub shutdown: Option<Box<dyn FnOnce() + Send>>,
}

/// 不做任何事的装配:`router()` 的默认值,也让测试能只测纯逻辑端点。
pub struct NullOps;

impl ControlOps for NullOps {}

/// 装配层提供的运行期信息。
#[derive(Clone)]
pub struct ControlDeps {
    /// 控制令牌原文(`~/.syncx/control.token`)。所有认证的根。
    pub token: String,
    /// `config.json` 路径。数据目录 = 它所在的目录。
    pub config_path: PathBuf,
    /// 数据目录(展示给登录页的路径提示)。缺省取 `config_path` 的父目录。
    pub config_dir: Option<String>,
    /// 账号密码落盘位置。`None` = 只保留令牌登录。
    pub auth_file: Option<PathBuf>,
    pub device_id: String,
    pub version: String,
    /// 源码 dev 运行态:所有自更新接口一律拒绝。
    pub dev_mode: bool,
    /// `--log-file`。`None` 时 `/api/logs` 回 `ok:false`。
    pub log_file: Option<PathBuf>,
    /// 进程启动时刻,`/metrics` 的 uptime 与 `/health` 用它。
    pub started_at: Instant,
    /// 状态载荷的即时计算入口(与 WS 推送同源)。
    pub status: Arc<dyn Fn() -> Value + Send + Sync>,
    /// 状态推送中枢。`None` 时 `/api/events` 握手一律拒绝。
    pub hub: Option<StatusHub>,
    /// 活会话能力。`None` 等价于全部不可用。
    pub ops: Option<Arc<dyn ControlOps>>,
    /// 进程累计流量(WS/指标用)。`None` = 不写该指标。
    pub traffic: Option<Arc<dyn Fn() -> TrafficStats + Send + Sync>>,
}

impl ControlDeps {
    pub fn new(token: impl Into<String>, config_path: impl Into<PathBuf>) -> Self {
        Self {
            token: token.into(),
            config_path: config_path.into(),
            config_dir: None,
            auth_file: None,
            device_id: String::new(),
            version: syncx_core::version_string().to_string(),
            dev_mode: false,
            log_file: None,
            started_at: Instant::now(),
            status: Arc::new(|| Value::Null),
            hub: None,
            ops: None,
            traffic: None,
        }
    }

    pub fn ops(&self) -> Option<&Arc<dyn ControlOps>> {
        self.ops.as_ref()
    }
}

/// 装配好的运行期状态:路由处理函数看到的全部东西。
pub struct AppState {
    pub deps: ControlDeps,
    pub config: ConfigStore,
    pub auth: SessionAuth,
    pub history: HistoryStore,
    pub shares: ShareStore,
    pub login: crate::routes::util::LoginLimiter,
    pub share_limit: crate::routes::util::ShareLimiter,
}

impl AppState {
    pub fn new(deps: ControlDeps) -> Self {
        let config = ConfigStore::new(deps.config_path.clone());
        let auth = SessionAuth::new(deps.token.clone(), deps.auth_file.clone());
        let max_events = config.load().history_max_events();
        let history = HistoryStore::new(deps.config_path.clone(), Some(max_events));
        let shares = ShareStore::new(config.clone(), deps.token.clone());
        Self {
            deps,
            config,
            auth,
            history,
            shares,
            login: crate::routes::util::LoginLimiter::new(),
            share_limit: crate::routes::util::ShareLimiter::new(),
        }
    }

    pub fn config_dir_display(&self) -> String {
        self.deps
            .config_dir
            .clone()
            .unwrap_or_else(|| self.config.config_dir().display().to_string())
    }

    /// 目录 id → 共享根。找不到返回 `None`,路由据此回 400(与 Node 的 catch 一致)。
    pub fn folder_root(&self, folder_id: &str) -> Option<std::path::PathBuf> {
        self.config
            .load()
            .folder(folder_id)
            .map(|folder| std::path::PathBuf::from(&folder.path))
    }
}

impl std::fmt::Debug for AppState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppState")
            .field("config", &self.config.path())
            .finish()
    }
}
