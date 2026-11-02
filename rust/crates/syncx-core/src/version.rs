//! 版本向量。与 Node 侧 `src/version.ts` 逐函数对应。
//!
//! 用 `BTreeMap` 而非 `HashMap`:版本向量会进快照与 fixture 比对,顺序不确定
//! 会让断言随机失败。代价是插入慢一点点——这条路径不在热循环里。

use std::collections::BTreeMap;

pub type VersionVector = BTreeMap<String, u64>;

/// 两个版本向量的偏序关系,逐字对应 Node 侧 `VersionRelation`。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VersionRelation {
    Equal,
    ANewer,
    BNewer,
    /// 互不包含:并发修改,即冲突。
    Concurrent,
}

/// 比较两个版本向量。
///
/// 语义:逐设备取两边的计数,A 处处不小于 B 则 A 支配 B,反之亦然;
/// 双方都支配即相等,都不支配即并发。
pub fn compare_versions(a: &VersionVector, b: &VersionVector) -> VersionRelation {
    let mut a_dominates = true;
    let mut b_dominates = true;

    // BTreeMap 的有序迭代让遍历顺序天然确定(与 Node 用 Set 遍历同一集合)。
    let mut devices: Vec<&String> = a.keys().chain(b.keys()).collect();
    devices.sort();
    devices.dedup();

    for device in devices {
        let a_count = a.get(device).copied().unwrap_or(0);
        let b_count = b.get(device).copied().unwrap_or(0);
        if a_count < b_count {
            a_dominates = false;
        }
        if b_count < a_count {
            b_dominates = false;
        }
    }

    match (a_dominates, b_dominates) {
        (true, true) => VersionRelation::Equal,
        (true, false) => VersionRelation::ANewer,
        (false, true) => VersionRelation::BNewer,
        (false, false) => VersionRelation::Concurrent,
    }
}

/// 按设备取较大计数合并两个版本向量,返回新向量,不修改输入。
pub fn merge_versions(a: &VersionVector, b: &VersionVector) -> VersionVector {
    let mut merged = a.clone();
    for (device, count) in b {
        let slot = merged.entry(device.clone()).or_insert(0);
        *slot = (*slot).max(*count);
    }
    merged
}

/// 把某设备的计数 +1,返回新向量。
pub fn increment_version(vector: &VersionVector, device_id: &str) -> VersionVector {
    let mut next = vector.clone();
    let slot = next.entry(device_id.to_string()).or_insert(0);
    *slot += 1;
    next
}
