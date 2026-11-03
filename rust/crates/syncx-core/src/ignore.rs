//! gitignore 风格忽略规则。对应 Node 侧 `src/ignore.ts`。
//!
//! 移植这块的风险不在"能不能写出一个 gitignore 实现",而在**细节等价**:
//! `**` 只有紧邻 `/` 时才跨层级、不含 `/` 的模式匹配任意层级的同名段、
//! 目录规则要逐级回溯前缀才能挡住子目录里的 `node_modules/`。任何一处跑偏,
//! 症状都是"某些文件被同步了 / 某些文件永远不出现",而不是编译错误。

use regex::Regex;

/// 一条规则。`negated` 来自 `!` 前缀。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct IgnoreRule {
    pub pattern: String,
    pub negated: bool,
}

/// 解析规则行:跳过空行与 `#` 注释,`!` 前缀是负向规则。
pub fn parse_ignore_rules(lines: &[String]) -> Vec<IgnoreRule> {
    let mut rules = Vec::new();
    for raw in lines {
        let mut line = raw.trim().to_string();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut negated = false;
        if let Some(rest) = line.strip_prefix('!') {
            negated = true;
            line = rest.to_string();
        }
        if line.is_empty() {
            continue;
        }
        rules.push(IgnoreRule {
            pattern: line,
            negated,
        });
    }
    rules
}

/// 把 gitignore 模式编译成匹配**完整相对路径**的正则,语义与 Node 的 `buildRegex` 一致:
///   - `*`   匹配任意非 `/` 字符
///   - `**`  仅紧邻 `/` 时跨层级;否则等价于单个 `*`
///   - `?`   匹配单个非 `/` 字符
///   - 其余字符按字面量处理(含 `[` `]` `{` `}`——它们不是通配符)
fn build_regex(pattern: &str) -> Option<Regex> {
    if pattern == "**" {
        return Regex::new("^.*$").ok();
    }
    let chars: Vec<char> = pattern.chars().collect();
    let mut body = String::new();
    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];
        if c == '*' {
            if chars.get(i + 1) == Some(&'*') {
                i += 1; // 指向第二个 *
                let next = chars.get(i + 1).copied();
                let prev = if i >= 2 {
                    chars.get(i - 2).copied()
                } else {
                    None
                };
                let at_start = i == 1;
                if prev == Some('/') && next == Some('/') {
                    // 中间 ** (a/**/b):匹配零个或多个中间目录
                    body.push_str("([^/]+/)*");
                    i += 1; // 吃掉紧跟的 /
                } else if at_start && next == Some('/') {
                    // 开头 ** (**/foo)
                    body.push_str("([^/]+/)*");
                    i += 1;
                } else if prev == Some('/') && i + 1 == chars.len() {
                    // 末尾 ** (a/**)
                    body.push_str(".*");
                } else if at_start && i + 1 == chars.len() {
                    body.push_str(".*");
                } else {
                    // 不在分隔符旁的 **,与单 * 等价(如 a*b)
                    body.push_str("[^/]*");
                }
            } else {
                body.push_str("[^/]*");
            }
        } else if c == '?' {
            body.push_str("[^/]");
        } else if ".+()[]{}^$|\\".contains(c) {
            body.push('\\');
            body.push(c);
        } else {
            body.push(c);
        }
        i += 1;
    }
    Regex::new(&format!("^{body}$")).ok()
}

/// 编译后的规则:把「以 `/` 结尾 = 仅目录」「以 `/` 开头 = 锚定」等前缀语义
/// 在构造时解析掉,避免每个路径都重新算一遍。
#[derive(Debug, Clone)]
pub struct CompiledRule {
    pub rule: IgnoreRule,
    dir_only: bool,
    /// 锚定或含斜杠:相对 .gitignore 所在目录定位,匹配完整相对路径。
    full_path_mode: bool,
    /// `None` 表示该模式不会匹配任何路径(清洗后为空)。
    regex: Option<Regex>,
}

