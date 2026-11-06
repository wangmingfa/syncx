///|
/// 日历路由:仓库未注入 → 503;注入后 GET 返回缓存数据与覆盖回显,
/// POST 覆盖落盘 config.calendarOverrides 并触发热重载回调。
async test "GET /api/calendar:未注入 503,注入后读缓存与覆盖回显" {
  let dir = test_config_dir("calendar")
  let options = options_with("calendar", dir)
  let app = @api.build_app(options)
  let secret = @api.session_secret("test-token")
  let ticket = @api.sign_session(
    { via: "token", sub: "token", exp: @api.now_ms() + 60_000L, },
    secret,
  )
  let headers : Map[@http.CaseInsensitiveString, StringView] = {
    "Cookie": "syncx_session=\{ticket}",
  }
  // 仓库未注入(旧装配):503
  let response = @mocket.dispatch_http(
    app, "GET", "/api/calendar?year=2026", headers, b"",
  )
  assert_eq(response.status_code.to_int(), 503)
  // 注入仓库并落一份缓存(1-01 休、1-02 补班)
  let store = @daemon.HolidayStore::new(dir)
  options.holidays = Some(store)
  let app = @api.build_app(options)
  @fs.write_file(
    "\{dir}/holidays-2026.json",
    "{\"year\":2026,\"fetchedAt\":1000,\"days\":{\"2026-01-01\":\"holiday\",\"2026-01-02\":\"workday\"}}",
  ) catch {
    _ => fail("写缓存失败")
  }
  store.ensure_year_loaded(2026)
  let response = @mocket.dispatch_http(
    app, "GET", "/api/calendar?year=2026", headers, b"",
  )
  assert_eq(response.status_code.to_int(), 200)
  let body : Json = response.read_body()
  match body {
    Object(obj) => {
      match obj.get("year") {
        Some(Number(n, ..)) => assert_eq(n, 2026.0)
        _ => fail("应带 year")
      }
      let days = match obj.get("days") {
        Some(Object(days)) => days
        _ => fail("应带 days 对象")
      }
      assert_eq(days.get("2026-01-01"), Some("holiday"))
      assert_eq(days.get("2026-01-02"), Some("workday"))
      assert_eq(days.get("2026-01-03"), None)
      match obj.get("fetched") {
        Some(True) => ()
        _ => fail("fetched 应为 true")
      }
    }
    _ => fail("响应应为对象")
  }
  // 非法年份:400
  let response = @mocket.dispatch_http(
    app, "GET", "/api/calendar?year=999", headers, b"",
  )
  assert_eq(response.status_code.to_int(), 400)
}

///|
/// POST /api/calendar/override:合法覆盖落盘(含 null 撤销),非法日期/身份 400。
async test "POST /api/calendar/override:覆盖落盘与校验" {
  let dir = test_config_dir("caloverride")
  let options = options_with("caloverride", dir)
  let store = @daemon.HolidayStore::new(dir)
  options.holidays = Some(store)
  let app = @api.build_app(options)
  let secret = @api.session_secret("test-token")
  let ticket = @api.sign_session(
    { via: "token", sub: "token", exp: @api.now_ms() + 60_000L, },
    secret,
  )
  let headers : Map[@http.CaseInsensitiveString, StringView] = {
    "Cookie": "syncx_session=\{ticket}",
  }
  // 覆盖 1-01 为工作日(公司调休与国家日历不一致)
  let response = @mocket.dispatch_http(
    app, "POST", "/api/calendar/override", headers, b"{\"date\":\"2026-01-01\",\"type\":\"workday\"}",
  )
  assert_eq(response.status_code.to_int(), 200)
  let saved = @api.load_config("\{dir}/config.json")
  let overrides = match saved.calendar_overrides {
    Some(ov) => ov
    None => fail("应落覆盖")
  }
  assert_eq(overrides.get("2026-01-01"), Some("workday"))
  // GET 回显 overrides
  let response = @mocket.dispatch_http(
    app, "GET", "/api/calendar?year=2026", headers, b"",
  )
  let body : Json = response.read_body()
  match body {
    Object(obj) =>
      match obj.get("overrides") {
        Some(Object(ov)) => assert_eq(ov.get("2026-01-01"), Some("workday"))
        _ => fail("应带 overrides")
      }
    _ => fail("响应应为对象")
  }
  // null 撤销:覆盖清空后 calendarOverrides 整键消失(与 Node 同口径)
  let response = @mocket.dispatch_http(
    app, "POST", "/api/calendar/override", headers, b"{\"date\":\"2026-01-01\",\"type\":null}",
  )
  assert_eq(response.status_code.to_int(), 200)
  let saved = @api.load_config("\{dir}/config.json")
  assert_true(saved.calendar_overrides is None)
  // 非法日期与非法身份:400
  let response = @mocket.dispatch_http(
    app, "POST", "/api/calendar/override", headers, b"{\"date\":\"2026-02-30\",\"type\":\"workday\"}",
  )
  assert_eq(response.status_code.to_int(), 400)
  let response = @mocket.dispatch_http(
    app, "POST", "/api/calendar/override", headers, b"{\"date\":\"2026-01-01\",\"type\":\"off\"}",
  )
  assert_eq(response.status_code.to_int(), 400)
}
