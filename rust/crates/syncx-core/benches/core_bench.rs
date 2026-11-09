//! 核心算法基准:与 Node `test/core.bench.ts`、MoonBit `core/core_bench_test.mbt`
//! 同一份确定性合成负载,跑四条热路径(CDC 切块 / 单块 SHA-256 / 全量规划 /
//! 忽略匹配)。跑法:`cd rust && cargo bench -p syncx-core`。跨后端只比量级与比例,
//! 绝对值受机器状态影响。
//!
//! 数据合成:Lehmer 随机 `state * 48271 % 2147483647`、种子 20261106 ——
//! 乘积 < 2^48,在 JS Number 里同样精确,三端可复现同一序列。
//!
//! 手工计时(预热 3 轮 + 计时 20 轪),不引 criterion:cargo bench 是
//! `cargo test --benches` 的别名,挂 harness = false 后这里就是一个普通
//! 二进制,输出即结果。

use std::collections::BTreeMap;
use std::time::Instant;

use syncx_core::blockstore::{chunk_ranges, hash_block};
use syncx_core::ignore::IgnoreRuleset;
use syncx_core::plan::{build_plan, IndexEntry};
use syncx_core::VersionVector;

/// Lehmer 随机数。
struct Lehmer(u64);

impl Lehmer {
    fn next(&mut self) -> u64 {
        self.0 = self.0 * 48271 % 2147483647;
        self.0
    }
}

/// 造 size 字节合成缓冲:LCG 逐字节,每 13 步插 64 字节平坦段,
/// 让 CDC 既有指纹命中的边界、也有走 CDC_MAX 强制收块的边界。
fn make_bytes(size: usize) -> Vec<u8> {
    let mut rng = Lehmer(20261106);
    let mut out = Vec::with_capacity(size);
    while out.len() < size {
        let s = rng.next();
        if s % 13 == 0 {
            let fill = (s % 251) as u8;
            for _ in 0..64 {
                if out.len() >= size {
                    break;
                }
                out.push(fill);
            }
        } else {
            out.push((s % 256) as u8);
        }
    }
    out
}

/// 一条索引条目:blocks 用两个定长假哈希(内容不影响规划开销,长度影响)。
fn entry(path: &str, size: u64, b: u64) -> IndexEntry {
    let mut version: VersionVector = BTreeMap::new();
    version.insert("DEV-A".to_string(), 1);
    version.insert("DEV-B".to_string(), b);
    IndexEntry {
        path: path.to_string(),
        version,
        size,
        deleted: false,
        blocks: vec![
            "3a985a74119fb1b3eea7e1a5f7d0e2f6e5c8f0d2c1b0a9f8e7d6c5b4a3f2e1d0"
                .to_string(),
            "b9812a7c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8"
                .to_string(),
        ],
        cdh: None,
        clens: None,
    }
}

/// 规划负载:2000 条索引。4% 对端缺失(send),10% 对端更新(receive),
/// 其余双方一致(无动作)—— 三类路径都走到。
fn plan_maps() -> (BTreeMap<String, IndexEntry>, BTreeMap<String, IndexEntry>) {
    let mut local = BTreeMap::new();
    let mut remote = BTreeMap::new();
    for i in 0..2000u32 {
        let path = format!("dir{}/file{}.bin", i % 37, i);
        let size = i as u64 * 977 + 1024;
        local.insert(path.clone(), entry(&path, size, 1));
        if i % 25 == 0 {
            continue;
        }
        let b = if i % 10 == 0 { 2 } else { 1 };
        remote.insert(path.clone(), entry(&path, size, b));
    }
    (local, remote)
}

/// 忽略匹配负载:2000 条路径,命中/未命中/目录/文件混着,与同一份规则集对拍。
fn ignore_paths() -> Vec<(String, bool)> {
    let mut rng = Lehmer(20261106);
    let mut out = Vec::with_capacity(2000);
    for i in 0..2000u32 {
        let s = rng.next();
        let is_dir = s % 4 == 0;
        let path = match s % 7 {
            0 => format!("node_modules/pkg{}/index.js", i % 40),
            1 => format!("src/file{}.ts", i),
            2 => format!("logs/app-{}.log", i % 12),
            3 => format!("dist/bundle-{}.js", i % 20),
            4 => format!("docs/guide/chapter{}.md", i % 9),
            5 => format!("tmp/cache-{}.tmp", i),
            _ => format!("assets/img-{}.png", i % 33),
        };
        out.push((path, is_dir));
    }
    out
}

/// 预热 3 轪 + 计时 20 轪,回值累进防优化。
fn bench(name: &str, mut f: impl FnMut() -> usize) {
    for _ in 0..3 {
        f();
    }
    const RUNS: u32 = 20;
    let mut sink = 0usize;
    let start = Instant::now();
    for _ in 0..RUNS {
        sink = sink.wrapping_add(f());
    }
    let per_us = start.elapsed().as_secs_f64() * 1e6 / RUNS as f64;
    println!("{:<14} {:>12.3} µs/op  (sink 0x{sink:x})", name, per_us);
}

fn main() {
    let data = make_bytes(4 * 1024 * 1024);
    bench("cdc-4mib", || chunk_ranges(&data).len());

    let block = make_bytes(64 * 1024);
    bench("sha256-64k", || hash_block(&block).len());

    let (local, remote) = plan_maps();
    bench("plan-2000", || build_plan(&local, &remote).len());

    let lines: Vec<String> = [
        "node_modules/", ".git", ".syncx-trash", "*.log", "!keep.log", "dist/",
        "build/", "*.tmp", "temp/", "coverage/", "*.pid", "*.seed", ".DS_Store",
        "logs/", ".idea/", ".vscode/", "*.bak", "cache/", "uploads/", "*.min.js",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let rules = IgnoreRuleset::from_lines(&lines);
    let paths = ignore_paths();
    bench("ignore-2k", || {
        paths
            .iter()
            .filter(|(p, d)| rules.is_ignored(p, *d))
            .count()
    });
}
