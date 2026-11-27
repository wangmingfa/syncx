//! wire 协议:消息模型 + 文本/二进制两种信封。对应 Node 侧 `src/net/wire.ts`
//! 与 `src/messages.ts` 的索引编解码。
//!
//! 三个必须逐字复刻的地方,顺序即踩坑顺序:
//!
//! 1. **`full` 缺省按增量**。旧版对端不发这个字段,而它**确实**会发增量索引。
//!    把缺省当全量,就会为「它没提到的本地条目」回推,两端互为回声、无限循环。
//! 2. **控制消息里的 `version` 是软件版本,不是条目版本向量**。后者叫 `entryVersion`,
//!    字段名刻意避开 —— 混用会让读协议的人把版本向量当成软件版本号。
//! 3. **`ControlMessage` 的变体必须带 `kind` 判别字段**,且未知 `kind` 要能原样跳过
//!    而不是让整条连接报错(旧对端会发本端不认识的 kind)。

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use syncx_core::plan::IndexEntry;

/// 单条 WebSocket 消息的上限:索引/块传输的上限,防单条巨消息耗尽内存。
pub const MAX_MESSAGE_BYTES: usize = 64 * 1024 * 1024;

/// 索引在线上的一条条目。
///
/// 单独定义而不是直接给 core 的 `IndexEntry` 加 serde 派生,原因是线上字段比内核多
/// 一个 `mtime`:
///   - `mtime` 参与 newest-wins 冲突判定,但**不参与**规划与版本比较,
///     所以 core 里没有它(内核只关心「要不要传」,不关心「谁更新」);
///   - 版本向量在线上是 `[[device, count], ...]` 数组而不是对象 —— JS 的 `Map`
///     序列化就是这个形态,写成对象会让旧对端的 `new Map(e.version)` 拿到 `[]`。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WireEntry {
    pub path: String,
    /// `[[deviceId, counter], ...]`。**顺序有意义**:Node 侧按 Map 迭代顺序写,
    /// 读回来也是这个顺序,保持即可(比较时处处按集合处理,不依赖顺序)。
    pub version: Vec<(String, u64)>,
    pub size: u64,
    pub deleted: bool,
    pub blocks: Vec<String>,
    /// 文件 mtime(毫秒)。**可能是小数**:Node 侧写的是 `statSync().mtimeMs`,
    /// 在多数文件系统上是带小数的毫秒(NTFS/ext4/APFS 都给分数),`JSON.stringify`
    /// 会原样输出 `1750000000123.456`。用 `i64` 反序列化会让**整条索引**解析失败
    /// (serde 不接受带小数的整数),而失败点是「解码丢帧」—— 连接看着正常、索引
    /// 一条也收不到。宽进:按 f64 收,内部再截断成毫秒。
    pub mtime: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cdh: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clens: Option<Vec<u64>>,
}

/// 毫秒截断。负数/NaN 一律归 0(对端不可信,不能让它污染 newest-wins 比较)。
pub fn mtime_ms(value: f64) -> i64 {
    if value.is_finite() && value > 0.0 {
        value as i64
    } else {
        0
    }
}

impl WireEntry {
    /// 由内核条目 + mtime(整毫秒)组装线上形态。
    pub fn from_entry(entry: &IndexEntry, mtime: i64) -> Self {
        Self::from_entry_raw_mtime(entry, mtime as f64)
    }

    /// 由内核条目 + **未截断**的 mtime 组装:中转场景用 —— 对端带来的小数毫秒
    /// 必须原样转发(newest-wins 跨机比较依赖它),截断值顶替会让同一份内容
    /// 绕一跳后 mtime 凭空变小。
    pub fn from_entry_raw_mtime(entry: &IndexEntry, mtime: f64) -> Self {
        Self {
            path: entry.path.clone(),
            version: entry.version.iter().map(|(k, v)| (k.clone(), *v)).collect(),
            size: entry.size,
            deleted: entry.deleted,
            blocks: entry.blocks.clone(),
            mtime,
            cdh: entry.cdh.clone(),
            clens: entry.clens.clone(),
        }
    }

