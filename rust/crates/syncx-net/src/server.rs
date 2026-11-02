//! 对端 WebSocket 服务端:两阶段握手 + 完成后的帧通道。对应 Node 侧
//! `src/net/server.ts`。
//!
//! 三个数字都是**行为契约**,不是随便定的:
//!   - `MAX_MESSAGE_BYTES` 64 MiB:单条消息上限,索引与块都在这个量级之下;
//!   - `HANDSHAKE_TIMEOUT_MS` 10 s:握手未完成即断,防半开连接堆积;
//!   - `MAX_PEER_CONNECTIONS` 64:并发入站上限,防单点耗尽资源。

use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::WebSocketStream;

use crate::handshake::{
    build_kx_message, decode_kx_message, derive_session_key, verify_kx_message, X25519KeyPair,
    PEER_CAPS,
};
use crate::identity::{derive_device_id, DeviceIdentity};
use crate::wire::{encrypt_message, WireMessage, MAX_MESSAGE_BYTES};

pub const HANDSHAKE_TIMEOUT_MS: u64 = 10_000;
pub const MAX_PEER_CONNECTIONS: usize = 64;

/// 收发的原始帧(已解密前的形态)。
///
/// 保持「文本 / 二进制」两分支到这一层就够:二进制帧的语义在 `wire` 里解,
/// 这里只负责搬字节 —— 与 Node 的 `attachPeerMessages` 同一分工。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    Text(String),
    Binary(Vec<u8>),
}

/// 握手完成后的对端连接。
///
/// 由调用方独占所有权(不是回调里借用):读循环归调用方写,避免这里猜同步语义。
/// Node 侧那个「握手完成到分发器挂载之间有微任务间隙,需要缓冲帧」的补丁在这里
/// **不需要存在** —— 流一直在我们手里,没人读的时候帧就待在 socket 缓冲区里。
pub struct PeerConnection {
    pub device_id: String,
    pub session_key: [u8; 32],
    /// 对端在 kx 里广播的监听端口(旧版对端为 `None`)。
    pub listen_port: Option<u16>,
    /// 对端能力标签。`None` 表示旧版对端,数据面必须退回文本信封。
    pub caps: Option<Vec<String>>,
    pub remote_addr: SocketAddr,
    socket: WebSocketStream<TcpStream>,
}

impl PeerConnection {
    /// 由客户端握手路径构造(两侧握手产物必须是同一个类型,否则上层要为
    /// 「我是连出去的一方」写两套收发代码)。
    pub(crate) fn new(
        device_id: String,
        session_key: [u8; 32],
        listen_port: Option<u16>,
        caps: Option<Vec<String>>,
        remote_addr: SocketAddr,
        socket: WebSocketStream<TcpStream>,
    ) -> Self {
        Self {
            device_id,
            session_key,
            listen_port,
            caps,
            remote_addr,
            socket,
        }
    }

    /// 对端是否支持二进制信封。
    pub fn supports_binary(&self) -> bool {
        self.caps
            .as_deref()
            .is_some_and(|caps| caps.iter().any(|c| c == crate::handshake::CAP_BINARY1))
    }

    /// 读一帧。连接正常关闭或出错都返回 `None`。
    pub async fn recv(&mut self) -> Option<Frame> {
        loop {
            match self.socket.next().await? {
                Ok(WsMessage::Text(text)) => return Some(Frame::Text(text.to_string())),
                Ok(WsMessage::Binary(bytes)) => return Some(Frame::Binary(bytes.to_vec())),
                Ok(WsMessage::Ping(payload)) => {
                    // tungstenite 不替我们回 pong;不回的话对端会判定链路死掉
                    let _ = self.socket.send(WsMessage::Pong(payload)).await;
                }
                Ok(WsMessage::Pong(_)) | Ok(WsMessage::Frame(_)) => continue,
                Ok(WsMessage::Close(_)) | Err(_) => return None,
            }
        }
    }

