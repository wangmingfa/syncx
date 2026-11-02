///|
/// 会话票据与登录/登出的行为测试(黑盒):
///   - 与 Node/Rust 的逐字节兼容点用 golden 锁死(scrypt 派生、会话签名);
///   - 登录/登出/令牌登录走 dispatch_http 全链路(中间件 + 路由)。

///|
/// Rust `auth.rs` 同一份 golden:密钥派生 + payload 键序 + base64url 无填充。
async test "会话签名与 Rust 逐字节一致" {
  assert_eq(
    @api.session_secret("base"),
    "8b88f9721be8e1911b857a6bb2496841763f3c0b507456dd6a4dcc408e920740",
  )
  let secret = @api.session_secret("base")
  let payload : @api.SessionPayload = {
    via: "password",
    sub: "u",
    exp: 1_800_000_000_000L,
  }
  assert_eq(
    @api.sign_session(payload, secret),
    "eyJ2aWEiOiJwYXNzd29yZCIsInN1YiI6InUiLCJleHAiOjE4MDAwMDAwMDAwMDB9.6AjgMSI7kLootI7-wfocAL64wI6wiGNTbozNzNRfQRU",
  )
}

///|
/// scrypt 派生与 Node `crypto.scryptSync` 同参数同结果(跨实现 golden,
/// 两端共用 auth.json 的前提)。
async test "scrypt 派生与 Node 逐字节一致" {
  let salt = @lib.hex_to_bytes("00112233445566778899aabbccddeeff")
  let derived = @api.derive_password_hash("hunter2", salt)
  assert_eq(
    @lib.bytes_to_hex(derived),
    "162b9f7f4e53ff947ff972d4f4a1201cc2021a34527f2e93467b96e3b8cfdee440571bb671929b3a71c0aee2cb5e930adb22d758a09eee7b7263e1274f2b4635",
  )
}

///|
async test "票据校验:签发可验、错钥拒绝、过期拒绝" {
  let secret = @api.session_secret("base")
  let payload : @api.SessionPayload = {
    via: "password",
    sub: "u",
    exp: @api.now_ms() + 1_000L,
  }
  let value = @api.sign_session(payload, secret)
  // 正常校验
  match @api.verify_session(value, secret) {
    Some(checked) => {
      assert_eq(checked.via, "password")
      assert_eq(checked.sub, "u")
      assert_eq(checked.exp, payload.exp)
    }
    None => fail("有效票据被拒")
  }
  // 签名密钥不对
  assert_true(@api.verify_session(value, @api.session_secret("other")) is None)
  // 过期即失效
  let expired : @api.SessionPayload = {
    via: "password",
    sub: "u",
    exp: @api.now_ms() - 1L,
  }
  assert_true(
    @api.verify_session(@api.sign_session(expired, secret), secret) is None,
  )
  // 篡改载荷(改 base64 body)必须失效
  let parts = value.split(".").collect()
  assert_eq(parts.length(), 2)
  let tampered = "eyJ2aWEiOiJwYXNzd29yZCIsInN1YiI6Im90aGVyIiwiZXhwIjo5OTk5OTk5OTk5OTk5fQ.\{parts[1].to_owned()}"
  assert_true(@api.verify_session(tampered, secret) is None)
}

///|
/// 写一份合法 auth.json(golden 盐/哈希,密码 = hunter2)。
async fn write_auth_file(dir : String) -> String {
  let file = "\{dir}/auth.json"
  @fs.write_file(
    file,
    "{\"username\":\"u\",\"algo\":\"scrypt\",\"salt\":\"00112233445566778899aabbccddeeff\",\"hash\":\"162b9f7f4e53ff947ff972d4f4a1201cc2021a34527f2e93467b96e3b8cfdee440571bb671929b3a71c0aee2cb5e930adb22d758a09eee7b7263e1274f2b4635\",\"createdAt\":0,\"updatedAt\":0}",
    create_mode=CreateOrTruncate,
  )
  file
}

