///|
/// gitignore 风格忽略规则(对应 Node `src/ignore.ts`、Rust `syncx-core/src/ignore.rs`)。
///
/// 风险不在"能不能写出一个 gitignore 实现",而在**细节等价**:
/// `**` 只有紧邻 `/` 时才跨层级、不含 `/` 的模式匹配任意层级的同名段、
/// 目录规则要逐级回溯前缀才能挡住子目录里的 `node_modules/`。任何一处跑偏,
/// 症状都是"某些文件被同步了 / 某些文件永远不出现",而不是编译错误。

///|
/// 一条规则。`negated` 来自 `!` 前缀。
pub(all) struct IgnoreRule {
  pattern : String
  negated : Bool
} derive(Eq)

///|
pub extend IgnoreRule with Eq::{equal, not_equal}

///|
/// 解析规则行:跳过空行与 `#` 注释,`!` 前缀是负向规则。
pub fn parse_ignore_rules(lines : Array[String]) -> Array[IgnoreRule] {
  let rules : Array[IgnoreRule] = []
  for raw in lines {
    let mut line = raw.trim().to_owned()
    if line == "" || line.has_prefix("#") {
      continue
    }
    let mut negated = false
    match line.strip_prefix("!") {
      Some(rest) => {
        negated = true
        line = rest.to_owned()
      }
      None => ()
    }
    if line == "" {
      continue
    }
    rules.push({ pattern: line, negated, })
  }
  rules
}

///|
/// 把 gitignore 模式编译成匹配**完整相对路径**的正则,语义与 Node 的 `buildRegex` 一致:
///  - `*`   匹配任意非 `/` 字符
///  - `**`  仅紧邻 `/` 时跨层级;否则等价于单个 `*`
///  - `?`   匹配单个非 `/` 字符
///  - 其余字符按字面量处理(含 `[` `]` `{` `}`——它们不是通配符)
///
/// 编译失败按「该模式不会匹配任何路径」处理(与 Rust 版返回 `None` 同口径)。
fn build_regex(pattern : String) -> @regexp.Regexp? {
  try {
    if pattern == "**" {
      return Some(@regexp.compile("^.*$"))
    }
    let chars = pattern.to_array()
    let body = StringBuilder()
    let mut i = 0
    let n = chars.length()
    while i < n {
      let c = chars[i]
      if c == '*' {
        if i + 1 < n && chars[i + 1] == '*' {
          i += 1 // 指向第二个 *
          let next = if i + 1 < n { Some(chars[i + 1]) } else { None }
          let prev = if i >= 2 { Some(chars[i - 2]) } else { None }
          let at_start = i == 1
          if prev == Some('/') && next == Some('/') {
            // 中间 ** (a/**/b):匹配零个或多个中间目录
            body.write_string("([^/]+/)*")
            i += 1
          } else if at_start && next == Some('/') {
            // 开头 ** (**/foo)
            body.write_string("([^/]+/)*")
            i += 1
          } else if prev == Some('/') && i + 1 == n {
            // 末尾 ** (a/**)
            body.write_string(".*")
          } else if at_start && i + 1 == n {
            body.write_string(".*")
          } else {
            // 不在分隔符旁的 **,与单 * 等价(如 a*b)
            body.write_string("[^/]*")
          }
        } else {
          body.write_string("[^/]*")
        }
      } else if c == '?' {
        body.write_string("[^/]")
      } else if ".+()[]{}^$|\\".contains_char(c) {
        body.write_char('\\')
        body.write_char(c)
      } else {
        body.write_char(c)
      }
      i += 1
    }
    Some(@regexp.compile("^\{body.to_string()}$"))
  } catch {
    _ => None
  }
}

