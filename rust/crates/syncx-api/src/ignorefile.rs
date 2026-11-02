//! 忽略规则编辑器的**磁盘侧**:`.syncxignore` 读写与规则组装。
//!
//! 规则文本在盘上,判定在 [`syncx_core::ignore`];这一层只负责「哪些行算数」。
//! 优先级与 Node `composeIgnoreLines` 严格同序(后者覆盖前者):
//! 内置默认 → `.gitignore`(按目录开关)→ `.syncxignore`。
//!
//! 写回时的清洗规则也是跨后端契约:去掉 `\r`、去掉行尾空白、LF 连接、非空时补尾换行、
//! 空数组写空文件。任一端少做一步,另一端的编辑器回填后行数就会单调增长。

use std::path::Path;

use syncx_core::ignore::{IgnoreRuleset, IgnoreVerdict};

/// 内置默认忽略行(展示给编辑器,只读;文本层面可被负向规则覆盖,硬闸门另算)。
pub const BUILTIN_IGNORE_LINES: [&str; 5] = [
    ".git",
    ".hg",
    ".svn",
    ".syncx-trash",
    ".syncx-folder",
];

/// 保存规则的上限,与 Node 侧同参数。
pub const MAX_IGNORE_LINES: usize = 500;
pub const MAX_IGNORE_LINE_CHARS: usize = 1024;

pub const ERR_IGNORE_TOO_LARGE: &str =
    "忽略规则需为字符串数组:最多 500 行,每行最长 1024 字符";

/// 读 `.syncxignore` 的原始用户行(不含内置与 `.gitignore`)。
///
/// 尾换行不产生额外空行 —— 编辑器回填后直接保存不应让行数增长。
pub fn read_syncx_ignore_lines(folder_path: &Path) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(folder_path.join(".syncxignore")) else {
        return Vec::new();
    };
    let text = text.replace("\r\n", "\n");
    if text.is_empty() {
        return Vec::new();
    }
    let trimmed = text.strip_suffix('\n').unwrap_or(&text);
    trimmed.split('\n').map(|line| line.to_string()).collect()
}

/// 写 `.syncxignore`。`\r` 与行尾空白先清掉,空数组写空文件(= 清空)。
pub fn write_syncx_ignore_lines(folder_path: &Path, lines: &[String]) -> std::io::Result<()> {
    let clean: Vec<String> = lines
        .iter()
        .map(|line| {
            line.replace('\r', "")
                .trim_end_matches([' ', '\t'])
                .to_string()
        })
        .collect();
    let payload = if clean.is_empty() {
        String::new()
    } else {
        format!("{}\n", clean.join("\n"))
    };
    std::fs::write(folder_path.join(".syncxignore"), payload)
}

/// 组装完整规则文本:内置默认 + `.gitignore`(按开关)+ 给定的 `.syncxignore` 行。
pub fn compose_ignore_lines(folder_path: &Path, use_gitignore: bool, syncx_lines: &[String]) -> Vec<String> {
    let mut lines: Vec<String> = BUILTIN_IGNORE_LINES
        .iter()
        .map(|line| line.to_string())
        .collect();
    if use_gitignore {
        if let Ok(text) = std::fs::read_to_string(folder_path.join(".gitignore")) {
            lines.extend(text.split('\n').map(|line| line.to_string()));
        }
    }
    lines.extend(syncx_lines.iter().cloned());
    lines
}

/// 编辑器打开数据:`{lines, builtin, useGitignore}`。
pub fn ignore_info(folder_path: &Path, use_gitignore: bool) -> serde_json::Value {
    serde_json::json!({
        "lines": read_syncx_ignore_lines(folder_path),
        "builtin": BUILTIN_IGNORE_LINES,
        "useGitignore": use_gitignore,
    })
}

