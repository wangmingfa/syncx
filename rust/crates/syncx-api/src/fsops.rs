//! 落在**本机磁盘**上的目录内操作:版本留档、回收站、时间机器、冲突收件箱、空目录清理。
//!
//! 这些动作不依赖任何活着的对端会话,只读/写 `<configDir>/versions`、`<configDir>/trash`
//! 与共享根本身,所以实现在 API 层而不是经 `ControlOps` 注入 —— 两个后端必须对同一批
//! 文件给出同一个答案(命名、排序、越界判定),注入只会给漂移留口子。
//!
//! 与 Node 的对应关系逐函数写在各自注释里。**文件名规则是跨后端契约**:
//! `<relPath>.<base36 ts>[.<n>]`(回收站)与 `<relPath>.syncx-v-<base36 ts>[.<n>]`(版本),
//! 任一端解析不了另一端的产物,「切换后端后历史全丢」就是必然结果。

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

use regex::Regex;
use serde_json::{json, Value};

use crate::config::{self, SharedFolder};
use crate::history::HistoryStore;

/* ==================== 路径与命名 ==================== */

/// 共享根下的相对路径做**词法**归一 + 越界判定。
///
/// 与 [`crate::filebrowser::resolve_folder_subpath`] 的区别:这里**不要求路径存在**
/// —— 回收站还原、版本恢复的目标路径通常还不存在。防越界因此靠逐段消解 `..`,
/// 而不是靠 canonicalize。
pub fn safe_join(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel.contains('\0') {
        return Err("路径包含非法字符".to_string());
    }
    let normalized = rel.replace('\\', "/");
    if normalized.starts_with('/') || is_drive_absolute(&normalized) {
        return Err("必须是共享目录内的相对路径".to_string());
    }
    let mut path = root.to_path_buf();
    for segment in normalized.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                if !path.pop() || !path.starts_with(root) {
                    return Err("路径越出共享目录".to_string());
                }
            }
            other => path.push(other),
        }
    }
    if !path.starts_with(root) {
        return Err("路径越出共享目录".to_string());
    }
    Ok(path)
}

fn is_drive_absolute(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

/// 共享根的 realpath。根不存在时由调用方转 400。
pub fn root_of(folder: &SharedFolder) -> Result<PathBuf, String> {
    std::fs::canonicalize(&folder.path).map_err(|_| "共享目录不可访问".to_string())
}

fn stamp36(now: i64) -> String {
    let mut n = now.max(0) as u64;
    if n == 0 {
        return "0".to_string();
    }
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    while n > 0 {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8_lossy(&out).to_string()
}

/// 版本文件名解析:captures `(原相对路径, 快照时刻)`。
pub fn parse_version_name(file: &str) -> Option<(String, i64)> {
    let re = version_name_regex();
    let caps = re.captures(file)?;
    let ts = i64::from_str_radix(caps.get(2)?.as_str(), 36).ok()?;
    Some((caps.get(1)?.as_str().to_string(), ts))
}

/// 回收站文件名解析。时间戳下限挡住「文件名自带 8–13 位日期后缀」的误判。
pub fn parse_trash_name(file: &str) -> Option<(String, i64)> {
    let re = trash_name_regex();
    let caps = re.captures(file)?;
    let head = caps.get(1)?.as_str();
    // 版本文件名本身以 `.syncx-v-` 收尾时不能被当成回收站条目
    if head.ends_with(".syncx-v") {
        return None;
    }
    let ts = i64::from_str_radix(caps.get(2)?.as_str(), 36).ok()?;
    if ts < 100_000_000_000 {
        return None;
    }
    Some((head.to_string(), ts))
}

/// 版本文件 → 原相对路径(去掉 `.syncx-v-<ts>[.<n>]` 尾巴)。
pub fn version_original_path(file: &str) -> String {
    match version_name_regex().captures(file) {
        Some(caps) => caps.get(1).map(|m| m.as_str().to_string()).unwrap_or_else(|| file.to_string()),
        None => file.to_string(),
    }
}

fn version_name_regex() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^(.*)\.syncx-v-([0-9a-z]+)(\.[0-9]+)?$").expect("版本名正则固定"))
}

fn trash_name_regex() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^(.*)\.([0-9a-z]{8,13})(\.[0-9]+)?$").expect("回收站名正则固定"))
}

/// 递归列目录下的全部文件(相对路径,`/` 分隔)。目录不存在 → 空。
fn walk_files(dir: &Path, prefix: &str, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let name = entry.file_name().to_string_lossy().to_string();
        let rel = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            walk_files(&entry.path(), &rel, out);
        } else if meta.is_file() {
            out.push(rel);
        }
    }
}

/// 版本目录里的全部文件(编辑器列表口径,未解析命名)。
pub fn list_version_files(versions_dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    walk_files(versions_dir, "", &mut out);
    out
}

/// 版本文件定位 + 越界校验。与 Node `locateVersionFile` 同口径。
pub fn locate_version_file(versions_dir: &Path, file: &str) -> Result<PathBuf, String> {
    if file.is_empty() || !file.contains(".syncx-v-") {
        return Err("invalid version file".to_string());
    }
    let abs = safe_join(versions_dir, file)?;
    Ok(abs)
}

/* ==================== 版本 ==================== */

