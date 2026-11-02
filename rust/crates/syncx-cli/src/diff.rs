//! 两个设备「同一目录 id」的内容对比(诊断用)。
//!
//! 逐条移植 Node 侧 `src/diff.ts`。这里**不新造比较逻辑**:`compare_file_state`
//! (`syncx-core::plan`)已经是同步规划器每天在用的「两边差在哪」判定,本模块只做
//! 三件事 ——
//!   1. 在它之上补两类规划器不关心的分类:版本相同但内容不一致(强异常信号)、
//!      以及「差异是忽略规则使然」(不是故障);
//!   2. 把结论翻译成可读的差异项(带上命中的规则原文、是否硬忽略、盘上复核);
//!   3. 全程只读:不落盘、不发索引、不改版本向量 —— 诊断工具绝不能扰动被观察的系统。
//!
//! 对端的索引由 daemon 经控制通道按需索取,不依赖会话建立时那份全量索引 ——
//! 那份只在 attach 时刻准确,对端之后改忽略规则或只发增量都会让它悄悄过期。

use std::collections::BTreeMap;
use std::path::Path;

use serde::Serialize;
use sha2::{Digest, Sha256};
use syncx_core::ignore::{is_hard_ignored, IgnoreRuleset};
use syncx_core::plan::{compare_file_state, FileStateRelation, IndexEntry};
use syncx_core::version::VersionVector;

/// 对端快照里的一条索引。与 [`IndexEntry`] 的唯一区别是 `blocks` 被折叠成一个摘要:
/// 线上原样的 blocks 是每块一个 64 位十六进制串,几十 GB 的目录条目体积会随文件大小
/// 线性膨胀。摘要数组由**双方用同一个函数**算(见 [`content_digest`]),因此可直接比对。
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct SnapshotEntry {
    pub path: String,
    /// wire 形态的版本向量(数组而非 map:与 Node 的 JSON 形态一致)。
    pub version: Vec<(String, u64)>,
    pub size: u64,
    pub deleted: bool,
    /// `content_digest(blocks)`;墓碑为空串。
    pub digest: String,
    /// 对端文件 mtime(毫秒)。仅用于展示,不参与任何判定。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mtime: Option<i64>,
}

/// 差异分类。序列化形态(连字符)与 Node 的 `DiffKind` 一致。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DiffKind {
    /// 版本向量相等,但大小或内容摘要不同 —— 正常绝不该出现,最强异常信号。
    ContentMismatch,
    /// 版本向量交叉:两边都改过。
    Conflict,
    /// 本机较新(含「本机已删除、待对端删除」):本机该推给对端。
    LocalNewer,
    /// 对端较新(含「对端已删除、待本机删除」):本机该拉回来。
    RemoteNewer,
    /// 只有对端声明,且命中**本机**忽略规则:本机按规则不收它,不是同步故障。
    IgnoredLocally,
    /// 只有本机声明,且命中**对端**规则:对端按它自己的规则不参与,不是同步故障。
    IgnoredRemotely,
    /// 双方一致(折叠展示,不进 items)。
    InSync,
}

impl DiffKind {
    /// 全部分类,顺序即 [`DIFF_KIND_ORDER`]。
    pub const ALL: [DiffKind; 7] = [
        DiffKind::ContentMismatch,
        DiffKind::Conflict,
        DiffKind::LocalNewer,
        DiffKind::RemoteNewer,
        DiffKind::IgnoredLocally,
        DiffKind::IgnoredRemotely,
        DiffKind::InSync,
    ];

    /// 排序权重:越靠前越可能是真问题。派生 `Ord` 恰好就是这个顺序(变体声明序)。
    fn rank(self) -> usize {
        Self::ALL.iter().position(|kind| *kind == self).unwrap_or(0)
    }
}

/// 展示用的单侧状态(version 保持 wire 形态,便于直接塞进 JSON 响应)。
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct DiffSide {
    pub version: Vec<(String, u64)>,
    pub size: u64,
    pub deleted: bool,
    pub digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mtime: Option<i64>,
}

/// 本机盘上复核结果。索引与磁盘可能不一致(daemon 离线期间的改动尚未扫到、
/// 或文件被外部删除),而「索引说有、盘上没了」和「两边内容不同」是完全不同的
/// 结论,必须分开报。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DiskState {
    Ok,
    Missing,
    SizeDiffers,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct DiffItem {
    pub path: String,
    pub kind: DiffKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local: Option<DiffSide>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote: Option<DiffSide>,
    /// 命中的忽略规则原文。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule: Option<String>,
    /// 该路径命中硬忽略名单(任何配置都解不开)。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hard: Option<bool>,
    /// 本机盘上复核(仅对本机索引声明存在的活条目做)。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disk: Option<DiskState>,
}