///|
/// 编译后的规则:把「以 `/` 结尾 = 仅目录」「以 `/` 开头 = 锚定」等前缀语义
/// 在构造时解析掉,避免每个路径都重新算一遍。
struct CompiledRule {
  rule : IgnoreRule
  /// 锚定或含斜杠:相对 .gitignore 所在目录定位,匹配完整相对路径。
  full_path_mode : Bool
  /// `None` 表示该模式不会匹配任何路径(清洗后为空)。
  regex : @regexp.Regexp?
}

///|
fn CompiledRule::compile(rule : IgnoreRule) -> CompiledRule {
  let dir_only = rule.pattern.has_suffix("/")
  let anchored = rule.pattern.has_prefix("/")
  let mut pattern = rule.pattern
  if dir_only {
    pattern = pattern[0:pattern.length() - 1].to_owned()
  }
  if anchored {
    pattern = pattern[1:pattern.length()].to_owned()
  }
  let full_path_mode = if pattern == "" {
    false
  } else {
    anchored || pattern.contains("/")
  }
  let regex = if pattern == "" { None } else { build_regex(pattern) }
  { rule, full_path_mode, regex, } // dir_only 折进 matches 的访问器,不单独存字段
}

///|
/// 相对路径按 `/` 与 `\` 双分隔符切分 —— 对端可能传来反斜杠。
fn split_segments(rel_path : String) -> Array[String] {
  let out : Array[String] = []
  let current = StringBuilder()
  for c in rel_path {
    if c == '/' || c == '\\' {
      out.push(current.to_string())
      current.reset()
    } else {
      current.write_char(c)
    }
  }
  out.push(current.to_string())
  out
}

///|
/// 单条规则是否命中该相对路径。
///
/// `is_dir` 只在目录规则下起作用:它决定最后一段能否被当作「被忽略的目录自身」。
fn CompiledRule::matches(
  self : CompiledRule,
  rel_path : String,
  is_dir : Bool,
) -> Bool {
  let re = match self.regex {
    Some(re) => re
    None => return false
  }
  fn match_full(p : String) -> Bool {
    if self.full_path_mode {
      match re.match_(p) {
        Some(_) => true
        None => false
      }
    } else {
      for segment in split_segments(p) {
        match re.match_(segment) {
          Some(_) => return true
          None => continue
        }
      }
      false
    }
  }
  if !self.dir_only() {
    return match_full(rel_path)
  }
  // 目录规则:忽略一个目录等价于忽略它下面的全部内容,而拿到的是**文件**路径,
  // 所以要逐级回溯目录前缀。只比字面量前缀的话挡不住子目录里的同名目录
  // (`admin/node_modules/**` 会漏),那正是 Node 侧修过的事故形态。
  let segments = split_segments(rel_path)
  let dir_depth = if is_dir {
    segments.length()
  } else {
    let d = segments.length() - 1
    if d < 0 {
      0
    } else {
      d
    }
  }
  if self.full_path_mode {
    for i in 1..<=dir_depth {
      let prefix = segments[0:i].join("/")
      if match_full(prefix) {
        return true
      }
    }
    return false
  }
  for i in 0..<dir_depth {
    match re.match_(segments[i]) {
      Some(_) => return true
      None => continue
    }
  }
  false
}

// dir_only 折进访问器,避免结构体存两份

///|
fn CompiledRule::dir_only(self : CompiledRule) -> Bool {
  self.rule.pattern.has_suffix("/")
}

///|
/// 一组编译好的忽略规则。后命中的规则覆盖先命中的(负向规则用于"放回")。
pub(all) struct IgnoreRuleset {
  rules : Array[CompiledRule]
}

///|
pub fn IgnoreRuleset::from_lines(lines : Array[String]) -> IgnoreRuleset {
  let rules : Array[CompiledRule] = []
  for rule in parse_ignore_rules(lines) {
    rules.push(CompiledRule::compile(rule))
  }
  { rules, }
}

