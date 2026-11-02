//! 浏览器内文件管理器的文件系统层:路径越界防护 + 目录列举 + 删除。
//!
//! 与控制路由(`routes/files.rs`)分离,便于对「路径安全」单独做单元测试。
//! 这一层是全套 API 里唯一直接接用户输入拼路径的地方,所以防护做成三道:
//!
//!  1. **字面校验** —— 拒绝 NUL、`..` 之外还拒绝绝对路径与 Windows 盘符;
//!  2. **归一校验** —— 拼接后必须仍落在共享根内;
//!  3. **软链校验** —— `canonicalize` 之后必须仍落在**根的真实路径**内。
//!
//! 第三道不能省:共享目录内部一个指向 `/etc` 的软链能通过前两道,却把
//! 「删共享目录里的东西」变成「删系统文件」。

use std::path::{Path, PathBuf};

use serde::Serialize;

/// 目录列举的单次条目上限:超出截断,避免巨型目录拖垮 UI。
pub const DIR_LIST_LIMIT: usize = 2000;

#[derive(Debug, Clone, Serialize)]
pub struct DirEntry {
    /// 相对共享目录根的路径(POSIX 分隔符),列表/下载/删除统一用它寻址。
    pub path: String,
    pub name: String,
    #[serde(rename = "dir")]
    pub is_dir: bool,
    /// 字节数(目录恒为 0)。
    pub size: u64,
    /// 修改时间(毫秒);stat 失败时为 0。
    pub mtime: i64,
    /// 按需同步的占位文件(盘上无实体)。缺省不写。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<bool>,
    /// 被「单文件暂停」冻结(盘上有实体但不再同步)。缺省不写。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paused: Option<bool>,
    /// 选择性同步命中的目录。仅目录行置此标志。
    #[serde(rename = "onDemandDir", skip_serializing_if = "Option::is_none")]
    pub on_demand_dir: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DirListing {
    pub entries: Vec<DirEntry>,
    pub truncated: bool,
}

/// 路径不安全时抛出。消息直接作为 400 响应体,故文案与 Node 逐字一致。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathUnsafeError(pub &'static str);

impl std::fmt::Display for PathUnsafeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}

impl std::error::Error for PathUnsafeError {}

pub const ERR_NUL: PathUnsafeError = PathUnsafeError("路径包含非法字符");
pub const ERR_NOT_RELATIVE: PathUnsafeError = PathUnsafeError("必须是共享目录内的相对路径");
pub const ERR_ESCAPE: PathUnsafeError = PathUnsafeError("路径越出共享目录");
pub const ERR_SYMLINK_ESCAPE: PathUnsafeError = PathUnsafeError("路径经软链越出共享目录");
pub const ERR_ROOT_DELETE: PathUnsafeError = PathUnsafeError("不能删除共享目录本身");

/// 把相对路径解析到共享目录根下的绝对路径,并做三道防越界。
///
/// 根自身返回根的 realpath。根不存在时由调用方先行兜错。
pub fn resolve_folder_subpath(root: &Path, rel_path: &str) -> Result<PathBuf, PathUnsafeError> {
    if rel_path.contains('\0') {
        return Err(ERR_NUL);
    }
    let normalized = rel_path.replace('\\', "/");
    if normalized.starts_with('/') || is_drive_absolute(&normalized) {
        return Err(ERR_NOT_RELATIVE);
    }
    let root_real = std::fs::canonicalize(root).map_err(|_| PathUnsafeError("共享目录不可访问"))?;
    let joined = if normalized.is_empty() || normalized == "." {
        root_real.clone()
    } else {
        // 逐段拼接而不是直接 Path::join:`..` 段必须真的被消解,不能留给 canonicalize
        // 去「碰巧」处理(根的子目录可能是软链,先归一再去 realpath 会漏掉一层)
        let mut path = root_real.clone();
        for segment in normalized.split('/') {
            match segment {
                "" | "." => {}
                ".." => {
                    path.pop();
                    if !path.starts_with(&root_real) {
                        return Err(ERR_ESCAPE);
                    }
                }
                other => path.push(other),
            }
        }
        path
    };
    if joined != root_real && !joined.starts_with(&root_real) {
        return Err(ERR_ESCAPE);
    }
    // 第三道:软链归一后仍需在根内
    let real = std::fs::canonicalize(&joined).map_err(|_| PathUnsafeError("路径不存在"))?;
    if real != root_real && !real.starts_with(&root_real) {
        return Err(ERR_SYMLINK_ESCAPE);
    }
    Ok(real)
}