/// 各分类计数(字段名与 Node 的 `Record<DiffKind, number>` 键一致)。
#[derive(Debug, Clone, Default, Serialize, serde::Deserialize)]
pub struct DiffCounts {
    #[serde(rename = "content-mismatch")]
    pub content_mismatch: usize,
    pub conflict: usize,
    #[serde(rename = "local-newer")]
    pub local_newer: usize,
    #[serde(rename = "remote-newer")]
    pub remote_newer: usize,
    #[serde(rename = "ignored-locally")]
    pub ignored_locally: usize,
    #[serde(rename = "ignored-remotely")]
    pub ignored_remotely: usize,
    #[serde(rename = "in-sync")]
    pub in_sync: usize,
}

impl DiffCounts {
    fn bump(&mut self, kind: DiffKind) {
        match kind {
            DiffKind::ContentMismatch => self.content_mismatch += 1,
            DiffKind::Conflict => self.conflict += 1,
            DiffKind::LocalNewer => self.local_newer += 1,
            DiffKind::RemoteNewer => self.remote_newer += 1,
            DiffKind::IgnoredLocally => self.ignored_locally += 1,
            DiffKind::IgnoredRemotely => self.ignored_remotely += 1,
            DiffKind::InSync => self.in_sync += 1,
        }
    }

    /// 差异总数(不含 in-sync)。
    pub fn total(&self) -> usize {
        self.content_mismatch
            + self.conflict
            + self.local_newer
            + self.remote_newer
            + self.ignored_locally
            + self.ignored_remotely
    }
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct FolderDiff {
    /// 逐条差异(**不含** in-sync)。已按 [`DIFF_KIND_ORDER`] + 路径排序。
    pub items: Vec<DiffItem>,
    pub counts: DiffCounts,
    /// 本机索引条目数(含墓碑)。
    ///
    /// 这三个字段必须显式写成 camelCase:前端按 `diff.localTotal` 读,
    /// 而 serde 默认用下划线,漏了 rename 就是三个恒为 `undefined` 的字段。
    #[serde(rename = "localTotal")]
    pub local_total: usize,
    /// 对端快照条目数(含墓碑)。
    #[serde(rename = "remoteTotal")]
    pub remote_total: usize,
    /// 对端是否带回了它该目录的忽略规则行。旧版本对端不回 → false,
    /// 此时 ignored-remotely 无法判定,「只有本机声明」的条目会一律报成 local-newer。
    #[serde(rename = "remoteRulesKnown")]
    pub remote_rules_known: bool,
}

/// 对比输入。
pub struct FolderDiffInput<'a> {
    /// 本机内存索引(已按本机忽略规则过滤,用户级忽略的墓碑仍保留)。
    pub local: &'a BTreeMap<String, IndexEntry>,
    /// 对端快照。
    pub remote: &'a [SnapshotEntry],
    /// 本机该目录生效的忽略规则(含内置默认行)。
    pub local_rules: &'a IgnoreRuleset,
    /// 对端随快照带回的规则行解析结果;旧对端不返回时为 `None`。
    pub remote_rules: Option<&'a IgnoreRuleset>,
}

/// 内容摘要:把逐块哈希折叠成一个定长 sha256。
/// 空 blocks(墓碑、空文件)返回空串 —— 两者无需区分,摘要只用于「内容是否同一份」。
pub fn content_digest(blocks: &[String]) -> String {
    if blocks.is_empty() {
        return String::new();
    }
    let mut hasher = Sha256::new();
    hasher.update(blocks.join("\n").as_bytes());
    hex::encode(hasher.finalize())
}

/// 本地索引条目 → 快照条目(供服务端回快照;双方用同一函数保证摘要可比)。
pub fn to_snapshot_entry(entry: &IndexEntry, mtime: Option<i64>) -> SnapshotEntry {
    SnapshotEntry {
        path: entry.path.clone(),
        version: entry
            .version
            .iter()
            .map(|(device, seq)| (device.clone(), *seq))
            .collect(),
        size: entry.size,
        deleted: entry.deleted,
        digest: content_digest(&entry.blocks),
        mtime,
    }
}

fn version_pairs(version: &VersionVector) -> Vec<(String, u64)> {
    version
        .iter()
        .map(|(device, seq)| (device.clone(), *seq))
        .collect()
}

/// 快照条目 → 仅够 [`compare_file_state`] 使用的索引条目(blocks 不参与版本比较)。
fn as_index_entry(entry: &SnapshotEntry) -> IndexEntry {
    IndexEntry {
        path: entry.path.clone(),
        version: entry.version.iter().cloned().collect(),
        size: entry.size,
        deleted: entry.deleted,
        blocks: Vec::new(),
        cdh: None,
        clens: None,
    }
}

fn local_side(entry: &IndexEntry) -> DiffSide {
    DiffSide {
        version: version_pairs(&entry.version),
        size: entry.size,
        deleted: entry.deleted,
        digest: content_digest(&entry.blocks),
        mtime: None,
    }
}

fn remote_side(entry: &SnapshotEntry) -> DiffSide {
    DiffSide {
        version: entry.version.clone(),
        size: entry.size,
        deleted: entry.deleted,
        digest: entry.digest.clone(),
        mtime: entry.mtime,
    }
}

