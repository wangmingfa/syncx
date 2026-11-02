//! HTTP 端点。按 `src/api.ts` 的分发顺序分模块,一个域一个文件。
//!
//! **分发顺序就是安全边界**,不是组织方式。与 Node 侧逐条对应:
//!
//!  1. 免认证探活/图标;
//!  2. 分享链接匿名下载(`/s/<token>`,自带 HMAC 限时令牌);
//!  3. 免认证登录与 UI 入口;
//!  4. 认证门(401);
//!  5. 提权 → 系统 → 指标 → 账号 → 目录 → 设备 → 邀请 → fleet → 分享管理 → 文件;
//!  6. 404。
//!
//! 顺序错了不会报错,只会「某个端点悄悄不需要登录」或「某个匿名链接被 401 拦下」,
//! 两种都是线上事故。新增域一律插在它该在的位置,不要图省事扔到末尾。

pub mod auth;
pub mod devices;
pub mod elevation;
pub mod files;
pub mod fleet;
pub mod folders;
pub mod metrics;
pub mod offers;
pub mod public;
pub mod share;
pub mod system;
pub mod util;

use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, StatusCode};
use axum::response::Response;

use crate::deps::AppState;
use util::{Ctx, MAX_BINARY_BODY, MAX_TEXT_BODY};

/// axum 处理入口。读体、建上下文、按顺序分发。
pub async fn dispatch(State(state): State<Arc<AppState>>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    let raw_path = parts.uri.path().to_string();
    // 体上限按端点区分:上传安装包要 64MB,其余 1MB(Node 同款)
    let limit = if raw_path.starts_with("/api/self-update/upload") {
        MAX_BINARY_BODY
    } else {
        MAX_TEXT_BODY
    };
    let body = match axum::body::to_bytes(body, limit).await {
        Ok(bytes) => bytes.to_vec(),
        Err(_) => {
            return util::error(StatusCode::PAYLOAD_TOO_LARGE, "request body too large");
        }
    };

    let ctx = Ctx {
        method: parts.method,
        path: decode_path(parts.uri.path()),
        query: parts.uri.query().unwrap_or("").to_string(),
        headers: parts.headers,
        body,
        remote: parts
            .extensions
            .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
            .map(|info| info.0.ip().to_string())
            .unwrap_or_else(|| "unknown".to_string()),
    };

    route(&state, ctx)
}

/// 与 Node `pathname()` 同口径:解百分号编码,畸形编码回退原文。
fn decode_path(raw: &str) -> String {
    percent_encoding::percent_decode_str(raw)
        .decode_utf8()
        .map(|decoded| decoded.to_string())
        .unwrap_or_else(|_| raw.to_string())
}

/// 纯分发。测试可以直接构造 [`Ctx`] 调用它,不必起 socket。
pub fn route(state: &AppState, ctx: Ctx) -> Response {
    // 1. 免认证探活与图标
    if let Some(response) = public::try_pre_auth(state, &ctx) {
        return response;
    }
    // 2. 分享链接匿名下载:必须排在认证门之前 —— 收到链接的人没有会话
    if let Some(response) = share::try_share_public(state, &ctx) {
        return response;
    }

    let authenticated = state.auth.credential_ok(ctx.token().as_deref());

    // 3. 免认证:登录相关 + UI 入口
    if let Some(response) = auth::try_public_auth(state, &ctx) {
        return response;
    }

    // 4. 认证门
    if !authenticated {
        return util::error(StatusCode::UNAUTHORIZED, "unauthorized");
    }

    // 5. 已认证业务域
    if let Some(response) = elevation::try_routes(state, &ctx) {
        return response;
    }
    if let Some(response) = system::try_routes(state, &ctx) {
        return response;
    }
    if let Some(response) = metrics::try_routes(state, &ctx) {
        return response;
    }
    if let Some(response) = auth::try_account_routes(state, &ctx) {
        return response;
    }
    if let Some(response) = folders::try_routes(state, &ctx) {
        return response;
    }
    if let Some(response) = devices::try_routes(state, &ctx) {
        return response;
    }
    if let Some(response) = offers::try_routes(state, &ctx) {
        return response;
    }
    if let Some(response) = fleet::try_routes(&ctx) {
        return response;
    }
    if let Some(response) = share::try_share_admin(state, &ctx) {
        return response;
    }
    if let Some(response) = files::try_routes(state, &ctx) {
        return response;
    }

    util::not_found()
}

/// 生成完整路由(含探活、静态资源、页面壳、HTTP 分发与两条 WS 通道)。
pub fn router(state: Arc<AppState>) -> axum::Router {
    use axum::routing::{any, get};

    axum::Router::new()
        // 状态推送:鉴权在 upgrade 之前完成,失败回 401 原始响应(客户端据此区分
        // 「没登录」与「网络不通」,而不是无休止重连)。
        .route("/api/events", get(crate::ws_routes::events))
        .route("/api/terminal", get(crate::ws_routes::terminal))
        .route("/", any(dispatch))
        .route("/*rest", any(dispatch))
        .with_state(state)
}

/// `/health` 的 uptime(秒)。node 的 `process.uptime()` 同口径。
pub fn uptime_seconds(started: std::time::Instant) -> u64 {
    started.elapsed().as_secs()
}

/// 统一的二进制下载响应:文件流 + `Content-Disposition`。
pub fn file_response(path: std::path::PathBuf) -> Response {
    match std::fs::read(&path) {
        Ok(bytes) => {
            let disposition = crate::share::content_disposition(&path.to_string_lossy());
            let mut builder = Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "application/octet-stream")
                .header(header::CONTENT_DISPOSITION, disposition)
                .header(header::CACHE_CONTROL, "no-store");
            if let Ok(meta) = std::fs::metadata(&path) {
                builder = builder.header(header::CONTENT_LENGTH, meta.len());
            }
            builder
                .body(Body::from(bytes))
                .unwrap_or_else(|_| util::error(StatusCode::INTERNAL_SERVER_ERROR, "internal error"))
        }
        Err(error) => util::error(StatusCode::BAD_REQUEST, &error.to_string()),
    }
}
