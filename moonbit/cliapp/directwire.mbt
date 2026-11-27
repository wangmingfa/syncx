///|
/// 设备间直发(ADR-0028)在 cli 装配层的通道面:把「现取会话连接」折算成
/// direct 服务要的 DirectTransport(control 走 Control 帧、chunk 走 kind 3
/// 二进制信封帧),并给入站消息搭一条**串行泵** —— direct 服务的状态机按
/// 「每条消息完整处理完再处理下一条」设计(Node 单线程事件循环天然如此,
/// MoonBit 用单队列单泵等价,避免两个 async 任务在落盘中途交错)。

///|
/// 直发通道登记表:deviceId → DirectTransport。server 侧在 on_connect 登记、
/// on_disconnect 摘除;client 侧在拨号成功后登记、会话撤销时摘除。生命周期
/// 跟随会话;单线程 async,普通 Map 无锁。
pub struct DirectChannels {
  priv channels : Map[String, @direct.DirectTransport]
}

///|
pub fn DirectChannels::new() -> DirectChannels {
  { channels: Map([]) }
}

///|
pub fn DirectChannels::register(
  self : DirectChannels,
  device_id : String,
  transport : @direct.DirectTransport,
) -> Unit {
  self.channels.set(device_id, transport)
}

///|
/// 会话撤销(断开钩子;幂等)。
pub fn DirectChannels::unregister(self : DirectChannels, device_id : String) -> Unit {
  self.channels.remove(device_id)
}

///|
/// 现取一台设备的直发通道(无活跃会话 = None,发送方走离线排队)。
pub fn DirectChannels::lookup(
  self : DirectChannels,
  device_id : String,
) -> @direct.DirectTransport? {
  self.channels.get(device_id)
}

///|
/// 入站直发载荷(串行泵的队列元素):控制消息与分片帧同队,保证 direct
/// 服务状态机的处理顺序与 Node 一致。
pub(all) enum DirectInbound {
  DCtl(@net.ControlMessage)
  DChunk(@net.BinaryFrame)
}

///|
/// 直发入站箱登记表:deviceId → 队列。生命周期跟随会话(on_connect 建、
/// on_disconnect 关);on_message/on_binary 这两个**同步**回调只往里入队。
pub struct DirectBoxes {
  priv boxes : Map[String, @async.Queue[DirectInbound]]
}

///|
pub fn DirectBoxes::new() -> DirectBoxes {
  { boxes: Map([]) }
}

///|
/// 会话建立:开箱。返回新箱供 pump 使用;已有箱(重复 on_connect,理论
/// 不可达)先关旧箱再开新箱,泵由旧箱收尾退出。
pub fn DirectBoxes::open(
  self : DirectBoxes,
  device_id : String,
) -> @async.Queue[DirectInbound] {
  match self.boxes.get(device_id) {
    Some(existing) => existing.close(clear=true)
    None => ()
  }
  let fresh : @async.Queue[DirectInbound] = @async.Queue(kind=Unbounded)
  self.boxes.set(device_id, fresh)
  fresh
}

///|
/// 入站投递(同步回调调用):无箱 = 会话已断,直接丢弃。投不进去同样丢
/// (箱 Unbounded,失败只在会话刚关的窄窗里发生)。
pub fn DirectBoxes::put(
  self : DirectBoxes,
  device_id : String,
  item : DirectInbound,
) -> Unit {
  match self.boxes.get(device_id) {
    Some(box) => {
      let _ = box.try_put(item) catch { _ => false }
    }
    None => ()
  }
}

///|
/// 会话结束:关箱(pump 随之收工)并摘除;幂等。
pub fn DirectBoxes::close(self : DirectBoxes, device_id : String) -> Unit {
  match self.boxes.get(device_id) {
    Some(box) => box.close(clear=true)
    None => ()
  }
  self.boxes.remove(device_id)
}

///|
/// 直发入站串行泵:逐条交给 direct 服务处理,直到箱被关。会话中途断开时
/// 用登记表现取通道 —— 箱里可能还压着断线前的尾巴,对已断会话与其硬塞
/// 失败,不如留个空转通道直接丢弃。
pub fn start_direct_pump(
  direct : @direct.DirectService,
  channels : DirectChannels,
  device_id : String,
  box : @async.Queue[DirectInbound],
  group : @async.TaskGroup[Unit],
) -> Unit {
  group.spawn_bg(allow_failure=true, no_wait=true) <| () => {
    for ;; {
      let item : DirectInbound? = Some(box.get()) catch { _ => None }
      match item {
        Some(DCtl(message)) =>
          match channels.lookup(device_id) {
            Some(tx) => direct.handle_control(message, device_id, tx) catch { _ => () }
            None => ()
          }
        Some(DChunk(frame)) =>
          match channels.lookup(device_id) {
            Some(tx) =>
              direct.handle_chunk(frame.header, frame.body, device_id, tx) catch {
                _ => ()
              }
            None => ()
          }
        // 箱已关 = 会话结束,泵收工
        None => break
      }
    }
  }
}
