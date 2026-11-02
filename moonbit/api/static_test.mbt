///|
/// 静态资源服务测试(黑盒):dist/web 存在时按扩展名回 Content-Type,
/// 壳路径回 index.html,不存在的文件 404;dist 缺失时退回占位页。

///|
async test "未配置 web_dist:/ 回占位页,非壳路径 404" {
  let dir = @fs.tmpdir(prefix="syncx-mb-static-none")
  let options = @api.ApiOptions::new(
    device_id="TESTDEVICE01",
    control_token="test-token",
    config_file=Some("\{dir}/config.json"),
  )
  let app = @api.build_app(options)
  let response = @mocket.dispatch_http(app, "GET", "/", {}, b"")
  assert_eq(response.status_code.to_int(), 200)
  let body : String = response.read_body()
  assert_true(body.contains("<title>syncx</title>"))
  assert_true(body.contains("SYNCX_WEB_DIST"))
}

///|
async test "配置了 dist:/ 走真实静态文件,Content-Type 按扩展名映射" {
  let dir = @fs.tmpdir(prefix="syncx-mb-static-dist")
  @fs.mkdir("\{dir}/dist", recursive=true, allow_exist=true)
  @fs.write_file(
    "\{dir}/dist/index.html",
    "<!doctype html><title>real</title>",
    create_mode=CreateOrTruncate,
  )
  @fs.write_file(
    "\{dir}/dist/app.js",
    "console.log(1)",
    create_mode=CreateOrTruncate,
  )
  @fs.write_file(
    "\{dir}/dist/style.css",
    "body{}",
    create_mode=CreateOrTruncate,
  )
  @fs.write_file("\{dir}/dist/logo.svg", "<svg/>", create_mode=CreateOrTruncate)
  let options = @api.ApiOptions::new(
    device_id="TESTDEVICE01",
    control_token="test-token",
    config_file=Some("\{dir}/config.json"),
    web_dist=Some("\{dir}/dist"),
  )
  let app = @api.build_app(options)
  // / → index.html
  let response = @mocket.dispatch_http(app, "GET", "/", {}, b"")
  assert_eq(response.status_code.to_int(), 200)
  assert_eq(
    response.headers.get("Content-Type"),
    Some("text/html; charset=utf-8"),
  )
  let body : String = response.read_body()
  assert_true(body.contains("<title>real</title>"))
  // .js
  let response = @mocket.dispatch_http(app, "GET", "/app.js", {}, b"")
  assert_eq(response.status_code.to_int(), 200)
  assert_eq(
    response.headers.get("Content-Type"),
    Some("text/javascript; charset=utf-8"),
  )
  // .css
  let response = @mocket.dispatch_http(app, "GET", "/style.css", {}, b"")
  assert_eq(response.status_code.to_int(), 200)
  assert_eq(
    response.headers.get("Content-Type"),
    Some("text/css; charset=utf-8"),
  )
  // .svg
  let response = @mocket.dispatch_http(app, "GET", "/logo.svg", {}, b"")
  assert_eq(response.status_code.to_int(), 200)
  assert_eq(response.headers.get("Content-Type"), Some("image/svg+xml"))
  // 不存在的文件:404
  let response = @mocket.dispatch_http(app, "GET", "/missing.txt", {}, b"")
  assert_eq(response.status_code.to_int(), 404)
}

///|
async test "壳路径回 index.html:前端路径路由刷新不 404" {
  let dir = @fs.tmpdir(prefix="syncx-mb-static-shell")
  @fs.mkdir("\{dir}/dist", recursive=true, allow_exist=true)
  @fs.write_file(
    "\{dir}/dist/index.html",
    "<!doctype html><title>real</title>",
    create_mode=CreateOrTruncate,
  )
  let options = @api.ApiOptions::new(
    device_id="TESTDEVICE01",
    control_token="test-token",
    config_file=Some("\{dir}/config.json"),
    web_dist=Some("\{dir}/dist"),
  )
  let app = @api.build_app(options)
  for path in ["/login", "/compare", "/compare/abc", "/files", "/trash/x"] {
    let response = @mocket.dispatch_http(app, "GET", path, {}, b"")
    assert_eq(response.status_code.to_int(), 200)
    let body : String = response.read_body()
    assert_true(body.contains("<title>real</title>"))
  }
  // 拼错的 API 路径不能被壳掩盖
  assert_true(@api.is_shell_path("/"))
  assert_true(@api.is_shell_path("/compare/abc"))
  assert_true(!@api.is_shell_path("/api/statuss"))
  assert_true(!@api.is_shell_path("/history"))
}

///|
async test "dist 不存在时:壳路径退占位页,不 5xx" {
  let dir = @fs.tmpdir(prefix="syncx-mb-static-missing")
  let options = @api.ApiOptions::new(
    device_id="TESTDEVICE01",
    control_token="test-token",
    config_file=Some("\{dir}/config.json"),
    web_dist=Some("\{dir}/dist-does-not-exist"),
  )
  let app = @api.build_app(options)
  let response = @mocket.dispatch_http(app, "GET", "/", {}, b"")
  assert_eq(response.status_code.to_int(), 200)
  let body : String = response.read_body()
  assert_true(body.contains("<title>syncx</title>"))
  let response = @mocket.dispatch_http(app, "GET", "/login", {}, b"")
  assert_eq(response.status_code.to_int(), 200)
  // 静态探测失败绝不能吃掉 API:未认证仍 401
  let response = @mocket.dispatch_http(app, "GET", "/api/status", {}, b"")
  assert_eq(response.status_code.to_int(), 401)
}
