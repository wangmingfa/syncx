///|
/// 节假日日历仓库(daemon 侧判定数据源;对齐 Node createHolidayStore 的三条
/// 硬约束:**判定路径绝不打网络** —— 只读内存/盘上缓存;**没有任何数据时退化
/// 为按星期几判**,绝不因拉不到日历把目录锁死;**缓存落 <配置目录>/
/// holidays-<year>.json 不进 config.json** —— 那个文件被热重载盯着,年度数据
/// 写进去会让每次刷新都触发一轮配置重载)。
///
/// 所有权:实例由装配层创建,共享给三处 —— actor 的时段判定只读(mem 在
/// 首次 load 后驻留)、API 的日历面板/status 只读、装配层 spawn 的刷新循环
/// 写 mem/meta/last_error。协作式单线程调度下,跨 await 之后的同步字段写入
/// 对读方是原子的,无需加锁。

///|
pub struct HolidayStore {
  /// 缓存目录(= 配置目录;空串 = 无处读写缓存,判定恒走退化口径,测试用)。
  config_dir : String
  /// year → dateKey → "workday" | "holiday"(盘上缓存命中后驻留,判定不重复读盘)。
  mem : Map[Int32, Map[String, String]]
  /// year → 拉取时刻(仅诊断;重启后从盘上缓存回填)。
  meta : Map[Int32, Int64]
  /// 最近一次拉取失败的原因(仅诊断;不影响判定)。
  mut last_error : String?
  /// config.calendarOverrides 快照(apply_config 注入;覆盖优先于拉取数据)。
  mut overrides : Map[String, String]?
  /// config.holidayAutoFetch 快照(None = 开,与 Node `!== false` 同口径)。
  mut auto_fetch : Bool?
  /// config.holidaySourceUrl 快照(None = 默认源)。
  mut source_url : String?
}

///|
/// 拉取超时封顶(对齐 Node FETCH_TIMEOUT_MS)。
pub const HOLIDAY_FETCH_TIMEOUT_MS : Int32 = 15_000

///|
/// 刷新周期(对齐 Node 的 24h setInterval;装配层循环按此睡眠)。
pub const HOLIDAY_REFRESH_INTERVAL_MS : Int64 = 24 * 60 * 60_000L

///|
pub fn HolidayStore::new(config_dir : String) -> HolidayStore {
  {
    config_dir,
    mem: Map([]),
    meta: Map([]),
    last_error: None,
    overrides: None,
    auto_fetch: None,
    source_url: None,
  }
}

///|
/// 配置快照注入(启动与每次配置热重载后调用;改完即时生效)。参数取
/// config 对应字段,显式传参让测试不必构造整个 Config。
pub fn HolidayStore::apply_config(
  self : HolidayStore,
  auto_fetch~ : Bool? = None,
  source_url~ : String? = None,
  overrides~ : Map[String, String]? = None,
) -> Unit {
  self.auto_fetch = auto_fetch
  self.source_url = source_url
  self.overrides = overrides
}

///|
/// 自动拉取开关(None = 开,与 Node `holidayAutoFetch !== false` 同口径)。
fn HolidayStore::auto_fetch_enabled(self : HolidayStore) -> Bool {
  self.auto_fetch != Some(false)
}

///|
/// 生效的源地址(未配置回默认源)。
fn HolidayStore::effective_source(self : HolidayStore) -> String {
  match self.source_url {
    Some(url) => url
    None => @core.DEFAULT_HOLIDAY_SOURCE
  }
}

///|
/// 按年份展开占位符后的源地址(拉取实际会用的地址;诊断与测试用)。
pub fn HolidayStore::source_url_for(
  self : HolidayStore,
  year : Int32,
) -> String {
  replace_year_placeholder(self.effective_source(), year)
}

///|
/// 盘上缓存路径(对齐 Node cachePath;config_dir 为空 = 不落盘,测试用)。
fn HolidayStore::cache_path(self : HolidayStore, year : Int32) -> String {
  "\{self.config_dir}/holidays-\{year}.json"
}

///|
/// 读一年的日历数据(**仅内存**;判定路径是同步上下文,绝不读盘/打网络)。
pub fn HolidayStore::mem_year(
  self : HolidayStore,
  year : Int32,
) -> Map[String, String]? {
  self.mem.get(year)
}