/// `{ versions: [{file, path, size, mtime}] }`,按路径再按文件名排序。
pub fn list_versions(versions_dir: &Path) -> Value {
    let mut rows: Vec<Value> = Vec::new();
    for file in list_version_files(versions_dir) {
        let abs = versions_dir.join(&file);
        let Ok(meta) = std::fs::metadata(&abs) else {
            continue;
        };
        rows.push(json!({
            "file": file,
            "path": version_original_path(&file),
            "size": meta.len(),
            "mtime": crate::filebrowser::mtime_ms(&meta),
        }));
    }
    rows.sort_by(|a, b| {
        let pa = a["path"].as_str().unwrap_or("");
        let pb = b["path"].as_str().unwrap_or("");
        let fa = a["file"].as_str().unwrap_or("");
        let fb = b["file"].as_str().unwrap_or("");
        pa.cmp(pb).then_with(|| fa.cmp(fb))
    });
    json!({ "versions": rows })
}

/// 恢复一个版本回原路径:**恢复前先把当前内容留档**,动作本身可逆。
pub fn restore_version(
    folder: &SharedFolder,
    versions_dir: &Path,
    file: &str,
    now: i64,
) -> Result<(), String> {
    let src = locate_version_file(versions_dir, file)?;
    let meta = std::fs::metadata(&src).map_err(|_| "version not found".to_string())?;
    if !meta.is_file() {
        return Err("version not found".to_string());
    }
    let root = root_of(folder)?;
    let rel_path = version_original_path(file);
    let dest = safe_join(&root, &rel_path)?;

    if std::fs::metadata(&dest).map(|m| m.is_file()).unwrap_or(false) {
        std::fs::create_dir_all(versions_dir).map_err(|e| e.to_string())?;
        let base = versions_dir.join(format!("{rel_path}.syncx-v-{}", stamp36(now)));
        let backup = unique_path(&base);
        if let Some(parent) = backup.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::copy(&dest, &backup).map_err(|e| e.to_string())?;
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::copy(&src, &dest).map_err(|e| e.to_string())?;
    Ok(())
}

/// 删除单个版本文件。
pub fn delete_version(versions_dir: &Path, file: &str) -> Result<(), String> {
    let abs = locate_version_file(versions_dir, file)?;
    std::fs::remove_file(abs).map_err(|e| e.to_string())
}

/// 读单个版本文件内容。超 1MB 或含 NUL 时只回状态不回内容 —— 与对比页同一口径。
pub fn version_content(versions_dir: &Path, file: &str) -> Result<Value, String> {
    let abs = locate_version_file(versions_dir, file)?;
    let Ok(meta) = std::fs::metadata(&abs) else {
        return Ok(json!({ "exists": false }));
    };
    if !meta.is_file() {
        return Ok(json!({ "exists": false }));
    }
    let size = meta.len();
    if size > 1_000_000 {
        return Ok(json!({ "exists": true, "size": size, "tooLarge": true }));
    }
    let bytes = std::fs::read(&abs).map_err(|e| e.to_string())?;
    if bytes.contains(&0) {
        return Ok(json!({ "exists": true, "size": size, "binary": true }));
    }
    Ok(json!({
        "exists": true,
        "size": size,
        "text": String::from_utf8_lossy(&bytes).to_string(),
    }))
}

/* ==================== 回收站 ==================== */

/// 回收站条目:`{file, path, ts, size}`,新删在前。
pub fn list_trash(trash_dir: &Path) -> Value {
    let mut files = Vec::new();
    walk_files(trash_dir, "", &mut files);
    let mut rows: Vec<Value> = Vec::new();
    for file in files {
        let Some((rel_path, ts)) = parse_trash_name(&file) else {
            continue;
        };
        let size = std::fs::metadata(trash_dir.join(&file))
            .map(|meta| meta.len())
            .unwrap_or(0);
        rows.push(json!({ "file": file, "path": rel_path, "ts": ts, "size": size }));
    }
    rows.sort_by(|a, b| {
        b["ts"]
            .as_i64()
            .unwrap_or(0)
            .cmp(&a["ts"].as_i64().unwrap_or(0))
    });
    json!({ "entries": rows })
}

/// 把回收站副本搬回原路径;同名实体已在时先挪进回收站(还原动作可逆)。
pub fn restore_trash(
    folder: &SharedFolder,
    trash_dir: &Path,
    file: &str,
    now: i64,
) -> Result<(), String> {
    let src = safe_join(trash_dir, file)?;
    if !std::fs::metadata(&src).map(|m| m.is_file()).unwrap_or(false) {
        return Err("回收站里没有这个副本".to_string());
    }
    let normalized = file.replace('\\', "/");
    let Some((rel_path, _)) = parse_trash_name(&normalized) else {
        return Err("回收站副本命名无法识别".to_string());
    };
    let root = root_of(folder)?;
    let dest = safe_join(&root, &rel_path)?;
    if dest.exists() {
        std::fs::create_dir_all(trash_dir).map_err(|e| e.to_string())?;
        let backup = unique_path(&trash_dir.join(format!("{rel_path}.{}", stamp36(now))));
        if let Some(parent) = backup.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::rename(&dest, &backup).map_err(|e| e.to_string())?;
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&src, &dest).map_err(|e| e.to_string())
}

/// 彻底删除:`file` 缺失/空 = 清空该目录整个回收站。
pub fn purge_trash(trash_dir: &Path, file: Option<&str>) -> Result<(), String> {
    match file {
        None | Some("") => {
            let _ = std::fs::remove_dir_all(trash_dir);
            Ok(())
        }
        Some(file) => {
            let target = safe_join(trash_dir, file)?;
            if !target.exists() {
                return Err("回收站里没有这个副本".to_string());
            }
            let meta = std::fs::symlink_metadata(&target).map_err(|e| e.to_string())?;
            if meta.is_dir() {
                std::fs::remove_dir_all(&target).map_err(|e| e.to_string())
            } else {
                std::fs::remove_file(&target).map_err(|e| e.to_string())
            }
        }
    }
}

/* ==================== 时间机器(整目录回滚) ==================== */

#[derive(Debug, Clone)]
pub struct VersionRef {
    pub file: String,
    pub rel_path: String,
    pub ts: i64,
}

#[derive(Debug, Clone)]
pub struct TrashRef {
    pub file: String,
    pub rel_path: String,
    pub ts: i64,
}

/// 递归解析版本目录为引用表(未命中命名的文件忽略)。
pub fn list_version_refs(versions_dir: &Path) -> Vec<VersionRef> {
    let mut out = Vec::new();
    for file in list_version_files(versions_dir) {
        if let Some((rel_path, ts)) = parse_version_name(&file) {
            out.push(VersionRef { file, rel_path, ts });
        }
    }
    out
}

/// 递归解析回收站目录为引用表。
pub fn list_trash_refs(trash_dir: &Path) -> Vec<TrashRef> {
    let mut files = Vec::new();
    walk_files(trash_dir, "", &mut files);
    let mut out = Vec::new();
    for file in files {
        if let Some((rel_path, ts)) = parse_trash_name(&file) {
            out.push(TrashRef { file, rel_path, ts });
        }
    }
    out
}

/// 当前目录实况:相对路径 → mtime(ms)。跳过硬忽略名与 `.syncx-*` 元数据。
pub fn walk_current_files(root: &Path) -> HashMap<String, i64> {
    fn walk(root: &Path, rel_dir: &str, out: &mut HashMap<String, i64>) {
        let Ok(entries) = std::fs::read_dir(if rel_dir.is_empty() {
            root.to_path_buf()
        } else {
            root.join(rel_dir)
        }) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let rel = if rel_dir.is_empty() {
                name.clone()
            } else {
                format!("{rel_dir}/{name}")
            };
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                if crate::fsops::is_hard_ignore_name(&name) || name.starts_with(".syncx-") {
                    continue;
                }
                walk(root, &rel, out);
                continue;
            }
            if !meta.is_file() {
                continue;
            }
            if crate::fsops::is_hard_ignore_name(&name) {
                continue;
            }
            out.insert(rel, crate::filebrowser::mtime_ms(&meta));
        }
    }
    let mut out = HashMap::new();
    walk(root, "", &mut out);
    out
}