/// 分类两份索引的差异。纯函数:不碰文件系统、不发消息。
pub fn build_folder_diff(input: FolderDiffInput<'_>) -> FolderDiff {
    let FolderDiffInput {
        local,
        remote,
        local_rules,
        remote_rules,
    } = input;

    let mut remote_map: BTreeMap<&str, &SnapshotEntry> = BTreeMap::new();
    for entry in remote {
        remote_map.insert(entry.path.as_str(), entry);
    }

    let mut items: Vec<DiffItem> = Vec::new();
    let mut counts = DiffCounts::default();
    let mut push = |item: DiffItem, counts: &mut DiffCounts| {
        counts.bump(item.kind);
        items.push(item);
    };

    let mut paths: Vec<&str> = local.keys().map(String::as_str).collect();
    paths.extend(remote_map.keys().copied());
    paths.sort_unstable();
    paths.dedup();

    for path in paths {
        let l = local.get(path);
        let r = remote_map.get(path).copied();

        // --- 单边墓碑:一方删过、另一方从未见过它 ---
        // 墓碑是「删除」的载体,不是内容差异:对端压根没有这个文件,墓碑推过去也无事可做。
        // 若把这类报成差异,每个删过的文件都会长期挂在报告里,真正的差异反而被淹没。
        if l.is_none() {
            if let Some(r) = r {
                if r.deleted {
                    counts.in_sync += 1;
                    continue;
                }
            }
        }
        if r.is_none() {
            if let Some(l) = l {
                if l.deleted {
                    counts.in_sync += 1;
                    continue;
                }
            }
        }

        // --- 只有对端声明:先问「本机为什么没有」是不是规则使然 ---
        // 本机索引已被忽略规则过滤过,所以本机忽略的活条目在这里正是「对端有、本机没有」。
        // 不消歧的话,这些条目会被报成 remote-newer(「该拉回来」),而真相是
        // 「本机按规则不收它」—— 用户会照着报告去修一个不存在的问题。
        if l.is_none() {
            if let Some(r) = r {
                if let Some(rule) = local_rules.last_matched(path, false).filter(|r| !r.negated) {
                    push(
                        DiffItem {
                            path: path.to_string(),
                            kind: DiffKind::IgnoredLocally,
                            local: None,
                            remote: Some(remote_side(r)),
                            rule: Some(rule.pattern.clone()),
                            hard: is_hard_ignored(path).then_some(true),
                            disk: None,
                        },
                        &mut counts,
                    );
                    continue;
                }
                push(
                    DiffItem {
                        path: path.to_string(),
                        kind: DiffKind::RemoteNewer,
                        local: None,
                        remote: Some(remote_side(r)),
                        rule: None,
                        hard: None,
                        disk: None,
                    },
                    &mut counts,
                );
                continue;
            }
        }

        // --- 只有本机声明 ---
        if r.is_none() {
            let Some(l) = l else { continue };
            let rule = remote_rules.and_then(|rules| {
                rules
                    .last_matched(path, false)
                    .filter(|rule| !rule.negated)
                    .map(|rule| rule.pattern.clone())
            });
            if let Some(pattern) = rule {
                push(
                    DiffItem {
                        path: path.to_string(),
                        kind: DiffKind::IgnoredRemotely,
                        local: Some(local_side(l)),
                        remote: None,
                        rule: Some(pattern),
                        hard: is_hard_ignored(path).then_some(true),
                        disk: None,
                    },
                    &mut counts,
                );
                continue;
            }
            push(
                DiffItem {
                    path: path.to_string(),
                    kind: DiffKind::LocalNewer,
                    local: Some(local_side(l)),
                    remote: None,
                    rule: None,
                    hard: None,
                    disk: None,
                },
                &mut counts,
            );
            continue;
        }

        // --- 双方都声明 ---
        let (Some(l), Some(r)) = (l, r) else { continue };
        let relation = compare_file_state(Some(l), Some(&as_index_entry(r)));
        if relation == FileStateRelation::Equal {
            // 版本相同:唯一还算「一致」的前提是内容也真的同一份。
            // 规划器看不到这一层(它只比版本向量),而「版本相同、内容不同」是数据被
            // 破坏或索引被错写的强信号,正是这个功能最该抓出来的一类。
            let same_body = l.deleted == r.deleted
                && (l.deleted || (l.size == r.size && content_digest(&l.blocks) == r.digest));
            if same_body {
                counts.in_sync += 1;
                continue;
            }
            push(
                DiffItem {
                    path: path.to_string(),
                    kind: DiffKind::ContentMismatch,
                    local: Some(local_side(l)),
                    remote: Some(remote_side(r)),
                    rule: None,
                    hard: None,
                    disk: None,
                },
                &mut counts,
            );
            continue;
        }
        let kind = match relation {
            FileStateRelation::LocalNewer => DiffKind::LocalNewer,
            FileStateRelation::RemoteNewer => DiffKind::RemoteNewer,
            FileStateRelation::Conflict => DiffKind::Conflict,
            FileStateRelation::Equal => continue,
        };
        push(
            DiffItem {
                path: path.to_string(),
                kind,
                local: Some(local_side(l)),
                remote: Some(remote_side(r)),
                rule: None,
                hard: None,
                disk: None,
            },
            &mut counts,
        );
    }

    items.sort_by(|a, b| {
        a.kind
            .rank()
            .cmp(&b.kind.rank())
            .then_with(|| a.path.cmp(&b.path))
    });

    FolderDiff {
        items,
        counts,
        local_total: local.len(),
        remote_total: remote.len(),
        remote_rules_known: remote_rules.is_some(),
    }
}

