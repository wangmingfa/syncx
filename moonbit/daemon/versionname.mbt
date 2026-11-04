///|
/// 版本与回收站文件名的反解(对应 Node src/rollback.ts 的 parseVersionName /
/// parseTrashName、src/cli.ts 的 versionOriginalPath)。命名由本包执行器的
/// snapshot_version / move_to_trash 生成,形态:
///   - 版本:`<relPath>.syncx-v-<base36 时间戳>[.<n>]`(.n 为同毫秒碰撞序号)
///   - 回收站:`<relPath>.<base36 时间戳>[.<n>]`
/// `.syncx-v-` 是显式标记,恢复/回滚据此无歧义反推原始相对路径;回收站名没有
/// 标记,靠「时间戳段 8–13 位 base36 且 ≥1e11」区分日期尾巴等巧合命名(Node
/// parseTrashName 的守卫逐条对齐)。跨后端互认的前提是命名逐字节一致 ——
/// 改命名必须 Node/MoonBit 两侧同步。

///|
/// 版本后缀标记(版本命名里的显式分隔,见 snapshot_version)。
const VERSION_MARKER : String = ".syncx-v-"

///|
/// base36 时间戳的下限(Node parseTrashName:排除日期后缀等巧合命名的误判;
/// 1e11 ≈ 2001 年的毫秒时间戳)。
const TRASH_TS_FLOOR : Int64 = 100000000000L

///|
fn is_base36_char(c : Char) -> Bool {
  (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z')
}

///|
fn is_digit_char(c : Char) -> Bool {
  c >= '0' && c <= '9'
}

///|
/// chars[start..<end] 的 base36 串 → Int64(调用方保证段内全是 base36 字符)。
fn base36_to_int64(chars : Array[Char], start : Int, end : Int) -> Int64 {
  let mut v : Int64 = 0L
  for k in start..<end {
    let c = chars[k]
    let d : Int64 = if c <= '9' {
      (c.to_int() - '0'.to_int()).to_int64()
    } else {
      (c.to_int() - 'a'.to_int() + 10).to_int64()
    }
    v = v * 36L + d
  }
  v
}

///|
/// chars[0..<end] → String(拼回原始路径前缀)。
fn chars_prefix(chars : Array[Char], end : Int) -> String {
  let sb = StringBuilder()
  for k in 0..<end {
    sb.write_char(chars[k])
  }
  sb.to_string()
}

///|
/// chars 从 start 起是否形如 `[0-9a-z]+(\.[0-9]+)?$`(版本时间戳段,可带
/// 一个 `.序号` 尾巴;尾巴之后必须到结尾 —— 与 Node 正则的 `$` 锚一致)。
fn valid_version_suffix(chars : Array[Char], start : Int) -> Bool {
  let n = chars.length()
  let mut i = start
  while i < n && is_base36_char(chars[i]) {
    i += 1
  }
  if i == start {
    return false
  }
  if i == n {
    return true
  }
  if chars[i] == '.' {
    let mut j = i + 1
    while j < n && is_digit_char(chars[j]) {
      j += 1
    }
    return j > i + 1 && j == n
  }
  false
}

///|
/// 从右往左找最后一处「后缀形态合法」的 `.syncx-v-`(对应 Node 正则贪婪
/// `(.*)` 的回溯次序:最右合法切分胜出)。返回 marker 起始下标。
fn last_version_marker(chars : Array[Char]) -> Int? {
  let marker = VERSION_MARKER.to_array()
  let m = marker.length()
  let mut i = chars.length() - m
  while i >= 0 {
    let mut hit = true
    for k in 0..<m {
      if chars[i + k] != marker[k] {
        hit = false
        break
      }
    }
    if hit && valid_version_suffix(chars, i + m) {
      return Some(i)
    }
    i -= 1
  }
  None
}

///|
/// 版本文件名 → 原始共享目录内相对路径。无合法后缀时原样返回(Node cli
/// versionOriginalPath 同口径 —— 列表页对混进版本目录的杂散文件也照列)。
pub fn version_original_path(version_file : String) -> String {
  let chars = version_file.to_array()
  match last_version_marker(chars) {
    Some(i) => chars_prefix(chars, i)
    None => version_file
  }
}

///|
/// 严格解析版本文件名:`<relPath>.syncx-v-<base36>[.<n>]` → (relPath, ts)。
/// 无合法后缀返回 None(对应 Node rollback.ts parseVersionName)。
pub fn parse_version_name(file : String) -> (String, Int64)? {
  let chars = file.to_array()
  match last_version_marker(chars) {
    Some(i) => {
      let ts_start = i + VERSION_MARKER.length()
      let mut j = ts_start
      while j < chars.length() && is_base36_char(chars[j]) {
        j += 1
      }
      Some((chars_prefix(chars, i), base36_to_int64(chars, ts_start, j)))
    }
    None => None
  }
}

///|
/// 回收站时间戳段:chars[start..] 必须整体形如 `[0-9a-z]{8,13}(\.[0-9]+)?$`
/// (对应 Node 正则的 ts 组 + 可选碰撞序号组)。成立时返回时间戳段的结束
/// 下标(序号段不属于时间戳)。
fn trash_ts_segment(chars : Array[Char], start : Int) -> Int? {
  let n = chars.length()
  let mut i = start
  while i < n && is_base36_char(chars[i]) {
    i += 1
  }
  let len = i - start
  if len < 8 || len > 13 {
    return None
  }
  if i == n {
    return Some(i)
  }
  if chars[i] == '.' {
    let mut j = i + 1
    while j < n && is_digit_char(chars[j]) {
      j += 1
    }
    if j > i + 1 && j == n {
      return Some(i)
    }
  }
  None
}

///|
/// 回收站副本名 → (原始相对路径, 落盘时刻 ms):`<relPath>.<base36>[.<n>]`。
/// 守卫逐条对齐 Node parseTrashName:relPath 不以 `.syncx-v` 结尾(版本文件
/// 不误认)、时间戳段 8–13 位、ts ≥ 1e11。从右往左逐个 `.` 试拆,首个(最右)
/// 成立者即结果;守卫失败整体返回 None,不回溯到更早的点(Node 同序)。
pub fn parse_trash_name(file : String) -> (String, Int64)? {
  let chars = file.to_array()
  let n = chars.length()
  let mut p = n - 1
  while p >= 0 {
    if chars[p] == '.' {
      match trash_ts_segment(chars, p + 1) {
        Some(ts_end) => {
          let rel = chars_prefix(chars, p)
          if rel.has_suffix(".syncx-v") {
            return None
          }
          let ts = base36_to_int64(chars, p + 1, ts_end)
          if ts < TRASH_TS_FLOOR {
            return None
          }
          return Some((rel, ts))
        }
        None => ()
      }
    }
    p -= 1
  }
  None
}
