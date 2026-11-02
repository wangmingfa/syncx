//! 路由层的公共零件:请求上下文、响应构造、查询解析、限流。
//!
//! 这里的每个函数都对应 Node 侧 `src/api/helpers.ts` 的一个函数,语义刻意保持一致:
//! 前端是同一份 bundle,状态码或 JSON 形状差一点就是界面上一块内容空白。

use std::collections::HashMap;
use std::sync::Mutex;

use axum::body::Body;
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::response::Response;
use serde_json::Value;

/// 文本请求体上限,与 Node `readBody` 的默认值一致。
pub const MAX_TEXT_BODY: usize = 1_000_000;
/// 二进制请求体上限(上传安装包),与 Node `MAX_BINARY_BODY_BYTES` 一致。
pub const MAX_BINARY_BODY: usize = 64 * 1024 * 1024;

/// 一次请求的只读视图。体已在分发入口读完 —— 路由函数不必再关心流式读取与上限。
pub struct Ctx {
    pub method: Method,
    /// 已解百分号编码的路径(与 Node `pathname()` 同口径)。
    pub path: String,
    /// 原始查询串(不含 `?`)。
    pub query: String,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
    /// 来源地址,用于登录/分享限流。
    pub remote: String,
}

impl Ctx {
    pub fn method_is(&self, method: &str) -> bool {
        self.method.as_str() == method
    }

    /// 取一个查询参数;空串与缺省在 Node 侧同义(都用 `?? ''` 和 `||`),这里如实返回 `Option`。
    pub fn param(&self, name: &str) -> Option<String> {
        form_urlencoded::parse(self.query.as_bytes())
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.to_string())
    }

    /// 与 Node 的 `url.searchParams.get(x) ?? ''` 等价。
    pub fn param_or_empty(&self, name: &str) -> String {
        self.param(name).unwrap_or_default()
    }

    /// 请求体按 UTF-8 文本取(Node `readBody` 的口径)。
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).to_string()
    }

    /// 请求体按 JSON 解析,空体视为 `{}`(Node 里满地的 `raw === '' ? {} : JSON.parse(raw)`)。
    #[allow(clippy::result_large_err)]
    pub fn json(&self) -> Result<Value, Response> {
        if self.body.is_empty() {
            return Ok(Value::Object(serde_json::Map::new()));
        }
        serde_json::from_slice(&self.body).map_err(|_| json_invalid())
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|v| v.to_str().ok())
    }

    /// Bearer 或 `syncx_session` cookie —— 与 Node `readToken` 同样的两条通道。
    pub fn token(&self) -> Option<String> {
        header_token(&self.headers)
    }

    pub fn cookie(&self, name: &str) -> Option<String> {
        header_cookie(&self.headers, name)
    }
}

/// 取凭据的两条通道。WS 升级阶段没有请求体,只能直接读头,所以抽出来共用一份实现。
pub fn header_token(headers: &HeaderMap) -> Option<String> {
    if let Some(auth) = headers.get("authorization").and_then(|v| v.to_str().ok()) {
        if let Some(rest) = auth.strip_prefix("Bearer ") {
            if !rest.is_empty() {
                return Some(rest.to_string());
            }
        }
    }
    header_cookie(headers, "syncx_session")
}

pub fn header_cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    let raw = headers.get("cookie").and_then(|value| value.to_str().ok())?;
    for part in raw.split(';') {
        let trimmed = part.trim();
        let Some((key, value)) = trimmed.split_once('=') else {
            continue;
        };
        if key == name {
            return Some(value.to_string());
        }
    }
    None
}

/// `400 {"error":"invalid json"}`,与 Node `sendJson(res, 400, {error:'invalid json'})` 同款。
pub fn json_invalid() -> Response {
    error(StatusCode::BAD_REQUEST, "invalid json")
}

pub fn json_value(status: StatusCode, value: &Value) -> Response {
    let body = serde_json::to_vec(value).unwrap_or_else(|_| b"null".to_vec());
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body))
        .expect("响应构造不应失败")
}

pub fn ok(value: Value) -> Response {
    json_value(StatusCode::OK, &value)
}

/// `{"ok":true}`,最高频的那个载荷。
pub fn ok_true() -> Response {
    ok(serde_json::json!({ "ok": true }))
}

/// 错误载荷。`error` 字段是前端唯一读取的键,不能改名。
pub fn error(status: StatusCode, message: &str) -> Response {
    json_value(status, &serde_json::json!({ "error": message }))
}

pub fn not_found() -> Response {
    error(StatusCode::NOT_FOUND, "not found")
}

pub fn text_response(status: StatusCode, content_type: &str, body: String) -> Response {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .body(Body::from(body))
        .expect("响应构造不应失败")
}

pub fn html(body: &str) -> Response {
    text_response(StatusCode::OK, "text/html; charset=utf-8", body.to_string())
}

pub fn redirect(location: &str) -> Response {
    Response::builder()
        .status(StatusCode::FOUND)
        .header(header::LOCATION, location)
        .body(Body::empty())
        .expect("响应构造不应失败")
}

/// 覆盖 `Set-Cookie`(登录/登出这类一次性 Cookie)。
pub fn set_cookie(mut response: Response, cookie: &str) -> Response {
    if let Ok(value) = cookie.parse() {
        response.headers_mut().insert(header::SET_COOKIE, value);
    }
    response
}

/// 追加一条 `Set-Cookie`(一次响应里要同时下发会话与提权两份时用)。
pub fn with_cookie(mut response: Response, cookie: &str) -> Response {
    if let Ok(value) = cookie.parse() {
        response.headers_mut().append(header::SET_COOKIE, value);
    }
    response
}

