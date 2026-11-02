//! Git 仓库感知与自动提交。对应 Node 侧 `src/git-monitor.ts`。
//!
//! 为什么不是「差不多就行」:git 的输出格式(`-z` 的 NUL 分隔、`%x1f` 字段分隔、
//! porcelain 的两列状态、`show --name-status` 的三段式改名记录)是**解析契约**,
//! 任一处口径不同,同一个仓库在两个后端下就会报出不同的改动清单。
//!
//! 每一处 `Command::new("git")` 都必须经过 `hide_console`:daemon 被自更新
//! detached 拉起后自己没有控制台,而 `git.exe` 是控制台子系统程序 —— 不加这个标志,
//! Windows 会为每次调用现开一个控制台窗口。默认 5s 一轮扫描的两笔 git 调用就是
//! 「每隔几秒弹两次黑框」。

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde_json::{json, Map, Value};

/// Windows:给子进程加 `CREATE_NO_WINDOW`,否则每次 git 调用都会闪一个控制台窗口。
/// 其它平台是空操作 —— 这个标志只在 Windows 上存在,不能无条件调用。
#[cfg(windows)]
fn hide_console(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x0800_0000);
}

#[cfg(not(windows))]
fn hide_console(_command: &mut Command) {}

/// 弹窗默认展示的提交条数。
pub const GIT_LOG_LIMIT: usize = 20;

/// 「推送弹窗」每目录最多列出的提交条数。
pub const GIT_UNPUSHED_LIMIT: usize = 50;

/// 工作区改动条目数封顶(弹窗树分批渲染受不了几十万条)。
pub const GIT_CHANGES_MAX: usize = 2000;

/// push 是网络操作,给足超时但必须封顶。
pub const GIT_PUSH_TIMEOUT_MS: u64 = 120_000;

/// 「最近提交」与「未推送提交」两处共用的机器可读格式。
const GIT_LOG_FORMAT: &str = "%h%x1f%an%x1f%aI%x1f%D%x1f%s%x1f%b";

/// `git add -A` / `git status` 的负向 pathspec:把 syncx 的在途中间态挡在版本库之外。
///
/// 断点续传之后 `.syncx-tmp` / `.syncx-partial` 会在目标文件旁边躺上一整个传输过程,
/// 放任 `git add -A` 把它们收进去就是几百 MB 半截内容进仓库历史。后缀取自
/// `syncx_core::ignore::SCRATCH_SUFFIXES`,两处共用一份事实。
fn scratch_pathspecs() -> Vec<String> {
    syncx_core::ignore::SCRATCH_SUFFIXES
        .iter()
        .map(|suffix| format!(":(exclude)*{suffix}"))
        .collect()
}

/// 一次 git 调用的结果。
struct GitOutput {
    stdout: Vec<u8>,
    stderr: String,
    success: bool,
}

/// 跑一次 git。`cwd` 是仓库目录;超时按 Node 侧各调用点给的秒数。
fn run_git(cwd: &Path, args: &[&str], timeout_ms: u64, max_out: usize) -> Option<GitOutput> {
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Windows:daemon 没有控制台,不加这个标志每次调用都会闪一个黑框
    hide_console(&mut command);
    let mut child = command.spawn().ok()?;

    // 没有内置超时(标准库不提供):轮询 `try_wait`,超时就杀。
    // git 的本地操作通常 <100ms,真到超时基本是挂在网络或锁上。
    let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(_) => return None,
        }
    }

    let output = child.wait_with_output().ok()?;
    let mut stdout = output.stdout;
    if stdout.len() > max_out {
        stdout.truncate(max_out);
    }
    Some(GitOutput {
        stdout,
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        success: output.status.success(),
    })
}

/// 文本版 git 调用(stdout 按 UTF-8 宽松解码)。
fn git_text(cwd: &Path, args: &[&str], timeout_ms: u64, max_out: usize) -> Option<String> {
    let output = run_git(cwd, args, timeout_ms, max_out)?;
    if !output.success {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).to_string())
}

/// 带 stderr 的 git 调用(需要把失败原因透给前端的调用点用)。
fn git_checked(cwd: &Path, args: &[&str], timeout_ms: u64, max_out: usize) -> Result<Vec<u8>, String> {
    let output = run_git(cwd, args, timeout_ms, max_out).ok_or_else(|| "git 执行失败".to_string())?;
    if output.success {
        return Ok(output.stdout);
    }
    // 取 stderr 首行:多行 inflate 错误里第一行已够说明问题,整段塞进弹窗太长
    let first = output.stderr.trim().lines().next().unwrap_or("").trim();
    Err(if first.is_empty() {
        "git 读取失败".to_string()
    } else {
        first.to_string()
    })
}