    /// 转回内核条目。
    pub fn to_entry(&self) -> IndexEntry {
        // 宽进严出:cdh/clens 必须等长且非空才算有 CDC 视图,与 Node 的
        // decodeIndex 同一判据(见 core 的 IndexEntry::has_cdc_view)
        let cdc_view = match (&self.cdh, &self.clens) {
            (Some(h), Some(l)) if !h.is_empty() && h.len() == l.len() => {
                (Some(h.clone()), Some(l.clone()))
            }
            _ => (None, None),
        };
        IndexEntry {
            path: self.path.clone(),
            version: self.version.iter().cloned().collect(),
            size: self.size,
            deleted: self.deleted,
            blocks: self.blocks.clone(),
            cdh: cdc_view.0,
            clens: cdc_view.1,
        }
    }
}

/// 索引体的编解码。
///
/// **空条目也要保留**(`deleted: true` 的那类):它们是删除标记,过滤掉等于
/// 拒绝传播删除,对端会一直把已删文件当「本机独有」回推。
pub fn encode_index(entries: &[WireEntry]) -> Vec<u8> {
    serde_json::to_vec(entries).expect("索引条目应可序列化")
}

/// 解码索引体。畸形数据返回 `Err`,由调用方丢弃整条消息 —— 线上数据不可信。
pub fn decode_index(body: &[u8]) -> Result<Vec<WireEntry>, WireError> {
    serde_json::from_slice(body).map_err(|e| WireError::Malformed(e.to_string()))
}

/// 文本信封里的块响应(块数据 base64)。
///
/// 单独定义而不是复用 core 的 `BlockResponse`,因为线上形态不同:core 的版本是
/// 文件系统视角(`data: Vec<u8>`),这里是线上视角(`data: String`,base64)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireBlockResponse {
    #[serde(rename = "deviceId")]
    pub device_id: String,
    pub path: String,
    #[serde(rename = "blockIndex")]
    pub block_index: u64,
    pub hash: String,
    pub data: String,
    /// 回显请求的 CDC 口径标记。**`None` 时不能序列化成 `null`** ——
    /// Node 侧用 `cdc?: boolean` + `...(wire.cdc === true ? { cdc: true } : {})`,
    /// 发 `null` 会让旧对端的 `typeof` 判断走进非预期分支。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cdc: Option<bool>,
}

/// 块请求(文本信封)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireBlockRequest {
    #[serde(rename = "deviceId")]
    pub device_id: String,
    pub path: String,
    #[serde(rename = "blockIndex")]
    pub block_index: u64,
    pub hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cdc: Option<bool>,
}

