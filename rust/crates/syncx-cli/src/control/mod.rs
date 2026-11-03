//! 活会话装配层:把 `syncx-api` 注入的 [`ControlOps`] 真正实现出来。
//!
//! 本模块只放**不依赖对端连接细节**的能力(配置、生命周期、待确认项、自更新、
//! Webhook、终端)与按设备索引的会话台账;对端索引快照 / 文件读写那批需要
//! 收发控制帧的方法在 [`compare`],git 在 [`git`],进程装配在 [`assembly`]。
//!
//! 台账口径与 Node `SessionManager` 对齐:
//!
//!  * **会话按设备索引**。一台设备在一个进程里只应有一条连接(同一份 `device.key`
//!    出现两条就是配置被整目录拷贝了),所以 `sessions` 是 `deviceId → ControlLink`,
//!    后到者覆盖先到者 —— 这也让 `close` 钩子可以安全地按设备删除。
//!  * **配对的落盘与推送分两步**。先写 config,再推控制帧:反过来的话,帧发出去
//!    但落盘失败,对端就会以为已被接受,而本机重启后卡片又回来了。
//!  * **未见过的设备信息只缓存不落盘**。版本/主机名/平台是对端每次连上来现报的,
//!    缓存一份只为状态页展示,重启即失效 —— 与 Node 把 `peerInfo` 放在内存同构。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::oneshot;

use syncx_api::config::{Config, ConfigStore, PendingOffer};
use syncx_api::deps::{ControlOps, OpError, OpResult};
use syncx_api::history::HistoryStore;
use syncx_api::mutate;
use syncx_api::status::{self, TrafficStats};
use syncx_api::ws::StatusHub;
use syncx_daemon::actor::{ActorHandle, Cmd};
use syncx_daemon::StoredEntry;
use syncx_net::wire::ControlMessage;
use syncx_net::DeviceIdentity;

use crate::terminal::TerminalHub;
use crate::update;

pub mod assembly;
pub mod compare;
pub mod git;
pub mod git_sync;
pub mod offers;
pub mod selfheal;

/// 单文件内容对比的请求超时(与 Node 的 `FILE_REQUEST_TIMEOUT_MS` 同值)。
pub const FILE_REQUEST_TIMEOUT_MS: u64 = 20_000;
/// 索引快照请求超时(与 Node 的 `SNAPSHOT_TIMEOUT_MS` 同值)。
pub const SNAPSHOT_TIMEOUT_MS: u64 = 20_000;
/// 一次快照请求允许的最大分片数(N=500 × 2000 条 ≈ 100 万条目)。
pub const MAX_SNAPSHOT_CHUNKS: usize = 500;
/// 自更新安装包的默认通道。
pub const DEFAULT_TAG: &str = update::DEFAULT_UPGRADE_TAG;

/// 本后端的运行时形态(ADR-0025 第 3 节)。与 `syncx-api` 的 `/api/status`
/// 里 `runtime` 字段同源:都是「这个二进制是用哪种语言写的」这一编译期事实。
pub const RUNTIME: &str = "rust";

/// 一台对端最近一次自报的软件信息。
#[derive(Debug, Clone, Default)]
pub struct PeerInfo {
    pub version: Option<String>,
    pub hostname: Option<String>,
    pub platform: Option<String>,
    /// 对端后端形态(node/rust/moonbit);`None` = 旧版本对端未宣告。
    pub runtime: Option<String>,
}

/// 对端索引快照(经分片收齐)。
#[derive(Debug, Clone)]
pub struct PeerSnapshot {
    pub entries: Vec<crate::diff::SnapshotEntry>,
    pub ignore_lines: Option<Vec<String>>,
    pub progress: Option<Value>,
    pub at: i64,
}

/// 对端某文件的一份内容(读对比用)。
#[derive(Debug, Clone)]
pub struct PeerFile {
    pub data: Vec<u8>,
    pub size: u64,
    pub version: Option<Vec<(String, u64)>>,
}

/// 拨号请求。`reconnect` 与 mDNS 发现共用一条队列,避免各自维护重连状态。
#[derive(Debug, Clone)]
pub struct DialRequest {
    pub device_id: String,
}

/// 会话装配本体。所有字段都是 `Send + Sync`,可整体 `Arc` 到路由层。
pub struct RuntimeOps {
    pub identity: Arc<DeviceIdentity>,
    pub store: ConfigStore,
    pub config_path: PathBuf,
    pub config_dir: PathBuf,
    pub device_id: String,
    pub version: String,
    pub dev_mode: bool,
    /// 数据面监听端口(`None` 表示本轮没起 peer server)。
    pub peer_port: Option<u16>,
    pub actor: ActorHandle,
    pub hub: Option<StatusHub>,
    pub terminal: TerminalHub,
    pub started_at: Instant,

    /// `deviceId → 这条连接的控制面出站通道`。
    pub sessions: Mutex<HashMap<String, ControlLink>>,
    pub peer_info: Mutex<HashMap<String, PeerInfo>>,
    /// `deviceId → 本机记录的可达地址`(状态页展示用)。
    pub peer_urls: Mutex<HashMap<String, String>>,
    pub remote_folders: Mutex<HashMap<String, Vec<String>>>,
    pub remote_pending: Mutex<HashMap<String, Vec<String>>>,

    /// 快照台账的值是**累积中的分片状态**而不是裸回执:分片到齐才放行等待方。
    pub pending_snapshots: Mutex<HashMap<String, compare::SnapshotWaiter>>,
    pub pending_files: Mutex<HashMap<String, oneshot::Sender<Result<PeerFile, String>>>>,
    pub pending_writes: Mutex<HashMap<String, oneshot::Sender<Result<(), String>>>>,
    pub pending_binaries: Mutex<HashMap<String, oneshot::Sender<Option<Vec<u8>>>>>,

    pub shutdown_tx: UnboundedSender<()>,
    pub dial_tx: UnboundedSender<DialRequest>,
    pub git_push_running: AtomicBool,

    /// 自动提交台账:挂起通知 / 退避时刻 / 已失败次数 / 最近失败原因。
    ///
    /// 四张表放同一个锁里:结算时它们必须同时前进或同时不动 ——
    /// 分开加锁会出现「通知还在、次数已清零」这种自相矛盾的中间态。
    pub git_state: Mutex<GitState>,
}

/// 自动提交的运行期台账。
#[derive(Default)]
pub struct GitState {
    /// 还没结算的通知:`folderId → 通知`。
    pub pending: HashMap<String, GitNotice>,
    /// 下一次允许重试的时刻(毫秒)。没有条目 = 不在退避中。
    pub retry_at: HashMap<String, i64>,
    /// 已经失败的次数。
    pub attempts: HashMap<String, u32>,
    /// 最近一次失败原因(只保留 `git-auto-commit` 这一类)。
    pub error: HashMap<String, GitFailure>,

    /// 本机出站广播的待回执台账(自己提交的那一笔)。
    pub broadcast: HashMap<String, GitLedger>,
    /// 替别人中继的待回执台账。
    pub relay: HashMap<String, GitLedger>,
    /// 各目录的 HEAD 基线内存镜像。缺键 = 尚未从配置读取;
    /// 值为 `None` = 盘上没有基线(首次启用 / 不是仓库)。
    pub baseline: HashMap<String, Option<String>>,
    /// 已入队的对端提交哈希(去重):重连补发的同一通知不该重复排队。
    pub processed_remote: HashMap<String, Vec<String>>,
    /// 上次跑 git 同步巡检的时刻(毫秒)。巡检挂在 500ms 的排空节拍上,
    /// 靠它节流到与 Node 一致的 5s。
    pub checked_at: i64,
}

/// 一条待结算的 Git 提交通知(对端推来的提交广播)。
#[derive(Debug, Clone)]
pub struct GitNotice {
    /// 最初提交的那台设备 —— 中继全程不改写。
    pub from_device_id: String,
    pub commit_hash: String,
    pub commit_message: String,
    pub changed_files: Vec<String>,
    pub diff_stat: Option<String>,
    /// 本批次全部提交的 subject(旧→新),镜像提交时附进正文。
    pub commit_subjects: Option<Vec<String>>,
    pub parent_hash: String,
    /// 送达它的那一跳(会话)设备 id。中继场景下与 `from_device_id` 不同。
    pub via_device_id: Option<String>,
}

