///|
/// CDC 请求与供应的白盒单测:plan_cdc 判定表、供应定位(越界 / 长度闸)、
/// 跨口径重试键见 reliability_wbtest。

///|
/// 造一条 daemon 条目(CDC 视图可选)。
fn cdcwb_entry(
  path : String,
  size : Int64,
  blocks : Array[String],
  cdh~ : Array[String]? = None,
  clens~ : Array[Int64]? = None,
  deleted~ : Bool = false,
  placeholder~ : Bool = false,
) -> Entry {
  {
    path,
    version: Map([("dev-x", 1L)]),
    size,
    deleted,
    blocks,
    cdh,
    clens,
    mtime: None,
    placeholder,
  }
}

///|
/// plan_cdc 判定表:判据全在「本端能不能差集」——双方都有 CDC 视图且本机
/// 条目是活实体才启用;本机墓碑 / 占位 / 无视图、对端无视图一律按定长。
test "plan_cdc: 判定表" {
  let remote_with_view = cdcwb_entry(
    "f.bin",
    300L,
    ["b0"],
    cdh=Some(["c0", "c1"]),
    clens=Some([100L, 200L]),
  )
  let remote_no_view = cdcwb_entry("f.bin", 300L, ["b0"])
  let local_with_view = cdcwb_entry(
    "f.bin",
    300L,
    ["b0"],
    cdh=Some(["c0", "c1"]),
    clens=Some([100L, 200L]),
  )
  let local_no_view = cdcwb_entry("f.bin", 300L, ["b0"])
  let local_tombstone = cdcwb_entry("f.bin", 0L, [], deleted=true)
  let local_placeholder = cdcwb_entry(
    "f.bin",
    300L,
    ["b0"],
    cdh=Some(["c0", "c1"]),
    clens=Some([100L, 200L]),
    placeholder=true,
  )
  // 双方有视图 → true
  assert_eq(plan_cdc(remote_with_view, Some(local_with_view)), true)
  // 本地墓碑 / 占位 / 无视图 / 缺失 → false(无差集可算,按定长)
  assert_eq(plan_cdc(remote_with_view, Some(local_tombstone)), false)
  assert_eq(plan_cdc(remote_with_view, Some(local_placeholder)), false)
  assert_eq(plan_cdc(remote_with_view, Some(local_no_view)), false)
  assert_eq(plan_cdc(remote_with_view, None), false)
  // 对端无视图 → false
  assert_eq(plan_cdc(remote_no_view, Some(local_with_view)), false)
  // cdh 与 clens 不等长:视为无视图(绝不全套上线)
  let lopsided = cdcwb_entry(
    "f.bin",
    300L,
    ["b0"],
    cdh=Some(["c0", "c1"]),
    clens=Some([100L]),
  )
  assert_eq(plan_cdc(lopsided, Some(local_with_view)), false)
}

///|
/// 供应定位:CDC 槽位越界 / 本机无 CDC 视图 / 定长哈希漂移都不定位,
/// CDC 偏移按本机 clens 前缀和。
test "locate_serve_slot: 口径定位" {
  let entry = cdcwb_entry(
    "f.bin",
    300L,
    ["b0"],
    cdh=Some(["c0", "c1", "c2"]),
    clens=Some([100L, 200L, 50L]),
  )
  // CDC:偏移 = 前缀和(槽 2 → 300),响应哈希 = cdh[slot] 而非 request.hash
  let req_cdc : @net.WireBlockRequest = {
    device_id: "peer",
    path: "f.bin",
    block_index: 2L,
    hash: "stale-or-wrong",
    priority: None,
    cdc: Some(true),
  }
  let serve = locate_serve_slot(entry, req_cdc).unwrap()
  assert_eq(serve.slot, 2)
  assert_eq(serve.offset, 300L)
  assert_eq(serve.length, 50)
  assert_eq(serve.expected, "c2")
  assert_eq(serve.cdc, true)
  // CDC 槽位越界 / 负数
  let req_oob = { ..req_cdc, block_index: 3L, }
  assert_true(locate_serve_slot(entry, req_oob) is None)
  let req_neg = { ..req_cdc, block_index: -1L, }
  assert_true(locate_serve_slot(entry, req_neg) is None)
  // 本机无 CDC 视图(旧数据):静默忽略
  let plain = cdcwb_entry("f.bin", 300L, ["b0"])
  assert_true(locate_serve_slot(plain, req_cdc) is None)
  // clens 声明超出 CDC_MAX_CHUNK:防御闸不供
  let huge = cdcwb_entry(
    "big.bin",
    @core.CDC_MAX_CHUNK.to_int64() + 1L,
    ["b0"],
    cdh=Some(["c0"]),
    clens=Some([@core.CDC_MAX_CHUNK.to_int64() + 1L]),
  )
  let req_huge : @net.WireBlockRequest = {
    device_id: "peer",
    path: "big.bin",
    block_index: 0L,
    hash: "c0",
    priority: None,
    cdc: Some(true),
  }
  assert_true(locate_serve_slot(huge, req_huge) is None)
  // 定长:请求哈希与本机索引一致才定位;漂移不定位
  let req_fixed : @net.WireBlockRequest = {
    device_id: "peer",
    path: "f.bin",
    block_index: 0L,
    hash: "b0",
    priority: None,
    cdc: None,
  }
  let serve_fixed = locate_serve_slot(entry, req_fixed).unwrap()
  assert_eq(serve_fixed.slot, 0)
  // 末块按条目 size 收尾(300 < BLOCK_SIZE)
  assert_eq(serve_fixed.length, 300)
  assert_eq(serve_fixed.cdc, false)
  let req_drift = { ..req_fixed, hash: "other-version", }
  assert_true(locate_serve_slot(entry, req_drift) is None)
  let req_fixed_oob = { ..req_fixed, block_index: 5L, }
  assert_true(locate_serve_slot(entry, req_fixed_oob) is None)
}