/// 检测目录是否为 git 仓库(`.git` 存在,可以是目录或文件(worktree))。
pub fn is_git_repo(folder_path: &Path) -> bool {
    folder_path.join(".git").exists()
}

/// 获取 HEAD 当前提交哈希;无提交(空仓库)返回 `None`。
pub fn get_last_commit_hash(folder_path: &Path) -> Option<String> {
    let text = git_text(folder_path, &["rev-parse", "HEAD"], 5_000, 64 * 1024)?;
    let hash = text.trim();
    if hash.is_empty() {
        None
    } else {
        Some(hash.to_string())
    }
}

/// 两提交之间的信息。
#[derive(Debug, Clone)]
pub struct CommitInfo {
    pub hash: String,
    pub parent_hash: String,
    pub message: String,
    pub full_message: String,
    pub changed_files: Vec<String>,
    pub diff_stat: Option<String>,
    /// 本批次所有提交的 subject(旧→新,含最后一笔)。
    pub commit_subjects: Vec<String>,
}

/// 收集两个提交之间的信息。`from_hash` 不含,`to_hash` 含。
pub fn get_commit_info(folder_path: &Path, from_hash: &str, to_hash: &str) -> Option<CommitInfo> {
    let range = format!("{from_hash}..{to_hash}");
    let log = git_text(
        folder_path,
        &[
            "log",
            "--format=%H%n%P%n%s%n%b%n---SYNCX-END---",
            &range,
        ],
        5_000,
        1024 * 1024,
    )?;

    // 每个提交由 ---SYNCX-END--- 分隔;trim 不能省 —— 分隔符之后的 entry 带前导换行,
    // 不剥掉取 [2] 会错位到父哈希
    let entries: Vec<String> = log
        .split("---SYNCX-END---")
        .filter(|entry| !entry.trim().is_empty())
        .map(|entry| entry.trim().to_string())
        .collect();
    if entries.is_empty() {
        return None;
    }

    // 整批提交的 subject,旧→新(git log 输出为新→旧,故倒序收集)
    let commit_subjects: Vec<String> = entries
        .iter()
        .map(|entry| {
            entry
                .lines()
                .nth(2)
                .map(|line| line.trim().to_string())
                .unwrap_or_default()
        })
        .filter(|subject| !subject.is_empty())
        .rev()
        .collect();

    // 取第一个 entry(最新的):git log 输出为新→旧,取最后一个在批次只有一笔时碰巧
    // 正确,一轮攒多笔时取到的会是最旧的一笔(hash、消息、变更清单全错位)
    let first = &entries[0];
    let lines: Vec<&str> = first.lines().collect();
    if lines.len() < 3 {
        return None;
    }

    let hash = lines[0].trim().to_string();
    let parent_hash = lines[1]
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_string();
    let message = lines[2].trim().to_string();
    let full_message = lines[2..].join("\n").trim().to_string();

    let diff_name_only = git_text(
        folder_path,
        &["diff", "--name-only", &range],
        5_000,
        1024 * 1024,
    )
    .unwrap_or_default();
    let changed_files: Vec<String> = diff_name_only
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| line.to_string())
        .collect();

    // diff stat 获取失败不影响主流程
    let diff_stat = git_text(folder_path, &["diff", "--stat", &range], 5_000, 64 * 1024)
        .map(|text| text.trim().to_string());

    Some(CommitInfo {
        hash,
        parent_hash,
        message,
        full_message,
        changed_files,
        diff_stat,
        commit_subjects,
    })
}

/// 提交历史弹窗的一行。
#[derive(Debug, Clone, PartialEq)]
pub struct GitCommitEntry {
    /// 短哈希(展示与复制用)。
    pub hash: String,
    pub subject: String,
    /// 提交正文(不含首行);空串 = 这笔没有正文。
    pub body: String,
    pub author: String,
    /// ISO 8601(git 的 `%aI`,带时区偏移)。
    pub date: String,
    /// 引用装饰原样串(git 的 `%D`)。
    pub refs: String,
}

impl GitCommitEntry {
    pub fn to_json(&self) -> Value {
        // 字段顺序与 Node 的对象字面量一致:hash/subject/body/author/date/refs
        let mut map = Map::new();
        map.insert("hash".to_string(), json!(self.hash));
        map.insert("subject".to_string(), json!(self.subject));
        map.insert("body".to_string(), json!(self.body));
        map.insert("author".to_string(), json!(self.author));
        map.insert("date".to_string(), json!(self.date));
        map.insert("refs".to_string(), json!(self.refs));
        Value::Object(map)
    }
}

