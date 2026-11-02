//! 分享链接域(默认关闭,见 [`crate::share`])。
//!
//! * **匿名下载** `GET /s/<token>`:免登录、限时、单文件只读。排在认证门之前 ——
//!   链接就是给没有会话的人用的。关着 / 令牌无效 / 文件已不在,一律 404:不给探测者
//!   区分「不存在 / 过期 / 撤销」的信息。
//! * **管理面**(登录门内):列表只读;创建是「对外开放匿名读」,与删文件同一条提权门;
//!   撤销是收紧权限,登录即可。

use axum::http::{header, StatusCode};
use axum::response::Response;

use crate::deps::AppState;
use crate::filebrowser;
use crate::routes::util::{self, Ctx};
use crate::share::{ShareCheck, TTL_HOURS_WHITELIST};

/// 令牌长度上限:超长串连解析都不做,直接当无效。
const MAX_TOKEN_CHARS: usize = 200;
const ERR_NOT_FOUND: &str = "not found";

pub fn try_share_public(state: &AppState, ctx: &Ctx) -> Option<Response> {
    let token = ctx.path.strip_prefix("/s/")?;
    if !ctx.method_is("GET") && !ctx.method_is("HEAD") {
        return Some(util::error(StatusCode::METHOD_NOT_ALLOWED, "method not allowed"));
    }

    let now = crate::auth::now_ms();
    // 限流先于一切:锁定后连「开关是否开着」都不透露
    if state.share_limit.limited(&ctx.remote, now) {
        return Some(util::error(
            StatusCode::TOO_MANY_REQUESTS,
            "too many failed attempts",
        ));
    }

    if !state.shares.enabled()
        || token.is_empty()
        || token.chars().count() > MAX_TOKEN_CHARS
    {
        return Some(util::error(StatusCode::NOT_FOUND, ERR_NOT_FOUND));
    }

    let record = match state.shares.verify(token, now) {
        ShareCheck::Ok(record) => record,
        ShareCheck::Rejected(_) => {
            let limited = state.share_limit.note_failure(&ctx.remote, now);
            return Some(if limited {
                util::error(StatusCode::TOO_MANY_REQUESTS, "too many failed attempts")
            } else {
                util::error(StatusCode::NOT_FOUND, ERR_NOT_FOUND)
            });
        }
    };

    // 目录被移除 / 文件已删除 / 记录指向占位:记录还在,内容已不可得
    let Some(root) = state.folder_root(&record.folder_id) else {
        return Some(util::error(StatusCode::NOT_FOUND, ERR_NOT_FOUND));
    };
    let Ok(absolute) = filebrowser::resolve_folder_subpath(&root, &record.path) else {
        return Some(util::error(StatusCode::NOT_FOUND, ERR_NOT_FOUND));
    };
    let Ok(meta) = std::fs::metadata(&absolute) else {
        return Some(util::error(StatusCode::NOT_FOUND, ERR_NOT_FOUND));
    };
    if !meta.is_file() {
        return Some(util::error(StatusCode::NOT_FOUND, ERR_NOT_FOUND));
    }

    state.shares.note_download(&record.id, now);

    let body = if ctx.method_is("HEAD") {
        axum::body::Body::empty()
    } else {
        // 读盘中途没了:头已经定了 Content-Length,只能回空体 —— 与 Node 的
        // `res.destroy()` 同效(客户端看到的是截断的下载,而不是一条错误的成功)
        std::fs::read(&absolute)
            .map(axum::body::Body::from)
            .unwrap_or_else(|_| axum::body::Body::empty())
    };
    Some(
        Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, SHARE_CONTENT_TYPE)
            .header(header::CONTENT_LENGTH, meta.len())
            .header(
                header::CONTENT_DISPOSITION,
                crate::share::content_disposition(&record.path),
            )
            .header(header::CACHE_CONTROL, "no-store")
            .body(body)
            .unwrap_or_else(|_| util::error(StatusCode::INTERNAL_SERVER_ERROR, "internal error")),
    )
}

