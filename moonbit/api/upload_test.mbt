///|
/// 上传换入路由面测试(黑盒,dispatch_http 全链路):
/// dev 门、回调缺省 503、识别成功/失败、换入成功/失败。
/// 识别与换入的实现逻辑在 cli/upload_test.mbt(真实 tar 包)。

///|
/// 带 dev/回调选项的构造器。
fn upload_options(
  dir : String,
  dev_mode~ : Bool = false,
  inspect~ : @api.UploadInspectFn? = None,
  swap~ : @api.UploadSwapFn? = None,
) -> @api.ApiOptions {
  @api.ApiOptions::new(
    device_id="TESTDEVICE01",
    control_token="test-token",
    config_file=Some("\{dir}/config.json"),
    dev_mode~,
    upload_inspect=inspect,
    upload_swap=swap,
  )
}

///|
/// 认证头(所有 /api 路由都要过认证门)。
fn auth_headers() -> Map[@http.CaseInsensitiveString, StringView] {
  let secret = @api.session_secret("test-token")
  let ticket = @api.sign_session(
    { via: "token", sub: "token", exp: @api.now_ms() + 60_000L, },
    secret,
  )
  { "Cookie": "syncx_session=\{ticket}" }
}

///|
async test "upload: 未注入回调回 503(Node 同款文案)" {
  let dir = @fs.tmpdir(prefix="syncx-mb-api-upload-none")
  let app = @api.build_app(upload_options(dir))
  let headers = auth_headers()
  // inspect 与换入两条路由都回 503
  let response = @mocket.dispatch_http(
    app, "POST", "/api/self-update/upload/inspect", headers, b"",
  )
  assert_eq(response.status_code.to_int(), 503)
  let body : Json = response.read_body()
  match body {
    Object(obj) =>
      assert_true(
        obj.get("error") is Some(String("upload update not available")),
      )
    _ => fail("响应应为对象")
  }
  let response = @mocket.dispatch_http(
    app, "POST", "/api/self-update/upload", headers, b"",
  )
  assert_eq(response.status_code.to_int(), 503)
}

///|
async test "upload: dev 运行态一律拒绝(文案与 Node 逐字一致)" {
  let dir = @fs.tmpdir(prefix="syncx-mb-api-upload-dev")
  // 回调已注入也要被 dev 门拦下(门在前,防线不依赖装配完整性)
  let inspect : @api.UploadInspectFn = _bytes => {
    let info : @api.InspectedPackage = {
      backend: "node",
      version: "0.0.0",
      target: None,
      name: None,
    }
    Ok(info)
  }
  let swap : @api.UploadSwapFn = _bytes => Ok("0.0.0")
  let app = @api.build_app(
    upload_options(dir, dev_mode=true, inspect=Some(inspect), swap=Some(swap)),
  )
  let headers = auth_headers()
  let response = @mocket.dispatch_http(
    app, "POST", "/api/self-update/upload/inspect", headers, b"",
  )
  assert_eq(response.status_code.to_int(), 400)
  let body : Json = response.read_body()
  match body {
    Object(obj) => {
      assert_true(obj.get("ok") is Some(False))
      assert_true(
        obj.get("error")
        is Some(
          String(
            "开发模式下不支持升级功能（运行态为 dev，无单文件运行时可替换）"
          )
        ),
      )
    }
    _ => fail("响应应为对象")
  }
  let response = @mocket.dispatch_http(
    app, "POST", "/api/self-update/upload", headers, b"",
  )
  assert_eq(response.status_code.to_int(), 400)
}

///|
async test "upload: inspect 成功回包信息,失败回 400" {
  let dir = @fs.tmpdir(prefix="syncx-mb-api-upload-inspect")
  let inspect : @api.UploadInspectFn = _bytes => {
    let info : @api.InspectedPackage = {
      backend: "rust",
      version: "0.4.9-local.1",
      target: Some("aarch64-apple-darwin"),
      name: None,
    }
    Ok(info)
  }
  let app = @api.build_app(upload_options(dir, inspect=Some(inspect)))
  let headers = auth_headers()
  let response = @mocket.dispatch_http(
    app, "POST", "/api/self-update/upload/inspect", headers, b"fake-bytes",
  )
  assert_eq(response.status_code.to_int(), 200)
  let body : Json = response.read_body()
  match body {
    Object(obj) => {
      assert_true(obj.get("ok") is Some(True))
      assert_true(obj.get("backend") is Some(String("rust")))
      assert_true(obj.get("version") is Some(String("0.4.9-local.1")))
      assert_true(obj.get("target") is Some(String("aarch64-apple-darwin")))
      // current = 当前运行版本,供前端做版本对比
      assert_true(obj.get("current") is Some(String(@core.VERSION)))
    }
    _ => fail("响应应为对象")
  }
  // 识别失败:400 + {ok:false, error}
  let inspect_bad : @api.UploadInspectFn = _bytes => {
    Err("无法识别的安装包")
  }
  let app = @api.build_app(upload_options(dir, inspect=Some(inspect_bad)))
  let response = @mocket.dispatch_http(
    app, "POST", "/api/self-update/upload/inspect", headers, b"junk",
  )
  assert_eq(response.status_code.to_int(), 400)
  let body : Json = response.read_body()
  match body {
    Object(obj) => {
      assert_true(obj.get("ok") is Some(False))
      assert_true(obj.get("error") is Some(String("无法识别的安装包")))
    }
    _ => fail("响应应为对象")
  }
}

///|
async test "upload: 换入成功回 restarting,失败回 400" {
  let dir = @fs.tmpdir(prefix="syncx-mb-api-upload-swap")
  let swap : @api.UploadSwapFn = _bytes => Ok("0.4.9")
  let app = @api.build_app(upload_options(dir, swap=Some(swap)))
  let headers = auth_headers()
  let response = @mocket.dispatch_http(
    app, "POST", "/api/self-update/upload", headers, b"fake-bytes",
  )
  assert_eq(response.status_code.to_int(), 200)
  let body : Json = response.read_body()
  match body {
    Object(obj) => {
      assert_true(obj.get("ok") is Some(True))
      assert_true(obj.get("version") is Some(String("0.4.9")))
      assert_true(obj.get("restarting") is Some(True))
    }
    _ => fail("响应应为对象")
  }
  // 换入失败:400 + {ok:false, error}
  let swap_bad : @api.UploadSwapFn = _bytes => {
    Err("安装包目标平台与本机不符")
  }
  let app = @api.build_app(upload_options(dir, swap=Some(swap_bad)))
  let response = @mocket.dispatch_http(
    app, "POST", "/api/self-update/upload", headers, b"junk",
  )
  assert_eq(response.status_code.to_int(), 400)
  let body : Json = response.read_body()
  match body {
    Object(obj) => {
      assert_true(obj.get("ok") is Some(False))
      assert_true(
        obj.get("error") is Some(String("安装包目标平台与本机不符")),
      )
    }
    _ => fail("响应应为对象")
  }
}
