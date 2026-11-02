//! 系统服务模板:systemd / launchd / Windows `sc`。
//!
//! 三个模板与 Node 侧 `src/install.ts` **逐字节一致**,只有 `ExecStart` 里的可执行
//! 部分是 `syncx-rs` 自己的路径。转录时保留三处转义规则,因为它们的根因不同:
//!
//!  - systemd 的 `ExecStart` 按空白拆参数,路径里的空格与反斜杠必须转义;
//!  - launchd 的 plist 是 XML,`& < > " '` 必须转成实体,否则模板直接是非法 XML;
//!  - Windows `sc` 的 `binPath=` 用双引号包裹,路径里的 `"` 会提前闭合字符串。

pub struct InstallTarget {
    /// 可执行命令(可能含参数,如 `node /path/syncx.js`)。
    pub executable: String,
    pub config_path: String,
}

/// systemd `ExecStart`:反斜杠先转(`\\`),再转空格(`\ `)。顺序不能反 ——
/// 先转空格会把反斜杠加在已经转义的序列里。
fn escape_systemd(value: &str) -> String {
    value.replace('\\', "\\\\").replace(' ', "\\ ")
}

/// launchd plist 的 XML 实体转义。
fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// Windows `sc` 的 `binPath`:只转双引号。
fn escape_windows(value: &str) -> String {
    value.replace('"', "\\\"")
}

pub fn render_systemd_unit(target: &InstallTarget) -> String {
    let executable = escape_systemd(&target.executable);
    let config_path = escape_systemd(&target.config_path);
    format!(
        "[Unit]\n\
         Description=syncx file sync daemon\n\
         After=network.target\n\
         \n\
         [Service]\n\
         Type=simple\n\
         ExecStart={executable} start --config {config_path}\n\
         Restart=on-failure\n\
         \n\
         [Install]\n\
         WantedBy=multi-user.target\n"
    )
}

pub fn render_launchd_plist(target: &InstallTarget) -> String {
    let executable = escape_xml(&target.executable);
    let config_path = escape_xml(&target.config_path);
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
         <plist version=\"1.0\">\n\
         <dict>\n\
         \x20 <key>Label</key>\n\
         \x20 <string>com.syncx.daemon</string>\n\
         \x20 <key>ProgramArguments</key>\n\
         \x20 <array>\n\
         \x20   <string>{executable}</string>\n\
         \x20   <string>start</string>\n\
         \x20   <string>--config</string>\n\
         \x20   <string>{config_path}</string>\n\
         \x20 </array>\n\
         \x20 <key>RunAtLoad</key>\n\
         \x20 <true/>\n\
         \x20 <key>KeepAlive</key>\n\
         \x20 <true/>\n\
         </dict>\n\
         </plist>\n"
    )
}

pub fn render_windows_service(target: &InstallTarget) -> String {
    let executable = escape_windows(&target.executable);
    let config_path = escape_windows(&target.config_path);
    format!(
        "sc create syncx binPath= \"{executable} start --config {config_path}\" start= auto\n\
         sc start syncx\n"
    )
}

/// 按当前平台挑模板。与 Node `cli.ts` 的分派完全一致。
pub fn render_for_platform(target: &InstallTarget) -> String {
    if cfg!(target_os = "macos") {
        render_launchd_plist(target)
    } else if cfg!(target_os = "windows") {
        render_windows_service(target)
    } else {
        render_systemd_unit(target)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn systemd_escapes_backslash_before_space() {
        assert_eq!(escape_systemd(r"C:\a b\c"), r"C:\\a\ b\\c");
    }

    #[test]
    fn xml_escapes_all_five_entities() {
        assert_eq!(escape_xml(r#"a&b<c>d"e'f"#), "a&amp;b&lt;c&gt;d&quot;e&apos;f");
    }

    #[test]
    fn windows_escapes_quotes_only() {
        assert_eq!(escape_windows(r#"a"b"#), r#"a\"b"#);
        assert_eq!(escape_windows(r"C:\x y"), r"C:\x y");
    }

    #[test]
    fn launchd_template_is_well_formed() {
        let plist = render_launchd_plist(&InstallTarget {
            executable: "/usr/local/bin/syncx-rs".to_string(),
            config_path: "/Users/x/.syncx/config.json".to_string(),
        });
        assert!(plist.starts_with("<?xml version=\"1.0\" encoding=\"UTF-8\"?>"));
        assert!(plist.contains("<string>com.syncx.daemon</string>"));
        assert!(plist.contains("<string>start</string>"));
        assert!(plist.trim_end().ends_with("</plist>"));
    }

    #[test]
    fn systemd_template_uses_config_flag() {
        let unit = render_systemd_unit(&InstallTarget {
            executable: "/usr/bin/syncx-rs".to_string(),
            config_path: "/root/.syncx/config.json".to_string(),
        });
        assert!(unit.contains("ExecStart=/usr/bin/syncx-rs start --config /root/.syncx/config.json"));
        assert!(unit.contains("WantedBy=multi-user.target"));
    }
}
