//! 接收落地、删除、冲突与版本快照。对应 Node 侧 `src/executor.ts`。
//!
//! 这里是**唯一**动本地文件的那一层,所以两个闸门也只能放在这里:
//!
//!  1. `resolve_share_path` 的符号链接越界校验。对端可以发来任意相对路径,而共享目录
//!     里可能早已有指向目录外的符号链接段 —— 逐段 realpath,任何一段逃出共享根就拒绝。
//!  2. 硬忽略的最后一道闸门。上游(规划、扫描、peer)漏了过滤都不该让对端写进本机
//!     `.git`,也不该让本机 `.git` 被移进回收站。
//!
//! 落地的两条铁律同样在这里:
//!  - **先校验再动本地文件**(`apply_conflict` 先 `preflight`)。校验不过时把本地文件
//!    rename 成冲突副本,会让原路径变空、下一轮扫描生成墓碑把对端也删掉。
//!  - **中间态按需创建**。`begin_receive` 一进来就开文件的话,一条「规划完却一个块都
//!    没收」的接收会在用户目录里留一个没人认领的空 tmp。

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use syncx_core::blockstore::{hash_block, BLOCK_SIZE};
use syncx_core::ignore::is_hard_ignored;
use syncx_core::plan::IndexEntry;
use syncx_core::version::merge_versions;
use syncx_core::{blockstore::ViewHasher, blockstore::FileViews};

use crate::entry::StoredEntry;
use crate::indexstore::{IndexStore, StoreError};
use crate::partial::{
    entry_fingerprint, partial_paths, read_manifest, remove_partial, write_manifest, PartialManifest,
    SlotBitmap,
};
use crate::scanner::blocks_match_on_disk;

/// 组提交节奏:每攒够这么多槽位,先 fsync tmp 再写 manifest。
///
/// 顺序是铁律,不可颠倒 —— manifest 说「这块已在盘上」而字节还没刷盘,崩溃后
/// 续传就会把一个空洞当成好块跳过。取 8:再密就退化成每块一次 fsync。
const PARTIAL_COMMIT_SLOTS: usize = 8;

/// 每路径保留的版本份数上限的默认值(设置页可调,改值后重建执行器生效)。
pub const DEFAULT_VERSIONS_PER_PATH: usize = 10;