fn is_hard_ignore_name(name: &str) -> bool {
    syncx_core::ignore::HARD_IGNORE_NAMES
        .iter()
        .any(|known| known.eq_ignore_ascii_case(name))
}

#[derive(Debug, Default)]
pub struct RollbackPlan {
    pub restores: Vec<(String, String, i64)>,
    pub trash_current: Vec<String>,
    pub from_trash: Vec<(String, String)>,
    pub no_snapshot: Vec<String>,
    pub lost_deletes: Vec<String>,
}

/// 纯规划:证据集 + 目标时刻 → 回滚计划。对应 Node `planRollback`,逐条同规则。
pub fn plan_rollback(
    versions: &[VersionRef],
    trash: &[TrashRef],
    history: &[(i64, String, String)],
    current: &HashMap<String, i64>,
    target_ts: i64,
) -> RollbackPlan {
    #[derive(Default)]
    struct Entry {
        versions: Vec<VersionRef>,
        trash: Vec<TrashRef>,
        events: Vec<(i64, String, String)>,
        current_mtime: Option<i64>,
    }
    let mut by_path: BTreeMap<String, Entry> = BTreeMap::new();
    for version in versions {
        by_path
            .entry(version.rel_path.clone())
            .or_default()
            .versions
            .push(version.clone());
    }
    for item in trash {
        by_path
            .entry(item.rel_path.clone())
            .or_default()
            .trash
            .push(item.clone());
    }
    for (ts, path, action) in history {
        by_path
            .entry(path.clone())
            .or_default()
            .events
            .push((*ts, path.clone(), action.clone()));
    }
    for (path, mtime) in current {
        by_path.entry(path.clone()).or_default().current_mtime = Some(*mtime);
    }

    let mut plan = RollbackPlan::default();
    for (rel_path, mut entry) in by_path {
        entry.versions.sort_by_key(|v| v.ts);
        entry.trash.sort_by_key(|t| t.ts);
        entry.events.sort_by_key(|(ts, _, _)| *ts);

        // T 时刻内容的最佳快照:最早的 stamp > T(捕获的正是 T 那代内容);否则最晚的 ≤ T
        let after_t = entry.versions.iter().find(|v| v.ts > target_ts).cloned();
        let before_t = entry
            .versions
            .iter()
            .rev()
            .find(|v| v.ts <= target_ts)
            .cloned();
        let best_at_t = after_t.clone().or(before_t);

        let added_after_t = entry
            .events
            .first()
            .map(|(ts, _, action)| action == "add" && *ts > target_ts)
            .unwrap_or(false)
            && entry.versions.is_empty();

        if let Some(cur) = entry.current_mtime {
            if added_after_t {
                plan.trash_current.push(rel_path);
                continue;
            }
            let changed_since_t = cur > target_ts;
            if let Some(best) = best_at_t {
                if changed_since_t || after_t.is_some() {
                    plan.restores.push((rel_path, best.file, best.ts));
                    continue;
                }
            }
            if changed_since_t && !entry.events.is_empty() {
                plan.no_snapshot.push(rel_path);
            }
            continue;
        }

        // 当前不存在:可能是「T 后删除」或「T 后新增又删掉」
        if let Some(best) = best_at_t {
            plan.restores.push((rel_path, best.file, best.ts));
            continue;
        }
        let deleted_after_t = entry
            .events
            .iter()
            .any(|(ts, _, action)| action == "delete" && *ts > target_ts);
        if deleted_after_t {
            let candidate = entry
                .trash
                .iter()
                .find(|t| t.ts > target_ts)
                .or_else(|| entry.trash.last());
            match candidate {
                Some(item) => plan.from_trash.push((rel_path, item.file.clone())),
                None => plan.lost_deletes.push(rel_path),
            }
        }
    }

    plan.restores.sort_by(|a, b| a.0.cmp(&b.0));
    plan.trash_current.sort();
    plan.from_trash.sort_by(|a, b| a.0.cmp(&b.0));
    plan
}

