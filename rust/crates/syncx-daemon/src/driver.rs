//! 连接驱动:把一条已握手的对端连接接上会话层。
//!
//! 职责边界很窄 —— **只搬帧,不做同步决策**:
//!
//!  - 收:解信封 → 转成 [`Cmd`] 投递给 actor;
//!  - 发:从 actor 给自己的 `mpsc` 里取出 [`Outbound`] → 编信封 → 写 socket。
//!
//! 同步语义(规划、块重试、冲突)全在 [`crate::peer`],actor 是唯一碰状态的地方。
//! 这样做的直接好处:驱动层是 `Send` 的、可以跑在 tokio 上,而会话状态里的 `Rc`
//! 从不出现在异步任务里。
//!
//! 信封选择与 Node 的 `makePeerTransport` / `attachPeerMessages` 一一对应:
//! 对端宣告 `binary1` 时,索引与块响应走二进制帧(省两次 base64),其余走文本。

use syncx_net::server::{Frame, PeerConnection};
use syncx_net::wire::{
    decode_binary_frame, decode_index, encode_binary_frame, encode_index, BinaryFrameKind,
    WireMessage,
};

use crate::actor::{ActorHandle, Cmd};
use crate::peer::{IndexMode, Outbound};

/// 一条连接在 actor 里的地址:`(目录 id, 连接槽位)`。
#[derive(Debug, Clone)]
pub struct PeerAddr {
    pub folder: String,
    pub slot: usize,
}

/// 起一个占位会话层并返回它的出站通道。
///
/// 由 actor 线程上的 [`crate::actor::Folder::open_peer`] 真正创建;这里只是给上层
/// 一个「先建通道、再交给驱动」的构造顺序。
pub fn open_peer_channel() -> (
    tokio::sync::mpsc::UnboundedSender<Outbound>,
    tokio::sync::mpsc::UnboundedReceiver<Outbound>,
) {
    tokio::sync::mpsc::unbounded_channel()
}

/// 把一条**已握手**的连接挂到一个目录上,并一路跑到断开。
///
/// 这是「连接 → actor」的唯一装配点,两种入站方式(对端连进来、本机连出去)都走它:
/// 槽位由 actor 分配,分配失败(目录不存在 / actor 已退出)就直接关连接。
///
/// `folder` 必须是对端的目录标识(与 wire 里的 `folder` 字段同一取值),否则
/// actor 找不到目录、这条连接白连。
pub async fn serve_connection(
    connection: PeerConnection,
    actor: ActorHandle,
    folder: impl Into<String>,
) -> Option<()> {
    serve_session(connection, actor, vec![folder.into()]).await
}

/// 一条连接上挂**多个**共享目录(与 Node 的「一个 socket、按 folder 路由」一致)。
///
/// 生产装配走这条:同一对端之间只维持一条连接,每个共享目录各占 actor 里的一个
/// 槽位。`folders` 为空等于「只建控制面会话」—— 不挂任何目录,但连接照常收发
/// 控制帧(配对 / 邀请),这正是新设备尚未互信时的形态。
///
/// 任一目录挂载失败(目录已被移除)只跳过那一个,不让整条连接作废。
pub async fn serve_session(
    connection: PeerConnection,
    actor: ActorHandle,
    folders: Vec<String>,
) -> Option<()> {
    serve_session_with_control(connection, actor, folders, None).await
}

