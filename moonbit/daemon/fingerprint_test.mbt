///|
/// 索引指纹测试。黄金值由 Node 参考实现(src/index-fingerprint.ts)实跑产出,
/// 保证三端逐字节一致 —— 字段顺序、版本向量排序、mtime 排除任何一处跑偏,
/// 指纹永远对不上,「跳过全量互换」的优化静默失效。

///|
fn fp_entry_a(mtime : Int64) -> @daemon.Entry {
  {
    path: "docs/报告.md",
    version: Map([("dev-b", 7L), ("dev-a", 3L)]), // 乱序插入:必须按 key 排序后序列化
    size: 12345L,
    deleted: false,
    blocks: ["aa", "bb", "cc"],
    cdh: Some(["h1", "h2"]),
    clens: Some([1048576L, 186000L]),
    mtime: Some(mtime),
    placeholder: false,
  }
}

///|
fn fp_entry_b() -> @daemon.Entry {
  {
    path: "a.txt",
    version: Map([("dev-a", 1L)]),
    size: 0L,
    deleted: false,
    blocks: [],
    cdh: None,
    clens: None,
    mtime: None,
    placeholder: false,
  }
}

///|
test "fingerprint: 与 Node 参考实现的黄金值一致" {
  // Node: indexFingerprint([entryA, entryB])
  let got = @daemon.index_fingerprint([fp_entry_a(1762000000000L), fp_entry_b()])
  assert_eq(
    got, "f9d0236f0c1da721ca0221d9562c305ee2a698b138c827de6683f576d1e5e03b",
  )
  // Node: indexFingerprint([]) = sha256("[]")
  let empty = @daemon.index_fingerprint([])
  assert_eq(
    empty, "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
  )
}

///|
test "fingerprint: 占位条目被排除(与上线过滤同口径)" {
  let placeholder : @daemon.Entry = {
    path: "a.txt",
    version: Map([("dev-a", 1L)]),
    size: 0L,
    deleted: false,
    blocks: [],
    cdh: None,
    clens: None,
    mtime: None,
    placeholder: true,
  }
  let got = @daemon.index_fingerprint([placeholder])
  // Node: indexFingerprint([{ ...b, placeholder: true }]) 与空集合同值
  assert_eq(
    got, "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
  )
}

///|
test "fingerprint: 条目顺序无关、mtime 不参与" {
  // 顺序颠倒,指纹不变
  let ab = @daemon.index_fingerprint([fp_entry_a(1762000000000L), fp_entry_b()])
  let ba = @daemon.index_fingerprint([fp_entry_b(), fp_entry_a(1762000000000L)])
  assert_eq(ab, ba)
  // 只改 mtime,指纹不变(「本机落盘时刻」不进指纹)
  let with_shifted = @daemon.index_fingerprint([fp_entry_a(999L), fp_entry_b()])
  assert_eq(with_shifted, ab)
}

///|

///|
/// fp_entry_a 的字段变体(size / deleted / blocks 任一不同)。
fn fp_entry_a_variant(
  size~ : Int64 = 12345L,
  deleted~ : Bool = false,
  blocks~ : Array[String] = ["aa", "bb", "cc"],
) -> @daemon.Entry {
  {
    path: "docs/报告.md",
    version: Map([("dev-b", 7L), ("dev-a", 3L)]),
    size,
    deleted,
    blocks,
    cdh: Some(["h1", "h2"]),
    clens: Some([1048576L, 186000L]),
    mtime: Some(1762000000000L),
    placeholder: false,
  }
}

///|
test "fingerprint: 内容不同则指纹不同" {
  let a = @daemon.index_fingerprint([fp_entry_a_variant()])
  let b = @daemon.index_fingerprint([fp_entry_a_variant(size=12346L)])
  assert_true(a != b)
  // 删除状态、块哈希同样参与
  let deleted = @daemon.index_fingerprint([fp_entry_a_variant(deleted=true)])
  assert_true(a != deleted)
  let blocks = @daemon.index_fingerprint([
    fp_entry_a_variant(blocks=["aa", "bb", "cd"]),
  ])
  assert_true(a != blocks)
}

///|
test "fingerprint: is_unchanged 快速路径判据" {
  let e = fp_entry_a(1762000000000L)
  // mtime 完全一致 → 未改动(免哈希)
  assert_true(e.is_unchanged(12345L, 1762000000000L))
  // 容忍窗口内的 mtime 抖动 → 不再免检,交给内容哈希确认
  // (2026-11-09 修复:窗口免检曾把写入竞态的真实改动永久吞掉)
  assert_true(!e.is_unchanged(12345L, 1762000000000L - 1999L))
  assert_true(!e.is_unchanged(12345L, 1762000000000L + 2000L))
  // 超出容忍窗口 → 可能已改
  assert_true(!e.is_unchanged(12345L, 1762000000000L + 2001L))
  // 尺寸不同 → 一定变了
  assert_true(!e.is_unchanged(12344L, 1762000000000L))
  // 没有 mtime 就没有免哈希依据
  let no_mtime : @daemon.Entry = {
    path: e.path,
    version: e.version,
    size: e.size,
    deleted: e.deleted,
    blocks: e.blocks,
    cdh: e.cdh,
    clens: e.clens,
    mtime: None,
    placeholder: false,
  }
  assert_true(!no_mtime.is_unchanged(12345L, 1762000000000L))
}
