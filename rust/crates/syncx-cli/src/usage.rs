//! 帮助/版本开关与顶层帮助文本。
//!
//! 文本与 Node 侧 `src/usage.ts` 的 `helpText` **逐行一致**,只有程序名不同
//! (`syncx` → `syncx-rs`)。这条一致性是有用的:用户在两个后端之间切换时不需要
//! 重学一遍选项,`--help` 的输出可以直接用于对照排查。

/// 帮助/版本开关:任一参数精确匹配即生效。
const HELP_FLAGS: [&str; 2] = ["-h", "--help"];
const VERSION_FLAGS: [&str; 2] = ["-v", "--version"];

pub fn wants_help(argv: &[String]) -> bool {
    argv.iter().any(|arg| HELP_FLAGS.contains(&arg.as_str()))
}

pub fn wants_version(argv: &[&String]) -> bool {
    argv.iter().any(|arg| VERSION_FLAGS.contains(&arg.as_str()))
}

/// 顶层帮助文本。`program` 是二进制名(`syncx-rs`),`version` 由 `build.rs` 注入。
pub fn help_text(program: &str, version: &str) -> String {
    let lines: Vec<String> = vec![
        format!("{program} {version} - 局域网 P2P 文件同步"),
        String::new(),
        "用法:".to_string(),
        format!("  {program} <command> [options]"),
        String::new(),
        "命令:".to_string(),
        "  start                     启动 daemon(默认命令,可省略)".to_string(),
        "  stop                      停止运行中的 daemon(优先优雅关闭)".to_string(),
        "  pause                     全局暂停同步(所有目录数据面停摆,连接与配对照常)"
            .to_string(),
        "  resume                    恢复全局暂停的同步".to_string(),
        "  status                    查看 Device ID 与共享目录概况".to_string(),
        "  install                   输出系统服务模板(systemd / launchd / Windows)".to_string(),
        "  invite <folder-path>      为已配置的共享目录生成一次性邀请码".to_string(),
        "  join <code> <local-path>  接受邀请并添加本地共享目录".to_string(),
        "  revoke <code>             吊销一个已发出的邀请码".to_string(),
        "  upgrade [tag]             自升级(默认 latest;Rust 后端从 GitHub Releases 取包)"
            .to_string(),
        "  diff <folder-path>        对比本机某共享目录与对端同一目录的内容(排查用,--device 指定对端)"
            .to_string(),
        String::new(),
        "选项:".to_string(),
        "  -h, --help                显示本帮助".to_string(),
        "  -v, --version             显示版本号".to_string(),
        "  --config <path>           配置文件路径(默认 ~/.syncx/config.json)".to_string(),
        "  --config-dir <dir>        数据目录(取 <dir>/config.json;与 --config 同时给出时后者优先)"
            .to_string(),
        "  --port <port>             peer 监听端口(默认 22000)".to_string(),
        "  --control-port <port>     Web UI / 控制 API 端口(默认 8384)".to_string(),
        "  --host <host>             控制 API 绑定地址(默认 127.0.0.1)".to_string(),
        "  --expose-control          允许把控制 API 绑到非回环地址(明文 HTTP,谨慎使用)"
            .to_string(),
        "  --log-file <path>         同时把日志写入文件".to_string(),
        "  --dev-vite <url>          开发用:把 Web UI 请求代理到 vite dev server".to_string(),
        String::new(),
        "示例:".to_string(),
        format!("  {program} start                    启动 daemon,打开 http://127.0.0.1:8384"),
        format!("  {program} stop                     停止运行中的 daemon"),
        format!("  {program} pause                    全局暂停同步(备份/维护时用,{program} resume 恢复)"),
        format!("  {program} status                   查看本机 Device ID"),
        format!("  {program} invite D:/sync           生成邀请码交给对端"),
        format!("  {program} join <code> D:/sync      接受邀请并开始同步"),
        format!("  {program} upgrade                  升级到最新正式版"),
        format!("  {program} upgrade beta             切到 beta 预发布通道"),
        format!("  {program} diff D:/sync             对比本机该目录与对端同一目录的内容差异"),
        String::new(),
    ];
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags_are_exact_matches() {
        let help = vec!["--help".to_string()];
        assert!(wants_help(&help));
        let not = vec!["--helpful".to_string()];
        assert!(!wants_help(&not));
        let flag = "-v".to_string();
        let version = vec![&flag];
        assert!(wants_version(&version));
    }

    #[test]
    fn help_lists_every_command() {
        let text = help_text("syncx-rs", "1.2.3");
        assert!(text.starts_with("syncx-rs 1.2.3 - 局域网 P2P 文件同步"));
        // 清单就是 `Command::parse` 认的全部取值;这里独立列一份,是为了在漏写
        // 帮助行时立刻炸掉,而不是跟着 `parse` 一起悄悄漂移。
        for command in [
            "start", "stop", "status", "install", "invite", "join", "revoke", "upgrade", "diff",
            "pause", "resume",
        ] {
            assert!(text.contains(command), "帮助文本缺少子命令 {command}");
        }
        // 末尾是一个空行(join 的最后一个元素),与 Node 版本的尾部一致
        assert!(text.ends_with('\n'));
    }
}
