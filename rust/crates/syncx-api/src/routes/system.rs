//! 系统域:状态、配对码、日志尾部、优雅关闭、手动扫描、全局暂停、自更新。
//!
//! 这里的分支与 Node `routes/system.ts` 逐条对齐,尤其是**能力缺失时的状态码**:
//! 有的端点 Node 显式回 503(前端据此显示「本装配不支持」),有的让请求落到 404。
//! 混用会让前端把「不支持的按钮」渲染成「服务端出错」,或反过来默默吞掉一个错。

use axum::http::StatusCode;
use axum::response::Response;
use serde_json::json;

use crate::deps::{AppState, OpError};
use crate::routes::util::{self, Ctx};

pub fn try_routes(state: &AppState, ctx: &Ctx) -> Option<Response> {
    // dev 运行态:源码启动没有可替换的单文件运行时。前端入口已拦,这里是最后一道
    // 防线(防直连 API),并给出明确原因而不是一个语焉不详的 503。
    if state.deps.dev_mode && ctx.path.starts_with("/api/self-update") {
        return Some(util::json_value(
            StatusCode::BAD_REQUEST,
            &json!({ "ok": false, "error": "开发模式下不支持升级功能（运行态为 dev，无单文件运行时可替换）" }),
        ));
    }

    if ctx.method_is("GET") && ctx.path == "/api/status" {
        return Some(util::ok((state.deps.status)()));
    }

    if ctx.method_is("GET") && ctx.path == "/api/paircode" {
        let Some(ops) = state.deps.ops() else {
            return Some(util::error(StatusCode::SERVICE_UNAVAILABLE, "paircode not available"));
        };
        return Some(match ops.paircode() {
            Ok(code) => {
                let port = code["port"].as_i64().unwrap_or(0);
                if port <= 0 {
                    util::error(StatusCode::SERVICE_UNAVAILABLE, "peer server 未就绪")
                } else {
                    util::ok(code)
                }
            }
            Err(OpError::Unavailable) => {
                util::error(StatusCode::SERVICE_UNAVAILABLE, "paircode not available")
            }
            Err(OpError::Failed(message)) => util::error(StatusCode::BAD_REQUEST, &message),
        });
    }

    // 日志尾部。未设置 --log-file 时回 ok:false 而不是 404:前端据此提示「加上启动参数」,
    // 而不是以为服务端坏了。
    if ctx.method_is("GET") && ctx.path == "/api/logs" {
        let requested = ctx
            .param("lines")
            .and_then(|raw| raw.parse::<i64>().ok())
            .filter(|n| *n > 0)
            .map(|n| n.min(5000) as usize)
            .unwrap_or(500);
        let Some(log_file) = state.deps.log_file.as_deref() else {
            return Some(util::ok(json!({
                "ok": false,
                "error": "未设置 --log-file,daemon 没有记录日志文件。启动时加 --log-file <路径> 后可在此查看日志。",
            })));
        };
        return Some(match std::fs::read_to_string(log_file) {
            Ok(content) => {
                let mut all: Vec<&str> = content.split('\n').collect();
                // 文件以换行结尾时最后一个元素是空串,不计入日志行
                if all.last() == Some(&"") {
                    all.pop();
                }
                let total = all.len();
                let truncated = total.saturating_sub(requested);
                let lines = &all[truncated..];
                util::ok(json!({
                    "ok": true,
                    "file": log_file.to_string_lossy(),
                    "total": total,
                    "truncated": truncated,
                    "lines": lines,
                }))
            }
            Err(error) => util::ok(json!({
                "ok": false,
                "error": format!("读取日志失败:{}", error),
            })),
        });
    }

    // 优雅关闭。必须已认证(与其它写操作同级):令牌只在本机磁盘上,但绝不能让
    // 无凭据请求关停服务。
    if ctx.method_is("POST") && ctx.path == "/api/shutdown" {
        let Some(ops) = state.deps.ops().cloned() else {
            return Some(util::error(StatusCode::SERVICE_UNAVAILABLE, "shutdown not available"));
        };
        // 先让响应冲出内核缓冲,再走关闭链路(Node 同款 50ms)
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            let _ = ops.shutdown();
        });
        return Some(util::ok(json!({ "ok": true, "msg": "shutting down" })));
    }

    if ctx.method_is("POST") && ctx.path == "/api/self-update/check" {
        let Some(ops) = state.deps.ops() else {
            return Some(util::error(StatusCode::SERVICE_UNAVAILABLE, "update check not available"));
        };
        return Some(match ops.check_for_update() {
            Ok(update) => util::ok(json!({ "ok": true, "update": update })),
            Err(OpError::Unavailable) => {
                util::error(StatusCode::SERVICE_UNAVAILABLE, "update check not available")
            }
            Err(OpError::Failed(message)) => {
                util::json_value(StatusCode::BAD_REQUEST, &json!({ "ok": false, "error": message }))
            }
        });
    }

    if ctx.method_is("POST") && ctx.path == "/api/self-update" {
        let Some(ops) = state.deps.ops().cloned() else {
            return Some(util::error(StatusCode::SERVICE_UNAVAILABLE, "self-update not available"));
        };
        return Some(match ops.self_update_npm() {
            Ok(version) => {
                schedule_shutdown(ops);
                util::ok(json!({ "ok": true, "version": version, "restarting": true }))
            }
            Err(OpError::Unavailable) => {
                util::error(StatusCode::SERVICE_UNAVAILABLE, "self-update not available")
            }
            Err(OpError::Failed(message)) => {
                util::json_value(StatusCode::BAD_REQUEST, &json!({ "ok": false, "error": message }))
            }
        });
    }

    // 上传包预检:只读,不派发 updater、不动运行期状态。请求体即 tgz 原始字节
    // (application/octet-stream,不走 multipart)。
    if ctx.method_is("POST") && ctx.path == "/api/self-update/upload/inspect" {
        let Some(ops) = state.deps.ops() else {
            return Some(util::error(StatusCode::SERVICE_UNAVAILABLE, "upload update not available"));
        };
        return Some(match ops.inspect_package(&ctx.body) {
            Ok(info) => util::ok(json!({
                "ok": true,
                "version": info["version"],
                "name": info["name"],
                "current": info["current"],
            })),
            Err(OpError::Unavailable) => {
                util::error(StatusCode::SERVICE_UNAVAILABLE, "upload update not available")
            }
            Err(OpError::Failed(message)) => {
                util::json_value(StatusCode::BAD_REQUEST, &json!({ "ok": false, "error": message }))
            }
        });
    }

    if ctx.method_is("POST") && ctx.path == "/api/self-update/upload" {
        let Some(ops) = state.deps.ops().cloned() else {
            return Some(util::error(StatusCode::SERVICE_UNAVAILABLE, "upload update not available"));
        };
        return Some(match ops.self_update_upload(&ctx.body) {
            Ok(version) => {
                schedule_shutdown(ops);
                util::ok(json!({ "ok": true, "version": version, "restarting": true }))
            }
            Err(OpError::Unavailable) => {
                util::error(StatusCode::SERVICE_UNAVAILABLE, "upload update not available")
            }
            Err(OpError::Failed(message)) => {
                util::json_value(StatusCode::BAD_REQUEST, &json!({ "ok": false, "error": message }))
            }
        });
    }

    // 手动触发一轮扫描。注意 Node 把能力判定写在了 if 条件里:没有该能力时
    // 请求继续往下落到 404,而不是回 503。
    if ctx.method_is("POST") && ctx.path == "/api/rescan" {
        let ops = state.deps.ops()?;
        return Some(match ops.rescan() {
            Ok(()) => util::ok_true(),
            Err(OpError::Unavailable) => return None,
            Err(OpError::Failed(message)) => util::error(StatusCode::BAD_REQUEST, &message),
        });
    }

    // 全局暂停/恢复。写的是配置(纯数据),但要让 daemon 立刻生效 —— 因此落盘后
    // 通知装配层重载;不依赖装配层也能正确落盘,重启后仍然生效。
    if ctx.method_is("POST") && ctx.path == "/api/pause" {
        let Ok(body) = ctx.json() else {
            return Some(util::error(StatusCode::BAD_REQUEST, "invalid json body"));
        };
        let paused = body["paused"].as_bool() == Some(true);
        return Some(match state.config.mutate(|config| {
            // 与 Node `setGlobalPaused` 同款:一律落盘字面量,取消时写 false 而不是删键
            config.paused = Some(paused);
            Ok::<_, std::io::Error>(true)
        }) {
            Ok(_) => {
                if let Some(ops) = state.deps.ops() {
                    ops.reload_config();
                }
                util::ok_true()
            }
            Err(error) => util::error(StatusCode::BAD_REQUEST, &error.to_string()),
        });
    }

    None
}

/// 自更新成功后延迟触发优雅关闭:updater 接管换入并拉起新进程(端口不变)。
fn schedule_shutdown(ops: std::sync::Arc<dyn crate::deps::ControlOps>) {
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        let _ = ops.shutdown();
    });
}