///|
/// 把一年的日历数据从盘上缓存加载进内存(仅 async 上下文调用:启动刷新、
/// 每日刷新与日历面板查询)。盘上坏缓存等同没有,不影响判定;只收合法
/// 日期与合法身份(与 Node loadYear 同口径),坏键逐条丢弃。
pub async fn HolidayStore::ensure_year_loaded(
  self : HolidayStore,
  year : Int32,
) -> Unit {
  if self.mem.get(year) is Some(_) {
    return
  }
  if self.config_dir == "" {
    return
  }
  let raw = @fs.read_file(self.cache_path(year)) catch { _ => return }
  let body = @json.parse(raw.text()) catch { _ => return }
  let days = match body {
    Object(fields) =>
      match fields.get("days") {
        Some(Object(days)) => days
        _ => return
      }
    _ => return
  }
  let out : Map[String, String] = Map([])
  for key, value in days {
    match value {
      String(kind) =>
        if @core.is_real_date_key(key) &&
          (kind == "workday" || kind == "holiday") {
          out.set(key, kind)
        }
      _ => ()
    }
  }
  match body {
    Object(fields) =>
      match fields.get("fetchedAt") {
        Some(Number(n, ..)) => self.meta.set(year, n.to_int64())
        _ => ()
      }
    _ => ()
  }
  self.mem.set(year, out)
}

///|
/// 落盘一年的日历数据(写缓存 + 驻留内存 + 记拉取时刻)。写失败只留诊断
/// 线索,不影响判定(与 Node saveYear 同口径)。
pub async fn HolidayStore::save_year(
  self : HolidayStore,
  year : Int32,
  days : Map[String, String],
) -> Unit {
  if self.config_dir == "" {
    return
  }
  let days_json : Map[String, @json.Json] = Map([])
  for key, kind in days {
    days_json.set(key, Json::string(kind))
  }
  let payload : Map[String, @json.Json] = Map([])
  payload.set("year", Json::number(year.to_double()))
  payload.set("fetchedAt", Json::number(now_ms().to_double()))
  payload.set("days", Json::object(days_json))
  @fs.write_file(self.cache_path(year), Json::object(payload).stringify()) catch {
    e => {
      self.last_error = Some("节假日缓存写入失败:\{e}")
      return
    }
  }
  self.mem.set(year, days)
  self.meta.set(year, now_ms())
}

///|
/// 该日的日历身份;None = 该日无任何日历数据(调用方按星期几退化)。
/// 优先级:手动覆盖 > 拉取数据(对齐 Node dayType)。
pub fn HolidayStore::day_type(
  self : HolidayStore,
  year : Int32,
  month : Int32,
  day : Int32,
) -> String? {
  let key = date_key(year, month, day)
  match self.overrides {
    Some(ov) =>
      match ov.get(key) {
        Some(kind) => return Some(kind)
        None => ()
      }
    None => ()
  }
  match self.mem_year(year) {
    Some(days) => days.get(key)
    None => None
  }
}

///|
/// 是工作日吗:覆盖 > 拉取数据 > 周一~周五退化(对齐 Node isWorkday)。
pub fn HolidayStore::is_workday(
  self : HolidayStore,
  year : Int32,
  month : Int32,
  day : Int32,
) -> Bool {
  match self.day_type(year, month, day) {
    Some(kind) => kind == "workday"
    None => @core.weekday_workday_fallback(year, month, day)
  }
}

///|
/// 注入口:时段判定链要的 IsWorkday 谓词(闭包捕获仓库本体)。
pub fn HolidayStore::is_workday_fn(self : HolidayStore) -> @core.IsWorkday {
  fn(year, month, day) { self.is_workday(year, month, day) }
}

///|
/// 拉一年的日历:https 校验 + 15s 超时 + 源数据解析。失败如实记
/// last_error 并回 None —— 判定路径永远可用(离线是常态,不刷日志)。
async fn HolidayStore::fetch_year(
  self : HolidayStore,
  year : Int32,
) -> Map[String, String]? {
  let template = self.effective_source()
  if !template.has_prefix("https://") {
    self.last_error = Some("节假日源必须是 https 地址:\{template}")
    return None
  }
  let url = replace_year_placeholder(template, year)
  // 闭包内不抛自定义错误(无 Show):用 (ok, 载荷, 错误文案) 三元组带出结果
  let outcome : (Bool, @json.Json?, String) = @async.with_timeout(
    HOLIDAY_FETCH_TIMEOUT_MS,
    () => {
      let (header, data) = @http.get(url)
      if header.code != 200 {
        return (false, None, "节假日源返回 HTTP \{header.code}")
      }
      let body = data.text() catch {
        _ => return (false, None, "节假日源响应读取失败")
      }
      let payload = @json.parse(body) catch {
        _ => return (false, None, "节假日源响应不是合法 JSON")
      }
      (true, Some(payload), "")
    },
  ) catch {
    e => (false, None, "\{e}")
  }
  let (ok, payload, error_text) = outcome
  if !ok {
    self.last_error = Some(error_text)
    return None
  }
  let days = @core.parse_holiday_payload(payload)
  if days.length() == 0 {
    self.last_error = Some(
      "节假日源数据为空或结构不认识(\{year})",
    )
    return None
  }
  self.last_error = None
  Some(days)
}