/// 计划的可读形状(响应体)。`dryRun` 与执行返同一份骨架,前端复用一段渲染。
pub fn plan_json(plan: &RollbackPlan, target_ts: i64) -> Value {
    json!({
        "targetTs": target_ts,
        "restores": plan.restores.iter().map(|(rel, file, ts)| json!({
            "relPath": rel, "versionFile": file, "versionTs": ts,
        })).collect::<Vec<_>>(),
        "trashCurrent": plan.trash_current.iter().map(|rel| json!({ "relPath": rel })).collect::<Vec<_>>(),
        "fromTrash": plan.from_trash.iter().map(|(rel, file)| json!({
            "relPath": rel, "trashFile": file,
        })).collect::<Vec<_>>(),
        "noSnapshot": plan.no_snapshot,
        "lostDeletes": plan.lost_deletes,
        "counts": {
            "restores": plan.restores.len(),
            "trashCurrent": plan.trash_current.len(),
            "fromTrash": plan.from_trash.len(),
            "noSnapshot": plan.no_snapshot.len(),
            "lostDeletes": plan.lost_deletes.len(),
        },
    })
}

/// 执行计划:破坏性动作一律先归档,失败逐条计数,不留半截状态。
pub fn apply_rollback(
    plan: &RollbackPlan,
    root: &Path,
    versions_dir: &Path,
    trash_dir: &Path,
    now: i64,
) -> Value {
    let mut restored = 0;
    let mut trashed = 0;
    let mut from_trash = 0;
    let mut failed = 0;

    for (rel_path, version_file, _) in &plan.restores {
        let step = (|| -> Result<(), String> {
            let src = versions_dir.join(version_file);
            if !src.exists() {
                return Err("version missing".to_string());
            }
            let dest = safe_join(root, rel_path)?;
            if dest.exists() {
                std::fs::create_dir_all(versions_dir).map_err(|e| e.to_string())?;
                let backup = unique_path(
                    &versions_dir.join(format!("{rel_path}.syncx-v-{}", stamp36(now))),
                );
                if let Some(parent) = backup.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                std::fs::copy(&dest, &backup).map_err(|e| e.to_string())?;
            }
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::copy(&src, &dest).map_err(|e| e.to_string())?;
            Ok(())
        })();
        match step {
            Ok(()) => restored += 1,
            Err(_) => failed += 1,
        }
    }

    for rel_path in &plan.trash_current {
        let step = (|| -> Result<(), String> {
            let current = safe_join(root, rel_path)?;
            if !current.exists() {
                return Ok(());
            }
            std::fs::create_dir_all(trash_dir).map_err(|e| e.to_string())?;
            let dest = unique_path(&trash_dir.join(format!("{rel_path}.{}", stamp36(now))));
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::rename(&current, &dest).map_err(|e| e.to_string())?;
            Ok(())
        })();
        match step {
            Ok(()) => trashed += 1,
            Err(_) => failed += 1,
        }
    }

    for (rel_path, trash_file) in &plan.from_trash {
        let step = (|| -> Result<(), String> {
            let src = trash_dir.join(trash_file);
            if !src.exists() {
                return Err("trash copy missing".to_string());
            }
            let dest = safe_join(root, rel_path)?;
            if dest.exists() {
                std::fs::remove_file(&dest).map_err(|e| e.to_string())?;
            }
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::rename(&src, &dest).map_err(|e| e.to_string())?;
            Ok(())
        })();
        match step {
            Ok(()) => from_trash += 1,
            Err(_) => failed += 1,
        }
    }

    json!({
        "restored": restored,
        "trashed": trashed,
        "fromTrash": from_trash,
        "failed": failed,
    })
}

/// 整目录回滚:证据采集 + 规划 + (可选)执行。`dry_run` 只回计划。
pub fn rollback_folder(
    folder: &SharedFolder,
    config_dir: &Path,
    history: &HistoryStore,
    target_ts: i64,
    dry_run: bool,
    now: i64,
) -> Result<Value, String> {
    let root = root_of(folder)?;
    let key = folder.index_key();
    let versions_dir = config_dir.join("versions").join(config::short_hash(&key));
    let trash_dir = config_dir.join("trash").join(config::short_hash(&key));

    let result = history.query(&folder.folder_id(), usize::MAX, &Default::default());
    let events: Vec<(i64, String, String)> = result
        .events
        .iter()
        .map(|event| (event.ts, event.path.clone(), event.action.clone()))
        .collect();

    let plan = plan_rollback(
        &list_version_refs(&versions_dir),
        &list_trash_refs(&trash_dir),
        &events,
        &walk_current_files(&root),
        target_ts,
    );
    if dry_run {
        return Ok(json!({ "dryRun": true, "plan": plan_json(&plan, target_ts) }));
    }
    let applied = apply_rollback(&plan, &root, &versions_dir, &trash_dir, now);
    Ok(json!({
        "dryRun": false,
        "plan": plan_json(&plan, target_ts),
        "result": applied,
    }))
}

