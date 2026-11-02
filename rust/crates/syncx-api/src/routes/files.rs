//! 文件管理器与回收站域。
//!
//! 鉴权分两档,与 Node 同一条骨架:
//!
//!  * **浏览 / 下载 / 回收站列举**是只读操作,登录门(401)之后即可放行;
//!  * **删除、还原、彻底清空**会真实改动盘面(并且本地删除会作为墓碑传播给对端),
//!    属敏感操作,要求额外的提权 cookie(10 分钟窗口,滑动续期)。
//!
//! 「移除共享目录只摘配置、不删文件」与这里的删除是两件事,前端文案也分开了。

use axum::http::{header, StatusCode};
use axum::response::Response;
use serde_json::{json, Value};

use crate::deps::AppState;
use crate::filebrowser::{self, DIR_LIST_LIMIT};
use crate::fsops;
use crate::routes::elevation;
use crate::routes::util::{self, Ctx};

/// JSON 体里区分「键不存在」与「值为 null」:Node 的 `undefined` 与 `null` 语义不同,
/// 清空回收站只认前者。
enum Opt {
    Missing,
    Value(Value),
}

fn field(body: &Value, key: &str) -> Opt {
    match body.get(key) {
        Some(value) => Opt::Value(value.clone()),
        None => Opt::Missing,
    }
}

/// `Number.parseInt(x, 10)` 的近似:前导空白可选、符号可选、遇到非数字即停。
fn js_parse_int(text: &str) -> Option<i64> {
    let trimmed = text.trim_start();
    if trimmed.is_empty() {
        return None;
    }
    let bytes = trimmed.as_bytes();
    let mut index = 0;
    let mut negative = false;
    if bytes[0] == b'+' || bytes[0] == b'-' {
        negative = bytes[0] == b'-';
        index = 1;
    }
    let start = index;
    while index < bytes.len() && bytes[index].is_ascii_digit() {
        index += 1;
    }
    if index == start {
        return None;
    }
    let value: i64 = trimmed[start..index].parse().ok()?;
    Some(if negative { -value } else { value })
}

fn query_limit(ctx: &Ctx) -> usize {
    ctx.param("limit")
        .as_deref()
        .and_then(js_parse_int)
        .filter(|limit| *limit > 0)
        .map(|limit| limit as usize)
        .unwrap_or(DIR_LIST_LIMIT)
}

/// 目录不存在一律 400「共享目录不存在(可能刚被移除)」,与 Node 的 catch 一致。
// Response 本就很大; Err 直接回给调用方省一次装箱,不必为了体积改写全部调用点。
#[allow(clippy::result_large_err)]
fn folder_of(state: &AppState, folder_id: &str) -> Result<crate::config::SharedFolder, Response> {
    state
        .config
        .load()
        .folder(folder_id)
        .cloned()
        .ok_or_else(|| util::error(StatusCode::BAD_REQUEST, "共享目录不存在(可能刚被移除)"))
}

fn elevated(state: &AppState, ctx: &Ctx) -> bool {
    state.auth.elevate_ok(ctx.cookie("syncx_su").as_deref())
}

fn forbidden() -> Response {
    util::error(
        StatusCode::FORBIDDEN,
        "敏感操作需要验证:请先用控制令牌或密码完成验证",
    )
}

pub fn try_routes(state: &AppState, ctx: &Ctx) -> Option<Response> {
    match ctx.path.as_str() {
        "/api/trash" | "/api/trash/restore" | "/api/trash/purge" => Some(trash(state, ctx)),
        "/api/folder-files" | "/api/folder-files/download" => Some(files(state, ctx)),
        _ => None,
    }
}

fn files(state: &AppState, ctx: &Ctx) -> Response {
    // 删除是变更操作:先于任何列举逻辑判定,免得「先查目录存在与否」泄漏信息
    let is_delete = ctx.method_is("DELETE");
    let elevated_now = elevated(state, ctx);
    if is_delete && !elevated_now {
        return forbidden();
    }

    let response = match (ctx.method.as_str(), ctx.path.as_str()) {
        ("GET", "/api/folder-files") => list(state, ctx),
        ("GET", "/api/folder-files/download") => download(state, ctx),
        ("DELETE", "/api/folder-files") => delete(state, ctx),
        _ => util::error(StatusCode::METHOD_NOT_ALLOWED, "method not allowed"),
    };

    // 放行即滑动续期:下载分支也走这里,续期头不会丢
    if elevated_now {
        return elevation::reissue(state, ctx, response);
    }
    response
}