/// 执行器错误。
#[derive(Debug, thiserror::Error)]
pub enum ExecutorError {
    #[error("文件操作失败:{0}")]
    Io(#[from] std::io::Error),
    #[error("*引库错误:{0}")]
    Store(#[from] StoreError),
    #[error("越界或不安全的路径:{0}")]
    UnsafePath(String),
    #[error("硬忽略路径:{0}")]
    HardIgnored(String),
    #[error("条目缺少可用的 CDC 视图:{0}")]
    InvalidEntry(String),
    #[error("接收未收齐 {path}:{done}/{slots} 块")]
    Incomplete {
        path: String,
        done: usize,
        slots: usize,
    },
    #[error("内容与条目不符:{0}")]
    ContentMismatch(String),
    #[error("块哈希不符:{path} 第 {index} 块")]
    BlockHashMismatch { path: String, index: usize },
    #[error("文件不存在:{0}")]
    FileNotFound(String),
}

/// 一个在途接收的落盘句柄。
///
/// 块到达即按**最终偏移**随机写进 `<target>.syncx-tmp`,位图与条目指纹落在
/// `<target>.syncx-partial`。内存开销是块级而不是文件级,崩溃后可续传。
pub trait ReceiveHandle: Send {
    /// 该槽位是否已正确写入。
    fn has(&self, index: usize) -> bool;
    /// 已收槽位数。
    fn count(&self) -> usize;
    /// 已收字节数(进度统计)。
    fn bytes(&self) -> usize;
    /// 写入一个槽位(乱序安全)。块校验在这里做 —— 位图一旦说「这块在盘上」就必须是真的对。
    fn append(&mut self, index: usize, data: &[u8]) -> Result<(), ExecutorError>;
    /// 只读检查「现在就能落地」。冲突路径用它做前置判断。
    fn preflight(&self) -> Result<(), ExecutorError>;
    /// 校验 + 版本快照 + rename 落地 + 清中间态,返回落盘 mtime。
    fn finalize(&mut self) -> Result<i64, ExecutorError>;
    /// 放弃:保留中间态供续传,或整份作废。
    fn abort(&mut self, keep_partial: bool);
}

/// 进程内替身:块攒在内存里、不碰磁盘。
///
/// 生产路径永远走磁盘句柄;留这份内存实现的理由与 Node 一致 —— 让调用方不必为
/// 「有没有落盘能力」写分支,它只该关心「收没收到」。
pub struct MemoryReceiveHandle {
    slots: usize,
    got: Vec<bool>,
    done: usize,
    bytes: usize,
    hashes: Vec<String>,
    path: String,
}

impl MemoryReceiveHandle {
    pub fn new(entry: &IndexEntry, cdc: bool) -> Self {
        let hashes = if cdc {
            entry.cdh.clone().unwrap_or_default()
        } else {
            entry.blocks.clone()
        };
        Self {
            slots: hashes.len(),
            got: vec![false; hashes.len()],
            done: 0,
            bytes: 0,
            hashes,
            path: entry.path.clone(),
        }
    }
}

impl ReceiveHandle for MemoryReceiveHandle {
    fn has(&self, index: usize) -> bool {
        self.got.get(index).copied().unwrap_or(false)
    }
    fn count(&self) -> usize {
        self.done
    }
    fn bytes(&self) -> usize {
        self.bytes
    }
    fn append(&mut self, index: usize, data: &[u8]) -> Result<(), ExecutorError> {
        if index >= self.slots || self.got[index] {
            return Ok(());
        }
        if hash_block(data) != self.hashes[index] {
            return Err(ExecutorError::BlockHashMismatch {
                path: self.path.clone(),
                index,
            });
        }
        self.got[index] = true;
        self.done += 1;
        self.bytes += data.len();
        Ok(())
    }
    fn preflight(&self) -> Result<(), ExecutorError> {
        if self.done != self.slots {
            return Err(ExecutorError::Incomplete {
                path: self.path.clone(),
                done: self.done,
                slots: self.slots,
            });
        }
        Ok(())
    }
    fn finalize(&mut self) -> Result<i64, ExecutorError> {
        self.preflight()?;
        Ok(crate::partial::now_ms())
    }
    fn abort(&mut self, _keep_partial: bool) {}
}

/// 槽位布局:每槽的偏移与长度,以及总字节数与最长槽。
///
/// 口径只有两种:CDC 取 `clens` 前缀和,定长取 `BLOCK_SIZE`、末块按 size 收口。
/// `begin_receive` 的随机写落点与 `partial_bytes` 的体积预估**必须共用这一份** ——
/// 各写一遍的话,「盘上已经有多少」就是假的,而假的预估只会让磁盘守卫在该拦时放行。
pub struct SlotLayout {
    pub offsets: Vec<u64>,
    pub lengths: Vec<u64>,
    pub total: u64,
    pub max_len: u64,
}

pub fn slot_layout(entry: &IndexEntry, cdc: bool) -> Result<SlotLayout, ExecutorError> {
    let hashes: &[String] = if cdc {
        entry
            .cdh
            .as_deref()
            .ok_or_else(|| ExecutorError::InvalidEntry(format!("{} 缺少 cdh", entry.path)))?
    } else {
        &entry.blocks
    };
    if cdc && entry.clens.as_ref().map(|l| l.len()) != Some(hashes.len()) {
        return Err(ExecutorError::InvalidEntry(format!(
            "{} 的 clens 与 cdh 不等长",
            entry.path
        )));
    }

    let mut offsets = Vec::with_capacity(hashes.len());
    let mut lengths = Vec::with_capacity(hashes.len());
    let mut total = 0u64;
    let mut max_len = 0u64;
    for i in 0..hashes.len() {
        offsets.push(total);
        let len = if cdc {
            entry.clens.as_ref().expect("上面已校验")[i]
        } else {
            (entry.size - total).min(BLOCK_SIZE as u64)
        };
        lengths.push(len);
        total += len;
        max_len = max_len.max(len);
    }
    Ok(SlotLayout {
        offsets,
        lengths,
        total,
        max_len,
    })
}

/// 执行器共享配置。句柄需要它来收尾(快照 / 修剪 / 落地),故用 `Arc` 共享。
struct ExecutorInner {
    root: PathBuf,
    trash_dir: PathBuf,
    versions_dir: Option<PathBuf>,
    versions_per_path: usize,
}

/// 一个共享目录的本地执行器。
pub struct LocalExecutor {
    inner: Arc<ExecutorInner>,
}

impl LocalExecutor {
    /// `trash_dir` 刻意由调用方传入而不是在共享根下现算:回收站放在共享目录里会在
    /// 用户目录中留下常驻痕迹(并被 `git status` 报成未跟踪文件)。
    /// `versions_dir` 保护「修改」,回收站保护「删除」;缺省不做版本快照。
    pub fn new(
        root: impl Into<PathBuf>,
        trash_dir: impl Into<PathBuf>,
        versions_dir: Option<PathBuf>,
        versions_per_path: Option<usize>,
    ) -> Self {
        Self {
            inner: Arc::new(ExecutorInner {
                root: root.into(),
                trash_dir: trash_dir.into(),
                versions_dir,
                versions_per_path: versions_per_path
                    .unwrap_or(DEFAULT_VERSIONS_PER_PATH)
                    .max(1),
            }),
        }
    }

    /// 共享目录内的相对路径 → 绝对路径(含越界与硬忽略校验)。
    fn resolve_path(&self, rel_path: &str) -> Result<PathBuf, ExecutorError> {
        resolve_share_path(&self.inner.root, rel_path, false)
    }

    /// 冲突副本专用:副本命名本身是硬忽略对象,必须绕过硬忽略闸门,
    /// 但符号链接越界校验**不受影响**。
    fn resolve_conflict_copy_path(&self, rel_path: &str) -> Result<PathBuf, ExecutorError> {
        resolve_share_path(&self.inner.root, rel_path, true)
    }

    /// 开启(或续上)一个在途接收。
    pub fn begin_receive(
        &self,
        entry: &IndexEntry,
        cdc: bool,
    ) -> Result<DiskReceiveHandle, ExecutorError> {
        DiskReceiveHandle::new(Arc::clone(&self.inner), entry, cdc)
    }

    /// 把已收齐的句柄落地并登记索引。
    pub fn finalize_receive(
        &self,
        index: &IndexStore,
        entry: &IndexEntry,
        handle: &mut dyn ReceiveHandle,
    ) -> Result<(), ExecutorError> {
        let mtime = handle.finalize()?;
        // 记录落盘后的 mtime,供扫描免哈希快速跳过未变更文件
        let stored = StoredEntry::new(entry.clone(), Some(mtime), false);
        index.save_entry(&stored)?;
        Ok(())
    }

    /// 磁盘中间态已占的字节。只信 manifest 的位图,不回读验哈希 —— 这里问的是**空间**:
    /// 位图声称的槽位即便随后验失败、退回重传,写的也是同一段区间。
    ///
    /// **绝不返回错误**:一条预估失败掀翻整轮同步是不成比例的代价。
    pub fn partial_bytes(&self, entry: &IndexEntry, cdc: bool) -> u64 {
        let Ok(target) = self.resolve_path(&entry.path) else {
            return 0;
        };
        let paths = partial_paths(&target);
        if !paths.tmp.exists() {
            return 0; // 位图在、tmp 不在 = 没有字节可扣
        }
        let Ok(layout) = slot_layout(entry, cdc) else {
            return 0;
        };
        let Some(prev) = read_manifest(
            &paths.manifest,
            &entry_fingerprint(&StoredEntry::new(entry.clone(), None, false)),
            cdc,
            layout.lengths.len(),
        ) else {
            return 0; // 指纹不符 → 续传会整对作废
        };
        let Ok(bitmap) = SlotBitmap::from_base64(prev.slots, &prev.bitmap) else {
            return 0;
        };
        let mut bytes = 0u64;
        for (i, len) in layout.lengths.iter().enumerate() {
            if bitmap.has(i) {
                bytes += *len;
            }
        }
        // size 是条目自己声明的期望字节数:残骸比它「多」时不认(宁可多估需求)
        bytes.min(entry.size)
    }

    /// 删除:移入回收站而非硬删(2026-09-15 事故前删除不可恢复),再写墓碑。
    pub fn apply_delete(
        &self,
        index: &IndexStore,
        path: &str,
        tombstone: &StoredEntry,
    ) -> Result<(), ExecutorError> {
        let target = self.resolve_path(path)?;
        if target.is_file() {
            move_to_trash(&self.inner, path)?;
        }
        index.save_entry(tombstone)?;
        Ok(())
    }

    /// 双方都改过同一份文件:本地内容保留成 `.sync-conflict-` 副本,远端内容落地。
    pub fn apply_conflict(
        &self,
        index: &IndexStore,
        path: &str,
        local: &StoredEntry,
        remote: &IndexEntry,
        handle: &mut dyn ReceiveHandle,
        remote_device_id: &str,
    ) -> Result<StoredEntry, ExecutorError> {
        // 双方同时删除:只合并版本向量写墓碑,绝不落盘空文件复活删除
        if local.deleted && remote.deleted {
            let merged = StoredEntry {
                path: path.to_string(),
                version: merge_versions(&local.version, &remote.version),
                size: 0,
                deleted: true,
                blocks: Vec::new(),
                cdh: None,
                clens: None,
                mtime: None,
                placeholder: false,
            };
            index.save_entry(&merged)?;
            return Ok(merged);
        }

        let target = self.resolve_path(path)?;

        // 先确认远端内容齐了而且对:校验不过时本地文件保持不动,避免本地被 rename
        // 成冲突副本后原路径变空、下一轮扫描产生墓碑并传播删除。
        handle.preflight()?;

        // 校验通过后才动本地文件:本地内容保留为冲突副本,绝不静默丢弃。
        if target.exists() {
            let copy_name = self.conflict_copy_name(path, remote_device_id);
            std::fs::rename(&target, self.resolve_conflict_copy_path(&copy_name)?)?;
        }

        let mtime = handle.finalize()?;

        // 索引记录合并版本(双方修改都保留),并写入落地后的 mtime
        let landed = StoredEntry {
            path: path.to_string(),
            version: merge_versions(&local.version, &remote.version),
            size: remote.size,
            deleted: false,
            blocks: remote.blocks.clone(),
            cdh: remote.cdh.clone(),
            clens: remote.clens.clone(),
            mtime: Some(mtime),
            placeholder: false,
        };
        index.save_entry(&landed)?;
        Ok(landed)
    }

    /// 冲突自动策略 local-wins / newest-wins:磁盘一字不动,只把合并后的版本向量
    /// 写进索引。合并结果支配双方,对端下一轮会判「本地较新」并主动来拉,收敛由协议完成。
    pub fn apply_conflict_keep_local(
        &self,
        index: &IndexStore,
        local: &StoredEntry,
        remote: &IndexEntry,
    ) -> Result<StoredEntry, ExecutorError> {
        let keep = StoredEntry {
            version: merge_versions(&local.version, &remote.version),
            ..local.clone()
        };
        index.save_entry(&keep)?;
        Ok(keep)
    }

    /// 按需同步:只写索引库(带块哈希的占位条目),文件系统一字不动。
    pub fn apply_placeholder(
        &self,
        index: &IndexStore,
        entry: &IndexEntry,
    ) -> Result<(), ExecutorError> {
        index.save_entry(&StoredEntry::new(entry.clone(), None, true))?;
        Ok(())
    }

    /// 发送前(重新)计算条目:流式算定长块与 CDC 视图,版本向量 +1。
    pub fn apply_send(
        &self,
        index: &IndexStore,
        path: &str,
        device_id: &str,
    ) -> Result<StoredEntry, ExecutorError> {
        let target = self.resolve_path(path)?;
        if !target.is_file() {
            return Err(ExecutorError::FileNotFound(path.to_string()));
        }

        // 流式算视图:定长块与 CDC 块一次读盘一起扫出来。不再整读 —— 整读把整个文件
        // 搬进内存(1.5GB 实测顶爆 V8 堆),这是 Node 侧 `hashFileViews` 的分界点。
        let FileViews {
            size,
            blocks,
            cdh,
            clens,
        } = hash_file_views(&target)?;

        let previous = index.get_entry(path)?;
        let previous_version = previous.map(|e| e.version).unwrap_or_default();
        let version = syncx_core::version::increment_version(&previous_version, device_id);

        let updated = StoredEntry {
            path: path.to_string(),
            version,
            size,
            deleted: false,
            blocks,
            // 空文件没有块可言:cdh/clens 留空,与「无 CDC 视图」同口径
            cdh: if cdh.is_empty() { None } else { Some(cdh) },
            clens: if clens.is_empty() { None } else { Some(clens) },
            mtime: file_mtime_ms(&target),
            placeholder: false,
        };
        index.save_entry(&updated)?;
        Ok(updated)
    }

    /// 接收对端文件前的冷启动保护:本机盘上已有同名文件、但本机索引尚未记录该路径
    /// (目录刚加入 / daemon 刚启动、首扫未跑即遭"热"对端推送)时,把本机原文件保留为
    /// `.sync-conflict-<ts>-<remoteDeviceId>` 副本,让出原路径给对端版本落地。
    ///
    /// 返回 `true` = 已保留副本(原路径已让出)。**路径不安全时返回错误,由调用方
    /// 兜底成「不保护、照常覆盖」**—— 保护只是防丢数据的增强,不该阻断接收。
    pub fn preserve_local_as_conflict(
        &self,
        path: &str,
        remote_device_id: &str,
    ) -> Result<bool, ExecutorError> {
        let target = self.resolve_path(path)?;
        if !target.is_file() {
            return Ok(false);
        }
        let copy_name = self.conflict_copy_name(path, remote_device_id);
        std::fs::rename(&target, self.resolve_conflict_copy_path(&copy_name)?)?;
        Ok(true)
    }

    /// 冲突副本文件名:`.sync-conflict-<ts36>[-<seq36>]-<deviceId><ext>`,
    /// 同一毫秒多次冲突靠序号避碰。
    fn conflict_copy_name(&self, path: &str, remote_device_id: &str) -> String {
        let (base, ext) = split_ext(path);
        let ts = base36(crate::partial::now_ms());
        let mut n = 0usize;
        loop {
            let seq = if n > 0 {
                format!("-{}", base36(n as i64))
            } else {
                String::new()
            };
            let candidate = format!("{base}.sync-conflict-{ts}{seq}-{remote_device_id}{ext}");
            if n >= 1000 || !self.resolve_conflict_copy_path(&candidate).map(|p| p.exists()).unwrap_or(false)
            {
                return candidate;
            }
            n += 1;
        }
    }
}

/* ==================== 磁盘接收句柄 ==================== */

/// 磁盘接收句柄。
pub struct DiskReceiveHandle {
    inner: Arc<ExecutorInner>,
    path: String,
    target: PathBuf,
    tmp: PathBuf,
    manifest: PathBuf,
    fingerprint: String,
    cdc: bool,
    /// 本次口径的块哈希(CDC 或定长)。
    hashes: Vec<String>,
    /// 条目自己的**定长**块哈希:全量闸门一律用它,哪怕本次按 CDC 收。
    expected_blocks: Vec<String>,
    offsets: Vec<u64>,
    bitmap: SlotBitmap,
    bytes: usize,
    started_at: i64,
    file: Option<std::fs::File>,
    dirty: usize,
}

impl DiskReceiveHandle {
    fn new(
        inner: Arc<ExecutorInner>,
        entry: &IndexEntry,
        cdc: bool,
    ) -> Result<Self, ExecutorError> {
        let target = resolve_share_path(&inner.root, &entry.path, false)?;
        let paths = partial_paths(&target);
        let layout = slot_layout(entry, cdc)?;
        let hashes = if cdc {
            entry.cdh.clone().unwrap_or_default()
        } else {
            entry.blocks.clone()
        };
        let fingerprint = entry_fingerprint(&StoredEntry::new(entry.clone(), None, false));
        let slots = hashes.len();

        let mut bitmap = SlotBitmap::new(slots);
        let mut bytes = 0usize;
        let mut started_at = crate::partial::now_ms();

        // 只认「manifest 说得清这份内容」:tmp 长度不做等式校验 —— 条目的声明尺寸与
        // 块实长可能本就不等(旧对端的 size 是它自己看到的),长度不符的槽位在下面的
        // 自检里一律读不满、自动清位,末尾还有 blocks_match_on_disk 兜全量。
        let resumed = read_manifest(&paths.manifest, &fingerprint, cdc, slots)
            .filter(|_| paths.tmp.exists());

        if let Some(prev) = resumed {
            bitmap = SlotBitmap::from_base64(prev.slots, &prev.bitmap)
                .map_err(ExecutorError::InvalidEntry)?;
            started_at = prev.started_at;
            // 续传自检:位图声称已写的槽位逐个回读验哈希。半截块(崩在写中间)、被别的
            // 进程改过的区间都在这里清位退回重传。宁可多读一遍盘,不可把坏块当成已收。
            if let Ok(mut vf) = std::fs::File::open(&paths.tmp) {
                let mut buf = vec![0u8; layout.max_len as usize];
                for i in 0..slots {
                    if !bitmap.has(i) {
                        continue;
                    }
                    // 必须循环读满:单次定位读的短读是 POSIX 允许的正常返回,拿短读去
                    // 验哈希会把**写对了的槽位**误判成坏块清位重传。
                    match read_at_fully(&mut vf, &mut buf[..layout.lengths[i] as usize], layout.offsets[i])
                    {
                        Ok(got) if got == layout.lengths[i] as usize
                            && hash_block(&buf[..got]) == hashes[i] =>
                        {
                            bytes += got;
                        }
                        _ => bitmap.clear(i),
                    }
                }
            } else {
                bitmap = SlotBitmap::new(slots);
            }
        }

        Ok(Self {
            inner,
            path: entry.path.clone(),
            target,
            tmp: paths.tmp,
            manifest: paths.manifest,
            fingerprint,
            cdc,
            hashes,
            expected_blocks: entry.blocks.clone(),
            offsets: layout.offsets,
            bitmap,
            bytes,
            started_at,
            file: None,
            dirty: 0,
        })
    }

    /// 磁盘中间态按需创建:第一个块到达(或确实要落地)才开句柄。
    fn ensure_file(&mut self) -> Result<&mut std::fs::File, ExecutorError> {
        if self.file.is_none() {
            if let Some(parent) = self.target.parent() {
                std::fs::create_dir_all(parent)?;
            }
            // 自认为已有内容 → 不能截断,否则等于把断点续传删了。
            let file = if self.bitmap.count() > 0 {
                std::fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .create(true)
                    .truncate(false)
                    .open(&self.tmp)?
            } else {
                std::fs::File::create(&self.tmp)?
            };
            self.file = Some(file);
        }
        Ok(self.file.as_mut().expect("上面刚创建"))
    }

    /// 关掉写句柄(幂等)。Windows 上句柄不关就 rename / 删不掉。
    fn close_file(&mut self) {
        self.file = None;
    }

    /// 先 fsync 字节,再写位图(见 `PARTIAL_COMMIT_SLOTS`)。
    fn commit(&mut self) {
        if self.dirty == 0 {
            return;
        }
        let Some(file) = self.file.as_ref() else {
            return;
        };
        if file.sync_all().is_err() {
            return;
        }
        let manifest = PartialManifest {
            v: 1,
            fingerprint: self.fingerprint.clone(),
            cdc: self.cdc,
            slots: self.hashes.len(),
            bitmap: self.bitmap.to_base64(),
            started_at: self.started_at,
            updated_at: crate::partial::now_ms(),
        };
        let _ = write_manifest(&self.manifest, &manifest);
        self.dirty = 0;
    }

    /// 定长视图是两种口径共用的正确性依据:CDC 块拼起来就是同一份字节,重切一次
    /// 必然得到 entry.blocks。空文件没有字节可验,直接通过。
    fn content_matches(&self, expected_blocks: &[String]) -> bool {
        // 空文件没有任何块,也没有 tmp 可读 —— 直接判定通过
        expected_blocks.is_empty() || blocks_match_on_disk(&self.tmp, expected_blocks)
    }
}

impl ReceiveHandle for DiskReceiveHandle {
    fn has(&self, index: usize) -> bool {
        self.bitmap.has(index)
    }
    fn count(&self) -> usize {
        self.bitmap.count()
    }
    fn bytes(&self) -> usize {
        self.bytes
    }

    fn append(&mut self, index: usize, data: &[u8]) -> Result<(), ExecutorError> {
        if self.bitmap.has(index) {
            return Ok(()); // 重复响应:幂等,不重写也不重复计数
        }
        let Some(expected) = self.hashes.get(index) else {
            return Err(ExecutorError::BlockHashMismatch {
                path: self.path.clone(),
                index,
            });
        };
        // 落盘前逐块验哈希:位图一旦说「这块已在盘上」就必须是真的对,续传与终验才敢信
        if hash_block(data) != *expected {
            return Err(ExecutorError::BlockHashMismatch {
                path: self.path.clone(),
                index,
            });
        }
        let offset = self.offsets[index];
        {
            let file = self.ensure_file()?;
            file.seek(SeekFrom::Start(offset))?;
            file.write_all(data)?;
        }
        self.bitmap.set(index);
        self.bytes += data.len();
        self.dirty += 1;
        if self.dirty >= PARTIAL_COMMIT_SLOTS || self.bitmap.full() {
            self.commit();
        }
        Ok(())
    }

    fn preflight(&self) -> Result<(), ExecutorError> {
        if !self.bitmap.full() {
            // 还没收齐就落地 = 把空洞当成内容
            return Err(ExecutorError::Incomplete {
                path: self.path.clone(),
                done: self.bitmap.count(),
                slots: self.hashes.len(),
            });
        }
        Ok(())
    }

    fn finalize(&mut self) -> Result<i64, ExecutorError> {
        if !self.bitmap.full() {
            // 还没收齐:中间态**保留**,这条接收本来就还能续
            return Err(ExecutorError::Incomplete {
                path: self.path.clone(),
                done: self.bitmap.count(),
                slots: self.hashes.len(),
            });
        }
        // 位图说齐了但盘上内容不对(块被篡改 / tmp 被动过):整对作废重传。
        // 注意这里必须用**条目自己的定长块**做全量闸门,哪怕本次按 CDC 收的。
        let expected_blocks = self.expected_blocks.clone();
        if !self.content_matches(&expected_blocks) {
            self.close_file();
            remove_partial(&self.target);
            return Err(ExecutorError::ContentMismatch(self.path.clone()));
        }
        // 空文件的接收一个块都没有(不会创建 tmp):落地就是一份空文件,补上创建
        if self.file.is_none() {
            self.ensure_file()?;
        }
        self.close_file();
        snapshot_version(&self.inner, &self.path)?;
        prune_versions(&self.inner, &self.path);
        std::fs::rename(&self.tmp, &self.target)?;
        remove_partial(&self.target); // tmp 已改名,这里真正清掉的是 manifest
        Ok(file_mtime_ms(&self.target).unwrap_or_else(crate::partial::now_ms))
    }

    fn abort(&mut self, keep_partial: bool) {
        // 保留中间态时先把最后一批字节交代干净,否则这段进度在重启后就是白写的。
        // 落地成功后再调必须是无操作:句柄已关、位图已清零。
        if self.file.is_some() {
            if keep_partial {
                self.commit();
            }
            self.close_file();
        }
        if !keep_partial {
            remove_partial(&self.target);
        }
    }
}

/* ==================== 路径与文件工具 ==================== */

/// 解析共享目录内的相对路径,做符号链接越界校验与硬忽略闸门。
///
/// `allow_hard_ignored` 仅供冲突处理链路使用(副本本身就是硬忽略对象);
/// 符号链接越界守卫**不受该选项影响**,永远生效。
pub fn resolve_share_path(
    root: &Path,
    rel_path: &str,
    allow_hard_ignored: bool,
) -> Result<PathBuf, ExecutorError> {
    if !allow_hard_ignored && is_hard_ignored(rel_path) {
        return Err(ExecutorError::HardIgnored(rel_path.to_string()));
    }
    // 词法归一,拒绝绝对路径与越过根的 `..`。协议路径一律 '/' 分隔,但 Windows 调用方
    // 可能传来 '\' —— 两种都要切分,否则整条被当成一个 part,中间段的符号链接校验被绕过。
    let mut parts: Vec<&str> = Vec::new();
    for segment in rel_path.split(['/', '\\']) {
        match segment {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return Err(ExecutorError::UnsafePath(rel_path.to_string()));
                }
            }
            other => parts.push(other),
        }
    }
    let mut abs = root.to_path_buf();
    for part in &parts {
        let component = Path::new(part);
        if component
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
        {
            return Err(ExecutorError::UnsafePath(rel_path.to_string()));
        }
        abs.push(part);
    }