/* ==================== 冲突收件箱 ==================== */

const MAX_SCAN_ENTRIES: usize = 20_000;
const MAX_CONFLICT_RESULTS: usize = 500;
const IDENTICAL_MAX_BYTES: u64 = 32 * 1024 * 1024;
const RMDIR_CHANGED: &str = "删除时目录内容有变化,未完成(未删除任何文件)";

fn split_rel(rel_path: &str) -> (&str, &str) {
    match rel_path.rfind('/') {
        Some(index) => (&rel_path[..=index], &rel_path[index + 1..]),
        None => ("", rel_path),
    }
}

fn compare_with_original(copy_abs: &Path, original_abs: &Path, size: u64) -> Option<bool> {
    let meta = std::fs::metadata(original_abs).ok()?;
    if !meta.is_file() {
        return None;
    }
    if meta.len() != size {
        return Some(false);
    }
    if size > IDENTICAL_MAX_BYTES {
        return None;
    }
    let copy = std::fs::read(copy_abs).ok()?;
    let original = std::fs::read(original_abs).ok()?;
    Some(copy == original)
}

/// 实时扫描共享根内的 `.sync-conflict-*` 副本。
pub fn list_conflicts(root: &Path) -> Value {
    let mut conflicts: Vec<Value> = Vec::new();
    let mut scanned = 0usize;
    let mut truncated = false;

    fn walk(
        root: &Path,
        rel_dir: &str,
        scanned: &mut usize,
        truncated: &mut bool,
        conflicts: &mut Vec<Value>,
    ) {
        if *truncated {
            return;
        }
        let dir = if rel_dir.is_empty() {
            root.to_path_buf()
        } else {
            root.join(rel_dir)
        };
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return;
        };
        for entry in entries.flatten() {
            if *truncated {
                return;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let rel = if rel_dir.is_empty() {
                name.clone()
            } else {
                format!("{rel_dir}/{name}")
            };
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                if is_hard_ignore_name(&name) {
                    continue;
                }
                walk(root, &rel, scanned, truncated, conflicts);
                continue;
            }
            if !meta.is_file() {
                continue;
            }
            *scanned += 1;
            if *scanned > MAX_SCAN_ENTRIES || conflicts.len() >= MAX_CONFLICT_RESULTS {
                *truncated = true;
                return;
            }
            let Some((original_name, device_id)) =
                syncx_core::ignore::parse_conflict_copy_name(&name)
            else {
                continue;
            };
            let copy_abs = root.join(&rel);
            let size = meta.len();
            let mtime = crate::filebrowser::mtime_ms(&meta);
            let original_rel = if rel_dir.is_empty() {
                original_name
            } else {
                format!("{rel_dir}/{original_name}")
            };
            let identical = compare_with_original(&copy_abs, &root.join(&original_rel), size);
            conflicts.push(json!({
                "copyPath": rel,
                "originalPath": original_rel,
                "deviceId": device_id,
                "size": size,
                "mtime": mtime,
                "identical": identical,
            }));
        }
    }

    walk(root, "", &mut scanned, &mut truncated, &mut conflicts);
    conflicts.sort_by(|a, b| {
        b["mtime"]
            .as_i64()
            .unwrap_or(0)
            .cmp(&a["mtime"].as_i64().unwrap_or(0))
    });
    json!({ "conflicts": conflicts, "truncated": truncated })
}

/// 与 executor 的回收站落盘同式:保留相对结构 + base36 时间戳后缀,碰撞加序号。
fn move_to_trash_file(root: &Path, trash_dir: &Path, rel_path: &str, now: i64) -> Result<(), String> {
    let src = safe_join(root, rel_path)?;
    std::fs::create_dir_all(trash_dir).map_err(|e| e.to_string())?;
    let dest = unique_path(&trash_dir.join(format!("{rel_path}.{}", stamp36(now))));
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if std::fs::rename(&src, &dest).is_ok() {
        return Ok(());
    }
    // 跨文件系统 / 文件被占用:拷贝后删原,绝不静默丢弃
    std::fs::copy(&src, &dest).map_err(|e| e.to_string())?;
    std::fs::remove_file(&src).map_err(|e| e.to_string())
}

/// 覆盖前把原文件当前内容留档(命名与 executor 的 snapshotVersion 对齐)。
fn backup_to_versions(versions_dir: Option<&Path>, original_rel: &str, original_abs: &Path, now: i64) {
    let Some(versions_dir) = versions_dir else {
        return;
    };
    if !std::fs::metadata(original_abs).map(|m| m.is_file()).unwrap_or(false) {
        return;
    }
    if std::fs::create_dir_all(versions_dir).is_err() {
        return;
    }
    let backup = unique_path(&versions_dir.join(format!(
        "{original_rel}.syncx-v-{}",
        stamp36(now)
    )));
    if let Some(parent) = backup.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::copy(original_abs, backup);
}