/// 带控制面回调的 [`serve_session`]。
pub async fn serve_session_with_control(
    connection: PeerConnection,
    actor: ActorHandle,
    folders: Vec<String>,
    control: Option<ControlHooks>,
) -> Option<()> {
    let remote_device_id = connection.device_id.clone();
    // 各目录的出站帧汇进**一条**通道:连接只有一个写端,按目录分流会让写顺序
    // 与 actor 的投递顺序不一致(块响应被后到的索引帧挤后),对端看见的就是乱序。
    let (merged_tx, merged_rx) =
        tokio::sync::mpsc::unbounded_channel::<(String, Outbound)>();
    let mut slots: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for folder in folders {
        if slots.contains_key(&folder) {
            continue;
        }
        let (sink, mut outbound) = open_peer_channel();
        let Some(slot) = actor
            .attach_peer(folder.clone(), remote_device_id.clone(), sink)
            .await
        else {
            // 目录不存在(可能刚被移除):跳过这一个,其余目录照常挂
            continue;
        };
        let tag = folder.clone();
        let merged = merged_tx.clone();
        // 转发任务在整流通道关闭后自行退出(那时 `send` 返回 Err)
        tokio::spawn(async move {
            while let Some(frame) = outbound.recv().await {
                if merged.send((tag.clone(), frame)).is_err() {
                    break;
                }
            }
        });
        slots.insert(folder, slot);
    }
    // 丢掉模板克隆:否则整流通道在本任务存活期间永不关闭
    drop(merged_tx);

    // 会话建立后的第一件事就是初始索引交换(指纹 → ack/request,兜底发全量)。
    // 必须在这里发:驱动任务一旦进入收发循环,就没有「建立」这个时机了。
    for (folder, peer) in &slots {
        actor.send(Cmd::PeerOpen {
            folder: folder.clone(),
            peer: *peer,
        });
    }
    drive_session_with_control(connection, actor, slots, merged_rx, control).await;
    Some(())
}

/// 控制面消息的接收端,由装配层实现。
///
/// 收到的每条控制消息都附带一条**回到对端的出站通道** —— 控制面自己决定要不要
/// 回、回什么。用回调而不是内置台账,是因为控制面同时要读写 config、要向别的
/// 设备转发,这些都不该让连接驱动知道。
#[derive(Clone)]
pub struct ControlLink {
    /// 这条连接的远端设备 id(与握手一致,不可由消息体自带字段替代)。
    pub device_id: String,
    /// 沿这条连接回消息。连接已断时 `send` 返回 `Err`。
    pub outbound: tokio::sync::mpsc::UnboundedSender<syncx_net::wire::ControlMessage>,
}

pub type ControlSink = std::sync::Arc<dyn Fn(ControlLink, syncx_net::wire::ControlMessage) + Send + Sync>;

/// 连接生命周期钩子:`open` 在会话挂上之后、进入收发循环之前调用一次,
/// 让控制面拿到**本连接的出站通道**(hello / 目录清单 / 邀请都靠它首发);
/// `close` 在连接结束时调用,用于把会话从控制面台账里摘掉。
///
/// 只给 `ControlLink::outbound` 的克隆而不是整个 `ControlLink`,是因为控制面
/// 往往要把这条通道存进按设备索引的 map,存 `ControlLink` 会连带复制 `device_id`
/// 造成两份真相。
pub struct ControlHooks {
    pub open: std::sync::Arc<dyn Fn(ControlLink) + Send + Sync>,
    pub message: ControlSink,
    pub close: std::sync::Arc<dyn Fn(&str) + Send + Sync>,
}

/// 把一条连接跑完(不接管控制面)。
///
/// 返回即表示连接已断:不管是读循环结束、写失败还是 [`PeerConnection::recv`] 返回
/// `None`。退出前一定投递 [`Cmd::PeerClose`],否则会话层的认领会挂到保鲜期过。
pub async fn drive_connection(
    connection: PeerConnection,
    actor: ActorHandle,
    addr: PeerAddr,
    outbound: tokio::sync::mpsc::UnboundedReceiver<Outbound>,
) {
    drive_connection_with_control(connection, actor, addr, outbound, None).await
}

/// 带控制面回调的 [`drive_connection`]。
///
/// 控制帧与目录帧走同一条连接、共用同一个 `select!`:控制面回消息只需往
/// [`ControlLink::outbound`] 里塞一条,驱动会按收发顺序把它写出去。
pub async fn drive_connection_with_control(
    connection: PeerConnection,
    actor: ActorHandle,
    addr: PeerAddr,
    outbound: tokio::sync::mpsc::UnboundedReceiver<Outbound>,
    control: Option<ControlHooks>,
) {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<(String, Outbound)>();
    let tag = addr.folder.clone();
    tokio::spawn(async move {
        let mut outbound = outbound;
        while let Some(frame) = outbound.recv().await {
            if tx.send((tag.clone(), frame)).is_err() {
                break;
            }
        }
    });
    let mut slots = std::collections::HashMap::new();
    slots.insert(addr.folder, addr.slot);
    drive_session_with_control(connection, actor, slots, rx, control).await
}

