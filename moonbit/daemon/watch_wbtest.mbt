///|
/// fs-watch 事件过滤的**批级**语义(白盒:filter_event_batch /
/// event_is_ignored 是 priv 装配件)。谓词判据与路径归一化的对外语义由
/// watch_test.mbt 的纯单测覆盖;触发链的端到端行为(丢弃不重扫、同步文件
/// 照常触发、谓词热替换)由 watch_test.mbt 的真实 fs 集成测试覆盖。

///|
test "filter_event_batch:混合批次按事件逐个判" {
  let rules = @core.IgnoreRuleset::from_lines(["node_modules/"])
  let filter = event_ignore_filter(rules)
  let events : Array[@fs.FsEvent] = [
    @fs.Modify("node_modules/x"),
    @fs.Create("src/a.txt"),
    @fs.Remove("node_modules/y"),
  ]
  let (live, dropped) = filter_event_batch(events, "/tmp/x", filter)
  assert_eq(live, 1)
  assert_eq(dropped, 2)
}

///|
test "filter_event_batch:全部命中的批次为纯丢弃(live == 0 不触发重扫)" {
  // 空规则集 = 只剩硬忽略闸门:daemon 自己写 .git(git 镜像提交)与接收
  // 中间态(.syncx-tmp)的场景 —— 被滤正是目的
  let hard = event_ignore_filter(@core.IgnoreRuleset::from_lines([]))
  let events : Array[@fs.FsEvent] = [
    @fs.Modify(".git/index"),
    @fs.Create(".git/HEAD"),
    @fs.Remove(".receive.syncx-tmp"),
  ]
  let (live, dropped) = filter_event_batch(events, "/tmp/x", hard)
  assert_eq(live, 0)
  assert_eq(dropped, 3)
  // 同步文件混入则批次保留触发
  let mixed : Array[@fs.FsEvent] = [
    @fs.Modify(".git/index"),
    @fs.Create("a.txt"),
  ]
  let (live2, dropped2) = filter_event_batch(mixed, "/tmp/x", hard)
  assert_eq(live2, 1)
  assert_eq(dropped2, 1)
}

///|
test "event_is_ignored:Rename 双路径全部命中才丢,归一失败保留" {
  let rules = @core.IgnoreRuleset::from_lines(["node_modules/"])
  let filter = event_ignore_filter(rules)
  // 新旧都在忽略子树 → 丢(整个重命名发生在忽略子树内)
  assert_true(
    event_is_ignored(
      @fs.Rename(old="node_modules/a", new="node_modules/b"),
      "/tmp/x",
      filter,
    ),
  )
  // 一端出了忽略子树 → 保留(另一端需要被扫描)
  assert_false(
    event_is_ignored(
      @fs.Rename(old="node_modules/a", new="b.txt"),
      "/tmp/x",
      filter,
    ),
  )
  assert_false(
    event_is_ignored(
      @fs.Rename(old="a.txt", new="node_modules/b"),
      "/tmp/x",
      filter,
    ),
  )
  // 归一失败(监听根之外 / 含 '..' 段)→ 保留,宁可多扫不可漏扫
  assert_false(
    event_is_ignored(@fs.Modify("/elsewhere/a.txt"), "/tmp/x", filter),
  )
  assert_false(event_is_ignored(@fs.Modify("a/../b.txt"), "/tmp/x", filter))
  // 空串路径 → 当「无路径」保留原语义
  assert_false(event_is_ignored(@fs.Modify(""), "/tmp/x", filter))
  // 硬忽略子树内的重命名 → 丢(daemon 自己写 .git 的场景,这正是目的)
  let hard = event_ignore_filter(@core.IgnoreRuleset::from_lines([]))
  assert_true(
    event_is_ignored(
      @fs.Rename(old=".git/index", new=".git/index2"),
      "/tmp/x",
      hard,
    ),
  )
}
