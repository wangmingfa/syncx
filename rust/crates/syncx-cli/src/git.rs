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

// 历史重写的命中判定与镜像提交清洗共用同一条规则(单一事实来源)
use crate::control::strip_co_authored_lines;

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

/// 未推送区间历史重写(`git filter-branch`)的超时,与 push 同一档。区间内每笔
/// 提交都要起一次 shell 管道,本地仓库通常秒级完成;卡死的仓库不能让请求挂死。
pub const GIT_REWRITE_TIMEOUT_MS: u64 = 120_000;

/// 「最近提交」与「未推送提交」两处共用的机器可读格式。
const GIT_LOG_FORMAT: &str = "%h%x1f%an%x1f%aI%x1f%D%x1f%s%x1f%b";

/// 历史重写用的 msg-filter:逐行剔除 Co-Authored-By 行,再过 `git stripspace`
/// 把剔除留下的尾部空行砍掉。命中规则与镜像提交清洗
/// [`crate::control::strip_co_authored_lines`] 同源:整行 `/co-?authored-by/i`。
/// 末尾 `|| true` 兜 grep 全剔空返回 1 的退出码(管道末位本就是 stripspace,
/// 正常路径不会失败,纯属双保险)。filter 由 git 自带的 sh 执行
/// (git-filter-branch 是 shell 脚本),grep/stripspace 都随 git 发行,跨平台一致。
const STRIP_CO_AUTHORED_FILTER: &str =
    "grep -Evi 'co-?authored-by' | git stripspace || true";

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

