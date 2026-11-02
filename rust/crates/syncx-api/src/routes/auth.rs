//! 登录与 UI 入口(免认证)+ 账号密码管理(已认证)。
//!
//! 免认证的四件事:告诉登录页该渲染哪种表单、账号登录、登出、回页面壳。
//! 页面壳必须对 `/`、`/login`、`/compare*`、`/terminal*`、`/files*`、`/fleet*`、
//! `/trash*` 都回同一份 —— 前端用路径路由(链接可分享、可刷新),少放行一棵子树
//! 就是那条链接一刷新就 404。刻意不放行未知路径:否则拼错的 API 路径会被掩盖成
//! 一张空页面。

use axum::http::{header, StatusCode};
use axum::response::Response;
use serde_json::json;

use crate::auth::{self, SessionPayload, SESSION_TTL_MS};
use crate::deps::AppState;
use crate::routes::util::{self, lock_seconds, Ctx};
use crate::UI_SHELL;

pub fn try_public_auth(state: &AppState, ctx: &Ctx) -> Option<Response> {
    // GET /api/auth:公开。登录页据此决定渲染账号密码还是令牌表单,并带上数据目录 ——
    // 令牌输入框的路径提示要跟着真实目录走,数据目录隔离时才不会指错地方。
    if ctx.method_is("GET") && ctx.path == "/api/auth" {
        let mut body = json!({ "mode": if state.auth.has_account() { "password" } else { "token" } });
        if let Some(username) = state.auth.username() {
            body["username"] = json!(username);
        }
        if state.deps.auth_file.is_none() {
            body["passwordLogin"] = json!(false);
        }
        if !state.config_dir_display().is_empty() {
            body["configDir"] = json!(state.config_dir_display());
        }
        return Some(util::ok(body));
    }

    // POST /api/login:账号密码登录
    if ctx.method_is("POST") && ctx.path == "/api/login" {
        let locked = state.login.remaining(&ctx.remote);
        if locked > 0 {
            return Some(util::error(
                StatusCode::TOO_MANY_REQUESTS,
                &format!("尝试过于频繁,请 {}s 后重试", lock_seconds(locked)),
            ));
        }
        let Some(auth_file) = state.deps.auth_file.as_deref() else {
            return Some(util::error(
                StatusCode::NOT_FOUND,
                "未启用账号密码登录",
            ));
        };
        let Ok(body) = ctx.json() else {
            return Some(util::json_invalid());
        };
        let username = body["username"].as_str().unwrap_or("").to_string();
        let password = body["password"].as_str().unwrap_or("").to_string();
        if username.is_empty() || password.is_empty() {
            return Some(util::error(
                StatusCode::BAD_REQUEST,
                "用户名和密码不能为空",
            ));
        }
        if auth::verify_password(auth_file, &username, &password) {
            state.login.note_success(&ctx.remote);
            let session = state.auth.session_cookie(&SessionPayload {
                via: "password".to_string(),
                sub: username,
                exp: auth::now_ms() + SESSION_TTL_MS,
            });
            let cookie = auth::cookie_header("syncx_session", &session, SESSION_TTL_MS / 1000);
            return Some(util::set_cookie(util::ok_true(), &cookie));
        }
        state.login.note_failure(&ctx.remote);
        return Some(util::error(StatusCode::UNAUTHORIZED, "用户名或密码错误"));
    }

    // POST /api/logout:清 cookie(会话本身无状态,服务端不用记)
    if ctx.method_is("POST") && ctx.path == "/api/logout" {
        let cookie = auth::clear_cookie_header("syncx_session");
        return Some(util::set_cookie(util::ok_true(), &cookie));
    }

    // 页面壳。路径路由意味着服务端必须对这些路径回壳,否则刷新直接 404。
    if ctx.method_is("GET") && is_shell_path(&ctx.path) {
        return Some(util::html(UI_SHELL));
    }

    // POST /login:令牌登录(恢复通道)。同样下发签名会话,不把 token 原文写进 cookie。
    if ctx.method_is("POST") && ctx.path == "/login" {
        let locked = state.login.remaining(&ctx.remote);
        if locked > 0 {
            return Some(util::text_response(
                StatusCode::TOO_MANY_REQUESTS,
                "text/plain; charset=utf-8",
                format!("尝试过于频繁,请 {}s 后重试", lock_seconds(locked)),
            ));
        }
        let submitted = form_field(&ctx.text(), "token");
        if state.auth.token_accepted(submitted.as_deref()) {
            state.login.note_success(&ctx.remote);
            let session = state.auth.session_cookie(&SessionPayload {
                via: "token".to_string(),
                sub: "token".to_string(),
                exp: auth::now_ms() + SESSION_TTL_MS,
            });
            let cookie = auth::cookie_header("syncx_session", &session, SESSION_TTL_MS / 1000);
            return Some(util::set_cookie(util::redirect("/"), &cookie));
        }
        state.login.note_failure(&ctx.remote);
        return Some(util::html(UI_SHELL));
    }

    // GET /client.js:前端 bundle 由页面壳在**未登录**时就加载,故保持公开
    if ctx.method_is("GET") && ctx.path == "/client.js" {
        return Some(match crate::WebAssets::get("client.js") {
            Some(file) => Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "application/javascript; charset=utf-8")
                .body(axum::body::Body::from(file.data.into_owned()))
                .expect("响应构造失败"),
            None => util::text_response(StatusCode::OK, "text/plain", String::new()),
        });
    }

    None
}