///|
async test "账号密码登录:成功下发签名 cookie,失败 401" {
  let dir = @fs.tmpdir(prefix="syncx-mb-auth-login")
  let options = @api.ApiOptions::new(
    device_id="TESTDEVICE01",
    control_token="test-token",
    auth_file=Some(write_auth_file(dir)),
    config_file=Some("\{dir}/config.json"),
  )
  let app = @api.build_app(options)
  // 密码正确:200 + Set-Cookie,且 cookie 是签名票据而非 token 原文
  let response = @mocket.dispatch_http(
    app,
    "POST",
    "/api/login",
    {},
    b"{\"username\":\"u\",\"password\":\"hunter2\"}",
  )
  assert_eq(response.status_code.to_int(), 200)
  let cookie = response.headers.get("Set-Cookie").unwrap_or("").to_owned()
  assert_true(cookie.contains("syncx_session="))
  assert_true(!cookie.contains("test-token"))
  assert_true(cookie.contains("HttpOnly"))
  assert_true(cookie.contains("SameSite=Lax"))
  // 取票据值,直接访问受保护路由
  let value = cookie[cookie.find("=").unwrap_or(0) + 1:cookie
  .find(";")
  .unwrap_or(cookie.length())].to_owned()
  let response = @mocket.dispatch_http(
    app,
    "GET",
    "/api/status",
    { "Cookie": "syncx_session=\{value}" },
    b"",
  )
  assert_eq(response.status_code.to_int(), 200)
  // 密码错误:401 + Node 同款文案
  let response = @mocket.dispatch_http(
    app,
    "POST",
    "/api/login",
    {},
    b"{\"username\":\"u\",\"password\":\"wrong\"}",
  )
  assert_eq(response.status_code.to_int(), 401)
  let body : Json = response.read_body()
  assert_true(body is Object(_))
  // 用户名为空:400
  let response = @mocket.dispatch_http(
    app,
    "POST",
    "/api/login",
    {},
    b"{\"username\":\"\",\"password\":\"x\"}",
  )
  assert_eq(response.status_code.to_int(), 400)
}

///|
async test "未启用账号密码登录:/api/login 与 /api/auth 的降级形态" {
  let dir = @fs.tmpdir(prefix="syncx-mb-auth-none")
  let options = @api.ApiOptions::new(
    device_id="TESTDEVICE01",
    control_token="test-token",
    config_file=Some("\{dir}/config.json"),
  )
  let app = @api.build_app(options)
  let response = @mocket.dispatch_http(
    app,
    "POST",
    "/api/login",
    {},
    b"{\"username\":\"u\",\"password\":\"p\"}",
  )
  assert_eq(response.status_code.to_int(), 404)
  let body : Json = response.read_body()
  assert_true(body is Object(_))
  // /api/auth:令牌模式 + passwordLogin:false(登录页据此渲染令牌表单)
  let response = @mocket.dispatch_http(app, "GET", "/api/auth", {}, b"")
  assert_eq(response.status_code.to_int(), 200)
  let body : Json = response.read_body()
  match body {
    Object(obj) => {
      assert_true(obj.get("mode") is Some(String("token")))
      assert_true(obj.get("passwordLogin") is Some(False))
    }
    _ => fail("/api/auth 应回对象")
  }
}

///|
async test "令牌登录 POST /login:302 回 /,失败回页面壳" {
  let dir = @fs.tmpdir(prefix="syncx-mb-auth-token")
  let options = @api.ApiOptions::new(
    device_id="TESTDEVICE01",
    control_token="test-token",
    config_file=Some("\{dir}/config.json"),
  )
  let app = @api.build_app(options)
  // token 正确:302 + 签名 cookie + Location: /
  let response = @mocket.dispatch_http(
    app,
    "POST",
    "/login",
    {},
    b"token=test-token",
  )
  assert_eq(response.status_code.to_int(), 302)
  assert_eq(response.headers.get("Location"), Some("/"))
  let cookie = response.headers.get("Set-Cookie").unwrap_or("").to_owned()
  assert_true(cookie.contains("syncx_session="))
  assert_true(!cookie.contains("test-token"))
  // token 错误:200 回页面壳(不区分错因,防爆破侧信道)
  let response = @mocket.dispatch_http(
    app,
    "POST",
    "/login",
    {},
    b"token=wrong",
  )
  assert_eq(response.status_code.to_int(), 200)
  let body : String = response.read_body()
  assert_true(body.contains("<title>syncx</title>"))
}

///|
async test "登出清 cookie(Max-Age=0)" {
  let dir = @fs.tmpdir(prefix="syncx-mb-auth-logout")
  let options = @api.ApiOptions::new(
    device_id="TESTDEVICE01",
    control_token="test-token",
    config_file=Some("\{dir}/config.json"),
  )
  let app = @api.build_app(options)
  let response = @mocket.dispatch_http(app, "POST", "/api/logout", {}, b"")
  assert_eq(response.status_code.to_int(), 200)
  assert_eq(
    response.headers.get("Set-Cookie"),
    Some("syncx_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"),
  )
  let body : Json = response.read_body()
  match body {
    Object(obj) => assert_true(obj.get("ok") is Some(True))
    _ => fail("logout 应回 {\"ok\":true}")
  }
}
