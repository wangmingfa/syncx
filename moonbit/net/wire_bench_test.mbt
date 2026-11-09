///|
/// 线上编解码基准:与 Node `test/core.bench.ts`、Rust `benches/wire_bench.rs`
/// 同一份确定性负载(2000 条索引,Lehmer 造路径),量「全量索引交换」这条
/// 每次连接必付的 CPU 成本。跑法:`cd moonbit && moon bench net`。
/// 本文件是 `*_bench_test.mbt`,`moon test` 不认,只有 `moon bench` 会跑。

///|
/// 造 2000 条线上条目:字段形态与 plan 基准同一套(两个假哈希块 + 双设备版本向量),
/// mtime 带小数毫秒 —— 这是线上形态(NTFS/ext4/APFS 的 stat 都给分数)。
fn bench_wire_entries() -> Array[@net.WireEntry] {
  let out : Array[@net.WireEntry] = []
  for i in 0..<2000 {
    out.push({
      path: "dir\{i % 37}/file\{i}.bin",
      version: [
        ("DEV-A", 1L),
        ("DEV-B", if i % 10 == 0 { 2L } else { 1L }),
      ],
      size: i.to_int64() * 977L + 1024L,
      deleted: false,
      blocks: [
        "3a985a74119fb1b3eea7e1a5f7d0e2f6e5c8f0d2c1b0a9f8e7d6c5b4a3f2e1d0",
        "b9812a7c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8",
      ],
      mtime: 1750000000123.456,
      cdh: None,
      clens: None,
    })
  }
  out
}

///|
test "bench wire-encode-2000" (it : @bench.T) {
  let entries = bench_wire_entries()
  it.bench(fn() {
    let payload = @net.encode_index(entries)
    it.keep(payload.length())
  })
}

///|
test "bench wire-decode-2000" (it : @bench.T) {
  let payload = @net.encode_index(bench_wire_entries())
  it.bench(fn() {
    let entries = try {
      @net.decode_index(payload)
    } catch {
      _ => []
    }
    it.keep(entries.length())
  })
}
