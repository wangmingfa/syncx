//! 本机索引条目:核心条目 + 只有本机才有的两个字段。
//!
//! `syncx-core` 的 `IndexEntry` 刻意不含 `mtime` / `placeholder` —— 它们不参与
//! 版本关系判定,属于「落盘与本机状态」而不是「协议语义」。daemon 层需要它们:
//!
//!  - `mtime`:扫描免哈希快速路径的判据(见 [`StoredEntry::is_unchanged`]),
//!    同时随索引上线供对端 `newest-wins` 冲突策略比较;
//!  - `placeholder`:按需同步的占位条目,盘上没有实体文件,不进 wire。

use syncx_core::plan::IndexEntry;
use syncx_core::version::VersionVector;

/// 扫描免哈希快速路径的容忍窗口(毫秒)。
///
/// 历史语义:FAT32 的 mtime 精度是 2 秒,免哈希判定曾对窗口内的 mtime 差直接
/// 免检 —— 那会把「写入竞态落在窗口内」的真实改动永久吞掉(2026-11-09 MoonUI
/// 实测,见 [`StoredEntry::is_unchanged`] 注释)。2026-11-09 起免检收紧为
/// mtime 完全一致,窗口内的抖动改走「内容哈希对比 + 写回新 mtime」收敛,本
/// 常量仅保留作跨后端口径标记(取值仍与 Node 侧 `src/scanner.ts` 一致)。
pub const MTIME_TOLERANCE_MS: i64 = 2000;

/// 索引里的一条本机条目。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredEntry {
    pub path: String,
    pub version: VersionVector,
    pub size: u64,
    pub deleted: bool,
    pub blocks: Vec<String>,
    pub cdh: Option<Vec<String>>,
    pub clens: Option<Vec<u64>>,
    pub mtime: Option<i64>,
    pub placeholder: bool,
}

impl StoredEntry {
    /// 从协议条目构造(落地/占位时用)。`mtime` 与 `placeholder` 由调用方给。
    pub fn new(core: IndexEntry, mtime: Option<i64>, placeholder: bool) -> Self {
        Self {
            path: core.path,
            version: core.version,
            size: core.size,
            deleted: core.deleted,
            blocks: core.blocks,
            cdh: core.cdh,
            clens: core.clens,
            mtime,
            placeholder,
        }
    }

    /// 投影成纯逻辑内核条目(规划只看这些字段)。
    pub fn core(&self) -> IndexEntry {
        IndexEntry {
            path: self.path.clone(),
            version: self.version.clone(),
            size: self.size,
            deleted: self.deleted,
            blocks: self.blocks.clone(),
            cdh: self.cdh.clone(),
            clens: self.clens.clone(),
        }
    }

    /// CDC 视图是否可用:与 Node 的 `cdcUsable` / `IndexEntry.has_cdc_view` 同口径 ——
    /// **等长且非空**。只判 `is_some()` 会把「一端为空数组」的坏数据当成有视图。
    pub fn has_cdc_view(&self) -> bool {
        match (&self.cdh, &self.clens) {
            (Some(h), Some(l)) => !h.is_empty() && h.len() == l.len(),
            _ => false,
        }
    }

    /// 盘上这份文件是否与条目「未改动」。
    ///
    /// 与 Node 的 `isUnchanged` 逐条对齐:尺寸必须相等;`mtime` 缺失一律视为
    /// **可能已改**(没有时间戳就没有免哈希的依据);mtime **完全一致**才算未改。
    /// 曾经的「差在容忍窗口内即免检」会把窗口内的真实改动永久吞掉 —— 扫描落在
    /// 一次写入完成前(读到中间态且 size 恰好一致)之后,每轮 |mtime 差| 都只有
    /// 几十 ms,条目再也不重哈希,本机索引永远宣告旧哈希,对端索块被哈希闸门
    /// 拒收,传输死锁(2026-11-09 MoonUI 两文件实测)。窗口内的抖动(FAT32 粒度、
    /// touch、写入竞态)落到调用方的「内容哈希对比 + 写回新 mtime」路径 —— 一次
    /// 整文件哈希后 diff 归零,不会每轮重复付。drift 哨兵与本函数共用同一口径,
    /// 各写一遍的话口径不一致,哨兵就会开始报假案。
    pub fn is_unchanged(&self, size: u64, mtime_ms: i64) -> bool {
        if size != self.size {
            return false;
        }
        let Some(prev) = self.mtime else {
            return false;
        };
        mtime_ms == prev
    }

    /// 该条目能否上线宣告。占位条目盘上没有实体,宣告等于谎称「我供得出内容」。
    pub fn is_announceable(&self) -> bool {
        !self.placeholder
    }
}

/// 墓碑条目:版本向量 +1、内容清空。CDC 视图一并清掉,留着只会白白撑大索引与线路。
pub fn tombstone_of(entry: &StoredEntry, device_id: &str) -> StoredEntry {
    StoredEntry {
        path: entry.path.clone(),
        version: syncx_core::version::increment_version(&entry.version, device_id),
        size: 0,
        deleted: true,
        blocks: Vec::new(),
        cdh: None,
        clens: None,
        mtime: None,
        placeholder: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(mtime: Option<i64>) -> StoredEntry {
        StoredEntry {
            path: "a".into(),
            version: VersionVector::new(),
            size: 12345,
            deleted: false,
            blocks: vec!["h".into()],
            cdh: None,
            clens: None,
            mtime,
            placeholder: false,
        }
    }

    #[test]
    fn is_unchanged_requires_exact_mtime() {
        // 2026-11-09 修复回归:容忍窗口内的 mtime 抖动不得免检 —— 窗口免检曾把
        // 写入竞态的真实改动永久吞掉(扫描读到中间态且 size 恰好一致),本机索引
        // 永远宣告旧哈希,对端索块被哈希闸门拒收,传输死锁
        let e = entry(Some(1_762_000_000_000));
        assert!(e.is_unchanged(12345, 1_762_000_000_000));
        assert!(!e.is_unchanged(12345, 1_762_000_000_000 - 1999));
        assert!(!e.is_unchanged(12345, 1_762_000_000_000 + 2000));
        assert!(!e.is_unchanged(12344, 1_762_000_000_000));
        assert!(!entry(None).is_unchanged(12345, 1_762_000_000_000));
    }
}
