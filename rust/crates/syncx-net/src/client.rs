//! 对端 WebSocket 客户端。对应 Node 侧 `src/net/client.ts` 的 `connectPeer`。
//!
//! 与服务端对称:先发本机公钥 → 收对端公钥 → 发 kx → 收 kx。
//! **顺序不能与一方对调** —— 握手是无显式协商的固定脚本,任一侧改顺序都会互锁。

use std::net::SocketAddr;

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::WebSocketStream;

use crate::handshake::{
    build_kx_message, decode_kx_message, derive_session_key, verify_kx_message, X25519KeyPair,
    PEER_CAPS,
};
use crate::identity::{derive_device_id, DeviceIdentity};
use crate::server::PeerConnection;
use crate::wire::MAX_MESSAGE_BYTES;

/// 连接结果。
pub struct ConnectedPeer {
    pub connection: PeerConnection,
    /// 对端地址(用于日志;重连提示由调用方按 device_id 自己记)。
    pub remote_addr: SocketAddr,
}

/// 连接一个对端并完成握手。
///
/// `listen_port` 写进本机 kx,让接收方结合源 IP 反向重连本机。
pub async fn connect_peer(
    identity: &DeviceIdentity,
    url: &str,
    listen_port: Option<u16>,
) -> Result<ConnectedPeer, ConnectError> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

    let request = url
        .into_client_request()
        .map_err(|e| ConnectError::Transport(e.to_string()))?;
    // 只支持明文 ws://:本协议的加密在应用层(AES-GCM 信封),传输层不需要 TLS。
    // 走 `connect_async*` 会拿到 `MaybeTlsStream`,那样 `PeerConnection` 就得对
    // 传输类型做泛型,而它两侧共用 —— 自己建 TCP 更直接。
    if request.uri().scheme_str() != Some("ws") {
        return Err(ConnectError::Transport(format!("只支持 ws:// 地址:{url}")));
    }
    // 用 uri 的 host/port 而不是自己切字符串:IPv6 字面量的方括号写法自己拆会翻车
    let host = request
        .uri()
        .host()
        .ok_or_else(|| ConnectError::Transport(format!("地址缺少主机名:{url}")))?
        .to_string();
    let port = request.uri().port_u16().unwrap_or(80);

    let stream = TcpStream::connect((host.as_str(), port))
        .await
        .map_err(|e| ConnectError::Transport(e.to_string()))?;
    let remote_addr = stream
        .peer_addr()
        .map_err(|e| ConnectError::Transport(e.to_string()))?;

    let (socket, _response) =
        tokio_tungstenite::client_async_with_config(request, stream, Some(ws_config()))
            .await
            .map_err(|e| ConnectError::Transport(e.to_string()))?;

    handshake(socket, identity, listen_port, remote_addr).await
}

fn ws_config() -> WebSocketConfig {
    WebSocketConfig {
        max_message_size: Some(MAX_MESSAGE_BYTES),
        max_frame_size: Some(MAX_MESSAGE_BYTES),
        ..Default::default()
    }
}

async fn handshake(
    mut socket: WebSocketStream<TcpStream>,
    identity: &DeviceIdentity,
    listen_port: Option<u16>,
    remote_addr: SocketAddr,
) -> Result<ConnectedPeer, ConnectError> {
    // 第一阶段:发本机公钥
    socket
        .send(WsMessage::Text(identity.public_key_pem.clone()))
        .await
        .map_err(|e| ConnectError::Transport(e.to_string()))?;

    let peer_public_key_pem = read_text(&mut socket).await?;
    let peer_device_id = derive_device_id(&peer_public_key_pem);

    // 第二阶段:发 kx
    let session_pair = X25519KeyPair::generate();
    let our_kx = build_kx_message(&session_pair, identity, listen_port, PEER_CAPS)
        .map_err(|e| ConnectError::Handshake(e.to_string()))?;
    socket
        .send(WsMessage::Text(crate::handshake::encode_kx_message(
            &our_kx,
        )))
        .await
        .map_err(|e| ConnectError::Transport(e.to_string()))?;

    let kx_text = read_text(&mut socket).await?;
    let kx = decode_kx_message(&kx_text).map_err(|e| ConnectError::Handshake(e.to_string()))?;
    let peer_x25519 = verify_kx_message(&kx, &peer_public_key_pem)
        .map_err(|e| ConnectError::Handshake(e.to_string()))?;

    let session_key = derive_session_key(&session_pair, &peer_x25519);

    Ok(ConnectedPeer {
        connection: PeerConnection::new(
            peer_device_id,
            session_key,
            kx.listen_port,
            kx.caps,
            remote_addr,
            socket,
        ),
        remote_addr,
    })
}

/// 读一条文本帧(跳过控制帧)。
async fn read_text(socket: &mut WebSocketStream<TcpStream>) -> Result<String, ConnectError> {
    loop {
        match socket.next().await {
            Some(Ok(WsMessage::Text(text))) => return Ok(text.to_string()),
            Some(Ok(WsMessage::Binary(bytes))) => {
                return Ok(String::from_utf8_lossy(&bytes).to_string())
            }
            Some(Ok(WsMessage::Ping(payload))) => {
                let _ = socket.send(WsMessage::Pong(payload)).await;
            }
            Some(Ok(WsMessage::Pong(_))) | Some(Ok(WsMessage::Frame(_))) => continue,
            Some(Ok(WsMessage::Close(_))) | Some(Err(_)) | None => {
                return Err(ConnectError::Closed)
            }
        }
    }
}

/// 连接层错误。
#[derive(Debug, thiserror::Error)]
pub enum ConnectError {
    #[error("连接失败:{0}")]
    Transport(String),
    #[error("握手失败:{0}")]
    Handshake(String),
    #[error("握手期间连接关闭")]
    Closed,
}
