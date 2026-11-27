//! 设备间直发(ADR-0028)。
//!
//! 与 Node 的 `src/direct.ts` **逐条对齐语义**,不是「差不多」:两端要能互相投送,
//! 任何一处状态机偏差都会表现为「发出去了但对方永远不确认」。移植时逐段对照过:
//!
//!  - 文本即时落箱并回 `direct-result`;文件先提议、用户确认后才收字节;
//!  - 分片 256KB、在途窗口 4、5s 未确认重发、单片最多 3 次、30s 无进展硬超时;
//!  - 落后片先缓存(上限 32 片),只按 `next_seq` 顺序落盘,重复片只回 ack 不重写;
//!  - 收齐先关句柄再校验 sha256,通过才原子 rename 进收件箱;
//!  - 目标离线则入队(24h / 20 条 / 512MB),上线自动补发;
//!  - 链路断开时传过字节的传输转 `paused` 留半截,重连后接收方在 `direct-reply`
//!    里报 `offset`,发送方从对应片号接着发;
//!  - 进程重启后靠 `inbox/resume.json` 台账把半截认领回来(与 Node 同结构),
//!    出站重新提议、入站等对方重提议时直接回 offset。

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use syncx_net::wire::{ControlMessage, DIRECT_CHUNK_BYTES};

use super::ControlLink;

/* ============================ 常量(与 Node 同值) ============================ */

/// 在途窗口:4 片 ≈ 1MB。
const WINDOW: u64 = 4;
/// 文本上限(64KB UTF-8 字节,不是字符数)。
pub const MAX_TEXT_BYTES: usize = 64 * 1024;
/// 单文件上限 100MB:超过请走共享目录。
pub const MAX_FILE_BYTES: u64 = 100 * 1024 * 1024;
/// 收件箱软配额:超出后拒绝新入站,避免把 daemon 数据目录撑爆。
const INBOX_QUOTA_BYTES: u64 = 512 * 1024 * 1024;
const OFFER_TIMEOUT_MS: i64 = 120_000;
const RETRY_MS: i64 = 5_000;
const MAX_RETRIES: u32 = 3;
const STALL_TIMEOUT_MS: i64 = 30_000;
const MAX_BUFFERED_CHUNKS: usize = 32;
const FINISHED_TTL_MS: i64 = 60_000;
const RESUME_TTL_MS: i64 = 600_000;
const QUEUE_TTL_MS: i64 = 24 * 3600 * 1000;
const MAX_QUEUED: usize = 20;
const QUEUE_MAX_BYTES: u64 = 512 * 1024 * 1024;
/// 排队项探测通道的间隔:会话事件与入队可能擦肩而过,定时器兜一层。
const QUEUE_PROBE_MS: i64 = 5_000;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn direct_id(prefix: &str) -> String {
    let mut bytes = [0u8; 8];
    rand::thread_rng().fill_bytes(&mut bytes);
    format!("{prefix}-{}", hex::encode(bytes))
}

/// 文件名只取 basename 并去掉控制字符;重名由落盘时加序号兜底。
fn safe_file_name(input: &str) -> String {
    let base = input.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .map(|c| {
            if (c as u32) < 0x20 || c as u32 == 0x7f {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim();
    let name = if trimmed.is_empty() {
        "未命名文件"
    } else {
        trimmed
    };
    // 180 字符截断:与 Node 的 slice(0,180) 同口径(这里按字符而非字节)
    name.chars().take(180).collect()
}

fn is_safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}

/* ============================ 状态 ============================ */

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OutState {
    Queued,
    Offering,
    Transferring,
    Paused,
    Done,
    Canceled,
    Failed,
}

impl OutState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Offering => "offering",
            Self::Transferring => "transferring",
            Self::Paused => "paused",
            Self::Done => "done",
            Self::Canceled => "canceled",
            Self::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InState {
    Pending,
    Transferring,
    Paused,
}

struct Inflight {
    data: Vec<u8>,
    sent_at: i64,
    attempts: u32,
}

struct Outgoing {
    id: String,
    device_id: String,
    /// `true` = 文本消息,`false` = 文件。
    is_text: bool,
    name: Option<String>,
    size: u64,
    sha256: Option<String>,
    source_path: Option<PathBuf>,
    /// 排队时保留正文:入队到补发之间可能跨 daemon 重启。
    text: Option<String>,
    batch_id: Option<String>,
    state: OutState,
    error: Option<String>,
    bytes_done: u64,
    acked: u64,
    next_seq: u64,
    total_chunks: Option<u64>,
    inflight: BTreeMap<u64, Inflight>,
    last_progress_at: i64,
    created_at: i64,
    offer_sent_at: i64,
    paused_at: Option<i64>,
    resuming: bool,
    queued_at: Option<i64>,
    finished_at: Option<i64>,
    file: Option<File>,
}

struct Incoming {
    id: String,
    from: String,
    name: String,
    size: u64,
    sha256: String,
    created_at: i64,
    batch_id: Option<String>,
    tmp_path: PathBuf,
    save_dir: Option<PathBuf>,
    state: InState,
    paused_at: Option<i64>,
    file: Option<File>,
    hasher: Option<Sha256>,
    next_seq: u64,
    total_chunks: u64,
    bytes_done: u64,
    received: HashSet<u64>,
    buffered: BTreeMap<u64, Vec<u8>>,
    last_progress_at: i64,
}

/// 收件箱条目,字段名与 Node 的 `index.json` 逐字对齐(两个后端共用数据目录)。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Item {
    kind: String,
    id: String,
    from: String,
    created_at: i64,
    size: u64,
    path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    preview: Option<String>,
    /// `true` = 另存到用户目录:删回执不能删真实文件。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    external: Option<bool>,
}

/// 排队台账(与 Node 的 `queue.json` 同结构,便于换后端后接着投)。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueuedRecord {
    id: String,
    device_id: String,
    kind: String,
    #[serde(default)]
    name: Option<String>,
    size: u64,
    created_at: i64,
    queued_at: i64,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    source_path: Option<String>,
    #[serde(default)]
    sha256: Option<String>,
    #[serde(default)]
    batch_id: Option<String>,
}

/// 跨重启续传台账(与 Node 的 `inbox/resume.json` 同结构、同键序)。
///
/// 两侧后端可能先后接管同一个数据目录,键名必须逐字对齐,否则换后端就丢半截。
#[derive(Debug, Serialize, Deserialize)]
struct ResumeFile {
    v: u32,
    #[serde(default)]
    outgoing: Vec<ResumeOut>,
    #[serde(default)]
    incoming: Vec<ResumeIn>,
}

/// 出站:暂存文件与「对端确认过的字节」都在盘上,重启后重新提议接着发。
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResumeOut {
    id: String,
    device_id: String,
    name: String,
    size: u64,
    sha256: String,
    source_path: String,
    created_at: i64,
    bytes_done: u64,
    paused_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    batch_id: Option<String>,
}

/// 入站:半截文件固定叫 `.tmp/in-<id>`,不必存路径。
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResumeIn {
    id: String,
    from: String,
    name: String,
    size: u64,
    sha256: String,
    created_at: i64,
    bytes_done: u64,
    paused_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    save_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    batch_id: Option<String>,
}

struct State {
    outgoing: HashMap<String, Outgoing>,
    incoming: HashMap<String, Incoming>,
    items: Vec<Item>,
    /// 群发共用一份暂存文件:只有最后一笔结束时才能删。
    source_refs: HashMap<PathBuf, usize>,
    /// 每条投送最近一次用的通道(ack 回来时接着 pump)。
    out_link: HashMap<String, ControlLink>,
    /// 每台设备最近一次用的通道(确认提议时要回 `direct-reply`)。
    device_link: HashMap<String, ControlLink>,
    /// 每个设备最近一次探测排队通道的时间。
    queued_probe_at: HashMap<String, i64>,
    closing: bool,
}

type GetLink = Arc<dyn Fn(&str) -> Option<ControlLink> + Send + Sync>;
type OnChange = Arc<dyn Fn() + Send + Sync>;

pub struct DirectService {
    root: PathBuf,
    messages_dir: PathBuf,
    files_dir: PathBuf,
    tmp_dir: PathBuf,
    state: Mutex<State>,
    get_link: GetLink,
    on_change: OnChange,
}

