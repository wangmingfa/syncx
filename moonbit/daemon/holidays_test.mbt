///|
/// 节假日仓库:盘上缓存回灌、覆盖优先于数据、无数据退化按星期几。
/// 2026-01-01 是周四:无日历数据时应判工作日,有数据(holiday)才判休。
async test "节假日仓库:缓存回灌 + 覆盖优先 + 退化口径" {
  let dir = actor_fresh_root("holiday-store")
  actor_mkdir(dir)
  let store = @daemon.HolidayStore::new(dir)
  // 无任何数据:退化口径(周一~五 = 工作日)
  assert_true(store.is_workday(2026, 1, 1))
  assert_false(store.is_workday(2026, 1, 3)) // 周六
  assert_false(store.is_year_fetched(2026))
  // 落一份盘上缓存(Node 同名同格式):1-01 休、1-02(周五)补班
  @fs.write_file(
    "\{dir}/holidays-2026.json",
    "{\"year\":2026,\"fetchedAt\":1000,\"days\":{\"2026-01-01\":\"holiday\",\"2026-01-02\":\"workday\"}}",
  ) catch {
    _ => fail("写缓存失败")
  }
  store.ensure_year_loaded(2026)
  assert_false(store.is_workday(2026, 1, 1))
  assert_true(store.is_workday(2026, 1, 2))
  assert_true(store.is_year_fetched(2026))
  // 手动覆盖优先于拉取数据(公司假与国家法定不一致的场景)
  store.apply_config(overrides=Some(Map([("2026-01-01", "workday")])))
  assert_true(store.is_workday(2026, 1, 1))
  store.apply_config(overrides=Some(Map([("2026-01-02", "holiday")])))
  assert_false(store.is_workday(2026, 1, 2))
  // 注入口:谓词形态与判定链所需 IsWorkday 同形(覆盖 holiday 后该日判休)
  let predicate = store.is_workday_fn()
  assert_false(predicate(2026, 1, 2))
}

///|
/// save → load 往返:写缓存后另起仓库实例能接上(跨重启语义);缓存目录
/// 为空的实例恒走退化口径(测试与无配置目录部署的守门)。
async test "节假日仓库:缓存往返与空目录守门" {
  let dir = actor_fresh_root("holiday-roundtrip")
  actor_mkdir(dir)
  let store = @daemon.HolidayStore::new(dir)
  store.save_year(2027, Map([("2027-01-01", "holiday")]))
  assert_false(store.is_workday(2027, 1, 1))
  let reloaded = @daemon.HolidayStore::new(dir)
  assert_true(reloaded.is_workday(2027, 1, 1)) // 未加载前退化口径
  reloaded.ensure_year_loaded(2027)
  assert_false(reloaded.is_workday(2027, 1, 1))
  // 空缓存目录:读写皆静默跳过,判定恒走退化
  let bare = @daemon.HolidayStore::new("")
  assert_true(bare.is_workday(2027, 1, 1))
  bare.save_year(2027, Map([("2027-01-01", "holiday")]))
  assert_true(bare.is_workday(2027, 1, 1))
}

///|
/// {year} 占位符替换:出现即替换、多次全替换、未出现原样返回。
async test "节假日仓库:源地址占位符替换" {
  let dir = actor_fresh_root("holiday-replace")
  actor_mkdir(dir)
  let store = @daemon.HolidayStore::new(dir)
  store.apply_config(source_url=Some("https://x.test/{year}.json"))
  assert_eq(store.source_url_for(2026), "https://x.test/2026.json")
  store.apply_config(source_url=Some("https://x.test/{year}/{year}.json"))
  assert_eq(store.source_url_for(2026), "https://x.test/2026/2026.json")
  store.apply_config(source_url=Some("https://x.test/static.json"))
  assert_eq(store.source_url_for(2026), "https://x.test/static.json")
}
