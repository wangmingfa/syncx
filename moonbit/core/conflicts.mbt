///|
/// 冲突副本的识别与反解(冲突收件箱的纯逻辑半边)。对应 Rust `syncx-core/src/ignore.rs`
/// 的冲突副本命名部分与 Node `src/conflicts.ts` 的 `parseConflictCopy`。
///
/// 冲突在盘上的实体是版本向量判撞时生成的 `.sync-conflict-*` 副本:
///   <原路径去扩展名>.sync-conflict-<ts36>[-<seq36>]-<对端设备ID><扩展名>
/// 设备 ID 是 10 位 base32(A-Z2-7,无连字符),因此命名可以无歧义反解:
/// 去掉 `.sync-conflict-…-<设备ID>` 段即原文件路径,设备 ID 即冲突来源。
///
/// Node/Rust 侧的收件箱扫描、回收站落盘等 I/O 部分留在 daemon 层,本包只做判定。

///|
/// 冲突副本命名模式。正则与 Node 侧 `CONFLICT_COPY_RE` 逐字相同 —— 两处漂移会让
/// 「冲突收件箱」与「扫描器」对同一个文件给出不同结论。
pub const CONFLICT_COPY_PATTERN : String = "^(.+)\\.sync-conflict-[0-9a-z]+(?:-[0-9a-z]+)?-([A-Z2-7]{10})(\\.[^./]*)?$"

///|
/// 编译冲突副本正则。编译失败(理论不可达)按「永不匹配」处理,与 Rust 侧
/// `conflict_copy_regex() -> Option<Regex>` 同口径。
fn conflict_copy_regex() -> @regexp.Regexp? {
  Some(@regexp.compile(CONFLICT_COPY_PATTERN)) catch {
    _ => None
  }
}

///|
/// 单段文件名是否为冲突副本。
pub fn is_conflict_copy_name(name : String) -> Bool {
  match conflict_copy_regex() {
    Some(re) =>
      match re.match_(name) {
        Some(_) => true
        None => false
      }
    None => false
  }
}

///|
/// 反解冲突副本文件名 → (原文件名, 来源设备 ID)。非冲突命名返回 `None`。
///
/// 扩展名拼回原文件名尾部:`报告.sync-conflict-ab12-DEV1234ABC.md` →
/// `("报告.md", "DEV1234ABC")`。
pub fn parse_conflict_copy_name(name : String) -> (String, String)? {
  let re = match conflict_copy_regex() {
    Some(re) => re
    None => return None
  }
  let caps = match re.match_(name) {
    Some(m) => m
    None => return None
  }
  let head = match caps.get(1) {
    Some(h) => h.to_owned()
    None => return None
  }
  let device = match caps.get(2) {
    Some(d) => d.to_owned()
    None => return None
  }
  let ext = match caps.get(3) {
    Some(e) => e.to_owned()
    None => ""
  }
  Some(("\{head}\{ext}", device))
}