/// 控制面消息。
///
/// 用 `#[serde(tag = "kind")]` 而不是让每个变体自己带字段:线上格式就是
/// `{"kind":"hello", ...}`,判别字段在顶层。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ControlMessage {
    FolderInvitation {
        #[serde(rename = "offerId")]
        offer_id: String,
        #[serde(rename = "fromDeviceId")]
        from_device_id: String,
        #[serde(rename = "folderId")]
        folder_id: String,
        #[serde(rename = "folderName")]
        folder_name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        version: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hostname: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        platform: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        runtime: Option<String>,
    },
    FolderInvitationAck {
        #[serde(rename = "offerId")]
        offer_id: String,
        #[serde(rename = "fromDeviceId")]
        from_device_id: String,
        accepted: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        version: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hostname: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        platform: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        runtime: Option<String>,
    },
    PairingRequest {
        #[serde(rename = "offerId")]
        offer_id: String,
        #[serde(rename = "fromDeviceId")]
        from_device_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        version: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hostname: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        platform: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        runtime: Option<String>,
    },
    PairingAck {
        #[serde(rename = "offerId")]
        offer_id: String,
        #[serde(rename = "fromDeviceId")]
        from_device_id: String,
        accepted: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        version: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hostname: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        platform: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        runtime: Option<String>,
    },
    /// 邀请投递回执(控制面「至少一次」的第二道锁):接收方**处理了**邀请/配对请求
    /// 即回此帧,与用户是否决策无关 —— 用户决策走 `*-ack`,可能迟到很久,不能驱动重发。
    OfferReceipt {
        #[serde(rename = "offerId")]
        offer_id: String,
        #[serde(rename = "fromDeviceId")]
        from_device_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        version: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hostname: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        platform: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        runtime: Option<String>,
    },
    FolderSyncList {
        #[serde(rename = "fromDeviceId")]
        from_device_id: String,
        #[serde(rename = "folderIds")]
        folder_ids: Vec<String>,
        #[serde(
            rename = "pendingFolderIds",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        pending_folder_ids: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        version: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hostname: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        platform: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        runtime: Option<String>,
    },
    /// 会话建立时互发的版本宣告。dev 态(src 直跑)`version` 为 `"dev"`。
    Hello {
        #[serde(rename = "fromDeviceId")]
        from_device_id: String,
        version: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hostname: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        platform: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        runtime: Option<String>,
    },
    SelfBinaryRequest {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "fromDeviceId")]
        from_device_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        version: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hostname: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        platform: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        runtime: Option<String>,
    },
    SelfBinaryResponse {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "fromDeviceId")]
        from_device_id: String,
        version: String,
        sha256: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        data: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hostname: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        platform: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        runtime: Option<String>,
    },
    FolderIndexRequest {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "fromDeviceId")]
        from_device_id: String,
        #[serde(rename = "folderId")]
        folder_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        version: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hostname: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        platform: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        runtime: Option<String>,
    },
    FolderIndexSnapshot {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "fromDeviceId")]
        from_device_id: String,
        #[serde(rename = "folderId")]
        folder_id: String,
        seq: u64,
        total: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        entries: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        #[serde(
            rename = "ignoreLines",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        ignore_lines: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        progress: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        version: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hostname: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        platform: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        runtime: Option<String>,
    },
    FileContentRequest {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "fromDeviceId")]
        from_device_id: String,
        #[serde(rename = "folderId")]
        folder_id: String,
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        version: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hostname: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        platform: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        runtime: Option<String>,
    },
    FileContentResponse {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "fromDeviceId")]
        from_device_id: String,
        #[serde(rename = "folderId")]
        folder_id: String,
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        data: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        size: Option<u64>,
        /// 条目版本向量。**不是**软件版本 —— 见模块注释第 2 条。
        #[serde(
            rename = "entryVersion",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        entry_version: Option<Vec<(String, u64)>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        version: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hostname: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        platform: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        runtime: Option<String>,
    },
    FileContentWrite {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "fromDeviceId")]
        from_device_id: String,
        #[serde(rename = "folderId")]
        folder_id: String,
        path: String,
        data: String,
        #[serde(rename = "entryVersion")]
        entry_version: Vec<(String, u64)>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        version: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hostname: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        platform: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        runtime: Option<String>,
    },
    FileContentWriteResult {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "fromDeviceId")]
        from_device_id: String,
        #[serde(rename = "folderId")]
        folder_id: String,
        path: String,
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        version: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hostname: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        platform: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        runtime: Option<String>,
    },
    GitCommitNotify {
        #[serde(rename = "fromDeviceId")]
        from_device_id: String,
        #[serde(rename = "folderId")]
        folder_id: String,
        #[serde(rename = "commitHash")]
        commit_hash: String,
        #[serde(rename = "commitMessage")]
        commit_message: String,
        #[serde(rename = "changedFiles")]
        changed_files: Vec<String>,
        #[serde(rename = "diffStat", default, skip_serializing_if = "Option::is_none")]
        diff_stat: Option<String>,
        #[serde(
            rename = "commitSubjects",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        commit_subjects: Option<Vec<String>>,
        #[serde(rename = "parentHash")]
        parent_hash: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        version: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hostname: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        platform: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        runtime: Option<String>,
    },
    GitCommitAck {
        #[serde(rename = "fromDeviceId")]
        from_device_id: String,
        #[serde(rename = "folderId")]
        folder_id: String,
        #[serde(rename = "commitHash")]
        commit_hash: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        version: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hostname: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        platform: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        runtime: Option<String>,
    },

    /* ===== 设备间直发(ADR-0028)=====
     * 全部带 `id` 关联同一次投送。归属一律以**这一跳的会话身份**为准,消息体里的
     * `fromDeviceId` 只用于注入版本等信息(Node 侧同款),不能拿来判「是谁发的」。
     * 文件字节不走这些 JSON 帧,走 [`BinaryFrameKind::DirectFileChunk`]。 */
    /// 一段文本(≤64KB UTF-8 字节),接收方直接落收件箱并回 `direct-result`。
    DirectText {
        id: String,
        #[serde(rename = "fromDeviceId", default)]
        from_device_id: String,
        text: String,
        #[serde(rename = "createdAt", default)]
        created_at: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        version: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hostname: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        platform: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        runtime: Option<String>,
    },
    /// 文件投送提议。用户确认前接收方不写入任何字节(只预建临时文件路径)。
    /// `batchId` 把同一次「发送 N 个文件」串起来:接收方据此合并成一张卡、一次确认。
    DirectFileOffer {
        id: String,
        #[serde(rename = "fromDeviceId", default)]
        from_device_id: String,
        name: String,
        size: u64,
        sha256: String,
        #[serde(rename = "createdAt", default)]
        created_at: i64,
        #[serde(rename = "batchId", default, skip_serializing_if = "Option::is_none")]
        batch_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        version: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hostname: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        platform: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        runtime: Option<String>,
    },
    /// 接收方对提议的表态。`offset` 只在断点续传时出现 = 本机已落盘字节数
    /// (必然是整片的整数倍),发送方据此把起点挪到对应片号。
    DirectReply {
        id: String,
        #[serde(rename = "fromDeviceId", default)]
        from_device_id: String,
        accept: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        offset: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        version: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hostname: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        platform: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        runtime: Option<String>,
    },
    /// 累积确认:`seq` = 接收方**下一个期望的片号**,即它之前全部已落盘。
    DirectAck {
        id: String,
        #[serde(rename = "fromDeviceId", default)]
        from_device_id: String,
        seq: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        version: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hostname: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        platform: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        runtime: Option<String>,
    },
    /// 任一方中止(离线 / 超时 / 校验失败);收到即清理临时文件。
    DirectCancel {
        id: String,
        #[serde(rename = "fromDeviceId", default)]
        from_device_id: String,
        #[serde(default)]
        reason: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        version: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hostname: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        platform: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        runtime: Option<String>,
    },
    /// 接收方最终回执(文本落箱 / 文件校验通过并重命名)。
    DirectResult {
        id: String,
        #[serde(rename = "fromDeviceId", default)]
        from_device_id: String,
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        version: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hostname: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        platform: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        runtime: Option<String>,
    },
    /// 未知 kind:静默忽略。
    ///
    /// Node 侧的控制面是「读一段 JSON、按 kind 分支,不认识的直接跳过」,所以它天然
    /// 向前兼容。这里是关闭枚举:没有这一支时,任何新版本发来的消息都会让**整帧**
    /// 反序列化失败 —— 而 `decrypt_message` 的失败策略是丢弃整帧并打 debug 日志,
    /// 于是「对端发来一条我不认识的通知」等于什么都没发生,却连原因都看不出来。
    /// 降级成一条可忽略的消息,与 Node 的语义对齐。
    #[serde(other)]
    Unknown,
}

