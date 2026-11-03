//! 文件系统监听中枢的行为测试。
//!
//! 尽量用**真实文件事件**(macOS FSEvents / Linux inotify 由 notify 保证):临时目录里
//! 真写文件、真删目录。唯一注入的是「时间」—— 窗口与巡检间隔都缩到几百毫秒,
//! 断言用轮询 + 宽限期,不吃平台事件延迟的亏。

use std::path::PathBuf;
use std::time::Duration;

use syncx_daemon::watcher::{
    FsWatchHub, RescanReason, RescanRequest, WatchFolderSpec, FS_WATCH_WINDOW,
};

/// 测试用短窗口。生产值是 [`FS_WATCH_WINDOW`](2 秒),这里缩 5 倍:
/// 聚合语义相同,测试快一个量级。
const WINDOW: Duration = Duration::from_millis(FS_WATCH_WINDOW.as_millis() as u64 / 5);

/// 巡检间隔:重建延迟由它决定,测试里压到 150ms。
const SWEEP: Duration = Duration::from_millis(150);

/// 自清理的临时目录。
struct TempRoot(PathBuf);

impl TempRoot {
    fn new(tag: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "syncx-watcher-{}-{tag}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &std::path::Path {
        &self.0
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// 轮询条件直到成立或超时。全部用异步 sleep 让步,不饿死 hub 的后台任务。
async fn wait_until(cond: impl Fn() -> bool, timeout: Duration) -> bool {
    let start = std::time::Instant::now();
    while start.elapsed() < timeout {
        if cond() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    cond()
}

/// 取下一条满足条件的重扫请求(整体限时 10 秒,足够跨过事件流的预热延迟)。
async fn next_matching(
    rx: &mut tokio::sync::mpsc::UnboundedReceiver<RescanRequest>,
    pred: impl Fn(&RescanRequest) -> bool,
) -> Option<RescanRequest> {
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        let now = std::time::Instant::now();
        if now >= deadline {
            return None;
        }
        let Ok(Some(request)) =
            tokio::time::timeout(deadline - now, rx.recv()).await
        else {
            return None;
        };
        if pred(&request) {
            return Some(request);
        }
    }
}

fn spec(id: &str, root: &std::path::Path) -> WatchFolderSpec {
    WatchFolderSpec {
        id: id.to_string(),
        root: root.to_path_buf(),
    }
}

#[tokio::test]
async fn events_within_window_collapse_to_one_rescan() {
    let root = TempRoot::new("collapse");
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let hub = FsWatchHub::spawn(WINDOW, SWEEP, tx);
    hub.sync(vec![spec("f1", root.path())]);
    assert!(
        wait_until(|| hub.health().healthy(), Duration::from_secs(5)).await,
        "watcher 启动后应健康"
    );

    // 窗口内一批事件:写 6 个文件,应塌缩成**一次**该目录重扫
    for index in 0..6 {
        std::fs::write(root.path().join(format!("file-{index}.txt")), "x").unwrap();
    }
    let first = next_matching(&mut rx, |r| {
        r.folder == "f1" && r.reason == RescanReason::Watch
    })
    .await
    .expect("窗口关闭后应触发一次重扫");
    assert!(first.events >= 6, "聚合计数应覆盖整批事件,实得 {}", first.events);

    // 没有新写入 → 同一个窗口之后不应再产生第二条请求(塌缩语义)
    let quiet = WINDOW + SWEEP + Duration::from_millis(600);
    let no_more = tokio::time::timeout(quiet, rx.recv()).await;
    match no_more {
        Err(_) => {} // 超时 = 无更多请求,正是期望
        Ok(Some(extra)) => panic!("无新写入时不应再触发重扫:{extra:?}"),
        Ok(None) => panic!("重扫通道提前关闭"),
    }
}

#[tokio::test]
async fn deleted_folder_is_rebuilt_and_rescanned_on_reappearance() {
    let root = TempRoot::new("rebuild");
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let hub = FsWatchHub::spawn(WINDOW, SWEEP, tx);
    hub.sync(vec![spec("f1", root.path())]);
    std::fs::write(root.path().join("a.txt"), "x").unwrap();
    let initial = next_matching(&mut rx, |r| r.reason == RescanReason::Watch).await;
    assert!(initial.is_some(), "正常监听应收到事件触发的重扫");

    // 目录消失:巡检关闭 watcher,健康度翻红;期间不崩
    std::fs::remove_dir_all(root.path()).unwrap();
    assert!(
        wait_until(|| !hub.health().healthy(), Duration::from_secs(5)).await,
        "目录消失后 watcher 关闭,健康度应翻红"
    );

    // 目录恢复(同路径重建):巡检重建并**立即**补扫一轮
    std::fs::create_dir_all(root.path()).unwrap();
    let rebuild = next_matching(&mut rx, |r| r.reason == RescanReason::Rebuild).await;
    assert!(rebuild.is_some(), "目录恢复后应触发重建补扫");
    assert!(
        wait_until(|| hub.health().healthy(), Duration::from_secs(5)).await,
        "重建成功后健康度应恢复"
    );

    // 事件通路随之恢复
    std::fs::write(root.path().join("b.txt"), "y").unwrap();
    let resumed = next_matching(&mut rx, |r| r.reason == RescanReason::Watch).await;
    assert!(resumed.is_some(), "重建后的事件应继续触发重扫");
}

#[tokio::test]
async fn watcher_creation_failure_degrades_until_folder_appears() {
    let root = TempRoot::new("degrade");
    let missing = root.path().join("尚未创建");
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let hub = FsWatchHub::spawn(WINDOW, SWEEP, tx);

    // 指向不存在的目录:创建失败 → 降级,健康度翻红(warn 只发一次)
    hub.sync(vec![spec("f1", &missing)]);
    assert!(
        wait_until(|| !hub.health().healthy(), Duration::from_secs(5)).await,
        "创建失败的 watcher 应让健康度翻红"
    );

    // 目录出现:巡检自动建档 + 立即补扫
    std::fs::create_dir_all(&missing).unwrap();
    std::fs::write(missing.join("late.txt"), "x").unwrap();
    let rebuild = next_matching(&mut rx, |r| r.reason == RescanReason::Rebuild).await;
    assert!(rebuild.is_some(), "目录出现后应重建并立即补扫");
    assert!(
        wait_until(|| hub.health().healthy(), Duration::from_secs(5)).await,
        "目录出现后健康度应恢复"
    );
    // 事件通路已接通
    std::fs::write(missing.join("more.txt"), "y").unwrap();
    let watch = next_matching(&mut rx, |r| r.reason == RescanReason::Watch).await;
    assert!(watch.is_some(), "建档后的事件应触发重扫");
}

#[tokio::test]
async fn sync_with_empty_specs_drops_all_watchers() {
    let root = TempRoot::new("drop");
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let hub = FsWatchHub::spawn(WINDOW, SWEEP, tx);
    hub.sync(vec![spec("f1", root.path())]);
    std::fs::write(root.path().join("a.txt"), "x").unwrap();
    assert!(
        next_matching(&mut rx, |r| r.reason == RescanReason::Watch)
            .await
            .is_some(),
        "对齐清单后事件通路应就绪"
    );

    // 清空清单(配置关闭监听的形态):watcher 全部拆除,后续事件不再触发
    hub.sync(Vec::new());
    // 给对齐命令一个落地窗口(命令是异步处理的)
    tokio::time::sleep(WINDOW * 3).await;
    std::fs::write(root.path().join("b.txt"), "y").unwrap();
    let none = tokio::time::timeout(WINDOW + SWEEP + Duration::from_millis(900), rx.recv()).await;
    assert!(
        none.is_err(),
        "清单清空后不应再有重扫请求,实得 {:?}",
        none.ok().flatten()
    );
}
