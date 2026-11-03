//! 目录域:目录增删、设备指派、忽略规则、同步记录、版本、冲突、回滚、空目录、git。
//!
//! 与 Node `routes/folders.ts` 逐条对齐。两类实现刻意分开:
//!
//!  * **纯文件系统/配置**动作(目录增删、各项开关、忽略规则、回收站/版本/冲突/回滚/
//!    空目录、历史与周报、日历读取)在本模块 + [`crate::fsops`] 里直接做完;
//!  * **需要活会话**的动作(materialize、diff/compare/file-pair/apply-sync、全部 git、
//!    批量重采身份、优先同步)经 `ControlOps` 注入,未注入时按 Node 的 if 条件落到
//!    404 —— 而不是 503,因为前端这些入口本来就按「有没有这个能力」决定显不显示。
//!
//! 错误文案逐字复制 Node:它们是前端直接展示的字符串。

use axum::http::StatusCode;
use axum::response::Response;
use serde_json::{json, Map, Value};

use crate::config::{Config, SharedFolder};
use crate::deps::{AppState, OpError};
use crate::fsops;
use crate::history::HistoryFilter;
use crate::ignorefile;
use crate::mutate;
use crate::report;
use crate::routes::util::{self, Ctx};

/* ==================== 小工具 ==================== */

/// 目录域统一的失败兜底:`Invalid` 原样透出,`Io` 用 Node 的兜底文案。
fn bad(error: mutate::MutateError, fallback: &str) -> Response {
    match error {
        mutate::MutateError::Invalid(message) => util::error(StatusCode::BAD_REQUEST, &message),
        mutate::MutateError::Io(error) => util::error(
            StatusCode::BAD_REQUEST,
            &if error.to_string().is_empty() {
                fallback.to_string()
            } else {
                error.to_string()
            },
        ),
    }
}

fn op_error(error: OpError, fallback: &str) -> Response {
    match error {
        OpError::Failed(message) => util::error(StatusCode::BAD_REQUEST, &message),
        OpError::Unavailable => util::error(StatusCode::BAD_REQUEST, fallback),
    }
}

fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// 取一个非空字符串字段(`typeof x !== 'string' || x === ''` 的反面)。
fn non_empty_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(|value| value.as_str())
        .filter(|text| !text.is_empty())
        .map(|text| text.to_string())
}

/// 目录 id → 配置里的目录。找不到时按 Node 的 throw → 400 处理。
#[allow(clippy::result_large_err)]
fn require_folder(state: &AppState, folder_id: &str) -> Result<SharedFolder, Response> {
    state.config.load().folder(folder_id).cloned().ok_or_else(|| {
        util::error(StatusCode::BAD_REQUEST, "共享目录不存在(可能刚被移除)")
    })
}

fn config_dir(state: &AppState) -> std::path::PathBuf {
    state.config.config_dir()
}

fn other_roots(config: &Config, folder: &SharedFolder) -> Vec<String> {
    config
        .shared_folders
        .iter()
        .filter(|other| other.folder_id() != folder.folder_id())
        .map(|other| other.path.clone())
        .collect()
}

fn folder_ignore_ruleset(folder: &SharedFolder) -> syncx_core::ignore::IgnoreRuleset {
    // 目录规则 = 内置默认 + .gitignore(按开关)+ .syncxignore,后写覆盖先写
    let root = std::path::Path::new(&folder.path);
    let user_lines = ignorefile::read_syncx_ignore_lines(root);
    let lines = ignorefile::compose_ignore_lines(root, folder.use_gitignore_enabled(), &user_lines);
    syncx_core::ignore::IgnoreRuleset::from_lines(&lines)
}

/// `limit` 查询参数:缺省/空 = 全量;非正整数 → 错误(参数打错时静默等于全量最难查)。
fn parse_history_query(ctx: &Ctx, max_events: usize) -> Result<(usize, HistoryFilter), String> {
    let mut limit = usize::MAX;
    if let Some(raw) = ctx.param("limit").filter(|raw| !raw.is_empty()) {
        let parsed: f64 = raw
            .parse()
            .map_err(|_| "limit must be a positive integer".to_string())?;
        if !parsed.is_finite() || parsed < 1.0 {
            return Err("limit must be a positive integer".to_string());
        }
        limit = (parsed.floor() as usize).min(max_events);
    }
    let direction = ctx.param("direction").filter(|raw| !raw.is_empty());
    let action = ctx.param("action").filter(|raw| !raw.is_empty());
    let mut bad: Vec<&str> = Vec::new();
    if let Some(value) = &direction {
        if value != "local" && value != "remote" {
            bad.push("direction");
        }
    }
    if let Some(value) = &action {
        if !["add", "update", "delete", "conflict"].contains(&value.as_str()) {
            bad.push("action");
        }
    }
    if !bad.is_empty() {
        return Err(format!("invalid {} parameter", bad.join(", ")));
    }
    Ok((
        limit,
        HistoryFilter {
            direction,
            device_id: ctx.param("device").filter(|raw| !raw.is_empty()),
            action,
            query: ctx.param("q").filter(|raw| !raw.is_empty()),
        },
    ))
}

/* ==================== 分发 ==================== */

