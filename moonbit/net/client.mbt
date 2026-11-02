///|
/// 对端 WebSocket 传输层(客户端)。对应 Node `src/net/client.ts` 的
/// connectPeer 与 Rust `rust/crates/syncx-net/src/client.rs`。
///
/// WebSocket 客户端直接用 moonbitlang/async 的 `@websocket.Conn`:RFC 6455
/// 客户端握手、客户端→服务端帧掩码、分片收发、ping/pong、close 都是现成的,
/// 不再手写(任务书里的「没有就手写」分支不成立)。本层补的是 syncx 的
/// 契约:64MB 单条消息上限(对齐 Rust 的 ws_config)与两阶段握手流程。
///
/// 与服务端对称:先发本机公钥 → 收对端公钥 → 发 kx → 收 kx。顺序不能与
/// 一方对调 —— 握手是无显式协商的固定脚本,任一侧改顺序都会互锁。

///|
/// 连接结果:握手完成后的对端连接。
pub struct PeerClient {
  conn : @websocket.Conn
  /// 远端设备 ID。Secure 模式握手后已知;Plain 模式未定(None),由调用方
  /// 从对端 Hello 消息自行确认。
  peer_device_id : String?
  /// 会话密钥。Secure 模式协商产物;明文模式恒 None。
  session_key : Bytes?
  /// 对端能力标签(None = 旧版对端,数据面走文本信封)。
  caps : Array[String]?
  /// 对端在 kx 里广播的监听端口(旧版对端 None)。
  listen_port : Int32?
}

///|
/// 已连接对端的设备 ID(Secure 模式)。
pub fn PeerClient::remote_device_id(self : PeerClient) -> String? {
  self.peer_device_id
}

///|
/// 会话密钥(Secure 模式;明文模式 None)。
pub fn PeerClient::session_key(self : PeerClient) -> Bytes? {
  self.session_key
}

///|
/// 对端是否宣告二进制信封能力。
pub fn PeerClient::supports_binary(self : PeerClient) -> Bool {
  match self.caps {
    Some(caps) => {
      let mut found = false
      for c in caps {
        if c == CAP_BINARY1 {
          found = true
        }
      }
      found
    }
    None => false
  }
}

///|
/// 连接一个对端并完成握手。
///
/// `listen_port` 写进本机 kx,让接收方结合源 IP 反向重连本机。
/// Plain 模式下握手直接跳过,`listen_port` 无用。
pub async fn connect_peer(
  mode : PeerHandshakeMode,
  url : String,
  listen_port~ : Int32? = None,
) -> PeerClient raise PeerError {
  // `Conn::connect` 的 raise 是无类型的 Error,模式匹配拿不到构造器;WS
  // 升级被拒与非 101 的判定按错误文本分类(与 async 包自身测试同一口径)。
  let conn = @websocket.Conn::connect(url) catch {
    e => {
      let text = @debug.to_string(e)
      if text.contains("HandshakeRejected") || text.contains("InvalidHandshake") {
        raise PeerError::Handshake("WebSocket 升级被拒:\{text}")
      }
      raise PeerError::Transport("WebSocket 连接失败:\{text}")
    }
  }
  match mode {
    Plain =>
      {
        conn,
        peer_device_id: None,
        session_key: None,
        caps: None,
        listen_port: None,
      }
    Secure(identity) => {
      // 第一阶段:发本机公钥,收对端公钥
      conn.send_text(identity.public_key_pem) catch {
        e => raise PeerError::Transport("发送公钥失败:\{e}")
      }
      let peer_pem = expect_text(conn, "对端公钥")
      // 服务端公钥形态必须合法 —— 设备 ID 才可信
      let _ = parse_public_key_pem(peer_pem) catch {
        e => raise PeerError::Handshake(e.to_text())
      }
      // 第二阶段:发签名 kx,收对端 kx
      let pair = X25519KeyPair::generate() catch {
        e => raise PeerError::Handshake(e.to_text())
      }
      let our_kx = build_kx_message(pair, identity, listen_port, peer_caps()) catch {
        e => {
          conn.close()
          raise PeerError::Handshake(e.to_text())
        }
      }
      conn.send_text(encode_kx_message(our_kx)) catch {
        e => raise PeerError::Transport("发送 kx 失败:\{e}")
      }
      let kx_text = expect_text(conn, "对端 kx")
      let kx = decode_kx_message(kx_text) catch {
        e => raise PeerError::Handshake(e.to_text())
      }
      let peer_public = verify_kx_message(kx, peer_pem) catch {
        e => raise PeerError::Handshake(e.to_text())
      }
      let session_key = derive_session_key(pair, peer_public) catch {
        e => raise PeerError::Handshake(e.to_text())
      }
      {
        conn,
        peer_device_id: Some(derive_device_id(peer_pem)),
        session_key: Some(session_key),
        caps: kx.caps,
        listen_port: kx.listen_port,
      }
    }
  }
}

///|
/// 读一条文本消息(握手阶段用;二进制帧按文本宽进,与 Rust read_text 同口径)。
async fn expect_text(
  conn : @websocket.Conn,
  what : String,
) -> String raise PeerError {
  let msg = conn.recv() catch {
    e => raise PeerError::Transport("读取 \{what} 失败:\{e}")
  }
  let bytes = read_message_capped(msg)
  @utf8.decode_lossy(bytes)
}