impl DirectService {
    pub fn new(config_dir: &Path, get_link: GetLink, on_change: OnChange) -> Arc<Self> {
        let root = config_dir.join("inbox");
        let messages_dir = root.join("messages");
        let files_dir = root.join("files");
        let tmp_dir = root.join(".tmp");
        for dir in [&root, &messages_dir, &files_dir, &tmp_dir] {
            let _ = fs::create_dir_all(dir);
        }
        let items = read_index(&root.join("index.json"));
        let service = Arc::new(Self {
            root,
            messages_dir,
            files_dir,
            tmp_dir,
            state: Mutex::new(State {
                outgoing: HashMap::new(),
                incoming: HashMap::new(),
                items,
                source_refs: HashMap::new(),
                out_link: HashMap::new(),
                device_link: HashMap::new(),
                queued_probe_at: HashMap::new(),
                closing: false,
            }),
            get_link,
            on_change,
        });
        service.load_queue();
        service.load_resume();
        service
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        // 锁中毒说明某次 panic 发生在本模块内;继续用旧状态比整个 daemon 挂掉好
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn notify(&self) {
        if self.lock().closing {
            return;
        }
        (self.on_change)();
    }

    /* ---------------------------- 持久化 ---------------------------- */

    fn save_index(state: &State, root: &Path) {
        let path = root.join("index.json");
        let Ok(text) = serde_json::to_string_pretty(&state.items) else {
            return;
        };
        atomic_write(&path, text.as_bytes());
    }

    fn save_queue(&self) {
        let state = self.lock();
        let records: Vec<QueuedRecord> = state
            .outgoing
            .values()
            .filter(|o| o.state == OutState::Queued)
            .map(|o| QueuedRecord {
                id: o.id.clone(),
                device_id: o.device_id.clone(),
                kind: if o.is_text {
                    "text".into()
                } else {
                    "file".into()
                },
                name: o.name.clone(),
                size: o.size,
                created_at: o.created_at,
                queued_at: o.queued_at.unwrap_or(o.created_at),
                text: o.text.clone(),
                source_path: o
                    .source_path
                    .as_ref()
                    .map(|p| p.to_string_lossy().to_string()),
                sha256: o.sha256.clone(),
                batch_id: o.batch_id.clone(),
            })
            .collect();
        let path = self.root.join("queue.json");
        if records.is_empty() {
            let _ = fs::remove_file(&path);
            return;
        }
        if let Ok(text) = serde_json::to_string_pretty(&records) {
            atomic_write(&path, text.as_bytes());
        }
    }

    /// 恢复上次没来得及投出去的离线队列。到期的直接丢掉(24 小时窗口照算)。
    fn load_queue(&self) {
        let path = self.root.join("queue.json");
        let Ok(text) = fs::read_to_string(&path) else {
            return;
        };
        let Ok(records) = serde_json::from_str::<Vec<QueuedRecord>>(&text) else {
            return;
        };
        let now = now_ms();
        let mut state = self.lock();
        for rec in records {
            if !is_safe_id(&rec.id) || now - rec.queued_at > QUEUE_TTL_MS {
                continue;
            }
            // 文件暂存已经没了(被手工清过):这条没法再投,直接跳过。
            let source_path = rec.source_path.as_ref().map(PathBuf::from);
            if !rec.kind.eq("text") {
                match &source_path {
                    Some(p) if p.exists() => {}
                    _ => continue,
                }
            }
            let out = Outgoing {
                id: rec.id.clone(),
                device_id: rec.device_id.clone(),
                is_text: rec.kind == "text",
                name: rec.name.clone(),
                size: rec.size,
                sha256: rec.sha256.clone(),
                source_path: source_path.clone(),
                text: rec.text.clone(),
                batch_id: rec.batch_id.clone(),
                state: OutState::Queued,
                error: None,
                bytes_done: 0,
                acked: 0,
                next_seq: 0,
                total_chunks: if rec.kind == "text" {
                    None
                } else {
                    Some(rec.size.div_ceil(DIRECT_CHUNK_BYTES as u64))
                },
                inflight: BTreeMap::new(),
                last_progress_at: now,
                created_at: rec.created_at,
                offer_sent_at: now,
                paused_at: None,
                resuming: false,
                queued_at: Some(rec.queued_at),
                finished_at: None,
                file: None,
            };
            if let Some(p) = source_path {
                *state.source_refs.entry(p).or_insert(0) += 1;
            }
            state.outgoing.insert(rec.id, out);
        }
    }

    /// 把当前内存状态推导成续传台账(调用方必须已持有 `state` 锁)。
    ///
    /// 台账只在「有半截东西能接着传」时存在:没内容就删文件,免得留下一份空账让人
    /// 误会。每个改变状态的入口写完就调它 —— 镜像式维护迟早会漏一处。
    fn write_resume(root: &Path, state: &State) {
        let now = now_ms();
        let mut outgoing: Vec<ResumeOut> = Vec::new();
        for out in state.outgoing.values() {
            if out.is_text || out.queued_at.is_some() {
                continue;
            }
            let (Some(source), Some(sha), Some(name)) =
                (&out.source_path, &out.sha256, &out.name)
            else {
                continue;
            };
            // 传输中也要记:进程被 kill -9 时没有 close() 可走,只能靠这一笔。
            // 发送侧存的是「对端确认过的字节」,真正从哪儿续由接收方说了算。
            if out.state != OutState::Transferring
                && out.state != OutState::Paused
                && !out.resuming
            {
                continue;
            }
            outgoing.push(ResumeOut {
                id: out.id.clone(),
                device_id: out.device_id.clone(),
                name: name.clone(),
                size: out.size,
                sha256: sha.clone(),
                source_path: source.to_string_lossy().to_string(),
                created_at: out.created_at,
                bytes_done: out.bytes_done,
                // 传输中崩掉的没有 paused_at:用「写下这一笔的时刻」当锚点,
                // 续传窗口从「最后一次确认它还活着」算起,而不是用户点发送那一刻。
                paused_at: out.paused_at.unwrap_or(now),
                batch_id: out.batch_id.clone(),
            });
        }
        let mut incoming: Vec<ResumeIn> = Vec::new();
        for inc in state.incoming.values() {
            // 待确认的提议不记:它还要用户点头,重启后重新提议更干净。
            if inc.state == InState::Pending {
                continue;
            }
            incoming.push(ResumeIn {
                id: inc.id.clone(),
                from: inc.from.clone(),
                name: inc.name.clone(),
                size: inc.size,
                sha256: inc.sha256.clone(),
                created_at: inc.created_at,
                bytes_done: inc.bytes_done,
                paused_at: inc.paused_at.unwrap_or(now),
                save_dir: inc
                    .save_dir
                    .as_ref()
                    .map(|p| p.to_string_lossy().to_string()),
                batch_id: inc.batch_id.clone(),
            });
        }
        let path = root.join("resume.json");
        if outgoing.is_empty() && incoming.is_empty() {
            let _ = fs::remove_file(&path);
            return;
        }
        let file = ResumeFile {
            v: 1,
            outgoing,
            incoming,
        };
        let Ok(text) = serde_json::to_string_pretty(&file) else {
            return;
        };
        // 先写 .tmp 再 rename:进程恰好死在写台账中途时,下一次启动读到的是旧台账
        // (或什么都没有),而不是一份被截断的 JSON。
        let tmp = root.join("resume.json.tmp");
        if fs::write(&tmp, text.as_bytes()).is_ok() {
            let _ = fs::rename(&tmp, &path);
        }
    }

    /// 启动时恢复跨重启续传。四种情况直接丢弃(连同半截文件):
    ///  - 过了续传窗口(10 分钟)—— 半截已无意义,还占着收件箱配额;
    ///  - 出站暂存 / 入站半截文件不见了(被手工清过 `.tmp`);
    ///  - 入站半截不是整片对齐(落盘永远顺序整片写,对不齐说明被动过);
    ///  - 记录本身不合法(旧版本写的、或被改坏)。
    fn load_resume(&self) {
        let path = self.root.join("resume.json");
        let Ok(text) = fs::read_to_string(&path) else {
            return;
        };
        let Ok(records) = serde_json::from_str::<ResumeFile>(&text) else {
            return;
        };
        let now = now_ms();
        let mut state = self.lock();

        // 出站:先登记存活条目,再统一清理过期条目的暂存文件(群发会共用同一路径)。
        let mut dead_sources: Vec<PathBuf> = Vec::new();
        for r in records.outgoing {
            if !is_safe_id(&r.id) || !is_sha256(&r.sha256) || r.size == 0 {
                continue;
            }
            let source = PathBuf::from(&r.source_path);
            let fresh = now - r.paused_at <= RESUME_TTL_MS;
            if !(fresh && r.bytes_done < r.size && source.exists()) {
                dead_sources.push(source);
                continue;
            }
            let acked = r.bytes_done / DIRECT_CHUNK_BYTES as u64;
            let out = Outgoing {
                id: r.id.clone(),
                device_id: r.device_id,
                is_text: false,
                name: Some(r.name),
                size: r.size,
                sha256: Some(r.sha256),
                source_path: Some(source.clone()),
                text: None,
                batch_id: r.batch_id,
                state: OutState::Paused,
                error: None,
                bytes_done: r.bytes_done,
                acked,
                next_seq: acked,
                total_chunks: Some(r.size.div_ceil(DIRECT_CHUNK_BYTES as u64)),
                inflight: BTreeMap::new(),
                last_progress_at: now,
                created_at: r.created_at,
                // 一启动就允许重发提议:重启本身就是「刚断过线」,没必要再等。
                offer_sent_at: r.paused_at,
                paused_at: Some(r.paused_at),
                resuming: true,
                queued_at: None,
                finished_at: None,
                file: None,
            };
            *state.source_refs.entry(source).or_insert(0) += 1;
            state.outgoing.insert(r.id, out);
        }
        for path in dead_sources {
            // 还有存活条目在用它(群发暂存共用)就别删。
            if state.source_refs.contains_key(&path) {
                continue;
            }
            let _ = fs::remove_file(&path);
        }

        for r in records.incoming {
            if !is_safe_id(&r.id) || !is_sha256(&r.sha256) || r.size == 0 {
                continue;
            }
            let tmp_path = self.tmp_dir.join(format!("in-{}", r.id));
            let Ok(meta) = fs::metadata(&tmp_path) else {
                continue;
            };
            let on_disk = meta.len();
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            // 半截文件最后一次被写的时间才是「它还活着」的真实证据:台账里的 paused_at
            // 对「传到一半被硬杀」那一笔只到开始时刻,长传输会因此被误判过期。
            let fresh = now - r.paused_at.max(mtime) <= RESUME_TTL_MS;
            // 必须「整片且没满」:满了却没落盘说明崩在校验/rename 之间,重来更省事。
            let resumable =
                fresh && on_disk > 0 && on_disk % DIRECT_CHUNK_BYTES as u64 == 0 && on_disk < r.size;
            if !resumable {
                let _ = fs::remove_file(&tmp_path);
                continue;
            }
            state.incoming.insert(
                r.id.clone(),
                Incoming {
                    id: r.id,
                    from: r.from,
                    name: r.name,
                    size: r.size,
                    sha256: r.sha256,
                    created_at: r.created_at,
                    batch_id: r.batch_id,
                    tmp_path,
                    save_dir: r.save_dir.map(PathBuf::from),
                    state: InState::Paused,
                    paused_at: Some(r.paused_at),
                    file: None,
                    hasher: None,
                    next_seq: on_disk / DIRECT_CHUNK_BYTES as u64,
                    total_chunks: r.size.div_ceil(DIRECT_CHUNK_BYTES as u64),
                    bytes_done: on_disk,
                    received: HashSet::new(),
                    buffered: BTreeMap::new(),
                    last_progress_at: now,
                },
            );
        }
        // 丢弃过的条目不要留在文件里,否则下次启动又捞出来判一遍。
        Self::write_resume(&self.root, &state);
    }

    /* ---------------------------- 快照 ---------------------------- */

    /// 状态快照:形状与 Node 的 `DirectSnapshot` 完全一致,前端一套渲染逻辑。
    pub fn snapshot(&self) -> Value {
        let state = self.lock();
        let now = now_ms();
        let inbox: Vec<Value> = state
            .items
            .iter()
            .take(100)
            .map(|i| serde_json::to_value(i).unwrap_or(Value::Null))
            .collect();
        let pending: Vec<Value> = state
            .incoming
            .values()
            .filter(|i| i.state == InState::Pending)
            .map(|i| {
                let mut value = json!({
                    "id": i.id,
                    "from": i.from,
                    "name": i.name,
                    "size": i.size,
                    "sha256": i.sha256,
                    "createdAt": i.created_at,
                });
                if let Some(batch) = &i.batch_id {
                    value["batchId"] = json!(batch);
                }
                value
            })
            .collect();
        let mut transfers: Vec<Value> = Vec::new();
        for out in state.outgoing.values() {
            if let Some(finished) = out.finished_at {
                if now - finished >= FINISHED_TTL_MS {
                    continue;
                }
            }
            let mut value = json!({
                "id": out.id,
                "direction": "send",
                "deviceId": out.device_id,
                "kind": if out.is_text { "text" } else { "file" },
                "size": out.size,
                "bytesDone": out.bytes_done,
                "state": out.state.as_str(),
            });
            if let Some(name) = &out.name {
                value["name"] = json!(name);
            }
            if let Some(error) = &out.error {
                value["error"] = json!(error);
            }
            transfers.push(value);
        }
        for inc in state.incoming.values() {
            if inc.state == InState::Pending {
                continue;
            }
            transfers.push(json!({
                "id": inc.id,
                "direction": "receive",
                "deviceId": inc.from,
                "kind": "file",
                "name": inc.name,
                "size": inc.size,
                "bytesDone": inc.bytes_done,
                "state": if inc.state == InState::Paused { "paused" } else { "transferring" },
            }));
        }
        // `zip` 是**能力声明**:前端据此决定要不要显示「打包成一个压缩包」。
        // 三个后端各自报自己有没有,前端就不再按 runtime 猜。
        json!({ "inbox": inbox, "pending": pending, "transfers": transfers, "zip": true })
    }

    /// 取一条收件箱内容。文件返回原始字节,文本返回 UTF-8 字节。
    pub fn content(&self, id: &str) -> Option<(Value, Vec<u8>)> {
        let (meta, path) = {
            let state = self.lock();
            let item = state.items.iter().find(|i| i.id == id)?;
            (serde_json::to_value(item).ok()?, PathBuf::from(&item.path))
        };
        let data = fs::read(path).ok()?;
        Some((meta, data))
    }

    /// 删除一条收件箱记录(连同正文;不可逆)。另存到用户目录的只删回执。
    pub fn remove(&self, id: &str) -> bool {
        let removed = {
            let mut state = self.lock();
            let Some(index) = state.items.iter().position(|i| i.id == id) else {
                return false;
            };
            let item = state.items.remove(index);
            Self::save_index(&state, &self.root);
            item
        };
        if removed.kind == "file" && removed.external != Some(true) {
            let _ = fs::remove_file(&removed.path);
        }
        self.notify();
        true
    }

    /* ---------------------------- 发送 ---------------------------- */

    fn new_outgoing(&self, mut out: Outgoing, queued: bool) -> String {
        let now = now_ms();
        out.state = if queued {
            OutState::Queued
        } else {
            OutState::Offering
        };
        out.created_at = now;
        out.offer_sent_at = now;
        out.last_progress_at = now;
        if queued {
            out.queued_at = Some(now);
        }
        let id = out.id.clone();
        {
            let mut state = self.lock();
            if let Some(path) = &out.source_path {
                *state.source_refs.entry(path.clone()).or_insert(0) += 1;
            }
            state.outgoing.insert(id.clone(), out);
            // 只保留最近 30 条:排队项不能被顺手挤掉,那是用户明确交代要等的。
            if state.outgoing.len() > 30 {
                let oldest = state
                    .outgoing
                    .values()
                    .filter(|o| o.state != OutState::Queued)
                    .min_by_key(|o| o.created_at)
                    .map(|o| o.id.clone());
                if let Some(id) = oldest {
                    if let Some(victim) = state.outgoing.remove(&id) {
                        Self::release_source(&mut state, &victim);
                        state.out_link.remove(&id);
                    }
                }
            }
            Self::write_resume(&self.root, &state);
        }
        if queued {
            self.save_queue();
        }
        self.notify();
        id
    }

    fn release_source(state: &mut State, out: &Outgoing) {
        let Some(path) = &out.source_path else {
            return;
        };
        let left = state
            .source_refs
            .get(path)
            .copied()
            .unwrap_or(1)
            .saturating_sub(1);
        if left > 0 {
            state.source_refs.insert(path.clone(), left);
            return;
        }
        state.source_refs.remove(path);
        let _ = fs::remove_file(path);
    }

    fn check_queue_room(state: &State, extra: u64) -> Result<(), String> {
        let queued: Vec<&Outgoing> = state
            .outgoing
            .values()
            .filter(|o| o.state == OutState::Queued)
            .collect();
        if queued.len() >= MAX_QUEUED {
            return Err(format!(
                "离线排队已满({MAX_QUEUED} 条),请等设备上线或先取消一些"
            ));
        }
        let bytes: u64 = queued
            .iter()
            .map(|o| if o.is_text { 0 } else { o.size })
            .sum();
        if bytes + extra > QUEUE_MAX_BYTES {
            return Err("离线排队的文件总量已满(512 MB),请等设备上线或先取消一些".into());
        }
        Ok(())
    }

    /// 发起文本直发。`link` 为 `None` 表示目标离线 → 入队,上线后自动补发。
    pub fn send_text(
        &self,
        device_id: &str,
        text: &str,
        link: Option<ControlLink>,
    ) -> Result<(String, bool), String> {
        let len = text.len();
        if len == 0 || len > MAX_TEXT_BYTES {
            return Err(format!("文本长度必须在 1 ~ {MAX_TEXT_BYTES} 字节之间"));
        }
        let queued = link.is_none();
        if queued {
            let state = self.lock();
            Self::check_queue_room(&state, 0)?;
        }
        let id = direct_id("dt");
        let out = Outgoing {
            id: id.clone(),
            device_id: device_id.to_string(),
            is_text: true,
            name: None,
            size: len as u64,
            sha256: None,
            source_path: None,
            text: if queued { Some(text.to_string()) } else { None },
            batch_id: None,
            state: OutState::Offering,
            error: None,
            bytes_done: 0,
            acked: 0,
            next_seq: 0,
            total_chunks: None,
            inflight: BTreeMap::new(),
            last_progress_at: 0,
            created_at: 0,
            offer_sent_at: 0,
            paused_at: None,
            resuming: false,
            queued_at: None,
            finished_at: None,
            file: None,
        };
        self.new_outgoing(out, queued);
        if let Some(link) = link {
            let ok = send_control(
                &link,
                ControlMessage::DirectText {
                    id: id.clone(),
                    from_device_id: String::new(),
                    text: text.to_string(),
                    created_at: now_ms(),
                    version: None,
                    hostname: None,
                    platform: None,
                    runtime: None,
                },
            );
            if !ok {
                // 控制帧没出去 = 会话刚断:退回队列,别让用户以为已经发了。
                let mut state = self.lock();
                if let Some(out) = state.outgoing.get_mut(&id) {
                    out.state = OutState::Queued;
                    out.queued_at = Some(now_ms());
                    out.text = Some(text.to_string());
                }
                drop(state);
                self.save_queue();
                self.notify();
                return Ok((id, true));
            }
            self.lock().out_link.insert(id.clone(), link);
        }
        Ok((id, queued))
    }

    /// 发起文件直发。`source_path` 是已落在**非共享暂存区**的完整文件。
    ///
    /// 参数多是有意的:每一个都对应 Node 侧 `sendFile` 的一个入参,合成结构体只会让
    /// 「哪个字段该由谁算」变模糊(指纹由路由算、批次由弹窗给)。
    #[allow(clippy::too_many_arguments)]
    pub fn send_file(
        &self,
        device_id: &str,
        name: &str,
        source_path: &Path,
        size: u64,
        sha256: &str,
        batch_id: Option<&str>,
        link: Option<ControlLink>,
    ) -> Result<(String, bool), String> {
        if size == 0 || size > MAX_FILE_BYTES {
            return Err(format!("文件大小必须在 1 ~ {MAX_FILE_BYTES} 字节之间"));
        }
        if !is_sha256(sha256) {
            return Err("文件指纹格式不正确".into());
        }
        let queued = link.is_none();
        if queued {
            let state = self.lock();
            Self::check_queue_room(&state, size)?;
        }
        let id = direct_id("df");
        let safe_name = safe_file_name(name);
        let batch = batch_id.filter(|b| is_safe_id(b)).map(|b| b.to_string());
        let out = Outgoing {
            id: id.clone(),
            device_id: device_id.to_string(),
            is_text: false,
            name: Some(safe_name.clone()),
            size,
            sha256: Some(sha256.to_string()),
            source_path: Some(source_path.to_path_buf()),
            text: None,
            batch_id: batch.clone(),
            state: OutState::Offering,
            error: None,
            bytes_done: 0,
            acked: 0,
            next_seq: 0,
            total_chunks: Some(size.div_ceil(DIRECT_CHUNK_BYTES as u64)),
            inflight: BTreeMap::new(),
            last_progress_at: 0,
            created_at: 0,
            offer_sent_at: 0,
            paused_at: None,
            resuming: false,
            queued_at: None,
            finished_at: None,
            file: None,
        };
        self.new_outgoing(out, queued);
        if let Some(link) = link {
            let offer = ControlMessage::DirectFileOffer {
                id: id.clone(),
                from_device_id: String::new(),
                name: safe_name,
                size,
                sha256: sha256.to_string(),
                created_at: now_ms(),
                batch_id: batch,
                version: None,
                hostname: None,
                platform: None,
                runtime: None,
            };
            if !send_control(&link, offer) {
                let mut state = self.lock();
                if let Some(out) = state.outgoing.get_mut(&id) {
                    out.state = OutState::Queued;
                    out.queued_at = Some(now_ms());
                }
                drop(state);
                self.save_queue();
                self.notify();
                return Ok((id, true));
            }
            self.lock().out_link.insert(id.clone(), link);
        }
        Ok((id, queued))
    }

    /* ---------------------------- 出站状态机 ---------------------------- */

    fn finish_outgoing(&self, id: &str, ok: bool, error: Option<String>) {
        let mut state = self.lock();
        let now = now_ms();
        let Some(out) = state.outgoing.get_mut(id) else {
            return;
        };
        out.file = None;
        out.state = if ok { OutState::Done } else { OutState::Failed };
        out.error = if ok {
            None
        } else {
            Some(error.unwrap_or_else(|| "传输失败".into()))
        };
        out.finished_at = Some(now);
        // 释放暂存文件:群发时只有最后一笔才真正删。
        let path = out.source_path.take();
        if let Some(path) = path {
            let left = state
                .source_refs
                .get(&path)
                .copied()
                .unwrap_or(1)
                .saturating_sub(1);
            if left > 0 {
                state.source_refs.insert(path, left);
            } else {
                state.source_refs.remove(&path);
                let _ = fs::remove_file(&path);
            }
        }
        Self::write_resume(&self.root, &state);
        drop(state);
        self.save_queue();
        self.notify();
    }

    fn cancel_outgoing(&self, id: &str, error: &str) {
        let mut state = self.lock();
        let path = {
            let Some(out) = state.outgoing.get_mut(id) else {
                return;
            };
            out.file = None;
            out.state = OutState::Failed;
            out.error = Some(error.to_string());
            out.finished_at = Some(now_ms());
            // 借用到此为止:下面的 source_refs 与 out_link 是 state 的另一半。
            out.source_path.take()
        };
        let link = state.out_link.get(id).cloned();
        if let Some(path) = path {
            let left = state
                .source_refs
                .get(&path)
                .copied()
                .unwrap_or(1)
                .saturating_sub(1);
            if left > 0 {
                state.source_refs.insert(path, left);
            } else {
                state.source_refs.remove(&path);
                let _ = fs::remove_file(&path);
            }
        }
        Self::write_resume(&self.root, &state);
        drop(state);
        if let Some(link) = link {
            send_control(
                &link,
                ControlMessage::DirectCancel {
                    id: id.to_string(),
                    from_device_id: String::new(),
                    reason: error.to_string(),
                    version: None,
                    hostname: None,
                    platform: None,
                    runtime: None,
                },
            );
        }
        self.save_queue();
        self.notify();
    }

    /// 暂停出站:关句柄、留暂存文件与已确认片号,等重连后重新提议。
    fn pause_outgoing(&self, id: &str) {
        let mut state = self.lock();
        let Some(out) = state.outgoing.get_mut(id) else {
            return;
        };
        out.file = None;
        out.inflight.clear();
        out.state = OutState::Paused;
        out.resuming = true;
        out.paused_at = Some(now_ms());
        out.error = None;
        Self::write_resume(&self.root, &state);
        drop(state);
        self.notify();
    }

    /// 把在途窗口里的分片推出去。返回 `false` 表示会话断了。
    fn pump(&self, id: &str) -> bool {
        let (chunks, broken) = {
            let mut state = self.lock();
            let Some(out) = state.outgoing.get_mut(id) else {
                return true;
            };
            if out.state != OutState::Transferring {
                return true;
            }
            let Some(total) = out.total_chunks else {
                return true;
            };
            let mut queued: Vec<(u64, Vec<u8>)> = Vec::new();
            let mut error: Option<String> = None;
            while out.next_seq < total && out.next_seq - out.acked < WINDOW {
                let seq = out.next_seq;
                match read_chunk(&mut out.file, seq) {
                    Ok(Some(data)) => {
                        out.next_seq += 1;
                        out.inflight.insert(
                            seq,
                            Inflight {
                                data: data.clone(),
                                sent_at: now_ms(),
                                attempts: 1,
                            },
                        );
                        queued.push((seq, data));
                    }
                    Ok(None) => {
                        error = Some("待发文件在传输中被改动,已中止".into());
                        break;
                    }
                    Err(e) => {
                        error = Some(format!("读取待发文件失败:{e}"));
                        break;
                    }
                }
            }
            if let Some(error) = error {
                (Vec::new(), Some(error))
            } else {
                (queued, None)
            }
        };
        if let Some(error) = broken {
            self.cancel_outgoing(id, &error);
            return true;
        }
        let link = self.lock().out_link.get(id).cloned();
        let Some(link) = link else {
            return false;
        };
        for (seq, data) in chunks {
            if link
                .chunk
                .send(syncx_daemon::driver::DirectChunk {
                    id: id.to_string(),
                    seq,
                    data,
                })
                .is_err()
            {
                // 会话断了:有现取通道能力就走续传,否则快速失败。
                self.pause_outgoing(id);
                return false;
            }
        }
        true
    }

    /* ---------------------------- 入站 ---------------------------- */

    fn cleanup_incoming(&self, id: &str) {
        let mut state = self.lock();
        if let Some(inc) = state.incoming.remove(id) {
            let _ = fs::remove_file(&inc.tmp_path);
        }
        Self::write_resume(&self.root, &state);
        drop(state);
        self.notify();
    }

    /// 暂停入站:关句柄、留半截文件,等对方重连后从已落盘字节继续。
    fn pause_incoming(&self, id: &str) {
        let mut state = self.lock();
        if let Some(inc) = state.incoming.get_mut(id) {
            inc.file = None;
            inc.hasher = None;
            inc.buffered.clear();
            inc.received.clear();
            inc.state = InState::Paused;
            inc.paused_at = Some(now_ms());
        }
        Self::write_resume(&self.root, &state);
        drop(state);
        self.notify();
    }

    /// 对端重连后重新提议:本机已有同 id 的半截且内容一致 → 报 offset 接着传。
    fn resume_incoming(
        &self,
        id: &str,
        from: &str,
        sha256: &str,
        size: u64,
        link: &ControlLink,
    ) -> bool {
        let mut state = self.lock();
        let Some(inc) = state.incoming.get_mut(id) else {
            return false;
        };
        if inc.from != from || inc.sha256 != sha256 || inc.size != size {
            return false;
        }
        let offset = inc.bytes_done;
        if offset == 0 || offset % DIRECT_CHUNK_BYTES as u64 != 0 || offset >= inc.size {
            return false;
        }
        let Ok(file) = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&inc.tmp_path)
        else {
            return false;
        };
        let Ok(hasher) = rebuild_hash(&inc.tmp_path, offset) else {
            return false;
        };
        inc.file = Some(file);
        inc.hasher = Some(hasher);
        inc.next_seq = offset / DIRECT_CHUNK_BYTES as u64;
        inc.state = InState::Transferring;
        inc.paused_at = None;
        inc.last_progress_at = now_ms();
        // 已经接上了:从台账里撤掉,别让重启后的自己以为它还停在那儿。
        Self::write_resume(&self.root, &state);
        drop(state);
        send_control(
            link,
            ControlMessage::DirectReply {
                id: id.to_string(),
                from_device_id: String::new(),
                accept: true,
                reason: None,
                offset: Some(offset),
                version: None,
                hostname: None,
                platform: None,
                runtime: None,
            },
        );
        self.notify();
        true
    }