/// 处理一条冲突副本:`keep-local` 用副本覆盖回原路径(当前内容先留档),`discard` 只搬走副本。
/// 两种收尾都把副本本身移进回收站 —— 绝不硬删,下次扫描也不会再报同一条。
pub fn resolve_conflict(
    root: &Path,
    trash_dir: &Path,
    versions_dir: Option<&Path>,
    copy_path: &str,
    choice: &str,
    now: i64,
) -> Result<(), String> {
    let (dir, name) = split_rel(copy_path);
    let Some((original_name, _)) = syncx_core::ignore::parse_conflict_copy_name(name) else {
        return Err("不是冲突副本命名".to_string());
    };
    let copy_abs = safe_join(root, copy_path)?;
    if !std::fs::metadata(&copy_abs).map(|m| m.is_file()).unwrap_or(false) {
        return Err("冲突副本已不存在".to_string());
    }
    let original_rel = format!("{dir}{original_name}");
    let original_abs = safe_join(root, &original_rel)?;
    match choice {
        "keep-local" => {
            backup_to_versions(versions_dir, &original_rel, &original_abs, now);
            if let Some(parent) = original_abs.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::copy(&copy_abs, &original_abs).map_err(|e| e.to_string())?;
        }
        "discard" => {}
        _ => return Err("未知处理方式".to_string()),
    }
    move_to_trash_file(root, trash_dir, copy_path, now)
}

/// 把逐块合并后的内容写回原文件;副本不动(用户还要显式丢弃/完成)。
pub fn merge_conflict(
    root: &Path,
    versions_dir: Option<&Path>,
    copy_path: &str,
    content: &str,
    now: i64,
) -> Result<(), String> {
    let (dir, name) = split_rel(copy_path);
    let Some((original_name, _)) = syncx_core::ignore::parse_conflict_copy_name(name) else {
        return Err("不是冲突副本命名".to_string());
    };
    let copy_abs = safe_join(root, copy_path)?;
    if !std::fs::metadata(&copy_abs).map(|m| m.is_file()).unwrap_or(false) {
        return Err("冲突副本已不存在".to_string());
    }
    let original_rel = format!("{dir}{original_name}");
    let original_abs = safe_join(root, &original_rel)?;
    backup_to_versions(versions_dir, &original_rel, &original_abs, now);
    if let Some(parent) = original_abs.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&original_abs, content).map_err(|e| e.to_string())
}

/// 一键清理逐字节无差异的副本,返回移走条数。
pub fn clean_identical_conflicts(
    root: &Path,
    trash_dir: &Path,
    versions_dir: Option<&Path>,
    now: i64,
) -> usize {
    let listing = list_conflicts(root);
    let mut removed = 0usize;
    for conflict in listing["conflicts"].as_array().cloned().unwrap_or_default() {
        if conflict["identical"].as_bool() != Some(true) {
            continue;
        }
        let Some(copy_path) = conflict["copyPath"].as_str() else {
            continue;
        };
        if resolve_conflict(root, trash_dir, versions_dir, copy_path, "discard", now).is_ok() {
            removed += 1;
        }
    }
    removed
}

/* ==================== 空目录 ==================== */

/// 盘点空目录 `{ dirs, truncated }`。规则与删除侧必须严格一致(见 Node 模块头注释)。
pub fn scan_empty_dirs(
    root: &Path,
    rules: &syncx_core::ignore::IgnoreRuleset,
    nested_roots: &[String],
    limit: usize,
) -> Value {
    let nested = build_nested_set(root, nested_roots);
    let mut dirs: Vec<String> = Vec::new();
    let mut truncated = false;

    // 递归内部函数:参数全是只读上下文,包成结构体只是把解构搬来搬去
    #[allow(clippy::too_many_arguments)]
    fn walk(
        abs_dir: &Path,
        rel_dir: &str,
        in_ignored: bool,
        nested: &HashSet<PathBuf>,
        rules: &syncx_core::ignore::IgnoreRuleset,
        limit: usize,
        dirs: &mut Vec<String>,
        truncated: &mut bool,
    ) -> bool {
        let Ok(entries) = std::fs::read_dir(abs_dir) else {
            // 读不动:无法证明为空,保守当有内容
            return true;
        };
        let mut has_content = false;
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let abs = abs_dir.join(&name);
            // 与 Node `Dirent.isDirectory()` 同义的 lstat 语义:软链(即便指向目录)
            // 也算内容,绝不递归、绝不列出 —— 否则删除侧要删的是别人的东西。
            let Ok(file_type) = entry.file_type() else {
                has_content = true;
                continue;
            };
            if !file_type.is_dir() {
                has_content = true;
                continue;
            }
            if is_nested(nested, &abs) {
                has_content = true;
                continue;
            }
            let rel = if rel_dir.is_empty() {
                name.clone()
            } else {
                format!("{rel_dir}/{name}")
            };
            let ignored = in_ignored
                || syncx_core::ignore::is_hard_ignored(&rel)
                || rules.is_ignored(&rel, true);
            if walk(&abs, &rel, ignored, nested, rules, limit, dirs, truncated) {
                has_content = true;
            } else if !ignored {
                if dirs.len() < limit {
                    dirs.push(rel);
                } else {
                    *truncated = true;
                }
            }
        }
        has_content
    }

    walk(root, "", false, &nested, rules, limit, &mut dirs, &mut truncated);
    dirs.sort();
    json!({ "dirs": dirs, "truncated": truncated })
}

