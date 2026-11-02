//! 敏感操作提权(终端 / 文件管理器 / 分享创建)。
//!
//! 登录会话「能看状态」不等于「能开 shell、删文件、对外放匿名链接」。提权必须来自
//! 一次**新鲜的**凭据校验,且用**独立签名密钥**签发:登录 cookie 冒充不了提权 cookie,
//! 反之亦然。10 分钟有效期 + 仅敏感请求滑动续期 —— 离开键盘十分钟回来要重新验一次。
//!
//! 失败计入与登录同一套锁定,否则拿提权接口当爆破入口就能绕开登录限速。

use axum::http::StatusCode;
use axum::response::Response;
use serde_json::json;

use crate::auth::{self, ELEVATE_TTL_MS};
use crate::deps::AppState;
use crate::routes::util::{self, lock_seconds, Ctx};

pub fn try_routes(state: &AppState, ctx: &Ctx) -> Option<Response> {
    if ctx.path != "/api/elevate" {
        return None;
    }

    if ctx.method_is("GET") {
        let elevated = state.auth.elevate_ok(ctx.cookie("syncx_su").as_deref());
        return Some(util::ok(json!({ "ok": elevated })));
    }

    if !ctx.method_is("POST") {
        return None;
    }

    let locked = state.login.remaining(&ctx.remote);
    if locked > 0 {
        return Some(util::error(
            StatusCode::TOO_MANY_REQUESTS,
            &format!("尝试过于频繁,请 {}s 后重试", lock_seconds(locked)),
        ));
    }

    let Ok(body) = ctx.json() else {
        return Some(util::json_invalid());
    };
    let token = body["token"].as_str().unwrap_or("").trim().to_string();
    let username = body["username"].as_str().unwrap_or("").trim().to_string();
    let password = body["password"].as_str().unwrap_or("").to_string();

    // 控制令牌通道(也是忘记密码时的恢复通道)
    if !token.is_empty() {
        if state.auth.token_accepted(Some(&token)) {
            state.login.note_success(&ctx.remote);
            return Some(issue(state));
        }
        state.login.note_failure(&ctx.remote);
        return Some(util::error(StatusCode::UNAUTHORIZED, "控制令牌无效"));
    }

    if username.is_empty() || password.is_empty() {
        return Some(util::error(
            StatusCode::BAD_REQUEST,
            "请提供账号密码或控制令牌",
        ));
    }
    let Some(auth_file) = state.deps.auth_file.as_deref() else {
        return Some(util::error(StatusCode::NOT_FOUND, "未启用账号密码验证"));
    };
    if auth::load_account(auth_file).is_none() {
        return Some(util::error(
            StatusCode::NOT_FOUND,
            "未设置登录账号,请使用控制令牌验证",
        ));
    }
    if auth::verify_password(auth_file, &username, &password) {
        state.login.note_success(&ctx.remote);
        Some(issue(state))
    } else {
        state.login.note_failure(&ctx.remote);
        Some(util::error(StatusCode::UNAUTHORIZED, "用户名或密码错误"))
    }
}

fn issue(state: &AppState) -> Response {
    let cookie = state.auth.elevation_cookie();
    util::set_cookie(util::ok_true(), &cookie)
}

/// 敏感路由拿到提权状态后,若本次确实带了有效提权 cookie,必须顺手滑动续期。
pub fn reissue(state: &AppState, ctx: &Ctx, response: Response) -> Response {
    if state.auth.elevate_ok(ctx.cookie("syncx_su").as_deref()) {
        let cookie = state.auth.elevation_cookie();
        return util::with_cookie(response, &cookie);
    }
    response
}

/// 提权 cookie 的 Max-Age 口径,导出给测试断言用。
pub const ELEVATE_MAX_AGE_SECS: i64 = ELEVATE_TTL_MS / 1000;
