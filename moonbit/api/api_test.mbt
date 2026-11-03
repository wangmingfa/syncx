///|
/// API 层测试。两组口径:
///   - `dispatch_http` 进程内分发:走完整「中间件 + 路由」链路,不起 socket,
///     断言状态码/Content-Type/JSON 形态;
///   - 一条真实 HTTP 用例:随机端口起 mocket 原生服务,用
///     moonbitlang/async/http 客户端发请求,验证 `App::listen` 端到端可用。
/// 端口由 `127.0.0.1:0` 探测获得,不占用固定端口,测试可幂等重跑。
/// 认证已接真实签名票据:不再用任意字符串糊弄 cookie,一律走
/// `sign_session(session_secret(base), ...)` 签发。

///|
/// 测试用装配选项:control_token 固定,配置指向不存在的临时路径
/// (读作空配置,不影响断言)。
fn test_options() -> @api.ApiOptions {
  @api.ApiOptions::new(
    device_id="TESTDEVICE01",
    control_token="test-token",
    config_file=Some("/tmp/syncx-mb-api-test-not-exist/config.json"),
  )
}

///|
/// 以 control_token 为签名基签发一枚有效会话票据。
fn mint_ticket() -> String {
  let secret = @api.session_secret("test-token")
  @api.sign_session(
    { via: "token", sub: "token", exp: @api.now_ms() + 60_000L, },
    secret,
  )
}

///|
/// 从响应体解出 JSON 对象;不是对象即测试失败。
fn require_object(body : Json) -> Map[String, Json] {
  match body {
    Object(obj) => obj
    _ => panic()
  }
}

///|
async test "GET /health 免认证回 ok" {
  let app = @api.build_app(test_options())
  let response = @mocket.dispatch_http(app, "GET", "/health", {}, b"")
  assert_eq(response.status_code.to_int(), 200)
  assert_eq(
    response.headers.get("Content-Type"),
    Some("application/json; charset=utf-8"),
  )
  let body : Json = response.read_body()
  let obj = require_object(body)
  assert_true(obj.get("ok") is Some(True))
  assert_eq(obj.length(), 1)
}

///|
async test "GET /api/status 未认证回 401" {
  let app = @api.build_app(test_options())
  let response = @mocket.dispatch_http(app, "GET", "/api/status", {}, b"")
  assert_eq(response.status_code.to_int(), 401)
  let body : Json = response.read_body()
  let obj = require_object(body)
  assert_true(obj.get("error") is Some(String("unauthorized")))
}

///|
async test "GET /api/status 已认证回最小 camelCase 载荷" {
  let app = @api.build_app(test_options())
  let response = @mocket.dispatch_http(
    app,
    "GET",
    "/api/status",
    { "Cookie": "syncx_session=\{mint_ticket()}" },
    b"",
  )
  assert_eq(response.status_code.to_int(), 200)
  let body : Json = response.read_body()
  let obj = require_object(body)
  assert_true(obj.get("deviceId") is Some(String("TESTDEVICE01")))
  assert_true(obj.get("version") is Some(String(@core.VERSION)))
  assert_true(obj.get("runtime") is Some(String("moonbit")))
  assert_true(obj.get("updateSource") is Some(String("github")))
  // 前端 StatusData 的必填字段必须有缺省值(空数组/0),
  // 否则前端 status.offers.filter 之类会直接抛错;platform 取编译目标 OS
  assert_true(obj.get("offers") is Some(Array([])))
  assert_true(obj.get("devices") is Some(Array([])))
  assert_true(obj.get("syncProgress") is Some(Array([])))
  assert_true(obj.get("platform") is Some(String(_)))
  // hostname/localAddresses 依赖宿主机环境(取得到才上线),键数按双口径折算
  let mut expected = 11
  if obj.get("hostname") is Some(_) {
    expected = expected + 1
  }
  if obj.get("localAddresses") is Some(_) {
    expected = expected + 1
  }
  assert_eq(obj.length(), expected)
}