/// 其它共享根中**严格含于** `root` 之内的那些(两级形式都收:字面绝对形式与 realpath)。
///
/// `root` 由调用方决定用字面形式(盘点)还是 realpath(删除),与 Node 各自的入参口径一致。
fn build_nested_set(root: &Path, nested_roots: &[String]) -> HashSet<PathBuf> {
    let root = std::path::absolute(root).unwrap_or_else(|_| root.to_path_buf());
    let mut set = HashSet::new();
    for nested_root in nested_roots {
        let literal = std::path::absolute(nested_root).unwrap_or_else(|_| PathBuf::from(nested_root));
        let mut forms = vec![literal.clone()];
        if let Ok(real) = literal.canonicalize() {
            if real != literal {
                forms.push(real);
            }
        }
        for form in forms {
            // 等于根本身 / 外层共享根都不算:外层本来就把本目录整棵跳过,不该约束内部删除
            if form != root && form.starts_with(&root) {
                set.insert(form);
            }
        }
    }
    set
}

/// 是否是「别的共享目录的地盘」。字面形式优先(与 Node 的 `resolvePath` 比较一致),
/// 字面不中再看 realpath —— 只可能多挡住一次删除,不会少挡。
fn is_nested(nested: &HashSet<PathBuf>, abs: &Path) -> bool {
    if nested.contains(abs) {
        return true;
    }
    match abs.canonicalize() {
        Ok(real) => nested.contains(&real),
        Err(_) => false,
    }
}

enum EmptyProbe {
    Empty,
    Missing,
    Blocked(String),
}

fn verify_empty(abs_dir: &Path, nested: &HashSet<PathBuf>) -> EmptyProbe {
    let entries = match std::fs::read_dir(abs_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return EmptyProbe::Missing,
        Err(_) => return EmptyProbe::Blocked("目录不可读,跳过".to_string()),
    };
    for entry in entries.flatten() {
        let child = abs_dir.join(entry.file_name());
        let Ok(file_type) = entry.file_type() else {
            return EmptyProbe::Blocked("目录不可读,跳过".to_string());
        };
        if !file_type.is_dir() {
            return EmptyProbe::Blocked("目录内现在有文件,跳过".to_string());
        }
        if is_nested(nested, &child) {
            return EmptyProbe::Blocked("目录内还有其它共享目录,跳过".to_string());
        }
        match verify_empty(&child, nested) {
            EmptyProbe::Empty => {}
            other => return other,
        }
    }
    EmptyProbe::Empty
}

/// 自底向上删除只含目录的树。任何非目录条目都会让该层失败 —— 只 rmdir、从不 unlink。
fn rmdir_bottom_up(abs_dir: &Path, nested: &HashSet<PathBuf>) -> Option<String> {
    let entries = match std::fs::read_dir(abs_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(_) => return Some("目录不可读,跳过".to_string()),
    };
    for entry in entries.flatten() {
        let child = abs_dir.join(entry.file_name());
        let Ok(file_type) = entry.file_type() else {
            return Some(RMDIR_CHANGED.to_string());
        };
        if !file_type.is_dir() {
            return Some(RMDIR_CHANGED.to_string());
        }
        if is_nested(nested, &child) {
            return Some("目录内出现其它共享目录,已中止".to_string());
        }
        if let Some(error) = rmdir_bottom_up(&child, nested) {
            return Some(error);
        }
    }
    match std::fs::remove_dir(abs_dir) {
        Ok(()) => None,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => Some(RMDIR_CHANGED.to_string()),
    }
}

/// 删除勾选的空目录,逐条独立给结果(一条被拒不连累其余)。
pub fn remove_empty_dirs(
    root: &Path,
    rel_paths: &[String],
    rules: &syncx_core::ignore::IgnoreRuleset,
    nested_roots: &[String],
) -> Value {
    let Ok(root_real) = std::fs::canonicalize(root) else {
        return json!({
            "results": rel_paths
                .iter()
                .map(|path| json!({ "path": path, "ok": false, "reason": "共享目录不存在或不可读" }))
                .collect::<Vec<_>>(),
        });
    };
    let nested = build_nested_set(&root_real, nested_roots);

    let mut sorted: Vec<&String> = rel_paths.iter().collect();
    sorted.sort_by(|a, b| {
        let da = a.split('/').count();
        let db = b.split('/').count();
        db.cmp(&da).then_with(|| a.cmp(b))
    });

    let mut results: Vec<Value> = Vec::new();
    for rel in sorted {
        // 与文件管理器同一道闸:归一 + 软链逃逸都要挡,而不只是词法消解 `..`
        let abs = match crate::filebrowser::resolve_folder_subpath(&root_real, rel) {
            Ok(abs) => abs,
            Err(error) => {
                let reason = error.to_string();
                // 目录已不存在(重复请求 / 外部已删)= 幂等成功
                let missing = reason == "路径不存在";
                results.push(json!({ "path": rel, "ok": missing, "reason": reason }));
                continue;
            }
        };
        if abs == root_real {
            results.push(json!({ "path": rel, "ok": false, "reason": "不能删除共享目录本身" }));
            continue;
        }
        if syncx_core::ignore::is_hard_ignored(rel) || rules.is_ignored(rel, true) {
            results.push(json!({
                "path": rel, "ok": false,
                "reason": "已不在同步范围内(被忽略规则命中),跳过",
            }));
            continue;
        }
        if is_nested(&nested, &abs) {
            results.push(json!({ "path": rel, "ok": false, "reason": "属于其它共享目录,跳过" }));
            continue;
        }
        match verify_empty(&abs, &nested) {
            EmptyProbe::Blocked(reason) => {
                results.push(json!({ "path": rel, "ok": false, "reason": reason }));
                continue;
            }
            EmptyProbe::Missing => {
                results.push(json!({ "path": rel, "ok": true }));
                continue;
            }
            EmptyProbe::Empty => {}
        }
        match rmdir_bottom_up(&abs, &nested) {
            None => results.push(json!({ "path": rel, "ok": true })),
            Some(reason) => results.push(json!({ "path": rel, "ok": false, "reason": reason })),
        }
    }
    json!({ "results": results })
}