pub fn try_routes(state: &AppState, ctx: &Ctx) -> Option<Response> {
    let path = ctx.path.as_str();

    // —— 表单:POST /folders(加目录 / _method=DELETE 删目录) ——
    if ctx.method_is("POST") && path == "/folders" {
        return Some(form_folders(state, ctx));
    }

    // —— POST /api/folders ——
    if ctx.method_is("POST") && path == "/api/folders" {
        let Ok(body) = ctx.json() else {
            return Some(util::error(StatusCode::BAD_REQUEST, "invalid json body"));
        };
        let Some(folder_path) = non_empty_string(body.get("path")) else {
            return Some(util::error(StatusCode::BAD_REQUEST, "path is required"));
        };
        let devices: Vec<String> = body
            .get("devices")
            .and_then(|value| value.as_array())
            .map(|list| {
                list.iter()
                    .filter_map(|item| item.as_str())
                    .map(|item| item.to_string())
                    .collect()
            })
            .unwrap_or_default();
        let id = non_empty_string(body.get("id"));
        let receive_only = body.get("receiveOnly").and_then(|value| value.as_bool()) == Some(true);
        return Some(match mutate::add_folder(
            &state.config,
            &folder_path,
            &devices,
            id.as_deref(),
            receive_only,
        ) {
            Ok(created) => {
                if let Some(ops) = state.deps.ops() {
                    ops.reload_config();
                }
                util::json_value(StatusCode::CREATED, &json!({ "ok": true, "created": created }))
            }
            Err(error) => bad(error, "invalid json body"),
        });
    }

    // —— POST /api/folders/devices ——
    if ctx.method_is("POST") && path == "/api/folders/devices" {
        let Ok(body) = ctx.json() else {
            return Some(util::error(StatusCode::BAD_REQUEST, "invalid json body"));
        };
        let Some(folder_path) = non_empty_string(body.get("path")) else {
            return Some(util::error(StatusCode::BAD_REQUEST, "path is required"));
        };
        let devices: Vec<String> = body
            .get("devices")
            .and_then(|value| value.as_array())
            .map(|list| {
                list.iter()
                    .filter_map(|item| item.as_str())
                    .map(|item| item.to_string())
                    .collect()
            })
            .unwrap_or_default();
        return Some(match mutate::set_folder_devices(&state.config, &folder_path, &devices) {
            Ok(()) => {
                notify_ops(state);
                util::ok_true()
            }
            Err(error) => bad(error, "invalid json body"),
        });
    }

    // —— POST /api/folders/gitignore ——
    if ctx.method_is("POST") && path == "/api/folders/gitignore" {
        let Ok(body) = ctx.json() else {
            return Some(util::error(StatusCode::BAD_REQUEST, "invalid json body"));
        };
        let Some(folder_path) = non_empty_string(body.get("path")) else {
            return Some(util::error(StatusCode::BAD_REQUEST, "path is required"));
        };
        let enabled = body.get("enabled").and_then(|value| value.as_bool()) != Some(false);
        return Some(match mutate::set_folder_gitignore(&state.config, &folder_path, enabled) {
            Ok(()) => {
                notify_ops(state);
                util::ok_true()
            }
            Err(error) => bad(error, "invalid json body"),
        });
    }

    // —— POST /api/folders/pause ——
    if ctx.method_is("POST") && path == "/api/folders/pause" {
        let Ok(body) = ctx.json() else {
            return Some(util::error(StatusCode::BAD_REQUEST, "invalid json body"));
        };
        let Some(folder_id) = non_empty_string(body.get("folderId")) else {
            return Some(util::error(StatusCode::BAD_REQUEST, "folderId is required"));
        };
        let paused = body.get("paused").and_then(|value| value.as_bool()) == Some(true);
        return Some(match mutate::set_folder_paused(&state.config, &folder_id, paused) {
            Ok(()) => {
                notify_ops(state);
                util::ok_true()
            }
            Err(error) => bad(error, "invalid json body"),
        });
    }

    // —— POST /api/folders/schedule ——
    if ctx.method_is("POST") && path == "/api/folders/schedule" {
        let Ok(body) = ctx.json() else {
            return Some(util::error(StatusCode::BAD_REQUEST, "invalid json body"));
        };
        let Some(folder_id) = non_empty_string(body.get("folderId")) else {
            return Some(util::error(StatusCode::BAD_REQUEST, "folderId is required"));
        };
        let schedule = body.get("schedule").cloned().unwrap_or(Value::Null);
        let acceptable = schedule.is_null()
            || schedule.is_string()
            || schedule.is_array();
        if !acceptable {
            return Some(util::error(
                StatusCode::BAD_REQUEST,
                "schedule must be a rule array (or legacy \"HH:MM-HH:MM\" string), null to clear",
            ));
        }
        let normalized = if schedule.is_null() {
            None
        } else {
            Some(schedule)
        };
        return Some(
            match mutate::set_folder_schedule(&state.config, &folder_id, normalized) {
                Ok(()) => {
                    notify_ops(state);
                    util::ok_true()
                }
                Err(error) => bad(error, "设置同步时段失败"),
            },
        );
    }

    // —— POST /api/schedule/override ——
    if ctx.method_is("POST") && path == "/api/schedule/override" {
        let Ok(body) = ctx.json() else {
            return Some(util::error(StatusCode::BAD_REQUEST, "invalid json body"));
        };
        let Some(minutes) = body.get("minutes").and_then(|value| value.as_f64()) else {
            return Some(util::error(
                StatusCode::BAD_REQUEST,
                "minutes must be a number (<= 0 to cancel)",
            ));
        };
        if !minutes.is_finite() {
            return Some(util::error(
                StatusCode::BAD_REQUEST,
                "minutes must be a number (<= 0 to cancel)",
            ));
        }
        return Some(match mutate::set_schedule_override(&state.config, minutes) {
            Ok(until) => {
                notify_ops(state);
                util::ok(json!({ "ok": true, "until": until }))
            }
            Err(error) => bad(error, "临时放行失败"),
        });
    }

    // —— POST /api/calendar/override ——
    if ctx.method_is("POST") && path == "/api/calendar/override" {
        let Ok(body) = ctx.json() else {
            return Some(util::error(StatusCode::BAD_REQUEST, "invalid json body"));
        };
        let Some(date) = body.get("date").and_then(|value| value.as_str()) else {
            return Some(util::error(
                StatusCode::BAD_REQUEST,
                "date must be a string (YYYY-MM-DD)",
            ));
        };
        let day_type = match body.get("type") {
            None | Some(Value::Null) => None,
            Some(Value::String(text)) if text == "workday" || text == "holiday" => Some(text.as_str()),
            Some(_) => {
                return Some(util::error(
                    StatusCode::BAD_REQUEST,
                    "type must be 'workday' | 'holiday' | null",
                ))
            }
        };
        return Some(match mutate::set_calendar_override(&state.config, date, day_type) {
            Ok(()) => {
                notify_ops(state);
                util::ok_true()
            }
            Err(error) => bad(error, "日历覆盖失败"),
        });
    }

    // —— GET /api/calendar ——
    if ctx.method_is("GET") && path == "/api/calendar" {
        let year = match ctx.param("year").filter(|raw| !raw.is_empty()) {
            None => {
                use chrono::Datelike;
                chrono::Local::now().year()
            }
            Some(raw) => match raw.parse::<i32>() {
                Ok(year) if (1970..=2100).contains(&year) => year,
                _ => {
                    return Some(util::error(
                        StatusCode::BAD_REQUEST,
                        "year must be an integer between 1970 and 2100",
                    ))
                }
            },
        };
        let overrides = state.config.load().calendar_overrides.unwrap_or_default();
        return Some(util::ok(crate::calendar::calendar_payload(
            &config_dir(state),
            year,
            &overrides,
        )));
    }

    // —— POST /api/folders/git-sync ——
    if ctx.method_is("POST") && path == "/api/folders/git-sync" {
        let Ok(body) = ctx.json() else {
            return Some(util::error(StatusCode::BAD_REQUEST, "invalid json body"));
        };
        let Some(folder_id) = non_empty_string(body.get("folderId")) else {
            return Some(util::error(StatusCode::BAD_REQUEST, "folderId is required"));
        };
        let mode = body.get("mode").and_then(|value| value.as_str()).unwrap_or("");
        if !["off", "send", "receive", "full"].contains(&mode) {
            return Some(util::error(
                StatusCode::BAD_REQUEST,
                "mode must be one of: off, send, receive, full",
            ));
        }
        return Some(
            match mutate::set_folder_git_sync(&state.config, &folder_id, mode) {
                Ok(()) => {
                    notify_ops(state);
                    util::ok_true()
                }
                Err(error) => bad(error, "设置 git 同步模式失败"),
            },
        );
    }

    // —— POST /api/folders/conflict-policy ——
    if ctx.method_is("POST") && path == "/api/folders/conflict-policy" {
        let Ok(body) = ctx.json() else {
            return Some(util::error(StatusCode::BAD_REQUEST, "invalid json body"));
        };
        let Some(folder_id) = non_empty_string(body.get("folderId")) else {
            return Some(util::error(StatusCode::BAD_REQUEST, "folderId is required"));
        };
        let policy = body
            .get("policy")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        if !["keep-both", "newest-wins", "local-wins"].contains(&policy) {
            return Some(util::error(
                StatusCode::BAD_REQUEST,
                "policy must be one of: keep-both, newest-wins, local-wins",
            ));
        }
        return Some(
            match mutate::set_folder_conflict_policy(&state.config, &folder_id, policy) {
                Ok(()) => {
                    notify_ops(state);
                    util::ok_true()
                }
                Err(error) => bad(error, "设置冲突策略失败"),
            },
        );
    }

    // —— POST /api/folders/git-strip-co-authored ——
    if ctx.method_is("POST") && path == "/api/folders/git-strip-co-authored" {
        let Ok(body) = ctx.json() else {
            return Some(util::error(StatusCode::BAD_REQUEST, "invalid json body"));
        };
        let Some(folder_id) = non_empty_string(body.get("folderId")) else {
            return Some(util::error(StatusCode::BAD_REQUEST, "folderId is required"));
        };
        let Some(on) = body.get("on").and_then(|value| value.as_bool()) else {
            return Some(util::error(
                StatusCode::BAD_REQUEST,
                "on must be a boolean",
            ));
        };
        return Some(
            match mutate::set_folder_git_strip_co_authored(&state.config, &folder_id, on) {
                Ok(()) => {
                    notify_ops(state);
                    util::ok_true()
                }
                Err(error) => bad(error, "设置剔除 Co-Authored-By 失败"),
            },
        );
    }

    // —— POST /api/folders/e2e ——
    if ctx.method_is("POST") && path == "/api/folders/e2e" {
        let Ok(body) = ctx.json() else {
            return Some(util::error(StatusCode::BAD_REQUEST, "invalid json body"));
        };
        let Some(folder_id) = non_empty_string(body.get("folderId")) else {
            return Some(util::error(StatusCode::BAD_REQUEST, "folderId is required"));
        };
        let mut passphrase: Option<Option<String>> = None;
        if let Some(value) = body.get("passphrase") {
            match value {
                Value::Null => passphrase = Some(None),
                Value::String(text) => passphrase = Some(Some(text.clone())),
                _ => {
                    return Some(util::error(
                        StatusCode::BAD_REQUEST,
                        "passphrase must be a string or null",
                    ))
                }
            }
        }
        let mut untrusted: Option<Option<Vec<String>>> = None;
        if let Some(value) = body.get("untrusted") {
            match value {
                Value::Null => untrusted = Some(None),
                Value::Array(items) => {
                    let mut ids = Vec::with_capacity(items.len());
                    for item in items {
                        match item.as_str() {
                            Some(id) => ids.push(id.to_string()),
                            None => {
                                return Some(util::error(
                                    StatusCode::BAD_REQUEST,
                                    "untrusted must be an array of device ids or null",
                                ))
                            }
                        }
                    }
                    untrusted = Some(Some(ids));
                }
                _ => {
                    return Some(util::error(
                        StatusCode::BAD_REQUEST,
                        "untrusted must be an array of device ids or null",
                    ))
                }
            }
        }
        return Some(
            match mutate::set_folder_e2e(
                &state.config,
                &folder_id,
                passphrase.as_ref().map(|value| value.as_deref()),
                untrusted.clone(),
            ) {
                Ok(()) => {
                    notify_ops(state);
                    util::ok_true()
                }
                Err(error) => bad(error, "设置端到端加密失败"),
            },
        );
    }

    // —— POST /api/folders/on-demand ——
    if ctx.method_is("POST") && path == "/api/folders/on-demand" {
        let Ok(body) = ctx.json() else {
            return Some(util::error(StatusCode::BAD_REQUEST, "invalid json body"));
        };
        let Some(folder_id) = non_empty_string(body.get("folderId")) else {
            return Some(util::error(StatusCode::BAD_REQUEST, "folderId is required"));
        };
        let Some(on) = body.get("onDemand").and_then(|value| value.as_bool()) else {
            return Some(util::error(StatusCode::BAD_REQUEST, "onDemand must be a boolean"));
        };
        return Some(match mutate::set_folder_on_demand(&state.config, &folder_id, on) {
            Ok(()) => {
                notify_ops(state);
                util::ok_true()
            }
            Err(error) => bad(error, "设置按需同步失败"),
        });
    }

    // —— POST /api/folders/on-demand-dir ——
    if ctx.method_is("POST") && path == "/api/folders/on-demand-dir" {
        let Ok(body) = ctx.json() else {
            return Some(util::error(StatusCode::BAD_REQUEST, "invalid json body"));
        };
        let Some(folder_id) = non_empty_string(body.get("folderId")) else {
            return Some(util::error(StatusCode::BAD_REQUEST, "folderId is required"));
        };
        let Some(rel_path) = non_empty_string(body.get("path")) else {
            return Some(util::error(StatusCode::BAD_REQUEST, "path is required"));
        };
        let Some(on) = body.get("onDemand").and_then(|value| value.as_bool()) else {
            return Some(util::error(StatusCode::BAD_REQUEST, "onDemand must be a boolean"));
        };
        return Some(
            match mutate::set_folder_on_demand_dir(&state.config, &folder_id, &rel_path, on) {
                Ok(()) => {
                    notify_ops(state);
                    util::ok_true()
                }
                Err(error) => bad(error, "设置子目录按需失败"),
            },
        );
    }

    // —— POST /api/folders/materialize ——
    if ctx.method_is("POST") && path == "/api/folders/materialize" {
        let Ok(body) = ctx.json() else {
            return Some(util::error(StatusCode::BAD_REQUEST, "invalid json body"));
        };
        let Some(folder_id) = non_empty_string(body.get("folderId")) else {
            return Some(util::error(StatusCode::BAD_REQUEST, "folderId is required"));
        };
        let Some(rel_path) = non_empty_string(body.get("path")) else {
            return Some(util::error(StatusCode::BAD_REQUEST, "path is required"));
        };
        let ops = state.deps.ops()?;
        return Some(match ops.materialize(&folder_id, &rel_path) {
            Ok(()) => util::ok_true(),
            Err(error) => op_error(error, "下载请求失败"),
        });
    }

    // —— POST /api/folders/pause-file ——
    if ctx.method_is("POST") && path == "/api/folders/pause-file" {
        let Ok(body) = ctx.json() else {
            return Some(util::error(StatusCode::BAD_REQUEST, "invalid json body"));
        };
        let Some(folder_id) = non_empty_string(body.get("folderId")) else {
            return Some(util::error(StatusCode::BAD_REQUEST, "folderId is required"));
        };
        let Some(rel_path) = non_empty_string(body.get("path")) else {
            return Some(util::error(StatusCode::BAD_REQUEST, "path is required"));
        };
        let Some(paused) = body.get("paused").and_then(|value| value.as_bool()) else {
            return Some(util::error(StatusCode::BAD_REQUEST, "paused must be a boolean"));
        };
        return Some(
            match mutate::set_folder_paused_file(&state.config, &folder_id, &rel_path, paused) {
                Ok(()) => {
                    notify_ops(state);
                    util::ok_true()
                }
                Err(error) => bad(error, "设置单文件暂停失败"),
            },
        );
    }

    // —— POST /api/folders/prioritize ——
    if ctx.method_is("POST") && path == "/api/folders/prioritize" {
        let Ok(body) = ctx.json() else {
            return Some(util::error(StatusCode::BAD_REQUEST, "invalid json body"));
        };
        let Some(folder_id) = non_empty_string(body.get("folderId")) else {
            return Some(util::error(StatusCode::BAD_REQUEST, "folderId is required"));
        };
        let Some(rel_path) = non_empty_string(body.get("path")) else {
            return Some(util::error(StatusCode::BAD_REQUEST, "path is required"));
        };
        let ops = state.deps.ops()?;
        return Some(match ops.prioritize_transfer(&folder_id, &rel_path) {
            Ok(()) => util::ok_true(),
            Err(error) => op_error(error, "优先同步请求失败"),
        });
    }

    // —— 忽略规则编辑器 ——
    if ctx.method_is("GET") && path == "/api/folders/ignore" {
        let Some(folder_id) = ctx.param("folderId").filter(|raw| !raw.is_empty()) else {
            return Some(util::error(StatusCode::BAD_REQUEST, "folderId is required"));
        };
        return Some(match require_folder(state, &folder_id) {
            Ok(folder) => util::ok(ignorefile::ignore_info(
                std::path::Path::new(&folder.path),
                folder.use_gitignore_enabled(),
            )),
            Err(response) => response,
        });
    }
    if ctx.method_is("POST") && path == "/api/folders/ignore" {
        let Ok(body) = ctx.json() else {
            return Some(util::error(StatusCode::BAD_REQUEST, "invalid json body"));
        };
        let Some(folder_id) = non_empty_string(body.get("folderId")) else {
            return Some(util::error(StatusCode::BAD_REQUEST, "folderId is required"));
        };
        let Some(lines) = body.get("lines").and_then(|value| value.as_array()) else {
            return Some(util::error(
                StatusCode::BAD_REQUEST,
                "lines must be an array of strings",
            ));
        };
        let mut owned = Vec::with_capacity(lines.len());
        for line in lines {
            match line.as_str() {
                Some(text) => owned.push(text.to_string()),
                None => {
                    return Some(util::error(
                        StatusCode::BAD_REQUEST,
                        "lines must be an array of strings",
                    ))
                }
            }
        }
        let folder = match require_folder(state, &folder_id) {
            Ok(folder) => folder,
            Err(response) => return Some(response),
        };
        if let Err(message) = ignorefile::validate_ignore_lines(&owned) {
            return Some(util::error(StatusCode::BAD_REQUEST, &message));
        }
        if let Err(error) = ignorefile::write_syncx_ignore_lines(std::path::Path::new(&folder.path), &owned)
        {
            return Some(util::error(StatusCode::BAD_REQUEST, &error.to_string()));
        }
        // 规则变了,索引要按新规则重建 / 补扫 —— 这一步只有装配层能做
        if let Some(ops) = state.deps.ops() {
            ops.reload_config();
            let _ = ops.rescan();
        }
        return Some(util::ok_true());
    }
    if ctx.method_is("POST") && path == "/api/folders/ignore/test" {
        let Ok(body) = ctx.json() else {
            return Some(util::error(StatusCode::BAD_REQUEST, "invalid json body"));
        };
        let Some(folder_id) = non_empty_string(body.get("folderId")) else {
            return Some(util::error(StatusCode::BAD_REQUEST, "folderId is required"));
        };
        let Some(rel_path) = non_empty_string(body.get("path")) else {
            return Some(util::error(StatusCode::BAD_REQUEST, "path is required"));
        };
        let draft: Option<Vec<String>> = match body.get("lines") {
            None => None,
            Some(Value::Array(items)) => {
                let mut owned = Vec::with_capacity(items.len());
                for item in items {
                    match item.as_str() {
                        Some(text) => owned.push(text.to_string()),
                        None => {
                            return Some(util::error(
                                StatusCode::BAD_REQUEST,
                                "lines must be an array of strings",
                            ))
                        }
                    }
                }
                Some(owned)
            }
            Some(_) => {
                return Some(util::error(
                    StatusCode::BAD_REQUEST,
                    "lines must be an array of strings",
                ))
            }
        };
        let folder = match require_folder(state, &folder_id) {
            Ok(folder) => folder,
            Err(response) => return Some(response),
        };
        return Some(
            match ignorefile::test_ignore(
                std::path::Path::new(&folder.path),
                folder.use_gitignore_enabled(),
                &rel_path,
                draft.as_deref(),
            ) {
                Ok(verdict) => util::ok(serde_json::to_value(verdict).unwrap_or(Value::Null)),
                Err(message) => util::error(StatusCode::BAD_REQUEST, &message),
            },
        );
    }

    // —— POST /api/folders/re-adopt-identity ——
    if ctx.method_is("POST") && path == "/api/folders/re-adopt-identity" {
        let Ok(body) = ctx.json() else {
            return Some(util::error(StatusCode::BAD_REQUEST, "invalid json body"));
        };
        let Some(folder_id) = non_empty_string(body.get("folderId")) else {
            return Some(util::error(StatusCode::BAD_REQUEST, "folderId is required"));
        };
        return Some(match mutate::re_adopt_folder_identity(&state.config, &folder_id) {
            Ok(_) => {
                notify_ops(state);
                util::ok_true()
            }
            Err(error) => bad(error, "采集身份失败"),
        });
    }

    // —— POST /api/folders/re-adopt-identity-all ——
    if ctx.method_is("POST") && path == "/api/folders/re-adopt-identity-all" {
        return Some(match re_adopt_all(state) {
            Ok(payload) => util::ok(payload),
            Err(error) => util::error(StatusCode::BAD_REQUEST, &error),
        });
    }

    // —— 同步记录 / 周报 / 全局时间线 ——
    if ctx.method_is("GET") && path == "/api/folders/history" {
        let Some(folder_id) = ctx.param("folderId").filter(|raw| !raw.is_empty()) else {
            return Some(util::error(StatusCode::BAD_REQUEST, "folderId is required"));
        };
        let (limit, filter) = match parse_history_query(ctx, state.history.max_events()) {
            Ok(parsed) => parsed,
            Err(message) => return Some(util::error(StatusCode::BAD_REQUEST, &message)),
        };
        let result = state.history.query(&folder_id, limit, &filter);
        return Some(util::ok(serde_json::to_value(result).unwrap_or(Value::Null)));
    }
    if ctx.method_is("POST") && path == "/api/folders/history/clear" {
        let Ok(body) = ctx.json() else {
            return Some(util::error(StatusCode::BAD_REQUEST, "invalid json body"));
        };
        let Some(folder_id) = non_empty_string(body.get("folderId")) else {
            return Some(util::error(StatusCode::BAD_REQUEST, "folderId is required"));
        };
        return Some(match state.history.clear(&folder_id) {
            Ok(()) => util::ok_true(),
            Err(error) => util::error(StatusCode::BAD_REQUEST, &error.to_string()),
        });
    }
    if ctx.method_is("GET") && path == "/api/report/weekly" {
        let config = state.config.load();
        let folders = folder_pairs(&config);
        return Some(util::ok(report::collect(
            &state.history,
            &folders,
            crate::auth::now_ms(),
        )));
    }
    if ctx.method_is("GET") && path == "/api/history" {
        let (limit, filter) = match parse_history_query(ctx, state.history.max_events()) {
            Ok(parsed) => parsed,
            Err(message) => return Some(util::error(StatusCode::BAD_REQUEST, &message)),
        };
        let config = state.config.load();
        let folders = folder_pairs(&config);
        let result = state.history.query_global(&folders, limit, &filter);
        return Some(util::ok(serde_json::to_value(result).unwrap_or(Value::Null)));
    }
    if ctx.method_is("GET") && path == "/history" {
        return Some(history_page(state));
    }

    // —— 版本 ——
    if ctx.method_is("GET") && path == "/versions" {
        return Some(versions_page(state, ctx));
    }
    if ctx.method_is("GET") && path == "/api/folders/versions" {
        let Some(folder_id) = ctx.param("folderId").filter(|raw| !raw.is_empty()) else {
            return Some(util::error(StatusCode::BAD_REQUEST, "folderId is required"));
        };
        let folder = match require_folder(state, &folder_id) {
            Ok(folder) => folder,
            Err(response) => return Some(response),
        };
        let dir = fsops::versions_dir_for(&config_dir(state), &folder);
        return Some(util::ok(fsops::list_versions(&dir)));
    }
    if ctx.method_is("POST") && path == "/api/folders/versions/restore" {
        let Ok(body) = ctx.json() else {
            return Some(util::error(StatusCode::BAD_REQUEST, "invalid json body"));
        };
        let Some(folder_id) = non_empty_string(body.get("folderId")) else {
            return Some(util::error(
                StatusCode::BAD_REQUEST,
                "folderId and file are required",
            ));
        };
        let Some(file) = non_empty_string(body.get("file")) else {
            return Some(util::error(
                StatusCode::BAD_REQUEST,
                "folderId and file are required",
            ));
        };
        let folder = match require_folder(state, &folder_id) {
            Ok(folder) => folder,
            Err(response) => return Some(response),
        };
        let dir = fsops::versions_dir_for(&config_dir(state), &folder);
        return Some(
            match fsops::restore_version(&folder, &dir, &file, crate::auth::now_ms()) {
                Ok(()) => {
                    notify_ops(state);
                    util::ok_true()
                }
                Err(message) => util::error(StatusCode::BAD_REQUEST, &message),
            },
        );
    }
    if ctx.method_is("POST") && path == "/api/folders/versions/delete" {
        let Ok(body) = ctx.json() else {
            return Some(util::error(StatusCode::BAD_REQUEST, "invalid json body"));
        };
        let Some(folder_id) = non_empty_string(body.get("folderId")) else {
            return Some(util::error(
                StatusCode::BAD_REQUEST,
                "folderId and file are required",
            ));
        };
        let Some(file) = non_empty_string(body.get("file")) else {
            return Some(util::error(
                StatusCode::BAD_REQUEST,
                "folderId and file are required",
            ));
        };
        let folder = match require_folder(state, &folder_id) {
            Ok(folder) => folder,
            Err(response) => return Some(response),
        };
        let dir = fsops::versions_dir_for(&config_dir(state), &folder);
        return Some(match fsops::delete_version(&dir, &file) {
            Ok(()) => util::ok_true(),
            Err(message) => util::error(StatusCode::BAD_REQUEST, &message),
        });
    }
    if ctx.method_is("GET") && path == "/api/folders/versions/content" {
        let (Some(folder_id), Some(file)) = (
            ctx.param("folderId").filter(|raw| !raw.is_empty()),
            ctx.param("file").filter(|raw| !raw.is_empty()),
        ) else {
            return Some(util::error(
                StatusCode::BAD_REQUEST,
                "folderId and file are required",
            ));
        };
        let folder = match require_folder(state, &folder_id) {
            Ok(folder) => folder,
            Err(response) => return Some(response),
        };
        let dir = fsops::versions_dir_for(&config_dir(state), &folder);
        return Some(match fsops::version_content(&dir, &file) {
            Ok(value) => util::ok(value),
            Err(message) => util::error(StatusCode::BAD_REQUEST, &message),
        });
    }

    // —— 回滚(时间机器) ——
    if ctx.method_is("POST") && path == "/api/folders/rollback" {
        let Ok(body) = ctx.json() else {
            return Some(util::error(StatusCode::BAD_REQUEST, "invalid json body"));
        };
        let Some(folder_id) = non_empty_string(body.get("folderId")) else {
            return Some(util::error(StatusCode::BAD_REQUEST, "folderId is required"));
        };
        let Some(ts) = body.get("ts").and_then(|value| value.as_f64()) else {
            return Some(util::error(
                StatusCode::BAD_REQUEST,
                "ts must be a positive number (ms)",
            ));
        };
        if !ts.is_finite() || ts <= 0.0 {
            return Some(util::error(
                StatusCode::BAD_REQUEST,
                "ts must be a positive number (ms)",
            ));
        }
        let now = crate::auth::now_ms();
        if ts > (now + 60_000) as f64 {
            return Some(util::error(
                StatusCode::BAD_REQUEST,
                "目标时间不能晚于现在",
            ));
        }
        let dry_run = body.get("dryRun").and_then(|value| value.as_bool()) != Some(false);
        let folder = match require_folder(state, &folder_id) {
            Ok(folder) => folder,
            Err(response) => return Some(response),
        };
        return Some(
            match fsops::rollback_folder(
                &folder,
                &config_dir(state),
                &state.history,
                ts as i64,
                dry_run,
                now,
            ) {
                Ok(value) => {
                    if !dry_run {
                        notify_ops(state);
                    }
                    util::ok(value)
                }
                Err(message) => util::error(StatusCode::BAD_REQUEST, &message),
            },
        );
    }

    // —— 对端对比(需要活会话) ——
    if ctx.method_is("GET") && (path == "/api/folders/diff" || path == "/api/folders/compare") {
        let (Some(folder_id), Some(device)) = (
            ctx.param("folderId").filter(|raw| !raw.is_empty()),
            ctx.param("device").filter(|raw| !raw.is_empty()),
        ) else {
            return Some(util::error(
                StatusCode::BAD_REQUEST,
                "folderId and device are required",
            ));
        };
        let ops = state.deps.ops()?;
        let result = if path == "/api/folders/diff" {
            ops.diff_folder(&folder_id, &device)
        } else {
            ops.compare_folder(&folder_id, &device)
        };
        return Some(match result {
            Ok(value) => util::ok(value),
            Err(error) => op_error(error, "对比失败"),
        });
    }
    if ctx.method_is("GET") && path == "/api/folders/file" {
        let (Some(folder_id), Some(device), Some(rel_path)) = (
            ctx.param("folderId").filter(|raw| !raw.is_empty()),
            ctx.param("device").filter(|raw| !raw.is_empty()),
            ctx.param("path").filter(|raw| !raw.is_empty()),
        ) else {
            return Some(util::error(
                StatusCode::BAD_REQUEST,
                "folderId, device and path are required",
            ));
        };
        let ops = state.deps.ops()?;
        return Some(match ops.read_file_pair(&folder_id, &device, &rel_path) {
            Ok(value) => util::ok(value),
            Err(error) => op_error(error, "读取文件失败"),
        });
    }
    if ctx.method_is("POST") && path == "/api/folders/file/sync" {
        let Ok(body) = ctx.json() else {
            return Some(util::error(StatusCode::BAD_REQUEST, "invalid json body"));
        };
        let (Some(folder_id), Some(device), Some(rel_path)) = (
            non_empty_string(body.get("folderId")),
            non_empty_string(body.get("device")),
            non_empty_string(body.get("path")),
        ) else {
            return Some(util::error(
                StatusCode::BAD_REQUEST,
                "folderId, device and path are required",
            ));
        };
        let direction = body
            .get("direction")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        if direction != "pull" && direction != "push" {
            return Some(util::error(
                StatusCode::BAD_REQUEST,
                "direction must be 'pull' or 'push'",
            ));
        }
        let content = body
            .get("content")
            .and_then(|value| value.as_str())
            .map(|text| text.to_string());
        let ops = state.deps.ops()?;
        return Some(
            match ops.apply_file_sync(&folder_id, &device, &rel_path, direction, content) {
                Ok(()) => util::ok_true(),
                Err(error) => op_error(error, "同步失败"),
            },
        );
    }

    // —— 冲突收件箱 ——
    if ctx.method_is("GET") && path == "/api/folders/conflicts" {
        let Some(folder_id) = ctx.param("folderId").filter(|raw| !raw.is_empty()) else {
            return Some(util::error(StatusCode::BAD_REQUEST, "folderId is required"));
        };
        let folder = match require_folder(state, &folder_id) {
            Ok(folder) => folder,
            Err(response) => return Some(response),
        };
        return Some(match fsops::root_of(&folder) {
            Ok(root) => util::ok(fsops::list_conflicts(&root)),
            Err(message) => util::error(StatusCode::BAD_REQUEST, &message),
        });
    }
    if ctx.method_is("POST") && path == "/api/folders/conflicts/resolve" {
        let Ok(body) = ctx.json() else {
            return Some(util::error(StatusCode::BAD_REQUEST, "invalid json body"));
        };
        let Some(folder_id) = non_empty_string(body.get("folderId")) else {
            return Some(util::error(StatusCode::BAD_REQUEST, "folderId is required"));
        };
        let Some(copy_path) = non_empty_string(body.get("copyPath")) else {
            return Some(util::error(StatusCode::BAD_REQUEST, "copyPath is required"));
        };
        let choice = body.get("choice").and_then(|value| value.as_str()).unwrap_or("");
        if choice != "keep-local" && choice != "discard" {
            return Some(util::error(
                StatusCode::BAD_REQUEST,
                "choice must be keep-local or discard",
            ));
        }
        let folder = match require_folder(state, &folder_id) {
            Ok(folder) => folder,
            Err(response) => return Some(response),
        };
        let result = (|| -> Result<(), String> {
            let root = fsops::root_of(&folder)?;
            let cdir = config_dir(state);
            let trash = fsops::trash_dir_for(&cdir, &folder);
            let versions = fsops::versions_dir_for(&cdir, &folder);
            fsops::resolve_conflict(
                &root,
                &trash,
                Some(&versions),
                &copy_path,
                choice,
                crate::auth::now_ms(),
            )
        })();
        return Some(match result {
            Ok(()) => {
                // 盘面变了:沿正常同步路径广播出去,让对端收敛
                notify_ops(state);
                util::ok_true()
            }
            Err(message) => util::error(StatusCode::BAD_REQUEST, &message),
        });
    }
    if ctx.method_is("GET") && path == "/api/folders/conflicts/diff" {
        let (Some(folder_id), Some(copy_path)) = (
            ctx.param("folderId").filter(|raw| !raw.is_empty()),
            ctx.param("copyPath").filter(|raw| !raw.is_empty()),
        ) else {
            return Some(util::error(
                StatusCode::BAD_REQUEST,
                "folderId and copyPath are required",
            ));
        };
        let ops = state.deps.ops()?;
        return Some(match ops.read_file_pair(&folder_id, "", &copy_path) {
            Ok(value) => util::ok(value),
            Err(error) => op_error(error, "读取对比失败"),
        });
    }
    if ctx.method_is("POST") && path == "/api/folders/conflicts/merge" {
        let Ok(body) = ctx.json() else {
            return Some(util::error(StatusCode::BAD_REQUEST, "invalid json body"));
        };
        let Some(folder_id) = non_empty_string(body.get("folderId")) else {
            return Some(util::error(StatusCode::BAD_REQUEST, "folderId is required"));
        };
        let Some(copy_path) = non_empty_string(body.get("copyPath")) else {
            return Some(util::error(StatusCode::BAD_REQUEST, "copyPath is required"));
        };
        let Some(content) = body.get("content").and_then(|value| value.as_str()) else {
            return Some(util::error(StatusCode::BAD_REQUEST, "content is required"));
        };
        let folder = match require_folder(state, &folder_id) {
            Ok(folder) => folder,
            Err(response) => return Some(response),
        };
        let result = (|| -> Result<(), String> {
            let root = fsops::root_of(&folder)?;
            let versions = fsops::versions_dir_for(&config_dir(state), &folder);
            fsops::merge_conflict(&root, Some(&versions), &copy_path, content, crate::auth::now_ms())
        })();
        return Some(match result {
            Ok(()) => {
                notify_ops(state);
                util::ok_true()
            }
            Err(message) => util::error(StatusCode::BAD_REQUEST, &message),
        });
    }
    if ctx.method_is("POST") && path == "/api/folders/conflicts/clean-identical" {
        let Ok(body) = ctx.json() else {
            return Some(util::error(StatusCode::BAD_REQUEST, "invalid json body"));
        };
        let Some(folder_id) = non_empty_string(body.get("folderId")) else {
            return Some(util::error(StatusCode::BAD_REQUEST, "folderId is required"));
        };
        let folder = match require_folder(state, &folder_id) {
            Ok(folder) => folder,
            Err(response) => return Some(response),
        };
        let result = (|| -> Result<usize, String> {
            let root = fsops::root_of(&folder)?;
            let cdir = config_dir(state);
            let trash = fsops::trash_dir_for(&cdir, &folder);
            let versions = fsops::versions_dir_for(&cdir, &folder);
            Ok(fsops::clean_identical_conflicts(
                &root,
                &trash,
                Some(&versions),
                crate::auth::now_ms(),
            ))
        })();
        return Some(match result {
            Ok(removed) => {
                if removed > 0 {
                    notify_ops(state);
                }
                util::ok(json!({ "removed": removed }))
            }
            Err(message) => util::error(StatusCode::BAD_REQUEST, &message),
        });
    }

    // —— git(全部需要活会话) ——
    if let Some(response) = git_routes(state, ctx) {
        return Some(response);
    }

    // —— 空目录 ——
    if ctx.method_is("GET") && path == "/api/folders/empty-dirs" {
        let Some(folder_id) = ctx.param("folderId").filter(|raw| !raw.is_empty()) else {
            return Some(util::error(StatusCode::BAD_REQUEST, "folderId is required"));
        };
        let config = state.config.load();
        let folder = match require_folder(state, &folder_id) {
            Ok(folder) => folder,
            Err(response) => return Some(response),
        };
        let rules = folder_ignore_ruleset(&folder);
        let nested = other_roots(&config, &folder);
        return Some(util::ok(fsops::scan_empty_dirs(
            std::path::Path::new(&folder.path),
            &rules,
            &nested,
            2000,
        )));
    }
    if ctx.method_is("POST") && path == "/api/folders/empty-dirs/delete" {
        let Ok(body) = ctx.json() else {
            return Some(util::error(StatusCode::BAD_REQUEST, "invalid json body"));
        };
        let Some(folder_id) = non_empty_string(body.get("folderId")) else {
            return Some(util::error(StatusCode::BAD_REQUEST, "folderId is required"));
        };
        let paths: Option<Vec<String>> = body.get("paths").and_then(|value| value.as_array()).map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .filter(|text| !text.is_empty())
                .map(|text| text.to_string())
                .collect()
        });
        let Some(paths) = paths else {
            return Some(util::error(
                StatusCode::BAD_REQUEST,
                "paths must be a non-empty string array",
            ));
        };
        if paths.is_empty() {
            return Some(util::error(
                StatusCode::BAD_REQUEST,
                "paths must be a non-empty string array",
            ));
        }
        if paths.len() > 2000 {
            return Some(util::error(
                StatusCode::BAD_REQUEST,
                "too many paths (max 2000)",
            ));
        }
        let config = state.config.load();
        let folder = match require_folder(state, &folder_id) {
            Ok(folder) => folder,
            Err(response) => return Some(response),
        };
        let rules = folder_ignore_ruleset(&folder);
        let nested = other_roots(&config, &folder);
        return Some(util::ok(fsops::remove_empty_dirs(
            std::path::Path::new(&folder.path),
            &paths,
            &rules,
            &nested,
        )));
    }

    // —— DELETE /api/folders ——
    if ctx.method_is("DELETE") && path == "/api/folders" {
        let Some(folder_path) = ctx.param("path").filter(|raw| !raw.is_empty()) else {
            return Some(util::error(StatusCode::BAD_REQUEST, "path is required"));
        };
        let purge = ctx.param("purgeIndex").as_deref() == Some("1");
        return Some(match mutate::remove_folder(&state.config, &folder_path, purge) {
            Ok(()) => {
                notify_ops(state);
                util::ok_true()
            }
            Err(error) => bad(error, "invalid json body"),
        });
    }

    None
}