/// NUL 记录 + 0x1f 字段 → 提交条目。
///
/// 为什么不用行解析:提交**正文是多行的**,逐行读会在正文第二行处错位。`-z` 的记录
/// 分隔(NUL)是 git 自己保证的手段,`%x1f` 是用户几乎不可能敲进消息的分隔符;
/// 且正文放在最后一个字段,消息里真混入 `%x1f` 也只是并回正文,不挪动其它字段。
fn parse_commit_records(out: &str) -> Vec<GitCommitEntry> {
    out.split('\0')
        .filter(|record| !record.is_empty())
        .map(|record| {
            let fields: Vec<&str> = record.split('\x1f').collect();
            GitCommitEntry {
                hash: fields.first().copied().unwrap_or("").to_string(),
                author: fields.get(1).copied().unwrap_or("").to_string(),
                date: fields.get(2).copied().unwrap_or("").to_string(),
                refs: fields.get(3).copied().unwrap_or("").to_string(),
                subject: fields.get(4).copied().unwrap_or("").to_string(),
                body: fields.get(5..).map(|rest| rest.join("\x1f")).unwrap_or_default().trim().to_string(),
            }
        })
        .collect()
}

/// 读取最近 N 条提交。`None` = 不是 git 仓库(调用方据此隐藏入口)。
pub fn list_recent_commits(folder_path: &Path, limit: usize) -> Result<Option<Vec<GitCommitEntry>>, String> {
    if !is_git_repo(folder_path) {
        return Ok(None);
    }

    let limit_text = limit.to_string();
    let format_arg = format!("--format={GIT_LOG_FORMAT}");
    let output = run_git(
        folder_path,
        &[
            "log",
            "-n",
            &limit_text,
            "-z",
            "--no-color",
            "--no-show-signature",
            &format_arg,
        ],
        10_000,
        4 * 1024 * 1024,
    )
    .ok_or_else(|| "git log 读取失败".to_string())?;

    if !output.success {
        // 空仓库时 git log 退出码 128:是「没有提交」而非「读取失败」。用 rev-parse
        // 复核而不是解析 stderr 文案 —— 文案随 git 版本/语言变化,不可靠。
        if get_last_commit_hash(folder_path).is_none() {
            return Ok(Some(Vec::new()));
        }
        let first = output.stderr.trim().lines().next().unwrap_or("").trim();
        return Err(if first.is_empty() {
            "git log 读取失败".to_string()
        } else {
            first.to_string()
        });
    }

    Ok(Some(parse_commit_records(&String::from_utf8_lossy(
        &output.stdout,
    ))))
}

/// 「提交展开」里的一行。
#[derive(Debug, Clone, PartialEq)]
pub struct GitCommitFileEntry {
    /// git name-status 状态字母(M/A/D/R/C/T 等)。
    pub status: String,
    /// 提交后的路径(改名/复制时为新路径)。
    pub path: String,
    pub orig_path: Option<String>,
}

impl GitCommitFileEntry {
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("status".to_string(), json!(self.status));
        map.insert("path".to_string(), json!(self.path));
        if let Some(orig) = &self.orig_path {
            map.insert("origPath".to_string(), json!(orig));
        }
        Value::Object(map)
    }
}

/// 提交哈希的形状闸:git 的对象名只可能是 7–40 位十六进制。
///
/// 从源头挡掉两类输入:以 `-` 开头的字符串会被 git 当成**选项**解析(选项注入),
/// 以及任意把 rev 表达式当哈希传进来的调用方失误。
pub fn is_commit_hash(hash: &str) -> bool {
    let bytes = hash.as_bytes();
    (7..=40).contains(&bytes.len()) && bytes.iter().all(|byte| byte.is_ascii_hexdigit())
}

