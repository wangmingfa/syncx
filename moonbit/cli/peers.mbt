///|
/// 出站拨号 + 断线重连 + 会话注册表(cli 装配层)。对应 Node
/// session-manager.ts 的 connectTo / scheduleReconnect / 对端元数据
/// (peerInfo)职责的最小子集:
///   - 启动时对 config.peers 的 ws:// 地址逐一起常驻拨号循环,断线按指数
///     退避重拨(曲线与 Node reconnectDelayMs 同口径);
///   - 会话建立后主动发 hello,收到的 hello(Control)解析进会话注册表,
///     对端元数据生命周期跟随会话(断开即失效);
///   - git 提交通知/回执(Control 面)接镜像循环(见 gitmirror.mbt):
///     通知处理到即回回执,结算由镜像循环闸门负责;
///   - 明确不做(后续包):地址学习(learnedUrl / 反向发现)、mDNS 建连、
///     Control 面其余消息(notify 扫描触发 / 中继)、配置热重载。

///|
/// 断线重连退避基数(ms):指数退避 1s、2s、4s…(Node RECONNECT_BASE_MS 同值)。
pub const RECONNECT_BASE_MS : Int = 1000

///|
/// 断线重连退避上限(ms)(Node RECONNECT_MAX_MS 同值)。
pub const RECONNECT_MAX_MS : Int = 30000

///|
/// 出站拨号监督循环的 diff 节拍(ms):每拍现读配置的 peers 清单,新 URL 补起
/// 拨号循环。配置热重载的「设备登记后立即建连」由这个节拍承担(3s 内跟上;
/// Node 是回调即拨,MoonBit 以轻量轮询等价,避免回调里碰网络)。
pub const DIAL_SUPERVISOR_TICK_MS : Int = 3000

///|
/// 断线重连退避延迟(ms),与 Node `reconnectDelayMs` 同曲线:`attempts` 为
/// 已连续失败次数,第 0 次(首连失败)立即重试(0ms)—— 避免双 daemon 同时
/// 启动时互相拒连把连接建立推到 30s 边缘 —— 之后 1s 起指数退避,30s 封顶。
/// 注:Node 还有「无网抬到 5 分钟下限」的 offlineAware 口径,依赖网络在线
/// 感知,MoonBit 尚未实现该探针,故不在此曲线内(后续包)。
pub fn reconnect_delay_ms(attempts : Int) -> Int {
  if attempts <= 0 {
    return 0
  }
  let mut delay = RECONNECT_BASE_MS
  let mut doublings = attempts - 1
  while doublings > 0 && delay < RECONNECT_MAX_MS {
    delay = delay * 2
    doublings = doublings - 1
  }
  if delay > RECONNECT_MAX_MS {
    RECONNECT_MAX_MS
  } else {
    delay
  }
}

///|
/// 一条活跃会话的对端元数据(hello 宣告;None = 对端还没发 hello / 未宣告)。
/// url = 该设备当前活跃连接的 ws:// 地址:出站会话是拨号地址;入站会话本端
/// 无从得知对端地址(地址学习是后续包),恒 None。
pub(all) struct PeerSessionMeta {
  version : String?
  platform : String?
  hostname : String?
  url : String?
}

///|
/// 会话注册表:deviceId → 活跃会话元数据。生命周期跟随会话(断开即失效,
/// 由装配层的 disconnect 钩子撤销);单线程 async,普通 Map 无锁。
pub struct PeerSessionRegistry {
  priv sessions : Map[String, PeerSessionMeta]
}

///|
pub fn PeerSessionRegistry::new() -> PeerSessionRegistry {
  { sessions: Map([]) }
}

///|
/// 按 deviceId 查询活跃会话元数据(无会话 = None)。
pub fn PeerSessionRegistry::lookup(
  self : PeerSessionRegistry,
  device_id : String,
) -> PeerSessionMeta? {
  self.sessions.get(device_id)
}

///|
/// 直接登记/覆盖一条会话元数据。
pub fn PeerSessionRegistry::register(
  self : PeerSessionRegistry,
  device_id : String,
  meta : PeerSessionMeta,
) -> Unit {
  self.sessions.set(device_id, meta)
}

///|
/// 会话撤销(断开钩子;幂等)。
pub fn PeerSessionRegistry::unregister(self : PeerSessionRegistry, device_id : String) -> Unit {
  self.sessions.remove(device_id)
}

