//! 免认证的探活与静态资源:favicon、`/health`、`/healthz`、`/favicon.ico`。
//!
//! 必须排在认证门与 dev 重定向之前 —— 否则监控探活会在服务还没起来时就返回 401,
//! 而浏览器自动请求的 `.ico` 会让控制台里多一条误导性的未授权。

use axum::http::{header, StatusCode};
use axum::response::Response;
use serde_json::json;

use crate::deps::AppState;
use crate::routes::util::{self, Ctx};
use crate::FAVICON_SVG;

pub fn try_pre_auth(state: &AppState, ctx: &Ctx) -> Option<Response> {
    // 站点图标:公开资源,打包形态下也要可用
    if ctx.method_is("GET") && ctx.path == "/favicon.svg" {
        return Some(
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "image/svg+xml")
                .header(header::CACHE_CONTROL, "public, max-age=86400")
                .body(axum::body::Body::from(FAVICON_SVG))
                .expect("响应构造不应失败"),
        );
    }

    // 探活:只报存活与运行时长,不暴露版本/设备 ID —— 这个端点谁都能访问
    if ctx.method_is("GET") && (ctx.path == "/health" || ctx.path == "/healthz") {
        return Some(util::ok(json!({
            "ok": true,
            "msg": "syncx is ok",
            "uptime": state.deps.started_at.elapsed().as_secs(),
        })));
    }

    // 浏览器会自己请求 .ico:显式 204,避免落到 401 分支误导排查
    if ctx.method_is("GET") && ctx.path == "/favicon.ico" {
        return Some(
            Response::builder()
                .status(StatusCode::NO_CONTENT)
                .body(axum::body::Body::empty())
                .expect("响应构造不应失败"),
        );
    }

    None
}