    // 根目录可能不存在(刚配置尚未创建 / 运行中被删除):此时任何候选段也不可能存在
    // (祖先链断了),越界检查自然跳过;根恢复后恢复完整校验。
    let root_real = std::fs::canonicalize(root).ok();
    let Some(root_real) = root_real else {
        return Ok(abs);
    };
    let mut ancestor = root.to_path_buf();
    for part in &parts {
        ancestor.push(part);
        if !ancestor.exists() {
            continue;
        }
        let Ok(resolved) = std::fs::canonicalize(&ancestor) else {
            continue;
        };
        if resolved != root_real && !resolved.starts_with(&root_real) {
            return Err(ExecutorError::UnsafePath(rel_path.to_string()));
        }
    }
    Ok(abs)
}

/// 把待删除文件移入回收站(共享目录之外),保留原相对路径结构。
/// 同文件系统走 rename(瞬时、原子);跨文件系统或文件被占用时退化为拷贝后删 ——
/// 绝不静默丢弃。
fn move_to_trash(inner: &ExecutorInner, rel_path: &str) -> Result<(), ExecutorError> {
    let target = resolve_share_path(&inner.root, rel_path, false)?;
    if !target.is_file() {
        return Ok(());
    }
    std::fs::create_dir_all(&inner.trash_dir)?;
    let stamp = base36(crate::partial::now_ms());
    let mut dest = inner.trash_dir.join(format!("{rel_path}.{stamp}"));
    let mut n = 0usize;
    while dest.exists() {
        n += 1;
        dest = inner
            .trash_dir
            .join(format!("{rel_path}.{stamp}.{n}"));
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if std::fs::rename(&target, &dest).is_err() {
        std::fs::copy(&target, &dest)?;
        std::fs::remove_file(&target)?;
    }
    Ok(())
}

/// 覆盖本机现存文件前把旧内容快照进版本目录。回收站保护「删除」,这里保护「修改」。
/// 快照绝不能让原文件消失:rename 失败退化为拷贝,原文件保持原样随后照常被覆盖。
fn snapshot_version(inner: &ExecutorInner, rel_path: &str) -> Result<(), ExecutorError> {
    let Some(versions_dir) = inner.versions_dir.as_ref() else {
        return Ok(());
    };
    let target = resolve_share_path(&inner.root, rel_path, false)?;
    if !target.is_file() {
        return Ok(());
    }
    std::fs::create_dir_all(versions_dir)?;
    let stamp = base36(crate::partial::now_ms());
    let mut dest = versions_dir.join(format!("{rel_path}.syncx-v-{stamp}"));
    let mut n = 0usize;
    while dest.exists() {
        n += 1;
        dest = versions_dir.join(format!("{rel_path}.syncx-v-{stamp}.{n}"));
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if std::fs::rename(&target, &dest).is_err() {
        std::fs::copy(&target, &dest)?;
    }
    Ok(())
}

/// 同一路径的版本超过上限时删最旧。
///
/// 按文件名排序近似按时间排序 —— stamp 是单调递增的 base36 时间戳,同一路径下字典序
/// 即时间序。版本文件保留了原相对路径的目录结构,所以必须在「relPath 的父目录」里
/// 按 basename 前缀筛 —— 只扫顶层会漏掉所有嵌套路径,上限对它们失效(无界增长)。
fn prune_versions(inner: &ExecutorInner, rel_path: &str) {
    let Some(versions_dir) = inner.versions_dir.as_ref() else {
        return;
    };
    let (dir_rel, name) = match rel_path.rsplit_once('/') {
        Some((dir, name)) => (dir, name),
        None => ("", rel_path),
    };
    let dir = versions_dir.join(dir_rel);
    let prefix = format!("{name}.syncx-v-");
    let mut names: Vec<String> = match std::fs::read_dir(&dir) {
        Ok(entries) => entries
            .flatten()
            .filter_map(|e| e.file_name().to_str().map(|s| s.to_string()))
            .filter(|n| n.starts_with(&prefix))
            .collect(),
        Err(_) => return, // 版本目录还没建等异常:修剪是 best-effort
    };
    if names.len() <= inner.versions_per_path {
        return;
    }
    names.sort();
    let remove_count = names.len() - inner.versions_per_path;
    for name in names.into_iter().take(remove_count) {
        let _ = std::fs::remove_file(dir.join(name)); // 单个失败留给下次快照再试
    }
}

/// 流式计算一份文件的定长块与 CDC 视图(内存峰值 = 一个窗口)。
pub fn hash_file_views(path: &Path) -> std::io::Result<FileViews> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = ViewHasher::new();
    let mut buf = vec![0u8; BLOCK_SIZE];
    loop {
        let read = file.read(&mut buf)?;
        if read == 0 {
            break;
        }
        hasher.push(&buf[..read]);
    }
    Ok(hasher.finish())
}

/// 定位读并循环读满。单次 `read` 的短读是 POSIX 允许的正常返回,不循环就会拿半截
/// 字节去验哈希 —— 那是一条**每次都对不上**的假 drift / 假清位。
fn read_at_fully(file: &mut std::fs::File, buf: &mut [u8], offset: u64) -> std::io::Result<usize> {
    file.seek(SeekFrom::Start(offset))?;
    let mut got = 0usize;
    while got < buf.len() {
        let n = file.read(&mut buf[got..])?;
        if n == 0 {
            break;
        }
        got += n;
    }
    Ok(got)
}

/// 文件的 mtime(*秒)。
pub fn file_mtime_ms(path: &Path) -> Option<i64> {
    let meta = std::fs::metadata(path).ok()?;
    let modified = meta.modified().ok()?;
    modified
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as i64)
}