/// 多目录连接的收发循环。`slots` 是「目录 id → actor 槽位」,`outbound` 里每条帧
/// 自带它属于哪个目录 —— 与 Node 在同一个 socket 上按 `folder` 字段路由同构。
pub async fn drive_session_with_control(
    mut connection: PeerConnection,
    actor: ActorHandle,
    slots: std::collections::HashMap<String, usize>,
    mut outbound: tokio::sync::mpsc::UnboundedReceiver<(String, Outbound)>,
    control: Option<ControlHooks>,
) {
    // 本端能力在握手时已协商:对端宣告 binary1 才用二进制信封
    let binary = connection.supports_binary();
    let key = connection.session_key;

    // 控制面出站通道。持有发送端的克隆可以保证 `recv` 在本连接存活期间永不返回
    // `None`,所以不需要在循环里写「通道空了就禁用这个分支」。
    let (control_tx, mut control_rx) = tokio::sync::mpsc::unbounded_channel::<
        syncx_net::wire::ControlMessage,
    >();
    let link = ControlLink {
        device_id: connection.device_id.clone(),
        outbound: control_tx,
    };

    // 会话已挂上、收发循环还没开始 —— 控制面在这里注册出站通道并发首帧
    // (hello / 目录清单 / 配对请求)。放在循环之前是必须的:循环里没有「刚连上」这个时机。
    if let Some(hooks) = &control {
        (hooks.open)(link.clone());
    }

    // 读与写放在同一个任务里用 `select!` 交替做 —— 不 split socket。这样块请求
    // 不会因为写阻塞而停止进来,也不需要把连接拆成两半再重新拼。
    loop {
        tokio::select! {
            biased;
            // 出站优先:块响应压着不发会让对端超时重试,越积越多
            frame = outbound.recv() => {
                let Some((folder, frame)) = frame else { break };
                let Ok(bytes) = send_outbound(&mut connection, binary, &key, &folder, frame).await
                else {
                    break;
                };
                // 只对块响应记账:发送窗口的语义是「已生成、还没离开本机的**块字节**」,
                // 索引与控制帧不参与窗口判定,多扣会把窗口提前关上
                if bytes > 0 {
                    if let Some(slot) = slots.get(&folder) {
                        actor.send(Cmd::Flushed {
                            folder: folder.clone(),
                            peer: *slot,
                            bytes,
                        });
                    }
                }
            }
            // 控制面插话:与目录帧共用一条连接,直接写成 Control 信封
            payload = control_rx.recv() => {
                let Some(payload) = payload else { break };
                let message = WireMessage::Control { payload };
                let Ok(encrypted) = syncx_net::wire::encrypt_message(&key, &message) else {
                    break;
                };
                if connection.send_text(&encrypted).await.is_err() {
                    break;
                }
            }
            incoming = connection.recv() => {
                let Some(frame) = incoming else { break };
                if !handle_incoming(&actor, &slots, &key, binary, control.as_ref(), &link, frame) {
                    break;
                }
            }
        }
    }

    if let Some(hooks) = &control {
        (hooks.close)(&connection.device_id);
    }
    for (folder, peer) in slots {
        actor.send(Cmd::PeerClose { folder, peer });
    }
    connection.close().await;
}