/// 某笔提交动了哪些文件(`git show --format= --name-status -z -M`)。
///
/// `-z` 是必需的:文本模式会把非 ASCII 路径转成八进制转义。`-z` 下记录为
/// `status\0path\0` 两段一组,改名/复制是 `R100\0旧\0新\0` 三段一组。
/// 空数组 = 这笔提交没有文件改动(典型:干净的合并提交)。
pub fn list_commit_files(folder_path: &Path, hash: &str) -> Result<Vec<GitCommitFileEntry>, String> {
    if !is_commit_hash(hash) {
        return Err("非法的提交哈希".to_string());
    }

    let stdout = git_checked(
        folder_path,
        &[
            "show",
            "--format=",
            "--name-status",
            "-z",
            "-M",
            "--no-color",
            hash,
        ],
        10_000,
        4 * 1024 * 1024,
    )?;
    let text = String::from_utf8_lossy(&stdout);

    let fields: Vec<&str> = text.split('\0').collect();
    let mut entries = Vec::new();
    let mut index = 0usize;
    while index < fields.len() {
        let status = fields[index];
        // 尾部:最后一个记录以 \0 结尾,split 后残留一个空串,直接收尾
        if status.is_empty() {
            break;
        }
        let path = fields.get(index + 1).copied().unwrap_or("");
        if path.is_empty() {
            break;
        }
        // 改名/复制状态带相似度后缀(R100/C75),语义按首字母;-z 三段为
        // `R100\0旧路径\0新路径`,path 取提交后的新路径
        if status.starts_with('R') || status.starts_with('C') {
            let orig_path = fields.get(index + 1).copied().unwrap_or("");
            let new_path = fields.get(index + 2).copied().unwrap_or("");
            if new_path.is_empty() {
                break;
            }
            entries.push(GitCommitFileEntry {
                status: status.to_string(),
                path: new_path.to_string(),
                orig_path: Some(orig_path.to_string()),
            });
            index += 3;
        } else {
            entries.push(GitCommitFileEntry {
                status: status.to_string(),
                path: path.to_string(),
                orig_path: None,
            });
            index += 2;
        }
    }
    Ok(entries)
}

/// 某笔提交的父提交列表(`git rev-list --parents -n 1`)。空数组 = 根提交。
pub fn get_commit_parents(folder_path: &Path, hash: &str) -> Result<Vec<String>, String> {
    if !is_commit_hash(hash) {
        return Err("非法的提交哈希".to_string());
    }
    let stdout = git_checked(
        folder_path,
        &["rev-list", "--parents", "-n", "1", hash],
        10_000,
        256 * 1024,
    )?;
    let text = String::from_utf8_lossy(&stdout);
    // 输出形如 `<hash> <parent1> [parent2 ...]`,首段是提交自己
    Ok(text
        .split_whitespace()
        .filter(|part| !part.is_empty())
        .skip(1)
        .map(|part| part.to_string())
        .collect())
}

/// 工作区是否有未提交变更(含未跟踪文件)。
pub fn has_uncommitted_changes(folder_path: &Path) -> bool {
    let mut args: Vec<&str> = vec!["status", "--porcelain", "--"];
    let specs = scratch_pathspecs();
    args.extend(specs.iter().map(String::as_str));
    match git_text(folder_path, &args, 5_000, 1024 * 1024) {
        Some(text) => !text.trim().is_empty(),
        None => false,
    }
}

/// 工作区一条未提交变更。
#[derive(Debug, Clone, PartialEq)]
pub struct GitChangeEntry {
    /// 相对仓库根的路径(POSIX 分隔);未跟踪目录已去尾斜杠。
    pub path: String,
    /// `true` = git 把「整棵未跟踪目录」折叠成的这一条记录。
    pub dir: bool,
    /// `modified` / `added` / `deleted` / `renamed`。
    pub status: &'static str,
    pub orig_path: Option<String>,
    /// 已 staged(git status 第一列非空/非 `?`)。
    pub staged: bool,
}

impl GitChangeEntry {
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("path".to_string(), json!(self.path));
        if self.dir {
            map.insert("dir".to_string(), json!(true));
        }
        map.insert("status".to_string(), json!(self.status));
        if let Some(orig) = &self.orig_path {
            map.insert("origPath".to_string(), json!(orig));
        }
        if self.staged {
            map.insert("staged".to_string(), json!(true));
        }
        Value::Object(map)
    }
}