impl CompiledRule {
    fn compile(rule: IgnoreRule) -> Self {
        let dir_only = rule.pattern.ends_with('/');
        let anchored = rule.pattern.starts_with('/');
        let mut pattern = rule.pattern.as_str();
        if dir_only {
            pattern = &pattern[..pattern.len() - 1];
        }
        if anchored {
            pattern = &pattern[1..];
        }
        // 先算完再移动 `rule`:`pattern` 借着 `rule.pattern` 的引用。
        let (full_path_mode, regex) = if pattern.is_empty() {
            (false, None)
        } else {
            (anchored || pattern.contains('/'), build_regex(pattern))
        };
        Self {
            rule,
            dir_only,
            full_path_mode,
            regex,
        }
    }
}

/// 相对路径按 `/` 与 `\` 双分隔符切分 —— 对端可能传来反斜杠。
fn split_segments(rel_path: &str) -> Vec<&str> {
    rel_path.split(['/', '\\']).collect()
}

impl CompiledRule {
    /// 单条规则是否命中该相对路径。
    ///
    /// `is_dir` 只在目录规则下起作用:它决定最后一段能否被当作「被忽略的目录自身」。
    fn matches(&self, rel_path: &str, is_dir: bool) -> bool {
        let Some(re) = &self.regex else {
            return false;
        };

        let match_full = |p: &str| -> bool {
            if self.full_path_mode {
                re.is_match(p)
            } else {
                split_segments(p).iter().any(|segment| re.is_match(segment))
            }
        };

        if !self.dir_only {
            return match_full(rel_path);
        }

        // 目录规则:忽略一个目录等价于忽略它下面的全部内容,而拿到的是**文件**路径,
        // 所以要逐级回溯目录前缀。只比字面量前缀的话挡不住子目录里的同名目录
        // (`admin/node_modules/**` 会漏),那正是 Node 侧修过的事故形态。
        let segments = split_segments(rel_path);
        let dir_depth = if is_dir {
            segments.len()
        } else {
            segments.len().saturating_sub(1)
        };

        if self.full_path_mode {
            for i in 1..=dir_depth {
                let prefix = segments[..i].join("/");
                if re.is_match(&prefix) {
                    return true;
                }
            }
            return false;
        }
        for segment in segments.iter().take(dir_depth) {
            if re.is_match(segment) {
                return true;
            }
        }
        false
    }
}

/// 一组编译好的忽略规则。后命中的规则覆盖先命中的(负向规则用于"放回")。
#[derive(Debug, Clone)]
pub struct IgnoreRuleset {
    rules: Vec<CompiledRule>,
}

impl IgnoreRuleset {
    pub fn from_lines(lines: &[String]) -> Self {
        Self {
            rules: parse_ignore_rules(lines)
                .into_iter()
                .map(CompiledRule::compile)
                .collect(),
        }
    }

    /// 是否忽略该相对路径。`is_dir` 表示路径指向目录还是文件 ——
    /// 调用方必须传对:`node_modules/` 不匹配名为 node_modules 的**文件**。
    pub fn is_ignored(&self, rel_path: &str, is_dir: bool) -> bool {
        let mut ignored = false;
        for rule in &self.rules {
            if rule.matches(rel_path, is_dir) {
                ignored = !rule.rule.negated;
            }
        }
        ignored
    }

    /// 最后一次命中的规则(不区分正负向)。与 [`Self::is_ignored`] 同序,
    /// 供忽略规则编辑器的实时测试器解释「哪一行挡住了它」。
    pub fn last_matched(&self, rel_path: &str, is_dir: bool) -> Option<&IgnoreRule> {
        let mut last: Option<&IgnoreRule> = None;
        for rule in &self.rules {
            if rule.matches(rel_path, is_dir) {
                last = Some(&rule.rule);
            }
        }
        last
    }