/// 实时测试器:给定路径 + 可选草稿行,回答「会不会被忽略、被哪条规则挡住」。
///
/// 路径以 `/` 结尾按目录语义判定(目录规则 `foo/` 只挡目录不挡同名文件);
/// 与 Node 一样先把反斜杠归一、去掉前导斜杠,再判空。
pub fn test_ignore(
    folder_path: &Path,
    use_gitignore: bool,
    test_path: &str,
    draft_lines: Option<&[String]>,
) -> Result<IgnoreVerdict, String> {
    let normalized = test_path.trim().replace('\\', "/");
    let normalized = normalized.trim_start_matches('/');
    if normalized.is_empty() {
        return Err("path is required".to_string());
    }
    let is_dir = normalized.ends_with('/');
    let rel = if is_dir {
        normalized.trim_end_matches('/')
    } else {
        normalized
    };
    if rel.is_empty() {
        return Err("path is required".to_string());
    }
    let owned;
    let syncx_lines: &[String] = match draft_lines {
        Some(lines) => lines,
        None => {
            owned = read_syncx_ignore_lines(folder_path);
            &owned
        }
    };
    let lines = compose_ignore_lines(folder_path, use_gitignore, syncx_lines);
    Ok(IgnoreRuleset::from_lines(&lines).explain(rel, is_dir))
}

/// 保存前的校验(行数与行长上限)。错误文案与 Node 逐字一致。
pub fn validate_ignore_lines(lines: &[String]) -> Result<(), String> {
    if lines.len() > MAX_IGNORE_LINES
        || lines
            .iter()
            .any(|line| line.chars().count() > MAX_IGNORE_LINE_CHARS)
    {
        return Err(ERR_IGNORE_TOO_LARGE.to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "syncx-api-ignore-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn ignore_file_round_trip_drops_trailing_newline() {
        let dir = temp("roundtrip");
        assert!(read_syncx_ignore_lines(&dir).is_empty(), "文件不存在 = 空规则");
        write_syncx_ignore_lines(&dir, &["a  ".to_string(), "b\r".to_string()]).unwrap();
        assert_eq!(read_syncx_ignore_lines(&dir), vec!["a".to_string(), "b".to_string()]);
        write_syncx_ignore_lines(&dir, &[]).unwrap();
        let raw = std::fs::read_to_string(dir.join(".syncxignore")).unwrap();
        assert!(raw.is_empty(), "空数组必须写空文件,不能留一个换行");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_ignore_explains_hard_and_negated() {
        let dir = temp("explain");
        write_syncx_ignore_lines(&dir, &["logs/".to_string(), "!logs/keep".to_string()]).unwrap();
        let verdict = test_ignore(&dir, false, "logs/keep", None).unwrap();
        assert!(!verdict.ignored);
        // Node 的 negatedRule 存的是 rule.pattern,`!` 已在解析时剥掉
        assert_eq!(verdict.negated_rule.as_deref(), Some("logs/keep"));
        let verdict = test_ignore(&dir, false, "logs/x.txt", None).unwrap();
        assert!(verdict.ignored);
        assert_eq!(verdict.rule.as_deref(), Some("logs/"));
        let verdict = test_ignore(&dir, false, ".git/config", None).unwrap();
        assert!(verdict.hard, "硬闸门不可被规则解除");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_ignore_directory_semantics() {
        let dir = temp("dironly");
        write_syncx_ignore_lines(&dir, &["node_modules/".to_string()]).unwrap();
        assert!(test_ignore(&dir, false, "node_modules", Some(&[])).is_ok());
        // 文件同名不被目录规则命中
        let verdict = test_ignore(&dir, false, "node_modules", Some(&["node_modules/".into()])).unwrap();
        assert!(!verdict.ignored, "目录规则不该匹配同名文件");
        let verdict = test_ignore(&dir, false, "node_modules/", Some(&["node_modules/".into()])).unwrap();
        assert!(verdict.ignored, "带尾斜杠按目录语义判定");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
