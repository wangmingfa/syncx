//! 共享目录扫描。对应 Node 侧 `src/scanner.ts`。
//!
//! 这个模块的每一处「绕路」都是事故留下的疤,移植时**不能简化**:
//!
//!  1. **相对路径用字符串拼接,不用平台 API**。同步协议与索引一律 POSIX 分隔符,
//!     而 Windows 上 `Path::join`/`relative` 产出 `\`。一旦把 `\` 路径当成索引 key,
//!     就会出现「索引里有 `utils/x.mbt`、扫描却得到 `utils\x.mbt`」的错配:每个
//!     子目录文件既进 changed(误报修改)又被判为「索引有、盘上无」→ 生成墓碑广播给
//!     对端,把对端整棵子目录删掉(2026-09-15 端 251 个文件被误删的根因;顶层文件
//!     不含分隔符故不受影响,恰好解释了「只删子目录、不删顶层」的形态)。
//!  2. **根目录不存在时不做墓碑推断**。盘符卸载 / 权限丢失 / 未挂载时,整棵索引会
//!     被当成「已删除」,一次扫描就能把对端数据删空。
//!  3. **占位条目永不生成墓碑**。盘上本就没有实体文件,那不是「本地删除」——生成
//!     墓碑会把对端的真文件删进回收站(数据丢失级)。
//!  4. **硬忽略路径绝不生成墓碑**。墓碑会把「对端也有这份内容」变成对端的一次真实
//!     删除,伤疤会传染。
//!  5. **嵌套共享根**内的条目既不重扫也不墓碑,交由那个共享自己管理。

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use syncx_core::blockstore::{hash_block, split_ranges, BLOCK_SIZE};
use syncx_core::ignore::{is_hard_ignored, is_conflict_copy_name, is_scratch_segment, IgnoreRuleset};

use crate::entry::{tombstone_of, StoredEntry};
use crate::indexstore::IndexStore;
use crate::partial::PARTIAL_TTL_MS;

/// 扫描结果。字段语义与 Node 的 `ScanDiff` 一一对应。
#[derive(Debug, Default)]
pub struct ScanDiff {
    /// 新增或内容变化的相对路径(需重新索引并发送)。
    pub changed: Vec<String>,
    /// 本地已删除文件的墓碑条目(需传播)。
    pub tombstones: Vec<StoredEntry>,
    /// 本轮实际看到的文件数(已排除忽略/硬忽略/临时件,不含嵌套共享根内的文件)。
    ///
    /// 供上层做结构性守卫:无法校验目录身份时,「一个文件都没看到、却要删东西」是
    /// 目录未挂载或被换掉的典型形态,此时必须拒绝执行这批删除。
    pub files_seen: usize,
    /// 盘上残留的冲突副本数(硬忽略、不进索引,但目录卡徽标要报数)。
    pub conflict_count: usize,
}

/// 扫描一个共享目录树,与索引对比,产出需要重新索引/发送的路径与墓碑。
///
/// `nested_roots` 是其它共享目录的归一化绝对根:本树中命中其中任一条的子目录视为
/// 「嵌套共享根」,既不递归进去索引、也不为其中文件产生墓碑 —— 否则同一批文件会被
/// 两个共享重复扫描/同步,跳过后又会误把对方已同步的文件墓碑删除。
pub fn scan_folder(
    root: &Path,
    index: &IndexStore,
    rules: &IgnoreRuleset,
    device_id: &str,
    nested_roots: &[PathBuf],
) -> Result<ScanDiff, crate::indexstore::StoreError> {
    // 根目录不存在 / 不是目录:不做任何墓碑推断(见模块注释第 2 条)
    match std::fs::metadata(root) {
        Ok(meta) if meta.is_dir() => {}
        _ => return Ok(ScanDiff::default()),
    }

    let mut changed = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut conflict_count = 0usize;

    // 一次性把索引装进内存:每轮扫描都要对每个已索引文件问一次「改了没」,
    // 逐条查询会把「一次 SQLite 往返」放大到「一次每个文件」。
    let existing: Vec<StoredEntry> = index.list_entries()?;
    let by_path: std::collections::HashMap<&str, &StoredEntry> =
        existing.iter().map(|e| (e.path.as_str(), e)).collect();

    let resolved_nested: Vec<PathBuf> = nested_roots.iter().map(|p| normalize_path(p)).collect();
    let mut ctx = WalkCtx {
        index,
        by_path: &by_path,
        rules,
        nested: &resolved_nested,
        changed: &mut changed,
        seen: &mut seen,
        conflict_count: &mut conflict_count,
    };
    walk(root, "", &mut ctx);

    // 索引中有、本地文件已不存在的非墓碑条目 → 墓碑
    let mut tombstones = Vec::new();
    let root_norm = normalize_path(root);
    for entry in existing {
        if entry.deleted || seen.contains(&entry.path) {
            continue;
        }
        // 占位条目:盘上本就没有实体(见模块注释第 3 条)
        if entry.placeholder {
            continue;
        }
        // 硬忽略路径绝不生成墓碑(第 4 条)
        if is_hard_ignored(&entry.path) {
            continue;
        }
        // 用户级忽略规则命中的条目同样不生成墓碑:本机不再扫描它,也就无从判断它是否
        // 真的被删除;而墓碑会让对端执行真实删除。与 Node 的 `isIgnoredPath(rules, …)`
        // 同一分支(那里也是先判规则、后判嵌套根)。
        if rules.is_ignored(&entry.path, false) {
            continue;
        }
        // 嵌套共享根内的既有条目:本次扫描既不重扫也不墓碑(第 5 条)。
        // 仅当被保护的根是当前扫描根的**后代**时才跳过 —— 若它是当前根的祖先/同级,
        // 该根自己的删除必须由它自己的扫描负责,在这里按前缀命中会吞掉整棵子树的删除。
        let abs_entry = root.join(&entry.path);
        let abs_entry_norm = normalize_path(&abs_entry);
        if resolved_nested.iter().any(|nr| {
            if !nr.starts_with(&root_norm) || *nr == root_norm {
                return false;
            }
            abs_entry_norm == *nr || abs_entry_norm.starts_with(nr)
        }) {
            continue;
        }
        tombstones.push(tombstone_of(&entry, device_id));
    }

    Ok(ScanDiff {
        changed,
        tombstones,
        files_seen: seen.len(),
        conflict_count,
    })
}