    /// 一个待确认提议的确认/拒绝。批量入口也走这里 —— 两条路径分叉过一次就难对齐。
    fn reply_one(
        &self,
        id: &str,
        accept: bool,
        link: &ControlLink,
        reason: Option<&str>,
        save_dir: Option<&Path>,
    ) -> bool {
        let mut state = self.lock();
        let Some(inc) = state.incoming.get_mut(id) else {
            return false;
        };
        if inc.state != InState::Pending {
            return false;
        }
        if !accept {
            let tmp = inc.tmp_path.clone();
            let from = inc.from.clone();
            let id = inc.id.clone();
            state.incoming.remove(&id);
            let _ = fs::remove_file(tmp);
            drop(state);
            send_control(
                link,
                ControlMessage::DirectReply {
                    id,
                    from_device_id: String::new(),
                    accept: false,
                    reason: Some(reason.unwrap_or("对方拒绝了接收").to_string()),
                    offset: None,
                    version: None,
                    hostname: None,
                    platform: None,
                    runtime: None,
                },
            );
            let _ = from;
            self.notify();
            return true;
        }
        // 只在真正开始接收时记下另存目录;拒绝路径完全不碰用户文件系统。
        inc.save_dir = save_dir.map(|p| p.to_path_buf());
        let tmp_path = inc.tmp_path.clone();
        match OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&tmp_path)
        {
            Ok(file) => {
                inc.file = Some(file);
                inc.hasher = Some(Sha256::new());
            }
            Err(e) => {
                let from = inc.from.clone();
                let id = inc.id.clone();
                state.incoming.remove(&id);
                let _ = fs::remove_file(&tmp_path);
                drop(state);
                let _ = from;
                send_control(
                    link,
                    ControlMessage::DirectResult {
                        id,
                        from_device_id: String::new(),
                        ok: false,
                        error: Some(format!("创建临时文件失败:{e}")),
                        version: None,
                        hostname: None,
                        platform: None,
                        runtime: None,
                    },
                );
                self.notify();
                return true;
            }
        }
        let id = inc.id.clone();
        inc.state = InState::Transferring;
        inc.last_progress_at = now_ms();
        Self::write_resume(&self.root, &state);
        drop(state);
        send_control(
            link,
            ControlMessage::DirectReply {
                id,
                from_device_id: String::new(),
                accept: true,
                reason: None,
                offset: None,
                version: None,
                hostname: None,
                platform: None,
                runtime: None,
            },
        );
        self.notify();
        true
    }

    /// 接收方确认 / 拒绝一个待确认文件;`save_dir` 给出时落到用户目录而非收件箱。
    pub fn reply(
        &self,
        id: &str,
        accept: bool,
        reason: Option<&str>,
        save_dir: Option<&Path>,
    ) -> bool {
        let link = {
            let state = self.lock();
            let Some(inc) = state.incoming.get(id) else {
                return false;
            };
            state.device_link.get(&inc.from).cloned()
        };
        let Some(link) = link else {
            return false;
        };
        self.reply_one(id, accept, &link, reason, save_dir)
    }

    /// 按 batchId 成组确认/拒绝:同一次多文件投送的几条提议一起处理,返回条数。
    pub fn reply_batch(
        &self,
        batch_id: &str,
        accept: bool,
        reason: Option<&str>,
        save_dir: Option<&Path>,
    ) -> usize {
        if !is_safe_id(batch_id) {
            return 0;
        }
        let (ids, link) =
            {
                let state = self.lock();
                let Some(first) = state.incoming.values().find(|i| {
                    i.batch_id.as_deref() == Some(batch_id) && i.state == InState::Pending
                }) else {
                    return 0;
                };
                let mut group: Vec<(i64, String)> = state
                    .incoming
                    .values()
                    .filter(|i| {
                        i.batch_id.as_deref() == Some(batch_id)
                            && i.state == InState::Pending
                            && i.from == first.from
                    })
                    .map(|i| (i.created_at, i.id.clone()))
                    .collect();
                group.sort();
                (
                    group.into_iter().map(|(_, id)| id).collect::<Vec<_>>(),
                    state.device_link.get(&first.from).cloned(),
                )
            };
        let Some(link) = link else {
            return 0;
        };
        ids.iter()
            .filter(|id| self.reply_one(id, accept, &link, reason, save_dir))
            .count()
    }

    /// 取消一条还在排队的投送(暂存文件一并回收);不是排队态返回 false。
    pub fn cancel_queued(&self, id: &str) -> bool {
        let mut state = self.lock();
        let Some(out) = state.outgoing.get_mut(id) else {
            return false;
        };
        if out.state != OutState::Queued {
            return false;
        }
        out.file = None;
        out.state = OutState::Canceled;
        out.error = None;
        out.finished_at = Some(now_ms());
        let path = out.source_path.take();
        if let Some(path) = path {
            let left = state
                .source_refs
                .get(&path)
                .copied()
                .unwrap_or(1)
                .saturating_sub(1);
            if left > 0 {
                state.source_refs.insert(path, left);
            } else {
                state.source_refs.remove(&path);
                let _ = fs::remove_file(&path);
            }
        }
        drop(state);
        self.save_queue();
        self.notify();
        true
    }

    /* ---------------------------- 接收分片 ---------------------------- */

    pub fn handle_chunk(&self, from: &str, id: &str, seq: u64, body: &[u8]) {
        if !is_safe_id(id) || body.is_empty() || body.len() > DIRECT_CHUNK_BYTES {
            return;
        }
        let link = {
            let state = self.lock();
            state.device_link.get(from).cloned()
        };
        let Some(link) = link else {
            return;
        };
        enum Step {
            Ignore,
            Ack(u64),
            Write,
        }
        let step = {
            let mut state = self.lock();
            let Some(inc) = state.incoming.get_mut(id) else {
                return;
            };
            if inc.from != from || inc.state != InState::Transferring || seq >= inc.total_chunks {
                return;
            }
            if seq * DIRECT_CHUNK_BYTES as u64 + body.len() as u64 > inc.size {
                return;
            }
            if seq < inc.next_seq {
                Step::Ack(inc.next_seq)
            } else if inc.received.contains(&seq) {
                Step::Ignore
            } else if seq > inc.next_seq {
                if inc.buffered.len() < MAX_BUFFERED_CHUNKS {
                    inc.buffered.insert(seq, body.to_vec());
                }
                Step::Ack(inc.next_seq)
            } else {
                inc.received.insert(seq);
                inc.buffered.insert(seq, body.to_vec());
                Step::Write
            }
        };
        match step {
            Step::Ignore => {}
            Step::Ack(expected) => {
                send_control(
                    &link,
                    ControlMessage::DirectAck {
                        id: id.to_string(),
                        from_device_id: String::new(),
                        seq: expected,
                        version: None,
                        hostname: None,
                        platform: None,
                        runtime: None,
                    },
                );
            }
            Step::Write => self.write_sequential(id, &link),
        }
    }

    fn write_sequential(&self, id: &str, link: &ControlLink) {
        let (finished, ack, error, item) = {
            let mut state = self.lock();
            let Some(inc) = state.incoming.get_mut(id) else {
                return;
            };
            let mut write_error: Option<String> = None;
            while let Some(chunk) = inc.buffered.get(&inc.next_seq).cloned() {
                inc.buffered.remove(&inc.next_seq);
                let Some(file) = inc.file.as_mut() else {
                    return;
                };
                if let Err(e) = file
                    .seek(SeekFrom::Start(inc.bytes_done))
                    .and_then(|_| file.write_all(&chunk))
                {
                    write_error = Some(format!("本机写入失败:{e}"));
                    break;
                }
                if let Some(hasher) = inc.hasher.as_mut() {
                    hasher.update(&chunk);
                }
                inc.bytes_done += chunk.len() as u64;
                inc.next_seq += 1;
                inc.last_progress_at = now_ms();
            }
            if let Some(error) = write_error {
                let from = inc.from.clone();
                let id = inc.id.clone();
                let tmp = inc.tmp_path.clone();
                state.incoming.remove(&id);
                let _ = fs::remove_file(tmp);
                (false, None, Some((from, id, error)), None)
            } else if inc.bytes_done != inc.size {
                (false, Some(inc.next_seq), None, None)
            } else {
                // 收齐:先关句柄再校验。哈希按落盘顺序算,与发送方对整份文件的指纹可比。
                inc.file = None;
                let actual = inc
                    .hasher
                    .take()
                    .map(|h| hex::encode(h.finalize()))
                    .unwrap_or_default();
                let expected = inc.sha256.clone();
                let tmp_path = inc.tmp_path.clone();
                let dir = inc
                    .save_dir
                    .clone()
                    .unwrap_or_else(|| self.files_dir.clone());
                let name = inc.name.clone();
                let external = inc.save_dir.is_some();
                let from = inc.from.clone();
                let item_id = inc.id.clone();
                let size = inc.size;
                let created_at = inc.created_at;
                state.incoming.remove(&item_id);
                if actual != expected {
                    let _ = fs::remove_file(&tmp_path);
                    (
                        false,
                        None,
                        Some((from, item_id, "文件校验失败(sha256 不一致)".to_string())),
                        None,
                    )
                } else {
                    match unique_file_path(&dir, &name) {
                        Ok(final_path) => match fs::rename(&tmp_path, &final_path) {
                            Ok(()) => {
                                let item = Item {
                                    kind: "file".into(),
                                    id: item_id.clone(),
                                    from: from.clone(),
                                    created_at,
                                    size,
                                    path: final_path.to_string_lossy().to_string(),
                                    name: Some(name),
                                    sha256: Some(expected),
                                    preview: None,
                                    external: if external { Some(true) } else { None },
                                };
                                state.items.insert(0, item.clone());
                                Self::save_index(&state, &self.root);
                                (true, None, None, Some((from, item_id, item)))
                            }
                            Err(e) => {
                                let _ = fs::remove_file(&tmp_path);
                                (
                                    false,
                                    None,
                                    Some((from, item_id, format!("落盘失败:{e}"))),
                                    None,
                                )
                            }
                        },
                        Err(e) => {
                            let _ = fs::remove_file(&tmp_path);
                            (
                                false,
                                None,
                                Some((from, item_id, format!("落盘失败:{e}"))),
                                None,
                            )
                        }
                    }
                }
            }
        };

        if let Some((from, id, error)) = error {
            let _ = from;
            send_control(
                link,
                ControlMessage::DirectResult {
                    id,
                    from_device_id: String::new(),
                    ok: false,
                    error: Some(error),
                    version: None,
                    hostname: None,
                    platform: None,
                    runtime: None,
                },
            );
            self.notify();
            return;
        }
        if let Some(seq) = ack {
            // 未收齐才回累积 ack:最后一片必须只回 direct-result,否则发送方会在
            // 同一个调用栈里继续 pump,而这里还没来得及 digest(重入会二次消费哈希)。
            send_control(
                link,
                ControlMessage::DirectAck {
                    id: id.to_string(),
                    from_device_id: String::new(),
                    seq,
                    version: None,
                    hostname: None,
                    platform: None,
                    runtime: None,
                },
            );
            self.notify();
            return;
        }
        if finished {
            if let Some((_from, item_id, item)) = item {
                tracing::info!(id = %item_id, name = %item.name.clone().unwrap_or_default(), "直发文件已落盘");
            }
            send_control(
                link,
                ControlMessage::DirectResult {
                    id: id.to_string(),
                    from_device_id: String::new(),
                    ok: true,
                    error: None,
                    version: None,
                    hostname: None,
                    platform: None,
                    runtime: None,
                },
            );
            self.notify();
        }
    }

    /* ---------------------------- 控制消息 ---------------------------- */

    pub fn handle_control(&self, link: &ControlLink, message: ControlMessage) {
        let from = link.device_id.clone();
        self.lock().device_link.insert(from.clone(), link.clone());
        match message {
            ControlMessage::DirectText { id, text, .. } => {
                if !is_safe_id(&id) || text.is_empty() || text.len() > MAX_TEXT_BYTES {
                    return;
                }
                {
                    let state = self.lock();
                    if state.outgoing.contains_key(&id) || state.incoming.contains_key(&id) {
                        return;
                    }
                }
                let item_id = direct_id("dt");
                let path = self.messages_dir.join(format!("{item_id}.txt"));
                if fs::write(&path, text.as_bytes()).is_err() {
                    return;
                }
                let preview: String = text.chars().take(120).collect();
                {
                    let mut state = self.lock();
                    state.items.insert(
                        0,
                        Item {
                            kind: "text".into(),
                            id: item_id,
                            from: from.clone(),
                            created_at: now_ms(),
                            size: text.len() as u64,
                            path: path.to_string_lossy().to_string(),
                            name: None,
                            sha256: None,
                            preview: Some(preview),
                            external: None,
                        },
                    );
                    Self::save_index(&state, &self.root);
                }
                send_control(
                    link,
                    ControlMessage::DirectResult {
                        // 回执关联的是**发送方给的消息 id**,不是本机条目 id
                        id,
                        from_device_id: String::new(),
                        ok: true,
                        error: None,
                        version: None,
                        hostname: None,
                        platform: None,
                        runtime: None,
                    },
                );
                self.notify();
            }
            ControlMessage::DirectFileOffer {
                id,
                name,
                size,
                sha256,
                created_at,
                batch_id,
                ..
            } => {
                if !is_safe_id(&id) {
                    return;
                }
                // 同一 id 又来一次 = 对端重连后重新提议:能接着传就静默继续。
                {
                    let state = self.lock();
                    if let Some(existing) = state.incoming.get(&id) {
                        if existing.state == InState::Paused {
                            drop(state);
                            if self.resume_incoming(&id, &from, &sha256, size, link) {
                                return;
                            }
                        } else {
                            return;
                        }
                    }
                }
                if size == 0 || size > MAX_FILE_BYTES || !is_sha256(&sha256) {
                    return;
                }
                let used: u64 = {
                    let state = self.lock();
                    state.items.iter().map(|i| i.size).sum()
                };
                if used + size > INBOX_QUOTA_BYTES {
                    send_control(
                        link,
                        ControlMessage::DirectResult {
                            id,
                            from_device_id: String::new(),
                            ok: false,
                            error: Some("本机收件箱空间不足".into()),
                            version: None,
                            hostname: None,
                            platform: None,
                            runtime: None,
                        },
                    );
                    return;
                }
                let safe_name = safe_file_name(&name);
                let batch = batch_id.filter(|b| is_safe_id(b));
                let tmp_path = self.tmp_dir.join(format!("in-{id}"));
                let inc = Incoming {
                    id: id.clone(),
                    from: from.clone(),
                    name: safe_name,
                    size,
                    sha256,
                    created_at: if created_at > 0 { created_at } else { now_ms() },
                    batch_id: batch,
                    tmp_path,
                    save_dir: None,
                    state: InState::Pending,
                    paused_at: None,
                    file: None,
                    hasher: None,
                    next_seq: 0,
                    total_chunks: size.div_ceil(DIRECT_CHUNK_BYTES as u64),
                    bytes_done: 0,
                    received: HashSet::new(),
                    buffered: BTreeMap::new(),
                    last_progress_at: now_ms(),
                };
                self.lock().incoming.insert(id, inc);
                self.notify();
            }
            ControlMessage::DirectReply {
                id,
                accept,
                reason,
                offset,
                ..
            } => {
                if !accept {
                    self.finish_outgoing(&id, false, reason);
                    return;
                }
                let mut state = self.lock();
                let Some(out) = state.outgoing.get_mut(&id) else {
                    return;
                };
                if out.device_id != from || out.state != OutState::Offering {
                    return;
                }
                let mut offset = offset.unwrap_or(0);
                if offset != 0 {
                    let usable = out.resuming
                        && offset > 0
                        && offset % DIRECT_CHUNK_BYTES as u64 == 0
                        && offset < out.size;
                    if !usable {
                        drop(state);
                        self.finish_outgoing(&id, false, Some("续传位置不合法".into()));
                        return;
                    }
                } else {
                    offset = 0;
                }
                let Some(source) = out.source_path.clone() else {
                    return;
                };
                match File::open(&source) {
                    Ok(file) => out.file = Some(file),
                    Err(e) => {
                        drop(state);
                        self.finish_outgoing(&id, false, Some(format!("打开待发文件失败:{e}")));
                        return;
                    }
                }
                out.acked = offset / DIRECT_CHUNK_BYTES as u64;
                out.next_seq = out.acked;
                out.bytes_done = offset;
                out.inflight.clear();
                out.state = OutState::Transferring;
                out.resuming = false;
                out.paused_at = None;
                out.last_progress_at = now_ms();
                Self::write_resume(&self.root, &state);
                drop(state);
                self.pump(&id);
            }
            ControlMessage::DirectAck { id, seq, .. } => {
                {
                    let mut state = self.lock();
                    let Some(out) = state.outgoing.get_mut(&id) else {
                        return;
                    };
                    if out.device_id != from || out.state != OutState::Transferring {
                        return;
                    }
                    let total = out.total_chunks.unwrap_or(0);
                    if seq <= out.acked || seq > total {
                        return;
                    }
                    out.acked = seq;
                    out.bytes_done = out.size.min(seq * DIRECT_CHUNK_BYTES as u64);
                    out.last_progress_at = now_ms();
                    let done: Vec<u64> =
                        out.inflight.keys().copied().filter(|s| *s < seq).collect();
                    for s in done {
                        out.inflight.remove(&s);
                    }
                }
                self.pump(&id);
            }
            ControlMessage::DirectResult { id, ok, error, .. } => {
                let owned = {
                    let state = self.lock();
                    state
                        .outgoing
                        .get(&id)
                        .filter(|o| o.device_id == from)
                        .map(|_| ())
                };
                if owned.is_some() {
                    self.finish_outgoing(&id, ok, error);
                }
            }
            ControlMessage::DirectCancel { id, reason, .. } => {
                {
                    let mut state = self.lock();
                    if let Some(inc) = state.incoming.get(&id) {
                        if inc.from == from {
                            let tmp = inc.tmp_path.clone();
                            state.incoming.remove(&id);
                            let _ = fs::remove_file(tmp);
                        }
                    }
                }
                {
                    let state = self.lock();
                    if let Some(out) = state.outgoing.get(&id) {
                        if out.device_id == from
                            && out.state != OutState::Done
                            && out.state != OutState::Failed
                        {
                            drop(state);
                            self.finish_outgoing(&id, false, Some(reason));
                            return;
                        }
                    }
                }
                self.notify();
            }
            _ => {}
        }
    }

    /* ---------------------------- 会话事件 ---------------------------- */

    /// 设备上线:先补发离线期间排下的内容,再把暂停中的投送重新提议一次。
    pub fn on_peer_online(&self, device_id: &str, link: &ControlLink) {
        self.flush_queued(device_id, link);
        self.reoffer_paused(device_id, link);
    }

    fn flush_queued(&self, device_id: &str, link: &ControlLink) {
        let now = now_ms();
        let ids: Vec<String> = {
            let state = self.lock();
            let mut batch: Vec<(i64, String)> = state
                .outgoing
                .values()
                .filter(|o| o.device_id == device_id && o.state == OutState::Queued)
                .map(|o| (o.created_at, o.id.clone()))
                .collect();
            batch.sort();
            batch.into_iter().map(|(_, id)| id).collect()
        };
        if ids.is_empty() {
            return;
        }
        for id in ids {
            // 先置状态再发:文本的 result 可能在同一调用栈里就回来(直接判 done),
            // 发完再改状态会把已完成覆盖回 offering。
            let (is_text, text, offer) = {
                let mut state = self.lock();
                let Some(out) = state.outgoing.get_mut(&id) else {
                    continue;
                };
                out.state = OutState::Offering;
                out.offer_sent_at = now;
                out.queued_at = None;
                if out.is_text {
                    (true, out.text.take(), None)
                } else {
                    (false, None, Some(offer_message(out)))
                }
            };
            self.lock().out_link.insert(id.clone(), link.clone());
            let sent = if is_text {
                send_control(
                    link,
                    ControlMessage::DirectText {
                        id: id.clone(),
                        from_device_id: String::new(),
                        text: text.clone().unwrap_or_default(),
                        created_at: now,
                        version: None,
                        hostname: None,
                        platform: None,
                        runtime: None,
                    },
                )
            } else {
                offer.map(|m| send_control(link, m)).unwrap_or(false)
            };
            if !sent {
                let mut state = self.lock();
                if let Some(out) = state.outgoing.get_mut(&id) {
                    out.state = OutState::Queued;
                    out.text = text;
                }
            }
        }
        self.save_queue();
        self.notify();
    }

    fn reoffer_paused(&self, device_id: &str, link: &ControlLink) {
        let now = now_ms();
        let offers: Vec<(String, ControlMessage)> = {
            let mut state = self.lock();
            let mut result = Vec::new();
            for out in state.outgoing.values_mut() {
                if out.device_id != device_id || !out.resuming {
                    continue;
                }
                // 刚发过的别抢跑:定时器与 onPeerOnline 可能同时到。
                if now - out.offer_sent_at < 1_000 && out.state == OutState::Offering {
                    continue;
                }
                out.state = OutState::Offering;
                out.offer_sent_at = now;
                result.push((out.id.clone(), offer_message(out)));
            }
            result
        };
        for (id, message) in offers {
            self.lock().out_link.insert(id, link.clone());
            send_control(link, message);
        }
        self.notify();
    }

    /// 连接掉线:在途入站转暂停(半截保留),出站转暂停等重连。
    pub fn on_peer_offline(&self, device_id: &str) {
        // 同一设备可能有多条连接:断掉的也许只是备份,其他传输仍活在另一条上。
        if (self.get_link)(device_id).is_some() {
            return;
        }
        let (pause_inc, drop_inc) = {
            let state = self.lock();
            let mut pause = Vec::new();
            let mut drop_ = Vec::new();
            for inc in state.incoming.values() {
                if inc.from != device_id {
                    continue;
                }
                if inc.state == InState::Transferring {
                    pause.push(inc.id.clone());
                } else {
                    drop_.push(inc.id.clone());
                }
            }
            (pause, drop_)
        };
        for id in pause_inc {
            self.pause_incoming(&id);
        }
        for id in drop_inc {
            self.cleanup_incoming(&id);
        }

        let (pause_out, fail_out) = {
            let state = self.lock();
            let mut pause = Vec::new();
            let mut fail = Vec::new();
            for out in state.outgoing.values() {
                if out.device_id != device_id {
                    continue;
                }
                if out.state == OutState::Done || out.state == OutState::Failed {
                    continue;
                }
                if out.resuming || out.state == OutState::Queued {
                    continue;
                }
                if out.state == OutState::Transferring {
                    pause.push(out.id.clone());
                } else {
                    fail.push(out.id.clone());
                }
            }
            (pause, fail)
        };
        for id in pause_out {
            self.pause_outgoing(&id);
        }
        for id in fail_out {
            self.cancel_outgoing(&id, "设备已离线");
        }
        {
            let mut state = self.lock();
            state.device_link.remove(device_id);
            state.out_link.retain(|_, link| link.device_id != device_id);
        }
    }

    /* ---------------------------- 定时巡检 ---------------------------- */

    /// 每秒一次:超时、重发、续传重提议、队列探测。与 Node 的 `setInterval(…, 1000)` 对应。
    pub fn tick(&self) {
        let now = now_ms();
        let mut resumed_devices: HashSet<String> = HashSet::new();

        let snapshot: Vec<String> = {
            let state = self.lock();
            state.outgoing.keys().cloned().collect()
        };
        for id in &snapshot {
            let action = {
                let state = self.lock();
                let Some(out) = state.outgoing.get(id) else {
                    continue;
                };
                if out.resuming {
                    if now - out.paused_at.unwrap_or(now) > RESUME_TTL_MS {
                        TickAction::Cancel("设备离线时间过长,已中止发送".into())
                    } else if out.state != OutState::Transferring
                        && !resumed_devices.contains(&out.device_id)
                        && now - out.offer_sent_at >= RETRY_MS
                    {
                        TickAction::Reoffer(out.device_id.clone())
                    } else {
                        TickAction::None
                    }
                } else if out.state == OutState::Offering
                    && now - out.offer_sent_at > OFFER_TIMEOUT_MS
                {
                    TickAction::Cancel("对方未在 2 分钟内确认".into())
                } else if out.state != OutState::Transferring {
                    TickAction::None
                } else if now - out.last_progress_at > STALL_TIMEOUT_MS {
                    TickAction::Cancel("对方长时间没有确认,已中止".into())
                } else {
                    let stale: Vec<(u64, u32)> = out
                        .inflight
                        .iter()
                        .filter(|(_, s)| now - s.sent_at >= RETRY_MS)
                        .map(|(seq, s)| (*seq, s.attempts))
                        .collect();
                    if let Some((seq, attempts)) = stale.first().copied() {
                        if attempts >= MAX_RETRIES {
                            TickAction::Cancel(format!(
                                "第 {} 片重试 {MAX_RETRIES} 次仍未确认",
                                seq + 1
                            ))
                        } else {
                            TickAction::Resend(stale)
                        }
                    } else {
                        TickAction::None
                    }
                }
            };
            match action {
                TickAction::None => {}
                TickAction::Cancel(reason) => self.cancel_outgoing(id, &reason),
                TickAction::Reoffer(device) => {
                    resumed_devices.insert(device.clone());
                    if let Some(link) = (self.get_link)(&device) {
                        self.reoffer_paused(&device, &link);
                    }
                }
                TickAction::Resend(stale) => {
                    let link = self.lock().out_link.get(id).cloned();
                    if let Some(link) = link {
                        for (seq, _) in stale {
                            let data = {
                                let mut state = self.lock();
                                match state.outgoing.get_mut(id) {
                                    Some(out) => match out.inflight.get_mut(&seq) {
                                        Some(slot) => {
                                            slot.attempts += 1;
                                            slot.sent_at = now;
                                            Some(slot.data.clone())
                                        }
                                        None => None,
                                    },
                                    None => None,
                                }
                            };
                            if let Some(data) = data {
                                let _ = link.chunk.send(syncx_daemon::driver::DirectChunk {
                                    id: id.clone(),
                                    seq,
                                    data,
                                });
                            }
                        }
                    }
                }
            }
        }

        // 入站:暂停超窗口 / 传着却没了进展,都要清掉半截。
        let incoming: Vec<(String, InState, i64, i64)> = {
            let state = self.lock();
            state
                .incoming
                .values()
                .map(|i| {
                    (
                        i.id.clone(),
                        i.state,
                        i.paused_at.unwrap_or(0),
                        i.last_progress_at,
                    )
                })
                .collect()
        };
        for (id, state_kind, paused_at, last_progress) in incoming {
            // 暂停超窗口、或者传着却没了进展(对端假死):两种都清掉半截,
            // 等对方重连后重新提议。
            let expired = (state_kind == InState::Paused && now - paused_at > RESUME_TTL_MS)
                || (state_kind == InState::Transferring
                    && now - last_progress > STALL_TIMEOUT_MS);
            if expired {
                self.cleanup_incoming(&id);
            }
        }

        // 终态记录留一会儿给 UI 看,过期收回,免得快照无限增长。
        {
            let mut state = self.lock();
            let expired: Vec<String> = state
                .outgoing
                .values()
                .filter(|o| o.finished_at.is_some_and(|t| now - t > FINISHED_TTL_MS))
                .map(|o| o.id.clone())
                .collect();
            for id in expired {
                state.outgoing.remove(&id);
                state.out_link.remove(&id);
            }
        }

        // 排队项:超窗口就放弃;否则定期探一次现取通道,兜住「会话建立早于入队」。
        let queued: Vec<(String, String, i64, i64)> = {
            let state = self.lock();
            state
                .outgoing
                .values()
                .filter(|o| o.state == OutState::Queued)
                .map(|o| {
                    (
                        o.id.clone(),
                        o.device_id.clone(),
                        o.queued_at.unwrap_or(o.created_at),
                        o.created_at,
                    )
                })
                .collect()
        };
        for (id, device, queued_at, created_at) in queued {
            if now - queued_at.min(created_at) > QUEUE_TTL_MS {
                self.cancel_outgoing(&id, "设备 24 小时内未上线,已取消发送");
                continue;
            }
            let probe = {
                let state = self.lock();
                state.queued_probe_at.get(&device).copied().unwrap_or(0)
            };
            if now - probe < QUEUE_PROBE_MS {
                continue;
            }
            self.lock().queued_probe_at.insert(device.clone(), now);
            if let Some(link) = (self.get_link)(&device) {
                self.flush_queued(&device, &link);
            }
        }
    }

    /// daemon 关闭:停止推送。传了一半的传输转暂停(半截留在盘上),其余照旧。
    pub fn close(&self) {
        let mut state = self.lock();
        state.closing = true;
        let keep: Vec<String> = state
            .incoming
            .values()
            .filter(|i| {
                i.bytes_done > 0 && (i.state == InState::Transferring || i.state == InState::Paused)
            })
            .map(|i| i.id.clone())
            .collect();
        let all: Vec<String> = state.incoming.keys().cloned().collect();
        for id in &all {
            if keep.contains(id) {
                if let Some(inc) = state.incoming.get_mut(id) {
                    inc.file = None;
                    inc.hasher = None;
                    inc.buffered.clear();
                    inc.state = InState::Paused;
                    inc.paused_at = Some(now_ms());
                }
            } else if let Some(inc) = state.incoming.remove(id) {
                let _ = fs::remove_file(&inc.tmp_path);
            }
        }
        let out_ids: Vec<String> = state.outgoing.keys().cloned().collect();
        for id in out_ids {
            let Some(out) = state.outgoing.get_mut(&id) else {
                continue;
            };
            out.file = None;
            if out.state == OutState::Queued {
                continue;
            }
            if !out.is_text
                && out.finished_at.is_none()
                && (out.resuming || out.state == OutState::Transferring)
            {
                out.state = OutState::Paused;
                out.resuming = true;
                out.paused_at = Some(now_ms());
                continue;
            }
            let path = out.source_path.take();
            if let Some(path) = path {
                let left = state
                    .source_refs
                    .get(&path)
                    .copied()
                    .unwrap_or(1)
                    .saturating_sub(1);
                if left > 0 {
                    state.source_refs.insert(path, left);
                } else {
                    state.source_refs.remove(&path);
                    let _ = fs::remove_file(&path);
                }
            }
        }
        // 台账要在清空通道台账之前写:它只读 outgoing/incoming,与通道无关,
        // 但把它放在这里能保证「关停前最后一份状态」一定落了盘。
        Self::write_resume(&self.root, &state);
        state.source_refs.clear();
        state.out_link.clear();
        state.device_link.clear();
    }
}