    /// 发一条已加密的 wire 消息(文本信封)。
    pub async fn send_message(
        &mut self,
        message: &WireMessage,
    ) -> Result<(), crate::wire::WireError> {
        let text = encrypt_message(&self.session_key, message)?;
        self.send_text(&text).await
    }

    pub async fn send_text(&mut self, text: &str) -> Result<(), crate::wire::WireError> {
        self.socket
            .send(WsMessage::Text(text.to_string()))
            .await
            .map_err(|e| crate::wire::WireError::Malformed(e.to_string()))
    }

    pub async fn send_binary(&mut self, bytes: Vec<u8>) -> Result<(), crate::wire::WireError> {
        self.socket
            .send(WsMessage::Binary(bytes))
            .await
            .map_err(|e| crate::wire::WireError::Malformed(e.to_string()))
    }

    pub async fn close(&mut self) {
        let _ = self.socket.close(None).await;
    }
}

/// 握手成功的回调。返回的 future 由服务端负责跑完(连接的生命周期就在里面)。
pub type PeerHandler =
    Arc<dyn Fn(PeerConnection) -> futures_util::future::BoxFuture<'static, ()> + Send + Sync>;

/// 正在运行的对端服务端。
pub struct PeerServer {
    pub port: u16,
    shutdown: Option<oneshot::Sender<()>>,
    handle: Option<tokio::task::JoinHandle<()>>,
}

impl PeerServer {
    /// 停止监听。**不**等待已建立的对端连接结束 —— 那些连接归各自的 handler 管,
    /// 调用方要断它们应该从自己的会话表里关。
    pub async fn close(mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        if let Some(handle) = self.handle.take() {
            let _ = handle.await;
        }
    }
}

/// 在 `127.0.0.1:0` / 指定地址上起对端服务端。返回的 `port` 是实际绑定端口
/// (传 0 时由内核分配,测试靠这个拿端口)。
pub async fn start_peer_server(
    identity: Arc<DeviceIdentity>,
    bind: SocketAddr,
    handler: PeerHandler,
) -> Result<PeerServer, std::io::Error> {
    let listener = TcpListener::bind(bind).await?;
    let port = listener.local_addr()?.port();
    let (shutdown_tx, mut shutdown_rx) = oneshot::channel();
    let active = Arc::new(AtomicUsize::new(0));

    let handle = tokio::spawn(async move {
        loop {
            let accepted = tokio::select! {
                biased;
                _ = &mut shutdown_rx => break,
                accepted = listener.accept() => accepted,
            };
            let Ok((stream, remote_addr)) = accepted else {
                continue;
            };

            // 超出并发上限:直接断开,防止单点打开大量连接耗尽资源
            if active.load(Ordering::Relaxed) >= MAX_PEER_CONNECTIONS {
                drop(stream);
                continue;
            }
            active.fetch_add(1, Ordering::Relaxed);

            let identity = Arc::clone(&identity);
            let handler = Arc::clone(&handler);
            let active = Arc::clone(&active);
            tokio::spawn(async move {
                let result = run_server_handshake(stream, remote_addr, identity, port).await;
                if let Ok(connection) = result {
                    handler(connection).await;
                }
                active.fetch_sub(1, Ordering::Relaxed);
            });
        }
    });

    Ok(PeerServer {
        port,
        shutdown: Some(shutdown_tx),
        handle: Some(handle),
    })
}

fn ws_config() -> WebSocketConfig {
    WebSocketConfig {
        max_message_size: Some(MAX_MESSAGE_BYTES),
        max_frame_size: Some(MAX_MESSAGE_BYTES),
        ..Default::default()
    }
}

