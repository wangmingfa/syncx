//! 两条 WebSocket 通道的升级与帧循环:`/api/events`(状态推送)与 `/api/terminal`。
//!
//! 鉴权在**升级之前**用原始 HTTP 请求头完成,失败时回一条裸 HTTP 响应再断链:
//! 浏览器没法给 WebSocket 设请求头,凭据只能来自同源 cookie,而 `ws` 一旦升级就
//! 无法再回状态码。前端据此区分「没登录(401)」与「网络不通」,不会无休止重连。
//!
//! 顺序与 Node `src/api.ts` 的 `upgrade` 事件逐条一致:
//! 1. 只有 `/api/events`(需中枢)与 `/api/terminal`(需终端)放行,其余直接断;
//! 2. 凭据不通 → 401;
//! 3. 终端还要提权 → 403(整机 shell 是最高危通道);
//! 4. 已授权 → 交给中枢或终端。

use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};

use crate::deps::AppState;
use crate::routes::util::{header_cookie, header_token};
use crate::ws::{StatusHub, WsFrame};

pub const EVENTS_PATH: &str = "/api/events";
pub const TERMINAL_PATH: &str = "/api/terminal";

/// 升级失败时回一条裸 HTTP 响应。用 `text/plain` 而非 JSON:这条响应是写给
/// 客户端的 WebSocket 栈看的,不是给页面渲染的。
fn raw_status(status: StatusCode, reason: &str) -> Response {
    let body = format!(
        "HTTP/1.1 {} {}\r\nConnection: close\r\n\r\n",
        status.as_u16(),
        reason
    );
    let mut response = (status, body).into_response();
    response
        .headers_mut()
        .insert(axum::http::header::CONNECTION, "close".parse().expect("静态头合法"));
    response
}

/// 升级前的公共闸门。`need_elevation` 只有终端那一路为真。
#[allow(clippy::result_large_err)]
fn gate(
    state: &AppState,
    headers: &HeaderMap,
    need_elevation: bool,
) -> Result<(), Response> {
    if !state.auth.credential_ok(header_token(headers).as_deref()) {
        return Err(raw_status(StatusCode::UNAUTHORIZED, "Unauthorized"));
    }
    if need_elevation
        && !state
            .auth
            .elevate_ok(header_cookie(headers, "syncx_su").as_deref())
    {
        return Err(raw_status(StatusCode::FORBIDDEN, "Forbidden"));
    }
    Ok(())
}

pub async fn events(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    let Some(hub) = state.deps.hub.clone() else {
        // 中枢没装:与 Node 的 `path === EVENTS_PATH && deps.statusHub` 同款,不认这条路由
        return raw_status(StatusCode::NOT_FOUND, "Not Found");
    };
    if let Err(response) = gate(&state, &headers, false) {
        return response;
    }
    upgrade.on_upgrade(move |socket| events_loop(socket, hub))
}

pub async fn terminal(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    let Some(ops) = state.deps.ops().cloned() else {
        return raw_status(StatusCode::NOT_FOUND, "Not Found");
    };
    // 终端是最高危通道(整机 shell):登录之外还要提权
    if let Err(response) = gate(&state, &headers, true) {
        return response;
    }
    upgrade.on_upgrade(move |socket| terminal_loop(socket, ops))
}

/// 状态推送:接管连接,把中枢广播的帧写进 socket,客户端发来的心跳忽略。
async fn events_loop(mut socket: WebSocket, hub: StatusHub) {
    let Some((id, mut rx)) = hub.attach() else {
        let _ = socket
            .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                code: 1001,
                reason: "server shutting down".into(),
            })))
            .await;
        return;
    };
    loop {
        tokio::select! {
            frame = rx.recv() => {
                let Some(frame) = frame else { break };
                if !write_frame(&mut socket, frame).await {
                    break;
                }
            }
            incoming = socket.recv() => {
                match incoming {
                    // 浏览器侧的 ping/pong 由 axum 自己答;这里只看连接是否还活着
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(_)) => {}
                }
            }
        }
    }
    hub.detach(id);
}

async fn write_frame(socket: &mut WebSocket, frame: WsFrame) -> bool {
    match frame {
        WsFrame::Text(text) => socket.send(Message::Text(text.into())).await.is_ok(),
        WsFrame::Close(code, reason) => socket
            .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                code,
                reason: reason.into(),
            })))
            .await
            .is_ok(),
    }
}

/// 浏览器内终端。协议与 Node `api/terminal.ts` 一致(JSON 文本帧):
/// 入站 `{t:'in'|'resize'|'sigint'|'ping',...}`,出站 `{t:'ready'|'out'|'exit',...}`。
///
/// 真正的 PTY 生命周期由装配层的终端中枢负责 —— 那条实现要 spawn 子进程、
/// 处理两套存活门,属于 CLI 侧。这里只做协议转发,不自己 fork shell:
/// 一个没有节流、没有子进程收割的 PTY 比没有终端更危险。
async fn terminal_loop(mut socket: WebSocket, ops: Arc<dyn crate::deps::ControlOps>) {
    let Some(link) = ops.open_terminal() else {
        let _ = socket
            .send(Message::Text(
                serde_json::json!({ "t": "exit", "code": 1 }).to_string().into(),
            ))
            .await;
        return;
    };
    let crate::deps::TerminalLink {
        inbound,
        mut output,
        shutdown,
    } = link;

    loop {
        tokio::select! {
            frame = output.recv() => {
                let Some(frame) = frame else { break };
                if socket.send(Message::Text(frame.into())).await.is_err() {
                    break;
                }
            }
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        // shell 已退出:前端还发帧就没意义了,收尾走同一条路
                        if inbound.send(text.to_string()).is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(_)) => {}
                }
            }
        }
    }
    if let Some(shutdown) = shutdown {
        shutdown();
    }
}