///|
/// 活跃会话数(观测/测试用)。
pub fn PeerSessionRegistry::size(self : PeerSessionRegistry) -> Int {
  self.sessions.length()
}

///|
/// 当前活跃设备清单(观测/会话面对账用,配置热重载按它对账 sinks 与连接)。
pub fn PeerSessionRegistry::devices(self : PeerSessionRegistry) -> Array[String] {
  let out : Array[String] = []
  for device, _ in self.sessions {
    out.push(device)
  }
  out
}

///|
/// hello 驱动的登记/更新:元数据以 hello 为准(version 是 hello 必填字段,
/// wire 契约恒有值),url 保留已知值里的「Some」侧 —— 双方互拨时同一设备
/// 会有入站/出站两条会话,hello 从任一条到达都覆盖元数据,而 url 以出站
/// 拨号学到的为准(入站侧无从得知对端地址)。
pub fn PeerSessionRegistry::register_hello(
  self : PeerSessionRegistry,
  device_id : String,
  version : String,
  platform : String?,
  hostname : String?,
) -> Unit {
  let kept = match self.lookup(device_id) {
    Some(existing) => existing.url
    None => None
  }
  self.register(
    device_id,
    { version: Some(version), platform, hostname, url: kept },
  )
}

///|
/// 设备状态合并(纯函数):静态快照(knownDevices 折算的离线视图)+ 会话
/// 注册表 → `/api/status.devices` 数组。会话活着:online=true 且 version/
/// platform/hostname/url 逐字段上线(有值才写);断开回落静态快照原样
/// (online=false)。静态快照的元素不就地改写 —— 拷贝后改,快照仍是装配层
/// 的单一事实(device_infos 数组复用)。纯函数 + 注入注册表,两态可单测。
pub fn merge_device_status(
  static_infos : Array[Json],
  registry : PeerSessionRegistry,
) -> Array[Json] {
  let merged : Array[Json] = []
  for info in static_infos {
    match info {
      Object(map) => {
        let device_id = match map.get("deviceId") {
          Some(String(id)) => id
          _ => {
            merged.push(info)
            continue
          }
        }
        let out : Map[String, Json] = Map([])
        for key, value in map {
          out.set(key, value)
        }
        match registry.lookup(device_id) {
          Some(meta) => {
            out.set("online", Json::boolean(true))
            match meta.version {
              Some(v) => out.set("version", Json::string(v))
              None => ()
            }
            match meta.platform {
              Some(p) => out.set("platform", Json::string(p))
              None => ()
            }
            match meta.hostname {
              Some(h) => out.set("hostname", Json::string(h))
              None => ()
            }
            match meta.url {
              Some(u) => out.set("url", Json::string(u))
              None => ()
            }
          }
          None => ()
        }
        merged.push(Json::object(out))
      }
      other => merged.push(other)
    }
  }
  merged
}

// ==================== 会话接线与出站循环 ====================

///|
/// 设备会话的 actor 出站接线:按共享目录建 sinks + 出站泵任务(actor 的
/// Outbound 帧 → wire 消息 → `send` 闭包投递)。send 返回 false(连接已坏)
/// 即停泵。server 侧 / client 侧各自注入投递闭包;sinks 登记在 session_sinks,
/// 断开钩子按设备整体 close(与 PeerClose 命令一起,见 entry.mbt)。
fn spawn_session_pumps(
  group : @async.TaskGroup[Unit],
  handle : @daemon.ActorHandle,
  config : @core.Config,
  device_id : String,
  session_sinks : Map[String, Map[String, @async.Queue[@daemon.Outbound]]],
  send : async (@net.WireMessage) -> Bool,
) -> Unit {
  let per_device : Map[String, @async.Queue[@daemon.Outbound]] = Map([])
  session_sinks.set(device_id, per_device)
  for folder in config.shared_folders {
    if !folder.devices.contains(device_id) {
      continue
    }
    let folder_id = folder.folder_id()
    let sink : @async.Queue[@daemon.Outbound] = @async.Queue(kind=Unbounded)
    per_device.set(folder_id, sink)
    let _ = handle.send(
      @daemon.Cmd::PeerOpen(folder=folder_id, remote_device_id=device_id, sink~),
    )
    group.spawn_bg(allow_failure=true, no_wait=true) <| () => {
      let mut running = true
      while running {
        let frame : @daemon.Outbound? = Some(sink.get()) catch { _ => None }
        match frame {
          Some(f) => running = send(outbound_to_wire(folder_id, f))
          None => running = false
        }
      }
    }
  }
}