pub fn try_share_admin(state: &AppState, ctx: &Ctx) -> Option<Response> {
    let path = ctx.path.as_str();
    if path != "/api/shares" && path != "/api/shares/create" && path != "/api/shares/revoke" {
        return None;
    }

    // GET /api/shares : 在册分享 + 开关状态
    if ctx.method_is("GET") && path == "/api/shares" {
        let now = crate::auth::now_ms();
        return Some(util::ok(serde_json::json!({
            "enabled": state.shares.enabled(),
            "shares": state.shares.list(now),
        })));
    }

    if ctx.method_is("POST") && path == "/api/shares/create" {
        // 创建 = 对外开放匿名读一道门:与删除文件同一条提权门
        let elevated = state.auth.elevate_ok(ctx.cookie("syncx_su").as_deref());
        if !elevated {
            return Some(util::error(
                StatusCode::FORBIDDEN,
                "敏感操作需要验证:请先用控制令牌或密码完成验证",
            ));
        }
        let Ok(body) = ctx.json() else {
            return Some(util::json_invalid());
        };
        if !state.shares.enabled() {
            return Some(util::error(
                StatusCode::BAD_REQUEST,
                "分享链接未启用:请先在全局设置中打开开关",
            ));
        }
        let Some(folder_id) = body.get("folderId").and_then(|value| value.as_str()) else {
            return Some(util::error(StatusCode::BAD_REQUEST, "folderId is required"));
        };
        if folder_id.is_empty() {
            return Some(util::error(StatusCode::BAD_REQUEST, "folderId is required"));
        }
        let rel_path = body.get("path").and_then(|value| value.as_str());
        if rel_path.is_none_or(str::is_empty) {
            return Some(util::error(
                StatusCode::BAD_REQUEST,
                "不能分享目录本身,请选择文件",
            ));
        }
        let rel_path = rel_path.unwrap_or_default();
        // 白名单而非区间:杜绝「分享一百年」的手滑
        let Some(ttl_hours) = body.get("ttlHours").and_then(|value| value.as_i64()) else {
            return Some(util::error(
                StatusCode::BAD_REQUEST,
                &format!(
                    "有效期只能是 {} 小时",
                    TTL_HOURS_WHITELIST
                        .iter()
                        .map(|h| h.to_string())
                        .collect::<Vec<_>>()
                        .join("/")
                ),
            ));
        };
        if !TTL_HOURS_WHITELIST.contains(&ttl_hours) {
            return Some(util::error(
                StatusCode::BAD_REQUEST,
                &format!(
                    "有效期只能是 {} 小时",
                    TTL_HOURS_WHITELIST
                        .iter()
                        .map(|h| h.to_string())
                        .collect::<Vec<_>>()
                        .join("/")
                ),
            ));
        }

        let now = crate::auth::now_ms();
        return Some(
            match state
                .shares
                .create(folder_id, rel_path, ttl_hours * 3_600_000, now)
            {
                Ok(issued) => {
                    let response = util::ok(serde_json::json!({
                        "ok": true,
                        "urlToken": issued.url_token,
                        "expiresAt": issued.record.expires_at,
                    }));
                    crate::routes::elevation::reissue(state, ctx, response)
                }
                Err(error) => util::error(StatusCode::BAD_REQUEST, &error.to_string()),
            },
        );
    }

    if ctx.method_is("POST") && path == "/api/shares/revoke" {
        let Ok(body) = ctx.json() else {
            return Some(util::json_invalid());
        };
        let Some(id) = body.get("id").and_then(|value| value.as_str()) else {
            return Some(util::error(StatusCode::BAD_REQUEST, "id is required"));
        };
        if id.is_empty() {
            return Some(util::error(StatusCode::BAD_REQUEST, "id is required"));
        }
        return Some(match state.shares.revoke(id) {
            Ok(_) => util::ok_true(),
            Err(error) => util::error(StatusCode::BAD_REQUEST, &error.to_string()),
        });
    }

    Some(util::error(StatusCode::METHOD_NOT_ALLOWED, "method not allowed"))
}

/// 匿名下载的 `Content-Type` 在 Node 里是硬编码的二进制流;这里导出一份,
/// 便于路由层与测试引用同一常量。
pub const SHARE_CONTENT_TYPE: &str = "application/octet-stream";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ttl_whitelist_message_matches_node() {
        let text = TTL_HOURS_WHITELIST
            .iter()
            .map(|h| h.to_string())
            .collect::<Vec<_>>()
            .join("/");
        assert_eq!(format!("有效期只能是 {text} 小时"), "有效期只能是 1/24/168/720 小时");
    }

    #[test]
    fn content_type_is_binary() {
        assert_eq!(SHARE_CONTENT_TYPE, "application/octet-stream");
    }
}