/// 登录失败限流状态:同 IP 连续失败 5 次锁 60 秒。与 Node `helpers.ts` 同参数。
pub struct LoginLimiter {
    state: Mutex<HashMap<String, FailRecord>>,
}

#[derive(Clone, Copy)]
struct FailRecord {
    count: u32,
    until: i64,
}

pub const MAX_FAILS: u32 = 5;
pub const LOCK_MS: i64 = 60_000;

impl Default for LoginLimiter {
    fn default() -> Self {
        Self::new()
    }
}

impl LoginLimiter {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(HashMap::new()),
        }
    }

    /// 剩余锁定毫秒数;0 = 未锁定。
    pub fn remaining(&self, ip: &str) -> i64 {
        let guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        match guard.get(ip) {
            Some(record) if record.until > 0 => (record.until - crate::auth::now_ms()).max(0),
            _ => 0,
        }
    }

    pub fn note_failure(&self, ip: &str) {
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let record = guard.entry(ip.to_string()).or_insert(FailRecord {
            count: 0,
            until: 0,
        });
        record.count += 1;
        if record.count >= MAX_FAILS {
            record.until = crate::auth::now_ms() + LOCK_MS;
            record.count = 0;
        }
    }

    pub fn note_success(&self, ip: &str) {
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        guard.remove(ip);
    }
}

/// 匿名分享端点的失败限流:同 IP 每 60 秒超过 40 次即 429。与 Node `routes/share.ts` 同参数。
pub struct ShareLimiter {
    state: Mutex<HashMap<String, ShareRecord>>,
}

#[derive(Clone, Copy)]
struct ShareRecord {
    count: u32,
    window_start: i64,
}

pub const SHARE_FAIL_WINDOW_MS: i64 = 60_000;
pub const SHARE_FAIL_MAX: u32 = 40;

impl Default for ShareLimiter {
    fn default() -> Self {
        Self::new()
    }
}

impl ShareLimiter {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(HashMap::new()),
        }
    }

    /// 窗口内是否已超限(只读判定:限流要先于「开关是否开着」回答)。
    pub fn limited(&self, ip: &str, now: i64) -> bool {
        let guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        match guard.get(ip) {
            Some(record) if now - record.window_start <= SHARE_FAIL_WINDOW_MS => {
                record.count > SHARE_FAIL_MAX
            }
            _ => false,
        }
    }

    /// 记一次失败,返回「记完之后是否已超限」。
    pub fn note_failure(&self, ip: &str, now: i64) -> bool {
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        match guard.get_mut(ip) {
            Some(record) if now - record.window_start <= SHARE_FAIL_WINDOW_MS => {
                record.count += 1;
                record.count > SHARE_FAIL_MAX
            }
            _ => {
                guard.insert(
                    ip.to_string(),
                    ShareRecord {
                        count: 1,
                        window_start: now,
                    },
                );
                false
            }
        }
    }
}

/// 剩余锁定毫秒数 → 提示里的秒数。**向上取整**:还剩 1ms 时说「0s 后重试」等于
/// 让人立刻重试再撞一次墙。
pub fn lock_seconds(remaining_ms: i64) -> i64 {
    let remaining = remaining_ms.max(0);
    if remaining == 0 {
        0
    } else {
        remaining / 1000 + i64::from(remaining % 1000 != 0)
    }
}

/// 取文件名的最后一段(同时认 `/` 与 `\`,与 Node 的写法一致)。
pub fn base_name(path: &str) -> &str {
    match path.rfind(['/', '\\']) {
        Some(index) => &path[index + 1..],
        None => path,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_reads_bearer_and_cookie() {
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, "a=1; syncx_session=abc".parse().unwrap());
        let ctx = Ctx {
            method: Method::GET,
            path: "/".into(),
            query: String::new(),
            headers: headers.clone(),
            body: Vec::new(),
            remote: "127.0.0.1".into(),
        };
        assert_eq!(ctx.token().as_deref(), Some("abc"));

        headers.insert(header::AUTHORIZATION, "Bearer tok".parse().unwrap());
        let ctx = Ctx {
            method: Method::GET,
            path: "/".into(),
            query: String::new(),
            headers,
            body: Vec::new(),
            remote: "127.0.0.1".into(),
        };
        assert_eq!(ctx.token().as_deref(), Some("tok"), "Bearer 优先于 cookie");
    }

    #[test]
    fn empty_body_parses_as_object() {
        let ctx = Ctx {
            method: Method::POST,
            path: "/".into(),
            query: String::new(),
            headers: HeaderMap::new(),
            body: Vec::new(),
            remote: String::new(),
        };
        assert_eq!(ctx.json().unwrap(), serde_json::json!({}));
    }

    #[test]
    fn login_limiter_locks_after_five_failures() {
        let limiter = LoginLimiter::new();
        for _ in 0..MAX_FAILS {
            limiter.note_failure("1.2.3.4");
        }
        assert!(limiter.remaining("1.2.3.4") > 0);
        limiter.note_success("1.2.3.4");
        assert_eq!(limiter.remaining("1.2.3.4"), 0);
    }

    #[test]
    fn base_name_handles_both_separators() {
        assert_eq!(base_name("a/b/c.txt"), "c.txt");
        assert_eq!(base_name("a\\b\\c.txt"), "c.txt");
        assert_eq!(base_name("c.txt"), "c.txt");
    }
}