///|
/// 关闭某设备的全部会话 sinks(断开钩子与出站循环断链共用):队列 close
/// 叫停泵,由调用方对每目录补发 PeerClose(server 侧)或直接撤销(client 侧)。
fn close_session_sinks(
  session_sinks : Map[String, Map[String, @async.Queue[@daemon.Outbound]]],
  device_id : String,
) -> Unit {
  match session_sinks.get(device_id) {
    Some(per_device) => {
      for _, sink in per_device {
        sink.close(clear=true)
      }
      session_sinks.remove(device_id)
    }
    None => ()
  }
}

///|
/// hello 驱动的元数据处理(收发两侧共用口径):
///   - Hello:元数据登记进会话注册表(register_hello 保留已知 Some url,
///     入站侧无从得知对端地址);
///   - GitCommitNotify:投递回执**即刻**回给这一跳的对端(处理到即回,与
///     随后有没有真落成一笔镜像提交无关 —— 与 offer-receipt 同一口径;按
///     这一跳寻址而非消息署名来源,中继场景下署名来源在两跳之外没有会话),
///     随后通知交给镜像循环只入队不立即提交;
///   - GitCommitAck:投递层回执,MoonBit 侧无台账,记日志销账;
///   - 其余 Control 维持丢弃(TODO:notify 扫描触发 / 中继等后续包);
///   - 数据面消息路由进 actor。
fn handle_peer_message(
  registry : PeerSessionRegistry,
  handle : @daemon.ActorHandle,
  self_device_id : String,
  mirror : GitMirror?,
  device_id : String,
  message : @net.WireMessage,
  send_control : (@net.ControlMessage) -> Unit,
) -> Unit {
  match message {
    Control(payload=Hello(from_device_id=_, version~, hostname~, platform~, ..)) =>
      registry.register_hello(device_id, version, platform, hostname)
    Control(payload=notify) =>
      match notify {
        GitCommitNotify(from_device_id=_, folder_id~, commit_hash~, ..) => {
          send_control(
            @net.ControlMessage::GitCommitAck(
              from_device_id=self_device_id,
              folder_id=folder_id,
              commit_hash=commit_hash,
              version=None,
              hostname=None,
              platform=None,
              runtime=None,
            ),
          )
          match mirror {
            Some(m) => m.on_notify(notify, Some(device_id))
            None => ()
          }
        }
        GitCommitAck(from_device_id=sender, folder_id~, commit_hash~, ..) =>
          log_git_commit_ack(sender, folder_id, commit_hash)
        // 其余 Control 维持丢弃(TODO:notify 扫描触发 / 中继等后续包)
        _ => ()
      }
    _ =>
      match message_folder(message) {
        Some(folder) => {
          let _ = handle.send(
            @daemon.Cmd::PeerMessage(folder~, remote_device_id=device_id, message~),
          )
          // 索引到达后补一条 ApplyPlan(驱动层职责,同 actor_test)
          if message is Index(..) {
            let _ = handle.send(@daemon.Cmd::ApplyPlan(folder))
          }
        }
        None => ()
      }
  }
}