/// 顶层 wire 消息。
///
/// `index` 的 `full` 字段语义见模块注释第 1 条 —— 这里刻意做成 `Option<bool>`
/// 而不是 `bool`,让「缺省」这一状态在类型上就可见,调用方必须显式决定怎么解释它。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum WireMessage {
    Index {
        folder: String,
        payload: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        full: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        relayed: Option<bool>,
    },
    IndexFingerprint {
        folder: String,
        fingerprint: String,
    },
    IndexAck {
        folder: String,
    },
    IndexRequest {
        folder: String,
    },
    BlockRequest {
        folder: String,
        payload: WireBlockRequest,
    },
    BlockResponse {
        folder: String,
        payload: WireBlockResponse,
    },
    Control {
        payload: ControlMessage,
    },
}

impl WireMessage {
    /// 这条索引消息是否应当按**全量**语义规划。
    ///
    /// 唯一正确的读法:**只有明确 `full == Some(true)` 才是全量**。`None`(旧对端)
    /// 与 `Some(false)` 都按增量处理。见模块注释第 1 条。
    pub fn is_full_index(&self) -> bool {
        matches!(
            self,
            WireMessage::Index {
                full: Some(true),
                ..
            }
        )
    }
}

/// 文本信封编码。
pub fn encode_wire_message(message: &WireMessage) -> String {
    serde_json::to_string(message).expect("WireMessage 应可序列化")
}

/// 文本信封解码。
///
/// 返回 `Result` 而不是像 Node 那样直接 `JSON.parse` + 断言:线上数据不可信,
/// 畸形消息必须能被调用方丢弃而不是 panic。
pub fn decode_wire_message(raw: &str) -> Result<WireMessage, serde_json::Error> {
    serde_json::from_str(raw)
}

/* ==================== AES-256-GCM 文本信封 ==================== */

/// 加密信封的线上形态。
#[derive(Debug, Serialize, Deserialize)]
struct EncEnvelope {
    #[serde(rename = "type")]
    kind: String,
    iv: String,
    tag: String,
    data: String,
}

