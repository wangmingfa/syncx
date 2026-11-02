//! axum 路由、WS 状态推送、内嵌前端。
//!
//! 前端由 `rust-embed` 在编译期内嵌进二进制(见 `build.rs` 与 ADR-0025 第 3 节):
//! 发布产物是单个文件,运行时不需要 `dist/web/` 目录存在。
//!
//! 路径与 Node 侧 `src/api/routes/public.ts` 保持一致:`/health`、`/healthz`、
//! `/favicon.svg`、`/client.js`、`/`。
//!
//! **本 crate 的分层**:纯文件系统 / 纯配置的能力(`config`、`history`、`share`、
//! `filebrowser`、`fsops`、`mutate`、`ignorefile`、`report`、`calendar`)在这里
//! 直接实现,与 Node 逐字节对齐;需要活会话的能力经 [`deps::ControlOps`] 注入,
//! 未注入即视为「没有这项能力」,由路由回 404 / 503。

use std::sync::Arc;

use axum::Router;

pub mod auth;
pub mod calendar;
pub mod config;
pub mod deps;
pub mod filebrowser;
pub mod fsops;
pub mod history;
pub mod ignorefile;
pub mod mutate;
pub mod report;
pub mod routes;
pub mod share;
pub mod status;
pub mod ws;
pub mod ws_routes;

/// 前端产物。`folder = "../../../dist/web"` 是相对 crate 根目录的路径
/// (crates/syncx-api → crates → rust → 仓库根)。
///
/// `build.rs` 已校验 `dist/web/client.js` 存在,编译期就该失败;这里的 `None`
/// 分支只兜底"编译后产物被删"的情况,而不是正常态。
#[derive(rust_embed::Embed)]
#[folder = "../../../dist/web"]
pub(crate) struct WebAssets;

/// 站点图标。与 Node 侧 `src/favicon.ts` 一样内联为常量而非从磁盘读:
/// 单文件产物运行时没有 `web/` 目录,磁盘读取必然失败,而静默失败会让页面白屏。
///
/// **真值在 `src/favicon.ts`**。这里是逐字复制的一份,没有跨语言 import 的办法;
/// 改图标时两处都要动。用 `include_str!` 而不是 Rust 原始字符串:`#0F6E56` 里的
/// `#` 在原始字符串里会被当成标识符前缀,直接编译失败。
pub(crate) const FAVICON_SVG: &str = include_str!("favicon.svg");

/// 页面壳。与 Node 侧 `UI_SHELL`(`src/api/helpers.ts`)逐字一致 ——
/// 深色模式首绘那段内联脚本必须保留,否则深色用户会先白闪一下。
pub(crate) const UI_SHELL: &str = include_str!("ui_shell.html");

/// 生成完整路由:HTTP 分发 + 两条 WS 通道。
///
/// 服务必须用 `.into_make_service_with_connect_info::<SocketAddr>()` 挂载 ——
/// 登录/分享限流按来源 IP 记账,缺了连接信息就退化成「所有人共用一个桶」。
pub fn router(state: Arc<deps::AppState>) -> Router {
    routes::router(state)
}
