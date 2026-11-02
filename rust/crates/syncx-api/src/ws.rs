//! 状态推送中枢(`/api/events`)。
//!
//! 直接照搬 Node 侧 `src/status-hub.ts` 的语义,因为前端是同一份 bundle:
//!
//!  * **连上立刻发一帧全量**,不等任何事件 —— 界面连上就能画,不靠轮询;
//!  * **250ms 合并窗口**:一次扫描的成批变更只推一帧;
//!  * **5000ms 兜底重算**:漏掉某个通知点只表现为「晚几秒」,而不是「永远不动」;
//!  * **差异驱动**:序列化结果与上次相同就一帧都不发。有了它,通知点可以放心地
//!    在粗粒度位置多打几个,不会变成多推几帧(空闲通道真正零流量);
//!  * **30s 应用层 ping**,让中间代理不因空闲掐断连接;
//!  * 没有订阅者时重置基线,下一个客户端连上必须收到一帧,不被差异判断挡掉。
//!
//! 差异驱动是这里唯一容易写错的地方:基线必须是「上次真正发出去的字节」,
//! 而不是「上次算出来的对象」。用对象比较会漏掉键序、浮点格式化这些差异,
//! 而客户端看到的恰恰是字节。

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;

/// 变更合并窗口。
pub const DEFAULT_FLUSH_MS: u64 = 250;
/// 兜底重算周期。与扫描周期同阶。
pub const DEFAULT_FALLBACK_MS: u64 = 5000;
/// 应用层 ping 周期。低于多数中间代理 60s 的空闲阈值。
pub const DEFAULT_PING_MS: u64 = 30000;

/// 一条待发出的帧。
pub enum WsFrame {
    Text(String),
    Close(u16, String),
}

type ClientId = u64;
type ClientSender = tokio::sync::mpsc::UnboundedSender<WsFrame>;

struct Inner {
    clients: BTreeMap<ClientId, ClientSender>,
    /// 上一次**真正发出去**的序列化结果。
    last_sent: String,
    closed: bool,
    next_id: ClientId,
}

/// 状态推送中枢。克隆共享同一份状态。
#[derive(Clone)]
pub struct StatusHub {
    inner: Arc<Mutex<Inner>>,
    /// 有「可能变了」的通知挂在待处理标记上。
    dirty: Arc<AtomicBool>,
    get_status: Arc<dyn Fn() -> Value + Send + Sync>,
    timings: Timings,
}

#[derive(Debug, Clone, Copy)]
pub struct Timings {
    pub flush: Duration,
    pub fallback: Duration,
    pub ping: Duration,
}

impl Default for Timings {
    fn default() -> Self {
        Self {
            flush: Duration::from_millis(DEFAULT_FLUSH_MS),
            fallback: Duration::from_millis(DEFAULT_FALLBACK_MS),
            ping: Duration::from_millis(DEFAULT_PING_MS),
        }
    }
}

impl StatusHub {
    /// 建中枢并起后台定时器。`get_status` 须与 `/api/status` 同源。
    pub fn new(
        get_status: impl Fn() -> Value + Send + Sync + 'static,
        timings: Timings,
    ) -> Self {
        let hub = Self {
            inner: Arc::new(Mutex::new(Inner {
                clients: BTreeMap::new(),
                last_sent: String::new(),
                closed: false,
                next_id: 0,
            })),
            dirty: Arc::new(AtomicBool::new(false)),
            get_status: Arc::new(get_status),
            timings,
        };
        hub.spawn_timers();
        hub
    }