enum TickAction {
    None,
    Cancel(String),
    Reoffer(String),
    Resend(Vec<(u64, u32)>),
}

fn offer_message(out: &Outgoing) -> ControlMessage {
    ControlMessage::DirectFileOffer {
        id: out.id.clone(),
        from_device_id: String::new(),
        name: out.name.clone().unwrap_or_else(|| "未命名文件".into()),
        size: out.size,
        sha256: out.sha256.clone().unwrap_or_default(),
        created_at: out.created_at,
        batch_id: out.batch_id.clone(),
        version: None,
        hostname: None,
        platform: None,
        runtime: None,
    }
}

fn send_control(link: &ControlLink, message: ControlMessage) -> bool {
    link.outbound.send(message).is_ok()
}

/// 从 `seq` 位置读一片。文件被截短时返回 `Ok(None)`(调用方据此中止传输)。
fn read_chunk(file: &mut Option<File>, seq: u64) -> std::io::Result<Option<Vec<u8>>> {
    let Some(file) = file.as_mut() else {
        return Ok(None);
    };
    file.seek(SeekFrom::Start(seq * DIRECT_CHUNK_BYTES as u64))?;
    let mut buf = vec![0u8; DIRECT_CHUNK_BYTES];
    let mut filled = 0;
    while filled < buf.len() {
        let n = file.read(&mut buf[filled..])?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    if filled == 0 {
        return Ok(None);
    }
    buf.truncate(filled);
    Ok(Some(buf))
}

/// 只重算前 `bytes` 个字节的指纹:续传不重读整份文件,但必须与一次性哈希等价。
fn rebuild_hash(path: &Path, bytes: u64) -> std::io::Result<Sha256> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut left = bytes;
    let mut buf = vec![0u8; 1024 * 1024];
    while left > 0 {
        let want = (buf.len() as u64).min(left) as usize;
        let n = file.read(&mut buf[..want])?;
        if n == 0 {
            return Err(std::io::Error::other("半截文件读取失败"));
        }
        hasher.update(&buf[..n]);
        left -= n as u64;
    }
    Ok(hasher)
}

