///|
/// 版本向量(与 Node `src/version.ts`、Rust `syncx-core/src/version.rs` 逐函数对应)。
///
/// 语义:逐设备取两边的计数,A 处处不小于 B 则 A 支配 B,反之亦然;
/// 双方都支配即相等,都不支配即并发(冲突)。
///
/// 计数用 Int64:与 daemon 层索引条目(`indexstore.Entry.version`)的落盘形态一致。

///|
/// 版本向量:每设备一条单调计数。
pub type VersionVector = Map[String, Int64]

///|
/// 两个版本向量的偏序关系,逐字对应 Node 侧 `VersionRelation`。
pub(all) enum VersionRelation {
  Equal
  ANewer
  BNewer
  /// 互不包含:并发修改,即冲突。
  Concurrent
} derive(Eq)

///|
pub extend VersionRelation with Eq::{equal, not_equal}

///|
/// 比较两个版本向量。
pub fn compare_versions(
  a : VersionVector,
  b : VersionVector,
) -> VersionRelation {
  let mut a_dominates = true
  let mut b_dominates = true
  // 只在 a 独有的设备上:a 计数 >= 1 > 0 = b 计数,只会压低 b_dominates;
  // 只在 b 独有的设备上反之。遍历两边的键即可覆盖全集,无需显式排序。
  for device, a_count in a {
    match b.get(device) {
      Some(b_count) => {
        if a_count < b_count {
          a_dominates = false
        }
        if b_count < a_count {
          b_dominates = false
        }
      }
      None => b_dominates = false
    }
  }
  for device, b_count in b {
    match a.get(device) {
      Some(_) => ()
      // a 侧计数按 0 处理:0 < b_count(除非 b_count 为 0,等价于无影响)
      None => if b_count > 0 { a_dominates = false }
    }
  }
  match (a_dominates, b_dominates) {
    (true, true) => Equal
    (true, false) => ANewer
    (false, true) => BNewer
    (false, false) => Concurrent
  }
}

///|
/// 按设备取较大计数合并两个版本向量,返回新向量,不修改输入。
pub fn merge_versions(a : VersionVector, b : VersionVector) -> VersionVector {
  let merged = copy_vector(a)
  for device, count in b {
    match merged.get(device) {
      Some(existing) => if count > existing { merged.set(device, count) }
      None => merged.set(device, count)
    }
  }
  merged
}

///|
/// 把某设备的计数 +1,返回新向量。
pub fn increment_version(
  vector : VersionVector,
  device_id : String,
) -> VersionVector {
  let next = copy_vector(vector)
  match next.get(device_id) {
    Some(count) => next.set(device_id, count + 1)
    None => next.set(device_id, 1L)
  }
  next
}

///|
fn copy_vector(v : VersionVector) -> VersionVector {
  let out : VersionVector = Map([])
  for device, count in v {
    out.set(device, count)
  }
  out
}

///|
/// 向量相等(逐键比计数)。`Map` 未派生 `Eq`,测试与 daemon 层断言用。
pub fn vectors_equal(a : VersionVector, b : VersionVector) -> Bool {
  if a.length() != b.length() {
    return false
  }
  for device, count in a {
    match b.get(device) {
      Some(other) => if count != other { return false }
      None => return false
    }
  }
  true
}