///|
/// 流式读整条消息并强制 64MB 上限:超限即弃,不为对端的巨帧买单内存。
async fn read_message_capped(msg : @websocket.Message) -> Bytes raise PeerError {
  let buf = @buffer.Buffer()
  let chunk : FixedArray[Byte] = FixedArray::make(65536, b'\x00')
  let cap = MAX_MESSAGE_BYTES.to_int()
  let mut done = false
  while !done {
    let n = msg.read(chunk) catch {
      e => raise PeerError::Transport("读取消息失败:\{e}")
    }
    if n == 0 {
      done = true
    } else {
      if buf.length() + n > cap {
        raise PeerError::TooLarge("入站消息超出 64MB 上限")
      }
      buf.write_bytes(chunk.unsafe_reinterpret_as_bytes()[0:n])
    }
  }
  buf.to_bytes()
}

///|
/// 收下一帧(文本或二进制),阻塞到对端发来为止。连接关闭/出错抛 Transport。
pub async fn PeerClient::recv_frame(
  self : PeerClient,
) -> PeerFrame raise PeerError {
  let msg = self.conn.recv() catch {
    e => raise PeerError::Transport("读取帧失败:\{e}")
  }
  let bytes = read_message_capped(msg)
  match msg.kind {
    Text => PeerFrame::Text(@utf8.decode_lossy(bytes))
    Binary => PeerFrame::Binary(bytes)
  }
}

///|
/// 收一条 wire 消息(文本信封解码)。
pub async fn PeerClient::recv_message(
  self : PeerClient,
) -> WireMessage raise PeerError {
  let frame = self.recv_frame()
  match frame {
    PeerFrame::Text(text) =>
      decode_wire_message(text) catch {
        e => raise PeerError::Transport(e.to_text())
      }
    PeerFrame::Binary(_) =>
      raise PeerError::Transport(
        "二进制帧不是文本信封(二进制信封是后续里程碑)",
      )
  }
}

///|
/// 发一条 wire 消息(文本信封编码)。
pub async fn PeerClient::send_message(
  self : PeerClient,
  message : WireMessage,
) -> Unit raise PeerError {
  self.send_text(encode_wire_message(message))
}

///|
/// 发一条文本帧(超 64MB 拒发,不进 socket)。
pub async fn PeerClient::send_text(
  self : PeerClient,
  text : String,
) -> Unit raise PeerError {
  if @utf8.encode(text).length() > MAX_MESSAGE_BYTES.to_int() {
    raise PeerError::TooLarge("出站文本帧超出 64MB 上限")
  }
  self.conn.send_text(text) catch {
    e => raise PeerError::Transport("发送失败:\{e}")
  }
}

///|
/// 发一条二进制帧(超 64MB 拒发)。
pub async fn PeerClient::send_binary(
  self : PeerClient,
  data : Bytes,
) -> Unit raise PeerError {
  if data.length() > MAX_MESSAGE_BYTES.to_int() {
    raise PeerError::TooLarge("出站二进制帧超出 64MB 上限")
  }
  self.conn.send_binary(data) catch {
    e => raise PeerError::Transport("发送失败:\{e}")
  }
}

///|
/// 发 ping 并等服务端回 pong(pong 由 `recv_frame` 的读循环驱动 —— 没人在
/// 收帧时调用本函数会死等,与 @websocket 的约定一致)。
pub async fn PeerClient::ping(self : PeerClient) -> Unit raise PeerError {
  self.conn.ping() catch {
    e => raise PeerError::Transport("ping 失败:\{e}")
  }
}

///|
/// 关闭连接(底层 TCP 一并关闭)。
pub fn PeerClient::close(self : PeerClient) -> Unit {
  self.conn.close()
}

///|
/// 客户端事件回调(驱动 `PeerClient::run` 的分发循环)。
pub(all) struct PeerClientHandlers {
  on_message : (WireMessage) -> Unit
  on_binary : (Bytes) -> Unit
  on_error : (String) -> Unit
  on_close : () -> Unit
}

///|
/// 常驻收发循环:收到的文本帧解码后交 `on_message`,二进制帧交
/// `on_binary`,畸形消息只记 `on_error`(不掀翻连接),连接结束回调
/// `on_close` 后返回。
///
/// 注:moonbitlang/async 的 async 调用携带不可捕获的取消错误,所以本函数
/// 不能声明 noraise;循环里的一切错误都在 try 里消化,正常路径不会抛。
/// 上层 spawn 时带 allow_failure 兜底即可。
pub async fn PeerClient::run(
  self : PeerClient,
  handlers : PeerClientHandlers,
) -> Unit {
  try {
    for ;; {
      let frame = self.recv_frame()
      match frame {
        PeerFrame::Text(text) => {
          let decoded : WireMessage? = Some(decode_wire_message(text)) catch {
            e => {
              (handlers.on_error)("丢弃畸形消息:\{e.to_text()}")
              None
            }
          }
          match decoded {
            Some(message) => (handlers.on_message)(message)
            None => ()
          }
        }
        PeerFrame::Binary(data) => (handlers.on_binary)(data)
      }
    }
  } catch {
    _ => (handlers.on_close)()
  }
}
