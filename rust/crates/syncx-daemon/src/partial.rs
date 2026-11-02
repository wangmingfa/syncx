//! 断点续传的落盘中间态。对应 Node 侧 `src/partial-store.ts`。
//!
//! 在途内容写进 `<target>.syncx-tmp`,位图与条目指纹写进 `<target>.syncx-partial`
//! (JSON sidecar),成对出现、成对消失。
//!
//! **为什么是 sidecar 而不是把位图塞进 tmp 头部**:tmp 的内容必须**就是**最终文件
//! 字节(rename 即落地,不做二次搬运),任何头部都会污染它。
//!
//! **为什么指纹只看内容不看版本**:续传关心的是「已写进 tmp 的那些块,对当前条目还
//! 成不成立」。块哈希列表 + CDC 视图 + 尺寸三者相同,字节布局就相同,版本向量变不变
//! 都无所谓(对端 revert 回旧内容这种「版本变了内容没变」的情况,续传反而是对的)。
//! 反过来内容一变(哪怕一个块),指纹就变,旧 tmp 整份作废 —— 宁可重传,不可错接。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::entry::StoredEntry;

/// 续传中间态文件后缀(与 `.syncx-tmp` 成对;扫描器/文件管理器都必须跳过这两个后缀)。
pub const PARTIAL_SUFFIX: &str = ".syncx-partial";

/// 中间态的保鲜期:超过它就整对回收。
///
/// 为什么必须有回收:接收中止的原因里有一类是「对端根本供不出这些块」(它的编辑器
/// tmp 中间文件进了索引又改名,2026-09-22 事故形态),这种半截 tmp 永远不会有人来续,
/// 也永远不会被宣告出去 —— 不回收就是用户共享目录里一堆没人认领的巨型文件。
/// 取 7 天:比任何合理的断线时长都长(断网一周的 NAS 应该重新规划而不是赌旧位图),
/// 又足够短,不至于把盘占死。
pub const PARTIAL_TTL_MS: i64 = 7 * 24 * 3600 * 1000;

/// 一个目标文件的两个中间态路径:在途内容(tmp)与在途位图(manifest)。
pub struct PartialPaths {
    pub tmp: PathBuf,
    pub manifest: PathBuf,
}

/// 定位 `<target>` 的两个中间态文件。
pub fn partial_paths(target: &Path) -> PartialPaths {
    let tmp = PathBuf::from(format!("{}.syncx-tmp", target.display()));
    let manifest = PathBuf::from(format!("{}{PARTIAL_SUFFIX}", target.display()));
    PartialPaths { tmp, manifest }
}

/// 落盘的中间态清单。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PartialManifest {
    /// 结构版本:将来字段变更时拒绝旧文件(直接作废重传,不做迁移)。
    pub v: u32,
    pub fingerprint: String,
    pub cdc: bool,
    pub slots: usize,
    /// 位图的 base64(每 bit 一个槽位,1 = 该块已正确写入 tmp)。
    pub bitmap: String,
    pub started_at: i64,
    pub updated_at: i64,
}

/// 条目内容指纹:尺寸 + 定长块哈希 + CDC 视图。
///
/// 刻意**不含** version / mtime / path:path 由文件名承载,version 与内容布局无关。
/// 分隔符用 `\u{0}`,与 Node 的 `'\u0000'` 一致 —— 换成逗号会让
/// `blocks=["a,b"]` 与 `blocks=["a","b"]` 撞同一个指纹。
pub fn entry_fingerprint(entry: &StoredEntry) -> String {
    let mut hasher = Sha256::new();
    hasher.update(entry.size.to_string().as_bytes());
    hasher.update([0u8]);
    hasher.update(entry.blocks.join(",").as_bytes());
    hasher.update([0u8]);
    let cdh = entry.cdh.as_ref().map(|h| h.join(",")).unwrap_or_default();
    hasher.update(cdh.as_bytes());
    hasher.update([0u8]);
    let clens = entry
        .clens
        .as_ref()
        .map(|l| {
            l.iter()
                .map(|n| n.to_string())
                .collect::<Vec<_>>()
                .join(",")
        })
        .unwrap_or_default();
    hasher.update(clens.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// 槽位位图:固定槽位数的 bitset,序列化成 base64。
#[derive(Debug, Clone)]
pub struct SlotBitmap {
    slots: usize,
    bytes: Vec<u8>,
}

impl SlotBitmap {
    pub fn new(slots: usize) -> Self {
        Self {
            slots,
            bytes: vec![0u8; slots.div_ceil(8)],
        }
    }

    /// 从 base64 恢复。长度不符直接报错 —— 调用方(`read_manifest`)据此把
    /// 坏 manifest 当成「没有中间态」。
    pub fn from_base64(slots: usize, raw: &str) -> Result<Self, String> {
        use base64::Engine;
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(raw)
            .map_err(|e| format!("位图 base64 非法:{e}"))?;
        let expected = slots.div_ceil(8);
        if decoded.len() != expected {
            return Err(format!(
                "位图长度不符:期望 {expected} 字节,实际 {}",
                decoded.len()
            ));
        }
        Ok(Self {
            slots,
            bytes: decoded,
        })
    }

    pub fn has(&self, index: usize) -> bool {
        if index >= self.slots {
            return false;
        }
        self.bytes[index >> 3] & (1 << (index & 7)) != 0
    }

    pub fn set(&mut self, index: usize) {
        if index >= self.slots {
            return;
        }
        self.bytes[index >> 3] |= 1 << (index & 7);
    }

    /// 清位:续传自检发现某块「位图说写了、盘上内容不对」时,把它退回缺失态重传。
    pub fn clear(&mut self, index: usize) {
        if index >= self.slots {
            return;
        }
        self.bytes[index >> 3] &= !(1 << (index & 7));
    }

    pub fn count(&self) -> usize {
        self.bytes.iter().map(|b| b.count_ones() as usize).sum()
    }

    pub fn full(&self) -> bool {
        self.count() == self.slots
    }

    pub fn to_base64(&self) -> String {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(&self.bytes)
    }
}

/// 读 manifest;不存在 / 损坏 / 结构与期望不符一律返回 `None`(调用方按「无中间态」处理)。
pub fn read_manifest(
    path: &Path,
    fingerprint: &str,
    cdc: bool,
    slots: usize,
) -> Option<PartialManifest> {
    let text = std::fs::read_to_string(path).ok()?;
    let manifest: PartialManifest = serde_json::from_str(&text).ok()?;
    if manifest.v != 1 || manifest.fingerprint != fingerprint {
        return None;
    }
    if manifest.cdc != cdc || manifest.slots != slots {
        return None;
    }
    // 构造一次位图以校验 base64 与长度;坏的就当没有
    SlotBitmap::from_base64(manifest.slots, &manifest.bitmap).ok()?;
    Some(manifest)
}

pub fn write_manifest(path: &Path, manifest: &PartialManifest) -> std::io::Result<()> {
    std::fs::write(path, serde_json::to_string(manifest).unwrap_or_default())
}

/// 成对删除 tmp 与 manifest(作废 / 落地完成后调用)。
///
/// 删不掉也无妨:下次 `begin_receive` 会再试,扫描器也会跳过这两个后缀 ——
/// 所以这里吞掉错误,不让清理失败影响调用方的终态处理。
pub fn remove_partial(target: &Path) {
    let paths = partial_paths(target);
    for path in [paths.tmp, paths.manifest] {
        let _ = std::fs::remove_file(path);
    }
}

/// 当前毫秒时间戳(中间态时间戳用)。测试可注入固定值。
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