///|
/// 是否忽略该相对路径。`is_dir` 表示路径指向目录还是文件 ——
/// 调用方必须传对:`node_modules/` 不匹配名为 node_modules 的**文件**。
pub fn IgnoreRuleset::is_ignored(
  self : IgnoreRuleset,
  rel_path : String,
  is_dir : Bool,
) -> Bool {
  let mut ignored = false
  for rule in self.rules {
    if rule.matches(rel_path, is_dir) {
      ignored = !rule.rule.negated
    }
  }
  ignored
}

///|
/// 最后一次命中的规则(不区分正负向)。与 `is_ignored` 同序,
/// 供忽略规则编辑器的实时测试器解释「哪一行挡住了它」。
pub fn IgnoreRuleset::last_matched(
  self : IgnoreRuleset,
  rel_path : String,
  is_dir : Bool,
) -> IgnoreRule? {
  let mut last : IgnoreRule? = None
  for rule in self.rules {
    if rule.matches(rel_path, is_dir) {
      last = Some(rule.rule)
    }
  }
  last
}

///|
/// 忽略判定解释(忽略规则编辑器实时测试器的响应体)。
pub(all) struct IgnoreVerdict {
  ignored : Bool
  /// 命中硬忽略闸门(任何规则都解不开)。
  hard : Bool
  /// 决定「忽略」的那条规则文本。
  rule : String?
  /// 决定「放行」的负向规则文本(如 `!logs/`)。
  negated_rule : String?
} derive(Eq)

///|
pub extend IgnoreVerdict with Eq::{equal, not_equal}

///|
/// 判定并**解释命中来源**。与 Node `explainIgnore` 逐字段同义:
/// `ignored` 只看最后命中的那条规则(负向规则放行),`hard` 是独立的硬闸门。
pub fn IgnoreRuleset::explain(
  self : IgnoreRuleset,
  rel_path : String,
  is_dir : Bool,
) -> IgnoreVerdict {
  let last = self.last_matched(rel_path, is_dir)
  let hard = is_hard_ignored(rel_path)
  let last_ignores = match last {
    Some(rule) => !rule.negated
    None => false
  }
  let ignored = hard || last_ignores
  let rule = match last {
    Some(r) => if !r.negated { Some(r.pattern) } else { None }
    None => None
  }
  let negated_rule = match last {
    Some(r) => if r.negated { Some(r.pattern) } else { None }
    None => None
  }
  { ignored, hard, rule, negated_rule, }
}

// ==================== 硬忽略 ====================

///|
/// 永远不参与同步的目录名(大小写不敏感)。见 Node 侧 `HARD_IGNORE_NAMES`。
/// (MoonBit 的 const 只认不可变基础类型,列表以函数形式暴露。)
pub fn hard_ignore_names() -> Array[String] {
  [".git", ".git-rewrite", ".hg", ".svn", ".syncx-trash", ".syncx-folder"]
}

///|
/// syncx 在途中间态后缀(见 Node 侧 `SCRATCH_SUFFIXES`)。
pub fn scratch_suffixes() -> Array[String] {
  [".syncx-tmp", ".syncx-partial"]
}

///|
/// 路径段是否为在途中间态(后缀判定,大小写不敏感)。
pub fn is_scratch_segment(name : String) -> Bool {
  let lower = name.to_lower()
  for suffix in scratch_suffixes() {
    if lower.has_suffix(suffix) {
      return true
    }
  }
  false
}

///|
/// 相对路径中任一段命中硬忽略名单 / 冲突副本命名 / 在途中间态。
///
/// 按**路径段**比较而非子串:`.github` / `.svnignore` 这类前缀相同但段不同的
/// 名字不受影响。
pub fn is_hard_ignored(rel_path : String) -> Bool {
  for segment in split_segments(rel_path) {
    if segment == "" {
      continue
    }
    let lower = segment.to_lower()
    for name in hard_ignore_names() {
      if lower == name {
        return true
      }
    }
    if is_conflict_copy_name(segment) {
      return true
    }
    if is_scratch_segment(segment) {
      return true
    }
  }
  false
}