    fn spawn_timers(&self) {
        let hub = self.clone();
        tokio::spawn(async move {
            let mut flush_tick = tokio::time::interval(hub.timings.flush);
            let mut fallback_tick = tokio::time::interval(hub.timings.fallback);
            let mut ping_tick = tokio::time::interval(hub.timings.ping);
            // 三个 interval 的第一次 tick 都是立即完成的:`MissedTickBehavior::Delay`
            // 让错过的 tick 重新计时而不是补发一串。
            flush_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            fallback_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            ping_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            // `interval` 的**第一次 tick 立即完成**。三个都先空跑一次,否则进程一起
            // 就会立刻做一次兜底重算并发一个 ping —— 前者的症状是「连上就多推一帧」,
            // 后者是「刚连上就收到心跳」,两者都会让差异驱动/合并窗口的断言失真。
            flush_tick.tick().await;
            fallback_tick.tick().await;
            ping_tick.tick().await;
            loop {
                tokio::select! {
                    _ = flush_tick.tick() => {
                        // 只有挂了通知才重算:空闲通道不该每 250ms 做一次序列化
                        if hub.dirty.swap(false, Ordering::Relaxed) {
                            hub.flush();
                        }
                    }
                    _ = fallback_tick.tick() => {
                        // 兜底无条件重算 —— 差异驱动保证它不会变成无效推送
                        hub.flush();
                    }
                    _ = ping_tick.tick() => hub.ping(),
                }
                if hub.is_closed() {
                    break;
                }
            }
        });
    }

    fn is_closed(&self) -> bool {
        self.inner.lock().map(|g| g.closed).unwrap_or(true)
    }

    pub fn client_count(&self) -> usize {
        self.inner.lock().map(|g| g.clients.len()).unwrap_or(0)
    }

    /// 状态可能已变(由会话管理的变更点调用)。合并窗口内多次调用只推一帧。
    pub fn notify(&self) {
        self.dirty.store(true, Ordering::Relaxed);
    }

    /// 重算一次状态,有变化才广播。
    fn flush(&self) {
        if self.client_count() == 0 {
            return;
        }
        // 序列化在锁外做:get_status 会读配置、统计索引,持锁期间做这些会把
        // attach/close 全堵住
        let status = (self.get_status)();
        let frame = serde_json::json!({ "type": "status", "status": status });
        let Ok(serialized) = serde_json::to_string(&frame) else {
            return;
        };
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        if serialized == inner.last_sent {
            return;
        }
        inner.last_sent = serialized.clone();
        inner.broadcast_text(serialized);
    }

    fn ping(&self) {
        let payload = serde_json::json!({ "type": "ping", "ts": crate::auth::now_ms() }).to_string();
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        inner.broadcast_text(payload);
    }

    /// 接管一条已完成握手的连接:立即回一帧全量,之后随变更推送。
    ///
    /// 返回一个接收端,由调用方把帧写进 socket。连接断开时丢弃它即可 ——
    /// 发送失败会自动摘掉这个客户端。
    pub fn attach(&self) -> Option<(ClientId, tokio::sync::mpsc::UnboundedReceiver<WsFrame>)> {
        let mut inner = self.inner.lock().ok()?;
        if inner.closed {
            return None;
        }
        // 连上立刻给一帧:只发这一条(并顺手校准基线),不必惊动在线的其它标签页
        let status = (self.get_status)();
        let frame = serde_json::json!({ "type": "status", "status": status });
        let serialized = serde_json::to_string(&frame).ok()?;
        inner.last_sent = serialized.clone();

        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let id = inner.next_id;
        inner.next_id += 1;
        let _ = tx.send(WsFrame::Text(serialized));
        inner.clients.insert(id, tx);
        Some((id, rx))
    }

    /// 摘掉一个客户端。最后一个断开时重置基线 —— 否则下一个连上会被
    /// 「与上次相同」的差异判断挡掉,永远收不到第一帧。
    pub fn detach(&self, id: ClientId) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.clients.remove(&id);
            if inner.clients.is_empty() {
                inner.last_sent.clear();
            }
        }
    }

    /// 关闭全部连接并停止定时器(优雅关闭时调用)。
    pub fn close(&self) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        inner.closed = true;
        // 1001 = going away。前端据此知道是「服务端在关」而不是网络抖动
        let close = WsFrame::Close(1001, "server shutting down".to_string());
        for sender in inner.clients.values() {
            let _ = sender.send(WsFrame::Close(1001, "server shutting down".to_string()));
        }
        inner.clients.clear();
        inner.last_sent.clear();
        drop(close);
    }
}