/// 回页面壳的全部路径。刻意逐条列出而不是 `starts_with('/')`:
/// 后者会把拼错的 API 路径也变成一张 200 的空页面。
fn is_shell_path(path: &str) -> bool {
    let exact = ["/", "/login", "/compare", "/terminal", "/files", "/fleet", "/trash"];
    const TREES: [&str; 5] = ["/compare/", "/terminal/", "/files/", "/fleet/", "/trash/"];
    exact.contains(&path) || TREES.iter().any(|prefix| path.starts_with(prefix))
}

fn form_field(body: &str, name: &str) -> Option<String> {
    form_urlencoded::parse(body.as_bytes())
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.to_string())
}

/// 已认证后的账号管理:设置 / 清除登录密码。
///
/// 两条都必须**额外提交 control.token 原文**:会话 cookie 会在浏览器里长期驻留,
/// 只凭会话就能改密的话,「已登录的机器被别人顺手操作」就等于交出了账号 ——
/// 而 control.token 只存在于本机磁盘与启动日志里,能挡住这种顺手操作。
pub fn try_account_routes(state: &AppState, ctx: &Ctx) -> Option<Response> {
    if ctx.path != "/api/auth/password" {
        return None;
    }
    let Some(auth_file) = state.deps.auth_file.as_deref() else {
        return Some(util::error(StatusCode::NOT_FOUND, "未启用账号密码登录"));
    };

    if ctx.method_is("POST") {
        let Ok(body) = ctx.json() else {
            return Some(util::json_invalid());
        };
        let token = body["token"].as_str().unwrap_or("");
        if !state.auth.token_accepted(Some(token)) {
            return Some(util::error(
                StatusCode::FORBIDDEN,
                "需要 control.token 才能设置或修改登录密码",
            ));
        }
        let username = body["username"].as_str().unwrap_or("").trim().to_string();
        let password = body["password"].as_str().unwrap_or("");
        if username.is_empty() {
            return Some(util::error(StatusCode::BAD_REQUEST, "用户名不能为空"));
        }
        if password.len() < 6 {
            return Some(util::error(StatusCode::BAD_REQUEST, "密码至少 6 位"));
        }
        match auth::set_password(auth_file, &username, password) {
            Ok(record) => {
                // 签名密钥的基已变成新口令哈希:旧会话立即失效,给本次请求补发一条,
                // 否则设置完密码当场被踢下线
                let session = state.auth.session_cookie(&SessionPayload {
                    via: "password".to_string(),
                    sub: record.username.clone(),
                    exp: auth::now_ms() + SESSION_TTL_MS,
                });
                let cookie =
                    auth::cookie_header("syncx_session", &session, SESSION_TTL_MS / 1000);
                Some(util::set_cookie(
                    util::ok(json!({ "ok": true, "username": record.username })),
                    &cookie,
                ))
            }
            Err(message) => Some(util::error(StatusCode::BAD_REQUEST, &message)),
        }
    } else if ctx.method_is("DELETE") {
        let token = ctx.json().ok().and_then(|body| {
            body["token"]
                .as_str()
                .map(|value| value.to_string())
        });
        if !state.auth.token_accepted(token.as_deref()) {
            return Some(util::error(
                StatusCode::FORBIDDEN,
                "需要 control.token 才能清除登录密码",
            ));
        }
        match auth::clear_password(auth_file) {
            Ok(()) => Some(util::ok_true()),
            Err(error) => Some(util::error(StatusCode::BAD_REQUEST, &error.to_string())),
        }
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_paths_match_node() {
        assert!(is_shell_path("/"));
        assert!(is_shell_path("/login"));
        assert!(is_shell_path("/compare"));
        assert!(is_shell_path("/compare/abc"));
        assert!(is_shell_path("/trash/x"));
        assert!(!is_shell_path("/api/statuss"), "拼错的 API 路径不能被壳掩盖");
        assert!(!is_shell_path("/history"));
    }
}