/// 一份待回执的 git 通知台账(出站广播与替别人中继各一份)。
#[derive(Debug, Clone)]
pub struct GitLedger {
    pub notice: GitNotice,
    /// 仍未回执的目标设备 id。
    pub targets: Vec<String>,
    /// 各目标「本地写成功却始终没回执」的重发次数。仅内存,重启归零。
    pub attempts: HashMap<String, u32>,
}

/// 自动提交失败原因。`ts` 供弹窗展示「多久以前失败的」。
#[derive(Debug, Clone)]
pub struct GitFailure {
    pub message: String,
    pub ts: i64,
}

impl GitNotice {
    /// 装进 wire 帧。字段**原样**转发:中继时 `from_device_id` 仍是最初那台提交设备,
    /// 中继设备自己的镜像哈希从头到尾不出门。
    pub fn to_message(&self, folder_id: &str) -> ControlMessage {
        ControlMessage::GitCommitNotify {
            from_device_id: self.from_device_id.clone(),
            folder_id: folder_id.to_string(),
            commit_hash: self.commit_hash.clone(),
            commit_message: self.commit_message.clone(),
            changed_files: self.changed_files.clone(),
            diff_stat: self.diff_stat.clone(),
            commit_subjects: self.commit_subjects.clone(),
            parent_hash: self.parent_hash.clone(),
            // 中继出去的帧署的是**最初那台提交设备**:本机的版本/主机名/平台/形态
            // 一个都不能盖上去,否则对端会把中继机的属性安到源头设备头上。
            version: None,
            hostname: None,
            platform: None,
            runtime: None,
        }
    }

    /// 镜像提交的提交信息:正文用本批最后一笔的完整消息,多于一笔时把其余提交的
    /// subject(旧→新)附在正文后 —— 一笔镜像提交里保留整批脉络(哈希两侧本就不同,
    /// 消息是唯一能对上的线索)。与 Node `composeMirrorCommitMessage` 同义。
    pub fn mirror_message(&self) -> String {
        let rest: Vec<&str> = self
            .commit_subjects
            .as_ref()
            .map(|subjects| {
                let end = subjects.len().saturating_sub(1);
                subjects[..end]
                    .iter()
                    .map(String::as_str)
                    .filter(|subject| !subject.trim().is_empty())
                    .collect()
            })
            .unwrap_or_default();
        if rest.is_empty() {
            self.commit_message.clone()
        } else {
            format!("{}\n\n{}", self.commit_message, rest.join("\n"))
        }
    }

    /// 落盘记录(与 Node `toGitPendingRecord` 同形)。重发计数不出门。
    pub fn to_record(&self, targets: &[String]) -> serde_json::Value {
        let mut record = serde_json::Map::new();
        record.insert(
            "fromDeviceId".into(),
            serde_json::json!(self.from_device_id),
        );
        record.insert("commitHash".into(), serde_json::json!(self.commit_hash));
        record.insert(
            "commitMessage".into(),
            serde_json::json!(self.commit_message),
        );
        record.insert("changedFiles".into(), serde_json::json!(self.changed_files));
        if let Some(stat) = &self.diff_stat {
            record.insert("diffStat".into(), serde_json::json!(stat));
        }
        if let Some(subjects) = &self.commit_subjects {
            if !subjects.is_empty() {
                record.insert("commitSubjects".into(), serde_json::json!(subjects));
            }
        }
        record.insert("parentHash".into(), serde_json::json!(self.parent_hash));
        record.insert("targets".into(), serde_json::json!(targets));
        serde_json::Value::Object(record)
    }

