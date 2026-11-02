//! Prometheus 抓取端点 `/metrics`。
//!
//! 走登录门(Bearer 控制令牌或会话 cookie),与 Node 一致:流量与条目数本身也算
//! 使用习惯,故不放进免认证组 —— `/healthz` 只报活,这个要鉴权。
//!
//! 载荷直接吃 `/api/status` 的同一份 JSON(状态源是同一个闭包),所以两处口径不可能漂:
//! 缺字段的旧载荷逐段跳过,不渲染 NaN。

use axum::http::{header, StatusCode};
use axum::response::Response;
use serde_json::{Map, Value};

use crate::deps::AppState;
use crate::routes::util::{self, Ctx};

pub fn try_routes(state: &AppState, ctx: &Ctx) -> Option<Response> {
    if ctx.path != "/metrics" {
        return None;
    }
    if !ctx.method_is("GET") && !ctx.method_is("HEAD") {
        return Some(util::error(StatusCode::METHOD_NOT_ALLOWED, "method not allowed"));
    }
    let status = (state.deps.status)();
    let text = render_metrics(&status, state.deps.started_at.elapsed().as_secs());
    let body = if ctx.method_is("HEAD") { String::new() } else { text };
    Some(
        Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/plain; version=0.0.4; charset=utf-8")
            .header(header::CACHE_CONTROL, "no-store")
            .body(axum::body::Body::from(body))
            .expect("响应构造不应失败"),
    )
}

/// 指标标签值转义(反斜杠 / 双引号 / 换行),与 Prometheus 文本格式规范一致。
fn escape_label(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
}

/// 数值直出:非有限数渲染 0,避免污染抓取。
fn num(value: Option<&Value>) -> String {
    match value {
        Some(Value::Number(number)) => number
            .as_f64()
            .filter(|n| n.is_finite())
            .map(|n| {
                // 整数原样输出,避免 1 渲染成 1.0
                if n.fract() == 0.0 && n.abs() < 9e15 {
                    format!("{}", n as i64)
                } else {
                    format!("{n}")
                }
            })
            .unwrap_or_else(|| "0".to_string()),
        _ => "0".to_string(),
    }
}

/// 布尔直 1/0(缺省视为 false)。
fn bool_of(value: Option<&Value>) -> &'static str {
    if value == Some(&Value::Bool(true)) {
        "1"
    } else {
        "0"
    }
}

fn str_of<'a>(object: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    object.get(key).and_then(|value| value.as_str())
}

fn array_of<'a>(object: &'a Map<String, Value>, key: &str) -> &'a [Value] {
    object
        .get(key)
        .and_then(|value| value.as_array())
        .map(|list| list.as_slice())
        .unwrap_or(&[])
}