/// 收一帧:解信封 → 按帧里的 `folder` 找到槽位 → 投递命令。返回 `false` 表示连接应终止。
///
/// **目录来自帧本身,不是连接** —— 一条连接承载全部共享目录,和 Node 同构。帧里的
/// 目录不在本连接的槽位表里(对端还没获准,或本机刚移除该目录)就静默丢弃:那是
/// 对端单方面的声明,不该在本机凭空建出会话。
fn handle_incoming(
    actor: &ActorHandle,
    slots: &std::collections::HashMap<String, usize>,
    key: &[u8; 32],
    binary: bool,
    control: Option<&ControlHooks>,
    link: &ControlLink,
    frame: Frame,
) -> bool {
    match frame {
        Frame::Binary(bytes) => {
            // 只有能力协商通过的对端会发二进制帧;坏帧静默丢弃(对端不可信)
            if !binary {
                tracing::debug!("binary frame but caps not negotiated; dropped");
                return true;
            }
            let Some(decoded) = decode_binary_frame(key, &bytes) else {
                tracing::debug!("binary frame failed to decode");
                return true;
            };
            let folder = text_field(&decoded.header, "folder");
            let Some(slot) = slots.get(&folder).copied() else {
                tracing::debug!(%folder, "binary frame for an unwatched folder; dropped");
                return true;
            };
            if decoded.kind == BinaryFrameKind::Index {
                let entries = match decode_index(&decoded.body) {
                    Ok(entries) => entries,
                    Err(error) => {
                        tracing::warn!(%error, body = %String::from_utf8_lossy(&decoded.body), "index body failed to decode");
                        return true;
                    }
                };
                let mode = if decoded.header["full"] == serde_json::json!(true) {
                    IndexMode::Full
                } else {
                    IndexMode::Delta
                };
                tracing::debug!(%folder, slot, count = entries.len(), full = mode == IndexMode::Full, "peer index");
                actor.send(Cmd::PeerIndex {
                    folder,
                    peer: slot,
                    entries,
                    mode,
                    relayed: decoded.header["relayed"] == serde_json::json!(true),
                });
            } else {
                // 二进制块响应的字节全在 body 里,header 只带定位信息
                actor.send(Cmd::PeerBlockResponse {
                    folder,
                    peer: slot,
                    response: syncx_net::wire::WireBlockResponse {
                        device_id: text_field(&decoded.header, "deviceId"),
                        path: text_field(&decoded.header, "path"),
                        block_index: decoded.header["blockIndex"].as_u64().unwrap_or(u64::MAX),
                        hash: text_field(&decoded.header, "hash"),
                        data: base64_encode(&decoded.body),
                        cdc: (decoded.header["cdc"] == serde_json::json!(true)).then_some(true),
                    },
                });
            }
            true
        }
        Frame::Text(text) => {
            let Ok(message) = syncx_net::wire::decrypt_message(key, &text) else {
                tracing::debug!("undecryptable text frame");
                return true; // 解密/认证失败(篡改或噪声),忽略
            };
            // 控制面没有目录维度,先分流出去;其余帧一律按自带的 `folder` 路由
            let (folder, routed) = match message {
                WireMessage::Control { payload } => {
                    if let Some(hooks) = control {
                        (hooks.message)(link.clone(), payload);
                    }
                    return true;
                }
                WireMessage::Index {
                    folder,
                    payload,
                    full,
                    relayed,
                } => {
                    let Ok(body) = base64_decode(&payload) else {
                        return true;
                    };
                    let Ok(entries) = decode_index(&body) else {
                        return true;
                    };
                    (
                        folder,
                        Routed::Index {
                            entries,
                            mode: if full == Some(true) {
                                IndexMode::Full
                            } else {
                                IndexMode::Delta
                            },
                            relayed: relayed == Some(true),
                        },
                    )
                }
                WireMessage::IndexFingerprint { folder, fingerprint } => {
                    (folder, Routed::IndexFingerprint(fingerprint))
                }
                WireMessage::IndexAck { folder } => (folder, Routed::IndexAck),
                WireMessage::IndexRequest { folder } => (folder, Routed::IndexRequest),
                WireMessage::BlockRequest { folder, payload } => {
                    (folder, Routed::BlockRequest(payload))
                }
                WireMessage::BlockResponse { folder, payload } => {
                    (folder, Routed::BlockResponse(payload))
                }
            };
            let Some(slot) = slots.get(&folder).copied() else {
                tracing::debug!(%folder, "frame for an unwatched folder; dropped");
                return true;
            };
            match routed {
                Routed::Index {
                    entries,
                    mode,
                    relayed,
                } => {
                    actor.send(Cmd::PeerIndex {
                        folder,
                        peer: slot,
                        entries,
                        mode,
                        relayed,
                    });
                }
                Routed::IndexFingerprint(fingerprint) => {
                    actor.send(Cmd::PeerIndexFingerprint {
                        folder,
                        peer: slot,
                        fingerprint,
                    });
                }
                Routed::IndexAck => {
                    actor.send(Cmd::PeerIndexAck {
                        folder,
                        peer: slot,
                    });
                }
                Routed::IndexRequest => {
                    actor.send(Cmd::PeerIndexRequest {
                        folder,
                        peer: slot,
                    });
                }
                Routed::BlockRequest(request) => {
                    actor.send(Cmd::PeerBlockRequest {
                        folder,
                        peer: slot,
                        request,
                    });
                }
                Routed::BlockResponse(response) => {
                    actor.send(Cmd::PeerBlockResponse {
                        folder,
                        peer: slot,
                        response,
                    });
                }
            }
            true
        }
    }
}

