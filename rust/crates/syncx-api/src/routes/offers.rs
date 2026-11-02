//! 待确认项域:配对请求 / 目录共享邀请的查看、确认、忽略与恢复。
//!
//! 列表是纯配置读取;三个动作都要向对端回控制消息(`pairing-ack` /
//! `folder-invitation-ack`)、反推目录清单、拉起会话 —— 全部依赖活会话,所以整段
//! 动作经 [`crate::deps::ControlOps`] 注入,未注入时**不认这条路由**(404)。
//!
//! 后缀判定顺序是安全项:必须先认 `/accept` 再认 `/decline`,否则 `.../decline`
//! 会被前缀相同的分支吞掉,拿一个带 `/decline` 尾巴的错误 id 去查 → 报 offer not found。

use axum::http::StatusCode;
use axum::response::Response;
use serde_json::Value;

use crate::deps::AppState;
use crate::routes::util::{self, Ctx};

const PREFIX: &str = "/api/offers/";

/// 仍可展示的待确认项:已接受的不再出现,已忽略的保留供 UI 灰显 + 「恢复」。
fn open_offers(state: &AppState) -> Value {
    let offers: Vec<Value> = state
        .config
        .load()
        .pending_offers
        .iter()
        .filter(|offer| offer.status != "accepted")
        .map(|offer| serde_json::to_value(offer).unwrap_or(Value::Null))
        .collect();
    Value::Array(offers)
}

/// 截出 `/api/offers/<id>/<suffix>` 里的 id。
fn offer_id(path: &str, suffix: &str) -> Option<String> {
    let rest = path.strip_prefix(PREFIX)?;
    let id = rest.strip_suffix(suffix)?;
    if id.is_empty() {
        return None;
    }
    Some(id.to_string())
}

pub fn try_routes(state: &AppState, ctx: &Ctx) -> Option<Response> {
    let path = ctx.path.as_str();

    // GET /api/offers : 待确认 + 已忽略
    if ctx.method_is("GET") && path == "/api/offers" {
        return Some(util::ok(open_offers(state)));
    }

    if !ctx.method_is("POST") || !path.starts_with(PREFIX) {
        return None;
    }

    // 顺序不可换:accept 必须先于 decline 判定
    if path.ends_with("/accept") {
        let ops = state.deps.ops()?;
        let Some(id) = offer_id(path, "/accept") else {
            return Some(util::error(StatusCode::BAD_REQUEST, "offer id is required"));
        };
        let Ok(body) = ctx.json() else {
            return Some(util::json_invalid());
        };
        let local_path = body
            .get("localPath")
            .and_then(|value| value.as_str())
            .map(|value| value.to_string());
        let receive_only = body.get("receiveOnly") == Some(&Value::Bool(true));
        return Some(match ops.accept_offer(&id, local_path.as_deref(), receive_only) {
            Ok(()) => util::ok_true(),
            Err(error) => util::error(StatusCode::BAD_REQUEST, &error.message()),
        });
    }

    if path.ends_with("/decline") {
        let ops = state.deps.ops()?;
        let Some(id) = offer_id(path, "/decline") else {
            return Some(util::error(StatusCode::BAD_REQUEST, "offer id is required"));
        };
        return Some(match ops.decline_offer(&id) {
            Ok(()) => util::ok_true(),
            Err(error) => util::error(StatusCode::BAD_REQUEST, &error.message()),
        });
    }

    if path.ends_with("/restore") {
        let ops = state.deps.ops()?;
        let Some(id) = offer_id(path, "/restore") else {
            return Some(util::error(StatusCode::BAD_REQUEST, "offer id is required"));
        };
        return Some(match ops.restore_offer(&id) {
            Ok(()) => util::ok_true(),
            Err(error) => util::error(StatusCode::BAD_REQUEST, &error.message()),
        });
    }

    None
}
