//! 浏览器内终端(PTY)。逐条对齐 Node 侧 `src/api/terminal.ts`。
//!
//! 协议是 JSON 文本帧,与路由层(`syncx-api/src/ws_routes.rs::terminal_loop`)约定:
//!  * 出站 `{t:'ready',shell,pty}` → `{t:'out',data}`* → `{t:'exit',code}`;
//!  * 入站 `{t:'in',data}` / `{t:'resize',cols,rows}` / `{t:'sigint'}` / `{t:'ping'}`。
//!
//! 两道存活门是**安全边界**,不是体验优化:终端没有空闲上限,一个忘关的标签页就是一条
//! 永久可用的远程 shell。`idle` 10 分钟、绝对上限 1 小时,超时即杀子进程并回 exit。
//!
//! 为什么要 `portable-pty` 而不是直接 `Command`:交互式 shell 只有在真 TTY 上才会
//! 给出提示符、行编辑、作业控制;走管道时很多命令会切换到无缓冲/无颜色模式,用户看到
//! 的就不是自己那台机器的 shell。PTY 打不开时才退回管道(仍然可用,只是 Term 能力弱)。

use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::json;

/// 闲置多久算「人走了」(与 Node 的 `TERMINAL_IDLE_MS = ELEVATE_TTL_MS` 同值)。
pub const TERMINAL_IDLE_MS: u64 = 10 * 60 * 1000;
/// 单条会话的绝对上限,与闲置门无关。
pub const TERMINAL_MAX_LIFETIME_MS: u64 = 60 * 60 * 1000;
/// 收割节拍(Node 是 30s;这里每秒检查一次,代价可以忽略而响应更快)。
const REAPER_INTERVAL_MS: u64 = 1_000;

/// 默认终端尺寸。与 Node 的 spawn 选项一致。
pub const DEFAULT_COLS: u16 = 80;
pub const DEFAULT_ROWS: u16 = 24;

/// 选 shell:Windows 用随系统的 PowerShell(全路径,不依赖 PATH),
/// 其余用 `$SHELL`(登录 shell),取不到再退 `/bin/bash`。
pub fn pick_shell() -> String {
    if cfg!(windows) {
        // 与 Node 一致:走全路径,避免在 PATH 里被别的 powershell 抢先
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
        return format!(
            "{root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
        );
    }
    std::env::var("SHELL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "/bin/bash".to_string())
}

fn home_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from)
}

/// 尺寸钳位:浏览器可能塞 0 或离谱的大数,内核会拒绝或画出一片空白。
pub fn clamp_dim(raw: Option<i64>, fallback: u16) -> u16 {
    match raw {
        Some(value) => (value.clamp(2, 999)) as u16,
        None => fallback,
    }
}

/// 管道模式下的换行补齐:管道没有行编辑,不发回车 shell 就永远收不到这一行。
pub fn pipe_input_line(data: &str) -> String {
    if data.ends_with('\n') {
        data.to_string()
    } else {
        format!("{data}\n")
    }
}

fn frame_ready(shell: &str, pty: bool) -> String {
    json!({ "t": "ready", "shell": shell, "pty": pty }).to_string()
}

fn frame_out(data: &str) -> String {
    json!({ "t": "out", "data": data }).to_string()
}

fn frame_exit(code: i32) -> String {
    json!({ "t": "exit", "code": code }).to_string()
}

/// 一条会话的控制面。
struct SessionControl {
    /// 入站帧(原始 JSON 文本)。
    inbound: mpsc::Sender<String>,
    /// 收尾信号:连接已断,子进程必须立即杀掉(不等闲置门)。
    closing: Arc<AtomicBool>,
}

/// 浏览器内终端中枢。
///
/// 目前一个进程内可以并存多条会话(多个标签页);中枢只持有一条**关闭开关**,
/// 便于 daemon 退出时统一收割。
#[derive(Clone, Default)]
pub struct TerminalHub {
    sessions: Arc<Mutex<Vec<SessionControl>>>,
}

impl TerminalHub {
    pub fn new() -> Self {
        Self::default()
    }