/// 渲染 Prometheus 文本。`status` 按「可能缺字段」对待,每段各自判空。
pub fn render_metrics(status: &Value, uptime_secs: u64) -> String {
    let empty = Map::new();
    let status = status.as_object().unwrap_or(&empty);
    let mut lines: Vec<String> = Vec::new();
    let mut emitted: std::collections::HashSet<String> = std::collections::HashSet::new();

    let help = |lines: &mut Vec<String>, emitted: &mut std::collections::HashSet<String>, name: &str, text: &str, kind: &str| {
        if emitted.insert(name.to_string()) {
            lines.push(format!("# HELP {name} {text}"));
            lines.push(format!("# TYPE {name} {kind}"));
        }
    };

    macro_rules! metric {
        ($name:literal, $help:literal, $kind:literal, $value:expr, $labels:expr) => {{
            help(&mut lines, &mut emitted, $name, $help, $kind);
            lines.push(format!("{}{} {}", $name, $labels, $value));
        }};
        ($name:literal, $help:literal, $kind:literal, $value:expr) => {{
            metric!($name, $help, $kind, $value, "");
        }};
    }

    // —— 存活与进程 ——
    metric!("syncx_up", "daemon 是否在响应(恒 1)", "gauge", "1");
    metric!(
        "syncx_uptime_seconds",
        "进程运行时长(秒)",
        "gauge",
        uptime_secs.to_string()
    );
    let version = str_of(status, "version").unwrap_or("unknown");
    let platform = str_of(status, "platform").unwrap_or("unknown");
    metric!(
        "syncx_build_info",
        "daemon 版本与平台(label 形式)",
        "gauge",
        "1",
        format!(
            "{{version=\"{}\",platform=\"{}\"}}",
            escape_label(version),
            escape_label(platform)
        )
    );

    // —— 索引规模 ——
    metric!(
        "syncx_index_entries",
        "本机索引条目数(未删)",
        "gauge",
        num(status.get("entries"))
    );
    metric!(
        "syncx_index_tombstones",
        "本机索引墓碑数",
        "gauge",
        num(status.get("tombstones"))
    );

    // —— 全局开关 ——
    metric!(
        "syncx_paused",
        "全局暂停同步(1=数据面停摆)",
        "gauge",
        bool_of(status.get("paused"))
    );
    let power_guard = status
        .get("powerGuard")
        .map(|value| !value.is_null())
        .unwrap_or(false);
    metric!(
        "syncx_power_guard",
        "电源守卫挂起中(计费网络/低电量)",
        "gauge",
        if power_guard { "1" } else { "0" }
    );

    // —— 目录 ——
    let folders = array_of(status, "folders");
    metric!(
        "syncx_shared_folders",
        "共享目录数",
        "gauge",
        folders.len().to_string()
    );
    for folder in folders {
        let Some(folder) = folder.as_object() else {
            continue;
        };
        // 标签取 `id ?? path`,与状态页目录键一致
        let key = str_of(folder, "id")
            .or_else(|| str_of(folder, "path"))
            .unwrap_or("");
        let key = escape_label(key);
        metric!(
            "syncx_folder_paused",
            "目录级暂停(1=该目录数据面停摆)",
            "gauge",
            bool_of(folder.get("paused")),
            format!("{{folder=\"{key}\"}}")
        );
        metric!(
            "syncx_folder_on_demand",
            "目录级按需同步开关",
            "gauge",
            bool_of(folder.get("onDemand")),
            format!("{{folder=\"{key}\"}}")
        );
        metric!(
            "syncx_folder_devices",
            "目录指派的设备数",
            "gauge",
            array_of(folder, "devices").len().to_string(),
            format!("{{folder=\"{key}\"}}")
        );
    }

    // —— 对端 ——
    let devices = array_of(status, "devices");
    let online = devices
        .iter()
        .filter(|device| {
            device
                .as_object()
                .and_then(|object| object.get("online"))
                .and_then(|value| value.as_bool())
                == Some(true)
        })
        .count();
    metric!(
        "syncx_peers_configured",
        "已配对设备数",
        "gauge",
        devices.len().to_string()
    );
    metric!(
        "syncx_peers_online",
        "当前在线设备数(握手完成)",
        "gauge",
        online.to_string()
    );

    // —— 待确认邀请 ——
    metric!(
        "syncx_offers_pending",
        "待确认的配对/共享邀请数",
        "gauge",
        array_of(status, "offers").len().to_string()
    );

    // —— 传输进度(每目录) ——
    for progress in array_of(status, "syncProgress") {
        let Some(progress) = progress.as_object() else {
            continue;
        };
        let key = escape_label(str_of(progress, "folder").unwrap_or(""));
        metric!(
            "syncx_transfer_pending_files",
            "各目录待同步文件数(计划里未开工)",
            "gauge",
            num(progress.get("pending")),
            format!("{{folder=\"{key}\"}}")
        );
        metric!(
            "syncx_transfer_sending_files",
            "各目录正在发送的文件数",
            "gauge",
            num(progress.get("sending")),
            format!("{{folder=\"{key}\"}}")
        );
        metric!(
            "syncx_transfer_receiving_files",
            "各目录正在接收的文件数",
            "gauge",
            num(progress.get("receiving")),
            format!("{{folder=\"{key}\"}}")
        );
    }

    // —— 流量累计(daemon 重启清零,counter 语义仍成立:重启处 reset) ——
    if let Some(traffic) = status.get("traffic").and_then(|value| value.as_object()) {
        metric!(
            "syncx_traffic_sent_bytes_total",
            "累计发送字节(daemon 启动以来)",
            "counter",
            num(traffic.get("sent"))
        );
        metric!(
            "syncx_traffic_received_bytes_total",
            "累计接收字节(daemon 启动以来)",
            "counter",
            num(traffic.get("received"))
        );
    }

    // —— 冲突副本与目录错误 ——
    if let Some(counts) = status.get("conflictCounts").and_then(|value| value.as_object()) {
        for (folder_id, count) in counts {
            metric!(
                "syncx_conflict_copies",
                "目录内残留冲突副本数",
                "gauge",
                num(Some(count)),
                format!("{{folder=\"{}\"}}", escape_label(folder_id))
            );
        }
    }
    for error in array_of(status, "folderErrors") {
        let Some(error) = error.as_object() else {
            continue;
        };
        let key = escape_label(str_of(error, "folder").unwrap_or(""));
        metric!(
            "syncx_folder_error",
            "目录最近一次同步错误(1=有错误未消除)",
            "gauge",
            "1",
            format!("{{folder=\"{key}\"}}")
        );
    }

    lines.join("\n") + "\n"
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn missing_fields_do_not_render_nan() {
        let text = render_metrics(&json!({}), 3);
        assert!(text.contains("syncx_up 1"));
        assert!(text.contains("syncx_index_entries 0"));
        assert!(!text.contains("NaN"));
        // 只查数值位:指标名里本来就有 `syncx_build_info`
        assert!(!text.contains(" inf") && !text.contains("Infinity"));
    }

    #[test]
    fn labels_are_escaped() {
        let text = render_metrics(
            &json!({ "folders": [{ "id": "a\"b\\c", "paused": true }] }),
            0,
        );
        assert!(text.contains(r#"folder="a\"b\\c""#), "{text}");
    }

    #[test]
    fn help_and_type_emitted_once() {
        let text = render_metrics(
            &json!({ "folders": [{ "id": "a" }, { "id": "b" }] }),
            0,
        );
        assert_eq!(text.matches("# HELP syncx_folder_paused").count(), 1);
        assert_eq!(text.matches("# TYPE syncx_folder_paused gauge").count(), 1);
    }
}