/// 一次遍历的可变状态。打包成结构体是因为递归函数需要同时持有只读的索引/规则
/// 与可写的产出,分开传参会有七八个形参,调用点读不出谁是谁。
struct WalkCtx<'a> {
    index: &'a IndexStore,
    by_path: &'a std::collections::HashMap<&'a str, &'a StoredEntry>,
    rules: &'a IgnoreRuleset,
    nested: &'a [PathBuf],
    changed: &'a mut Vec<String>,
    seen: &'a mut HashSet<String>,
    conflict_count: &'a mut usize,
}

/// 相对路径一律由「父级相对目录 + 文件名」以 `/` 拼接(见模块注释第 1 条)。
fn rel_of(rel_dir: &str, name: &str) -> String {
    if rel_dir.is_empty() {
        name.to_string()
    } else {
        format!("{rel_dir}/{name}")
    }
}

pub fn normalize_path(path: &Path) -> PathBuf {
    // 不解析符号链接(与 Node 的 resolve 同语义:只做词法归一),但要去掉 `.`/`..`。
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

fn mtime_ms(meta: &std::fs::Metadata) -> Option<i64> {
    meta.modified().ok().and_then(|t| {
        t.duration_since(std::time::UNIX_EPOCH)
            .ok()
            .map(|d| d.as_millis() as i64)
    })
}

/// 逐块比对盘上内容与索引里的定长块哈希,**首处不符立刻返回**。
///
/// 扫描每轮对每个已索引文件都要问一次「内容变了没」,既不该整读、也不该把后面的
/// 块读完。长度或任一块哈希对不上即 `false`。
pub fn blocks_match_on_disk(abs: &Path, expected: &[String]) -> bool {
    use std::io::Read;

    let Ok(mut file) = std::fs::File::open(abs) else {
        return false;
    };
    let mut window = vec![0u8; BLOCK_SIZE];
    let mut count = 0usize;
    loop {
        let mut filled = 0usize;
        let mut eof = false;
        while filled < BLOCK_SIZE {
            match file.read(&mut window[filled..]) {
                Ok(0) => {
                    eof = true;
                    break;
                }
                Ok(n) => filled += n,
                Err(_) => return false,
            }
        }
        if filled == 0 {
            break; // 盘上比索引短:交给下面的长度判断
        }
        if count >= expected.len() {
            return false; // 盘上比索引长
        }
        if hash_block(&window[..filled]) != expected[count] {
            return false;
        }
        count += 1;
        if eof {
            break;
        }
    }
    count == expected.len()
}

/// 遍历实现:一次 `read_dir` 处理一层,子目录递归。
///
/// 用同步 `std::fs`:扫描本来就在阻塞线程池里跑(见 `store::IndexStoreHandle`),
/// 再套一层 async 目录 API 只会把每次 stat 变成一次调度。
fn walk(dir: &Path, rel_dir: &str, ctx: &mut WalkCtx<'_>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return; // 目录已被删除
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().to_string();
        let rel = rel_of(rel_dir, &name);
        let abs = entry.path();

        if file_type.is_dir() {
            // 嵌套共享根:本目录树(父/外层)不递归进去,其中文件交由那个共享自己同步
            let abs_norm = normalize_path(&abs);
            if ctx.nested.contains(&abs_norm) {
                continue;
            }
            if ctx.rules.is_ignored(&rel, true) {
                continue;
            }
            walk(&abs, &rel, ctx);
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        // 接收中间态(在途 tmp + 位图 sidecar):不参与索引/宣告,顺带回收过期残骸。
        // 非中间态的目录项不付这个 stat —— prune_scratch_file 自己按后缀短路。
        if is_scratch_segment(&name) {
            prune_scratch_file(dir, &name);
            continue;
        }
        // 冲突副本被硬忽略跳过,但先计数供目录卡徽标(它们不参与同步/索引/墓碑)
        if is_conflict_copy_name(&name) {
            *ctx.conflict_count += 1;
        }
        if ctx.rules.is_ignored(&rel, false) {
            continue;
        }

        ctx.seen.insert(rel.clone());
        if is_changed(ctx, &rel, &abs) {
            ctx.changed.push(rel);
        }
    }
}

/// 该文件相对索引是否「已改动」。见模块注释:免哈希快速路径与内容哈希回退的分支顺序
/// 必须与 Node 的 `walk` 完全一致 —— 顺序反了会把「仅 mtime 变化」当成内容变化,
/// 每轮扫描都产生一次无意义的外推。
fn is_changed(ctx: &mut WalkCtx<'_>, rel: &str, abs: &Path) -> bool {
    let Some(prev) = ctx.by_path.get(rel) else {
        return true; // 索引里没有 → 新文件
    };
    if prev.deleted {
        return true; // 墓碑之后又出现了同名文件
    }
    let Ok(meta) = std::fs::metadata(abs) else {
        return false; // 文件在扫描途中被删:本轮跳过,下一轮按墓碑处理
    };
    let size = meta.len();
    let Some(mtime) = mtime_ms(&meta) else {
        return true; // 拿不到时间戳就没有免哈希依据
    };
    // 免哈希快速路径:大小与 mtime 完全一致才视为未改动;容忍窗口内的 mtime
    // 抖动落到下面的内容哈希确认(FAT32 粒度、写入竞态都只付一次哈希)
    if prev.is_unchanged(size, mtime) {
        return false;
    }
    // 大小相同但 mtime 变化(或旧数据无 mtime)才做内容哈希对比
    if size == prev.size && blocks_match_on_disk(abs, &prev.blocks) {
        // 内容未变仅 mtime 变化:写回新 mtime,把 diff 归零 —— 否则容忍窗口内
        // 的抖动会每轮重复整文件哈希。mtime 不在同步协议内,不递增版本、不触发广播。
        if prev.mtime.is_none() || prev.mtime.unwrap_or(0) != mtime {
            let mut updated = (*prev).clone();
            updated.mtime = Some(mtime);
            let _ = ctx.index.save_entry(&updated);
        }
        return false;
    }
    true
}

/// 扫描器遍历到中间态文件时顺手做的回收:超期就删掉**整对**(tmp 与 manifest 同进同出)。
///
/// 判据用 tmp 自己的 mtime:在途接收每落一块 mtime 就更新一次,7 天不动 = 确实没人
/// 续它;而「没有 manifest 的孤儿 tmp」连 `updatedAt` 都没有,却正是最需要回收的那种残骸。
///
/// 删不掉(被别的管线攥着 / 已消失)不报错:留到下一轮扫描再试。
pub fn prune_scratch_file(dir_abs: &Path, name: &str) -> bool {
    let lower = name.to_lowercase();
    let Some(suffix) = syncx_core::ignore::SCRATCH_SUFFIXES
        .iter()
        .find(|s| lower.ends_with(*s))
    else {
        return false;
    };
    let abs = dir_abs.join(name);
    let Ok(meta) = std::fs::metadata(&abs) else {
        return false; // 扫描途中它已经消失
    };
    let Some(mtime) = mtime_ms(&meta) else {
        return false;
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(mtime);
    if now - mtime <= PARTIAL_TTL_MS {
        return false;
    }
    // 去掉后缀得到目标文件本体:tmp 与它的 manifest 一起回收,不留半对
    let target_name = &name[..name.len() - suffix.len()];
    crate::partial::remove_partial(&dir_abs.join(target_name));
    !abs.exists()
}

/// 定长分块的范围表(供扫描侧与执行器共用同一口径)。
pub fn fixed_block_ranges(size: u64) -> Vec<(u64, u64)> {
    split_ranges(size as usize)
        .into_iter()
        .map(|(offset, length)| (offset as u64, length as u64))
        .collect()
}