/// AES-256-GCM 加密一条消息,输出携带 `iv`/`tag` 的 JSON 字符串。
pub fn encrypt_message(key: &[u8; 32], message: &WireMessage) -> Result<String, WireError> {
    let iv = random_iv();
    let plaintext = encode_wire_message(message);
    let mut buf = plaintext.into_bytes();
    let encrypted = aes_gcm_encrypt(key, &iv, &mut buf)?;
    Ok(serde_json::to_string(&EncEnvelope {
        kind: "enc".to_string(),
        iv: b64(&iv),
        tag: b64(&encrypted[..16]),
        data: b64(&encrypted[16..]),
    })
    .expect("信封应可序列化"))
}

/// 解密一条消息。`type` 不是 `enc` 时报错 —— 与 Node 的显式检查一致。
pub fn decrypt_message(key: &[u8; 32], raw: &str) -> Result<WireMessage, WireError> {
    let envelope: EncEnvelope =
        serde_json::from_str(raw).map_err(|e| WireError::Malformed(e.to_string()))?;
    if envelope.kind != "enc" {
        return Err(WireError::Malformed(
            "expected encrypted message".to_string(),
        ));
    }
    let iv = unb64(&envelope.iv)?;
    let tag = unb64(&envelope.tag)?;
    let data = unb64(&envelope.data)?;
    let iv: [u8; 12] = iv
        .as_slice()
        .try_into()
        .map_err(|_| WireError::Malformed("iv 长度不是 12".to_string()))?;
    let plain = aes_gcm_decrypt(key, &iv, &tag, &data)?;
    let text = String::from_utf8(plain).map_err(|e| WireError::Malformed(e.to_string()))?;
    decode_wire_message(&text).map_err(|e| WireError::Malformed(e.to_string()))
}

/* ==================== 二进制信封 ==================== */

/// 二进制帧版本。对端版本不符时整帧丢弃(宽进严出)。
pub const BINARY_FRAME_VERSION: u8 = 1;

/// iv(12) + tag(16) + [版本 1B][kind 1B][头长 u32 BE] = 34 字节固定开销。
pub const BINARY_FRAME_OVERHEAD: usize = 12 + 16 + 6;

/// 头部 JSON 上限:元数据远小于此,超限即视为坏帧(不让畸形长度支配内存)。
const BINARY_HEADER_MAX: usize = 1024 * 1024;

/// 走二进制信封的消息类型。
///
/// 只有这两个是字节量大头 —— 块响应与索引。块请求与控制面消息只有几十字节,
/// 继续走文本 JSON,少一处格式分支。
///
/// `DirectFileChunk` 是第三个:直发的文件分片(256KB)不属于任何共享目录,读循环
/// 必须**先**按 kind 认它、再按 `folder` 路由,否则会掉进「目录不存在」的静默丢弃。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinaryFrameKind {
    BlockResponse = 1,
    Index = 2,
    DirectFileChunk = 3,
}

impl BinaryFrameKind {
    fn from_byte(byte: u8) -> Option<Self> {
        match byte {
            1 => Some(Self::BlockResponse),
            2 => Some(Self::Index),
            3 => Some(Self::DirectFileChunk),
            _ => None,
        }
    }
}

/// 直发分片的裸字节上限:与 Node 的 `DIRECT_CHUNK_BYTES` 同值。
///
/// 放在 wire 层是因为接收侧要先按它拒掉畸形帧(**不信** header 声明的长度),
/// 而不是让上层拿到一片 8MB 的「分片」再自己判断。
pub const DIRECT_CHUNK_BYTES: usize = 256 * 1024;

/// 解出的一帧二进制数据。
#[derive(Debug, Clone)]
pub struct BinaryFrame {
    pub kind: BinaryFrameKind,
    /// 元数据(不含二进制体):块响应带 path/hash/…,索引带 folder/full/relayed。
    pub header: Value,
    /// 裸字节体:块内容或索引 JSON。
    pub body: Vec<u8>,
}

/// 加密并封成一帧二进制数据。
pub fn encode_binary_frame(
    key: &[u8; 32],
    kind: BinaryFrameKind,
    header: &Value,
    body: &[u8],
) -> Result<Vec<u8>, WireError> {
    let header_bytes =
        serde_json::to_vec(header).map_err(|e| WireError::Malformed(e.to_string()))?;
    if header_bytes.len() > BINARY_HEADER_MAX {
        return Err(WireError::Malformed("header too large".to_string()));
    }

    let mut plain = Vec::with_capacity(6 + header_bytes.len() + body.len());
    plain.push(BINARY_FRAME_VERSION);
    plain.push(kind as u8);
    // u32 BE 头长度 —— 与 Node 的 writeUInt32BE 同字节序
    plain.extend_from_slice(&(header_bytes.len() as u32).to_be_bytes());
    plain.extend_from_slice(&header_bytes);
    plain.extend_from_slice(body);

    let iv = random_iv();
    let encrypted = aes_gcm_encrypt(key, &iv, &mut plain)?;
    let mut frame = Vec::with_capacity(28 + encrypted.len());
    frame.extend_from_slice(&iv);
    frame.extend_from_slice(&encrypted); // 前 16 字节是 tag
    Ok(frame)
}

