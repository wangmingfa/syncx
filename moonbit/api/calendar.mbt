///|
/// 日历面板与手动覆盖的两条路由(对齐 Node /api/calendar*):
///  - GET  /api/calendar?year=YYYY : 某年日历(自动拉取数据 + 手动覆盖),
///    供日历面板渲染;
///  - POST /api/calendar/override { date, type } : 手动覆盖某天的日历身份
///    (公司假 / 补班),type = 'workday' | 'holiday' | null(撤销)。
/// 覆盖写 config.calendarOverrides 后触发配置热重载 —— 装配层回调会把新
/// 覆盖灌进节假日仓库,判定与横幅即时跟上(对齐 Node manager 重算语义)。

///|
/// 当前年份的缺省口径。API 包不带本地时区依赖,按 UTC 天数折算 —— 新年
/// 交界处可能与本地年差几小时;前端日历面板总是显式传参,不受影响。
fn current_year_utc() -> Int32 {
  let (year, _month, _day) = @core.civil_from_days(now_ms() / 86_400_000L)
  year
}

///|
pub async fn handle_calendar_get(
  options : ApiOptions,
  event : @mocket.MocketEvent,
) -> &Responder {
  let store = match options.holidays {
    Some(store) => store
    None =>
      return json_error(event, @mocket.ServiceUnavailable, "日历未启用")
  }
  let year : Int32 = match event.req.query().get("year") {
    Some(raw) => {
      let parsed = @json.parse(raw) catch {
        _ =>
          return json_error(
            event,
            @mocket.BadRequest,
            "year must be an integer between 1970 and 2100",
          )
      }
      match parsed {
        Number(n, ..) =>
          if n.floor() == n && n >= 1970.0 && n <= 2100.0 {
            n.to_int()
          } else {
            return json_error(
              event,
              @mocket.BadRequest,
              "year must be an integer between 1970 and 2100",
            )
          }
        _ =>
          return json_error(
            event,
            @mocket.BadRequest,
            "year must be an integer between 1970 and 2100",
          )
      }
    }
    None => current_year_utc()
  }
  // 盘上缓存灌进内存(异步上下文才能读盘;判定路径不受影响,它只读内存)
  store.ensure_year_loaded(year)
  let overrides : Map[String, @json.Json] = Map([])
  match load_config(options.config_file).calendar_overrides {
    Some(ov) =>
      for key, kind in ov {
        overrides.set(key, Json::string(kind))
      }
    None => ()
  }
  let map : Map[String, @json.Json] = Map([])
  map.set("year", Json::number(year.to_double()))
  map.set("days", store.year_days(year))
  map.set("overrides", Json::object(overrides))
  map.set(
    "fetched",
    Json::boolean(store.is_year_fetched(year) && year == current_year_utc()),
  )
  @mocket.HttpResponse(@mocket.OK).json(Json::object(map))
}

///|
pub async fn handle_calendar_override(
  options : ApiOptions,
  event : @mocket.MocketEvent,
) -> &Responder {
  let body = match parse_json_body(event) {
    Some(body) => body
    None => return json_error(event, @mocket.BadRequest, "invalid json body")
  }
  let obj = match body {
    Object(obj) => obj
    _ => return json_error(event, @mocket.BadRequest, "invalid json body")
  }
  let date = match obj.get("date") {
    Some(String(s)) => s
    _ =>
      return json_error(
        event,
        @mocket.BadRequest,
        "date must be a string (YYYY-MM-DD)",
      )
  }
  let kind : String? = match obj.get("type") {
    Some(Null) => None
    Some(String("workday")) => Some("workday")
    Some(String("holiday")) => Some("holiday")
    _ =>
      return json_error(
        event,
        @mocket.BadRequest,
        "type must be 'workday' | 'holiday' | null",
      )
  }
  if !@core.is_real_date_key(date) {
    return json_error(
      event,
      @mocket.BadRequest,
      "日期格式应为真实存在的 YYYY-MM-DD:「\{date}」",
    )
  }
  let config = load_config(options.config_file)
  let next : Map[String, String] = match config.calendar_overrides {
    Some(ov) => ov
    None => Map([])
  }
  match kind {
    Some(k) => next.set(date, k)
    None => next.remove(date)
  }
  config.calendar_overrides = if next.length() > 0 { Some(next) } else { None }
  save_config(options.config_file, config) catch {
    _ => return json_error(event, @mocket.BadRequest, "日历覆盖失败")
  }
  // 配置热重载:装配层回调把新覆盖灌进节假日仓库,判定与横幅即时跟上
  notify_config_changed(options)
  @mocket.HttpResponse(@mocket.OK).json(ok_true())
}