///|
async test "伪造票据过不了认证门" {
  let app = @api.build_app(test_options())
  // 无签名
  let response = @mocket.dispatch_http(
    app,
    "GET",
    "/api/status",
    { "Cookie": "syncx_session=session-ticket" },
    b"",
  )
  assert_eq(response.status_code.to_int(), 401)
  // 签名密钥不对
  let bad_secret = @api.session_secret("other-token")
  let forged = @api.sign_session(
    { via: "token", sub: "token", exp: @api.now_ms() + 60_000L, },
    bad_secret,
  )
  let response = @mocket.dispatch_http(
    app,
    "GET",
    "/api/status",
    { "Cookie": "syncx_session=\{forged}" },
    b"",
  )
  assert_eq(response.status_code.to_int(), 401)
}

///|
async test "control.token 原文可直接作凭据(对齐 credential_ok)" {
  let app = @api.build_app(test_options())
  let response = @mocket.dispatch_http(
    app,
    "GET",
    "/api/status",
    { "Cookie": "syncx_session=test-token" },
    b"",
  )
  assert_eq(response.status_code.to_int(), 200)
}

///|
async test "未知 API 路径:过认证门后落 404" {
  let app = @api.build_app(test_options())
  let response = @mocket.dispatch_http(
    app,
    "GET",
    "/api/nope",
    { "Cookie": "syncx_session=\{mint_ticket()}" },
    b"",
  )
  assert_eq(response.status_code.to_int(), 404)
}

///|
async test "GET / 未配置 dist 时回占位页" {
  let app = @api.build_app(test_options())
  let response = @mocket.dispatch_http(app, "GET", "/", {}, b"")
  assert_eq(response.status_code.to_int(), 200)
  assert_eq(
    response.headers.get("Content-Type"),
    Some("text/html; charset=utf-8"),
  )
  let body : String = response.read_body()
  assert_true(body.contains("<title>syncx</title>"))
}

///|
/// 探测 URL 是否可达:返回状态码;连接失败(服务尚未监听)回 None。
async fn probe_http(url : String) -> Int32? {
  let (response, _body) = @http.get(url) catch { _ => return None }
  Some(response.code)
}

///|
/// 真实 HTTP 端到端:随机端口 + moonbitlang/async/http 客户端。
/// 服务在后台任务里常驻(与 async 包自身 http 测试同款模式),端口经
/// `127.0.0.1:0` 探测取得,重跑不冲突。
async test "真实 HTTP:随机端口起服务,/health 与 /api/status 可达" {
  @async.with_task_group() <| group => {
    // 先绑 :0 让内核挑一个空闲端口,随即释放给 mocket 监听
    let probe = @socket.TcpServer(
      @socket.Addr::parse("127.0.0.1:0") catch {
        _ => panic()
      },
    )
    let port = probe.addr.port()
    probe.close()
    let base = "http://127.0.0.1:\{port}"
    let app = @api.build_app(test_options())
    group.spawn_bg(no_wait=true) <| () => { app.listen("127.0.0.1:\{port}") }
    // 后台拉起可能有窗口期,连接被拒时退避重试(总量 ~5s,超时即测试失败)
    let mut ready = false
    for _ in 0..<100 {
      if probe_http("\{base}/health") is Some(200) {
        ready = true
        break
      }
      @async.sleep(50)
    }
    assert_true(ready)
    // /health:JSON 形态
    let (health_response, health_body) = @http.get("\{base}/health")
    assert_eq(health_response.code, 200)
    let health_obj = require_object(@json.parse(health_body.text()))
    assert_true(health_obj.get("ok") is Some(True))
    // /api/status:带签名会话 cookie,断言最小字段
    let (status_response, status_body) = @http.get("\{base}/api/status", headers={
      "Cookie": "syncx_session=\{mint_ticket()}",
    })
    assert_eq(status_response.code, 200)
    let status_obj = require_object(@json.parse(status_body.text()))
    assert_true(status_obj.get("deviceId") is Some(String("TESTDEVICE01")))
    assert_true(status_obj.get("runtime") is Some(String("moonbit")))
    // /api/status 未带 cookie:真实链路上也要被认证门拦下
    assert_true(probe_http("\{base}/api/status") is Some(401))
  }
}

