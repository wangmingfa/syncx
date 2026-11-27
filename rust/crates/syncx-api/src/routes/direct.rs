//! 设备间直发(ADR-0028):收件箱、确认/拒绝、取消、发送文本与文件。
//!
//! 与 Node 的 `src/api/routes/direct.ts` 逐条对应(路径、状态码、错误文案),前端一套
//! 调用逻辑在三个后端上都能跑。业务状态机全在装配层的直发服务里 —— 这里只做
//! 参数校验、提权门与响应封装。
//!
//! 分发顺序:本域排在认证门之后、文件域之前。它读的是 `inbox/` 下的私有文件,
//! 与共享目录无关,不该被目录/设备的判定顺序影响。

use axum::body::Body;
use axum::http::{header, StatusCode};
use axum::response::Response;
use serde_json::Value;

use crate::deps::AppState;
use crate::routes::util::{self, Ctx};

/// 一次发送最多 20 台:避免浏览器误点「全选」时把 daemon 打满。
const MAX_TARGETS: usize = 20;

/// 单文件上限:与三个后端的直发同口径(打包后的包体也用它)。
const MAX_FILE_BYTES: u64 = 100 * 1024 * 1024;

/// 兼容旧的单设备 `deviceId` 与新的多设备 `deviceIds`,去重并保持传入顺序。
fn parse_targets(ctx: &Ctx) -> Vec<String> {
    let mut raw_values: Vec<String> = Vec::new();
    if let Some(single) = ctx.param("deviceId") {
        raw_values.push(single);
    }
    raw_values.extend(ctx.params("deviceIds"));
    let mut ids: Vec<String> = Vec::new();
    for raw in raw_values {
        let id = raw.trim().to_string();
        if id.is_empty() || ids.contains(&id) {
            continue;
        }
        ids.push(id);
    }
    ids
}

