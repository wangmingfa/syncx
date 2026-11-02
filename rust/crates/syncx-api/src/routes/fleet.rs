//! 多实例集中管理(fleet)的代理路由。
//!
//! 浏览器没法跨源直接问别的 daemon(整套控制 API 无 CORS,会话 cookie 是
//! SameSite=Lax),只能由本机代发。安全边界刻意收紧,不做通用代理:
//!
//!  * 路径白名单只含 fleet 视图真正需要的三个端点,方法绑定路径;
//!  * 目标 url 只取 origin,路径/查询/片段一律丢弃,scheme 仅 http/https;
//!  * 令牌只进不出:只出现在转发请求的 `Authorization` 头,不回显给页面;
//!  * 5s 超时 + 4MB 响应上限:远端挂了或异常肥大时快速失败。
//!
//! SSRF 面与 Node 一致:目标由**已登录的操作者**显式给出,和终端页「给整机 shell」
//! 同级信任;未登录请求在认证门就被拦下,进不到这里。
//!
//! 用 `reqwest` 的阻塞客户端:它自带运行时,不会在 axum 的工作线程里踩到
//! `block_on` 嵌套 panic。

use std::io::Read;

use axum::http::StatusCode;
use axum::response::Response;
use serde_json::{json, Value};

use crate::routes::util::{self, Ctx};

const PROXY_TIMEOUT_MS: u64 = 5_000;
const PROXY_MAX_BYTES: u64 = 4 * 1024 * 1024;
/// 远端回非 JSON 时透出的前若干字符(帮助排障)。
const NON_JSON_SNIPPET: usize = 200;

/// 白名单:路径 → 方法。新增动作前先想清楚 fleet 视图是否真的需要。
fn allowed_method(path: &str) -> Option<&'static str> {
    match path {
        "/api/status" => Some("GET"),
        "/api/pause" => Some("POST"),
        "/api/folders/pause" => Some("POST"),
        _ => None,
    }
}

/// url 只保留 origin;任何带路径的写法都拒绝(否则就成了任意端点代理)。
fn origin_of(raw: &str) -> Option<String> {
    let url = reqwest::Url::parse(raw).ok()?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return None;
    }
    if url.path() != "/" && !url.path().is_empty() {
        return None;
    }
    let mut origin = format!("{}://{}", url.scheme(), url.host_str()?);
    if let Some(port) = url.port() {
        origin.push_str(&format!(":{port}"));
    }
    Some(origin)
}

pub fn try_routes(ctx: &Ctx) -> Option<Response> {
    if !ctx.method_is("POST") || ctx.path != "/api/fleet/call" {
        return None;
    }

    let Ok(body) = ctx.json() else {
        return Some(util::error(StatusCode::BAD_REQUEST, "请求体须为 JSON"));
    };

    let Some(url) = body.get("url").and_then(|value| value.as_str()) else {
        return Some(util::error(StatusCode::BAD_REQUEST, "url is required"));
    };
    if url.is_empty() {
        return Some(util::error(StatusCode::BAD_REQUEST, "url is required"));
    }
    let Some(token) = body.get("token").and_then(|value| value.as_str()) else {
        return Some(util::error(
            StatusCode::BAD_REQUEST,
            "token 须为非空字符串(≤512 字符)",
        ));
    };
    if token.is_empty() || token.chars().count() > 512 {
        return Some(util::error(
            StatusCode::BAD_REQUEST,
            "token 须为非空字符串(≤512 字符)",
        ));
    }
    let Some(target_path) = body.get("path").and_then(|value| value.as_str()) else {
        return Some(util::error(
            StatusCode::BAD_REQUEST,
            "path 不在 fleet 代理白名单内",
        ));
    };
    let Some(method) = allowed_method(target_path) else {
        return Some(util::error(
            StatusCode::BAD_REQUEST,
            "path 不在 fleet 代理白名单内",
        ));
    };
    let Some(origin) = origin_of(url) else {
        return Some(util::error(
            StatusCode::BAD_REQUEST,
            "url 须为 http(s) 地址且不含路径",
        ));
    };

    let payload = if method == "POST" {
        body.get("body").map(|value| value.to_string())
    } else {
        None
    };

    Some(forward(&origin, target_path, method, token, payload.as_deref()))
}

/// 单次转发。所有失败都回 200 + `{ok:false,...}`,与 Node 一致:页面读的是载荷,
/// 不是 HTTP 状态码(400 只留给「请求本身不合法」)。
fn forward(
    origin: &str,
    path: &str,
    method: &str,
    token: &str,
    payload: Option<&str>,
) -> Response {
    let client = match reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_millis(PROXY_TIMEOUT_MS))
        .build()
    {
        Ok(client) => client,
        Err(_) => return util::ok(json!({ "ok": false, "error": "无法连接远端" })),
    };

    let mut request = match method {
        "POST" => client.post(format!("{origin}{path}")),
        _ => client.get(format!("{origin}{path}")),
    }
    .header("Authorization", format!("Bearer {token}"));
    if let Some(payload) = payload {
        request = request
            .header("Content-Type", "application/json")
            .body(payload.to_string());
    }

    let response = match request.send() {
        Ok(response) => response,
        Err(error) => return transport_error(&error),
    };
    let status = response.status().as_u16();

    // 先看 Content-Length 挡掉明显超标的,再边读边计数兜住未声明长度的流
    if response
        .content_length()
        .is_some_and(|length| length > PROXY_MAX_BYTES)
    {
        return util::ok(json!({ "ok": false, "error": "远端响应过大(>4MB)" }));
    }
    let mut collected: Vec<u8> = Vec::new();
    let mut reader = response.take(PROXY_MAX_BYTES + 1);
    if let Err(error) = reader.read_to_end(&mut collected) {
        return transport_error(&error);
    }
    if collected.len() as u64 > PROXY_MAX_BYTES {
        return util::ok(json!({ "ok": false, "error": "远端响应过大(>4MB)" }));
    }

    let text = String::from_utf8_lossy(&collected).to_string();
    if text.is_empty() {
        return util::ok(json!({ "ok": true, "status": status, "data": Value::Null }));
    }
    match serde_json::from_str::<Value>(&text) {
        Ok(data) => util::ok(json!({ "ok": true, "status": status, "data": data })),
        Err(_) => {
            // 可能被反代改写,或端口上根本不是 daemon:透出前 200 字符
            let snippet: String = text.chars().take(NON_JSON_SNIPPET).collect();
            util::ok(json!({
                "ok": false,
                "status": status,
                "error": format!("远端响应不是 JSON:{snippet}"),
            }))
        }
    }
}

/// 超时与连不上要给出不同文案:前者让用户等一会儿再试,后者要查地址。
fn transport_error(error: &dyn Errorish) -> Response {
    let message = if error.is_timeout() {
        "远端无响应(5s 超时)"
    } else {
        "无法连接远端"
    };
    util::ok(json!({ "ok": false, "error": message }))
}

/// `reqwest::Error` 与 `std::io::Error` 都可能是传输失败,只关心是不是超时。
trait Errorish {
    fn is_timeout(&self) -> bool;
}

impl Errorish for reqwest::Error {
    fn is_timeout(&self) -> bool {
        self.is_timeout()
    }
}

impl Errorish for std::io::Error {
    fn is_timeout(&self) -> bool {
        matches!(
            self.kind(),
            std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
        )
    }
}
