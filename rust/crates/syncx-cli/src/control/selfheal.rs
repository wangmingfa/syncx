//! 启动自愈(与 Node `cli.ts` 的启动自愈段逐条对齐)。
//!
//! 三件事,顺序固定,全部在 `reload_actor` 打开任何索引库**之前**执行:
//!
//!  1. **孤儿索引回收**:删掉 configDir 下不属于当前配置期望集合的 `index-*.db`。
//!     索引库是可再生缓存(最坏代价只是重扫一次),删除安全。这堵死两条无解的
//!     残留路径:关着 daemon 直接改 config.json 删目录(不会走登记清理),以及
//!     进程在「登记清理」与「热重载真正删除」之间重启(内存登记丢失)。
//!  2. **目录身份指纹收养**:为升级前创建的存量目录采集共享根指纹(dev + ino)
//!     并落盘。危险态(索引里有活条目但目录顶层为空,疑似未挂载/被清空)不自动
//!     收养 —— 否则把坏状态记成正常身份,结构守卫就彻底失效了。
//!  3. **共享目录内遗留元数据清理**:删掉旧版写的 `.syncx-folder` 标记文件,
//!     并把旧版回收站 `.syncx-trash` 的内容搬到共享目录之外。这两样留在用户
//!     目录里都会以未跟踪文件的形式污染 git status。
//!
//! 每一步都 best-effort:任何一步失败只记日志,不阻塞启动 —— 自愈是给「升级
//! 后的第一次启动」兜底的,不能反过来变成新的启动失败点。

use std::path::{Path, PathBuf};

use syncx_api::config::{folder_index_path, folder_trash_path, Config, ConfigStore, SharedFolder};
use syncx_api::mutate::read_folder_identity;
use syncx_daemon::indexstore::IndexStore;

/// 旧版标记文件的内容前缀(用于确认「这个文件确实是 syncx 写的」再删)。
const LEGACY_MARKER_BANNER: &str = "此文件由 syncx 生成";
/// 旧版本写在共享根里的挂载标记文件名与回收站目录名。**不再创建**,只用于清理。
const LEGACY_FOLDER_MARKER: &str = ".syncx-folder";
const LEGACY_TRASH_DIR: &str = ".syncx-trash";

/// 入口:按序跑完三步。在 `reload_actor` 之前调用。
pub fn run(store: &ConfigStore, config_dir: &Path) {
    let config = store.load();
    for path in purge_orphan_indexes(config_dir, &config) {
        tracing::info!("已回收不在配置内的孤儿索引库:{}", path.display());
    }
    let adopted = adopt_folder_identities(store, config_dir);
    // 收养之后配置可能已变(写回了指纹),元数据清理读最新一份。
    cleanup_legacy_metadata(&store.load(), config_dir, &adopted);
}

/* ---------------- 1) 孤儿索引回收 ---------------- */

/// 删除 configDir 下所有不属于期望集合的 `index-<16hex>.db`(连同 sidecar)。
///
/// 期望集合 = 每个配置目录的索引库路径。删除失败(被占用)跳过、下次启动再试 ——
/// 索引残留不会变成正确性问题:目录实例化后新实例永远打开自己名下的库文件。
pub fn purge_orphan_indexes(config_dir: &Path, config: &Config) -> Vec<PathBuf> {
    let expected: std::collections::HashSet<String> = config
        .shared_folders
        .iter()
        .map(|folder| {
            folder_index_path(config_dir, folder)
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default()
                .to_string()
        })
        .collect();
    let Ok(names) = std::fs::read_dir(config_dir) else {
        return Vec::new();
    };
    let mut removed = Vec::new();
    for entry in names.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let Some(stem) = index_db_stem(&name) else {
            continue;
        };
        if expected.contains(&stem) {
            continue; // 在册目录(含其 sidecar)保留
        }
        if std::fs::remove_file(entry.path()).is_ok() {
            removed.push(entry.path());
        }
    }
    removed
}

/// 从文件名剥出 `index-<hash>.db` 主干:sidecar(`-journal`/`-wal`/`-shm`)归到
/// 同一主干,主库与 sidecar 一起删。不是索引库文件 → `None`。
fn index_db_stem(name: &str) -> Option<String> {
    let base = name.strip_suffix(".db").unwrap_or(name);
    for suffix in ["-journal", "-wal", "-shm"] {
        if let Some(stripped) = base.strip_suffix(suffix) {
            // 只有 `-shm`/`-wal`/`-journal` 跟在 `.db` 后面才是 SQLite sidecar;
            // `index-xxx.db-shm` 的 base 已含 `.db`,剥出主干后再校验格式。
            return index_db_name(stripped).map(str::to_string);
        }
    }
    index_db_name(name).map(str::to_string)
}

/// 校验 `index-<16 位十六进制>.db` 形态并原样返回。
fn index_db_name(name: &str) -> Option<&str> {
    let rest = name.strip_prefix("index-")?;
    let hash = rest.strip_suffix(".db")?;
    if hash.len() == 16 && hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        Some(name)
    } else {
        None
    }
}

/* ---------------- 2) 目录身份指纹收养 ---------------- */