/// 盘点工作区的未提交变更。`None` = 不是 git 仓库。
///
/// 用 `-z`(NUL 分隔)解析:路径里的空格/引号/Unicode 不会被引号转义坑到;
/// rename 条目跟两个记录(新路径 + 原路径),porcelain 的既有约定。
pub fn get_uncommitted_changes(
    folder_path: &Path,
) -> Option<(Vec<GitChangeEntry>, bool)> {
    if !is_git_repo(folder_path) {
        return None;
    }
    let mut args: Vec<&str> = vec!["status", "--porcelain", "-z", "--"];
    let specs = scratch_pathspecs();
    args.extend(specs.iter().map(String::as_str));
    let text = git_text(folder_path, &args, 10_000, 4 * 1024 * 1024)?;

    let records: Vec<&str> = text.split('\0').filter(|record| !record.is_empty()).collect();
    let mut entries = Vec::new();
    let mut index = 0usize;
    while index < records.len() {
        let record = records[index];
        // 每条记录:XY<空格>path(X=暂存区列,Y=工作区列,?? = 未跟踪)
        let xy = record.get(..2).unwrap_or("");
        let mut path = record.get(3..).unwrap_or("");
        if path.is_empty() {
            index += 1;
            continue;
        }
        // 尾斜杠必须在这里去掉:留着的话前端按 '/' 切段建树会切出一个空名字的行
        let dir = path.ends_with('/');
        if dir {
            path = &path[..path.len() - 1];
        }
        let mut orig_path = None;
        if xy.contains('R') || xy.contains('C') {
            index += 1;
            orig_path = records.get(index).map(|value| value.to_string());
        }
        // 归类优先级:删除 > 重命名/复制 > 新增 > 修改 —— 一个「先删再加回来」的
        // 条目按删除理解更贴近用户直觉;?? 恒为 added
        let status = if xy.contains('D') {
            "deleted"
        } else if orig_path.is_some() {
            "renamed"
        } else if xy.contains('A') || xy == "??" {
            "added"
        } else {
            "modified"
        };
        let staged = {
            let first = xy.chars().next().unwrap_or(' ');
            first != ' ' && first != '?'
        };
        entries.push(GitChangeEntry {
            path: path.to_string(),
            dir,
            status,
            orig_path,
            staged,
        });
        if entries.len() >= GIT_CHANGES_MAX {
            return Some((entries, true));
        }
        index += 1;
    }
    Some((entries, false))
}

/// `git show <rev>:<path>` 的三种结果。
///
/// 必须分清,不能糊成「取不到」:没这个文件 ≠ 读失败,糊成一种会把人支去查一个
/// 不存在的问题(文件明明在盘上)。
#[derive(Debug, Clone)]
pub enum HeadRead {
    Bytes(Vec<u8>),
    /// 路径不在那个版本里(新文件 / 根提交里没有的东西)。
    Absent,
    Error(String),
}

/// 读取某文件在任意 rev 里的字节。
pub fn read_file_at(folder_path: &Path, rev: &str, rel_path: &str) -> HeadRead {
    let spec = format!("{rev}:{rel_path}");
    let output = match run_git(folder_path, &["show", &spec], 10_000, 32 * 1024 * 1024) {
        Some(output) => output,
        None => return HeadRead::Error("git 读取失败".to_string()),
    };
    if output.success {
        return HeadRead::Bytes(output.stdout);
    }
    // 两种文案都是「路径不在那个版本里」:
    //   does not exist in '<rev>' / exists on disk, but not in '<rev>'
    if output.stderr.contains("does not exist in") || output.stderr.contains("exists on disk, but not in") {
        return HeadRead::Absent;
    }
    let first = output.stderr.trim().lines().next().unwrap_or("").trim();
    HeadRead::Error(if first.is_empty() {
        "git 读取失败".to_string()
    } else {
        first.to_string()
    })
}

/// 读取某文件在 HEAD 提交里的字节(工作区改动的「改前」一侧)。
pub fn read_file_at_head(folder_path: &Path, rel_path: &str) -> HeadRead {
    read_file_at(folder_path, "HEAD", rel_path)
}

/// 自动提交结果。
#[derive(Debug, Clone)]
pub struct AutoCommitResult {
    pub success: bool,
    pub hash: Option<String>,
    pub error: Option<String>,
}

/// 执行自动提交:`git add -A && git commit -m <message>`。
///
/// `--allow-empty` 是兜底:判定有无变更与 add 之间工作树可能被其他程序改回,
/// 保证提交命令本身不因竞态失败。
pub fn auto_commit(folder_path: &Path, message: &str) -> AutoCommitResult {
    let specs = scratch_pathspecs();
    let mut add_args: Vec<&str> = vec!["add", "-A", "--"];
    add_args.extend(specs.iter().map(String::as_str));

    let staged = run_git(folder_path, &add_args, 10_000, 1024 * 1024);
    let stage_error = match &staged {
        Some(output) if !output.success => Some(output.stderr.trim().to_string()),
        Some(_) => None,
        None => Some("git add 执行失败".to_string()),
    };
    if let Some(error) = stage_error {
        return AutoCommitResult {
            success: false,
            hash: None,
            error: Some(error),
        };
    }

    // 参数数组形式,不经 shell —— 消息里有引号/换行都不会被解释
    match run_git(folder_path, &["commit", "-m", message, "--allow-empty"], 10_000, 1024 * 1024) {
        Some(output) if output.success => AutoCommitResult {
            success: true,
            hash: get_last_commit_hash(folder_path),
            error: None,
        },
        Some(output) => {
            let text = output.stderr.trim();
            AutoCommitResult {
                success: false,
                hash: None,
                error: Some(if text.is_empty() {
                    "git commit 执行失败".to_string()
                } else {
                    text.to_string()
                }),
            }
        }
        None => AutoCommitResult {
            success: false,
            hash: None,
            error: Some("git commit 执行失败".to_string()),
        },
    }
}