    /// 开一条终端会话。返回 `None` 仅当子进程完全起不来(PTY 与管道都失败),
    /// 此时路由层会回 `{t:'exit',code:1}`。
    pub fn open(&self) -> Option<syncx_api::deps::TerminalLink> {
        let (inbound_tx, inbound_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let (output_tx, output_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let (std_tx, std_rx) = mpsc::channel::<String>();
        let closing = Arc::new(AtomicBool::new(false));

        let shell = pick_shell();
        // 真正的 spawn 在专属线程里做:PTY 的打开/等待都是阻塞调用,放进 tokio
        // 工作线程会占住一个调度槽。这里先探测一次能否起来,起不来就别把空通道交出去。
        let spawn = std::sync::mpsc::channel::<Option<()>>();
        let thread_shell = shell.clone();
        let thread_output = output_tx.clone();
        let thread_closing = Arc::clone(&closing);
        let spawned = std::thread::Builder::new()
            .name("syncx-terminal".to_string())
            .spawn(move || {
                run_session(
                    thread_shell,
                    std_rx,
                    thread_output,
                    thread_closing,
                    spawn.0,
                );
            })
            .ok();

        spawned.as_ref()?;
        match spawn.1.recv_timeout(Duration::from_secs(10)) {
            Ok(Some(())) => {}
            // 超时/失败:线程已经退出或即将退出,输出通道会关闭,路由层照常收尾
            _ => return None,
        }

        let control = SessionControl {
            inbound: std_tx.clone(),
            closing: Arc::clone(&closing),
        };
        if let Ok(mut list) = self.sessions.lock() {
            list.push(control);
        }

        // 桥接层:tokio 的入站通道 → 阻塞线程能收的 std 通道。
        tokio::spawn(async move {
            let mut inbound_rx = inbound_rx;
            while let Some(frame) = inbound_rx.recv().await {
                if std_tx.send(frame).is_err() {
                    break;
                }
            }
        });

        let closing_for_shutdown = Arc::clone(&closing);
        Some(syncx_api::deps::TerminalLink {
            inbound: inbound_tx,
            output: output_rx,
            shutdown: Some(Box::new(move || {
                closing_for_shutdown.store(true, Ordering::SeqCst);
            })),
        })
    }

    /// 收割全部会话(daemon 退出时调用)。
    pub fn close(&self) {
        if let Ok(mut list) = self.sessions.lock() {
            for session in list.iter() {
                session.closing.store(true, Ordering::SeqCst);
                let _ = session.inbound.send(String::new()); // 唤醒阻塞收
            }
            list.clear();
        }
    }
}

/// 会话主体:启动 shell → 收帧 → 两个存活门 → 收尾。整段跑在专属线程上。
fn run_session(
    shell: String,
    inbound: mpsc::Receiver<String>,
    output: tokio::sync::mpsc::UnboundedSender<String>,
    closing: Arc<AtomicBool>,
    spawned: mpsc::Sender<Option<()>>,
) {
    let mut session = match ShellSession::start(&shell, &output) {
        Some(session) => session,
        None => {
            let _ = spawned.send(None);
            return;
        }
    };
    let _ = spawned.send(Some(()));

    let opened_at = Instant::now();
    let mut last_touch = Instant::now();

    loop {
        if closing.load(Ordering::SeqCst) {
            break;
        }
        // 两道存活门:闲置(人走了)与绝对上限(标签页开着但被遗忘)
        let idle_for = last_touch.elapsed().as_millis() as u64;
        let lived_for = opened_at.elapsed().as_millis() as u64;
        if idle_for >= TERMINAL_IDLE_MS || lived_for >= TERMINAL_MAX_LIFETIME_MS {
            break;
        }

        match inbound.recv_timeout(Duration::from_millis(REAPER_INTERVAL_MS)) {
            Ok(frame) => {
                if frame.is_empty() {
                    continue;
                }
                last_touch = Instant::now();
                session.handle(&frame, &output);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    session.shutdown(&output);
}

/// 一条 shell 的两种承载形态。
enum ShellSession {
    Pty(PtySession),
    Pipe(PipeSession),
}

impl ShellSession {
    fn start(shell: &str, output: &tokio::sync::mpsc::UnboundedSender<String>) -> Option<Self> {
        if let Some(pty) = PtySession::start(shell, output) {
            let _ = output.send(frame_ready(shell, true));
            return Some(ShellSession::Pty(pty));
        }
        let pipe = PipeSession::start(shell, output)?;
        let _ = output.send(frame_ready(shell, false));
        Some(ShellSession::Pipe(pipe))
    }

    fn handle(&mut self, frame: &str, output: &tokio::sync::mpsc::UnboundedSender<String>) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(frame) else {
            return;
        };
        let kind = value.get("t").and_then(|t| t.as_str()).unwrap_or("");
        match kind {
            // `ping` 只刷新 lastTouch(上面已经刷过),无其它动作
            "ping" => {}
            "in" => {
                let data = value.get("data").and_then(|d| d.as_str()).unwrap_or("");
                match self {
                    ShellSession::Pty(pty) => pty.write(data),
                    ShellSession::Pipe(pipe) => pipe.write(&pipe_input_line(data)),
                }
            }
            "resize" => {
                let cols = clamp_dim(value.get("cols").and_then(|v| v.as_i64()), DEFAULT_COLS);
                let rows = clamp_dim(value.get("rows").and_then(|v| v.as_i64()), DEFAULT_ROWS);
                if let ShellSession::Pty(pty) = self {
                    pty.resize(cols, rows);
                }
                // 管道模式没有窗口尺寸的概念,忽略即可
            }
            "sigint" => {
                // PTY 里 Ctrl-C 是终端驱动生成的信号,前端直接发 `\x03` 即可;
                // 管道模式没有这一层,只能杀进程再起一个(Node 同款)。
                if let ShellSession::Pipe(pipe) = self {
                    // 先取名字再换:respawn 之后旧 pipe 会被替换,借不到它的字段
                    let shell = pipe.shell_name();
                    if let Some(next) = pipe.respawn(output) {
                        *self = ShellSession::Pipe(next);
                        let _ = output.send(frame_ready(&shell, false));
                    }
                }
            }
            _ => {}
        }
    }

    fn shutdown(&mut self, output: &tokio::sync::mpsc::UnboundedSender<String>) {
        match self {
            ShellSession::Pty(pty) => {
                pty.kill();
                let _ = output.send(frame_exit(0));
            }
            ShellSession::Pipe(pipe) => {
                let code = pipe.kill();
                let _ = output.send(frame_exit(code));
            }
        }
    }
}

/// PTY 承载。master 在会话线程上,reader 在自己的线程上 —— `MasterPty` 不是 `Sync`,
/// 只能「谁用谁持有」,这正是它被拆成两半的原因。
struct PtySession {
    master: Box<dyn portable_pty::MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
}

impl PtySession {
    fn start(shell: &str, output: &tokio::sync::mpsc::UnboundedSender<String>) -> Option<Self> {
        let pty_system = portable_pty::native_pty_system();
        let pair = pty_system
            .openpty(portable_pty::PtySize {
                rows: DEFAULT_ROWS,
                cols: DEFAULT_COLS,
                pixel_width: 0,
                pixel_height: 0,
            })
            .ok()?;

        let mut command = portable_pty::CommandBuilder::new(shell);
        if let Some(home) = home_dir() {
            command.cwd(home);
        }
        command.env("TERM", "xterm-256color");
        let mut child = pair.slave.spawn_command(command).ok()?;
        // slave 必须显式丢弃:否则本端也占着一个句柄,子进程退出后 reader 等不到 EOF
        drop(pair.slave);

        let reader = pair.master.try_clone_reader().ok()?;
        let writer = pair.master.take_writer().ok()?;
        let killer = child.clone_killer();

        // 输出线程:读到多少发多少;EOF 之后等子进程退出码再发 exit
        let out = output.clone();
        std::thread::Builder::new()
            .name("syncx-terminal-pty".to_string())
            .spawn(move || {
                let mut reader = reader;
                let mut buf = vec![0u8; 8192];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            let text = String::from_utf8_lossy(&buf[..n]).to_string();
                            if out.send(frame_out(&text)).is_err() {
                                return;
                            }
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(_) => break,
                    }
                }
                // 读端结束时子进程通常已退出;wait 拿真实退出码,拿不到按 0
                let code = child
                    .wait()
                    .ok()
                    .map(|status| status.exit_code() as i32)
                    .unwrap_or(0);
                let _ = out.send(frame_exit(code));
            })
            .ok()?;

        Some(Self {
            master: pair.master,
            writer,
            killer,
        })
    }

    fn write(&mut self, data: &str) {
        let _ = self.writer.write_all(data.as_bytes());
        let _ = self.writer.flush();
    }

    fn resize(&self, cols: u16, rows: u16) {
        let _ = self.master.resize(portable_pty::PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        });
    }

    fn kill(&mut self) {
        let _ = self.killer.kill();
    }
}

/// 管道承载:`portable-pty` 打不开时的退路。功能仍在(能跑命令、能看输出),
/// 只是没有行编辑与窗口尺寸语义。
struct PipeSession {
    shell: String,
    child: std::process::Child,
    stdin: Option<std::process::ChildStdin>,
}

impl PipeSession {
    fn start(shell: &str, output: &tokio::sync::mpsc::UnboundedSender<String>) -> Option<Self> {
        let mut command = std::process::Command::new(shell);
        if let Some(home) = home_dir() {
            command.current_dir(home);
        }
        command.env("TERM", "dumb");
        command.stdin(std::process::Stdio::piped());
        command.stdout(std::process::Stdio::piped());
        command.stderr(std::process::Stdio::piped());
        let mut child = command.spawn().ok()?;
        let stdin = child.stdin.take();
        forward_stream(child.stdout.take(), output.clone());
        forward_stream(child.stderr.take(), output.clone());
        let session = Self {
            shell: shell.to_string(),
            child,
            stdin,
        };
        // Windows 控制台默认不是 UTF-8:不先声明,中文输出到前端就是乱码
        #[cfg(windows)]
        session.write("[Console]::OutputEncoding=[System.Text.Encoding]::UTF8\r\n");
        Some(session)
    }