///|
test "/api/status.settings 透出 fsWatch 全局设置" {
  // 装配层注入(config.json 启动时快照)→ settings 段按 camelCase 上线
  let config = @core.parse_config(
    "{\"fsWatchEnabled\":false,\"fsWatchFallbackScanSecs\":900}",
  )
  let options = @api.ApiOptions::new(
    device_id="TESTDEVICE01",
    control_token="test-token",
    settings=Some(@api.settings_json(config)),
  )
  let obj = require_object(@api.status_json(options))
  match obj.get("settings") {
    Some(Object(settings)) => {
      assert_true(settings.get("fsWatchEnabled") is Some(False))
      match settings.get("fsWatchFallbackScanSecs") {
        Some(Number(n, ..)) => assert_eq(n, 900.0)
        _ => panic()
      }
    }
    _ => panic()
  }
  // 未注入 = 整段不上线(旧装配形态,与「缺字段 = 旧后端」口径一致)
  let bare = require_object(
    @api.status_json(
      @api.ApiOptions::new(device_id="D", control_token="test-token"),
    ),
  )
  assert_true(bare.get("settings") is None)
}

///|
test "settings_json:缺省值口径(监听开、兜底 600s)" {
  let settings = require_object(@api.settings_json(@core.parse_config("{}")))
  assert_true(settings.get("fsWatchEnabled") is Some(True))
  match settings.get("fsWatchFallbackScanSecs") {
    Some(Number(n, ..)) => assert_eq(n, 600.0)
    _ => panic()
  }
}

///|
/// 点分 IPv4 字面量校验(localAddresses 形态断言用;四段、纯数字、每段 ≤3 位)。
fn is_ipv4_literal(text : String) -> Bool {
  let parts : Array[StringView] = text.split(".").collect()
  if parts.length() != 4 {
    return false
  }
  for part in parts {
    if part.char_length() == 0 || part.char_length() > 3 {
      return false
    }
    for c in part {
      if c < '0' || c > '9' {
        return false
      }
    }
  }
  true
}

///|
test "status_json:本机信息三字段(注入 peerPort 必上线,主机名/局域网按环境双口径)" {
  let obj = require_object(
    @api.status_json(
      @api.ApiOptions::new(
        device_id="TESTDEVICE01",
        control_token="test-token",
        peer_port=Some(23456),
      ),
    ),
  )
  // peerPort 是装配参数:注入后必须上线且为数值
  match obj.get("peerPort") {
    Some(Number(n, ..)) => assert_eq(n, 23456.0)
    _ => panic()
  }
  // hostname:本机取得到则断言非空字符串;取不到(CI/沙箱)则必须缺省不上线
  match obj.get("hostname") {
    Some(String(h)) => assert_true(h != "")
    Some(_) => panic()
    None => ()
  }
  // localAddresses:取到则每条都是点分 IPv4;一条都没有则缺省不上线
  match obj.get("localAddresses") {
    Some(Array(items)) =>
      for item in items {
        match item {
          String(addr) => assert_true(is_ipv4_literal(addr))
          _ => panic()
        }
      }
    Some(_) => panic()
    None => ()
  }
}

///|
test "status_json:未注入 peerPort 则字段不上线" {
  let obj = require_object(
    @api.status_json(@api.ApiOptions::new(device_id="D", control_token="test-token")),
  )
  assert_true(obj.get("peerPort") is None)
}

///|
test "parse_lan_addresses:合法数组逐条收,非字符串与畸形输入丢弃" {
  assert_eq(@api.parse_lan_addresses("[\"192.168.1.5\",\"10.0.0.2\"]").length(), 2)
  assert_true(@api.parse_lan_addresses("[]").length() == 0)
  // 畸形 JSON:解析失败视作取不到
  assert_true(@api.parse_lan_addresses("not json").length() == 0)
  // 非字符串元素忽略(C 侧已保证不会出现,防御性兜底)
  let mixed = @api.parse_lan_addresses("[1,\"10.0.0.9\",null]")
  assert_eq(mixed.length(), 1)
  assert_eq(mixed[0], "10.0.0.9")
}