fn list(state: &AppState, ctx: &Ctx) -> Response {
    let folder_id = ctx.param_or_empty("folderId");
    if folder_id.is_empty() {
        return util::error(StatusCode::BAD_REQUEST, "folderId is required");
    }
    let folder = match folder_of(state, &folder_id) {
        Ok(folder) => folder,
        Err(response) => return response,
    };
    let rel = ctx.param_or_empty("path");
    let mut listing = match filebrowser::list_directory(
        std::path::Path::new(&folder.path),
        &rel,
        query_limit(ctx),
    ) {
        Ok(listing) => listing,
        Err(error) => return util::error(StatusCode::BAD_REQUEST, &error.to_string()),
    };

    // 单文件暂停:命中的文件行打标,前端据此显示「已暂停」
    if let Some(paused) = &folder.paused_files {
        let paused: std::collections::HashSet<&str> =
            paused.iter().map(|path| path.as_str()).collect();
        for entry in &mut listing.entries {
            if !entry.is_dir && paused.contains(entry.path.as_str()) {
                entry.paused = Some(true);
            }
        }
    }
    // 选择性同步:命中按需前缀的目录行打标,前端据此把按钮换成「恢复同步此目录」
    if let Some(dirs) = &folder.on_demand_dirs {
        let dirs: std::collections::HashSet<&str> =
            dirs.iter().map(|path| path.as_str()).collect();
        for entry in &mut listing.entries {
            if entry.is_dir && dirs.contains(entry.path.as_str()) {
                entry.on_demand_dir = Some(true);
            }
        }
    }
    // 按需同步的占位文件盘上不存在,列举天然看不到 —— 由装配层补进当前层的
    // 「未下载」行。拉取中途盘上已有实体时跳过,不重复出行。
    let dir_prefix = if rel.is_empty() {
        String::new()
    } else {
        format!("{}/", rel.replace('\\', "/").trim_end_matches('/'))
    };
    if let Some(ops) = state.deps.ops() {
        let on_disk: std::collections::HashSet<String> = listing
            .entries
            .iter()
            .map(|entry| entry.path.clone())
            .collect();
        for (path, size) in ops.list_placeholders(&folder_id) {
            if !path.starts_with(&dir_prefix) || on_disk.contains(&path) {
                continue;
            }
            let rest = path[dir_prefix.len()..].to_string();
            if rest.is_empty() || rest.contains('/') {
                continue;
            }
            listing.entries.push(filebrowser::DirEntry {
                path,
                name: rest,
                is_dir: false,
                size,
                mtime: 0,
                placeholder: Some(true),
                paused: None,
                on_demand_dir: None,
            });
        }
    }

    util::json_value(StatusCode::OK, &listing_value(&listing))
}

fn listing_value(listing: &filebrowser::DirListing) -> Value {
    json!({
        "entries": listing.entries,
        "truncated": listing.truncated,
    })
}

fn download(state: &AppState, ctx: &Ctx) -> Response {
    let folder_id = ctx.param_or_empty("folderId");
    if folder_id.is_empty() {
        return util::error(StatusCode::BAD_REQUEST, "folderId is required");
    }
    let folder = match folder_of(state, &folder_id) {
        Ok(folder) => folder,
        Err(response) => return response,
    };
    let rel = ctx.param_or_empty("path");
    let absolute = match filebrowser::resolve_folder_subpath(std::path::Path::new(&folder.path), &rel)
    {
        Ok(path) => path,
        Err(error) => return util::error(StatusCode::BAD_REQUEST, &error.to_string()),
    };
    let Ok(meta) = std::fs::metadata(&absolute) else {
        return util::error(StatusCode::BAD_REQUEST, "只能下载文件");
    };
    if !meta.is_file() {
        return util::error(StatusCode::BAD_REQUEST, "只能下载文件");
    }
    let bytes = match std::fs::read(&absolute) {
        Ok(bytes) => bytes,
        Err(error) => return util::error(StatusCode::BAD_REQUEST, &error.to_string()),
    };
    axum::response::Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::CONTENT_LENGTH, meta.len())
        .header(
            header::CONTENT_DISPOSITION,
            crate::share::content_disposition(&absolute.to_string_lossy()),
        )
        .header(header::CACHE_CONTROL, "no-store")
        .body(axum::body::Body::from(bytes))
        .unwrap_or_else(|_| util::error(StatusCode::INTERNAL_SERVER_ERROR, "internal error"))
}