/// 已解出、待按目录投递的一条文本帧。
enum Routed {
    Index {
        entries: Vec<syncx_net::wire::WireEntry>,
        mode: IndexMode,
        relayed: bool,
    },
    IndexFingerprint(String),
    IndexAck,
    IndexRequest,
    BlockRequest(syncx_net::wire::WireBlockRequest),
    BlockResponse(syncx_net::wire::WireBlockResponse),
}

/// 发一条出站帧,返回该帧占用的**发送窗口字节数**(非块响应返回 0)。
async fn send_outbound(
    connection: &mut PeerConnection,
    binary: bool,
    key: &[u8; 32],
    folder: &str,
    frame: Outbound,
) -> Result<usize, syncx_net::wire::WireError> {
    match frame {
        Outbound::Entries { entries, full, relayed } => {
            if binary {
                let body = encode_index(&entries);
                let header = serde_json::json!({
                    "folder": folder,
                    "full": full,
                    "relayed": relayed,
                });
                let bytes = encode_binary_frame(key, BinaryFrameKind::Index, &header, &body)?;
                connection.send_binary(bytes).await?;
                Ok(0)
            } else {
                let message = WireMessage::Index {
                    folder: folder.to_string(),
                    payload: base64_encode(&encode_index(&entries)),
                    full: Some(full),
                    relayed: Some(relayed),
                };
                let encrypted = syncx_net::wire::encrypt_message(key, &message)?;
                connection.send_text(&encrypted).await?;
                Ok(0)
            }
        }
        Outbound::BlockRequest(request) => {
            let message = WireMessage::BlockRequest {
                folder: folder.to_string(),
                payload: request,
            };
            let encrypted = syncx_net::wire::encrypt_message(key, &message)?;
            connection.send_text(&encrypted).await?;
            Ok(0)
        }
        Outbound::BlockResponse(response) => {
            // 与 peer 侧记账口径一致(见 Peer::serve_block):present 的 base64 长度 + 协议余量。
            // 解剖结构变了要同时改两处,否则窗口会慢慢漂。
            let charged = response.data.len() + 512;
            if binary {
                let Ok(data) = base64_decode(&response.data) else {
                    return Ok(0);
                };
                let header = serde_json::json!({
                    "folder": folder,
                    "deviceId": response.device_id,
                    "path": response.path,
                    "blockIndex": response.block_index,
                    "hash": response.hash,
                    "cdc": response.cdc == Some(true),
                });
                let bytes = encode_binary_frame(
                    key,
                    BinaryFrameKind::BlockResponse,
                    &header,
                    &data,
                )?;
                connection.send_binary(bytes).await?;
                Ok(charged)
            } else {
                let message = WireMessage::BlockResponse {
                    folder: folder.to_string(),
                    payload: response,
                };
                let encrypted = syncx_net::wire::encrypt_message(key, &message)?;
                connection.send_text(&encrypted).await?;
                Ok(charged)
            }
        }
        Outbound::IndexFingerprint(fingerprint) => {
            let message = WireMessage::IndexFingerprint {
                folder: folder.to_string(),
                fingerprint,
            };
            let encrypted = syncx_net::wire::encrypt_message(key, &message)?;
            connection.send_text(&encrypted).await?;
            Ok(0)
        }
        Outbound::IndexAck => {
            let message = WireMessage::IndexAck {
                folder: folder.to_string(),
            };
            let encrypted = syncx_net::wire::encrypt_message(key, &message)?;
            connection.send_text(&encrypted).await?;
            Ok(0)
        }
        Outbound::IndexRequest => {
            let message = WireMessage::IndexRequest {
                folder: folder.to_string(),
            };
            let encrypted = syncx_net::wire::encrypt_message(key, &message)?;
            connection.send_text(&encrypted).await?;
            Ok(0)
        }
    }
}

fn text_field(header: &serde_json::Value, name: &str) -> String {
    header[name].as_str().unwrap_or_default().to_string()
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn base64_decode(text: &str) -> Result<Vec<u8>, base64::DecodeError> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(text)
}
