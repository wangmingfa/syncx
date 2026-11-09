//! 线上编解码基准:与 Node `test/core.bench.ts`、MoonBit `net/wire_bench_test.mbt`
//! 同一份确定性负载(2000 条索引),量「全量索引交换」这条每次连接必付的 CPU 成本。
//! 跑法:`cd rust && cargo bench -p syncx-net`。手工计时(预热 3 轮 + 计时 20 轮),
//! 与 syncx-core 的 benches/core_bench.rs 同一套驱动,不引 criterion。

use std::time::Instant;

use syncx_net::wire::{decode_index, encode_index, WireEntry};

/// 造 2000 条线上条目:字段形态与 plan 基准同一套(两个假哈希块 + 双设备版本向量),
/// mtime 带小数毫秒 —— 这是线上形态(NTFS/ext4/APFS 的 stat 都给分数)。
fn bench_wire_entries() -> Vec<WireEntry> {
    let mut out = Vec::with_capacity(2000);
    for i in 0..2000u32 {
        out.push(WireEntry {
            path: format!("dir{}/file{}.bin", i % 37, i),
            version: vec![
                ("DEV-A".to_string(), 1u64),
                ("DEV-B".to_string(), if i % 10 == 0 { 2 } else { 1 }),
            ],
            size: i as u64 * 977 + 1024,
            deleted: false,
            blocks: vec![
                "3a985a74119fb1b3eea7e1a5f7d0e2f6e5c8f0d2c1b0a9f8e7d6c5b4a3f2e1d0"
                    .to_string(),
                "b9812a7c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8"
                    .to_string(),
            ],
            mtime: 1750000000123.456,
            cdh: None,
            clens: None,
        });
    }
    out
}

/// 预热 3 轮 + 计时 20 轮,回值累进防优化(与 core_bench.rs 同一套)。
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
    println!("{:<18} {:>12.3} µs/op  (sink 0x{sink:x})", name, per_us);
}

fn main() {
    let entries = bench_wire_entries();
    bench("wire-encode-2000", || encode_index(&entries).len());

    let payload = encode_index(&entries);
    bench("wire-decode-2000", || decode_index(&payload).unwrap().len());
}
