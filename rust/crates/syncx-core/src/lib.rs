//! syncx 的纯逻辑内核:**不做任何 I/O**。
//!
//! 存在的意义是能逐条对拍 Node 实现(`src/version.ts`、`src/plan.ts` 等):
//! 纯函数才可能用 golden fixture 断言"两边算出来是同一个结果",带 I/O 的模块不行。
//!
//! 移植纪律:**先跑 Node 导出真值,再写 Rust**。fixture 由
//! `rust/scripts/gen-fixtures.mjs` 生成(直接 import Node 实现,不手写期望值),
//! 因此 Rust 侧测试红了只有两种可能 —— Rust 写错了,或 Node 侧语义变了。
//! 两种都必须人工确认,不存在"顺手改一下期望值"的处理方式。

pub mod blockstore;
pub mod file_kind;
pub mod ignore;
pub mod plan;
pub mod schedule;
pub mod version;

pub use version::{VersionRelation, VersionVector};

/// 本端支持的落盘代数。必须与 Node 侧 `src/config.ts` 的 `FORMAT_VERSION` 一致 ——
/// 两端共用同一数据目录,代数不同就意味着结构不同(见 docs/adr/0025 第 2 节)。
///
/// 测试 `format_version_matches_node` 会读 Node 的源码核对,防止两端各自改忘了同步。
pub const FORMAT_VERSION: u64 = 1;

/// 本端版本号。由 `build.rs` 从仓库根 `package.json` 注入(见 ADR-0025 第 3 节)。
///
/// 取 `env!` 而不是 `option_env!` 加回退:`build.rs` 读不到版本号时已经 panic,
/// 能走到这里就一定有值。给回退值等于给「发布物自称 0.0.0」留后门。
pub fn version_string() -> &'static str {
    env!("SYNCX_VERSION")
}