pub fn try_routes(state: &AppState, ctx: &Ctx) -> Option<Response> {
    let path = ctx.path.as_str();
    if !path.starts_with("/api/direct") {
        return None;
    }
    let Some(ops) = state.deps.ops() else {
        return Some(util::error(
            StatusCode::SERVICE_UNAVAILABLE,
            "当前后端不支持设备间直发",
        ));
    };

    // GET /api/direct/inbox : 元数据快照(正文不进状态,按需另取)
    if ctx.method_is("GET") && path == "/api/direct/inbox" {
        return Some(match ops.direct_snapshot() {
            Ok(value) => util::ok(value),
            Err(error) => util::error(StatusCode::INTERNAL_SERVER_ERROR, &error.message()),
        });
    }

    // GET /api/direct/inbox/:id/content : 文本/文件正文(下载用)
    if ctx.method_is("GET") {
        if let Some(id) = path
            .strip_prefix("/api/direct/inbox/")
            .and_then(|rest| rest.strip_suffix("/content"))
        {
            return Some(match ops.direct_content(id) {
                Ok((meta, bytes)) => content_response(&meta, bytes),
                Err(_) => util::error(StatusCode::NOT_FOUND, "收件箱条目不存在"),
            });
        }
    }

    // DELETE /api/direct/inbox/:id
    if ctx.method_is("DELETE") {
        if let Some(id) = path.strip_prefix("/api/direct/inbox/") {
            if !id.is_empty() && !id.contains('/') {
                return Some(match ops.direct_remove(id) {
                    Ok(true) => util::ok_true(),
                    _ => util::error(StatusCode::NOT_FOUND, "收件箱条目不存在"),
                });
            }
        }
    }

    if !ctx.method_is("POST") {
        return None;
    }

    // POST /api/direct/reply : 接收方确认/拒绝。id = 单条;batchId = 同一次多文件整组
    if path == "/api/direct/reply" {
        let Ok(body) = ctx.json() else {
            return Some(util::json_invalid());
        };
        let id = body
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty());
        let batch = body
            .get("batchId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty());
        let Some(accept) = body.get("accept").and_then(Value::as_bool) else {
            return Some(util::error(
                StatusCode::BAD_REQUEST,
                "需要 id 或 batchId（二者取其一）以及 accept",
            ));
        };
        // 二者取其一:同时给会让「到底处理了几条」变得含混。
        if id.is_some() == batch.is_some() {
            return Some(util::error(
                StatusCode::BAD_REQUEST,
                "需要 id 或 batchId（二者取其一）以及 accept",
            ));
        }
        let save_to = match body.get("saveTo") {
            None => None,
            Some(_) if !accept => {
                return Some(util::error(
                    StatusCode::BAD_REQUEST,
                    "只有接收文件时才能指定保存目录",
                ));
            }
            Some(value) => match value.as_str() {
                Some(text) if !text.trim().is_empty() => Some(text.to_string()),
                _ => {
                    return Some(util::error(StatusCode::BAD_REQUEST, "保存目录格式不正确"));
                }
            },
        };
        if save_to.is_some() {
            // 另存会写用户目录,与删除/终端同一条门:必须已提权。
            if !state.auth.elevate_ok(ctx.cookie("syncx_su").as_deref()) {
                return Some(util::error(
                    StatusCode::FORBIDDEN,
                    "另存到指定目录需要验证:请用控制令牌或密码完成验证",
                ));
            }
        }
        let reason = body.get("reason").and_then(Value::as_str);
        return Some(
            match ops.direct_reply(id, batch, accept, reason, save_to.as_deref()) {
                Ok(count) if count > 0 => {
                    util::ok(serde_json::json!({ "ok": true, "count": count }))
                }
                Ok(_) if batch.is_some() => {
                    util::error(StatusCode::NOT_FOUND, "该组待确认文件不存在或已处理")
                }
                Ok(_) => util::error(StatusCode::NOT_FOUND, "待确认项不存在或已处理"),
                Err(error) => util::error(StatusCode::BAD_REQUEST, &error.message()),
            },
        );
    }

    // POST /api/direct/cancel : 取消一条仍在排队的投送(设备离线时才有)
    if path == "/api/direct/cancel" {
        let Ok(body) = ctx.json() else {
            return Some(util::json_invalid());
        };
        let Some(id) = body.get("id").and_then(Value::as_str) else {
            return Some(util::error(StatusCode::BAD_REQUEST, "缺少投送 id"));
        };
        return Some(match ops.direct_cancel(id) {
            Ok(true) => util::ok_true(),
            _ => util::error(
                StatusCode::NOT_FOUND,
                "该投送不在排队中(可能已发出或已结束)",
            ),
        });
    }

    // POST /api/direct/text : 发送一段文本(支持 deviceIds 多设备)
    if path == "/api/direct/text" {
        let Ok(body) = ctx.json() else {
            return Some(util::json_invalid());
        };
        let mut raw_values: Vec<String> = Vec::new();
        if let Some(single) = body.get("deviceId").and_then(Value::as_str) {
            raw_values.push(single.to_string());
        }
        if let Some(list) = body.get("deviceIds").and_then(Value::as_array) {
            raw_values.extend(list.iter().filter_map(Value::as_str).map(str::to_string));
        }
        let mut ids: Vec<String> = Vec::new();
        for raw in raw_values {
            let id = raw.trim().to_string();
            if id.is_empty() || ids.contains(&id) {
                continue;
            }
            ids.push(id);
        }
        let Some(text) = body.get("text").and_then(Value::as_str) else {
            return Some(util::error(
                StatusCode::BAD_REQUEST,
                "需要 1 ~ 20 台目标设备和文本内容",
            ));
        };
        if ids.is_empty() || ids.len() > MAX_TARGETS {
            return Some(util::error(
                StatusCode::BAD_REQUEST,
                "需要 1 ~ 20 台目标设备和文本内容",
            ));
        }
        return Some(match ops.direct_send_text(&ids, text) {
            Ok(value) => util::ok(value),
            Err(error) => util::error(StatusCode::BAD_REQUEST, &error.message()),
        });
    }

    // POST /api/direct/file?deviceIds=&name=&size=&batch= : 暂存一次 + 发起多设备文件直发
    // 带 `zip=<batch>` 时只暂存、不投送,等 POST /api/direct/zip 打包后一次性发。
    if path == "/api/direct/file" {
        let ids = parse_targets(ctx);
        let name = ctx.param_or_empty("name");
        let size = ctx
            .param("size")
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);
        let batch = ctx
            .param("batch")
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
        let zip_batch = ctx
            .param("zip")
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
        if name.is_empty() || size == 0 || size > MAX_FILE_BYTES || ctx.body.len() as u64 != size {
            return Some(util::error(
                StatusCode::BAD_REQUEST,
                "文件参数不正确（名字、大小必填，单文件不超过 100MB）",
            ));
        }
        // 打包模式不需要目标设备:文件先进暂存区,选人在 /api/direct/zip 那一步。
        if zip_batch.is_none() && (ids.is_empty() || ids.len() > MAX_TARGETS) {
            return Some(util::error(
                StatusCode::BAD_REQUEST,
                "需要 1 ~ 20 台目标设备及合法的文件参数",
            ));
        }
        for value in batch.iter().chain(zip_batch.iter()) {
            if !valid_batch(value) {
                return Some(util::error(StatusCode::BAD_REQUEST, "批次号格式不正确"));
            }
        }
        if let Some(zip) = zip_batch {
            return Some(
                match ops.direct_stage_zip(&zip, &name, size, &ctx.body) {
                    Ok(value) => util::ok(value),
                    Err(error) => util::error(StatusCode::BAD_REQUEST, &error.message()),
                },
            );
        }
        return Some(
            match ops.direct_send_file(&ids, &name, size, &ctx.body, batch.as_deref()) {
                Ok(value) => util::ok(value),
                Err(error) => util::error(StatusCode::BAD_REQUEST, &error.message()),
            },
        );
    }

    // POST /api/direct/zip { batch, deviceIds, name? } : 把暂存的文件打成一个包再投送
    if path == "/api/direct/zip" {
        let Ok(body) = ctx.json() else {
            return Some(util::json_invalid());
        };
        let batch = body
            .get("batch")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        let ids = targets_from_body(&body);
        if !valid_batch(batch) || ids.is_empty() || ids.len() > MAX_TARGETS {
            return Some(util::error(
                StatusCode::BAD_REQUEST,
                "需要批次号与 1 ~ 20 台目标设备",
            ));
        }
        let name = body
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty());
        return Some(match ops.direct_send_zip(&ids, batch, name) {
            Ok(value) => util::ok(value),
            Err(error) => util::error(StatusCode::BAD_REQUEST, &error.message()),
        });
    }

    None
}