/// 对本机侧的差异项做一次盘上复核:索引声明存在、但盘上没了(或大小不符)。
/// 与索引不一致说明索引陈旧(daemon 离线期间的改动未扫到),而不是两端不同步 ——
/// 这两种结论的处置方式完全不同,所以要在报告里分开。
///
/// 只读 stat,越界路径(理论上不该出现)直接跳过而非按「盘上没有」处理,免得把
/// 一份被篡改的快照显示成「你的文件不见了」。
pub fn check_diff_against_disk(root: &Path, items: &mut [DiffItem]) {
    let Ok(base) = std::path::absolute(root) else {
        return;
    };
    for item in items.iter_mut() {
        let Some(want) = &item.local else { continue };
        if want.deleted {
            continue;
        }
        let Ok(abs) = std::path::absolute(base.join(&item.path)) else {
            continue;
        };
        // 越界闸门:必须是 base 本身或其子路径。
        if abs != base && !abs.starts_with(&base) {
            continue;
        }
        item.disk = Some(match std::fs::metadata(&abs) {
            Ok(meta) if meta.len() == want.size => DiskState::Ok,
            Ok(_) => DiskState::SizeDiffers,
            Err(_) => DiskState::Missing,
        });
    }
}

/// 差异总数(不含 in-sync)。
pub fn diff_total(counts: &DiffCounts) -> usize {
    counts.total()
}

/// 把 diff 结果落成 JSON(路由响应体)。
pub fn to_json_value(diff: &FolderDiff) -> serde_json::Value {
    serde_json::to_value(diff).unwrap_or(serde_json::Value::Null)
}

/// 忽略规则集:从若干行构建(调用方负责把内置默认行与用户 `.syncxignore` 拼好)。
pub fn ruleset_from_lines(lines: &[String]) -> IgnoreRuleset {
    IgnoreRuleset::from_lines(lines)
}

/* ------------------------------ 终端呈现 ------------------------------ */

/// 传输进度的三项计数。只取呈现需要的三个字段(`sending`/`receiving`/`pending`),
/// 速率与文件清单不进报告。
#[derive(Debug, Clone, Copy, Default, serde::Deserialize)]
pub struct ProgressCounts {
    pub pending: usize,
    pub sending: usize,
    pub receiving: usize,
}

impl ProgressCounts {
    /// 「此刻真的有传输在跑」。空闲时三项全 0,报告不该因此多一句提示。
    fn transferring(&self) -> bool {
        self.pending + self.sending + self.receiving > 0
    }
}

/// 一次对比的完整输入(对应 Node 的 `FolderDiffResult`)。
pub struct DiffReport<'a> {
    pub folder_id: &'a str,
    pub folder_path: &'a str,
    /// 本机设备 id:版本向量里显示成「本机」,对端显示成「对端」。
    pub local_device_id: &'a str,
    pub device_id: &'a str,
    pub device_version: Option<&'a str>,
    pub device_hostname: Option<&'a str>,
    /// 本机记录的该对端可达地址(`ws://ip:port`)。
    pub device_url: Option<&'a str>,
    pub local_hostname: &'a str,
    pub local_addresses: &'a [String],
    /// 对端快照的收齐时刻(毫秒)。
    pub remote_at: i64,
    pub diff: &'a FolderDiff,
    pub local_progress: Option<ProgressCounts>,
    pub remote_progress: Option<ProgressCounts>,
}

/// 组内最多列多少条,其余折叠成一句「还有 N 条」。
const MAX_PER_GROUP: usize = 20;

/// 本地时区的 `YYYY-MM-DD HH:mm:ss`。
fn format_time(ts: i64) -> String {
    use chrono::{Local, TimeZone};
    match Local.timestamp_millis_opt(ts).single() {
        Some(moment) => moment.format("%Y-%m-%d %H:%M:%S").to_string(),
        None => String::from("—"),
    }
}

/// 「刚刚 / N 分钟前 / N 小时前 / N 天前」。
fn format_ago(ts: i64, now: i64) -> String {
    let seconds = ((now - ts).max(0) + 500) / 1000;
    if seconds < 60 {
        "刚刚".to_string()
    } else if seconds < 3600 {
        format!("{} 分钟前", seconds / 60)
    } else if seconds < 86_400 {
        format!("{} 小时前", seconds / 3600)
    } else {
        format!("{} 天前", seconds / 86_400)
    }
}