/// 仓库 index.lock 的现况。
#[derive(Debug, Clone, PartialEq)]
pub struct GitIndexLockInfo {
    pub path: String,
    pub size: u64,
    pub mtime_ms: i64,
}

impl GitIndexLockInfo {
    pub fn to_json(&self) -> Value {
        json!({
            "path": self.path,
            "size": self.size,
            "mtimeMs": self.mtime_ms,
        })
    }
}

/// 删除 index.lock 的结果。
#[derive(Debug, Clone, PartialEq)]
pub struct GitIndexLockRemoveResult {
    pub ok: bool,
    pub path: Option<String>,
    /// `false` = 调用时锁已不存在(幂等:目的已达成)。
    pub removed: Option<bool>,
    pub error: Option<String>,
}

impl GitIndexLockRemoveResult {
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("ok".to_string(), json!(self.ok));
        if let Some(path) = &self.path {
            map.insert("path".to_string(), json!(path));
        }
        if let Some(removed) = self.removed {
            map.insert("removed".to_string(), json!(removed));
        }
        if let Some(error) = &self.error {
            map.insert("error".to_string(), json!(error));
        }
        Value::Object(map)
    }
}

/// 向 git 要 index.lock 的绝对路径。
///
/// worktree 的 `.git` 是文件,不能拼 `join(folder, ".git")`;只有
/// `git rev-parse --git-path` 答得准。
fn git_index_lock_path(folder_path: &Path) -> Option<PathBuf> {
    let text = git_text(folder_path, &["rev-parse", "--git-path", "index.lock"], 5_000, 64 * 1024)?;
    let relative = text.trim();
    if relative.is_empty() {
        return None;
    }
    let path = Path::new(relative);
    Some(if path.is_absolute() {
        path.to_path_buf()
    } else {
        folder_path.join(path)
    })
}

/// 读 index.lock 的现况;不存在 / 不是仓库 / git 答不上来时返回 `None`。只读。
pub fn find_git_index_lock(folder_path: &Path) -> Option<GitIndexLockInfo> {
    if !is_git_repo(folder_path) {
        return None;
    }
    let lock_path = git_index_lock_path(folder_path)?;
    // 路径虽然由 git 给出,仍校验文件名 —— 这个函数只该碰 index.lock
    if lock_path.file_name().and_then(|name| name.to_str()) != Some("index.lock") {
        return None;
    }
    let metadata = std::fs::metadata(&lock_path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    Some(GitIndexLockInfo {
        path: lock_path.display().to_string(),
        size: metadata.len(),
        mtime_ms: metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as i64)
            .unwrap_or(0),
    })
}

/// 删除残留的 index.lock(只删 git 指认的那一个,不接收调用方给的路径)。
pub fn remove_git_index_lock(folder_path: &Path) -> GitIndexLockRemoveResult {
    if !is_git_repo(folder_path) {
        return GitIndexLockRemoveResult {
            ok: false,
            path: None,
            removed: None,
            error: Some("该目录不是 git 仓库".to_string()),
        };
    }
    let Some(lock_path) = git_index_lock_path(folder_path) else {
        return GitIndexLockRemoveResult {
            ok: false,
            path: None,
            removed: None,
            error: Some("无法定位 git 锁文件".to_string()),
        };
    };
    let display = lock_path.display().to_string();
    if lock_path.file_name().and_then(|name| name.to_str()) != Some("index.lock") {
        return GitIndexLockRemoveResult {
            ok: false,
            path: Some(display),
            removed: None,
            error: Some("git 返回的锁路径异常,已中止删除".to_string()),
        };
    }
    match std::fs::remove_file(&lock_path) {
        Ok(()) => GitIndexLockRemoveResult {
            ok: true,
            path: Some(display),
            removed: Some(true),
            error: None,
        },
        // ENOENT:调用时锁已不存在,目的已达成
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => GitIndexLockRemoveResult {
            ok: true,
            path: Some(display),
            removed: Some(false),
            error: None,
        },
        Err(error) => GitIndexLockRemoveResult {
            ok: false,
            path: Some(display),
            removed: None,
            error: Some(error.to_string()),
        },
    }
}

