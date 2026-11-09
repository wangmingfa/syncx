///|
/// 核心算法基准:与 Node `test/core.bench.ts`、Rust `benches/core_bench.rs`
/// 同一份确定性合成负载,跑四条热路径(CDC 切块 / 单块 SHA-256 / 全量规划 /
/// 忽略匹配)。跑法:`cd moonbit && moon bench core`。跨后端只比量级与比例,
/// 绝对值受运行时与机器状态影响。
///
/// 数据合成:Lehmer 随机 `state * 48271 % 2147483647`、种子 20261106 ——
/// 乘积 < 2^48,在 JS Number 里同样精确,三端可复现同一序列。
/// 本文件是 `*_bench_test.mbt`,`moon test` 不认,只有 `moon bench` 会跑。

///|
/// Lehmer 随机数下一步。
fn bench_next(state : Int64) -> Int64 {
  (state * 48271L) % 2147483647L
}

///|
/// 造 size 字节合成缓冲:LCG 逐字节,每 13 步插 64 字节平坦段,
/// 让 CDC 既有指纹命中的边界、也有走 CDC_MAX 强制收块的边界。
fn bench_make_bytes(size : Int32) -> Bytes {
  let out : Array[Byte] = []
  let mut state : Int64 = 20261106L
  let mut i : Int32 = 0
  while i < size {
    state = bench_next(state)
    if state % 13L == 0L {
      let fill : Byte = (state % 251L).to_int().to_byte()
      for _ in 0..<64 {
        if i >= size {
          break
        }
        out.push(fill)
        i += 1
      }
    } else {
      out.push((state % 256L).to_int().to_byte())
      i += 1
    }
  }
  Bytes::from_array(out)
}

///|
/// 一条索引条目:blocks 用两个定长假哈希(内容不影响规划开销,长度影响)。
fn bench_entry(path : String, size : Int64, b : Int64) -> @core.IndexEntry {
  let version : @core.VersionVector = Map([])
  version.set("DEV-A", 1L)
  version.set("DEV-B", b)
  {
    path,
    version,
    size,
    deleted: false,
    blocks: [
      "3a985a74119fb1b3eea7e1a5f7d0e2f6e5c8f0d2c1b0a9f8e7d6c5b4a3f2e1d0",
      "b9812a7c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8",
    ],
    cdh: None,
    clens: None,
  }
}

///|
/// 规划负载:2000 条索引。4% 对端缺失(send),10% 对端更新(receive),
/// 其余双方一致(无动作)—— 三类路径都走到。
fn bench_plan_maps() -> (Map[String, @core.IndexEntry], Map[String, @core.IndexEntry]) {
  let local_side : Map[String, @core.IndexEntry] = Map([])
  let remote : Map[String, @core.IndexEntry] = Map([])
  for i in 0..<2000 {
    let path = "dir\{i % 37}/file\{i}.bin"
    let size = i.to_int64() * 977L + 1024L
    local_side.set(path, bench_entry(path, size, 1L))
    if i % 25 == 0 {
      continue
    }
    remote.set(path, bench_entry(path, size, if i % 10 == 0 { 2L } else { 1L }))
  }
  (local_side, remote)
}

///|
/// 忽略匹配负载:2000 条路径,命中/未命中/目录/文件混着,与同一份规则集对拍。
fn bench_ignore_paths() -> Array[(String, Bool)] {
  let out : Array[(String, Bool)] = []
  let mut state : Int64 = 20261106L
  for i in 0..<2000 {
    state = bench_next(state)
    let is_dir = state % 4L == 0L
    let path = match state % 7L {
      0 => "node_modules/pkg\{i % 40}/index.js"
      1 => "src/file\{i}.ts"
      2 => "logs/app-\{i % 12}.log"
      3 => "dist/bundle-\{i % 20}.js"
      4 => "docs/guide/chapter\{i % 9}.md"
      5 => "tmp/cache-\{i}.tmp"
      _ => "assets/img-\{i % 33}.png"
    }
    out.push((path, is_dir))
  }
  out
}

///|
test "bench cdc-4mib" (it : @bench.T) {
  let data = bench_make_bytes(4 * 1024 * 1024)
  it.bench(fn() {
    let ranges = @core.chunk_ranges(data)
    it.keep(ranges.length())
  })
}

///|
test "bench sha256-64k" (it : @bench.T) {
  let block = bench_make_bytes(64 * 1024)
  it.bench(fn() {
    let digest = @core.hash_block(block)
    it.keep(digest)
  })
}

///|
test "bench plan-2000" (it : @bench.T) {
  let (local_side, remote) = bench_plan_maps()
  it.bench(fn() {
    let actions = @core.build_plan(local_side, remote)
    it.keep(actions.length())
  })
}

///|
test "bench ignore-2k" (it : @bench.T) {
  let rules = @core.IgnoreRuleset::from_lines([
    "node_modules/", ".git", ".syncx-trash", "*.log", "!keep.log", "dist/",
    "build/", "*.tmp", "temp/", "coverage/", "*.pid", "*.seed", ".DS_Store",
    "logs/", ".idea/", ".vscode/", "*.bak", "cache/", "uploads/", "*.min.js",
  ])
  let paths = bench_ignore_paths()
  it.bench(fn() {
    let mut hit = 0
    for pair in paths {
      if rules.is_ignored(pair.0, pair.1) {
        hit += 1
      }
    }
    it.keep(hit)
  })
}