fn delete(state: &AppState, ctx: &Ctx) -> Response {
    let folder_id = ctx.param_or_empty("folderId");
    if folder_id.is_empty() {
        return util::error(StatusCode::BAD_REQUEST, "folderId is required");
    }
    let folder = match folder_of(state, &folder_id) {
        Ok(folder) => folder,
        Err(response) => return response,
    };
    let rel = ctx.param_or_empty("path");
    if rel.is_empty() {
        return util::error(StatusCode::BAD_REQUEST, "不能删除共享目录本身");
    }
    match filebrowser::delete_folder_entry(std::path::Path::new(&folder.path), &rel) {
        Ok(()) => {
            // 删除已改变盘面:让装配层立刻扫描,把删除尽快作为墓碑广播给对端
            if let Some(ops) = state.deps.ops() {
                let _ = ops.rescan();
            }
            util::ok_true()
        }
        Err(error) => util::error(StatusCode::BAD_REQUEST, &error.to_string()),
    }
}

fn trash(state: &AppState, ctx: &Ctx) -> Response {
    let is_mutate =
        ctx.method_is("POST") && (ctx.path == "/api/trash/restore" || ctx.path == "/api/trash/purge");
    let elevated_now = elevated(state, ctx);
    if is_mutate && !elevated_now {
        return forbidden();
    }

    let response = match (ctx.method.as_str(), ctx.path.as_str()) {
        ("GET", "/api/trash") => trash_list(state, ctx),
        ("POST", "/api/trash/restore") => trash_restore(state, ctx),
        ("POST", "/api/trash/purge") => trash_purge(state, ctx),
        _ => util::error(StatusCode::METHOD_NOT_ALLOWED, "method not allowed"),
    };

    if elevated_now {
        return elevation::reissue(state, ctx, response);
    }
    response
}

fn trash_list(state: &AppState, ctx: &Ctx) -> Response {
    let folder_id = ctx.param_or_empty("folderId");
    if folder_id.is_empty() {
        return util::error(StatusCode::BAD_REQUEST, "folderId is required");
    }
    let folder = match folder_of(state, &folder_id) {
        Ok(folder) => folder,
        Err(response) => return response,
    };
    let trash_dir = fsops::trash_dir_for(&state.config.config_dir(), &folder);
    util::json_value(StatusCode::OK, &fsops::list_trash(&trash_dir))
}

fn trash_restore(state: &AppState, ctx: &Ctx) -> Response {
    let Ok(body) = ctx.json() else {
        return util::json_invalid();
    };
    let Some(folder_id) = body.get("folderId").and_then(Value::as_str) else {
        return util::error(StatusCode::BAD_REQUEST, "folderId is required");
    };
    if folder_id.is_empty() {
        return util::error(StatusCode::BAD_REQUEST, "folderId is required");
    }
    let Some(file) = body.get("file").and_then(Value::as_str) else {
        return util::error(StatusCode::BAD_REQUEST, "file is required");
    };
    if file.is_empty() {
        return util::error(StatusCode::BAD_REQUEST, "file is required");
    }
    let folder = match folder_of(state, folder_id) {
        Ok(folder) => folder,
        Err(response) => return response,
    };
    let trash_dir = fsops::trash_dir_for(&state.config.config_dir(), &folder);
    match fsops::restore_trash(&folder, &trash_dir, file, crate::auth::now_ms()) {
        Ok(()) => {
            // 还原同样改变了盘面:经扫描广播,对端才知道文件回来了
            if let Some(ops) = state.deps.ops() {
                let _ = ops.rescan();
            }
            util::ok_true()
        }
        Err(message) => util::error(StatusCode::BAD_REQUEST, &message),
    }
}

fn trash_purge(state: &AppState, ctx: &Ctx) -> Response {
    let Ok(body) = ctx.json() else {
        return util::json_invalid();
    };
    let Some(folder_id) = body.get("folderId").and_then(Value::as_str) else {
        return util::error(StatusCode::BAD_REQUEST, "folderId is required");
    };
    if folder_id.is_empty() {
        return util::error(StatusCode::BAD_REQUEST, "folderId is required");
    }
    let file = match field(&body, "file") {
        Opt::Missing => None,
        // JSON null 不是「缺省」:Node 只认 undefined,这里如实拒绝
        Opt::Value(Value::String(text)) => Some(text),
        Opt::Value(_) => {
            return util::error(StatusCode::BAD_REQUEST, "file must be a string");
        }
    };
    let folder = match folder_of(state, folder_id) {
        Ok(folder) => folder,
        Err(response) => return response,
    };
    let trash_dir = fsops::trash_dir_for(&state.config.config_dir(), &folder);
    match fsops::purge_trash(&trash_dir, file.as_deref()) {
        Ok(()) => util::ok_true(),
        Err(message) => util::error(StatusCode::BAD_REQUEST, &message),
    }
}