/// 统计当前分支尚未推送的提交数。`None` = 不是仓库 / 未设置上游 / 读取失败。
///
/// 只与本地远程跟踪引用比较,**绝不 fetch**:不产生网络请求、不改动任何引用。
/// 先过 `is_git_repo` 闸:嵌在别的仓库内的 plain 目录会让 git 向上回溯,
/// 数到外层仓库的提交 —— 那与本函数「非仓库回 None」的契约不符。
pub fn count_unpushed_commits(folder_path: &Path) -> Option<u64> {
    if !is_git_repo(folder_path) {
        return None;
    }
    let text = git_text(folder_path, &["rev-list", "--count", "@{upstream}..HEAD"], 5_000, 64 * 1024)?;
    text.trim().parse::<u64>().ok()
}

/// 读取当前分支尚未推送的提交(`@{upstream}..HEAD`,新→旧)。
/// `None` = 不可列(不是仓库 / 未设置上游 / 读取失败),调用方据此整行跳过。
pub fn list_unpushed_commits(folder_path: &Path, limit: usize) -> Option<Vec<GitCommitEntry>> {
    if !is_git_repo(folder_path) {
        return None;
    }
    let limit_text = limit.to_string();
    let format_arg = format!("--format={GIT_LOG_FORMAT}");
    let text = git_text(
        folder_path,
        &[
            "log",
            "-n",
            &limit_text,
            "-z",
            "--no-color",
            "--no-show-signature",
            &format_arg,
            "@{upstream}..HEAD",
        ],
        10_000,
        4 * 1024 * 1024,
    )?;
    Some(parse_commit_records(&text))
}

/// 单目录 `git push` 的结果。
#[derive(Debug, Clone, PartialEq)]
pub struct GitPushResult {
    pub ok: bool,
    pub error: Option<String>,
}

impl GitPushResult {
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("ok".to_string(), json!(self.ok));
        if let Some(error) = &self.error {
            map.insert("error".to_string(), json!(error));
        }
        Value::Object(map)
    }
}

/// 对目录执行 `git push`:推当前分支到它配置的上游,不带 `-u`、不 fetch。
///
/// **必须异步**:push 要走网络,同步执行会把事件循环整个卡住(同步与接收全停),
/// 那不该是一个 UI 按钮的代价。
///
/// `GIT_TERMINAL_PROMPT=0`:daemon 没有控制台,缺凭据时让 git 立刻报错,
/// 而不是等一个永远不会出现的终端输入。
pub async fn git_push(folder_path: &Path, timeout_ms: u64) -> GitPushResult {
    let mut command = Command::new("git");
    command
        .arg("push")
        .current_dir(folder_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("GIT_TERMINAL_PROMPT", "0");
    hide_console(&mut command);

    let child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return GitPushResult {
                ok: false,
                error: Some(error.to_string()),
            }
        }
    };

    // tokio 的 wait_with_output 不提供超时:用 select! 赛一个定时器,超时则杀掉。
    let child = child;
    let wait = tokio::task::spawn_blocking(move || child.wait_with_output());
    let output = match tokio::time::timeout(Duration::from_millis(timeout_ms), wait).await {
        Ok(Ok(Ok(output))) => output,
        Ok(Ok(Err(error))) => {
            return GitPushResult {
                ok: false,
                error: Some(error.to_string()),
            }
        }
        Ok(Err(_)) => {
            return GitPushResult {
                ok: false,
                error: Some("git push 执行失败".to_string()),
            }
        }
        // 超时被杀时 stderr 可能为空,不能只交个空串
        Err(_) => {
            return GitPushResult {
                ok: false,
                error: Some(format!("超时(>{}s)", timeout_ms.div_ceil(1000))),
            }
        }
    };

    if output.status.success() {
        return GitPushResult {
            ok: true,
            error: None,
        };
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let first = stderr.trim().lines().next().unwrap_or("").trim();
    GitPushResult {
        ok: false,
        error: Some(if first.is_empty() {
            "git push 执行失败".to_string()
        } else {
            first.to_string()
        }),
    }
}