/// 批次号:与前端 `crypto.randomUUID()` 同字符集,同时挡住路径穿越。
fn valid_batch(batch: &str) -> bool {
    !batch.is_empty()
        && batch.len() <= 64
        && batch
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// 请求体里的目标设备:兼容旧的单设备 `deviceId` 与新的 `deviceIds`。
fn targets_from_body(body: &Value) -> Vec<String> {
    let mut raw: Vec<String> = Vec::new();
    if let Some(single) = body.get("deviceId").and_then(Value::as_str) {
        raw.push(single.to_string());
    }
    if let Some(list) = body.get("deviceIds").and_then(Value::as_array) {
        raw.extend(list.iter().filter_map(Value::as_str).map(str::to_string));
    }
    let mut ids: Vec<String> = Vec::new();
    for item in raw {
        let id = item.trim().to_string();
        if id.is_empty() || ids.contains(&id) {
            continue;
        }
        ids.push(id);
    }
    ids
}

/// 收件箱内容的响应:文本按纯文本给(前端直接展示),文件按附件下载。
fn content_response(meta: &serde_json::Value, bytes: Vec<u8>) -> Response {
    let kind = meta.get("kind").and_then(|v| v.as_str()).unwrap_or("file");
    if kind == "text" {
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
            .header(header::CACHE_CONTROL, "no-store")
            .body(Body::from(bytes))
            .unwrap_or_else(|_| util::error(StatusCode::INTERNAL_SERVER_ERROR, "internal error"));
    }
    let name = meta
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("download");
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename*=UTF-8''{}", percent_encode_name(name)),
        )
        .header(header::CONTENT_LENGTH, bytes.len())
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(bytes))
        .unwrap_or_else(|_| util::error(StatusCode::INTERNAL_SERVER_ERROR, "internal error"))
}