    /// 判定并**解释命中来源**。与 Node `explainIgnore` 逐字段同义:
    /// `ignored` 只看最后命中的那条规则(负向规则放行),`hard` 是独立的硬闸门。
    pub fn explain(&self, rel_path: &str, is_dir: bool) -> IgnoreVerdict {
        let last = self.last_matched(rel_path, is_dir);
        let hard = is_hard_ignored(rel_path);
        let ignored = hard || last.map(|rule| !rule.negated).unwrap_or(false);
        let rule = last.filter(|rule| !rule.negated).map(|r| r.pattern.clone());
        let negated_rule = last.filter(|rule| rule.negated).map(|r| r.pattern.clone());
        IgnoreVerdict {
            ignored,
            hard,
            rule,
            negated_rule,
        }
    }
}

/// 忽略判定解释(忽略规则编辑器实时测试器的响应体)。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct IgnoreVerdict {
    pub ignored: bool,
    /// 命中硬忽略闸门(任何规则都解不开)。
    pub hard: bool,
    /// 决定「忽略」的那条规则文本。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule: Option<String>,
    /// 决定「放行」的负向规则文本(如 `!logs/`)。
    #[serde(rename = "negatedRule", skip_serializing_if = "Option::is_none")]
    pub negated_rule: Option<String>,
}

/* ==================== 硬忽略 ==================== */

/// 永远不参与同步的目录名(大小写不敏感)。见 Node 侧 `HARD_IGNORE_NAMES`。
pub const HARD_IGNORE_NAMES: [&str; 6] = [".git", ".git-rewrite", ".hg", ".svn", ".syncx-trash", ".syncx-folder"];

/// syncx 在途中间态后缀(见 Node 侧 `SCRATCH_SUFFIXES`)。
pub const SCRATCH_SUFFIXES: [&str; 2] = [".syncx-tmp", ".syncx-partial"];

/// 冲突副本命名:
/// `<原路径去扩展名>.sync-conflict-<ts36>[-<seq36>]-<对端设备ID><扩展名>`
///
/// 设备 ID 固定 10 位 base32(A-Z2-7,无连字符),所以命名可以无歧义反解。
/// 正则与 Node 侧 `CONFLICT_COPY_RE` 逐字相同 —— 两处漂移会让「冲突收件箱」
/// 与「扫描器」对同一个文件给出不同结论。
pub const CONFLICT_COPY_PATTERN: &str =
    r"^(.+)\.sync-conflict-[0-9a-z]+(?:-[0-9a-z]+)?-([A-Z2-7]{10})(\.[^./]*)?$";

/// 单段文件名是否为冲突副本。
pub fn is_conflict_copy_name(name: &str) -> bool {
    conflict_copy_regex()
        .map(|re| re.is_match(name))
        .unwrap_or(false)
}

/// 反解冲突副本文件名 → (原文件名, 来源设备 ID)。非冲突命名返回 `None`。
pub fn parse_conflict_copy_name(name: &str) -> Option<(String, String)> {
    let re = conflict_copy_regex()?;
    let caps = re.captures(name)?;
    let head = caps.get(1)?.as_str();
    let device = caps.get(2)?.as_str();
    let ext = caps.get(3).map(|m| m.as_str()).unwrap_or("");
    Some((format!("{head}{ext}"), device.to_string()))
}

fn conflict_copy_regex() -> Option<Regex> {
    Regex::new(CONFLICT_COPY_PATTERN).ok()
}

/// 路径段是否为在途中间态(后缀判定,大小写不敏感)。
pub fn is_scratch_segment(name: &str) -> bool {
    let lower = name.to_lowercase();
    SCRATCH_SUFFIXES.iter().any(|s| lower.ends_with(s))
}

/// 相对路径中任一段命中硬忽略名单 / 冲突副本命名 / 在途中间态。
///
/// 按**路径段**比较而非子串:`.github` / `.svnignore` 这类前缀相同但段不同的名字不受影响。
pub fn is_hard_ignored(rel_path: &str) -> bool {
    for segment in rel_path.split(['/', '\\']) {
        if segment.is_empty() {
            continue;
        }
        let lower = segment.to_lowercase();
        if HARD_IGNORE_NAMES.contains(&lower.as_str()) {
            return true;
        }
        if is_conflict_copy_name(segment) {
            return true;
        }
        if is_scratch_segment(segment) {
            return true;
        }
    }
    false
}
