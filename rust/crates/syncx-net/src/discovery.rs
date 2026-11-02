//! mDNS 广播与发现。对应 Node 侧 `src/net/discovery.ts`。
//!
//! 与 Node 实现的两处差异,都是**刻意的**:
//!
//! 1. **对端地址取自发包源 IP,不解析 SRV target。** Node 侧注释写得很清楚:
//!    `xxx.local` 的解析依赖本机 mDNS 解析器(Linux 上可能没有),失败还要卡几秒;
//!    而发包源 IP 是白捡的,而且语义更准 —— 它就是「这台机器此刻 reachable 的地址」。
//! 2. **30 秒周期重播 + 主动查询。** 启动只广播不查询;周期 tick 才发起查询,
//!    这样后加入的节点既能被发现,也能发现早已在跑的节点。一次性 announce 会漏掉
//!    晚加入者 —— 这个坑在 Node 侧已经踩过。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};

/// 服务类型。**必须与 Node 完全一致**,否则两端互相看不见。
const SERVICE_TYPE: &str = "_syncx._tcp.local.";

/// 重播间隔。Node 侧是 30000ms。
const ANNOUNCE_INTERVAL: Duration = Duration::from_secs(30);

/// 发现到的对端。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredPeer {
    pub device_id: String,
    /// SRV target 的裸值(不带 `.local` 后缀)。不保证可解析,只作展示。
    pub host: String,
    pub port: u16,
    /// 收到这个广播的**源 IP**。见模块注释第 1 条。
    pub address: Option<String>,
}

/// 正在运行的发现服务。
pub struct Discovery {
    daemon: ServiceDaemon,
    fullname: String,
    task: Option<tokio::task::JoinHandle<()>>,
    /// 本机在网判定。`false` 时跳过周期广播(无网时组播发不出去,白烧电)。
    online: Arc<Mutex<bool>>,
}

impl Discovery {
    /// 立刻补一轮广播 + 查询(网络恢复时调用)。
    pub fn kick(&self) {
        // mdns-sd 的 browse 是持续的;这里重新注册一次会触发一轮 announce。
        // 没有 ready 之前调用的概念 —— 比 Node 简单,但语义等价。
        let _ = self.daemon.browse(SERVICE_TYPE);
    }

    /// 关闭发现服务。先注销再关 daemon,否则对端要等 TTL 才认为我们下线。
    pub async fn close(self) {
        let _ = self.daemon.unregister(&self.fullname);
        if let Some(task) = self.task {
            task.abort();
        }
        let _ = self.daemon.shutdown();
    }

    /// 更新「本机是否在线」判定。`false` 时周期广播会跳过。
    pub fn set_online(&self, online: bool) {
        if let Ok(mut guard) = self.online.lock() {
            *guard = online;
        }
    }
}

/// 启动广播与发现。
///
/// `on_peer_found` 每发现一个**不同的**对端设备调用一次(同一台设备反复广播不重复
/// 上报 —— 30 秒一轮,重复上报会让上层不停重连)。
pub fn start_discovery(
    device_id: &str,
    port: u16,
    on_peer_found: impl Fn(DiscoveredPeer) + Send + Sync + 'static,
) -> Result<Discovery, DiscoveryError> {
    let daemon = ServiceDaemon::new().map_err(|e| DiscoveryError::Mdns(e.to_string()))?;

    // 实例名用 device_id:同网多台设备时靠它区分。`TXT` 里再放一份 —— Node 侧
    // 就是从 TXT 里读 `deviceId=`,保持两条通道都能拿到(某些实现会剥掉实例名)。
    let hostname = hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .unwrap_or_else(|| "syncx".to_string());
    let properties = [("deviceId", device_id)];
    // 地址留空 + enable_addr_auto:由库自己跟随本机网卡变化填 A 记录。
    // 写死 "" 会被 `AsIpAddrs for &str` 当成空集合(不是解析错误),正是我们想要的。
    let info = ServiceInfo::new(
        SERVICE_TYPE,
        device_id,
        &format!("{hostname}.local."),
        "",
        port,
        &properties[..],
    )
    .map_err(|e| DiscoveryError::Mdns(e.to_string()))?
    // TTL:mdns-sd 的 host 记录默认就是 120 秒 = Node 侧写的 120,不必手改
    .enable_addr_auto();

    let fullname = info.get_fullname().to_string();
    daemon
        .register(info)
        .map_err(|e| DiscoveryError::Mdns(e.to_string()))?;

    let browser = daemon
        .browse(SERVICE_TYPE)
        .map_err(|e| DiscoveryError::Mdns(e.to_string()))?;

    let online = Arc::new(Mutex::new(true));
    let online_for_task = Arc::clone(&online);
    let self_device_id = device_id.to_string();
    let daemon_for_task = daemon.clone();

    let task = tokio::spawn(async move {
        use mdns_sd::Receiver;

        let mut seen: HashMap<String, String> = HashMap::new();
        let callback = Arc::new(on_peer_found);

        let recv: Receiver<ServiceEvent> = browser;
        loop {
            let Ok(event) = recv.recv_async().await else {
                // daemon 关闭;没有什么可做的
                break;
            };
            let ServiceEvent::ServiceResolved(info) = event else {
                continue;
            };

            // device_id 优先取 TXT,退回实例名(实例名形如 `<id>._syncx._tcp.local.`)
            let from_txt = info
                .get_property_val_str("deviceId")
                .map(|s| s.to_string())
                .filter(|s| is_device_id(s));
            let from_name = info
                .get_fullname()
                .split('.')
                .next()
                .filter(|s| is_device_id(s))
                .map(|s| s.to_string());
            let Some(found_id) = from_txt.or(from_name) else {
                continue;
            };
            if found_id == self_device_id {
                continue;
            }

            // 源 IP:多播响应里带地址列表;Node 用的是 UDP rinfo,这里是等价语义
            let address = info.get_addresses().iter().next().map(|ip| ip.to_string());
            let peer = DiscoveredPeer {
                device_id: found_id.clone(),
                host: info.get_hostname().trim_end_matches('.').to_string(),
                port: info.get_port(),
                address,
            };

            // 同一设备反复广播不重复上报;但地址/端口变了要重新上报
            let fingerprint = format!("{}:{}", peer.host, peer.port);
            if seen.get(&found_id) == Some(&fingerprint) {
                continue;
            }
            seen.insert(found_id, fingerprint);
            callback(peer);
        }

        // 周期重播:mdns-sd 自己会按 TTL 续期,但我们仍要主动查询一轮,
        // 保证网络恢复后立刻能看见早已在跑的对端(见模块注释第 2 条)
        loop {
            tokio::time::sleep(ANNOUNCE_INTERVAL).await;
            let is_online = online_for_task.lock().map(|g| *g).unwrap_or(true);
            if !is_online {
                continue;
            }
            let _ = daemon_for_task.browse(SERVICE_TYPE);
        }
    });

    Ok(Discovery {
        daemon,
        fullname,
        task: Some(task),
        online,
    })
}

/// Device ID 的形状:10 个 base32 字符(`[A-Z2-7]`)。与 Node 的正则 `[A-Z2-7]{10}` 同一判据。
fn is_device_id(text: &str) -> bool {
    text.len() == 10
        && text
            .bytes()
            .all(|b: u8| b.is_ascii_uppercase() || (b'2'..=b'7').contains(&b))
}

/// 发现服务启动失败。
#[derive(Debug, thiserror::Error)]
pub enum DiscoveryError {
    #[error("mDNS 服务启动失败:{0}")]
    Mdns(String),
}