impl Inner {
    fn broadcast_text(&mut self, text: String) {
        // 发送失败(对端已消失)立刻摘掉,避免反复对死连接写
        let dead: Vec<ClientId> = self
            .clients
            .iter()
            .filter(|(_, sender)| sender.send(WsFrame::Text(text.clone())).is_err())
            .map(|(id, _)| *id)
            .collect();
        for id in dead {
            self.clients.remove(&id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    fn fast() -> Timings {
        Timings {
            flush: Duration::from_millis(10),
            fallback: Duration::from_millis(2000),
            ping: Duration::from_millis(3000),
        }
    }

    #[tokio::test]
    async fn attach_sends_immediate_frame() {
        let hub = StatusHub::new(|| serde_json::json!({"n": 1}), fast());
        let (_id, mut rx) = hub.attach().expect("应能挂上");
        let frame = tokio::time::timeout(Duration::from_millis(100), rx.recv())
            .await
            .unwrap()
            .unwrap();
        let WsFrame::Text(text) = frame else {
            panic!("第一帧必须是状态")
        };
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["type"], "status");
        assert_eq!(value["status"]["n"], 1);
        hub.close();
    }

    #[tokio::test]
    async fn unchanged_status_sends_nothing() {
        let hub = StatusHub::new(|| serde_json::json!({"n": 1}), fast());
        let (_id, mut rx) = hub.attach().unwrap();
        let _first = rx.recv().await.unwrap();
        // 状态没变:再推一次必须一帧都不发
        hub.notify();
        assert!(
            tokio::time::timeout(Duration::from_millis(120), rx.recv()).await.is_err(),
            "差异驱动:相同内容不应重复推送"
        );
        hub.close();
    }

    #[tokio::test]
    async fn notify_coalesces_within_window() {
        let counter = Arc::new(AtomicUsize::new(0));
        let counter_for_status = Arc::clone(&counter);
        let hub = StatusHub::new(
            move || {
                let n = counter_for_status.fetch_add(1, Ordering::SeqCst);
                serde_json::json!({ "n": n })
            },
            Timings {
                flush: Duration::from_millis(100),
                fallback: Duration::from_millis(10_000),
                ping: Duration::from_millis(20_000),
            },
        );
        let (_id, mut rx) = hub.attach().unwrap();
        let _first = rx.recv().await.unwrap();
        let calls_after_attach = counter.load(Ordering::SeqCst);
        // 一波通知:合并窗口内只应重算一次
        for _ in 0..5 {
            hub.notify();
        }
        let _second = tokio::time::timeout(Duration::from_millis(500), rx.recv())
            .await
            .expect("合并窗口后应推出一帧")
            .unwrap();
        let calls = counter.load(Ordering::SeqCst) - calls_after_attach;
        assert_eq!(calls, 1, "5 次 notify 应合并成 1 次重算,实际 {calls}");
        hub.close();
    }

    #[tokio::test]
    async fn reconnect_gets_a_frame_after_idle() {
        let hub = StatusHub::new(|| serde_json::json!({"n": 1}), fast());
        let (id, mut rx) = hub.attach().unwrap();
        let _first = rx.recv().await.unwrap();
        hub.detach(id);
        // 基线被重置:新连接必须立刻拿到一帧,而不是被差异判断挡掉
        let (_id2, mut rx2) = hub.attach().unwrap();
        let frame = tokio::time::timeout(Duration::from_millis(100), rx2.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(frame, WsFrame::Text(_)));
        hub.close();
    }

    #[tokio::test]
    async fn close_sends_going_away() {
        let hub = StatusHub::new(|| serde_json::json!({"n": 1}), fast());
        let (_id, mut rx) = hub.attach().unwrap();
        let _first = rx.recv().await.unwrap();
        hub.close();
        let frame = tokio::time::timeout(Duration::from_millis(100), rx.recv())
            .await
            .unwrap()
            .unwrap();
        match frame {
            WsFrame::Close(code, reason) => {
                assert_eq!(code, 1001);
                assert_eq!(reason, "server shutting down");
            }
            _ => panic!("关闭前必须发 1001"),
        }
        assert!(hub.attach().is_none(), "关闭后不再接受新连接");
    }
}