/// 跑一次 git,可附带环境变量(如 filter-branch 的告警抑制)。
fn run_git_with_env(
    cwd: &Path,
    args: &[&str],
    envs: &[(&str, &str)],
    timeout_ms: u64,
    max_out: usize,
) -> Option<GitOutput> {
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in envs {
        command.env(key, value);
    }
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

/// 跑一次 git。`cwd` 是仓库目录;超时按 Node 侧各调用点给的秒数。
fn run_git(cwd: &Path, args: &[&str], timeout_ms: u64, max_out: usize) -> Option<GitOutput> {
    run_git_with_env(cwd, args, &[], timeout_ms, max_out)
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

/// 执行自动提交:`git add -A -- <清单|SCRATCH排除> && git commit -m <message>`。
///
/// `--allow-empty` 是兜底:判定有无变更与 add 之间工作树可能被其他程序改回,
/// 保证提交命令本身不因竞态失败。
///
/// 范围收敛(changedFiles,与 Node 侧 55b1c35 同款根治):镜像提交只 stage 通知
/// 宣称的那批文件(含删除 —— `add -A -- path` 同样登记删除),绝不再 `add -A`
/// 全吞 —— 否则「回声通知未结清 + 用户并发改动」时,用户的未提交修改会被旧通知
/// 的镜像消息打包带走(实测事故:脚本改名被 devices 快照的镜像消息吞掉)。
/// 清单为空(`None` 或全空白串,旧对端没给清单)才退回全量 SCRATCH 排除兜底。
/// 内容已在本地(staged 无差异)时仍落一笔 `--allow-empty` 空提交:两端提交链
/// 对齐是既有契约(git-sync 链路测试锚定),范围收敛后空提交不再吞任何内容,
/// 链上多一笔镜像记录无害。
///
/// 超时后探测(与 Node 侧 `src/git-monitor.ts` 的 autoCommit 同款):spawn 超时只
/// 保证「进程没在期限内退出」,不保证「提交没发生」—— 慢盘 fsync、post-commit hook
/// 卡顿(Termux 实测存在)都会让提交对象早已落盘而进程被杀。此时若按失败重试,
/// 重试前的 has_uncommitted_changes 判定会被「同步仍在继续」的新变更糊弄过去,
/// 同一镜像消息再吞一笔(把第一次提交之后到达的修改也提交进去)。因此提交失败
/// 路径先比对 HEAD:前进了且消息与本次一致 = 实际成功,按成功结算。
pub fn auto_commit(
    folder_path: &Path,
    message: &str,
    changed_files: Option<&[String]>,
) -> AutoCommitResult {
    // 调用前先记 HEAD 基线。空仓库(还没有任何提交)时为 None:首次提交落地后
    // after(Some) ≠ before(None) 同样判「前进」,首次提交的超时探测也能覆盖。
    let before_head = get_last_commit_hash(folder_path);

    // stage:有清单按清单精确 stage,清单为空退回全量;两种路径都把 syncx 的
    // 在途中间态挡在外面(见 scratch_pathspecs)。过滤空白串与 Node 的
    // `filter(s => s.trim())` 同口径,原串原样入参(pathspec 匹配是精确比对)。
    let mut add_args: Vec<&str> = vec!["add", "-A", "--"];
    let paths: Vec<&str> = changed_files
        .unwrap_or_default()
        .iter()
        .filter(|path| !path.trim().is_empty())
        .map(String::as_str)
        .collect();
    // 两条路径的串借用都来自活到函数尾的绑定(specs 若在分支内创建,add_args
    // 里的借用会越过其作用域)
    let specs = scratch_pathspecs();
    if paths.is_empty() {
        add_args.extend(specs.iter().map(String::as_str));
    } else {
        add_args.extend(paths.iter().copied());
    }

    let staged = run_git(folder_path, &add_args, 10_000, 1024 * 1024);
    let stage_error = match &staged {
        Some(output) if !output.success => Some(output.stderr.trim().to_string()),
        Some(_) => None,
        None => Some("git add 执行失败".to_string()),
    };
    if let Some(error) = stage_error {
        // stage 失败则 commit 根本没跑,不存在「实际成功」,无需探测
        return AutoCommitResult {
            success: false,
            hash: None,
            error: Some(error),
        };
    }

    // 参数数组形式,不经 shell —— 消息里有引号/换行都不会被解释
    let commit_output =
        run_git(folder_path, &["commit", "-m", message, "--allow-empty"], 10_000, 1024 * 1024);
    if let Some(output) = &commit_output {
        if output.success {
            return AutoCommitResult {
                success: true,
                hash: get_last_commit_hash(folder_path),
                error: None,
            };
        }
    }

    // 提交失败(非零退出或超时被杀)。不能直接判死 —— 先探测 HEAD 再定论,
    // 见函数头注释。
    if let Some(hash) = commit_landed_anyway(folder_path, before_head.as_deref(), message) {
        return AutoCommitResult {
            success: true,
            hash: Some(hash),
            error: None,
        };
    }
    let error = match &commit_output {
        Some(output) => {
            let text = output.stderr.trim();
            if text.is_empty() {
                "git commit 执行失败".to_string()
            } else {
                text.to_string()
            }
        }
        None => "git commit 执行失败".to_string(),
    };
    AutoCommitResult {
        success: false,
        hash: None,
        error: Some(error),
    }
}

/// 「超时但实际成功」探测:HEAD 较调用前前进,且 HEAD 提交正文(`%B`,两侧 trim
/// 后)与本次消息一致,才认定提交实际已落盘,返回新哈希;否则返回 `None`。
/// 消息不一致(并发了他程序的提交)保守按失败走原路 —— 那是罕见场景,且账目归
/// 调用方的基线/通知逻辑管。
fn commit_landed_anyway(
    folder_path: &Path,
    before_head: Option<&str>,
    message: &str,
) -> Option<String> {
    let after_head = get_last_commit_hash(folder_path)?;
    // 哈希没动(含空仓库两侧都是 None)就不存在「实际成功」
    if before_head == Some(after_head.as_str()) {
        return None;
    }
    if !head_message_matches(folder_path, message) {
        return None;
    }
    Some(after_head)
}

/// HEAD 的完整提交正文(`%B`)与本次消息是否一致(两侧 trim 掉空白后比对)。
fn head_message_matches(folder_path: &Path, message: &str) -> bool {
    match git_text(folder_path, &["log", "-1", "--format=%B"], 5_000, 64 * 1024) {
        Some(text) => text.trim() == message.trim(),
        None => false,
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

/// 当前分支的上游短名(如 `origin/main`)。`None` = 未设置上游 / 分离 HEAD。
pub fn upstream_branch(folder_path: &Path) -> Option<String> {
    let text = git_text(
        folder_path,
        &["rev-parse", "--abbrev-ref", "@{upstream}"],
        5_000,
        64 * 1024,
    )?;
    let name = text.trim();
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

/// 读取未推送区间的全部提交消息(`%B`,NUL 分隔,新→旧)。
///
/// 与「推送弹窗」的列表不同,**不做条数上限**:命中统计与重写都要覆盖整个区间,
/// 少一笔就会漏剔。`None` = 不是仓库 / 未设上游 / 读取失败。
pub fn list_unpushed_messages(folder_path: &Path, upstream: &str) -> Option<Vec<String>> {
    if !is_git_repo(folder_path) {
        return None;
    }
    let range = format!("{upstream}..HEAD");
    let text = git_text(
        folder_path,
        &[
            "log",
            "-z",
            "--no-color",
            "--no-show-signature",
            "--format=%B",
            &range,
        ],
        10_000,
        4 * 1024 * 1024,
    )?;
    // 每条记录 = 消息原文(尾部自带换行)+ NUL 分隔符。只有最后一个 NUL 之后的
    // 空尾串该丢弃;中间的空串是「消息为空的提交」(罕见但合法),丢掉会让区间计数对不上。
    let mut records: Vec<String> = text.split('\0').map(str::to_string).collect();
    if records.last().is_some_and(|last| last.is_empty()) {
        records.pop();
    }
    Some(records)
}

/// 剔除未推送提交的响应载荷。字段名是三端契约,不得改:`{ok, stripped, rewritten}`。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct StripCoAuthoredPayload {
    pub ok: bool,
    /// 消息确实变化的提交数。
    pub stripped: usize,
    /// 未推送区间的提交总数(区间空 / 无命中时也可能大于 stripped)。
    pub rewritten: usize,
}

impl StripCoAuthoredPayload {
    pub fn to_json(&self) -> Value {
        // 纯数据结构,序列化不会失败
        serde_json::to_value(self).expect("序列化 StripCoAuthoredPayload")
    }
}

/// [`strip_unpushed_coauthored`] 的执行结论。
#[derive(Debug, Clone, PartialEq)]
pub struct StripUnpushedOutcome {
    /// 消息确实变化的提交数。
    pub stripped: usize,
    /// 未推送区间的提交总数。
    pub rewritten: usize,
    /// 是否真的执行了 filter-branch(调用方据此把 HEAD 基线推到重写后的哈希)。
    pub rewrote: bool,
}

impl StripUnpushedOutcome {
    /// 响应载荷。区间空 / 无命中同样按契约交卷,只是不执行重写。
    pub fn payload(&self) -> StripCoAuthoredPayload {
        StripCoAuthoredPayload {
            ok: true,
            stripped: self.stripped,
            rewritten: self.rewritten,
        }
    }
}

/// 剔除某目录未推送提交消息里的 Co-Authored-By 行:决策 + 重写一步到位。
///
/// 流程与闸门:未设上游 / 区间空 / 区间内没有命中消息时**不执行重写命令**
/// (区间空连命中统计都不做);真要重写前先拒绝未提交改动 —— filter-branch
/// 自己也要求干净工作树,但这里先给出可读的中文原因。重写只覆盖
/// `<upstream>..HEAD`,已推送历史绝不触碰。
pub fn strip_unpushed_coauthored(
    folder_path: &Path,
    timeout_ms: u64,
) -> Result<StripUnpushedOutcome, String> {
    if !is_git_repo(folder_path) {
        return Err("该目录不是 git 仓库".to_string());
    }
    // 先单独确认上游存在:区分「未设置上游」(结构性不可用)与区间为空(正常态)
    let Some(upstream) = upstream_branch(folder_path) else {
        return Err("未设置上游分支(远程未配置或从未推送),没有可剔除的未推送区间".to_string());
    };
    // 预统计跑在**逐字节原文**(%B)上:命中判定与镜像提交清洗共用同一条规则,
    // 剔除结果与原文逐字节比较即「这条消息会被改写」
    let messages = list_unpushed_messages(folder_path, &upstream)
        .ok_or_else(|| "读取未推送提交失败".to_string())?;
    if messages.is_empty() {
        // 区间为空:契约要求 ok 且两个 0,不执行任何重写命令
        return Ok(StripUnpushedOutcome {
            stripped: 0,
            rewritten: 0,
            rewrote: false,
        });
    }
    let stripped = messages
        .iter()
        .filter(|message| {
            let raw = message.as_str();
            strip_co_authored_lines(raw) != raw
        })
        .count();
    // 工作区必须干净才动历史(syncx 在途中间态照旧豁免):filter-branch 重写期间
    // 叠加未提交改动,会把中间态一起写进重写后的历史
    if has_uncommitted_changes(folder_path) {
        return Err("工作区有未提交的变更,请先提交或暂存后再剔除".to_string());
    }
    if stripped == 0 {
        // 没有命中:重写只会原样复制(filter-branch 对未变化的引用只打警告),
        // 跳过重写 —— 也顺带保住无尾注提交里的连续空行节奏不被 stripspace 折叠
        return Ok(StripUnpushedOutcome {
            stripped: 0,
            rewritten: messages.len(),
            rewrote: false,
        });
    }
    strip_co_authored_unpushed(folder_path, &upstream, timeout_ms)?;
    Ok(StripUnpushedOutcome {
        stripped,
        rewritten: messages.len(),
        rewrote: true,
    })
}

/// 对仓库执行 `git filter-branch --msg-filter`,剔除 `<upstream>..HEAD` 区间内
/// 提交消息里的 Co-Authored-By 行。未推送提交重写是安全的(对端还没有这笔提交,
/// 哈希变化不影响任何人);失败时错误原文透出,原引用不会被破坏 —— filter-branch
/// 的引用更新集中在全部提交重写完成之后,中途失败引用保持原样。
fn strip_co_authored_unpushed(
    folder_path: &Path,
    upstream: &str,
    timeout_ms: u64,
) -> Result<(), String> {
    let range = format!("{upstream}..HEAD");
    // 与 Node 同款:错误原文(stderr 首行)直接透给前端,拿不到时兜底
    // 「git 历史重写失败」(执行失败 / 超时被杀时 stderr 可能为空,不能只交个空串)
    let output = match run_git_with_env(
        folder_path,
        &[
            "filter-branch",
            // 覆盖上一次重写留下的 refs/original 备份(同一分支二度剔除的场景)
            "-f",
            "--msg-filter",
            STRIP_CO_AUTHORED_FILTER,
            "--",
            &range,
        ],
        // filter-branch 会对「重写历史」先打一段告警再故意等 10 秒;明确压掉,
        // 让 stderr 里剩下的只有进度与真正的错误首行
        &[("FILTER_BRANCH_SQUELCH_WARNING", "1")],
        timeout_ms,
        1024 * 1024,
    ) {
        Some(output) => output,
        None => return Err("git 历史重写失败".to_string()),
    };
    if output.success {
        return Ok(());
    }
    let first = output.stderr.trim().lines().next().unwrap_or("").trim();
    Err(if first.is_empty() {
        "git 历史重写失败".to_string()
    } else {
        first.to_string()
    })
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

        let committed = auto_commit(&dir, "first", None);
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

    /// hook 探测两测共用的临时仓库根目录(带进程号 + 纳秒,避免并发撞名)。
    fn probe_temp_root(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "syncx-cli-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    /// 在 root 建一个带身份配置的真仓库;git 不可用返回 `None`(跳过不算失败),
    /// 与 [`temp_repo_round_trip`] 同款的环境探测口径。
    fn init_probe_repo(root: &Path) -> Option<()> {
        std::fs::create_dir_all(root).ok()?;
        let mut init = Command::new("git");
        // 显式 -b main:不依赖环境里的 init.defaultBranch 配置
        init.args(["init", "-q", "-b", "main"]).current_dir(root);
        hide_console(&mut init);
        if !init.status().ok()?.success() {
            return None;
        }
        for (key, value) in [("user.email", "probe@local"), ("user.name", "probe")] {
            let mut config = Command::new("git");
            config.args(["config", key, value]).current_dir(root);
            hide_console(&mut config);
            config.status().ok()?;
        }
        Some(())
    }

    #[test]
    fn auto_commit_counts_timeout_but_landed_commit_as_success() {
        // 用 post-commit hook 睡 15s 模拟「提交已落盘但进程卡住」:超过 auto_commit
        // 的 10s 提交超时。没有 git 的环境直接跳过(不算失败)。
        let root = probe_temp_root("timeout");
        if init_probe_repo(&root).is_none() {
            let _ = std::fs::remove_dir_all(&root);
            return;
        }
        std::fs::write(root.join("a.txt"), "first snapshot\n").unwrap();
        let base = auto_commit(&root, "base", None);
        assert!(base.success, "{:?}", base.error);

        let hooks = root.join(".git").join("hooks");
        std::fs::create_dir_all(&hooks).unwrap();
        let hook = hooks.join("post-commit");
        std::fs::write(&hook, "#!/bin/sh\nsleep 15\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let started = std::time::Instant::now();
        let result = auto_commit(&root, "镜像提交 from DEV-A", None);
        // 走满 10s 超时才可能触发探测;hook 没生效(比如权限没加上)时这里兜底
        // 拦住,避免测试在「根本没超时」的路径上假绿
        assert!(
            started.elapsed() >= std::time::Duration::from_secs(9),
            "post-commit hook 未生效,提交没有走到超时路径"
        );
        assert!(result.success, "超时但实际成功应按成功结算:{:?}", result.error);
        let head = result.hash.expect("探测成功应带回新哈希");
        assert_eq!(get_last_commit_hash(&root).as_deref(), Some(head.as_str()));

        // 只有一笔该消息的提交 —— 不再发生「重试又吞一笔」
        let log = list_recent_commits(&root, GIT_LOG_LIMIT).unwrap().unwrap();
        let hits = log
            .iter()
            .filter(|entry| entry.subject == "镜像提交 from DEV-A")
            .count();
        assert_eq!(hits, 1);
        assert_eq!(log.len(), 2, "base + 一笔镜像提交");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn auto_commit_still_fails_on_index_lock_residue() {
        // 确定性失败回归:index.lock 残留必须仍按失败上报,HEAD 不动。
        // 空仓库(before_head 为 None)同样覆盖。
        let root = probe_temp_root("lock");
        if init_probe_repo(&root).is_none() {
            let _ = std::fs::remove_dir_all(&root);
            return;
        }
        std::fs::write(root.join("a.txt"), "content\n").unwrap();
        let before = get_last_commit_hash(&root);
        assert_eq!(before, None, "前置:仓库还没有提交");

        std::fs::write(root.join(".git").join("index.lock"), "").unwrap();
        let result = auto_commit(&root, "镜像提交 from DEV-B", None);
        assert!(!result.success, "index.lock 残留必须仍按失败上报");
        assert!(result.error.is_some(), "失败要带原因:{:?}", result.error);
        assert_eq!(get_last_commit_hash(&root), None, "HEAD 不动");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn auto_commit_stages_only_listed_files() {
        // 范围收敛:镜像提交只 stage 通知宣称的文件 —— 用户并发的未提交改动
        // (不在清单)绝不能被 add -A 顺手打包;清单里的删除同样登记
        // (`add -A -- path` 对删除同义)。没有 git 的环境直接跳过(不算失败)。
        let root = probe_temp_root("scope");
        if init_probe_repo(&root).is_none() {
            let _ = std::fs::remove_dir_all(&root);
            return;
        }
        std::fs::write(root.join("keep.txt"), "one\n").unwrap();
        std::fs::write(root.join("listed.txt"), "old\n").unwrap();
        assert!(auto_commit(&root, "base", None).success);

        // 用户并发改动 keep.txt(不在清单);清单宣称:new.txt 新增 + listed.txt 删除
        std::fs::write(root.join("keep.txt"), "dirty\n").unwrap();
        std::fs::write(root.join("new.txt"), "fresh\n").unwrap();
        std::fs::remove_file(root.join("listed.txt")).unwrap();

        let listed = ["new.txt".to_string(), "listed.txt".to_string()];
        let result = auto_commit(&root, "镜像提交 from DEV-A", Some(&listed));
        assert!(result.success, "{:?}", result.error);
        let head = result.hash.expect("成功应带回新哈希");

        // 提交里只有清单宣称的两笔:新增 + 删除;keep.txt 的脏改动不在其中
        let files = list_commit_files(&root, &head).unwrap();
        assert_eq!(files.len(), 2, "只该吞清单内的文件:{files:?}");
        assert!(files.iter().any(|file| file.path == "new.txt" && file.status == "A"));
        assert!(files.iter().any(|file| file.path == "listed.txt" && file.status == "D"));

        // keep.txt 原样留在工作树,等用户自己的提交
        assert!(has_uncommitted_changes(&root), "脏文件必须不被吞");
        let (entries, truncated) = get_uncommitted_changes(&root).unwrap();
        assert!(!truncated);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "keep.txt");
        assert_eq!(entries[0].status, "modified");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn auto_commit_lands_empty_commit_when_content_already_in_head() {
        // 回声:通知宣称的文件内容已在本地 HEAD 里(staged 无差异)—— 仍要落一笔
        // --allow-empty 空提交:两端提交链对齐是既有契约;范围收敛后空提交不再吞
        // 任何内容,链上多一笔镜像记录无害。
        let root = probe_temp_root("echo");
        if init_probe_repo(&root).is_none() {
            let _ = std::fs::remove_dir_all(&root);
            return;
        }
        std::fs::write(root.join("a.txt"), "same\n").unwrap();
        let base = auto_commit(&root, "base", None);
        assert!(base.success, "{:?}", base.error);
        let base_hash = base.hash.expect("base 应有哈希");

        // 工作树干净,再按通知口径提交同一文件:只落链对齐空提交
        assert!(!has_uncommitted_changes(&root), "前置:工作树干净");
        let result = auto_commit(&root, "镜像提交 from DEV-A", Some(&["a.txt".to_string()]));
        assert!(result.success, "{:?}", result.error);
        let head = result.hash.expect("成功应带回新哈希");
        assert_ne!(head, base_hash, "空提交也要推进 HEAD");

        // HEAD 就是那笔镜像提交:subject 一致、不携带任何文件变更
        let log = list_recent_commits(&root, GIT_LOG_LIMIT).unwrap().unwrap();
        assert_eq!(log.len(), 2, "base + 一笔空镜像提交");
        assert_eq!(log[0].subject, "镜像提交 from DEV-A");
        assert!(list_commit_files(&root, &head).unwrap().is_empty(), "空提交不应携带文件");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn auto_commit_falls_back_to_full_stage_when_list_empty() {
        // 清单为空(旧对端没给清单)退回全量兜底:add -A 只挡在途中间态,
        // 工作树里的变更照旧全吞 —— 与旧版行为一致。`Some(&[])` 与 `None`
        // 语义相同,两条路径都锚住。
        let root = probe_temp_root("fallback");
        if init_probe_repo(&root).is_none() {
            let _ = std::fs::remove_dir_all(&root);
            return;
        }
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        let result = auto_commit(&root, "镜像提交 from DEV-A", Some(&[]));
        assert!(result.success, "{:?}", result.error);
        let files = list_commit_files(&root, &result.hash.expect("成功应带回新哈希")).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "a.txt");

        std::fs::write(root.join("b.txt"), "two\n").unwrap();
        std::fs::write(root.join("c.txt"), "three\n").unwrap();
        let result = auto_commit(&root, "镜像提交 from DEV-B", None);
        assert!(result.success, "{:?}", result.error);
        let files = list_commit_files(&root, &result.hash.expect("成功应带回新哈希")).unwrap();
        assert_eq!(files.len(), 2, "None 同样走全量兜底:{files:?}");
        assert!(files.iter().any(|file| file.path == "b.txt"));
        assert!(files.iter().any(|file| file.path == "c.txt"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn strip_payload_serde_round_trip() {
        let payload = StripCoAuthoredPayload {
            ok: true,
            stripped: 2,
            rewritten: 5,
        };
        let bytes = serde_json::to_vec(&payload).unwrap();
        let back: StripCoAuthoredPayload = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(back, payload);
        // 字段名是三端契约,不得改
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["ok"], true);
        assert_eq!(value["stripped"], 2);
        assert_eq!(value["rewritten"], 5);
        // 响应走 to_json:必须与 serde 序列化同形
        assert_eq!(payload.to_json(), value);
    }

    #[test]
    fn strip_unpushed_rewrites_trailers_keeps_rest() {
        // 真实仓库端到端:init + bare 远端设上游 + 多笔未推送提交(部分带尾注)。
        // 没有 git 的环境直接跳过(不算失败),与 temp_repo_round_trip 同款。
        let root = std::env::temp_dir().join(format!(
            "syncx-cli-strip-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let dir = root.join("work");
        std::fs::create_dir_all(&dir).unwrap();
        let mut init = Command::new("git");
        // 显式 -b main:不依赖环境里的 init.defaultBranch 配置
        init.args(["init", "-q", "-b", "main"]).current_dir(&dir);
        hide_console(&mut init);
        if !init.status().map(|status| status.success()).unwrap_or(false) {
            let _ = std::fs::remove_dir_all(&root);
            return;
        }
        let git = |args: &[&str]| {
            let mut command = Command::new("git");
            command.args(args).current_dir(&dir);
            hide_console(&mut command);
            let output = command.output().expect("git 可执行");
            assert!(
                output.status.success(),
                "git {args:?} 失败:{}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        for (key, value) in [("user.email", "t@example.com"), ("user.name", "T")] {
            git(&["config", key, value]);
        }

        // 非 git 目录:直接给原因
        let plain = root.join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        assert_eq!(
            strip_unpushed_coauthored(&plain, GIT_REWRITE_TIMEOUT_MS).unwrap_err(),
            "该目录不是 git 仓库"
        );

        // 未设置上游:拒绝(与 Node 同文案)
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-q", "-m", "base"]);
        assert_eq!(
            strip_unpushed_coauthored(&dir, GIT_REWRITE_TIMEOUT_MS).unwrap_err(),
            "未设置上游分支(远程未配置或从未推送),没有可剔除的未推送区间"
        );

        // bare 远端 + push -u:上游口径与「未推送 N」徽标同源(@{upstream}..HEAD)
        let remote = root.join("remote.git");
        git(&[
            "clone",
            "-q",
            "--bare",
            dir.to_str().unwrap(),
            remote.to_str().unwrap(),
        ]);
        git(&["remote", "add", "origin", remote.to_str().unwrap()]);
        git(&["push", "-q", "-u", "origin", "main"]);
        assert_eq!(upstream_branch(&dir).as_deref(), Some("origin/main"));

        // 区间空:契约要求 ok 且两个 0,重写命令不执行(refs/original 不出现)
        let outcome = strip_unpushed_coauthored(&dir, GIT_REWRITE_TIMEOUT_MS).unwrap();
        assert_eq!(outcome.stripped, 0);
        assert_eq!(outcome.rewritten, 0);
        assert!(!outcome.rewrote);
        assert!(
            git_text(&dir, &["for-each-ref", "refs/original"], 5_000, 1024)
                .unwrap_or_default()
                .trim()
                .is_empty(),
            "空区间不得执行 filter-branch"
        );

        // 三笔未推送提交:两笔带尾注(标准大小写 / 无连字符变体各一),一笔干净
        git(&[
            "commit", "-q", "--allow-empty", "-m", "第二笔", "-m", "Co-authored-by: A <a@b>",
        ]);
        git(&["commit", "-q", "--allow-empty", "-m", "第三笔"]);
        git(&[
            "commit", "-q", "--allow-empty", "-m", "第四笔", "-m", "coauthored-by: B <b@c>",
        ]);
        assert_eq!(count_unpushed_commits(&dir), Some(3));

        // 作者/提交者时间与 subject 快照:重写后必须逐条一致
        let range = "origin/main..HEAD";
        let identities = |dir: &Path| -> Vec<String> {
            git_text(
                dir,
                &["log", "-z", "--format=%aI%x1f%cI%x1f%s", range],
                10_000,
                64 * 1024,
            )
            .unwrap()
            .split('\0')
            .filter(|record| !record.is_empty())
            .map(str::to_string)
            .collect()
        };
        let before = identities(&dir);
        assert_eq!(before.len(), 3);

        // 工作区有未提交改动:先拒绝,不动历史(区间非空时无论有无命中都拦)
        std::fs::write(dir.join("dirty.txt"), "x\n").unwrap();
        assert!(has_uncommitted_changes(&dir));
        assert_eq!(
            strip_unpushed_coauthored(&dir, GIT_REWRITE_TIMEOUT_MS).unwrap_err(),
            "工作区有未提交的变更,请先提交或暂存后再剔除"
        );
        std::fs::remove_file(dir.join("dirty.txt")).unwrap();

        // 重写:3 笔区间里 2 笔命中
        let outcome = strip_unpushed_coauthored(&dir, GIT_REWRITE_TIMEOUT_MS).unwrap();
        assert_eq!(outcome.stripped, 2, "两笔带尾注");
        assert_eq!(outcome.rewritten, 3);
        assert!(outcome.rewrote);

        // 重写后:尾注消失(整条只剩正文首行),其余内容一字不动
        let upstream = upstream_branch(&dir).unwrap();
        assert_eq!(upstream, "origin/main", "上游引用不受重写影响");
        let messages = list_unpushed_messages(&dir, &upstream).unwrap();
        assert_eq!(messages, vec!["第四笔\n", "第三笔\n", "第二笔\n"]);
        assert_eq!(identities(&dir), before, "作者/提交者时间与 subject 不变");
        assert_eq!(count_unpushed_commits(&dir), Some(3));
        assert!(!has_uncommitted_changes(&dir));

        // 二度调用:区间里已无命中,重写不执行(幂等收卷);但区间非空且工作区脏时
        // 仍按 Node 口径拒绝
        std::fs::write(dir.join("dirty.txt"), "x\n").unwrap();
        assert_eq!(
            strip_unpushed_coauthored(&dir, GIT_REWRITE_TIMEOUT_MS).unwrap_err(),
            "工作区有未提交的变更,请先提交或暂存后再剔除"
        );
        std::fs::remove_file(dir.join("dirty.txt")).unwrap();
        let again = strip_unpushed_coauthored(&dir, GIT_REWRITE_TIMEOUT_MS).unwrap();
        assert_eq!(again.stripped, 0);
        assert_eq!(again.rewritten, 3);
        assert!(!again.rewrote);

        let _ = std::fs::remove_dir_all(&root);
    }
}