/// 解一帧二进制数据。
///
/// 任何认证/长度/格式问题一律返回 `None` —— 与文本路径的 `catch { return; }`
/// 同一策略:坏帧丢弃,不掀翻连接(对端不可信,宽进严出)。
pub fn decode_binary_frame(key: &[u8; 32], frame: &[u8]) -> Option<BinaryFrame> {
    if frame.len() < BINARY_FRAME_OVERHEAD {
        return None;
    }
    let iv: [u8; 12] = frame.get(..12)?.try_into().ok()?;
    let tag = frame.get(12..28)?;
    let ciphertext = frame.get(28..)?;

    let plain = aes_gcm_decrypt(key, &iv, tag, ciphertext).ok()?;
    if plain.len() < 6 || plain[0] != BINARY_FRAME_VERSION {
        return None;
    }
    let kind = BinaryFrameKind::from_byte(plain[1])?;
    let header_len = u32::from_be_bytes(plain.get(2..6)?.try_into().ok()?) as usize;
    if header_len == 0 || header_len > BINARY_HEADER_MAX || 6 + header_len > plain.len() {
        return None;
    }
    let header: Value = serde_json::from_slice(plain.get(6..6 + header_len)?).ok()?;
    if !header.is_object() {
        return None;
    }
    Some(BinaryFrame {
        kind,
        header,
        body: plain.get(6 + header_len..)?.to_vec(),
    })
}

/* ==================== 加解密原语 ==================== */

fn random_iv() -> [u8; 12] {
    use rand::RngCore;
    let mut iv = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut iv);
    iv
}

/// AES-256-GCM 加密。返回 tag(16)+ ciphertext 的拼接。
///
/// 注意这里**不用** Node 的逐块 API 形态:Node 的 `cipher.update` + `final` 等价于
/// 一次性加密整段,所以这里直接一次性处理,不引入分块语义上的可能偏差。
fn aes_gcm_encrypt(
    key: &[u8; 32],
    iv: &[u8; 12],
    plaintext: &mut [u8],
) -> Result<Vec<u8>, WireError> {
    use aes_gcm::aead::{AeadInPlace, KeyInit};
    use aes_gcm::{Aes256Gcm, Nonce};

    let cipher = Aes256Gcm::new(key.into());
    let nonce = Nonce::from_slice(iv);
    let tag = cipher
        .encrypt_in_place_detached(nonce, b"", plaintext)
        .map_err(|_| WireError::Crypto("encrypt failed".to_string()))?;

    let mut out = Vec::with_capacity(16 + plaintext.len());
    out.extend_from_slice(&tag);
    out.extend_from_slice(plaintext);
    Ok(out)
}

/// AES-256-GCM 解密。输入 tag(16)+ ciphertext。
fn aes_gcm_decrypt(
    key: &[u8; 32],
    iv: &[u8; 12],
    tag: &[u8],
    ciphertext: &[u8],
) -> Result<Vec<u8>, WireError> {
    use aes_gcm::aead::{AeadInPlace, KeyInit};
    use aes_gcm::{Aes256Gcm, Nonce, Tag};

    if tag.len() != 16 {
        return Err(WireError::Crypto("bad tag length".to_string()));
    }
    let cipher = Aes256Gcm::new(key.into());
    let nonce = Nonce::from_slice(iv);
    let mut buf = ciphertext.to_vec();
    cipher
        .decrypt_in_place_detached(nonce, b"", &mut buf, Tag::from_slice(tag))
        .map_err(|_| WireError::Crypto("decrypt failed".to_string()))?;
    Ok(buf)
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn unb64(text: &str) -> Result<Vec<u8>, WireError> {
    base64::engine::general_purpose::STANDARD
        .decode(text)
        .map_err(|e| WireError::Malformed(e.to_string()))
}

/// wire 层错误。
#[derive(Debug, thiserror::Error)]
pub enum WireError {
    #[error("帧格式非法:{0}")]
    Malformed(String),
    #[error("加解密失败:{0}")]
    Crypto(String),
}