/// 版本向量 → `本机:2 对端:1`(第三个设备的贡献原样显示其 id)。
fn format_version(version: &[(String, u64)], local_device_id: &str, remote_device_id: &str) -> String {
    if version.is_empty() {
        return "无版本".to_string();
    }
    version
        .iter()
        .map(|(device, count)| {
            let label = if device == local_device_id {
                "本机"
            } else if device == remote_device_id {
                "对端"
            } else {
                device.as_str()
            };
            format!("{label}:{count}")
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// 一行的单侧描述:`大小 · 摘要前 8 位 · 版本`。
fn format_side(side: Option<&DiffSide>, local_device_id: &str, remote_device_id: &str) -> String {
    let Some(side) = side else {
        return "无".to_string();
    };
    let size = if side.deleted {
        "已删除".to_string()
    } else {
        format!("{}B", side.size)
    };
    let digest = if side.digest.is_empty() {
        "—".to_string()
    } else {
        side.digest.chars().take(8).collect()
    };
    format!(
        "{size} · {digest} · {}",
        format_version(&side.version, local_device_id, remote_device_id)
    )
}

fn disk_note(item: &DiffItem) -> &'static str {
    match item.disk {
        Some(DiskState::Missing) => "  [⚠ 本机盘上已无此文件:索引陈旧,不是两端不同步]",
        Some(DiskState::SizeDiffers) => "  [⚠ 本机盘上大小与索引不符:索引陈旧]",
        _ => "",
    }
}

/// `ws://a.b.c.d:22000` → `a.b.c.d:22000`。终端里协议前缀是噪声。
fn strip_ws(url: &str) -> &str {
    url.strip_prefix("ws://").unwrap_or(url)
}

/// 把一次对比渲染成待打印的行。文本与 Node 的 `formatFolderDiff` 逐字一致。
pub fn format_folder_diff(report: &DiffReport<'_>) -> Vec<String> {
    format_folder_diff_with(report, MAX_PER_GROUP)
}

/// 同上,组内上限可调(测试用)。
pub fn format_folder_diff_with(report: &DiffReport<'_>, max_per_group: usize) -> Vec<String> {
    let local_device_id = report.local_device_id;
    let remote_device_id = report.device_id;
    let diff = report.diff;
    let now = report.remote_at;
    let mut lines: Vec<String> = Vec::new();

    let version_suffix = match report.device_version {
        Some(version) => format!(" (syncx {version})"),
        None => String::new(),
    };
    lines.push(format!(
        "对比 {} ↔ {}{version_suffix}",
        report.folder_path, report.device_id
    ));
    lines.push(format!("目录 id {}", report.folder_id));
    lines.push(format!(
        "对端快照取自 {}({}) · 本机索引 {} 条 · 对端 {} 条 · 双方一致 {} 条",
        format_time(report.remote_at),
        format_ago(report.remote_at, now),
        diff.local_total,
        diff.remote_total,
        diff.counts.in_sync
    ));

    // 设备身份:主机名 + IP。「我到底在跟哪台机器比」比设备 id 好认得多。
    let local_where = std::iter::once(report.local_hostname.to_string())
        .chain(report.local_addresses.iter().cloned())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" · ");
    let remote_where = [
        report.device_hostname.map(|value| value.to_string()),
        report.device_url.map(|value| strip_ws(value).to_string()),
    ]
    .into_iter()
    .flatten()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join(" · ");
    lines.push(format!(
        "设备 {local_device_id} = 本机{},{} = 对端{}",
        if local_where.is_empty() {
            String::new()
        } else {
            format!("({local_where})")
        },
        report.device_id,
        if remote_where.is_empty() {
            String::new()
        } else {
            format!("({remote_where})")
        }
    ));

    if let Some(progress) = report.local_progress {
        if progress.transferring() {
            lines.push(format!(
                "[提示] 本机此刻在传输(发送 {} · 接收 {} · 待处理 {}),报告可能含传输中的中间态",
                progress.sending, progress.receiving, progress.pending
            ));
        }
    }
    if let Some(progress) = report.remote_progress {
        if progress.transferring() {
            lines.push(format!(
                "[提示] 对端此刻在传输(发送 {} · 接收 {} · 待处理 {}),报告可能含传输中的中间态",
                progress.sending, progress.receiving, progress.pending
            ));
        }
    }
    if !diff.remote_rules_known {
        lines.push(
            "[提示] 对端未提供忽略规则(版本较旧),「规则使然」的差异无法区分,已按普通差异计入"
                .to_string(),
        );
    }

    let total = diff_total(&diff.counts);
    if total == 0 {
        lines.push(String::new());
        lines.push("✔ 没有差异:两端同一目录 id 的内容一致。".to_string());
        return lines;
    }

    let by_kind = |kind: DiffKind| -> Vec<&DiffItem> {
        diff.items.iter().filter(|item| item.kind == kind).collect()
    };

    // 打印一组:标题 + 若干条(path 与两侧描述)。
    let group = |lines: &mut Vec<String>, title: &str, items: Vec<&DiffItem>, two_lines: bool| {
        if items.is_empty() {
            return;
        }
        lines.push(String::new());
        lines.push(format!("{title} {}", items.len()));
        for item in items.iter().take(max_per_group) {
            let local = format_side(item.local.as_ref(), local_device_id, remote_device_id);
            let remote = format_side(item.remote.as_ref(), local_device_id, remote_device_id);
            lines.push(format!("  {}{}", item.path, disk_note(item)));
            if two_lines {
                lines.push(format!("      本机 {local}"));
                lines.push(format!("      对端 {remote}"));
            } else {
                lines.push(format!("      本机 {local}   对端 {remote}"));
            }
        }
        if items.len() > max_per_group {
            lines.push(format!("  … 还有 {} 条", items.len() - max_per_group));
        }
    };

    group(
        &mut lines,
        "✕ 内容错位 —— 版本向量相同但内容不一致(正常不该出现,优先查这类)",
        by_kind(DiffKind::ContentMismatch),
        true,
    );
    group(
        &mut lines,
        "⚠ 冲突 —— 两边都改过,看 .sync-conflict-* 副本",
        by_kind(DiffKind::Conflict),
        true,
    );
    group(
        &mut lines,
        "→ 待推送(本机较新)—— 长期不变说明推送卡住",
        by_kind(DiffKind::LocalNewer),
        false,
    );
    group(
        &mut lines,
        "← 待拉取(对端较新)—— 接收模式的目录里这属正常",
        by_kind(DiffKind::RemoteNewer),
        false,
    );

    let ignored_here = by_kind(DiffKind::IgnoredLocally);
    let ignored_there = by_kind(DiffKind::IgnoredRemotely);
    if !ignored_here.is_empty() || !ignored_there.is_empty() {
        lines.push(String::new());
        lines.push(format!(
            "· 规则使然的差异 {} —— 不是故障(两端按各自的忽略规则安静分叉)",
            ignored_here.len() + ignored_there.len()
        ));
        for (title, items) in [
            (
                "  本机忽略(对端有、本机不收) ",
                ignored_here.as_slice(),
            ),
            (
                "  对端忽略(本机有、对端不收) ",
                ignored_there.as_slice(),
            ),
        ] {
            if items.is_empty() {
                continue;
            }
            lines.push(format!("{title}{}", items.len()));
            for item in items.iter().take(max_per_group) {
                let rule = item.rule.as_deref().unwrap_or("?");
                let hard = if item.hard == Some(true) {
                    "(硬忽略,不可解除)"
                } else {
                    ""
                };
                lines.push(format!("    {}  ← 规则 `{rule}`{hard}", item.path));
            }
            if items.len() > max_per_group {
                lines.push(format!("    … 还有 {} 条", items.len() - max_per_group));
            }
        }
    }

    lines.push(String::new());
    lines.push(format!(
        "差异合计 {total}:内容错位 {} · 冲突 {} · 待推送 {} · 待拉取 {} · 规则使然 {}",
        diff.counts.content_mismatch,
        diff.counts.conflict,
        diff.counts.local_newer,
        diff.counts.remote_newer,
        diff.counts.ignored_locally + diff.counts.ignored_remotely
    ));
    if diff.counts.content_mismatch > 0 {
        lines.push(
            "提示:内容错位是索引与内容被错写的信号;处置办法是让两端重新比对同一份内容(重传该文件)。"
                .to_string(),
        );
    }
    lines
}

/* --------------------------- 控制 API 响应回读 --------------------------- */

/// `/api/folders/diff` 的响应体(**拥有所有权**的版本)。
///
/// 对比报告里的字段大多是缺省即无:旧版本 daemon 不回 `deviceVersion` / `deviceHostname`,
/// 不在传输时也不回 `localProgress` / `remoteProgress`,所以除了标识与快照时刻,
/// 其余一律按「缺省 = 未知」解析,而不是要求字段齐全。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiffResponseBody {
    folder_id: String,
    folder_path: String,
    device_id: String,
    #[serde(default)]
    device_version: Option<String>,
    #[serde(default)]
    device_hostname: Option<String>,
    #[serde(default)]
    device_url: Option<String>,
    local_hostname: String,
    #[serde(default)]
    local_addresses: Vec<String>,
    remote_at: i64,
    diff: FolderDiff,
    #[serde(default)]
    local_progress: Option<ProgressCounts>,
    #[serde(default)]
    remote_progress: Option<ProgressCounts>,
}

