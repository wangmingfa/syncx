///|
// 冲突副本命名判定。正则与 Node `CONFLICT_COPY_RE` / Rust `CONFLICT_COPY_PATTERN`
// 逐字相同;这里测的是同一正则在 MoonBit 下的行为等价:
//   <原路径去扩展名>.sync-conflict-<ts36>[-<seq36>]-<对端设备ID><扩展名>

///|
test "冲突副本命名:识别与反解" {
  // 标准命名:时间戳 + 10 位 base32 设备 ID + 扩展名
  assert_true(
    @core.is_conflict_copy_name("报告.sync-conflict-lz7k3a-ABCDEF2345.txt"),
  )
  let parsed = @core.parse_conflict_copy_name(
    "报告.sync-conflict-lz7k3a-ABCDEF2345.txt",
  )
  match parsed {
    Some((original, device)) => {
      assert_eq(original, "报告.txt")
      assert_eq(device, "ABCDEF2345")
    }
    None => panic()
  }
  // 带序号(ts 撞车时加序号区分)
  let parsed2 = @core.parse_conflict_copy_name(
    "a.md.sync-conflict-m1-3-ABCDEFGHIJ",
  )
  match parsed2 {
    Some((original, device)) => {
      assert_eq(original, "a.md")
      assert_eq(device, "ABCDEFGHIJ")
    }
    None => panic()
  }
  // 无扩展名
  let parsed3 = @core.parse_conflict_copy_name(
    "data.sync-conflict-x9-ABCDEFGHIJ",
  )
  match parsed3 {
    Some((original, device)) => {
      assert_eq(original, "data")
      assert_eq(device, "ABCDEFGHIJ")
    }
    None => panic()
  }
}

///|
test "非冲突命名不误判" {
  // 普通文件
  assert_true(!@core.is_conflict_copy_name("报告.txt"))
  // 设备 ID 不是 10 位 base32
  assert_true(!@core.is_conflict_copy_name("a.sync-conflict-lz-abcdefghijk.md"))
  // 缺时间戳段
  assert_true(!@core.is_conflict_copy_name("a.sync-conflict-ABCDEF2345"))
  // 大小写敏感:设备 ID 必须 A-Z2-7
  assert_true(
    !@core.is_conflict_copy_name("a.sync-conflict-lz7k3a-abcdefghij2"),
  )
}

///|
test "冲突副本整路径进硬忽略,反解出的原路径不受影响" {
  assert_true(
    @core.is_hard_ignored("docs/报告.sync-conflict-lz7k3a-ABCDEF2345.md"),
  )
  assert_true(!@core.is_hard_ignored("docs/报告.md"))
}

///|
test "在途中间态后缀判定(大小写不敏感)" {
  assert_true(@core.is_scratch_segment("a.syncx-tmp"))
  assert_true(@core.is_scratch_segment("a.SYNCX-PARTIAL"))
  assert_true(!@core.is_scratch_segment("a.syncx-tmpx"))
  assert_true(@core.is_hard_ignored("sub/a.syncx-partial"))
}
