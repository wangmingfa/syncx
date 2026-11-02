//! 设备、全局设置、手动重扫/重连与 fallback 表单动作。
//!
//! 与 Node `routes/devices.ts` 逐条对齐。设备增删与设置落盘是纯配置动作(本 crate
//! 直接写);重扫/重连/自更新/Webhook 测试是活会话动作,经 `ControlOps` 注入,未注入时
//! 按 Node 的 `&& deps.x` 语义**不认这条路由**(落到 404),而不是回一个假的成功。

use axum::http::StatusCode;
use axum::response::Response;
use serde_json::{json, Map, Value};

use crate::deps::AppState;
use crate::fsops;
use crate::mutate;
use crate::routes::util::{self, Ctx};

/// `encodeURIComponent` 的等价物。多编码几个 `-_.~` 只影响观感,少编码一个就会让中文
/// 消息在 `Location` 头里变成非法字节。
fn encode_component(text: &str) -> String {
    percent_encoding::utf8_percent_encode(text, percent_encoding::NON_ALPHANUMERIC).to_string()
}

fn redirect_msg(path: &str, message: &str) -> Response {
    util::redirect(&format!("{path}?msg={}", encode_component(message)))
}

fn non_empty_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(|value| value.as_str())
        .filter(|text| !text.is_empty())
        .map(|text| text.to_string())
}

pub fn try_routes(state: &AppState, ctx: &Ctx) -> Option<Response> {
    let path = ctx.path.as_str();

    // POST /api/devices : 添加一个已知对端设备 ID(可选直连地址)
    if ctx.method_is("POST") && path == "/api/devices" {
        let Ok(body) = ctx.json() else {
            return Some(util::json_invalid());
        };
        let Some(device_id) = non_empty_string(body.get("deviceId")) else {
            return Some(util::error(StatusCode::BAD_REQUEST, "deviceId is required"));
        };
        let address = non_empty_string(body.get("address"));
        return Some(match mutate::add_device(&state.config, &device_id, address.as_deref()) {
            Ok(()) => {
                notify(state);
                // 对端此刻可能已经连着:立刻补发配对请求与既有目录邀请,
                // 否则「先加目录后加设备」的意图要等对方重连才送达。
                if let Some(ops) = state.deps.ops() {
                    ops.after_device_trusted(&device_id);
                }
                util::json_value(StatusCode::CREATED, &json!({ "ok": true }))
            }
            Err(mutate::MutateError::Invalid(message)) => {
                util::error(StatusCode::BAD_REQUEST, &message)
            }
            Err(mutate::MutateError::Io(_)) => {
                util::error(StatusCode::BAD_REQUEST, "failed to add device")
            }
        });
    }

    // DELETE /api/devices?deviceId=xxx : 移除一个已知对端设备
    if ctx.method_is("DELETE") && path == "/api/devices" {
        let Some(device_id) = ctx.param("deviceId").filter(|value| !value.is_empty()) else {
            return Some(util::error(StatusCode::BAD_REQUEST, "deviceId is required"));
        };
        return Some(match mutate::remove_device(&state.config, &device_id) {
            Ok(()) => {
                notify(state);
                util::ok_true()
            }
            Err(error) => util::error(StatusCode::BAD_REQUEST, &error.to_string()),
        });
    }

    // POST /api/devices/upgrade : 从对端拉安装包自更新;成功后延迟优雅关闭
    if ctx.method_is("POST") && path == "/api/devices/upgrade" {
        let Some(ops) = state.deps.ops().cloned() else {
            return Some(util::error(
                StatusCode::SERVICE_UNAVAILABLE,
                "self-update not available",
            ));
        };
        let Ok(body) = ctx.json() else {
            return Some(util::json_invalid());
        };
        let Some(device_id) = non_empty_string(body.get("deviceId")) else {
            return Some(util::error(StatusCode::BAD_REQUEST, "deviceId required"));
        };
        return Some(match ops.self_update_from_device(&device_id) {
            Ok(version) => {
                // 响应先发出去,150ms 后才关:先关会把这条 HTTP 响应一起掐掉
                let shutdown_ops = ops.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                    let _ = shutdown_ops.shutdown();
                });
                util::ok(json!({ "ok": true, "version": version, "restarting": true }))
            }
            // 注意形状:这条是 `{ok:false,error}` 两键,不是通用的单 error 载荷
            Err(error) => util::json_value(
                StatusCode::BAD_REQUEST,
                &json!({ "ok": false, "error": error.message() }),
            ),
        });
    }

    // POST /api/settings : 全局设置补丁(键出现才改,值 null = 回默认)
    if ctx.method_is("POST") && path == "/api/settings" {
        let Ok(body) = ctx.json() else {
            return Some(util::json_invalid());
        };
        return Some(match body {
            Value::Object(body) => save_settings(state, &body),
            // JS 里 `'k' in [...]` 恒为假 → Node 对数组体走空补丁,回 200
            Value::Array(_) => finish_settings(state, &Map::new()),
            _ => util::error(StatusCode::BAD_REQUEST, "保存设置失败"),
        });
    }

    // POST /api/settings/webhook-test : 真发一条测试事件,同步等回执
    if ctx.method_is("POST") && path == "/api/settings/webhook-test" {
        let ops = state.deps.ops()?;
        return Some(match ops.webhook_test() {
            Ok(()) => util::ok_true(),
            Err(error) => util::error(StatusCode::BAD_REQUEST, &error.message()),
        });
    }

    // Form POST /actions : fallback UI 的无 JS 动作集合
    if ctx.method_is("POST") && path == "/actions" {
        return Some(form_action(state, ctx));
    }

    // POST /api/reconnect?deviceId=xxx : 手动重连指定对端
    if ctx.method_is("POST") && path == "/api/reconnect" {
        let Some(device_id) = ctx.param("deviceId").filter(|value| !value.is_empty()) else {
            return Some(util::error(StatusCode::BAD_REQUEST, "deviceId is required"));
        };
        let ops = state.deps.ops()?;
        return Some(match ops.reconnect(&device_id) {
            Ok(()) => util::ok_true(),
            Err(error) => util::error(StatusCode::BAD_REQUEST, &error.message()),
        });
    }

    None
}