/* ==================== 杂项 ==================== */

/// 与文件系统撞名时加 `.1`、`.2`… 直到空位。
pub fn unique_path(base: &Path) -> PathBuf {
    if !base.exists() {
        return base.to_path_buf();
    }
    for n in 1..10_000 {
        let candidate = PathBuf::from(format!("{}.{n}", base.display()));
        if !candidate.exists() {
            return candidate;
        }
    }
    base.to_path_buf()
}

/// 版本目录 / 回收站目录的绝对路径(按目录的 indexKey 哈希定位)。
pub fn versions_dir_for(config_dir: &Path, folder: &SharedFolder) -> PathBuf {
    config_dir.join("versions").join(config::short_hash(&folder.index_key()))
}

pub fn trash_dir_for(config_dir: &Path, folder: &SharedFolder) -> PathBuf {
    config_dir.join("trash").join(config::short_hash(&folder.index_key()))
}

/// 相对路径中是否有 `..` / 绝对路径段(供测试与路由快速判定)。
pub fn is_relative_safe(rel: &str) -> bool {
    let normalized = rel.replace('\\', "/");
    if normalized.contains('\0') || normalized.starts_with('/') || is_drive_absolute(&normalized) {
        return false;
    }
    let mut depth = 0i32;
    for segment in normalized.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                depth -= 1;
                if depth < 0 {
                    return false;
                }
            }
            _ => depth += 1,
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "syncx-api-fsops-{tag}-{}-{}",
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
    fn version_names_round_trip() {
        assert_eq!(
            parse_version_name("a/b.txt.syncx-v-1abc"),
            Some(("a/b.txt".to_string(), i64::from_str_radix("1abc", 36).unwrap()))
        );
        assert_eq!(
            parse_version_name("a/b.txt.syncx-v-1abc.2"),
            Some(("a/b.txt".to_string(), i64::from_str_radix("1abc", 36).unwrap()))
        );
        assert_eq!(version_original_path("a/b.txt.syncx-v-1abc.2"), "a/b.txt");
        assert!(parse_version_name("plain.txt").is_none());
    }

    #[test]
    fn trash_names_require_ms_timestamp() {
        let ts = 1_700_000_000_000i64;
        let name = format!("dir/f.txt.{}", stamp36(ts));
        assert_eq!(parse_trash_name(&name), Some(("dir/f.txt".to_string(), ts)));
        // 8 位数字段会被当 base36 解析:20240101 → 1.5e11,过了 <1e11 的下限,
        // Node 的 parseTrashName 同样认它(日期后缀的误判由下限兜底,不是绝对免疫)
        assert_eq!(
            parse_trash_name("report.20240101"),
            Some(("report".to_string(), i64::from_str_radix("20240101", 36).unwrap()))
        );
        // 版本文件不被误认
        assert!(parse_trash_name("a.txt.syncx-v-1abc").is_none());
    }

    #[test]
    fn safe_join_stops_escapes() {
        let root = Path::new("/tmp/root");
        assert!(safe_join(root, "../x").is_err());
        assert!(safe_join(root, "a/../../x").is_err());
        assert!(safe_join(root, "/etc/passwd").is_err());
        assert_eq!(safe_join(root, "a/b").unwrap(), root.join("a/b"));
    }

    #[test]
    fn rollback_plan_prefers_earliest_snapshot_after_target() {
        let versions = vec![
            VersionRef {
                file: "f.txt.syncx-v-1".into(),
                rel_path: "f.txt".into(),
                ts: 50,
            },
            VersionRef {
                file: "f.txt.syncx-v-2".into(),
                rel_path: "f.txt".into(),
                ts: 150,
            },
        ];
        let mut current = HashMap::new();
        current.insert("f.txt".to_string(), 200);
        let plan = plan_rollback(&versions, &[], &[], &current, 100);
        assert_eq!(plan.restores.len(), 1);
        assert_eq!(plan.restores[0].1, "f.txt.syncx-v-2");
    }

    #[test]
    fn empty_dir_scan_and_delete_are_consistent() {
        let dir = temp("empty");
        std::fs::create_dir_all(dir.join("a/b")).unwrap();
        std::fs::create_dir_all(dir.join("c")).unwrap();
        std::fs::write(dir.join("c/keep.txt"), b"x").unwrap();
        let rules = syncx_core::ignore::IgnoreRuleset::from_lines(&[]);
        let scan = scan_empty_dirs(&dir, &rules, &[], 2000);
        let dirs: Vec<String> = scan["dirs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        assert_eq!(dirs, vec!["a".to_string(), "a/b".to_string()]);

        let removed = remove_empty_dirs(&dir, &["a".to_string()], &rules, &[]);
        assert_eq!(removed["results"][0]["ok"], json!(true));
        assert!(!dir.join("a").exists());
        assert!(dir.join("c/keep.txt").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