/// 与 Node 的 `encodeURIComponent(name).replace(/['()]/g, %XX)` 同口径。
fn percent_encode_name(name: &str) -> String {
    let mut out = String::new();
    for byte in name.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'!' | b'*' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    use axum::http::{HeaderMap, Method};
    use axum::response::Response;

    use super::*;
    use crate::deps::{ControlDeps, ControlOps, OpResult};

    /// 只记账、不实现状态的假装配。
    ///
    /// 路由层测的是**契约**:校验顺序、状态码、错误文案、响应头。业务状态机在
    /// 装配层另有对拍用例,这里重复实现一遍只会让两处都难维护。
    #[derive(Default)]
    struct FakeOps {
        calls: Mutex<Vec<String>>,
        snapshot: Option<Value>,
        content: Option<(Value, Vec<u8>)>,
        removed: bool,
        reply_count: usize,
        cancelled: bool,
    }

    impl FakeOps {
        fn log(&self, call: String) {
            self.calls.lock().unwrap().push(call);
        }

        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl ControlOps for FakeOps {
        fn direct_snapshot(&self) -> OpResult<Value> {
            self.log("snapshot".into());
            Ok(self.snapshot.clone().unwrap_or(Value::Null))
        }

        fn direct_content(&self, id: &str) -> OpResult<(Value, Vec<u8>)> {
            self.log(format!("content:{id}"));
            match &self.content {
                Some((meta, bytes)) => Ok((meta.clone(), bytes.clone())),
                None => Err(crate::deps::OpError::Failed("missing".into())),
            }
        }

        fn direct_remove(&self, id: &str) -> OpResult<bool> {
            self.log(format!("remove:{id}"));
            Ok(self.removed)
        }

        fn direct_reply(
            &self,
            id: Option<&str>,
            batch: Option<&str>,
            accept: bool,
            reason: Option<&str>,
            save_to: Option<&str>,
        ) -> OpResult<usize> {
            self.log(format!(
                "reply:id={:?},batch={:?},accept={accept},reason={:?},saveTo={:?}",
                id,
                batch,
                reason.unwrap_or(""),
                save_to.unwrap_or("")
            ));
            Ok(self.reply_count)
        }

        fn direct_cancel(&self, id: &str) -> OpResult<bool> {
            self.log(format!("cancel:{id}"));
            Ok(self.cancelled)
        }

        fn direct_send_text(&self, ids: &[String], text: &str) -> OpResult<Value> {
            self.log(format!("text:{ids:?}:{text}"));
            Ok(serde_json::json!({ "ids": ids, "results": [] }))
        }

        fn direct_send_file(
            &self,
            ids: &[String],
            name: &str,
            size: u64,
            bytes: &[u8],
            batch: Option<&str>,
        ) -> OpResult<Value> {
            self.log(format!(
                "file:{ids:?}:{name}:{size}:{}:batch={:?}",
                bytes.len(),
                batch.unwrap_or("")
            ));
            Ok(serde_json::json!({ "ids": ids, "results": [] }))
        }

        fn direct_stage_zip(
            &self,
            batch: &str,
            name: &str,
            size: u64,
            bytes: &[u8],
        ) -> OpResult<Value> {
            self.log(format!(
                "stage:{batch}:{name}:{size}:{}",
                bytes.len()
            ));
            Ok(serde_json::json!({
                "staged": true,
                "count": 1,
                "name": name,
                "size": size,
            }))
        }

        fn direct_send_zip(
            &self,
            ids: &[String],
            batch: &str,
            name: Option<&str>,
        ) -> OpResult<Value> {
            self.log(format!("zip:{ids:?}:{batch}:{}", name.unwrap_or("")));
            Ok(serde_json::json!({ "ids": ids, "results": [] }))
        }
    }

    /// 临时目录 + 真实 `ConfigStore`,可选接上一个假装配。
    fn temp_state(tag: &str, ops: Option<Arc<FakeOps>>) -> (AppState, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "syncx-api-direct-route-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let mut deps = ControlDeps::new("test-token", dir.join("config.json"));
        if let Some(ops) = ops {
            deps.ops = Some(ops as Arc<dyn ControlOps>);
        }
        let state = AppState::new(deps);
        (state, dir)
    }

    fn ctx(method: Method, path: &str, query: &str, body: Vec<u8>) -> Ctx {
        Ctx {
            method,
            path: path.into(),
            query: query.into(),
            headers: HeaderMap::new(),
            body,
            remote: String::new(),
        }
    }

    fn get(path: &str) -> Ctx {
        ctx(Method::GET, path, "", Vec::new())
    }

    fn post(path: &str, body: Value) -> Ctx {
        ctx(Method::POST, path, "", serde_json::to_vec(&body).unwrap())
    }

    async fn body_bytes(response: Response) -> (StatusCode, HeaderMap, Vec<u8>) {
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .to_vec();
        (status, headers, bytes)
    }

    async fn body_json(response: Response) -> (StatusCode, Value) {
        let (status, _, bytes) = body_bytes(response).await;
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    fn error_text(body: &Value) -> String {
        body.get("error")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    }

    /// 装配没提供直发时,整个域统一 503 并给出可读原因 —— 前端据此隐藏入口。
    #[tokio::test]
    async fn missing_ops_reports_unsupported_whole_domain() {
        let (state, dir) = temp_state("no-ops", None);
        for request in [
            get("/api/direct/inbox"),
            get("/api/direct/inbox/abc/content"),
            ctx(Method::DELETE, "/api/direct/inbox/abc", "", Vec::new()),
            post("/api/direct/reply", serde_json::json!({ "id": "a", "accept": true })),
            post("/api/direct/text", serde_json::json!({ "deviceIds": ["d"], "text": "hi" })),
            post("/api/direct/zip", serde_json::json!({})),
        ] {
            let response = try_routes(&state, &request).expect("直发域必须接管该路径");
            let (status, body) = body_json(response).await;
            assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
            assert_eq!(error_text(&body), "当前后端不支持设备间直发");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 不属于直发的路径必须原样放行(排在 `files` 之前,很容易误吞前缀)。
    #[test]
    fn other_paths_fall_through() {
        let (state, dir) = temp_state("fallthrough", Some(Arc::new(FakeOps::default())));
        assert!(try_routes(&state, &get("/api/files")).is_none());
        assert!(try_routes(&state, &get("/api/directed")).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 打包投送:批次号与目标设备两个都校验,且必须在进状态机之前。
    #[tokio::test]
    async fn zip_route_requires_batch_and_targets() {
        let (state, dir) = temp_state("zip-shape", Some(Arc::new(FakeOps::default())));
        let expected = "需要批次号与 1 ~ 20 台目标设备";
        for body in [
            serde_json::json!({}),
            serde_json::json!({ "batch": "b1" }),
            serde_json::json!({ "batch": "", "deviceIds": ["d"] }),
            serde_json::json!({ "batch": "../etc", "deviceIds": ["d"] }),
            serde_json::json!({ "batch": "b1", "deviceIds": [] }),
        ] {
            let response = try_routes(&state, &post("/api/direct/zip", body)).unwrap();
            let (status, body) = body_json(response).await;
            assert_eq!(status, StatusCode::BAD_REQUEST);
            assert_eq!(error_text(&body), expected);
        }
        let too_many: Vec<String> = (0..21).map(|i| format!("d{i}")).collect();
        let response = try_routes(
            &state,
            &post(
                "/api/direct/zip",
                serde_json::json!({ "batch": "b1", "deviceIds": too_many }),
            ),
        )
        .unwrap();
        assert_eq!(body_json(response).await.0, StatusCode::BAD_REQUEST);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 合法请求原样透传:批次号、去重后的目标、可选包名。
    #[tokio::test]
    async fn zip_route_passes_batch_targets_and_name() {
        let ops = Arc::new(FakeOps::default());
        let (state, dir) = temp_state("zip-ok", Some(Arc::clone(&ops)));
        let response = try_routes(
            &state,
            &post(
                "/api/direct/zip",
                serde_json::json!({ "batch": "b-1", "deviceIds": ["A", "A", "B"], "name": "报告" }),
            ),
        )
        .unwrap();
        let (status, body) = body_json(response).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["ids"], serde_json::json!(["A", "B"]));
        assert_eq!(ops.calls(), vec!["zip:[\"A\", \"B\"]:b-1:报告".to_string()]);
        // 不给包名时透传 None(由装配层生成默认名)。
        let response = try_routes(
            &state,
            &post(
                "/api/direct/zip",
                serde_json::json!({ "batch": "b-2", "deviceId": "A" }),
            ),
        )
        .unwrap();
        assert_eq!(body_json(response).await.0, StatusCode::OK);
        assert_eq!(
            ops.calls().last().unwrap(),
            "zip:[\"A\"]:b-2:",
            "缺省包名不该被路由编出来"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 打包模式的上传:`?zip=<batch>` 只暂存,不需要目标设备。
    #[tokio::test]
    async fn file_route_stages_in_zip_mode() {
        let ops = Arc::new(FakeOps::default());
        let (state, dir) = temp_state("zip-stage", Some(Arc::clone(&ops)));
        let request = ctx(
            Method::POST,
            "/api/direct/file",
            "zip=b1&name=a.txt&size=3",
            b"abc".to_vec(),
        );
        let response = try_routes(&state, &request).unwrap();
        let (status, body) = body_json(response).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["staged"], true);
        assert_eq!(body["count"], 1);
        assert_eq!(ops.calls(), vec!["stage:b1:a.txt:3:3".to_string()]);

        // 批次号与大小校验在暂存之前。
        for (query, expected) in [
            ("zip=../etc&name=a.txt&size=3", "批次号格式不正确"),
            (
                "zip=b1&name=&size=3",
                "文件参数不正确（名字、大小必填，单文件不超过 100MB）",
            ),
            (
                "zip=b1&name=a.txt&size=9",
                "文件参数不正确（名字、大小必填，单文件不超过 100MB）",
            ),
        ] {
            let request = ctx(Method::POST, "/api/direct/file", query, b"abc".to_vec());
            let response = try_routes(&state, &request).unwrap();
            let (status, body) = body_json(response).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{query}");
            assert_eq!(error_text(&body), expected, "{query}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `id` 与 `batchId` 必须二选一。同时给会让「处理了几条」含混,一个都不给则
    /// 无从定位 —— 两种都回同一句提示,校验必须在进状态机之前。
    #[tokio::test]
    async fn reply_requires_exactly_one_of_id_and_batch() {
        let (state, dir) = temp_state("reply-shape", Some(Arc::new(FakeOps::default())));
        let expected = "需要 id 或 batchId（二者取其一）以及 accept";
        for body in [
            serde_json::json!({ "accept": true }),
            serde_json::json!({ "id": "a", "batchId": "b", "accept": true }),
            serde_json::json!({ "id": "a" }),
            serde_json::json!({ "id": "  ", "accept": true }),
        ] {
            let response = try_routes(&state, &post("/api/direct/reply", body))
                .expect("直发域必须接管该路径");
            let (status, raw) = body_json(response).await;
            assert_eq!(status, StatusCode::BAD_REQUEST);
            assert_eq!(error_text(&raw), expected);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 另存会写进用户目录,必须已提权 —— 与删除/终端同一道门。
    #[tokio::test]
    async fn reply_save_to_requires_elevation() {
        let ops = Arc::new(FakeOps {
            reply_count: 1,
            ..FakeOps::default()
        });
        let (state, dir) = temp_state("reply-elevate", Some(ops.clone()));
        let mut request = post(
            "/api/direct/reply",
            serde_json::json!({ "id": "abc", "accept": true, "saveTo": "/tmp/out" }),
        );

        // 未提权:403,且不能落到状态机(否则等于绕过门禁写盘)
        let response = try_routes(&state, &request).expect("直发域必须接管该路径");
        let (status, body) = body_json(response).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(
            error_text(&body),
            "另存到指定目录需要验证:请用控制令牌或密码完成验证"
        );
        assert!(ops.calls().is_empty(), "403 时不得调用直发服务");

        // 提权后放行,并把原样的 saveTo 交给状态机(规范化在装配层做)
        let cookie = format!("syncx_su={}", state.auth.elevation_cookie());
        request
            .headers
            .insert(header::COOKIE, cookie.parse().unwrap());
        let response = try_routes(&state, &request).expect("直发域必须接管该路径");
        let (status, body) = body_json(response).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body.get("count").and_then(Value::as_u64), Some(1));
        assert_eq!(
            ops.calls(),
            vec!["reply:id=Some(\"abc\"),batch=None,accept=true,reason=\"\",saveTo=\"/tmp/out\""
                .to_string()]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 拒绝时不许带 `saveTo`:那时候根本没有文件要落盘,带着它多半是前端状态没清。
    #[tokio::test]
    async fn reply_rejects_save_to_when_declining() {
        let (state, dir) = temp_state("reply-decline", Some(Arc::new(FakeOps::default())));
        let response = try_routes(
            &state,
            &post(
                "/api/direct/reply",
                serde_json::json!({ "id": "a", "accept": false, "saveTo": "/tmp/out" }),
            ),
        )
        .expect("直发域必须接管该路径");
        let (status, body) = body_json(response).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(error_text(&body), "只有接收文件时才能指定保存目录");

        // 非字符串同样要挡住,别让 JSON 里的数字一路走到路径拼接
        let response = try_routes(
            &state,
            &post(
                "/api/direct/reply",
                serde_json::json!({ "id": "a", "accept": true, "saveTo": 123 }),
            ),
        )
        .expect("直发域必须接管该路径");
        let (status, body) = body_json(response).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(error_text(&body), "保存目录格式不正确");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 处理到 0 条时的文案按模式分叉:整组要说清「这一组都不在了」,单条说「这条」。
    #[tokio::test]
    async fn reply_empty_result_message_depends_on_mode() {
        let (state, dir) = temp_state("reply-empty", Some(Arc::new(FakeOps::default())));

        let response = try_routes(
            &state,
            &post(
                "/api/direct/reply",
                serde_json::json!({ "batchId": "b1", "accept": true }),
            ),
        )
        .expect("直发域必须接管该路径");
        let (status, body) = body_json(response).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(error_text(&body), "该组待确认文件不存在或已处理");

        let response = try_routes(
            &state,
            &post(
                "/api/direct/reply",
                serde_json::json!({ "id": "a1", "accept": true }),
            ),
        )
        .expect("直发域必须接管该路径");
        let (status, body) = body_json(response).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(error_text(&body), "待确认项不存在或已处理");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 文件直发的参数校验:目标数、大小与体长必须自洽 —— 否则会先落一份错位的
    /// 暂存文件,等对端拒收才发现。
    #[tokio::test]
    async fn file_route_validates_targets_name_size_and_body() {
        let ops = Arc::new(FakeOps::default());
        let (state, dir) = temp_state("file", Some(ops.clone()));
        let payload = b"hello".to_vec();
        let bad_params = "文件参数不正确（名字、大小必填，单文件不超过 100MB）";
        let bad_targets = "需要 1 ~ 20 台目标设备及合法的文件参数";

        for (query, expected) in [
            // 名字为空 / size 为 0 / 体长与 size 不一致:都是「文件参数」这一档
            ("deviceIds=d1&name=&size=5", bad_params),
            ("deviceIds=d1&name=a.txt&size=0", bad_params),
            ("deviceIds=d1&name=a.txt&size=9", bad_params),
            // 参数齐了但没给目标(体长与 size 自洽,错在目标)
            ("name=a.txt&size=5", bad_targets),
            ("name=a.txt&size=5&deviceIds=", bad_targets),
            // 目标超过 20 台
            ("deviceIds=d1&deviceIds=d2&deviceIds=d3&deviceIds=d4&deviceIds=d5&deviceIds=d6&deviceIds=d7&deviceIds=d8&deviceIds=d9&deviceIds=d10&deviceIds=d11&deviceIds=d12&deviceIds=d13&deviceIds=d14&deviceIds=d15&deviceIds=d16&deviceIds=d17&deviceIds=d18&deviceIds=d19&deviceIds=d20&deviceIds=d21&name=a.txt&size=5", bad_targets),
        ] {
            let response = try_routes(
                &state,
                &ctx(Method::POST, "/api/direct/file", query, payload.clone()),
            )
            .expect("直发域必须接管该路径");
            let (status, body) = body_json(response).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "query={query}");
            assert_eq!(error_text(&body), expected, "query={query}");
        }

        // 批次号只允许 `[A-Za-z0-9_-]`:它会进文件名,不能带分隔符
        let response = try_routes(
            &state,
            &ctx(
                Method::POST,
                "/api/direct/file",
                "deviceIds=d1&name=a.txt&size=5&batch=bad%20batch",
                payload.clone(),
            ),
        )
        .expect("直发域必须接管该路径");
        let (status, body) = body_json(response).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(error_text(&body), "批次号格式不正确");
        assert!(ops.calls().is_empty(), "校验失败不得落盘");

        // 合法请求:`deviceId` 与 `deviceIds` 合并去重并保持顺序
        let response = try_routes(
            &state,
            &ctx(
                Method::POST,
                "/api/direct/file",
                "deviceId=d0&deviceIds=d1&deviceIds=d0&name=a.txt&size=5&batch=b-1_x",
                payload.clone(),
            ),
        )
        .expect("直发域必须接管该路径");
        let (status, body) = body_json(response).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body.get("ids").unwrap().as_array().unwrap().len(), 2);
        assert_eq!(
            ops.calls(),
            vec![r#"file:["d0", "d1"]:a.txt:5:5:batch="b-1_x""#.to_string()]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 文本直发:目标 1 ~ 20 台,正文必须是字符串(空串允许,状态机自己判)。
    #[tokio::test]
    async fn text_route_validates_targets_and_text() {
        let (state, dir) = temp_state("text", Some(Arc::new(FakeOps::default())));
        let bad = "需要 1 ~ 20 台目标设备和文本内容";
        let many: Vec<String> = (0..21).map(|i| format!("d{i}")).collect();

        for body in [
            serde_json::json!({ "deviceIds": [], "text": "hi" }),
            serde_json::json!({ "deviceIds": many, "text": "hi" }),
            serde_json::json!({ "deviceIds": ["d1"] }),
            serde_json::json!({ "deviceIds": ["d1"], "text": 42 }),
        ] {
            let response =
                try_routes(&state, &post("/api/direct/text", body)).expect("直发域必须接管该路径");
            let (status, raw) = body_json(response).await;
            assert_eq!(status, StatusCode::BAD_REQUEST);
            assert_eq!(error_text(&raw), bad);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 收件箱:文本按纯文本给(前端直接展示),文件按附件下载并做 UTF-8 文件名编码。
    #[tokio::test]
    async fn content_serves_text_inline_and_file_as_attachment() {
        let ops = Arc::new(FakeOps {
            content: Some((
                serde_json::json!({ "kind": "text", "name": "note" }),
                "你好".as_bytes().to_vec(),
            )),
            ..FakeOps::default()
        });
        let (state, dir) = temp_state("content-text", Some(ops));
        let response = try_routes(&state, &get("/api/direct/inbox/abc/content"))
            .expect("直发域必须接管该路径");
        let (status, headers, bytes) = body_bytes(response).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            headers.get(header::CONTENT_TYPE).unwrap(),
            "text/plain; charset=utf-8"
        );
        assert!(headers.get(header::CONTENT_DISPOSITION).is_none());
        assert_eq!(headers.get(header::CACHE_CONTROL).unwrap(), "no-store");
        assert_eq!(String::from_utf8(bytes).unwrap(), "你好");

        let ops = Arc::new(FakeOps {
            content: Some((
                serde_json::json!({ "kind": "file", "name": "报表 (1).xlsx" }),
                vec![1u8, 2, 3],
            )),
            ..FakeOps::default()
        });
        let (state, dir2) = temp_state("content-file", Some(ops));
        let response = try_routes(&state, &get("/api/direct/inbox/abc/content"))
            .expect("直发域必须接管该路径");
        let (status, headers, bytes) = body_bytes(response).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            headers.get(header::CONTENT_TYPE).unwrap(),
            "application/octet-stream"
        );
        assert_eq!(
            headers.get(header::CONTENT_DISPOSITION).unwrap(),
            "attachment; filename*=UTF-8''%E6%8A%A5%E8%A1%A8%20%281%29.xlsx"
        );
        assert_eq!(headers.get(header::CONTENT_LENGTH).unwrap(), "3");
        assert_eq!(bytes, vec![1u8, 2, 3]);
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&dir2);
    }

    /// 条目不存在一律 404,而且**不能**透出内部错误:`direct_content` 的失败原因
    /// 里可能带磁盘路径。
    #[tokio::test]
    async fn missing_entries_are_404_without_leaking_details() {
        let (state, dir) = temp_state("missing", Some(Arc::new(FakeOps::default())));

        let response =
            try_routes(&state, &get("/api/direct/inbox/abc/content")).expect("直发域必须接管该路径");
        let (status, body) = body_json(response).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(error_text(&body), "收件箱条目不存在");

        let response = try_routes(
            &state,
            &ctx(Method::DELETE, "/api/direct/inbox/abc", "", Vec::new()),
        )
        .expect("直发域必须接管该路径");
        let (status, body) = body_json(response).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(error_text(&body), "收件箱条目不存在");

        let response =
            try_routes(&state, &post("/api/direct/cancel", serde_json::json!({ "id": "x" })))
                .expect("直发域必须接管该路径");
        let (status, body) = body_json(response).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(
            error_text(&body),
            "该投送不在排队中(可能已发出或已结束)"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 取消必须带 id;带斜杠的 id 在 DELETE 上直接不当条目(id 是单段路径)。
    #[tokio::test]
    async fn cancel_and_delete_reject_malformed_ids() {
        let (state, dir) = temp_state("bad-ids", Some(Arc::new(FakeOps::default())));

        let response = try_routes(&state, &post("/api/direct/cancel", serde_json::json!({})))
            .expect("直发域必须接管该路径");
        let (status, body) = body_json(response).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(error_text(&body), "缺少投送 id");

        // `a/b` 不是条目 id,交给后续路由(而不是当成 id 去删)
        assert!(try_routes(
            &state,
            &ctx(Method::DELETE, "/api/direct/inbox/a/b", "", Vec::new())
        )
        .is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 快照原样透传:`inbox` 的 JSON 形状由装配层决定,路由不再包一层。
    #[tokio::test]
    async fn snapshot_passes_through_untouched() {
        let ops = Arc::new(FakeOps {
            snapshot: Some(serde_json::json!({ "items": [{ "id": "a" }], "queued": [] })),
            ..FakeOps::default()
        });
        let (state, dir) = temp_state("snapshot", Some(ops));
        let response = try_routes(&state, &get("/api/direct/inbox")).expect("直发域必须接管该路径");
        let (status, body) = body_json(response).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, serde_json::json!({ "items": [{ "id": "a" }], "queued": [] }));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 与 Node `encodeURIComponent(name).replace(/['()]/g, '%XX')` 逐字节一致:
    /// 两边后端给出的 `Content-Disposition` 必须能让同一个浏览器存成同一个文件名。
    #[test]
    fn percent_encode_matches_encode_uri_component() {
        assert_eq!(percent_encode_name("a b.txt"), "a%20b.txt");
        // `!*` 是 encodeURIComponent 不转义的少数符号,`'()` 被 Node 额外替换掉
        assert_eq!(percent_encode_name("a!b*c"), "a!b*c");
        assert_eq!(percent_encode_name("it's (1).txt"), "it%27s%20%281%29.txt");
        assert_eq!(percent_encode_name("报表.xlsx"), "%E6%8A%A5%E8%A1%A8.xlsx");
    }
}