/// 一份已解析的对比报告:持有字符串,借出 [`DiffReport`] 供渲染。
pub struct ParsedDiffReport {
    body: DiffResponseBody,
}

impl ParsedDiffReport {
    /// 渲染成待打印的行。`local_device_id` 是本机设备 id(版本向量里标成「本机」)。
    pub fn format(&self, local_device_id: &str) -> Vec<String> {
        format_folder_diff(&DiffReport {
            folder_id: &self.body.folder_id,
            folder_path: &self.body.folder_path,
            local_device_id,
            device_id: &self.body.device_id,
            device_version: self.body.device_version.as_deref(),
            device_hostname: self.body.device_hostname.as_deref(),
            device_url: self.body.device_url.as_deref(),
            local_hostname: &self.body.local_hostname,
            local_addresses: &self.body.local_addresses,
            remote_at: self.body.remote_at,
            diff: &self.body.diff,
            local_progress: self.body.local_progress,
            remote_progress: self.body.remote_progress,
        })
    }
}

/// 解析控制 API 的对比响应。失败信息直接面向用户(报告体是 daemon 自己给的,
/// 解析不了说明两个后端的版本对不上,而不是用户操作有误)。
pub fn parse_diff_response(body: &serde_json::Value) -> Result<ParsedDiffReport, String> {
    serde_json::from_value::<DiffResponseBody>(body.clone())
        .map(|body| ParsedDiffReport { body })
        .map_err(|error| format!("无法解析对比结果(daemon 与本机版本可能不一致):{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use syncx_core::ignore::parse_ignore_rules;

    fn ruleset(lines: &[&str]) -> IgnoreRuleset {
        IgnoreRuleset::from_lines(&lines.iter().map(|s| s.to_string()).collect::<Vec<_>>())
    }

    fn entry(path: &str, version: &[(&str, u64)], size: u64, blocks: &[&str]) -> IndexEntry {
        IndexEntry {
            path: path.to_string(),
            version: version.iter().map(|(d, s)| (d.to_string(), *s)).collect(),
            size,
            deleted: false,
            blocks: blocks.iter().map(|s| s.to_string()).collect(),
            cdh: None,
            clens: None,
        }
    }

    fn snapshot(path: &str, version: &[(&str, u64)], size: u64, digest: &str) -> SnapshotEntry {
        SnapshotEntry {
            path: path.to_string(),
            version: version.iter().map(|(d, s)| (d.to_string(), *s)).collect(),
            size,
            deleted: false,
            digest: digest.to_string(),
            mtime: None,
        }
    }

    #[test]
    fn empty_blocks_digest_is_empty() {
        assert_eq!(content_digest(&[]), "");
    }

    #[test]
    fn digest_matches_node_join_semantics() {
        // Node 侧是 `sha256(blocks.join('\n'))`,即 sha256("a\nb")(不是 "ab")
        assert_eq!(
            content_digest(&["a".to_string(), "b".to_string()]),
            "7e18f737311b2dc3b2f269dd78396b0351f14fb66efa879f768cb23181883c78"
        );
    }

    #[test]
    fn equal_versions_same_body_is_in_sync() {
        let mut local = BTreeMap::new();
        local.insert(
            "a.txt".to_string(),
            entry("a.txt", &[("dev1", 1)], 3, &["x"]),
        );
        let remote = vec![snapshot("a.txt", &[("dev1", 1)], 3, &content_digest(&["x".to_string()]))];
        let rules = ruleset(&[]);
        let diff = build_folder_diff(FolderDiffInput {
            local: &local,
            remote: &remote,
            local_rules: &rules,
            remote_rules: Some(&rules),
        });
        assert!(diff.items.is_empty());
        assert_eq!(diff.counts.in_sync, 1);
        assert_eq!(diff.local_total, 1);
        assert_eq!(diff.remote_total, 1);
        assert!(diff.remote_rules_known);
    }

    #[test]
    fn equal_versions_different_body_is_content_mismatch() {
        let mut local = BTreeMap::new();
        local.insert("a.txt".to_string(), entry("a.txt", &[("dev1", 1)], 3, &["x"]));
        let remote = vec![snapshot("a.txt", &[("dev1", 1)], 3, "deadbeef")];
        let rules = ruleset(&[]);
        let diff = build_folder_diff(FolderDiffInput {
            local: &local,
            remote: &remote,
            local_rules: &rules,
            remote_rules: Some(&rules),
        });
        assert_eq!(diff.items.len(), 1);
        assert_eq!(diff.items[0].kind, DiffKind::ContentMismatch);
        assert_eq!(diff.counts.content_mismatch, 1);
    }

    #[test]
    fn single_sided_tombstones_count_as_in_sync() {
        let mut local = BTreeMap::new();
        let mut tomb = entry("gone.txt", &[("dev1", 2)], 0, &[]);
        tomb.deleted = true;
        local.insert("gone.txt".to_string(), tomb);
        let rules = ruleset(&[]);
        let diff = build_folder_diff(FolderDiffInput {
            local: &local,
            remote: &[],
            local_rules: &rules,
            remote_rules: Some(&rules),
        });
        assert!(diff.items.is_empty());
        assert_eq!(diff.counts.in_sync, 1);
    }

    #[test]
    fn locally_ignored_remote_entry_is_not_a_sync_failure() {
        let local = BTreeMap::new();
        let remote = vec![snapshot("node_modules/x.js", &[("dev1", 1)], 1, "aa")];
        let rules = ruleset(&["node_modules/", "*.log"]);
        let diff = build_folder_diff(FolderDiffInput {
            local: &local,
            remote: &remote,
            local_rules: &rules,
            remote_rules: Some(&rules),
        });
        assert_eq!(diff.items.len(), 1);
        assert_eq!(diff.items[0].kind, DiffKind::IgnoredLocally);
        assert_eq!(diff.items[0].rule.as_deref(), Some("node_modules/"));
        assert!(diff.items[0].local.is_none());
    }

    #[test]
    fn remote_rules_unknown_reports_local_newer() {
        let mut local = BTreeMap::new();
        local.insert("debug.log".to_string(), entry("debug.log", &[("dev1", 1)], 1, &["x"]));
        let rules = ruleset(&[]);
        let diff = build_folder_diff(FolderDiffInput {
            local: &local,
            remote: &[],
            local_rules: &rules,
            remote_rules: None,
        });
        assert_eq!(diff.items[0].kind, DiffKind::LocalNewer);
        assert!(!diff.remote_rules_known);
    }

    #[test]
    fn ignored_remotely_uses_remote_rules() {
        let mut local = BTreeMap::new();
        local.insert("debug.log".to_string(), entry("debug.log", &[("dev1", 1)], 1, &["x"]));
        let rules = ruleset(&[]);
        let remote_rules = ruleset(&["*.log"]);
        let diff = build_folder_diff(FolderDiffInput {
            local: &local,
            remote: &[],
            local_rules: &rules,
            remote_rules: Some(&remote_rules),
        });
        assert_eq!(diff.items[0].kind, DiffKind::IgnoredRemotely);
        assert_eq!(diff.items[0].rule.as_deref(), Some("*.log"));
    }

    #[test]
    fn items_sort_by_kind_then_path() {
        let mut local = BTreeMap::new();
        local.insert("b.txt".to_string(), entry("b.txt", &[("dev1", 5)], 1, &["x"]));
        local.insert("a.txt".to_string(), entry("a.txt", &[("dev1", 5)], 1, &["x"]));
        local.insert("c.txt".to_string(), entry("c.txt", &[("dev1", 5)], 1, &["x"]));
        let remote = vec![
            snapshot("b.txt", &[("other", 9)], 1, "aa"),
            snapshot("a.txt", &[("other", 9)], 1, "aa"),
            snapshot("c.txt", &[("other", 9)], 1, "aa"),
        ];
        let rules = ruleset(&[]);
        let diff = build_folder_diff(FolderDiffInput {
            local: &local,
            remote: &remote,
            local_rules: &rules,
            remote_rules: Some(&rules),
        });
        // 版本交叉 → conflict,三条都同 kind,按 path 升序
        let paths: Vec<&str> = diff.items.iter().map(|i| i.path.as_str()).collect();
        assert_eq!(paths, vec!["a.txt", "b.txt", "c.txt"]);
        assert_eq!(diff.counts.conflict, 3);
    }

    #[test]
    fn hard_ignored_paths_are_flagged() {
        let local = BTreeMap::new();
        let remote = vec![snapshot(".git/config", &[("dev1", 1)], 1, "aa")];
        let rules = ruleset(&[".git/"]);
        let diff = build_folder_diff(FolderDiffInput {
            local: &local,
            remote: &remote,
            local_rules: &rules,
            remote_rules: Some(&rules),
        });
        assert_eq!(diff.items[0].kind, DiffKind::IgnoredLocally);
        assert_eq!(diff.items[0].hard, Some(true));
    }

    #[test]
    fn disk_check_reports_missing_and_size_drift() {
        let dir = std::env::temp_dir().join(format!(
            "syncx-cli-diff-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("ok.txt"), "abc").unwrap();
        std::fs::write(dir.join("short.txt"), "a").unwrap();

        let mut local = BTreeMap::new();
        local.insert("ok.txt".to_string(), entry("ok.txt", &[("dev1", 5)], 3, &["x"]));
        local.insert("short.txt".to_string(), entry("short.txt", &[("dev1", 5)], 3, &["x"]));
        local.insert("gone.txt".to_string(), entry("gone.txt", &[("dev1", 5)], 3, &["x"]));
        let rules = ruleset(&[]);
        let mut diff = build_folder_diff(FolderDiffInput {
            local: &local,
            remote: &[],
            local_rules: &rules,
            remote_rules: Some(&rules),
        });
        check_diff_against_disk(&dir, &mut diff.items);
        let by_path: BTreeMap<&str, Option<DiskState>> =
            diff.items.iter().map(|i| (i.path.as_str(), i.disk)).collect();
        assert_eq!(by_path["ok.txt"], Some(DiskState::Ok));
        assert_eq!(by_path["short.txt"], Some(DiskState::SizeDiffers));
        assert_eq!(by_path["gone.txt"], Some(DiskState::Missing));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parse_ignore_rules_still_available() {
        assert!(parse_ignore_rules(&["!keep".to_string()])[0].negated);
    }
}