    fn shell_name(&self) -> String {
        self.shell.clone()
    }

    fn write(&mut self, data: &str) {
        if let Some(stdin) = self.stdin.as_mut() {
            let _ = stdin.write_all(data.as_bytes());
            let _ = stdin.flush();
        }
    }

    /// 杀掉并起一条新会话(SIGINT 的管道等价物)。
    fn respawn(&mut self, output: &tokio::sync::mpsc::UnboundedSender<String>) -> Option<Self> {
        self.stdin = None;
        let _ = self.child.kill();
        let _ = self.child.wait();
        Self::start(&self.shell, output)
    }

    /// 收尾:关 stdin(kill 会丢掉之后未读的输出,所以先让子进程退出再报码)。
    fn kill(&mut self) -> i32 {
        self.stdin = None;
        let _ = self.child.kill();
        self.child
            .wait()
            .ok()
            .and_then(|status| status.code())
            .unwrap_or(0)
    }
}

fn forward_stream<R: Read + Send + 'static>(
    stream: Option<R>,
    output: tokio::sync::mpsc::UnboundedSender<String>,
) {
    let Some(mut stream) = stream else { return };
    std::thread::Builder::new()
        .name("syncx-terminal-pipe".to_string())
        .spawn(move || {
            let mut buf = vec![0u8; 8192];
            loop {
                match stream.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let text = String::from_utf8_lossy(&buf[..n]).to_string();
                        if output.send(frame_out(&text)).is_err() {
                            return;
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
        })
        .ok();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dims_are_clamped_into_kernel_range() {
        assert_eq!(clamp_dim(Some(0), 24), 2);
        assert_eq!(clamp_dim(Some(1), 24), 2);
        assert_eq!(clamp_dim(Some(120), 24), 120);
        assert_eq!(clamp_dim(Some(100_000), 24), 999);
        assert_eq!(clamp_dim(None, 80), 80);
    }

    #[test]
    fn pipe_input_adds_missing_newline_only() {
        assert_eq!(pipe_input_line("ls"), "ls\n");
        assert_eq!(pipe_input_line("ls\n"), "ls\n");
        assert_eq!(pipe_input_line(""), "\n");
    }

    #[test]
    fn frames_match_node_shape() {
        assert_eq!(
            frame_ready("/bin/bash", true),
            r#"{"pty":true,"shell":"/bin/bash","t":"ready"}"#
        );
        assert_eq!(frame_out("hi"), r#"{"data":"hi","t":"out"}"#);
        assert_eq!(frame_exit(3), r#"{"code":3,"t":"exit"}"#);
    }

    #[test]
    fn shell_is_never_empty() {
        assert!(!pick_shell().trim().is_empty());
    }
}