/// `git push` 的超时平台封装(供 ops 层直接用默认值)。
pub async fn git_push_default(folder_path: &Path) -> GitPushResult {
    git_push(folder_path, GIT_PUSH_TIMEOUT_MS).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commit_hash_shape_gate() {
        assert!(is_commit_hash("abc1234"));
        assert!(is_commit_hash("0123456789abcdef0123456789abcdef01234567"));
        assert!(!is_commit_hash("abc123"), "6 位不够");
        assert!(!is_commit_hash("-n1"), "选项注入");
        assert!(!is_commit_hash("HEAD~1"));
        assert!(!is_commit_hash(""));
    }

    #[test]
    fn commit_records_split_on_nul_and_unit_separator() {
        let out = "abc123\u{1f}Alice\u{1f}2026-01-01T00:00:00+08:00\u{1f}HEAD -> main\u{1f}subject\u{1f}body line1\u{1f}body line2\n\0\
                   def456\u{1f}Bob\u{1f}2026-01-02T00:00:00+08:00\u{1f}\u{1f}second\u{1f}\0";
        let entries = parse_commit_records(out);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].hash, "abc123");
        assert_eq!(entries[0].author, "Alice");
        assert_eq!(entries[0].refs, "HEAD -> main");
        assert_eq!(entries[0].subject, "subject");
        // 正文里的 0x1f 并回正文,不挪动其它字段
        assert_eq!(entries[0].body, "body line1\u{1f}body line2");
        assert_eq!(entries[1].body, "");
        assert_eq!(entries[1].refs, "");
    }

    #[test]
    fn scratch_pathspecs_cover_every_suffix() {
        let specs = scratch_pathspecs();
        assert_eq!(specs, vec![":(exclude)*.syncx-tmp", ":(exclude)*.syncx-partial"]);
    }

    #[test]
    fn porcelain_entries_classify_by_priority() {
        // deleted 优先于其它所有列
        let text = "D  gone.txt\0?? new.txt\0 R  old.txt\0new-name.txt\0 M staged.txt\0 dir/\0";
        // 直接复刻解析循环,避免依赖真实仓库(on-disk 单测覆盖真实 git)
        let records: Vec<&str> = text.split('\0').filter(|record| !record.is_empty()).collect();
        assert_eq!(records.len(), 6);
        assert_eq!(&records[0][..2], "D ");
        assert_eq!(&records[2][..2], " R");
        assert_eq!(records[3], "new-name.txt");
    }

    #[test]
    fn temp_repo_round_trip() {
        // 建一个真仓库跑通主要路径;没有 git 的环境直接跳过(不算失败)
        let dir = std::env::temp_dir().join(format!(
            "syncx-cli-git-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let mut init = Command::new("git");
        init.args(["init", "-q"]).current_dir(&dir);
        hide_console(&mut init);
        let initialized = init.status().map(|status| status.success()).unwrap_or(false);
        if !initialized {
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }
        for (key, value) in [("user.email", "t@example.com"), ("user.name", "T")] {
            let mut config = Command::new("git");
            config.args(["config", key, value]).current_dir(&dir);
            hide_console(&mut config);
            let _ = config.status();
        }

        assert!(is_git_repo(&dir));
        assert_eq!(get_last_commit_hash(&dir), None, "空仓库没有 HEAD");
        // 空仓库:空列表而不是错误
        assert_eq!(list_recent_commits(&dir, GIT_LOG_LIMIT).unwrap(), Some(Vec::new()));

        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        assert!(has_uncommitted_changes(&dir));
        let (entries, truncated) = get_uncommitted_changes(&dir).unwrap();
        assert!(!truncated);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "a.txt");
        assert_eq!(entries[0].status, "added");

        let committed = auto_commit(&dir, "first");
        assert!(committed.success, "{:?}", committed.error);
        let head = committed.hash.expect("提交后应有哈希");
        assert!(is_commit_hash(&head));

        let log = list_recent_commits(&dir, GIT_LOG_LIMIT).unwrap().unwrap();
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].subject, "first");

        let files = list_commit_files(&dir, &head).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].status, "A");
        assert_eq!(files[0].path, "a.txt");
        assert!(get_commit_parents(&dir, &head).unwrap().is_empty(), "根提交没有父");

        // 未设置上游:计数与列表都回 None(徽标不出现)
        assert_eq!(count_unpushed_commits(&dir), None);
        assert_eq!(list_unpushed_commits(&dir, GIT_UNPUSHED_LIMIT), None);

        // 在途中间态不进版本库
        std::fs::write(dir.join("b.txt.syncx-tmp"), "partial").unwrap();
        assert!(!has_uncommitted_changes(&dir), "syncx 中间态必须被 pathspec 排除");
        std::fs::remove_file(dir.join("b.txt.syncx-tmp")).unwrap();

        let _ = std::fs::remove_dir_all(&dir);
    }
}