/* ==================== 表单与页面 ==================== */

fn form_folders(state: &AppState, ctx: &Ctx) -> Response {
    let params: std::collections::HashMap<String, String> =
        form_urlencoded::parse(ctx.body.as_slice())
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect();

    if params.get("_method").map(|value| value.as_str()) == Some("DELETE") {
        if let Some(folder_path) = params.get("path").filter(|path| !path.is_empty()) {
            let purge = params.get("purgeIndex").map(|value| value.as_str()) == Some("1");
            let _ = mutate::remove_folder(&state.config, folder_path, purge);
            notify_ops(state);
        }
        return util::redirect("/");
    }

    let devices: Vec<String> = params
        .get("devices")
        .map(|raw| {
            raw.split(',')
                .map(|item| item.trim().to_string())
                .filter(|item| !item.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let receive_only = matches!(
        params.get("receiveOnly").map(|value| value.as_str()),
        Some("1") | Some("true")
    );
    let folder_path = params.get("path").cloned().unwrap_or_default();
    if folder_path.is_empty() {
        return util::error(StatusCode::BAD_REQUEST, "path is required");
    }
    match mutate::add_folder(&state.config, &folder_path, &devices, None, receive_only) {
        Ok(_) => {
            notify_ops(state);
            util::redirect("/?msg=shared folder added")
        }
        // Node 侧表单路径不接错误(只重定向);这里仍回 400 让 CLI 用法能看出问题,
        // 但保持重定向语义对浏览器更友好 —— 故与 Node 一致:失败也重定向。
        Err(_) => util::redirect("/"),
    }
}

fn folder_pairs(config: &Config) -> Vec<(String, String)> {
    config
        .shared_folders
        .iter()
        .map(|folder| (folder.folder_id(), folder.path.clone()))
        .collect()
}

/// 批量重采身份:只处理校验失败的目录,`missing` 逐条如实拒绝。
fn re_adopt_all(state: &AppState) -> Result<Value, String> {
    let config = state.config.load();
    let mut results: Vec<Value> = Vec::new();
    let mut updated = 0usize;
    for folder in &config.shared_folders {
        let verdict = mutate::folder_identity_verdict(folder);
        if verdict != "changed" && verdict != "remounted" {
            continue;
        }
        match mutate::re_adopt_folder_identity(&state.config, &folder.folder_id()) {
            Ok(identity) => {
                updated += 1;
                results.push(json!({
                    "folderId": folder.folder_id(),
                    "ok": true,
                    "identity": identity,
                }));
            }
            Err(error) => results.push(json!({
                "folderId": folder.folder_id(),
                "ok": false,
                "error": error.to_string(),
            })),
        }
    }
    if updated > 0 {
        notify_ops(state);
    }
    Ok(json!({ "ok": true, "updated": updated, "results": results }))
}

fn notify_ops(state: &AppState) {
    if let Some(ops) = state.deps.ops() {
        ops.reload_config();
    }
}

fn git_routes(state: &AppState, ctx: &Ctx) -> Option<Response> {
    let path = ctx.path.as_str();
    if !path.starts_with("/api/folders/git-") {
        return None;
    }
    let ops = state.deps.ops()?.clone();

    // 只读查询:缺 folderId 一律 400
    let query_folder = |state: &AppState| -> Option<(String, Config)> {
        ctx.param("folderId")
            .filter(|raw| !raw.is_empty())
            .map(|id| (id, state.config.load()))
    };

    match (ctx.method.as_str(), path) {
        ("GET", "/api/folders/git-changes") => {
            let (folder_id, _) = query_folder(state)?;
            Some(match ops.git_changes(&folder_id) {
                Ok(Value::Null) => util::ok(json!({ "gitRepo": false })),
                Ok(value) => util::ok(value),
                Err(error) => op_error(error, "读取改动清单失败"),
            })
        }
        ("GET", "/api/folders/git-diff") => {
            let (folder_id, _) = query_folder(state)?;
            let rel_path = ctx.param("path").filter(|raw| !raw.is_empty())?;
            Some(match ops.git_diff(&folder_id, &rel_path) {
                Ok(value) => util::ok(value),
                Err(error) => op_error(error, "读取变更对比失败"),
            })
        }
        ("GET", "/api/folders/git-log") => {
            let (folder_id, _) = query_folder(state)?;
            Some(match ops.git_log(&folder_id) {
                Ok(Value::Null) => util::ok(json!({ "commits": [], "gitRepo": false })),
                Ok(value) => util::ok(json!({ "commits": value, "gitRepo": true })),
                Err(error) => op_error(error, "读取提交历史失败"),
            })
        }
        ("GET", "/api/folders/git-commit-files") => {
            let (folder_id, _) = query_folder(state)?;
            let hash = ctx.param("hash").filter(|raw| !raw.is_empty())?;
            Some(match ops.git_commit_files(&folder_id, &hash) {
                Ok(Value::Null) => util::ok(json!({ "files": [], "gitRepo": false })),
                Ok(value) => util::ok(json!({ "files": value, "gitRepo": true })),
                Err(error) => op_error(error, "读取提交文件清单失败"),
            })
        }
        ("GET", "/api/folders/git-commit-diff") => {
            let (folder_id, _) = query_folder(state)?;
            let hash = ctx.param("hash").filter(|raw| !raw.is_empty())?;
            let rel_path = ctx.param("path").filter(|raw| !raw.is_empty())?;
            let orig = ctx.param("origPath").filter(|raw| !raw.is_empty());
            Some(match ops.git_commit_diff(&folder_id, &hash, &rel_path, orig.as_deref()) {
                Ok(value) => util::ok(value),
                Err(error) => op_error(error, "读取提交对比失败"),
            })
        }
        ("GET", "/api/folders/git-unpushed") => {
            // 空串视同缺省(全量):单目录调用方一律带非空 id
            let folder_id = ctx.param("folderId").filter(|raw| !raw.is_empty());
            Some(match ops.git_unpushed(folder_id.as_deref()) {
                Ok(value) => util::ok(json!({ "folders": value })),
                Err(error) => op_error(error, "读取未推送提交失败"),
            })
        }
        ("GET", "/api/folders/git-commit-status") => {
            let (folder_id, _) = query_folder(state)?;
            Some(match ops.git_auto_commit_status(&folder_id) {
                Ok(value) => util::ok(value),
                Err(error) => op_error(error, "读取自动提交状态失败"),
            })
        }
        ("POST", "/api/folders/git-push") => {
            let body = ctx.json().ok()?;
            let folder_id = non_empty_string(body.get("folderId"))?;
            Some(match ops.git_push(&folder_id) {
                Ok(value) => util::ok(value),
                Err(error) => op_error(error, "推送失败"),
            })
        }
        ("POST", "/api/folders/git-index-lock/delete") => {
            let body = ctx.json().ok()?;
            let folder_id = non_empty_string(body.get("folderId"))?;
            Some(match ops.git_delete_index_lock(&folder_id) {
                Ok(value) => util::ok(value),
                Err(error) => op_error(error, "删除锁文件失败"),
            })
        }
        ("POST", "/api/folders/git-commit-retry") => {
            let body = ctx.json().ok()?;
            let folder_id = non_empty_string(body.get("folderId"))?;
            Some(match ops.git_retry_auto_commit(&folder_id) {
                Ok(value) => util::ok(value),
                Err(error) => op_error(error, "重试自动提交失败"),
            })
        }
        _ => None,
    }
}

/* ==================== fallback 页面 ==================== */

fn history_page(state: &AppState) -> Response {
    let config = state.config.load();
    let folders = folder_pairs(&config);
    let result = state.history.query_global(&folders, 200, &HistoryFilter::default());

    let action_zh = |action: &str| -> String {
        match action {
            "add" => "新增".to_string(),
            "update" => "修改".to_string(),
            "delete" => "删除".to_string(),
            "conflict" => "冲突".to_string(),
            other => other.to_string(),
        }
    };
    let rows: String = result
        .events
        .iter()
        .map(|entry| {
            let event = &entry.event;
            let dir = if event.direction == "local" {
                "本地".to_string()
            } else {
                match &event.device_id {
                    Some(id) => format!("对端:{}", html_escape(id)),
                    None => "对端".to_string(),
                }
            };
            let class = if event.action == "conflict" {
                " class=\"conflict\""
            } else {
                ""
            };
            format!(
                "<tr{class}><td>{}</td><td>{}</td><td>{}</td><td>{dir}</td><td>{}</td></tr>",
                html_escape(&format_time(event.ts)),
                html_escape(&entry.folder_path),
                html_escape(&action_zh(&event.action)),
                html_escape(&event.path),
            )
        })
        .collect();

    let body = if result.events.is_empty() {
        "<p class=\"muted\">还没有同步记录</p>".to_string()
    } else {
        format!(
            "<p class=\"muted\">仅展示最近 200 条 · 各目录分别保留最近 {} 条</p>\
             <table><tr><th>时间</th><th>目录</th><th>动作</th><th>方向</th><th>路径</th></tr>{rows}</table>",
            result.max_retention
        )
    };
    util::html(&format!(
        "<h1>同步记录 · 全部目录</h1>{body}<p><a href=\"/\">← 返回</a></p>"
    ))
}

fn versions_page(state: &AppState, ctx: &Ctx) -> Response {
    let Some(folder_id) = ctx.param("folder").filter(|raw| !raw.is_empty()) else {
        return util::text_response(
            StatusCode::BAD_REQUEST,
            "text/html; charset=utf-8",
            "<p>missing folder parameter</p><a href=\"/\">返回</a>".to_string(),
        );
    };
    let Ok(folder) = require_folder(state, &folder_id) else {
        return util::text_response(
            StatusCode::BAD_REQUEST,
            "text/html; charset=utf-8",
            format!("<p>{}</p><a href=\"/\">返回</a>", html_escape(&folder_id)),
        );
    };
    let dir = fsops::versions_dir_for(&config_dir(state), &folder);
    let listing = fsops::list_versions(&dir);
    let back = percent_encoding::utf8_percent_encode(
        &format!("/versions?folder={folder_id}"),
        percent_encoding::NON_ALPHANUMERIC,
    )
    .to_string();

    let rows: String = listing["versions"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|item| {
                    let file = item["file"].as_str().unwrap_or("");
                    let rel_path = item["path"].as_str().unwrap_or("");
                    let size = item["size"].as_u64().unwrap_or(0);
                    let mtime = item["mtime"].as_i64().unwrap_or(0);
                    format!(
                        "<tr><td>{}</td><td>{}</td><td>{}</td><td>{}{}</td></tr>",
                        html_escape(rel_path),
                        format_size(size),
                        html_escape(&format_time(mtime)),
                        version_form("restore-version", &folder_id, file, &back, "恢复"),
                        version_form("delete-version", &folder_id, file, &back, "删除"),
                    )
                })
                .collect()
        })
        .unwrap_or_default();

    let body = if rows.is_empty() {
        "<p class=\"muted\">暂无版本留档(文件被对端覆盖修改时会自动留档旧内容)</p>".to_string()
    } else {
        format!("<table><tr><th>原始路径</th><th>大小</th><th>留档时间</th><th>操作</th></tr>{rows}</table>")
    };
    util::html(&format!(
        "<h1>文件版本 · {}</h1>{body}<p><a href=\"/\">← 返回</a></p>",
        html_escape(&folder_id)
    ))
}

fn version_form(action: &str, folder_id: &str, file: &str, back: &str, label: &str) -> String {
    format!(
        "<form method=\"post\" action=\"/actions\" style=\"display:inline\">\
         <input type=\"hidden\" name=\"action\" value=\"{action}\">\
         <input type=\"hidden\" name=\"folderId\" value=\"{}\">\
         <input type=\"hidden\" name=\"file\" value=\"{}\">\
         <input type=\"hidden\" name=\"back\" value=\"{back}\">\
         <button type=\"submit\" class=\"btn-sm\">{label}</button></form>",
        html_escape(folder_id),
        html_escape(file),
    )
}

fn format_size(bytes: u64) -> String {
    const GB: u64 = 1_073_741_824;
    const MB: u64 = 1_048_576;
    const KB: u64 = 1024;
    if bytes >= GB {
        format!("{:.1} GB", bytes as f64 / GB as f64)
    } else if bytes >= MB {
        format!("{:.1} MB", bytes as f64 / MB as f64)
    } else if bytes >= KB {
        format!("{:.1} KB", bytes as f64 / KB as f64)
    } else {
        format!("{bytes} B")
    }
}

fn format_time(ts: i64) -> String {
    use chrono::{Local, TimeZone};
    match Local.timestamp_millis_opt(ts).single() {
        Some(moment) => moment.format("%Y/%m/%d %H:%M:%S").to_string(),
        None => String::new(),
    }
}

/* ==================== 供其他模块复用的构造 ==================== */

/// 版本目录(供 files/actions 复用)。
pub fn versions_dir(state: &AppState, folder: &SharedFolder) -> std::path::PathBuf {
    fsops::versions_dir_for(&state.config.config_dir(), folder)
}

/// 空 Map 便捷构造(测试与较少字段的响应)。
#[allow(dead_code)]
fn empty_map() -> Map<String, Value> {
    Map::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn html_escape_covers_all_five() {
        assert_eq!(
            html_escape("a&b<c>d\"e'f"),
            "a&amp;b&lt;c&gt;d&quot;e&#39;f"
        );
    }

    #[test]
    fn format_size_matches_node_boundaries() {
        assert_eq!(format_size(1023), "1023 B");
        assert_eq!(format_size(1024), "1.0 KB");
        assert_eq!(format_size(1_048_576), "1.0 MB");
        assert_eq!(format_size(1_073_741_824), "1.0 GB");
    }

    #[test]
    fn parse_history_query_rejects_bad_params() {
        let ctx = Ctx {
            method: axum::http::Method::GET,
            path: "/api/folders/history".into(),
            query: "limit=0".into(),
            headers: axum::http::HeaderMap::new(),
            body: Vec::new(),
            remote: String::new(),
        };
        assert!(parse_history_query(&ctx, 2000).is_err());

        let ctx = Ctx {
            query: "direction=sideways&action=nope".into(),
            ..ctx
        };
        assert_eq!(
            parse_history_query(&ctx, 2000).unwrap_err(),
            "invalid direction, action parameter"
        );
    }

    /// 路由层测试用的最小 AppState:临时目录 + 真实 ConfigStore,不接活会话。
    fn temp_state(tag: &str) -> (AppState, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "syncx-api-folders-route-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let deps = crate::deps::ControlDeps::new("test-token", dir.join("config.json"));
        let state = AppState::new(deps);
        state.config.save(&crate::config::Config::new()).unwrap();
        (state, dir)
    }

    fn post_ctx(path: &str, body: Value) -> Ctx {
        Ctx {
            method: axum::http::Method::POST,
            path: path.into(),
            query: String::new(),
            headers: axum::http::HeaderMap::new(),
            body: serde_json::to_vec(&body).unwrap(),
            remote: String::new(),
        }
    }

    async fn response_json(response: axum::response::Response) -> (StatusCode, Value) {
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .unwrap();
        (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
    }

    #[tokio::test]
    async fn git_strip_co_authored_route_saves_toggle() {
        let (state, dir) = temp_state("toggle");
        let root = dir.join("shared");
        std::fs::create_dir_all(&root).unwrap();
        mutate::add_folder(&state.config, root.to_str().unwrap(), &[], None, false).unwrap();
        // 目录可能被规范化过(folder_id 回退 path 时以落盘值为准)
        let folder_id = state.config.load().shared_folders[0].folder_id();

        // 开:on=true 落盘,响应是 {"ok":true}
        let (status, body) =
            response_json(try_routes(&state, &post_ctx(
                "/api/folders/git-strip-co-authored",
                serde_json::json!({ "folderId": folder_id.clone(), "on": true }),
            )).unwrap())
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["ok"], true);
        assert_eq!(
            state.config.load().shared_folders[0].git_strip_co_authored,
            Some(true)
        );

        // 关:on=false 落成 None(缺省形态),不写字面量 false
        let (status, body) =
            response_json(try_routes(&state, &post_ctx(
                "/api/folders/git-strip-co-authored",
                serde_json::json!({ "folderId": folder_id, "on": false }),
            )).unwrap())
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["ok"], true);
        assert_eq!(
            state.config.load().shared_folders[0].git_strip_co_authored,
            None
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn git_strip_co_authored_route_rejects_bad_input() {
        let (state, dir) = temp_state("bad");

        // 缺 folderId / on 不是布尔 / 目录不存在:一律 400,与相邻路由同一文案口径
        for (payload, needle) in [
            (serde_json::json!({ "on": true }), "folderId is required"),
            (
                serde_json::json!({ "folderId": "/a", "on": "yes" }),
                "on must be a boolean",
            ),
            (
                serde_json::json!({ "folderId": "/missing", "on": true }),
                "未找到共享目录",
            ),
        ] {
            let (status, body) =
                response_json(try_routes(&state, &post_ctx(
                    "/api/folders/git-strip-co-authored",
                    payload,
                )).unwrap())
                .await;
            assert_eq!(status, StatusCode::BAD_REQUEST);
            assert!(
                body["error"].as_str().unwrap_or("").contains(needle),
                "{body}"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
