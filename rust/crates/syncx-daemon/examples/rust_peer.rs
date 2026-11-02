//! 一个最小的**真 Rust 后端**:起对端服务端 + actor + 扫描循环,等 Node 侧连进来。
//!
//! 存在的唯一目的是 ADR-0025 清单第 5 项的验收:「Node↔Rust 双向同步跑通」。
//! 这一项没法用纯 Rust 测试证明 —— 纯 Rust 测试证明的是 Rust 自己和自己对齐,
//! 而唯一可信的验收是**另一端是 Node 生产代码**(见 ADR §7)。
//!
//! 刻意保持极小:没有 HTTP、没有 CLI、没有配置解析,只有一个目录、一个连接槽位。
//! 协议互操作的问题不会因为这里多写几千行而变少,只会被埋得更深。
//!
//! 用法(Node 测试驱动):
//! ```text
//! rust_peer --root <共享目录> --data <数据目录> --port-file <路径>
//! ```
//! 起来后把实际监听端口写进 `--port-file`,并把本机身份写进 `<data>/device.key`
//! (与 Node 侧同一份 JSON 形态),测试据此算出 Device ID 并把目录 id 对齐。

use std::path::PathBuf;
use std::sync::Arc;

use syncx_core::ignore::IgnoreRuleset;
use syncx_daemon::actor::{build_folder, spawn_actor, Cmd, SessionActor};
use syncx_daemon::driver::serve_connection;
use syncx_net::identity::DeviceIdentity;
use syncx_net::server::{start_peer_server, PeerConnection, PeerHandler};

/// 扫描间隔。Node 侧生产是 1s 级;测试要的是「改动发布后能很快被 Rust 发现」,
/// 又不想把 CPU 烧在空转扫描上。
const SCAN_INTERVAL_MS: u64 = 150;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // 日志打到 stderr,由 Node 测试决定收不收(默认 RUST_LOG=info 只留下关键事件)
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_writer(std::io::stderr)
        .init();

    let mut root: Option<PathBuf> = None;
    let mut data: Option<PathBuf> = None;
    let mut port_file: Option<PathBuf> = None;
    let mut folder_id = "share".to_string();

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        let mut value = || args.next().expect("参数缺少取值");
        match arg.as_str() {
            "--root" => root = Some(PathBuf::from(value())),
            "--data" => data = Some(PathBuf::from(value())),
            "--port-file" => port_file = Some(PathBuf::from(value())),
            "--folder-id" => folder_id = value(),
            other => return Err(format!("未知参数 {other}").into()),
        }
    }
    let root = root.ok_or("缺少 --root")?;
    let data = data.ok_or("缺少 --data")?;
    let port_file = port_file.ok_or("缺少 --port-file")?;
    std::fs::create_dir_all(&root)?;
    std::fs::create_dir_all(&data)?;

    let identity = DeviceIdentity::generate();
    // 与 Node 的 identity.ts 同一份落盘形态,测试直接读它拿 Device ID
    std::fs::write(
        data.join("device.key"),
        serde_json::json!({
            "deviceId": identity.device_id,
            "publicKey": identity.public_key_pem,
            "privateKey": identity.private_key_pem,
        })
        .to_string(),
    )?;

    let device_id = identity.device_id.clone();
    let folder_for_build = folder_id.clone();
    let root_for_build = root.clone();
    let data_for_build = data.clone();

    // 会话状态里有 Rc,**必须**在 actor 自己的线程里构造 —— 这里传构造闭包即可。
    let actor = spawn_actor(move |snapshot| {
        let mut session = SessionActor::new(device_id, snapshot);
        let folder = build_folder(
            folder_for_build,
            root_for_build,
            &data_for_build,
            IgnoreRuleset::from_lines(&[]),
        )
        .expect("目录状态应能创建");
        session.add_folder(folder).expect("索引应能装入");
        session
    });

    let identity = Arc::new(identity);
    let actor_for_server = actor.clone();
    let folder_for_conn = folder_id.clone();
    let handler: PeerHandler = Arc::new(move |connection: PeerConnection| {
        let actor = actor_for_server.clone();
        let folder = folder_for_conn.clone();
        Box::pin(async move {
            // 对端连进来时用的是它那一侧的目录标识。生产里由会话建立阶段协商;
            // 本示例只有一个目录,直接认这个 id。
            if serve_connection(connection, actor, folder).await.is_none() {
                tracing::warn!("目录不存在,已断开入站连接");
            }
        })
    });

    let server = start_peer_server(
        Arc::clone(&identity),
        "127.0.0.1:0".parse()?,
        handler,
    )
    .await?;
    std::fs::write(&port_file, server.port.to_string())?;
    tracing::info!(port = server.port, root = %root.display(), "rust peer 已就绪");

    // 扫描与超时轮询都靠这条定时命令推进(与生产的调度器同一入口)。
    let ticker = actor.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_millis(SCAN_INTERVAL_MS));
        loop {
            tick.tick().await;
            ticker.send(Cmd::Scan);
            ticker.send(Cmd::Poll);
        }
    });

    // 跑到来不及优雅收尾为止:Node 测试直接 kill,这里只负责不被 SIGINT 打断成 panic
    tokio::signal::ctrl_c().await?;
    actor.send(Cmd::Shutdown);
    server.close().await;
    Ok(())
}
