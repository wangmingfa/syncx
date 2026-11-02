//! session 状态机、扫描、执行、调度、git、备份。
//!
//! 核心是一个 actor:所有状态变更经 `mpsc::Sender<Cmd>` 串行进入同一 task,
//! 复刻 Node 单线程事件循环提供的"一次同步决策不被并发打断"这一隐式保证。
//! 只读快照(`/api/status`、WS 推送)用 `Arc<StatusSnapshot>` 原子替换,不持锁序列化。
//!
//! 模块分层(自底向上):
//!
//! - [`entry`][]:索引条目 + 本机字段(`mtime` / `placeholder`);
//! - [`indexstore`][]:与 Node **同一个 schema** 的索引库;
//! - [`partial`][]:断点续传的落盘中间态;
//! - [`scanner`][]:共享目录扫描(含五处事故疤);
//! - [`executor`][]:唯一动本地文件的一层 —— 落地、删除、冲突、版本;
//! - [`peer`][]:一条对端连接上的会话层(规划应用、块请求、收齐判定);
//! - [`actor`][]:把上述能力串成单线程状态机,对外只暴露命令与状态快照。

pub mod actor;
pub mod driver;
pub mod entry;
pub mod executor;
pub mod fingerprint;
pub mod indexstore;
pub mod partial;
pub mod peer;
pub mod scanner;

pub use entry::StoredEntry;
pub use executor::{LocalExecutor, ReceiveHandle};
pub use indexstore::{IndexCounts, IndexStore, StoreError};