/// 服务端握手:先收对端公钥 → 回自己公钥 → 收 kx → 回 kx。
///
/// 顺序与 Node 完全一致。注意本端**先收后发**,所以连接方发公钥后必须等本端回应,
/// 不能假定可以立刻收到 kx —— 顺序反了会互锁。
async fn run_server_handshake(
    stream: TcpStream,
    remote_addr: SocketAddr,
    identity: Arc<DeviceIdentity>,
    listen_port: u16,
) -> Result<PeerConnection, HandshakeFailure> {
    let handshake = async {
        let mut socket = tokio_tungstenite::accept_async_with_config(stream, Some(ws_config()))
            .await
            .map_err(|e| HandshakeFailure::Protocol(e.to_string()))?;

        // 第一阶段:对端公钥 → 设备 ID
        let peer_public_key_pem = loop {
            match socket.next().await {
                Some(Ok(WsMessage::Text(text))) => break text.to_string(),
                Some(Ok(WsMessage::Binary(bytes))) => {
                    // 公钥阶段用二进制帧没有意义,但按文本解释即可(宽进)
                    break String::from_utf8_lossy(&bytes).to_string();
                }
                Some(Ok(WsMessage::Ping(_))) | Some(Ok(WsMessage::Pong(_))) => continue,
                Some(Ok(WsMessage::Close(_))) | Some(Err(_)) | None => {
                    return Err(HandshakeFailure::Closed)
                }
                Some(Ok(WsMessage::Frame(_))) => continue,
            }
        };
        let peer_device_id = derive_device_id(&peer_public_key_pem);
        socket
            .send(WsMessage::Text(identity.public_key_pem.clone()))
            .await
            .map_err(|e| HandshakeFailure::Protocol(e.to_string()))?;

        // 第二阶段:签名后的 X25519 密钥交换
        let kx_text = loop {
            match socket.next().await {
                Some(Ok(WsMessage::Text(text))) => break text.to_string(),
                Some(Ok(WsMessage::Binary(bytes))) => {
                    break String::from_utf8_lossy(&bytes).to_string()
                }
                Some(Ok(WsMessage::Ping(_))) | Some(Ok(WsMessage::Pong(_))) => continue,
                Some(Ok(WsMessage::Close(_))) | Some(Err(_)) | None => {
                    return Err(HandshakeFailure::Closed)
                }
                Some(Ok(WsMessage::Frame(_))) => continue,
            }
        };
        let kx = decode_kx_message(&kx_text)?;
        let peer_x25519 = verify_kx_message(&kx, &peer_public_key_pem)?;

        let session_pair = X25519KeyPair::generate();
        let our_kx = build_kx_message(&session_pair, &identity, Some(listen_port), PEER_CAPS)?;
        socket
            .send(WsMessage::Text(crate::handshake::encode_kx_message(
                &our_kx,
            )))
            .await
            .map_err(|e| HandshakeFailure::Protocol(e.to_string()))?;

        let session_key = derive_session_key(&session_pair, &peer_x25519);
        Ok::<_, HandshakeFailure>(PeerConnection {
            device_id: peer_device_id,
            session_key,
            listen_port: kx.listen_port,
            caps: kx.caps,
            remote_addr,
            socket,
        })
    };

    match tokio::time::timeout(
        std::time::Duration::from_millis(HANDSHAKE_TIMEOUT_MS),
        handshake,
    )
    .await
    {
        Ok(result) => result,
        Err(_) => Err(HandshakeFailure::Timeout),
    }
}

/// 握手失败原因。只用于日志 —— 对端一律直接断开,不回错误细节(不泄露时序信息)。
#[derive(Debug)]
enum HandshakeFailure {
    Timeout,
    Closed,
    Protocol(String),
}

impl From<crate::handshake::HandshakeError> for HandshakeFailure {
    fn from(error: crate::handshake::HandshakeError) -> Self {
        Self::Protocol(error.to_string())
    }
}

impl std::fmt::Display for HandshakeFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Timeout => write!(f, "握手超时"),
            Self::Closed => write!(f, "握手期间连接关闭"),
            Self::Protocol(reason) => write!(f, "握手协议错误:{reason}"),
        }
    }
}