///|
/// 单个配置对端的出站拨号 + 断线重连常驻循环。拨号成功:登记会话、主动发
/// hello、接 actor 出站泵与 git 回执泵、跑收发循环;连接结束(对端断开/
/// 链路故障):撤销会话与 sinks、记 WRN、按退避曲线重拨 —— 成功即归零
/// attempts(闭链后 0ms 立即重拨),失败持续指数退避(1s 起 30s 封顶,
/// 与 Node 同曲线)。
///
/// 配置热重载:`still_configured` 在每个重拨点检查该 URL 是否仍在配置里 ——
/// 被移除的 URL 在既有连接自然断开后退出循环(连接不断,等链路自己收);
/// `on_exit` 供监督循环把 URL 从「已拨」名册摘除,URL 重新添加时能重新起循环。
async fn outbound_peer_loop(
  registry : PeerSessionRegistry,
  identity : @net.DeviceIdentity,
  config_cell : Ref[@core.Config],
  handle : @daemon.ActorHandle,
  group : @async.TaskGroup[Unit],
  session_sinks : Map[String, Map[String, @async.Queue[@daemon.Outbound]]],
  senders : PeerSenders,
  closers : Map[String, () -> Unit],
  mirror : GitMirror,
  url : String,
  peer_port : Int32,
  still_configured : (String) -> Bool,
  on_exit : () -> Unit,
) -> Unit {
  let mut attempts = 0
  for ;; {
    if !still_configured(url) {
      // 该对端地址已从配置移除:既断则断后的清理段已跑过,这里直接收工
      @log.info("peer {Url} no longer in config, dial loop exiting", [
        Json::string(url),
      ])
      on_exit()
      return
    }
    let dial : @net.PeerClient? = Some(
      @net.connect_peer(
        @net.PeerHandshakeMode::Secure(identity),
        url,
        listen_port=Some(peer_port),
      ),
    ) catch {
      e => {
        // 拨号失败是对端离线的常态(Node 同口径记 WARN 不记 ERROR)
        @log.warn(
          "dial to {Url} failed: {Err} (attempt {N})",
          [
            Json::string(url),
            Json::string(e.to_text()),
            Json::number((attempts + 1).to_double()),
          ],
        )
        let delay = reconnect_delay_ms(attempts)
        attempts = attempts + 1
        @log.debug(
          "reconnect scheduled {Url} in {Ms}ms",
          [Json::string(url), Json::number(delay.to_double())],
        )
        @async.sleep(delay)
        None
      }
    }
    match dial {
      Some(client) => {
        attempts = 0
        let device_id = client.remote_device_id().unwrap_or("")
        @log.info(
          "connected to configured peer {DeviceId} ({Url})",
          [Json::string(device_id), Json::string(url)],
        )
        // 会话登记 + 主动 hello 宣告(版本/平台/主机名;生命周期跟随会话)
        registry.register(
          device_id,
          { version: None, platform: None, hostname: None, url: Some(url) },
        )
        client.send_message(
          @net.WireMessage::Control(
            payload=@net.make_hello(
              identity.device_id,
              @api.local_hostname(),
              Some(@api.platform_name()),
            ),
          ),
        ) catch { _ => () }
        // actor 出站接线(共享目录 sinks + 泵,直接走本条客户端连接;
        // 目录清单现读配置单元格)
        spawn_session_pumps(group, handle, config_cell.val, device_id, session_sinks, msg => {
          client.send_message(msg) catch { _ => return false }
          true
        })
        // 发送闭包登记(镜像中继按它寻址;断开钩子摘除)+ 连接 closer 登记
        // (配置热重载:设备不再共享任何目录时由会话面对账主动掐线)
        senders.register(device_id, msg => {
          client.send_message(msg) catch { _ => return false }
          true
        })
        closers.set(device_id, () => { client.close() })
        // git 回执泵:handle_peer_message 是同步回调,而 client 发送是 async ——
        // 回执先入无界箱,由本任务异步投递(单线程 async,箱即同步转发)
        let ack_outbox : @async.Queue[@net.ControlMessage] = @async.Queue(
          kind=Unbounded,
        )
        group.spawn_bg(allow_failure=true, no_wait=true) <| () => {
          for ;; {
            let ack : @net.ControlMessage? = Some(ack_outbox.get()) catch { _ => None }
            match ack {
              Some(m) =>
                client.send_message(@net.WireMessage::Control(payload=m)) catch {
                  _ => ()
                }
              // 箱已关 = 会话结束,泵收工
              None => break
            }
          }
        }
        // 收发循环:返回 = 连接结束(对端断开 / 链路故障)
        client.run({
          on_message: message =>
            handle_peer_message(
              registry,
              handle,
              identity.device_id,
              Some(mirror),
              device_id,
              message,
              msg => {
                let _ = ack_outbox.try_put(msg) catch { _ => false }
              },
            ),
          on_binary: _ => (),
          on_error: reason =>
            @log.warn("peer {DeviceId} message error {Reason}", [
              Json::string(device_id), Json::string(reason),
            ]),
          on_close: () => (),
        })
        // 会话撤销:元数据失效 + sinks 关闭 + 发送闭包/closer 摘除 + 回执箱
        // 关停(与 server 侧 on_disconnect 对称)
        registry.unregister(device_id)
        senders.unregister(device_id)
        closers.remove(device_id)
        close_session_sinks(session_sinks, device_id)
        ack_outbox.close(clear=true)
        @log.warn(
          "peer {DeviceId} session closed ({Url}); reconnecting",
          [Json::string(device_id), Json::string(url)],
        )
        // attempts 已在成功时归零:闭链后 0ms 立即重拨,失败再指数退避
        @async.sleep(reconnect_delay_ms(attempts))
      }
      None => ()
    }
  }
}