    /// 从配置里的待投递记录还原。字段不全或名单为空一律视为无 —— 宁可不投,
    /// 也不凭一份残缺记录往外发通知(配置可被手改)。
    pub fn from_record(folder_id: &str, record: &serde_json::Value) -> Option<(Self, Vec<String>)> {
        let text = |key: &str| record.get(key).and_then(|v| v.as_str()).map(str::to_string);
        let from_device_id = text("fromDeviceId").filter(|value| !value.is_empty())?;
        let commit_hash = text("commitHash").filter(|value| !value.is_empty())?;
        let commit_message = text("commitMessage")?;
        let targets: Vec<String> = record
            .get("targets")
            .and_then(|v| v.as_array())
            .map(|list| {
                list.iter()
                    .filter_map(|v| v.as_str())
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        if targets.is_empty() {
            return None;
        }
        let changed_files: Vec<String> = record
            .get("changedFiles")
            .and_then(|v| v.as_array())
            .map(|list| {
                list.iter()
                    .filter_map(|v| v.as_str())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        let commit_subjects = record
            .get("commitSubjects")
            .and_then(|v| v.as_array())
            .map(|list| {
                list.iter()
                    .filter_map(|v| v.as_str())
                    .filter(|subject| !subject.is_empty())
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            });
        let _ = folder_id;
        Some((
            GitNotice {
                from_device_id,
                commit_hash,
                commit_message,
                changed_files,
                diff_stat: text("diffStat"),
                commit_subjects,
                parent_hash: text("parentHash").unwrap_or_default(),
                via_device_id: None,
            },
            targets,
        ))
    }
}

/// 判断一行是否是 Co-Authored-By 尾注:等价于正则 `/co-?authored-by/i` —— 不锚定、
/// 大小写不敏感、`co` 与 `authored` 之间的连字符可有可无。syncx-cli 没依赖 regex,
/// 手写「转小写后包含」匹配与既有风格一致,也省一次编译期正则。
fn is_co_authored_line(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    lower.contains("co-authored-by") || lower.contains("coauthored-by")
}

/// 剔除提交信息里的 Co-Authored-By 行(目录开关 `gitStripCoAuthored` 开启时,
/// 镜像自动提交用它清洗最终提交消息)。三端统一契约,字段名不得改。
///
/// 规则:命中的**整行**剔除(不只首行);剔除留下的空档不外溢 —— 被剔除行紧前面
/// 尚未落笔的空行一并吞掉,结尾残留的空行整体砍掉,其余空行原样保留。没有命中行时
/// 原样返回,一个字节都不动。
pub fn strip_co_authored_lines(message: &str) -> String {
    if !message.lines().any(|line| is_co_authored_line(line)) {
        return message.to_string();
    }
    let mut out: Vec<&str> = Vec::new();
    // 尚未落笔的空行:遇到被剔除行就整个吞掉(这正是「不留连续空行尾巴」的一半),
    // 遇到正文行才按原数量 flush(没被波及的空行节奏不变)。
    let mut pending_blanks: usize = 0;
    for line in message.lines() {
        if is_co_authored_line(line) {
            pending_blanks = 0;
            continue;
        }
        if line.trim().is_empty() {
            pending_blanks += 1;
            continue;
        }
        out.extend(std::iter::repeat_n("", pending_blanks));
        pending_blanks = 0;
        out.push(line);
    }
    // 结尾残留的 pending 是剔除造成的空行尾巴,不落笔。
    out.join("\n")
}

/// 控制面出站通道(与 `syncx_api::deps` 里的同名类型无关,这里是 daemon 侧的)。
#[derive(Clone)]
pub struct ControlLink {
    pub device_id: String,
    pub outbound: UnboundedSender<ControlMessage>,
}

impl RuntimeOps {
    /// 当前进程的版本 / 主机名 / 平台。每条控制帧都带上,对端据此在状态页展示。
    pub fn self_info(&self) -> (String, Option<String>, Option<String>) {
        (
            self.version.clone(),
            hostname::get()
                .ok()
                .and_then(|name| name.into_string().ok()),
            Some(status::platform_name().to_string()),
        )
    }

    /// 沿某设备的控制面通道发一帧。连接不在(或刚断)返回 `false`,
    /// 调用方据此决定是「静默跳过」还是「报错」——两者语义不同,不能一刀切。
    pub fn send_to(&self, device_id: &str, message: ControlMessage) -> bool {
        let link = match self.sessions.lock() {
            Ok(map) => map.get(device_id).cloned(),
            Err(_) => None,
        };
        match link {
            Some(link) => link.outbound.send(message).is_ok(),
            None => false,
        }
    }

    pub fn is_connected(&self, device_id: &str) -> bool {
        self.sessions
            .lock()
            .map(|map| map.contains_key(device_id))
            .unwrap_or(false)
    }

    pub fn register_session(&self, link: ControlLink) {
        if let Ok(mut map) = self.sessions.lock() {
            map.insert(link.device_id.clone(), link);
        }
    }

    pub fn drop_session(&self, device_id: &str) {
        if let Ok(mut map) = self.sessions.lock() {
            // 只删「同一设备」的条目:重连风暴里后到的连接可能已经覆盖了先到的,
            // 无条件 remove 会把新连接也摘掉,表现为「刚连上就掉线」。
            map.remove(device_id);
        }
    }

    /// 学习对端自报的信息。返回 `true` 表示**版本号发生了变化**
    /// (调用方据此打一行日志,只在变化时打,避免每帧刷屏)。
    pub fn learn_peer_info(
        &self,
        device_id: &str,
        version: Option<&str>,
        hostname: Option<&str>,
        platform: Option<&str>,
        runtime: Option<&str>,
    ) -> bool {
        let Ok(mut map) = self.peer_info.lock() else {
            return false;
        };
        let entry = map.entry(device_id.to_string()).or_default();
        let changed = match version {
            Some(next) if entry.version.as_deref() != Some(next) => {
                entry.version = Some(next.to_string());
                true
            }
            Some(_) => false,
            None => false,
        };
        if let Some(value) = hostname {
            entry.hostname = Some(value.to_string());
        }
        if let Some(value) = platform {
            entry.platform = Some(value.to_string());
        }
        if let Some(value) = runtime {
            entry.runtime = Some(value.to_string());
        }
        changed
    }

    pub fn peer_info_of(&self, device_id: &str) -> PeerInfo {
        self.peer_info
            .lock()
            .ok()
            .and_then(|map| map.get(device_id).cloned())
            .unwrap_or_default()
    }

    pub fn record_peer_url(&self, device_id: &str, url: &str) {
        if let Ok(mut map) = self.peer_urls.lock() {
            map.insert(device_id.to_string(), url.to_string());
        }
    }

    pub fn peer_url_of(&self, device_id: &str) -> Option<String> {
        self.peer_urls
            .lock()
            .ok()
            .and_then(|map| map.get(device_id).cloned())
    }

    /// 把本机「共享意图」推给对端:目录邀请 + 配对请求。
    ///
    /// 一台设备刚连上、刚被信任、或刚接受邀请时都要推一遍 —— 对端按去重键只保留
    /// 一张卡片,重复推不会刷屏,漏推才会让离线期间建立的共享意图永远到不了对端。
    pub fn push_shares_to(&self, device_id: &str) {
        let config = self.store.load();
        let (version, hostname, platform) = self.self_info();
        for folder in &config.shared_folders {
            if !folder.devices.iter().any(|id| id == device_id) {
                continue;
            }
            let folder_id = folder.folder_id();
            let _ = self.send_to(
                device_id,
                ControlMessage::FolderInvitation {
                    offer_id: offers::make_offer_id("folder", device_id, Some(&folder_id)),
                    from_device_id: self.device_id.clone(),
                    folder_id: folder_id.clone(),
                    folder_name: folder_id,
                    version: Some(version.clone()),
                    hostname: hostname.clone(),
                    platform: platform.clone(),
                    runtime: Some(RUNTIME.to_string()),
                },
            );
        }
        if config.known_devices.iter().any(|d| d.id == device_id) {
            let _ = self.send_to(
                device_id,
                ControlMessage::PairingRequest {
                    offer_id: offers::make_offer_id("pair", device_id, None),
                    from_device_id: self.device_id.clone(),
                    version: Some(version),
                    hostname,
                    platform,
                    runtime: Some(RUNTIME.to_string()),
                },
            );
        }
    }

    /// 反推「本机当前仍想共享给该设备」的目录清单。
    ///
    /// 对端据此把目录标签从「已停止共享」切回来,并清理自己那边已被撤销的卡片。
    pub fn push_folder_sync_list(&self, device_id: &str) {
        let config = self.store.load();
        let folder_ids: Vec<String> = config
            .shared_folders
            .iter()
            .filter(|folder| folder.devices.iter().any(|id| id == device_id))
            .map(|folder| folder.folder_id())
            .collect();
        let pending: Vec<String> = config
            .pending_offers
            .iter()
            .filter(|offer| {
                offer.kind == "folder"
                    && offer.status == "pending"
                    && offer.from_device_id == device_id
            })
            .filter_map(|offer| offer.folder_id.clone())
            .collect();
        let (version, hostname, platform) = self.self_info();
        let _ = self.send_to(
            device_id,
            ControlMessage::FolderSyncList {
                from_device_id: self.device_id.clone(),
                folder_ids,
                pending_folder_ids: Some(pending),
                version: Some(version),
                hostname,
                platform,
                runtime: Some(RUNTIME.to_string()),
            },
        );
    }

    /// 已经信任了对端:补推共享意图与目录清单。
    ///
    /// **数据面槽位不在这里补建** —— 槽位归连接驱动所有,只有会话建立时能分配。
    /// 因此接受邀请后由 [`Self::reload_config`] 重建目录状态、并让对端在下次重连时
    /// 自动挂上;这一点与 Node 的 `promoteSession` 略有差异,但不会造成「静默不同步」:
    /// 双方此刻都已经把对方列进该目录,重连后一定互相挂载。
    pub fn promote_session(&self, device_id: &str) {
        if !self.is_connected(device_id) {
            return;
        }
        self.push_shares_to(device_id);
        self.push_folder_sync_list(device_id);
    }

    /// 对端已在线时立刻补发配对请求(刚把对方加为已知设备时调用)。
    pub fn notify_pairing_intent(&self, device_id: &str) {
        if !self.is_connected(device_id) {
            return;
        }
        let (version, hostname, platform) = self.self_info();
        let _ = self.send_to(
            device_id,
            ControlMessage::PairingRequest {
                offer_id: offers::make_offer_id("pair", device_id, None),
                from_device_id: self.device_id.clone(),
                version: Some(version),
                hostname,
                platform,
                runtime: Some(RUNTIME.to_string()),
            },
        );
        self.push_shares_to(device_id);
    }

    /// 该目录此刻生效的忽略规则行(内置 + .gitignore + .syncxignore)。
    pub fn ignore_lines(&self, folder: &syncx_api::config::SharedFolder) -> Vec<String> {
        let syncx_lines = syncx_api::ignorefile::read_syncx_ignore_lines(Path::new(&folder.path));
        syncx_api::ignorefile::compose_ignore_lines(
            Path::new(&folder.path),
            folder.use_gitignore_enabled(),
            &syncx_lines,
        )
    }

    /// 从 actor 取某目录的整份索引(含墓碑)。目录不在 actor 里返回 `None`。
    pub fn index_snapshot(&self, folder_id: &str) -> Option<Vec<StoredEntry>> {
        let (tx, rx) = oneshot::channel();
        if !self.actor.send(Cmd::IndexSnapshot {
            folder: folder_id.to_string(),
            reply: tx,
        }) {
            return None;
        }
        update::bridge(async move { rx.await.map_err(|e| e.to_string()) })
            .ok()
            .flatten()
    }

    /// 从 actor 取某目录的一条索引。
    pub fn entry_lookup(&self, folder_id: &str, path: &str) -> Option<StoredEntry> {
        let (tx, rx) = oneshot::channel();
        if !self.actor.send(Cmd::EntryLookup {
            folder: folder_id.to_string(),
            path: path.to_string(),
            reply: tx,
        }) {
            return None;
        }
        update::bridge(async move { rx.await.map_err(|e| e.to_string()) })
            .ok()
            .flatten()
    }

    /// 写一条同步记录。历史库只按目录分文件,写失败只记日志,不打断同步。
    pub fn record_event(
        &self,
        folder_id: &str,
        path: &str,
        action: &str,
        direction: &str,
        device_id: Option<&str>,
        duration_ms: Option<i64>,
    ) {
        let store = HistoryStore::new(self.config_path.clone(), Some(2000));
        let _ = store.record(syncx_api::history::SyncEvent {
            ts: syncx_api::auth::now_ms(),
            folder_id: folder_id.to_string(),
            path: path.to_string(),
            action: action.to_string(),
            direction: direction.to_string(),
            device_id: device_id.map(str::to_string),
            duration_ms,
        });
    }

    pub fn notify_hub(&self) {
        if let Some(hub) = &self.hub {
            hub.notify();
        }
    }

    /// 当前进程的流量统计。Rust 后端暂不采样,故不提供该键(前端把它当可选)。
    pub fn traffic(&self) -> Option<TrafficStats> {
        None
    }

    /* ---------------------- Git 提交通知的结算 ---------------------- */

    /// 收到对端的一笔提交广播:先过闸门,再入账。
    ///
    /// 三道闸门与 Node `onGitCommitNotify` 一致:目录不在本地配置 → 丢;该目录的
    /// `gitSync` 不是接收模式 → 丢;同一 `commitHash` 已入过队 → 丢(重连补发)。
    /// 只入队不提交:通知走控制面、内容走数据面,立刻 `git add -A` 会把半套文件定格。
    pub fn note_git_notice(&self, folder_id: &str, notice: GitNotice) {
        let config = self.store.load();
        let Some(folder) = config.folder(folder_id) else {
            return;
        };
        let receives = matches!(folder.git_sync.as_deref(), Some("receive") | Some("full"));
        if !receives {
            return;
        }
        if !crate::git::is_git_repo(Path::new(&folder.path)) {
            tracing::info!("git-commit-notify ignored: {folder_id} 不是 git 仓库");
            return;
        }
        if let Ok(mut state) = self.git_state.lock() {
            let seen = state
                .processed_remote
                .entry(folder_id.to_string())
                .or_default();
            if seen.iter().any(|hash| hash == &notice.commit_hash) {
                return;
            }
            seen.push(notice.commit_hash.clone());
            // 去重集合要有上限:长跑的 daemon 会积累成千上万条哈希
            if seen.len() > 1000 {
                seen.drain(..500);
            }
            tracing::info!(
                "git-commit-notify queued: {folder_id} (from {}) \"{}\"",
                notice.from_device_id,
                notice.commit_message.lines().next().unwrap_or("")
            );
            state.pending.insert(folder_id.to_string(), notice);
        }
        self.notify_hub();
    }

    /// 立刻结算某目录的挂起通知。
    ///
    /// 闸门与 Node 一致:目录不在配置 / 暂停 / 接收未排空时**不提交**,
    /// 留在台账里等下一轮。半套文件被定格正是这些闸门要防的事。
    ///
    /// 返回 `Ok(Some(_))` = 结了(`{ok:true, hash?, attempts}`);
    /// `Ok(None)` = 被闸门挡住,仍在等待。
    pub fn settle_git_notice(
        &self,
        folder_id: &str,
        root: &Path,
    ) -> Result<Option<Value>, OpError> {
        let config = self.store.load();
        let Some(folder) = config.folder(folder_id).cloned() else {
            // 目录没了:通知也就没有意义,直接丢掉,免得台账永远留着一条死项
            if let Ok(mut state) = self.git_state.lock() {
                state.pending.remove(folder_id);
            }
            return Err(OpError::Failed("共享目录不存在(可能刚被移除)".to_string()));
        };
        if folder.is_paused() || config.is_paused() {
            return Ok(None);
        }
        // 目录身份指纹坏掉(missing/changed/remounted)时 HEAD 读数来自「可能被换掉的盘」,
        // 拿去提交等于替错误内容背书。与 Node `gitBlockedByIdentity` 同一判据。
        if matches!(
            syncx_api::mutate::folder_identity_verdict(&folder),
            "missing" | "changed" | "remounted"
        ) {
            return Ok(None);
        }
        if !git_ready(self, folder_id) {
            return Ok(None);
        }
        let notice = match self.git_state.lock() {
            Ok(state) => state.pending.get(folder_id).cloned(),
            Err(_) => None,
        };
        let Some(notice) = notice else {
            return Ok(None);
        };

        // 工作树干净(内容早随上一笔结算提交过,或对端提交无净变更):不提交,但仍要
        // 结清通知并把基线推到当前 HEAD —— 不推进的话下一轮巡检会把同一笔当新提交广播。
        if !crate::git::has_uncommitted_changes(root) {
            if let Ok(mut state) = self.git_state.lock() {
                state.pending.remove(folder_id);
                state.attempts.remove(folder_id);
                state.retry_at.remove(folder_id);
                state.error.remove(folder_id);
                state.relay.remove(folder_id);
            }
            tracing::info!(
                "git auto-commit skipped (nothing to commit): {folder_id} (from {})",
                notice.from_device_id
            );
            self.set_git_baseline(folder_id, crate::git::get_last_commit_hash(root));
            self.notify_hub();
            let mut out = serde_json::Map::new();
            out.insert("ok".into(), json!(true));
            out.insert("attempts".into(), json!(0));
            return Ok(Some(Value::Object(out)));
        }

        // gitStripCoAuthored 开启时,镜像提交信息剔除 Co-Authored-By 行。清洗只
        // 作用于本机落盘的这笔提交;中继/广播给对端的 notice 仍是原始消息。
        let mut message = notice.mirror_message();
        if folder.git_strip_co_authored == Some(true) {
            message = strip_co_authored_lines(&message);
        }
        let outcome = crate::git::auto_commit(root, &message);
        let mut state = match self.git_state.lock() {
            Ok(state) => state,
            Err(_) => return Err(OpError::Failed("提交台账不可用".to_string())),
        };
        if outcome.success {
            state.pending.remove(folder_id);
            state.attempts.remove(folder_id);
            state.retry_at.remove(folder_id);
            state.error.remove(folder_id);
            state.relay.remove(folder_id);
            let attempts = 0u32;
            drop(state);
            tracing::info!(
                "git auto-commit ok: {folder_id} ({})",
                outcome.hash.as_deref().unwrap_or("")
            );
            // 基线推到镜像提交后的 HEAD:不推的话下一轮巡检会把这笔镜像提交
            // 当成「本机新提交」再广播回去(死循环)。
            let baseline = outcome
                .hash
                .clone()
                .or_else(|| crate::git::get_last_commit_hash(root));
            self.set_git_baseline(folder_id, baseline.clone());
            // 真的落成了一笔镜像提交,才把通知中继给本机其余对端 ——
            // 链路不成环正是因为它每经一台真落了提交的设备才多走一跳。
            git_sync::relay_notice(self, folder_id, &notice);
            let mut out = serde_json::Map::new();
            out.insert("ok".into(), json!(true));
            if let Some(hash) = &outcome.hash {
                out.insert("hash".into(), json!(hash));
            }
            out.insert("attempts".into(), json!(attempts));
            self.notify_hub();
            return Ok(Some(Value::Object(out)));
        }

        let attempts = state
            .attempts
            .entry(folder_id.to_string())
            .and_modify(|n| *n += 1)
            .or_insert(1)
            .to_owned();
        let message = outcome
            .error
            .clone()
            .unwrap_or_else(|| "git commit 执行失败".to_string());
        state.error.insert(
            folder_id.to_string(),
            GitFailure {
                message: message.clone(),
                ts: syncx_api::auth::now_ms(),
            },
        );
        if attempts >= git::GIT_AUTO_COMMIT_MAX_ATTEMPTS {
            // 次数耗尽:不再排重试,弹窗据此显示「已放弃」并给出手动重试
            state.retry_at.remove(folder_id);
        } else {
            state.retry_at.insert(
                folder_id.to_string(),
                syncx_api::auth::now_ms() + git::GIT_AUTO_COMMIT_RETRY_MS,
            );
        }
        drop(state);
        tracing::warn!("git auto-commit failed ({attempts}): {folder_id}: {message}");
        self.notify_hub();
        // 「失败了」不是「结算成功」:回 None 让调用方按闸门口径回话,
        // 失败原因从台账里取,保持同一句话只有一个来源。
        Ok(None)
    }

    /// 到期的目录挨个结算一遍。装配层的 tick 每轮调它。
    ///
    /// 开头先补投两份额外台账(替别人中继的、本机出站广播的),再结算挂起通知,
    /// 最后检测本机新提交并广播 —— 顺序与 Node `flushPendingGitNotify` +
    /// `checkGitCommits` 一致。先结算后检测是**死循环防护**:结算里的镜像提交会把
    /// 基线推到新 HEAD,检测因此不会把它误判成本机新提交而弹回对端。
    pub fn flush_git_notices(&self) {
        let now = syncx_api::auth::now_ms();
        let config = self.store.load();

        git_sync::retry_relays(self, &config);
        git_sync::retry_broadcasts(self, &config);

        let due: Vec<(String, PathBuf)> = match self.git_state.lock() {
            Ok(state) => state
                .pending
                .keys()
                .filter(|id| state.retry_at.get(*id).is_none_or(|at| *at <= now))
                .filter_map(|id| {
                    config
                        .folder(id)
                        .map(|folder| (id.clone(), PathBuf::from(&folder.path)))
                })
                .collect(),
            Err(_) => return,
        };
        for (folder_id, root) in due {
            let _ = self.settle_git_notice(&folder_id, &root);
        }

        git_sync::check_local_commits(self, &config, now);
    }

    /// 更新某目录的 HEAD 基线并落盘(内存与磁盘始终同值,热重载读回的必然是最新基线)。
    ///
    /// `None` = 不是 git 仓库:清掉盘上的陈旧基线,免得日后重建仓库时拿旧哈希去比对。
    pub fn set_git_baseline(&self, folder_id: &str, hash: Option<String>) {
        let changed = {
            let mut state = match self.git_state.lock() {
                Ok(state) => state,
                Err(_) => return,
            };
            let current = state
                .baseline
                .entry(folder_id.to_string())
                .or_insert_with(|| {
                    self.store
                        .load()
                        .folder(folder_id)
                        .and_then(|folder| folder.git_last_commit_hash.clone())
                });
            if *current == hash {
                return;
            }
            *current = hash.clone();
            true
        };
        if !changed {
            return;
        }
        let _ = self.store.mutate(|config: &mut Config| {
            let Some(folder) = config
                .shared_folders
                .iter_mut()
                .find(|folder| folder.folder_id() == folder_id)
            else {
                return Ok::<_, std::io::Error>(false);
            };
            if folder.git_last_commit_hash == hash {
                return Ok(false);
            }
            folder.git_last_commit_hash = hash.clone();
            Ok(true)
        });
    }

    /// 读某目录的 HEAD 基线(内存镜像优先,缺键时从配置取)。
    pub fn git_baseline(&self, folder_id: &str) -> Option<String> {
        if let Ok(mut state) = self.git_state.lock() {
            if let Some(value) = state.baseline.get(folder_id) {
                return value.clone();
            }
            let loaded = self
                .store
                .load()
                .folder(folder_id)
                .and_then(|folder| folder.git_last_commit_hash.clone());
            state.baseline.insert(folder_id.to_string(), loaded.clone());
            return loaded;
        }
        None
    }

    /// 更新出站广播 / 中继台账并落盘。
    ///
    /// `slot` 取 `"broadcast"` 或 `"relay"`;`None` 记录 = 清空该项。内存与配置
    /// 始终同值 —— daemon 重启后靠这份记录接着补投,这一跳不会因「投出去之前重启」丢。
    pub fn set_git_ledger(&self, folder_id: &str, slot: &str, next: Option<GitLedger>) {
        {
            let mut state = match self.git_state.lock() {
                Ok(state) => state,
                Err(_) => return,
            };
            let table = if slot == "relay" {
                &mut state.relay
            } else {
                &mut state.broadcast
            };
            match &next {
                Some(ledger) => {
                    table.insert(folder_id.to_string(), ledger.clone());
                }
                None => {
                    table.remove(folder_id);
                }
            }
        }
        let record = next
            .as_ref()
            .map(|ledger| ledger.notice.to_record(&ledger.targets));
        let key = if slot == "relay" {
            "git_relay_pending"
        } else {
            "git_broadcast_pending"
        };
        let _ = self.store.mutate(|config: &mut Config| {
            let Some(folder) = config
                .shared_folders
                .iter_mut()
                .find(|folder| folder.folder_id() == folder_id)
            else {
                return Ok::<_, std::io::Error>(false);
            };
            let next = record.clone();
            let current = if key == "git_relay_pending" {
                &folder.git_relay_pending
            } else {
                &folder.git_broadcast_pending
            };
            if current.as_ref() == next.as_ref() {
                return Ok(false);
            }
            if key == "git_relay_pending" {
                folder.git_relay_pending = next;
            } else {
                folder.git_broadcast_pending = next;
            }
            Ok(true)
        });
    }

    /// 从配置里把两份待投递台账还原进内存(热重载与启动时各调一次)。
    pub fn restore_git_ledgers(&self, config: &Config) {
        let mut state = match self.git_state.lock() {
            Ok(state) => state,
            Err(_) => return,
        };
        state.broadcast.clear();
        state.relay.clear();
        state.baseline.clear();
        for folder in &config.shared_folders {
            let folder_id = folder.folder_id();
            state
                .baseline
                .insert(folder_id.clone(), folder.git_last_commit_hash.clone());
            if let Some((notice, targets)) = folder
                .git_broadcast_pending
                .as_ref()
                .and_then(|record| GitNotice::from_record(&folder_id, record))
            {
                state.broadcast.insert(
                    folder_id.clone(),
                    GitLedger {
                        notice,
                        targets,
                        attempts: HashMap::new(),
                    },
                );
            }
            if let Some((notice, targets)) = folder
                .git_relay_pending
                .as_ref()
                .and_then(|record| GitNotice::from_record(&folder_id, record))
            {
                state.relay.insert(
                    folder_id,
                    GitLedger {
                        notice,
                        targets,
                        attempts: HashMap::new(),
                    },
                );
            }
        }
    }
}

/// 该目录此刻是否「内容已收齐、可以落提交」。
///
/// 两道闸门缺一不可:在途接收未排空 → 提交会定格半套文件;
/// 首轮索引交换未完成 → 对端的新内容还没到,提交的是一份残缺快照。
fn git_ready(ops: &RuntimeOps, folder_id: &str) -> bool {
    let snapshot = ops.actor.snapshot();
    let Some(status) = snapshot.folders.iter().find(|f| f.id == folder_id) else {
        return false;
    };
    if status.progress.receiving > 0 || status.progress.pending > 0 {
        return false;
    }
    !status.disk_blocked.is_some()
}

/// 「本机允许与这台设备交互」:已知设备,或任意共享目录已把它列进 devices。
pub fn is_peer_allowed(config: &Config, device_id: &str) -> bool {
    config.known_devices.iter().any(|d| d.id == device_id)
        || config
            .shared_folders
            .iter()
            .any(|folder| folder.devices.iter().any(|id| id == device_id))
}

impl ControlOps for RuntimeOps {
    // ---- 状态与生命周期 ----

    fn paircode(&self) -> OpResult<Value> {
        let port = self.peer_port.unwrap_or(0);
        Ok(json!({
            "deviceId": self.device_id,
            "port": port,
            "addresses": status::lan_addresses(),
        }))
    }

    fn rescan(&self) -> OpResult<()> {
        if self.actor.send(Cmd::Scan) {
            Ok(())
        } else {
            Err(OpError::Failed("扫描通道已关闭".to_string()))
        }
    }

    fn reconnect(&self, device_id: &str) -> OpResult<()> {
        if device_id.trim().is_empty() {
            return Err(OpError::Failed("deviceId is required".to_string()));
        }
        let config = self.store.load();
        if config.folder(device_id).is_none()
            && !config.known_devices.iter().any(|d| d.id == device_id)
        {
            return Err(OpError::Failed(format!("未配置该设备:{device_id}")));
        }
        let _ = self.dial_tx.send(DialRequest {
            device_id: device_id.to_string(),
        });
        Ok(())
    }

    fn shutdown(&self) -> OpResult<()> {
        self.shutdown_tx
            .send(())
            .map_err(|_| OpError::Failed("daemon 已在退出".to_string()))
    }

    fn check_for_update(&self) -> OpResult<Option<Value>> {
        if self.dev_mode {
            return Err(OpError::Failed(
                "开发模式下不支持升级功能（运行态为 dev，无单文件运行时可替换）".to_string(),
            ));
        }
        let info = update::check_for_update_blocking().map_err(OpError::Failed)?;
        if update::compare_versions(&info.latest, &info.current) > 0 {
            Ok(Some(
                serde_json::to_value(&info).map_err(|e| OpError::Failed(e.to_string()))?,
            ))
        } else {
            Ok(None)
        }
    }

    fn self_update_npm(&self) -> OpResult<String> {
        if self.dev_mode {
            return Err(OpError::Failed(
                "开发模式下不支持升级功能（运行态为 dev，无单文件运行时可替换）".to_string(),
            ));
        }
        let pid_file = crate::daemon::pid_file_path(&self.config_dir);
        let io = update::UpgradeIo {
            log: &|line: &str| tracing::info!("{line}"),
            error: &|line: &str| tracing::error!("{line}"),
        };
        // daemon 触发的升级带原 argv 与原工作目录:换入后看门狗拉起新进程、
        // 等健康标记,超时换回 .old(ADR-0025 第 3 节)。日志文件从自己的 argv
        // 里抠:新进程启动期的 panic 必须有去处,不能进 /dev/null。
        let restart = update::UpdateRestart {
            args: std::env::args().skip(1).collect(),
            cwd: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            log_file: daemon_log_file_from_argv(),
        };
        update::run_upgrade(None, &io, Some(&pid_file), Some(restart)).map_err(OpError::Failed)?;
        // 返回升级后的目标版本:升级成功时 npm 已经换过一遍,再查一次通道版本
        Ok(update::fetch_tag_version(DEFAULT_TAG)
            .unwrap_or_else(|| syncx_core::version_string().to_string()))
    }

    fn self_update_from_device(&self, device_id: &str) -> OpResult<String> {
        if self.dev_mode {
            return Err(OpError::Failed(
                "开发模式下不支持升级功能（运行态为 dev，无单文件运行时可替换）".to_string(),
            ));
        }
        let bytes = compare::request_self_binary(self, device_id)?;
        // 对端互传只认 npm 载体:后端二进制包没有设备间的分发契约,换入风险
        // (目标平台不符/来源二进制)也不该由这条通道兜。
        let inspected = update::inspect_uploaded_package(&bytes).map_err(OpError::Failed)?;
        if inspected.backend != "node" {
            return Err(OpError::Failed(
                "对端互传安装包只支持 npm 载体（收到后端二进制包）".to_string(),
            ));
        }
        install_tarball(&self.config_dir, &bytes, &inspected)
    }

    fn inspect_package(&self, tgz: &[u8]) -> OpResult<Value> {
        update::inspect_uploaded_package(tgz)
            .map(|inspect| inspect.to_json())
            .map_err(OpError::Failed)
    }

    fn self_update_upload(&self, tgz: &[u8]) -> OpResult<String> {
        if self.dev_mode {
            return Err(OpError::Failed(
                "开发模式下不支持升级功能（运行态为 dev，无单文件运行时可替换）".to_string(),
            ));
        }
        // 识别 → 按包类型分流:npm tgz 走 npm 覆盖(现有通道);后端二进制包
        // (pack:local --backend rust/moonbit 的产物)走看门狗跨后端 exec 换入。
        let inspected = update::inspect_uploaded_package(tgz).map_err(OpError::Failed)?;
        match update::upload_route(&inspected.backend).map_err(OpError::Failed)? {
            update::UploadRoute::NpmInstall => {
                install_tarball(&self.config_dir, tgz, &inspected)
            }
            update::UploadRoute::BackendSwap => update::install_backend_package(
                tgz,
                &inspected,
                &self.config_dir,
                daemon_log_file_from_argv(),
            )
            .map_err(OpError::Failed),
        }
    }

    // ---- 数据面动作 ----

    fn prioritize_transfer(&self, folder_id: &str, path: &str) -> OpResult<()> {
        if self.actor.send(Cmd::Prioritize {
            folder: folder_id.to_string(),
            path: path.to_string(),
        }) {
            Ok(())
        } else {
            Err(OpError::Failed("同步通道已关闭".to_string()))
        }
    }

    fn materialize(&self, folder_id: &str, path: &str) -> OpResult<()> {
        if self.actor.send(Cmd::Materialize {
            folder: folder_id.to_string(),
            path: path.to_string(),
        }) {
            Ok(())
        } else {
            Err(OpError::Failed("同步通道已关闭".to_string()))
        }
    }

    fn list_placeholders(&self, folder_id: &str) -> Vec<(String, u64)> {
        self.index_snapshot(folder_id)
            .map(|entries| {
                entries
                    .into_iter()
                    .filter(|entry| entry.placeholder && !entry.deleted)
                    .map(|entry| (entry.path, entry.size))
                    .collect()
            })
            .unwrap_or_default()
    }

    // ---- 待确认项 ----

    fn accept_offer(
        &self,
        offer_id: &str,
        local_path: Option<&str>,
        receive_only: bool,
    ) -> OpResult<()> {
        // 先查再落状态:校验失败时若已标 accepted,卡片消失而目录没建起来,
        // 用户就失去了重试入口(与 Node 的注释同一条理由)。
        let offer = find_offer(&self.store, offer_id)?;
        let (version, hostname, platform) = self.self_info();

        if offer.kind == "folder" {
            let folder_id = offer
                .folder_id
                .clone()
                .ok_or_else(|| OpError::Failed("folder offer missing folder id".to_string()))?;
            mutate::accept_folder_invitation(
                &self.store,
                &folder_id,
                &offer.from_device_id,
                local_path,
                receive_only,
            )
            .map_err(|error| OpError::Failed(error.to_string()))?;
            if offers::mark_accepted(&self.store, offer_id).is_none() {
                return Err(OpError::Failed("offer not found".to_string()));
            }
            let _ = self.send_to(
                &offer.from_device_id,
                ControlMessage::FolderInvitationAck {
                    offer_id: offer.id.clone(),
                    from_device_id: self.device_id.clone(),
                    accepted: true,
                    version: Some(version),
                    hostname,
                    platform,
                    runtime: Some(RUNTIME.to_string()),
                },
            );
            tracing::info!(
                "accepted folder invitation {} from {}",
                folder_id,
                offer.from_device_id
            );
            // 接受后目录已写入配置:立刻重建目录状态,免去手动重启
            self.reload_config();
        } else {
            if offers::mark_accepted(&self.store, offer_id).is_none() {
                return Err(OpError::Failed("offer not found".to_string()));
            }
            mutate::add_device(&self.store, &offer.from_device_id, None)
                .map_err(|error| OpError::Failed(error.to_string()))?;
            let _ = self.send_to(
                &offer.from_device_id,
                ControlMessage::PairingAck {
                    offer_id: offer.id.clone(),
                    from_device_id: self.device_id.clone(),
                    accepted: true,
                    version: Some(version),
                    hostname,
                    platform,
                    runtime: Some(RUNTIME.to_string()),
                },
            );
            tracing::info!("accepted pairing request from {}", offer.from_device_id);
        }
        self.promote_session(&offer.from_device_id);
        self.notify_hub();
        Ok(())
    }

    fn decline_offer(&self, offer_id: &str) -> OpResult<()> {
        let offer = match offers::mark_declined(&self.store, offer_id) {
            Some(offer) => offer,
            None => return Err(OpError::Failed("offer not found".to_string())),
        };
        let (version, hostname, platform) = self.self_info();
        let ack = if offer.kind == "folder" {
            ControlMessage::FolderInvitationAck {
                offer_id: offer.id.clone(),
                from_device_id: self.device_id.clone(),
                accepted: false,
                version: Some(version),
                hostname,
                platform,
                runtime: Some(RUNTIME.to_string()),
            }
        } else {
            ControlMessage::PairingAck {
                offer_id: offer.id.clone(),
                from_device_id: self.device_id.clone(),
                accepted: false,
                version: Some(version),
                hostname,
                platform,
                runtime: Some(RUNTIME.to_string()),
            }
        };
        let _ = self.send_to(&offer.from_device_id, ack);
        // 卡片已消失:反推目录清单,让对方设备标签从「待对方确认」切回「已停止共享」
        if offer.kind == "folder" {
            self.push_folder_sync_list(&offer.from_device_id);
        }
        tracing::info!("declined offer from {}", offer.from_device_id);
        self.notify_hub();
        Ok(())
    }

    fn restore_offer(&self, offer_id: &str) -> OpResult<()> {
        let offer = match offers::restore_declined(&self.store, offer_id) {
            Some(offer) => offer,
            None => {
                return Err(OpError::Failed(
                    "offer not found or not declined".to_string(),
                ))
            }
        };
        if offer.kind == "folder" {
            self.push_folder_sync_list(&offer.from_device_id);
        }
        tracing::info!("restored declined offer from {}", offer.from_device_id);
        self.notify_hub();
        Ok(())
    }

    // ---- 对端通信 ----

    fn diff_folder(&self, folder_id: &str, device_id: &str) -> OpResult<Value> {
        compare::diff_folder(self, folder_id, device_id, false)
    }

    fn compare_folder(&self, folder_id: &str, device_id: &str) -> OpResult<Value> {
        compare::diff_folder(self, folder_id, device_id, true)
    }

    fn read_file_pair(&self, folder_id: &str, device_id: &str, path: &str) -> OpResult<Value> {
        compare::read_file_pair(self, folder_id, device_id, path)
    }

    fn apply_file_sync(
        &self,
        folder_id: &str,
        device_id: &str,
        path: &str,
        direction: &str,
        content: Option<String>,
    ) -> OpResult<()> {
        compare::apply_file_sync(self, folder_id, device_id, path, direction, content)
    }

    fn rollback(&self, folder_id: &str, target_ts: i64, dry_run: bool) -> OpResult<Value> {
        let folder = self
            .store
            .load()
            .folder(folder_id)
            .cloned()
            .ok_or_else(|| OpError::Failed("folder not found".to_string()))?;
        let history = HistoryStore::new(self.config_path.clone(), None);
        let result = syncx_api::fsops::rollback_folder(
            &folder,
            &self.config_dir,
            &history,
            target_ts,
            dry_run,
            syncx_api::auth::now_ms(),
        )
        .map_err(OpError::Failed)?;
        if !dry_run {
            let _ = self.actor.send(Cmd::Scan);
        }
        Ok(result)
    }

    // ---- git(实现见 git.rs) ----
    fn git_changes(&self, folder_id: &str) -> OpResult<Value> {
        git::changes(self, folder_id)
    }
    fn git_diff(&self, folder_id: &str, path: &str) -> OpResult<Value> {
        git::diff(self, folder_id, path)
    }
    fn git_log(&self, folder_id: &str) -> OpResult<Value> {
        git::log(self, folder_id)
    }
    fn git_commit_files(&self, folder_id: &str, hash: &str) -> OpResult<Value> {
        git::commit_files(self, folder_id, hash)
    }
    fn git_commit_diff(
        &self,
        folder_id: &str,
        hash: &str,
        path: &str,
        orig_path: Option<&str>,
    ) -> OpResult<Value> {
        git::commit_diff(self, folder_id, hash, path, orig_path)
    }
    fn git_unpushed(&self, folder_id: Option<&str>) -> OpResult<Value> {
        git::unpushed(self, folder_id)
    }
    fn git_push(&self, folder_id: &str) -> OpResult<Value> {
        git::push(self, folder_id)
    }
    fn git_auto_commit_status(&self, folder_id: &str) -> OpResult<Value> {
        git::auto_commit_status(self, folder_id)
    }
    fn git_delete_index_lock(&self, folder_id: &str) -> OpResult<Value> {
        git::delete_index_lock(self, folder_id)
    }
    fn git_retry_auto_commit(&self, folder_id: &str) -> OpResult<Value> {
        git::retry_auto_commit(self, folder_id)
    }

    // ---- 分享 / 邀请的会话侧协同 ----

    fn after_folder_change(&self, folder_id: &str) {
        let config = self.store.load();
        let Some(folder) = config.folder(folder_id) else {
            return;
        };
        let folder_id = folder.folder_id();
        for device_id in folder.devices.clone() {
            let (version, hostname, platform) = self.self_info();
            let _ = self.send_to(
                &device_id,
                ControlMessage::FolderInvitation {
                    offer_id: offers::make_offer_id("folder", &device_id, Some(&folder_id)),
                    from_device_id: self.device_id.clone(),
                    folder_id: folder_id.clone(),
                    folder_name: folder_id.clone(),
                    version: Some(version),
                    hostname: hostname.clone(),
                    platform: platform.clone(),
                    runtime: Some(RUNTIME.to_string()),
                },
            );
            self.push_folder_sync_list(&device_id);
        }
    }

    fn after_device_trusted(&self, device_id: &str) {
        self.notify_pairing_intent(device_id);
    }

    fn reload_config(&self) {
        assembly::reload_actor(self);
        // 配置可能换了目录集合,台账要跟着重算:被移除目录的待投递项就此作废,
        // 新目录的 `gitLastCommitHash` 基线也要立刻生效(否则首轮会误判成新提交)。
        self.restore_git_ledgers(&self.store.load());
        self.notify_hub();
    }

    fn webhook_test(&self) -> OpResult<()> {
        let config = self.store.load();
        let url = config
            .webhook_url
            .clone()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| OpError::Failed("未配置 Webhook 地址".to_string()))?;
        let secret = config.webhook_secret.clone();
        send_webhook(&url, secret.as_deref(), "Webhook 测试消息").map_err(OpError::Failed)
    }

    fn open_terminal(&self) -> Option<syncx_api::deps::TerminalLink> {
        self.terminal.open()
    }
}

/// 在配置里找一条待确认项。找不到就是 `offer not found`
/// (与 Node 的 `findPendingOffer` + 抛错同口径)。
fn find_offer(store: &ConfigStore, offer_id: &str) -> Result<PendingOffer, OpError> {
    store
        .load()
        .pending_offers
        .into_iter()
        .find(|offer| offer.id == offer_id)
        .ok_or_else(|| OpError::Failed("offer not found".to_string()))
}

/// 用 npm 安装一个本地 tgz(自更新上传的 npm 包 / 对端互传安装包走同一条路)。
///
/// npm 载体的包用 npm 覆盖是最稳的一条:它同时更新 launcher 与 bin 链接。
/// 后端二进制包(rust/moonbit)不走这里,见 `update::install_backend_package`。
fn install_tarball(config_dir: &Path, tgz: &[u8], inspected: &update::UploadedInspect) -> OpResult<String> {
    let version = inspected.version.clone();
    let dir = config_dir.join("update");
    std::fs::create_dir_all(&dir).map_err(|e| OpError::Failed(e.to_string()))?;
    let path = dir.join(format!("{}.tgz", crate::invite::now_ms()));
    std::fs::write(&path, tgz).map_err(|e| OpError::Failed(e.to_string()))?;

    let mut command = std::process::Command::new("npm");
    command.args(["install", "-g", &path.display().to_string()]);
    #[cfg(windows)]
    {
        command = std::process::Command::new("cmd");
        command.args(["/C", "npm", "install", "-g", &path.display().to_string()]);
    }
    let status = command
        .status()
        .map_err(|error| OpError::Failed(format!("npm install -g 失败({error})")))?;
    if !status.success() {
        return Err(OpError::Failed(format!(
            "npm install -g 失败(退出码 {})",
            status.code().unwrap_or(1)
        )));
    }
    Ok(version)
}

/* ------------------------------ Webhook ------------------------------ */

/// 从本进程 argv 里抠 `--log-file` 的值(供升级看门狗重定向新进程输出)。
fn daemon_log_file_from_argv() -> Option<PathBuf> {
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--log-file" {
            return args.next().map(PathBuf::from);
        }
    }
    None
}

fn is_feishu(url: &reqwest::Url) -> bool {
    let host = url.host_str().unwrap_or("");
    if host.ends_with("feishu.cn") || host.ends_with("larksuite.com") {
        return true;
    }
    url.path().contains("/bot/v2/hook/")
}

/// 发一条测试消息。签名算法与 Node `src/webhook.ts` 逐字一致 ——
/// 两端都必须能通过同一个机器人校验,算法漂了表现为「只有 Node 发的能过」。
pub fn send_webhook(url: &str, secret: Option<&str>, message: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|error| format!("Webhook 地址非法:{error}"))?;
    let now = crate::invite::now_ms();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|error| error.to_string())?;

    let request = if is_feishu(&parsed) {
        let mut payload = json!({
            "msg_type": "text",
            "content": { "text": message },
        });
        if let Some(secret) = secret.filter(|value| !value.is_empty()) {
            let timestamp = now / 1000;
            let key = format!("{timestamp}\n{secret}");
            let sign =
                base64::engine::general_purpose::STANDARD.encode(hmac_sha256(key.as_bytes(), b""));
            payload["timestamp"] = json!(timestamp);
            payload["sign"] = json!(sign);
        }
        client.post(parsed).json(&payload)
    } else {
        let body = json!({ "kind": "test", "ts": now, "message": message }).to_string();
        let mut request = client
            .post(parsed)
            .header("content-type", "application/json")
            .header("x-syncx-timestamp", now.to_string());
        if let Some(secret) = secret.filter(|value| !value.is_empty()) {
            let signature = hex::encode(hmac_sha256(
                secret.as_bytes(),
                format!("{now}.{body}").as_bytes(),
            ));
            request = request.header("x-syncx-signature", signature);
        }
        request.body(body)
    };

    let response =
        update::bridge(async move { request.send().await.map_err(|error| error.to_string()) })?;
    if !response.status().is_success() {
        return Err(format!("Webhook 返回 {}", response.status().as_u16()));
    }
    Ok(())
}