///|
/// 源地址模板的 {year} 占位符替换(String 无通用 replace,手工拼接;
/// 未出现占位符则原样返回,与 Node 的 String.replace 语义一致)。
fn replace_year_placeholder(template : String, year : Int32) -> String {
  let needle = "{year}"
  let replacement = "\{year}"
  let out = StringBuilder(size_hint=32)
  let mut rest : String = template
  let mut changed = false
  for ;; {
    match rest.find(needle) {
      Some(idx) => {
        out.write_string(rest[0:idx].to_owned())
        out.write_string(replacement)
        rest = rest[idx + needle.length():].to_owned()
        changed = true
      }
      None => break
    }
  }
  if changed {
    out.write_string(rest)
    out.to_string()
  } else {
    template
  }
}

///|
/// 后台刷新:缺该年数据就拉;已进入 12 月则顺带预备下一年(跨年零点不
/// 想出现空窗)。失败只记 last_error 并保留旧数据 —— 判定路径永远可用。
pub async fn HolidayStore::refresh(
  self : HolidayStore,
  zone : @time.Zone,
  now : Int64,
) -> Unit {
  let moment = civil_from_ms(now, zone)
  // 先把盘上已有缓存灌进内存(判定路径只读内存;启动即有数据,不等网络)
  self.ensure_year_loaded(moment.year)
  if !self.auto_fetch_enabled() {
    return
  }
  let need : Array[Int32] = []
  match self.mem_year(moment.year) {
    Some(_) => ()
    None => need.push(moment.year)
  }
  if moment.month == 12 {
    self.ensure_year_loaded(moment.year + 1)
    match self.mem_year(moment.year + 1) {
      Some(_) => ()
      None => need.push(moment.year + 1)
    }
  }
  for year in need {
    match self.fetch_year(year) {
      Some(days) => {
        self.save_year(year, days)
        @log.info("节假日日历已刷新:{Year}({Count} 天)", [
          Json::number(year.to_double()),
          Json::number(days.length().to_double()),
        ])
      }
      None => ()
    }
  }
}

///|
/// 该年是否已有可用数据(内存台账;盘上缓存在启动/刷新时灌进内存)。
pub fn HolidayStore::is_year_fetched(self : HolidayStore, year : Int32) -> Bool {
  self.meta.get(year) is Some(_)
}

///|
/// 日历状态(status 与日历面板共用的诊断口径,对齐 Node HolidayStatus)。
pub fn HolidayStore::status(self : HolidayStore, year : Int32) -> @json.Json {
  let map : Map[String, @json.Json] = Map([])
  map.set("year", Json::number(year.to_double()))
  map.set("fetched", Json::boolean(self.meta.get(year) is Some(_)))
  match self.meta.get(year) {
    Some(at) => map.set("fetchedAt", Json::number(at.to_double()))
    None => ()
  }
  match self.overrides {
    Some(ov) => map.set("overrideCount", Json::number(ov.length().to_double()))
    None => map.set("overrideCount", Json::number(0.0))
  }
  match self.last_error {
    Some(text) => map.set("lastError", Json::string(text))
    None => ()
  }
  Json::object(map)
}

///|
/// 某年的日期表(日历面板渲染;无数据回空对象,对齐 Node yearDays ?? {})。
pub fn HolidayStore::year_days(self : HolidayStore, year : Int32) -> @json.Json {
  let out : Map[String, @json.Json] = Map([])
  match self.mem_year(year) {
    Some(days) =>
      for key, kind in days {
        out.set(key, Json::string(kind))
      }
    None => ()
  }
  Json::object(out)
}

///|
/// dateKey 组装(YYYY-MM-DD,月/日补零)。
fn date_key(year : Int32, month : Int32, day : Int32) -> String {
  "\{year}-\{two_digits(month)}-\{two_digits(day)}"
}

///|
fn two_digits(n : Int32) -> String {
  if n < 10 {
    "0\{n}"
  } else {
    "\{n}"
  }
}