/// 为没有 `folderIdentity` 的存量目录采集指纹并落盘。返回收养成功的目录路径
/// (供元数据清理判定「这个目录已被信任」)。
///
/// 只收养一次;目录不存在留给下次启动。平台/文件系统不提供 inode(部分网络盘)
/// 时留空:运行期退化为结构守卫,不凭空信任。
pub fn adopt_folder_identities(store: &ConfigStore, config_dir: &Path) -> Vec<String> {
    let mut adopted: Vec<String> = Vec::new();
    let _ = store.mutate::<_, std::io::Error>(|config| {
        let mut changed = false;
        for folder in config.shared_folders.iter_mut() {
            if folder.folder_identity.is_some() {
                continue;
            }
            let root = Path::new(&folder.path);
            if !root.is_dir() {
                continue;
            }
            if index_has_live_entries(config_dir, folder) && dir_top_is_empty(root) {
                tracing::warn!(
                    path = %folder.path,
                    "目录顶层为空但索引仍有活条目,拒绝自动收养身份 \
                     (确认目录内容无误后,在界面移除并重新添加该目录)"
                );
                continue;
            }
            let Some(identity) = read_folder_identity(root) else {
                tracing::warn!(path = %folder.path, "文件系统不提供 inode,身份指纹留空");
                continue;
            };
            let dev = identity.get("dev").and_then(|v| v.as_str()).unwrap_or("");
            let ino = identity.get("ino").and_then(|v| v.as_str()).unwrap_or("");
            tracing::info!(path = %folder.path, dev, ino, "已记录共享目录身份指纹");
            folder.folder_identity = Some(identity);
            adopted.push(folder.path.clone());
            changed = true;
        }
        Ok(changed)
    });
    adopted
}

/// 目录索引里是否存在活条目(非墓碑)。用于收养前判断该目录是否曾同步过真实
/// 文件:有活条目 + 目录顶层为空,是「盘未挂载 / 目录被整体清空」的典型形态,
/// 此时不能贸然补指纹。任何读取异常都按 false 处理,不因诊断失败阻塞启动。
fn index_has_live_entries(config_dir: &Path, folder: &SharedFolder) -> bool {
    let path = folder_index_path(config_dir, folder);
    let Ok(store) = IndexStore::open(&path) else {
        return false;
    };
    store
        .list_entries()
        .map(|entries| entries.iter().any(|entry| !entry.deleted))
        .unwrap_or(false)
}

fn dir_top_is_empty(root: &Path) -> bool {
    std::fs::read_dir(root)
        .map(|mut it| it.next().is_none())
        .unwrap_or(false)
}

/* ---------------- 3) 共享目录内遗留元数据清理 ---------------- */

/// 删掉旧版标记文件、把旧版回收站搬到共享目录之外。
///
/// 只清理**已确认身份**的目录:没记下指纹就说明这个目录还没被信任,此时动它的
/// 内容(哪怕只是删一个标记文件)都不合适,留给下次启动。
fn cleanup_legacy_metadata(config: &Config, config_dir: &Path, adopted: &[String]) {
    for folder in &config.shared_folders {
        if folder.folder_identity.is_none() && !adopted.contains(&folder.path) {
            continue;
        }
        let root = Path::new(&folder.path);
        if !root.is_dir() {
            continue;
        }
        if remove_legacy_folder_marker(root) {
            tracing::info!(path = %folder.path, "已删除旧版挂载标记文件");
        }
        let (moved, failed) = migrate_legacy_trash(root, &folder_trash_path(config_dir, folder));
        if moved > 0 {
            tracing::info!(path = %folder.path, moved, "旧版回收站已搬出共享目录");
        }
        if failed > 0 {
            tracing::warn!(path = %folder.path, failed, "旧版回收站搬运未完成,原目录保留");
        }
    }
}