/// JS `Number(v)`:字符串/布尔都参与转换;`NaN` 与 `±Infinity` 一律判死。
fn js_number(value: &Value) -> Option<f64> {
    let number = match value {
        Value::Number(number) => number.as_f64()?,
        Value::Bool(flag) => {
            if *flag {
                1.0
            } else {
                0.0
            }
        }
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                0.0
            } else {
                trimmed.parse::<f64>().ok()?
            }
        }
        _ => return None,
    };
    if number.is_finite() {
        Some(number)
    } else {
        None
    }
}

/// JS `String(v)`。只用于本来就被校验成字符串的键。
fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        Value::Bool(flag) => flag.to_string(),
        other => other.to_string(),
    }
}

const NUMBER_KEYS: [&str; 4] = [
    "maxSendKbps",
    "versionsPerPath",
    "historyMaxEvents",
    "batteryPauseThreshold",
];
const BOOL_KEYS: [&str; 3] = ["pauseOnMeteredNetwork", "pauseOnLowBattery", "shareEnabled"];
const TEXT_KEYS: [&str; 2] = ["webhookUrl", "webhookSecret"];

/// 逐键校验 → 归一 → 落盘。校验文案与 Node 逐字一致。
fn save_settings(state: &AppState, body: &Map<String, Value>) -> Response {
    for key in NUMBER_KEYS {
        let Some(value) = body.get(key) else { continue };
        if value.is_null() {
            continue;
        }
        if js_number(value).is_none() {
            return util::error(
                StatusCode::BAD_REQUEST,
                &format!("{key} must be a number or null"),
            );
        }
    }
    for key in BOOL_KEYS {
        let Some(value) = body.get(key) else { continue };
        if !value.is_null() && !value.is_boolean() {
            return util::error(
                StatusCode::BAD_REQUEST,
                &format!("{key} must be a boolean or null"),
            );
        }
    }
    for key in TEXT_KEYS {
        let Some(value) = body.get(key) else { continue };
        if !value.is_null() && !value.is_string() {
            return util::error(
                StatusCode::BAD_REQUEST,
                &format!("{key} must be a string or null"),
            );
        }
    }
    if let Some(value) = body.get("syncSchedule") {
        if !value.is_null() && !value.is_string() && !value.is_array() {
            return util::error(
                StatusCode::BAD_REQUEST,
                "syncSchedule must be a rule array or legacy \"HH:MM-HH:MM\" string, or null to clear",
            );
        }
    }

    let mut patch = Map::new();
    for key in NUMBER_KEYS {
        if let Some(value) = body.get(key) {
            patch.insert(
                key.to_string(),
                match (value.is_null(), js_number(value)) {
                    (true, _) => Value::Null,
                    (false, Some(number)) => json!(number),
                    // 上面已拦掉,这里只是保守兜底
                    (false, None) => Value::Null,
                },
            );
        }
    }
    for key in TEXT_KEYS {
        if let Some(value) = body.get(key) {
            patch.insert(
                key.to_string(),
                if value.is_null() {
                    Value::Null
                } else {
                    Value::String(js_string(value))
                },
            );
        }
    }
    for key in BOOL_KEYS {
        if let Some(value) = body.get(key) {
            // 布尔字段只认 true;null 保持 null(= 回默认)
            patch.insert(
                key.to_string(),
                if value.is_null() {
                    Value::Null
                } else {
                    Value::Bool(value.as_bool() == Some(true))
                },
            );
        }
    }
    if let Some(value) = body.get("syncSchedule") {
        patch.insert("syncSchedule".to_string(), value.clone());
    }
    if let Some(value) = body.get("holidayAutoFetch") {
        patch.insert(
            "holidayAutoFetch".to_string(),
            if value.is_null() {
                Value::Null
            } else {
                // 只有字面 false 才关,其余(缺省写法/true/任何非布尔)都算开
                Value::Bool(value.as_bool() != Some(false))
            },
        );
    }
    if let Some(value) = body.get("holidaySourceUrl") {
        patch.insert(
            "holidaySourceUrl".to_string(),
            if value.is_null() {
                Value::Null
            } else {
                Value::String(js_string(value))
            },
        );
    }

    finish_settings(state, &patch)
}