/// HMAC-SHA256(RFC 2104)。只用 `sha2`,不额外引入 `hmac` crate ——
/// 这里只需要一种摘要,HMAC 本身二十行;少一个依赖就少一处供应链面。
pub fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut normalized = [0u8; BLOCK];
    if key.len() > BLOCK {
        let digest = Sha256::digest(key);
        normalized[..digest.len()].copy_from_slice(&digest);
    } else {
        normalized[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    let mut outer = Sha256::new();
    inner.update(normalized.map(|byte| byte ^ 0x36));
    inner.update(message);
    outer.update(normalized.map(|byte| byte ^ 0x5c));
    outer.update(inner.finalize());
    let digest = outer.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

/// 供装配层判定「这一帧能不能收」:`version` 变化才打日志。
pub fn should_log_version_change(
    ops: &RuntimeOps,
    device_id: &str,
    version: Option<&str>,
    hostname: Option<&str>,
    platform: Option<&str>,
    runtime: Option<&str>,
) -> bool {
    ops.learn_peer_info(device_id, version, hostname, platform, runtime)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn notice(subjects: Option<Vec<&str>>) -> GitNotice {
        GitNotice {
            from_device_id: "devA".to_string(),
            commit_hash: "0123456789abcdef".to_string(),
            commit_message: "第三笔:收尾".to_string(),
            changed_files: vec!["src/a.rs".to_string()],
            diff_stat: Some("1 file changed".to_string()),
            commit_subjects: subjects.map(|list| list.into_iter().map(str::to_string).collect()),
            parent_hash: "fedcba9876543210".to_string(),
            via_device_id: None,
        }
    }

    #[test]
    fn mirror_message_appends_earlier_subjects_only() {
        // 正文已是最后一笔,前面几笔(旧→新)作为脉络附在后面;最后一笔不重复
        let msg = notice(Some(vec!["第一笔", "第二笔", "第三笔:收尾"]));
        assert_eq!(msg.mirror_message(), "第三笔:收尾\n\n第一笔\n第二笔");
    }

    #[test]
    fn mirror_message_falls_back_to_body() {
        // 单笔提交 / 无 subject 清单:保持原消息,不凭空多一个空行
        assert_eq!(notice(None).mirror_message(), "第三笔:收尾");
        assert_eq!(
            notice(Some(vec!["只有一笔"])).mirror_message(),
            "第三笔:收尾"
        );
        // 空白 subject 被过滤,过滤后为空同样回退
        assert_eq!(
            notice(Some(vec!["   ", "第三笔:收尾"])).mirror_message(),
            "第三笔:收尾"
        );
    }

    #[test]
    fn record_round_trips_through_config_shape() {
        let original = notice(Some(vec!["第一笔", "第三笔:收尾"]));
        let targets = vec!["devB".to_string(), "devC".to_string()];
        let record = original.to_record(&targets);

        // 落盘形状是 Node `toGitPendingRecord` 的 camelCase 契约,手改配置也靠它还原
        assert_eq!(record["fromDeviceId"], "devA");
        assert_eq!(record["commitHash"], "0123456789abcdef");
        assert_eq!(record["parentHash"], "fedcba9876543210");
        assert_eq!(record["targets"][1], "devC");

        let (restored, restored_targets) = GitNotice::from_record("f1", &record).unwrap();
        assert_eq!(restored_targets, targets);
        assert_eq!(restored.from_device_id, original.from_device_id);
        assert_eq!(restored.commit_message, original.commit_message);
        assert_eq!(restored.commit_subjects, original.commit_subjects);
        assert_eq!(restored.diff_stat, original.diff_stat);
        // 这一跳是本地信息,不落盘:重启后要按新会话重新认
        assert!(restored.via_device_id.is_none());
    }

    #[test]
    fn record_without_targets_is_not_restored() {
        // 名单空 / 关键字段缺失一律当作无 —— 宁可不补投,也不凭残缺记录外发
        let mut record = notice(None).to_record(&["devB".to_string()]);
        record["targets"] = serde_json::json!([]);
        assert!(GitNotice::from_record("f1", &record).is_none());

        let mut record = notice(None).to_record(&["devB".to_string()]);
        record.as_object_mut().unwrap().remove("fromDeviceId");
        assert!(GitNotice::from_record("f1", &record).is_none());
    }

    #[test]
    fn strip_removes_trailing_trailer_block() {
        // 最常见形态:正文 + 空行 + 尾注块。整块消失,连分隔空行一起,不留尾巴
        assert_eq!(
            strip_co_authored_lines("修复导航\n\nCo-authored-by: A <a@b>"),
            "修复导航"
        );
        assert_eq!(
            strip_co_authored_lines("修复导航\n\nCo-authored-by: A\nCo-authored-by: B"),
            "修复导航"
        );
    }

    #[test]
    fn strip_matches_case_variants_and_optional_dash() {
        // /co-?authored-by/i:大小写不敏感,连字符可有可无,且不限首行
        assert_eq!(
            strip_co_authored_lines("Fix\nCO-AUTHORED-BY: x"),
            "Fix"
        );
        assert_eq!(
            strip_co_authored_lines("Fix\nCo-Authored-By: x"),
            "Fix"
        );
        assert_eq!(
            strip_co_authored_lines("Fix\ncoauthored-by: x"),
            "Fix"
        );
        // 正文中间混进一行也剔除
        assert_eq!(
            strip_co_authored_lines("正文一\nnot a trailer\nco-authored-by: x\n正文二"),
            "正文一\nnot a trailer\n正文二"
        );
    }

    #[test]
    fn strip_without_trailer_is_byte_identical() {
        // 无命中行:原样返回,连异常的连续空行也不动
        assert_eq!(strip_co_authored_lines("只有一行"), "只有一行");
        assert_eq!(strip_co_authored_lines("A\n\nB"), "A\n\nB");
        assert_eq!(strip_co_authored_lines("A\n\n\nB"), "A\n\n\nB");
        assert_eq!(strip_co_authored_lines(""), "");
    }

    #[test]
    fn strip_never_leaves_blank_tail_or_double_blanks() {
        // 尾注后面本来就跟着的空行也一并砍掉:结尾绝不留空行
        assert_eq!(
            strip_co_authored_lines("Fix\n\nCo-authored-by: x\n\n\n"),
            "Fix"
        );
        // 尾注出现在正文中间:吞掉它前面的空档,前后正文各归各位,不出现连续空行
        assert_eq!(
            strip_co_authored_lines("Fix\n\nCo-authored-by: x\n\n第二段"),
            "Fix\n\n第二段"
        );
        // 整条消息只有尾注:剔干净就是空串(调用方会收到 git 的空消息报错,照实透出)
        assert_eq!(strip_co_authored_lines("Co-authored-by: x"), "");
    }

    #[test]
    fn mirror_message_then_strip_end_to_end() {
        // 多笔合并 + 正文自带尾注:先组装再清洗,subject 附行不受影响
        let mut msg = notice(Some(vec!["第一笔", "第三笔:收尾"]));
        msg.commit_message = "第三笔:收尾\n\nCo-Authored-By: Bot <bot@x>".to_string();
        assert_eq!(
            strip_co_authored_lines(&msg.mirror_message()),
            "第三笔:收尾\n\n第一笔"
        );
    }
}