/// 删除共享根里遗留的旧版标记文件。只删「确实是 syncx 生成的」那一个:同名但
/// 内容不符的文件保持不动(绝不误删用户文件)。
fn remove_legacy_folder_marker(root: &Path) -> bool {
    let path = root.join(LEGACY_FOLDER_MARKER);
    let Ok(meta) = std::fs::metadata(&path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    if meta.len() > 0 && !marker_is_ours(&path) {
        return false;
    }
    std::fs::remove_file(&path).is_ok()
}

/// 标记文件是否确实是 syncx 写的:内容以固定横幅开头(0 字节空文件也算 ——
/// 旧版本某些路径下会留下空标记)。
fn marker_is_ours(path: &Path) -> bool {
    let Ok(bytes) = std::fs::read(path) else {
        return false;
    };
    if bytes.len() > 4096 {
        return false;
    }
    String::from_utf8_lossy(&bytes).starts_with(LEGACY_MARKER_BANNER)
}

/// 把旧版回收站里的内容整体搬到新回收站目录(共享目录之外)。
///
/// 逐文件搬:同文件系统走 rename(瞬时),跨文件系统/文件被占用时退化为拷贝
/// 后删。任何单个文件搬运失败就保留原目录,绝不因为「搬不动」丢掉可恢复数据。
fn migrate_legacy_trash(root: &Path, dest_dir: &Path) -> (usize, usize) {
    let from = root.join(LEGACY_TRASH_DIR);
    if !from.is_dir() {
        return (0, 0);
    }
    let mut moved = 0;
    let mut failed = 0;
    let mut stack = vec![from.clone()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            failed += 1;
            continue;
        };
        for entry in entries.flatten() {
            let src = entry.path();
            if src.is_dir() {
                stack.push(src);
                continue;
            }
            // 相对路径以 '/' 拼接:与同步路径同构,避免 Windows 的 '\'
            let rel = src
                .strip_prefix(&from)
                .unwrap_or(&src)
                .to_string_lossy()
                .replace('\\', "/");
            let dest = dest_dir.join(&rel);
            if let Some(parent) = dest.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let ok = match std::fs::rename(&src, &dest) {
                Ok(()) => true,
                Err(_) => std::fs::copy(&src, &dest).is_ok() && std::fs::remove_file(&src).is_ok(),
            };
            if ok {
                moved += 1;
            } else {
                failed += 1;
            }
        }
    }
    // 只在全部搬完时移除原目录:有任何失败就原样保留,交给用户/下次启动处理
    if failed == 0 {
        let _ = std::fs::remove_dir_all(&from);
    }
    (moved, failed)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "syncx-selfheal-{}-{}-{tag}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn index_db_stem_recognizes_mains_and_sidecars() {
        assert_eq!(
            index_db_stem("index-0123456789abcdef.db"),
            Some("index-0123456789abcdef.db".to_string())
        );
        assert_eq!(
            index_db_stem("index-0123456789abcdef.db-wal"),
            Some("index-0123456789abcdef.db".to_string())
        );
        assert_eq!(
            index_db_stem("index-0123456789abcdef.db-journal"),
            Some("index-0123456789abcdef.db".to_string())
        );
        // 哈希长度不对 / 前缀不对 / 普通文件:一概不认
        assert_eq!(index_db_stem("index-abc.db"), None);
        assert_eq!(index_db_stem("index-0123456789abcdefg.db"), None);
        assert_eq!(index_db_stem("config.json"), None);
    }

    #[test]
    fn orphan_purge_keeps_expected_and_sidecars() {
        let dir = TempDir::new("purge");
        let folder = SharedFolder {
            path: "/nowhere".to_string(),
            id: Some("f1".to_string()),
            ..Default::default()
        };
        let expected = folder_index_path(&dir.0, &folder);
        let expected_name = expected.file_name().unwrap().to_str().unwrap();
        std::fs::write(dir.0.join(expected_name), b"db").unwrap();
        std::fs::write(dir.0.join(format!("{expected_name}-wal")), b"wal").unwrap();
        std::fs::write(dir.0.join("index-ffffffffffffffff.db"), b"orphan").unwrap();
        std::fs::write(dir.0.join("index-ffffffffffffffff.db-shm"), b"shm").unwrap();
        std::fs::write(dir.0.join("config.json"), b"{}").unwrap();

        let config = Config {
            shared_folders: vec![folder],
            ..Default::default()
        };
        let removed = purge_orphan_indexes(&dir.0, &config);
        assert_eq!(removed.len(), 2, "孤儿主库 + sidecar 都要删");
        assert!(dir.0.join(expected_name).exists(), "在册主库保留");
        assert!(
            dir.0.join(format!("{expected_name}-wal")).exists(),
            "在册 sidecar 保留"
        );
        assert!(dir.0.join("config.json").exists(), "无关文件不动");
    }

    #[test]
    fn legacy_marker_only_removed_when_ours() {
        let dir = TempDir::new("marker");
        // 我们写的(带横幅)→ 删
        std::fs::write(
            dir.0.join(LEGACY_FOLDER_MARKER),
            format!("{LEGACY_MARKER_BANNER} blah"),
        )
        .unwrap();
        assert!(remove_legacy_folder_marker(&dir.0));
        // 用户自己的同名文件 → 不动
        std::fs::write(dir.0.join(LEGACY_FOLDER_MARKER), "my own file").unwrap();
        assert!(!remove_legacy_folder_marker(&dir.0));
    }

    #[test]
    fn legacy_trash_migrates_nested_files() {
        let dir = TempDir::new("trash");
        let root = dir.0.join("root");
        std::fs::create_dir_all(root.join(LEGACY_TRASH_DIR).join("sub")).unwrap();
        std::fs::write(root.join(LEGACY_TRASH_DIR).join("a.txt"), b"a").unwrap();
        std::fs::write(root.join(LEGACY_TRASH_DIR).join("sub").join("b.txt"), b"b").unwrap();

        let dest = dir.0.join("trash-dest");
        let (moved, failed) = migrate_legacy_trash(&root, &dest);
        assert_eq!((moved, failed), (2, 0));
        assert!(!root.join(LEGACY_TRASH_DIR).exists(), "搬空后原目录移除");
        assert!(dest.join("a.txt").exists());
        assert_eq!(std::fs::read(dest.join("sub").join("b.txt")).unwrap(), b"b");
    }
}
