//! 对端服务端/客户端、握手、wire 编解码、mDNS 发现。
//!
//! `serde` 模型必须逐字对齐 Node 侧 `src/net/wire.ts` —— 包括那些历史坑:
//! `full?: boolean` 缺省视为增量、控制消息里用 `entryVersion` 而非 `version`。
//!
//! 模块分层:
//!
//! - [`identity`]:设备身份与 Device ID 派生(必须与 Node 逐位一致);
//! - [`handshake`]:两阶段握手(Ed25519 验身份 + X25519 协商会话密钥);
//! - `wire`:消息模型与文本/二进制两种信封;
//! - `server` / `client`:对端连接的两端;
//! - `blockio`:单文件的分块读写与哈希校验;
//! - `discovery`:mDNS 广播与发现。

pub mod blockio;
pub mod client;
pub mod discovery;
pub mod handshake;
pub mod identity;
pub mod server;
pub mod wire;

pub use client::{connect_peer, ConnectedPeer};
pub use discovery::{start_discovery, DiscoveredPeer, Discovery};
pub use handshake::{CAP_BINARY1, PEER_CAPS};
pub use identity::DeviceIdentity;
pub use server::{start_peer_server, PeerConnection, PeerServer};
pub use wire::{WireError, WireMessage, MAX_MESSAGE_BYTES};