/// 收件箱或用户指定目录里的不覆盖落点:同名一律加 (n) 后缀。
fn unique_file_path(dir: &Path, name: &str) -> std::io::Result<PathBuf> {
    let safe = safe_file_name(name);
    let mut candidate = dir.join(&safe);
    let mut n = 1;
    while candidate.exists() {
        let (stem, ext) = match safe.rfind('.') {
            Some(dot) if dot > 0 => (&safe[..dot], &safe[dot..]),
            _ => (safe.as_str(), ""),
        };
        candidate = dir.join(format!("{stem} ({n}){ext}"));
        n += 1;
    }
    Ok(candidate)
}

fn atomic_write(path: &Path, bytes: &[u8]) {
    let tmp = path.with_extension("json.tmp");
    if fs::write(&tmp, bytes).is_ok() {
        let _ = fs::rename(&tmp, path);
    }
}

fn read_index(path: &Path) -> Vec<Item> {
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(items) = serde_json::from_str::<Vec<Item>>(&text) else {
        return Vec::new();
    };
    items
        .into_iter()
        .filter(|i| (i.kind == "text" || i.kind == "file") && is_safe_id(&i.id))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("syncx-direct-{tag}-{}", direct_id("t")));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn file_names_are_sanitized() {
        assert_eq!(safe_file_name("a/b/c.txt"), "c.txt");
        assert_eq!(safe_file_name("win\\path\\x.bin"), "x.bin");
        assert_eq!(safe_file_name("bad\u{1}name"), "bad_name");
        assert_eq!(safe_file_name("   "), "未命名文件");
        assert_eq!(safe_file_name(""), "未命名文件");
        assert!(safe_file_name(&"字".repeat(300)).chars().count() <= 180);
    }

    #[test]
    fn ids_and_digests_are_validated() {
        assert!(is_safe_id("df-1a2b3c"));
        assert!(!is_safe_id(""));
        assert!(!is_safe_id("a/b"));
        assert!(!is_safe_id(&"x".repeat(65)));
        assert!(is_sha256(&"a".repeat(64)));
        assert!(!is_sha256(&"A".repeat(64)), "大写不是 Node 的产出格式");
        assert!(!is_sha256(&"a".repeat(63)));
    }

    #[test]
    fn unique_path_never_overwrites() {
        let dir = temp_dir("unique");
        fs::write(dir.join("a.txt"), b"1").unwrap();
        let next = unique_file_path(&dir, "a.txt").unwrap();
        assert_eq!(next.file_name().unwrap(), "a (1).txt");
        fs::write(&next, b"2").unwrap();
        let third = unique_file_path(&dir, "a.txt").unwrap();
        assert_eq!(third.file_name().unwrap(), "a (2).txt");
        // 隐藏文件没有 stem 时不能产生 ". (1)" 这种怪名
        fs::write(dir.join(".env"), b"x").unwrap();
        let hidden = unique_file_path(&dir, ".env").unwrap();
        assert_eq!(hidden.file_name().unwrap(), ".env (1)");
    }

    #[test]
    fn text_roundtrip_lands_in_inbox() {
        let config = temp_dir("text");
        let service = DirectService::new(&config, Arc::new(|_| None), Arc::new(|| {}));
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let link = ControlLink {
            device_id: "B".into(),
            outbound: tx,
            chunk: tokio::sync::mpsc::unbounded_channel().0,
            caps: vec!["binary1".into(), "direct1".into()],
        };
        service.handle_control(
            &link,
            ControlMessage::DirectText {
                id: "dt-x".into(),
                from_device_id: String::new(),
                text: "你好".into(),
                created_at: 1,
                version: None,
                hostname: None,
                platform: None,
                runtime: None,
            },
        );
        let snapshot = service.snapshot();
        assert_eq!(snapshot["inbox"].as_array().unwrap().len(), 1);
        assert_eq!(snapshot["inbox"][0]["kind"], "text");
        assert_eq!(snapshot["inbox"][0]["size"], 6);
        let reply = rx.try_recv().expect("应回 direct-result");
        match reply {
            ControlMessage::DirectResult { id, ok, .. } => {
                assert_eq!(id, "dt-x");
                assert!(ok);
            }
            other => panic!("回成了 {other:?}"),
        }
    }

    /// 两个服务用内存通道对接:每条 link 载着「该方向」的出站通道,
    /// 转发线程把它交给对端处理。这样能跑完一条真实的提议→分片→ack→落盘链路。
    fn wire_pair(a: Arc<DirectService>, b: Arc<DirectService>) -> (ControlLink, ControlLink) {
        let (a_tx, mut a_rx) = tokio::sync::mpsc::unbounded_channel::<ControlMessage>();
        let (a_chunk_tx, mut a_chunk_rx) =
            tokio::sync::mpsc::unbounded_channel::<syncx_daemon::driver::DirectChunk>();
        let (b_tx, mut b_rx) = tokio::sync::mpsc::unbounded_channel::<ControlMessage>();
        let (b_chunk_tx, mut b_chunk_rx) =
            tokio::sync::mpsc::unbounded_channel::<syncx_daemon::driver::DirectChunk>();

        let to_b = ControlLink {
            device_id: "B".into(),
            outbound: b_tx.clone(),
            chunk: b_chunk_tx.clone(),
            caps: vec!["binary1".into(), "direct1".into()],
        };
        let to_a = ControlLink {
            device_id: "A".into(),
            outbound: a_tx.clone(),
            chunk: a_chunk_tx.clone(),
            caps: vec!["binary1".into(), "direct1".into()],
        };

        // B 收到的东西(由 A 发出)交给 B 处理;B 回消息要走 to_a。
        let b_service = Arc::clone(&b);
        let back_to_a = to_a.clone();
        std::thread::spawn(move || {
            while let Some(message) = b_rx.blocking_recv() {
                b_service.handle_control(&back_to_a, message);
            }
        });
        let b_service = Arc::clone(&b);
        let back_to_a = to_a.clone();
        std::thread::spawn(move || {
            while let Some(chunk) = b_chunk_rx.blocking_recv() {
                b_service.handle_chunk(&back_to_a.device_id, &chunk.id, chunk.seq, &chunk.data);
            }
        });
        // A 收到的东西(由 B 发出)交给 A 处理;A 回消息要走 to_b。
        let a_service = Arc::clone(&a);
        let back_to_b = to_b.clone();
        std::thread::spawn(move || {
            while let Some(message) = a_rx.blocking_recv() {
                a_service.handle_control(&back_to_b, message);
            }
        });
        let a_service = Arc::clone(&a);
        let back_to_b = to_b.clone();
        std::thread::spawn(move || {
            while let Some(chunk) = a_chunk_rx.blocking_recv() {
                a_service.handle_chunk(&back_to_b.device_id, &chunk.id, chunk.seq, &chunk.data);
            }
        });
        (to_b, to_a)
    }

    /// 多分片文件走完整链路:提议 → 确认 → 5 片(超过在途窗口)→ ack 推进 → 落盘。
    #[test]
    fn file_transfer_across_multiple_chunks() {
        let a_dir = temp_dir("xfer-a");
        let b_dir = temp_dir("xfer-b");
        let a = DirectService::new(&a_dir, Arc::new(|_| None), Arc::new(|| {}));
        let b = DirectService::new(&b_dir, Arc::new(|_| None), Arc::new(|| {}));
        let (to_b, _to_a) = wire_pair(Arc::clone(&a), Arc::clone(&b));

        let source = a_dir.join("payload.bin");
        // 1MB + 少量:正好跨 5 片,能覆盖「窗口 4 满了要等 ack」的分支
        let data: Vec<u8> = (0..(DIRECT_CHUNK_BYTES * 4 + 777))
            .map(|i| (i % 251) as u8)
            .collect();
        fs::write(&source, &data).unwrap();
        let digest = hex::encode(Sha256::digest(&data));

        let (id, queued) = a
            .send_file(
                "B",
                "payload.bin",
                &source,
                data.len() as u64,
                &digest,
                None,
                Some(to_b),
            )
            .expect("发起应成功");
        assert!(!queued);

        // B 侧进入待确认
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while b.snapshot()["pending"].as_array().map(Vec::len) != Some(1) {
            assert!(std::time::Instant::now() < deadline, "提议没到 B");
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(b.reply(&id, true, None, None));

        // 等收齐落盘
        while b.snapshot()["inbox"].as_array().map(Vec::len) != Some(1) {
            assert!(
                std::time::Instant::now() < deadline,
                "文件没落进 B 的收件箱"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let arrived = fs::read(b_dir.join("inbox/files/payload.bin")).expect("应已落盘");
        assert_eq!(arrived.len(), data.len());
        assert!(arrived == data, "字节必须与源一致");
        // 发送侧收到 direct-result 后转 done,暂存文件被回收
        while a.snapshot()["transfers"][0]["state"] != "done" {
            assert!(std::time::Instant::now() < deadline, "A 没收到完成回执");
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(!source.exists(), "暂存文件应在完成后删掉");
    }

    /// 文本直发:对端直接落收件箱并回执,发送侧转 done。
    #[test]
    fn text_transfer_roundtrip() {
        let a = DirectService::new(&temp_dir("txt-a"), Arc::new(|_| None), Arc::new(|| {}));
        let b = DirectService::new(&temp_dir("txt-b"), Arc::new(|_| None), Arc::new(|| {}));
        let (to_b, _) = wire_pair(Arc::clone(&a), Arc::clone(&b));
        let (_, queued) = a.send_text("B", "跨语言直发", Some(to_b)).unwrap();
        assert!(!queued);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while b.snapshot()["inbox"].as_array().map(Vec::len) != Some(1) {
            assert!(std::time::Instant::now() < deadline, "文本没到 B");
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        while a.snapshot()["transfers"][0]["state"] != "done" {
            assert!(std::time::Instant::now() < deadline, "A 没收到完成回执");
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let item = &b.snapshot()["inbox"][0];
        assert_eq!(item["kind"], "text");
        let id = item["id"].as_str().unwrap().to_string();
        let (_, bytes) = b.content(&id).expect("正文应可读");
        assert_eq!(String::from_utf8_lossy(&bytes), "跨语言直发");
    }

    #[test]
    fn offer_becomes_pending_then_reply_accepts() {
        let config = temp_dir("offer");
        let service = DirectService::new(&config, Arc::new(|_| None), Arc::new(|| {}));
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let link = ControlLink {
            device_id: "B".into(),
            outbound: tx,
            chunk: tokio::sync::mpsc::unbounded_channel().0,
            caps: vec!["binary1".into(), "direct1".into()],
        };
        let payload = [7u8; 10];
        let digest = hex::encode(Sha256::digest(payload));
        service.handle_control(
            &link,
            ControlMessage::DirectFileOffer {
                id: "df-1".into(),
                from_device_id: String::new(),
                name: "a.bin".into(),
                size: 10,
                sha256: digest,
                created_at: 1,
                batch_id: None,
                version: None,
                hostname: None,
                platform: None,
                runtime: None,
            },
        );
        assert_eq!(service.snapshot()["pending"].as_array().unwrap().len(), 1);
        assert!(rx.try_recv().is_err(), "提议阶段不该回任何帧");

        assert!(service.reply("df-1", true, None, None));
        match rx.try_recv().expect("应回 direct-reply") {
            ControlMessage::DirectReply { accept, offset, .. } => {
                assert!(accept);
                assert!(offset.is_none(), "新投送不带 offset");
            }
            other => panic!("回成了 {other:?}"),
        }
        // 收全 10 字节:一片就够,校验通过后 rename 进收件箱
        service.handle_chunk("B", "df-1", 0, &payload);
        let files = std::fs::read_dir(config.join("inbox/files"))
            .unwrap()
            .count();
        assert_eq!(files, 1);
        assert_eq!(service.snapshot()["inbox"][0]["kind"], "file");
    }

    /// 传了一半被断链 → 台账落盘 → 换一个进程(同一数据目录)接着认领。
    /// 这是「重启后半截没人认领,白传一遍」的回归用例。
    #[test]
    fn resume_ledger_restores_outgoing_after_restart() {
        let dir = temp_dir("resume-out");
        let source = dir.join("payload.bin");
        let data = vec![9u8; DIRECT_CHUNK_BYTES * 2 + 10];
        fs::write(&source, &data).unwrap();
        let digest = hex::encode(Sha256::digest(&data));

        let service = DirectService::new(&dir, Arc::new(|_| None), Arc::new(|| {}));
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let (chunk_tx, _chunk_rx) = tokio::sync::mpsc::unbounded_channel();
        let link = ControlLink {
            device_id: "B".into(),
            outbound: tx,
            chunk: chunk_tx,
            caps: vec!["binary1".into(), "direct1".into()],
        };
        let (id, queued) = service
            .send_file(
                "B",
                "payload.bin",
                &source,
                data.len() as u64,
                &digest,
                None,
                Some(link.clone()),
            )
            .unwrap();
        assert!(!queued);
        // 对端确认 → transferring → pump 把前几片推出去;ack 是**累积水位**,
        // seq=1 表示「第 0 片已收」,bytesDone 因此推进一片。
        service.handle_control(
            &link,
            ControlMessage::DirectReply {
                id: id.clone(),
                from_device_id: "B".into(),
                accept: true,
                reason: None,
                offset: None,
                version: None,
                hostname: None,
                platform: None,
                runtime: None,
            },
        );
        service.handle_control(
            &link,
            ControlMessage::DirectAck {
                id: id.clone(),
                from_device_id: "B".into(),
                seq: 1,
                version: None,
                hostname: None,
                platform: None,
                runtime: None,
            },
        );
        // 断链:get_link 返回 None,transferring 的传输转 paused。
        service.on_peer_offline("B");
        assert_eq!(
            service.snapshot()["transfers"][0]["state"],
            "paused",
            "断链后应转暂停而不是失败"
        );

        let ledger = fs::read_to_string(dir.join("inbox/resume.json")).expect("应写出台账");
        assert!(ledger.contains("\"sourcePath\""), "键名要与 Node 一致:{ledger}");
        assert!(ledger.contains("\"pausedAt\""));
        assert!(ledger.contains("\"bytesDone\": 262144"), "已确认一片应在台账里");

        // 换一个实例模拟重启:同一数据目录,内存状态全丢。
        drop(service);
        let restarted = DirectService::new(&dir, Arc::new(|_| None), Arc::new(|| {}));
        let transfers = restarted.snapshot()["transfers"].clone();
        let entry = transfers
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["id"] == id.as_str())
            .expect("重启后应认领回这一笔");
        assert_eq!(entry["state"], "paused");
        assert_eq!(entry["direction"], "send");
        assert_eq!(entry["bytesDone"], (DIRECT_CHUNK_BYTES as u64));
        assert!(source.exists(), "暂存文件不能被顺手删掉");

        // 关停后台账仍在(下次启动还要接着认领)。
        restarted.close();
        assert!(dir.join("inbox/resume.json").exists());
    }

    /// 入站半截的认领规则:整片且没满才要,不合法的一律连文件一起清掉。
    #[test]
    fn resume_ledger_restores_incoming_and_drops_bad_records() {
        let dir = temp_dir("resume-in");
        let service = DirectService::new(&dir, Arc::new(|_| None), Arc::new(|| {}));
        drop(service);
        let tmp = dir.join("inbox/.tmp");
        fs::create_dir_all(&tmp).unwrap();

        let good_id = "df-good";
        let bad_id = "df-bad";
        let good_bytes = vec![1u8; DIRECT_CHUNK_BYTES];
        fs::write(tmp.join(format!("in-{good_id}")), &good_bytes).unwrap();
        // 未对齐的半截:说明文件被动过,不可信。
        fs::write(tmp.join(format!("in-{bad_id}")), [2u8; 100]).unwrap();

        let now = now_ms();
        let ledger = ResumeFile {
            v: 1,
            outgoing: Vec::new(),
            incoming: vec![
                ResumeIn {
                    id: good_id.into(),
                    from: "A".into(),
                    name: "x.bin".into(),
                    size: (DIRECT_CHUNK_BYTES as u64) * 2,
                    sha256: "a".repeat(64),
                    created_at: now,
                    bytes_done: DIRECT_CHUNK_BYTES as u64,
                    paused_at: now,
                    save_dir: None,
                    batch_id: None,
                },
                ResumeIn {
                    id: bad_id.into(),
                    from: "A".into(),
                    name: "y.bin".into(),
                    size: (DIRECT_CHUNK_BYTES as u64) * 2,
                    sha256: "b".repeat(64),
                    created_at: now,
                    bytes_done: 100,
                    paused_at: now,
                    save_dir: None,
                    batch_id: None,
                },
            ],
        };
        fs::write(
            dir.join("inbox/resume.json"),
            serde_json::to_string(&ledger).unwrap(),
        )
        .unwrap();

        let restarted = DirectService::new(&dir, Arc::new(|_| None), Arc::new(|| {}));
        let transfers = restarted.snapshot()["transfers"].clone();
        let list = transfers.as_array().unwrap();
        assert_eq!(list.len(), 1, "只有整片对齐的那笔能认领回来");
        assert_eq!(list[0]["id"], good_id);
        assert_eq!(list[0]["state"], "paused");
        assert_eq!(list[0]["bytesDone"], (DIRECT_CHUNK_BYTES as u64));
        assert!(
            !tmp.join(format!("in-{bad_id}")).exists(),
            "不可信的半截要连文件一起删"
        );

        // 被丢弃的条目不该留在台账里,否则下次启动又捞出来判一遍。
        let text = fs::read_to_string(dir.join("inbox/resume.json")).unwrap();
        assert!(!text.contains(bad_id), "台账应被重写:{text}");
        assert!(text.contains(good_id));
    }
}