/// `C:` / `c:` 这类 Windows 盘符前缀。POSIX 上 `"C:foo"` 是合法文件名,但共享
/// 数据目录会跨平台,在 Windows 上它是绝对路径 —— 统一按不安全处理。
fn is_drive_absolute(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

/// 绝对路径 → 相对共享根的 POSIX 相对路径。
fn to_rel(root_real: &Path, abs: &Path) -> String {
    abs.strip_prefix(root_real)
        .map(|rel| rel.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default()
}

/// 列举共享目录下某个子目录:目录在前、组内按名称次序。
///
/// 每条 `stat` 单独容错:并发删除/权限不足的单条不影响整页 —— 一次列举里出现
/// 一条读不到的文件是常态(下载中、正在被删),整页报错等于让文件管理器不可用。
pub fn list_directory(root: &Path, rel_path: &str, limit: usize) -> Result<DirListing, PathUnsafeError> {
    let root_real = std::fs::canonicalize(root).map_err(|_| PathUnsafeError("共享目录不可访问"))?;
    let abs_dir = resolve_folder_subpath(&root_real, rel_path)?;

    let mut names: Vec<String> = Vec::new();
    let entries = std::fs::read_dir(&abs_dir).map_err(|_| PathUnsafeError("目录不存在"))?;
    for entry in entries.flatten() {
        names.push(entry.file_name().to_string_lossy().to_string());
    }
    names.sort();

    let mut stats: Vec<DirEntry> = names
        .into_iter()
        .map(|name| {
            let abs = abs_dir.join(&name);
            // 用 stat 而非 lstat:软链指向目录时按目标类型展示
            match std::fs::metadata(&abs) {
                Ok(meta) => DirEntry {
                    path: to_rel(&root_real, &abs),
                    name: name.clone(),
                    is_dir: meta.is_dir(),
                    // 目录的 size 是文件系统元数据(APFS 96 / ext4 4096),不是内容体量
                    size: if meta.is_dir() { 0 } else { meta.len() },
                    mtime: mtime_ms(&meta),
                    placeholder: None,
                    paused: None,
                    on_demand_dir: None,
                },
                Err(_) => DirEntry {
                    path: to_rel(&root_real, &abs),
                    name,
                    is_dir: false,
                    size: 0,
                    mtime: 0,
                    placeholder: None,
                    paused: None,
                    on_demand_dir: None,
                },
            }
        })
        .collect();

    // 目录在前,组内按名称
    stats.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.cmp(&b.name),
    });
    let truncated = stats.len() > limit;
    stats.truncate(limit);
    Ok(DirListing {
        entries: stats,
        truncated,
    })
}

/// 删除共享目录内单个文件或整个子目录(递归)。不存在时返回错误由路由转 400。
pub fn delete_folder_entry(root: &Path, rel_path: &str) -> Result<(), PathUnsafeError> {
    let root_real = std::fs::canonicalize(root).map_err(|_| PathUnsafeError("共享目录不可访问"))?;
    let abs = resolve_folder_subpath(&root_real, rel_path)?;
    if abs == root_real {
        return Err(ERR_ROOT_DELETE);
    }
    let meta = std::fs::symlink_metadata(&abs).map_err(|_| PathUnsafeError("路径不存在"))?;
    if meta.is_dir() {
        std::fs::remove_dir_all(&abs).map_err(|e| PathUnsafeError(leak_message(e)))?;
    } else {
        std::fs::remove_file(&abs).map_err(|e| PathUnsafeError(leak_message(e)))?;
    }
    Ok(())
}

/// 错误消息是静态串(避免大对象带进错误类型),这里按常见情形给一句中文。
fn leak_message(error: std::io::Error) -> &'static str {
    match error.kind() {
        std::io::ErrorKind::PermissionDenied => "没有权限删除该路径",
        std::io::ErrorKind::NotFound => "路径不存在",
        _ => "删除失败",
    }
}

pub fn mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "syncx-api-fb-{tag}-{}-{}",
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
    fn rejects_unsafe_paths() {
        let root = temp_root("unsafe");
        std::fs::write(root.join("ok.txt"), "x").unwrap();
        assert_eq!(resolve_folder_subpath(&root, "a\0b"), Err(ERR_NUL));
        assert_eq!(resolve_folder_subpath(&root, "/etc/passwd"), Err(ERR_NOT_RELATIVE));
        assert_eq!(resolve_folder_subpath(&root, "C:/x"), Err(ERR_NOT_RELATIVE));
        assert_eq!(resolve_folder_subpath(&root, "../x"), Err(ERR_ESCAPE));
        assert_eq!(resolve_folder_subpath(&root, "a/../../x"), Err(ERR_ESCAPE));
        // 反斜杠按分隔符归一
        assert!(resolve_folder_subpath(&root, "ok.txt").is_ok());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape() {
        let root = temp_root("symlink");
        let outside = temp_root("symlink-outside");
        std::fs::write(outside.join("secret.txt"), "s").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        // 前两道都过(字面在根内),第三道拦住
        assert_eq!(
            resolve_folder_subpath(&root, "link/secret.txt"),
            Err(ERR_SYMLINK_ESCAPE)
        );
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn list_puts_dirs_first_and_reports_zero_dir_size() {
        let root = temp_root("list");
        std::fs::create_dir_all(root.join("zdir")).unwrap();
        std::fs::write(root.join("afile.txt"), "hello").unwrap();
        std::fs::write(root.join("bfile.txt"), "hi").unwrap();
        let listing = list_directory(&root, "", DIR_LIST_LIMIT).unwrap();
        let names: Vec<&str> = listing.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["zdir", "afile.txt", "bfile.txt"]);
        assert_eq!(listing.entries[0].size, 0, "目录大小恒报 0");
        assert_eq!(listing.entries[1].size, 5);
        assert_eq!(listing.entries[1].path, "afile.txt");
        assert!(!listing.truncated);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn list_truncates() {
        let root = temp_root("truncate");
        for i in 0..5 {
            std::fs::write(root.join(format!("f{i}")), "x").unwrap();
        }
        let listing = list_directory(&root, "", 3).unwrap();
        assert_eq!(listing.entries.len(), 3);
        assert!(listing.truncated);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn delete_entry_but_not_root() {
        let root = temp_root("delete");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("sub/a.txt"), "x").unwrap();
        assert_eq!(delete_folder_entry(&root, ""), Err(ERR_ROOT_DELETE));
        delete_folder_entry(&root, "sub").unwrap();
        assert!(!root.join("sub").exists());
        assert_eq!(delete_folder_entry(&root, "missing"), Err(PathUnsafeError("路径不存在")));
        let _ = std::fs::remove_dir_all(&root);
    }
}