fn finish_settings(state: &AppState, patch: &Map<String, Value>) -> Response {
    match mutate::set_global_settings(&state.config, patch) {
        Ok(()) => {
            notify(state);
            util::ok_true()
        }
        Err(mutate::MutateError::Invalid(message)) => {
            util::error(StatusCode::BAD_REQUEST, &message)
        }
        Err(mutate::MutateError::Io(error)) => util::error(
            StatusCode::BAD_REQUEST,
            &if error.to_string().is_empty() {
                "保存设置失败".to_string()
            } else {
                error.to_string()
            },
        ),
    }
}

fn form_action(state: &AppState, ctx: &Ctx) -> Response {
    let params: std::collections::HashMap<String, String> =
        form_urlencoded::parse(ctx.body.as_slice())
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect();
    let get = |name: &str| params.get(name).map(|value| value.as_str()).unwrap_or("");

    match get("action") {
        "rescan" => {
            if let Some(ops) = state.deps.ops() {
                let _ = ops.rescan();
            }
            redirect_msg("/", "扫描已触发")
        }
        "reconnect" => {
            if let Some(ops) = state.deps.ops() {
                if !get("deviceId").is_empty() {
                    let _ = ops.reconnect(get("deviceId"));
                }
            }
            redirect_msg("/", "重连已触发")
        }
        "pause-folder" => {
            let paused = get("paused") == "1";
            if !get("folderId").is_empty() {
                let _ = mutate::set_folder_paused(&state.config, get("folderId"), paused);
                notify(state);
            }
            redirect_msg("/", if paused { "目录同步已暂停" } else { "目录同步已恢复" })
        }
        "pause-global" => {
            let paused = get("paused") == "1";
            let _ = mutate::set_global_paused(&state.config, paused);
            notify(state);
            redirect_msg("/", if paused { "已全局暂停同步" } else { "已恢复同步" })
        }
        "restore-version" | "delete-version" => {
            let folder_id = get("folderId");
            let file = get("file");
            if folder_id.is_empty() || file.is_empty() {
                return util::redirect("/");
            }
            // Node 这里无条件拼 `&msg=`,不回填 `?` —— 保持同一个 Location
            let back = if get("back").is_empty() { "/" } else { get("back") };
            let restoring = get("action") == "restore-version";
            let result = folder_by_id(state, folder_id).and_then(|folder| {
                let versions = fsops::versions_dir_for(&state.config.config_dir(), &folder);
                if restoring {
                    fsops::restore_version(&folder, &versions, file, crate::auth::now_ms())
                        .map(|_| "版本已恢复到原路径")
                } else {
                    fsops::delete_version(&versions, file).map(|_| "版本已删除")
                }
            });
            match result {
                Ok(message) => {
                    notify(state);
                    util::redirect(&format!("{back}&msg={}", encode_component(message)))
                }
                Err(message) => util::redirect(&format!("{back}&msg={}", encode_component(&message))),
            }
        }
        _ => util::redirect("/"),
    }
}

fn folder_by_id(
    state: &AppState,
    folder_id: &str,
) -> Result<crate::config::SharedFolder, String> {
    state
        .config
        .load()
        .folder(folder_id)
        .cloned()
        .ok_or_else(|| "未找到共享目录".to_string())
}

fn notify(state: &AppState) {
    if let Some(ops) = state.deps.ops() {
        ops.reload_config();
    }
}