/// Node `path.extname` 的等价实现(只看 basename 的最后一个点,点开头且无其它点则为空)。
pub fn split_ext(path: &str) -> (&str, &str) {
    let name_start = path.rfind('/').map(|i| i + 1).unwrap_or(0);
    let name = &path[name_start..];
    match name.rfind('.') {
        // 点即首字符且名字里没有别的点(`.gitignore`)→ 无扩展名
        Some(0) | None => (path, ""),
        Some(i) => path.split_at(name_start + i),
    }
}

/// base36 时间戳(与 Node 的 `Date.now().toString(36)` 同形态,仅用于文件名排序)。
fn base36(mut value: i64) -> String {
    const ALPHABET: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value <= 0 {
        return "0".to_string();
    }
    let mut digits = Vec::new();
    while value > 0 {
        digits.push(ALPHABET[(value % 36) as usize]);
        value /= 36;
    }
    digits.reverse();
    String::from_utf8(digits).expect("base36 只含 ASCII")
}

/// 供上层(actor)批量估算入向体积时复用:条目各槽位长度之和。
pub fn slot_lengths(entry: &IndexEntry, cdc: bool) -> Result<Vec<u64>, ExecutorError> {
    Ok(slot_layout(entry, cdc)?.lengths)
}

/// 汇总表:路径 → 条目(规划入口用的形态)。
pub type EntryMap = HashMap<String, IndexEntry>;
