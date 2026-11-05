///|
/// 目录/设备/暂停/关闭四组路由的行为测试(黑盒,dispatch_http 全链路)。
/// 配置一律指向临时目录,断言「写操作落盘 + 读操作回读」。

///|
/// 临时配置目录:每个用例独享,config.json 初始为空(不存在)。
async fn test_config_dir(tag : String) -> String {
  @fs.tmpdir(prefix="syncx-mb-api-\{tag}")
}

///|
fn options_with(_tag : String, dir : String) -> @api.ApiOptions {
  @api.ApiOptions::new(
    device_id="TESTDEVICE01",
    control_token="test-token",
    config_file=Some("\{dir}/config.json"),
  )
}

///|
async test "POST /api/folders:新目录 201 落盘,重复路径合并设备" {
  let dir = test_config_dir("folders")
  let options = options_with("folders", dir)
  let app = @api.build_app(options)
  let secret = @api.session_secret("test-token")
  let ticket = @api.sign_session(
    { via: "token", sub: "token", exp: @api.now_ms() + 60_000L, },
    secret,
  )
  let headers : Map[@http.CaseInsensitiveString, StringView] = {
    "Cookie": "syncx_session=\{ticket}",
  }
  // 新目录:201 + created:true
  let response = @mocket.dispatch_http(
    app, "POST", "/api/folders", headers, b"{\"path\":\"/tmp/syncx-mb-api-photos\",\"devices\":[\"DEV2\",\"DEV3\"],\"receiveOnly\":true}",
  )
  assert_eq(response.status_code.to_int(), 201)
  let body : Json = response.read_body()
  match body {
    Object(obj) => {
      assert_true(obj.get("ok") is Some(True))
      assert_true(obj.get("created") is Some(True))
    }
    _ => fail("响应应为对象")
  }
  // config.json:字段名与 Node/Rust 逐字对齐
  let raw = @fs.read_file("\{dir}/config.json").text()
  let config = @json.parse(raw)
  assert_true(config is Object(_))
  let saved = @api.load_config("\{dir}/config.json")
  assert_eq(saved.shared_folders.length(), 1)
  let folder = saved.shared_folders[0]
  assert_eq(folder.path, "/tmp/syncx-mb-api-photos")
  assert_eq(folder.devices, ["DEV2", "DEV3"])
  assert_true(folder.receive_only is Some(true))
  // id 自动生成且非空
  assert_true(folder.id is Some(_))
  // generatedBy / formatVersion 戳
  assert_true(saved.generated_by is Some(_))
  assert_eq(saved.format_version, @core.FORMAT_VERSION)
  // 同路径再提交:created:false,设备合并去重
  let response = @mocket.dispatch_http(
    app, "POST", "/api/folders", headers, b"{\"path\":\"/tmp/syncx-mb-api-photos\",\"devices\":[\"DEV3\",\"DEV4\"]}",
  )
  assert_eq(response.status_code.to_int(), 201)
  let body : Json = response.read_body()
  match body {
    Object(obj) => assert_true(obj.get("created") is Some(False))
    _ => fail("响应应为对象")
  }
  let merged = @api.load_config("\{dir}/config.json")
  assert_eq(merged.shared_folders.length(), 1)
  assert_eq(merged.shared_folders[0].devices, ["DEV2", "DEV3", "DEV4"])
  // 同路径不同 id:矛盾请求拒绝
  let response = @mocket.dispatch_http(
    app, "POST", "/api/folders", headers, b"{\"path\":\"/tmp/syncx-mb-api-photos\",\"id\":\"another-id\"}",
  )
  assert_eq(response.status_code.to_int(), 400)
}

///|
async test "POST /api/folders:缺 path 与非法 JSON 回 400" {
  let dir = test_config_dir("folders-bad")
  let app = @api.build_app(options_with("folders-bad", dir))
  let secret = @api.session_secret("test-token")
  let ticket = @api.sign_session(
    { via: "token", sub: "token", exp: @api.now_ms() + 60_000L, },
    secret,
  )
  let headers : Map[@http.CaseInsensitiveString, StringView] = {
    "Cookie": "syncx_session=\{ticket}",
  }
  // 缺 path
  let response = @mocket.dispatch_http(
    app, "POST", "/api/folders", headers, b"{}",
  )
  assert_eq(response.status_code.to_int(), 400)
  let body : Json = response.read_body()
  match body {
    Object(obj) =>
      assert_true(obj.get("error") is Some(String("path is required")))
    _ => fail("响应应为对象")
  }
  // 非法 JSON
  let response = @mocket.dispatch_http(
    app, "POST", "/api/folders", headers, b"not-json",
  )
  assert_eq(response.status_code.to_int(), 400)
}

///|
async test "GET /api/folders:回读目录列表,字段与 config.json 一致" {
  let dir = test_config_dir("folders-get")
  // 直接铺一份带未知键的 config.json(未知键必须原样保留)
  @fs.write_file(
    "\{dir}/config.json",
    "{\"sharedFolders\":[{\"path\":\"/tmp/syncx-mb-api-docs\",\"id\":\"docs\",\"futureKey\":42}],\"formatVersion\":1}",
    create_mode=CreateOrTruncate,
  )
  let app = @api.build_app(options_with("folders-get", dir))
  let secret = @api.session_secret("test-token")
  let ticket = @api.sign_session(
    { via: "token", sub: "token", exp: @api.now_ms() + 60_000L, },
    secret,
  )
  let response = @mocket.dispatch_http(
    app,
    "GET",
    "/api/folders",
    { "Cookie": "syncx_session=\{ticket}" },
    b"",
  )
  assert_eq(response.status_code.to_int(), 200)
  let body : Json = response.read_body()
  match body {
    Object(obj) => {
      assert_true(obj.get("ok") is Some(True))
      match obj.get("folders") {
        Some(Array(items)) => {
          assert_eq(items.length(), 1)
          match items[0] {
            Object(folder) => {
              assert_true(
                folder.get("path") is Some(String("/tmp/syncx-mb-api-docs")),
              )
              // 未知键原样透出
              assert_true(folder.get("futureKey") is Some(Number(42.0, ..)))
            }
            _ => fail("folders[0] 应为对象")
          }
        }
        _ => fail("folders 应为数组")
      }
    }
    _ => fail("响应应为对象")
  }
}

///|
async test "POST /api/pause:一律落盘字面量(取消写 false 不删键)" {
  let dir = test_config_dir("pause")
  let app = @api.build_app(options_with("pause", dir))
  let secret = @api.session_secret("test-token")
  let ticket = @api.sign_session(
    { via: "token", sub: "token", exp: @api.now_ms() + 60_000L, },
    secret,
  )
  let headers : Map[@http.CaseInsensitiveString, StringView] = {
    "Cookie": "syncx_session=\{ticket}",
  }
  // 暂停:写 true
  let response = @mocket.dispatch_http(
    app, "POST", "/api/pause", headers, b"{\"paused\":true}",
  )
  assert_eq(response.status_code.to_int(), 200)
  let paused = @api.load_config("\{dir}/config.json")
  assert_true(paused.paused is Some(true))
  // 恢复:写 false(不是删键)
  let response = @mocket.dispatch_http(
    app, "POST", "/api/pause", headers, b"{\"paused\":false}",
  )
  assert_eq(response.status_code.to_int(), 200)
  // 落盘的是字面量 false(core 的内存模型只保留 true,这里直接看盘面)
  let resumed = @json.parse(@fs.read_file("\{dir}/config.json").text())
  match resumed {
    Object(obj) => assert_true(obj.get("paused") is Some(False))
    _ => fail("config.json 应为对象")
  }
  // 缺 paused:按 false 处理(Node `=== true` 同口径)
  let response = @mocket.dispatch_http(
    app, "POST", "/api/pause", headers, b"{}",
  )
  assert_eq(response.status_code.to_int(), 200)
}

///|
async test "GET /api/devices:回读 knownDevices" {
  let dir = test_config_dir("devices")
  @fs.write_file(
    "\{dir}/config.json",
    "{\"knownDevices\":[{\"id\":\"DEV2\",\"name\":\"laptop\",\"futureKey\":true}],\"formatVersion\":1}",
    create_mode=CreateOrTruncate,
  )
  let app = @api.build_app(options_with("devices", dir))
  let secret = @api.session_secret("test-token")
  let ticket = @api.sign_session(
    { via: "token", sub: "token", exp: @api.now_ms() + 60_000L, },
    secret,
  )
  let response = @mocket.dispatch_http(
    app,
    "GET",
    "/api/devices",
    { "Cookie": "syncx_session=\{ticket}" },
    b"",
  )
  assert_eq(response.status_code.to_int(), 200)
  let body : Json = response.read_body()
  match body {
    Object(obj) => {
      assert_true(obj.get("ok") is Some(True))
      match obj.get("devices") {
        Some(Array(items)) => {
          assert_eq(items.length(), 1)
          match items[0] {
            Object(device) => {
              assert_true(device.get("id") is Some(String("DEV2")))
              assert_true(device.get("name") is Some(String("laptop")))
              assert_true(device.get("futureKey") is Some(True))
            }
            _ => fail("devices[0] 应为对象")
          }
        }
        _ => fail("devices 应为数组")
      }
    }
    _ => fail("响应应为对象")
  }
}

///|
async test "POST /api/devices:400 校验、201 登记、幂等、地址登记口径" {
  let dir = test_config_dir("devices-post")
  let app = @api.build_app(options_with("devices-post", dir))
  let secret = @api.session_secret("test-token")
  let ticket = @api.sign_session(
    { via: "token", sub: "token", exp: @api.now_ms() + 60_000L, },
    secret,
  )
  let headers : Map[@http.CaseInsensitiveString, StringView] = {
    "Cookie": "syncx_session=\{ticket}",
  }
  // 未认证:认证门拦截
  let response = @mocket.dispatch_http(app, "POST", "/api/devices", {}, b"{}")
  assert_eq(response.status_code.to_int(), 401)
  // 缺 deviceId → 400 + Node 同款文案
  let response = @mocket.dispatch_http(
    app, "POST", "/api/devices", headers, b"{}",
  )
  assert_eq(response.status_code.to_int(), 400)
  let body : Json = response.read_body()
  match body {
    Object(obj) =>
      assert_true(obj.get("error") is Some(String("deviceId is required")))
    _ => fail("响应应为对象")
  }
  // deviceId 非字符串 → 同样 400
  let response = @mocket.dispatch_http(
    app, "POST", "/api/devices", headers, b"{\"deviceId\":42}",
  )
  assert_eq(response.status_code.to_int(), 400)
  // 成功:201 + ok:true,列表出现该设备
  let response = @mocket.dispatch_http(
    app, "POST", "/api/devices", headers, b"{\"deviceId\":\"DEV2\"}",
  )
  assert_eq(response.status_code.to_int(), 201)
  let body : Json = response.read_body()
  match body {
    Object(obj) => assert_true(obj.get("ok") is Some(True))
    _ => fail("响应应为对象")
  }
  let saved = @api.load_config("\{dir}/config.json")
  assert_eq(saved.known_devices.length(), 1)
  assert_eq(saved.known_devices[0].id, "DEV2")
  // 再 POST 同一设备:幂等不重复
  let response = @mocket.dispatch_http(
    app, "POST", "/api/devices", headers, b"{\"deviceId\":\"DEV2\"}",
  )
  assert_eq(response.status_code.to_int(), 201)
  let idempotent = @api.load_config("\{dir}/config.json")
  assert_eq(idempotent.known_devices.length(), 1)
  // 非法 address(缺 ws:// 前缀):响应仍 201,peers 不变
  let response = @mocket.dispatch_http(
    app, "POST", "/api/devices", headers, b"{\"deviceId\":\"DEV3\",\"address\":\"10.0.0.9:22000\"}",
  )
  assert_eq(response.status_code.to_int(), 201)
  let no_peer = @api.load_config("\{dir}/config.json")
  assert_eq(no_peer.known_devices.length(), 2)
  assert_eq(no_peer.peers.length(), 0)
  // 合法 ws:// address:落进 peers,且 ::ffff: 前缀被规范化剥离
  let response = @mocket.dispatch_http(
    app, "POST", "/api/devices", headers, b"{\"deviceId\":\"DEV3\",\"address\":\"ws://[::ffff:10.0.0.9]:22000\"}",
  )
  assert_eq(response.status_code.to_int(), 201)
  let with_peer = @api.load_config("\{dir}/config.json")
  assert_eq(with_peer.peers, ["ws://10.0.0.9:22000"])
  // 再登记同地址(大小写不敏感前缀 + host 小写):幂等,peers 不重复
  let response = @mocket.dispatch_http(
    app, "POST", "/api/devices", headers, b"{\"deviceId\":\"DEV4\",\"address\":\"WS://10.0.0.9:22000\"}",
  )
  assert_eq(response.status_code.to_int(), 201)
  let deduped = @api.load_config("\{dir}/config.json")
  assert_eq(deduped.peers, ["ws://10.0.0.9:22000"])
}

///|
async test "DELETE /api/devices:knownDevices 与目录 devices 联动摘除,幂等" {
  let dir = test_config_dir("devices-delete")
  // 预置:两个已知设备;目录 A 的 devices 含目标设备,目录 B 不含
  @fs.write_file(
    "\{dir}/config.json",
    "{\"knownDevices\":[{\"id\":\"DEV2\"},{\"id\":\"DEV3\"}],\"sharedFolders\":[{\"path\":\"/data/a\",\"id\":\"a\",\"devices\":[\"DEV2\",\"DEV3\",\"DEV9\"]},{\"path\":\"/data/b\",\"id\":\"b\",\"devices\":[\"DEV3\"]}],\"formatVersion\":1}",
    create_mode=CreateOrTruncate,
  )
  let app = @api.build_app(options_with("devices-delete", dir))
  let secret = @api.session_secret("test-token")
  let ticket = @api.sign_session(
    { via: "token", sub: "token", exp: @api.now_ms() + 60_000L, },
    secret,
  )
  let headers : Map[@http.CaseInsensitiveString, StringView] = {
    "Cookie": "syncx_session=\{ticket}",
  }
  // 缺参 → 400 + Node 同款文案
  let response = @mocket.dispatch_http(
    app, "DELETE", "/api/devices", headers, b"",
  )
  assert_eq(response.status_code.to_int(), 400)
  let body : Json = response.read_body()
  match body {
    Object(obj) =>
      assert_true(obj.get("error") is Some(String("deviceId is required")))
    _ => fail("响应应为对象")
  }
  // 空串参数同样 400(Node `if (!deviceId)` 同口径)
  let response = @mocket.dispatch_http(
    app, "DELETE", "/api/devices?deviceId=", headers, b"",
  )
  assert_eq(response.status_code.to_int(), 400)
  // 正常移除:200 + ok:true
  let response = @mocket.dispatch_http(
    app, "DELETE", "/api/devices?deviceId=DEV2", headers, b"",
  )
  assert_eq(response.status_code.to_int(), 200)
  let body : Json = response.read_body()
  match body {
    Object(obj) => assert_true(obj.get("ok") is Some(True))
    _ => fail("响应应为对象")
  }
  // 联动断言:knownDevices 摘除,目录 A 的 devices 同步摘除,目录 B 不受影响
  let saved = @api.load_config("\{dir}/config.json")
  assert_eq(saved.known_devices.length(), 1)
  assert_eq(saved.known_devices[0].id, "DEV3")
  assert_eq(saved.shared_folders[0].devices, ["DEV3", "DEV9"])
  assert_eq(saved.shared_folders[1].devices, ["DEV3"])
  // 设备已不存在:仍 200(幂等)
  let response = @mocket.dispatch_http(
    app, "DELETE", "/api/devices?deviceId=DEV2", headers, b"",
  )
  assert_eq(response.status_code.to_int(), 200)
}

///|
async test "POST /api/shutdown:有回调回 ok,无回调回 503" {
  // 无回调:503 + Node 同款文案
  let dir = test_config_dir("shutdown-none")
  let app = @api.build_app(options_with("shutdown-none", dir))
  let secret = @api.session_secret("test-token")
  let ticket = @api.sign_session(
    { via: "token", sub: "token", exp: @api.now_ms() + 60_000L, },
    secret,
  )
  let response = @mocket.dispatch_http(
    app,
    "POST",
    "/api/shutdown",
    { "Cookie": "syncx_session=\{ticket}" },
    b"",
  )
  assert_eq(response.status_code.to_int(), 503)
  let body : Json = response.read_body()
  match body {
    Object(obj) =>
      assert_true(obj.get("error") is Some(String("shutdown not available")))
    _ => fail("响应应为对象")
  }
  // 有回调:ok:true + msg,且回调确实被调
  let dir = test_config_dir("shutdown")
  let flags : Array[Bool] = []
  let options = @api.ApiOptions::new(
    device_id="TESTDEVICE01",
    control_token="test-token",
    config_file=Some("\{dir}/config.json"),
    on_shutdown=Some(fn() { flags.push(true) }),
  )
  let app = @api.build_app(options)
  let response = @mocket.dispatch_http(
    app,
    "POST",
    "/api/shutdown",
    { "Cookie": "syncx_session=\{ticket}" },
    b"",
  )
  assert_eq(response.status_code.to_int(), 200)
  let body : Json = response.read_body()
  match body {
    Object(obj) => {
      assert_true(obj.get("ok") is Some(True))
      assert_true(obj.get("msg") is Some(String("shutting down")))
    }
    _ => fail("响应应为对象")
  }
  assert_eq(flags.length(), 1)
}

///|
async test "POST /api/folders/git-strip-co-authored:开/关落盘与 400 校验" {
  let dir = test_config_dir("git-strip")
  // 预置两份目录:一份 id 显式 + 未知键,另一份无 id(定位走 path 回退)
  @fs.write_file(
    "\{dir}/config.json",
    "{\"sharedFolders\":[{\"path\":\"/data/repo\",\"id\":\"repo-1\",\"gitSync\":\"full\",\"futureKey\":1},{\"path\":\"/data/other\"}],\"formatVersion\":1}",
    create_mode=CreateOrTruncate,
  )
  let app = @api.build_app(options_with("git-strip", dir))
  let secret = @api.session_secret("test-token")
  let ticket = @api.sign_session(
    { via: "token", sub: "token", exp: @api.now_ms() + 60_000L, },
    secret,
  )
  let headers : Map[@http.CaseInsensitiveString, StringView] = {
    "Cookie": "syncx_session=\{ticket}",
  }
  // 开启:200 + ok:true,目标目录落盘 true,其余目录不受影响
  let response = @mocket.dispatch_http(
    app, "POST", "/api/folders/git-strip-co-authored", headers, b"{\"folderId\":\"repo-1\",\"on\":true}",
  )
  assert_eq(response.status_code.to_int(), 200)
  let body : Json = response.read_body()
  match body {
    Object(obj) => assert_true(obj.get("ok") is Some(True))
    _ => fail("响应应为对象")
  }
  let saved = @api.load_config("\{dir}/config.json")
  assert_eq(saved.shared_folders.length(), 2)
  assert_eq(saved.shared_folders[0].strip_co_authored, Some(true))
  assert_eq(saved.shared_folders[0].git_sync, Some("full"))
  assert_eq(saved.shared_folders[1].strip_co_authored, None)
  // 落盘字段名与契约逐字一致,未知键照常保留
  let raw = @fs.read_file("\{dir}/config.json").text()
  assert_true(raw.contains("\"gitStripCoAuthored\":true"))
  assert_true(raw.contains("futureKey"))
  // 关闭:回到缺省形态(不落 false 痕迹)
  let response = @mocket.dispatch_http(
    app, "POST", "/api/folders/git-strip-co-authored", headers, b"{\"folderId\":\"repo-1\",\"on\":false}",
  )
  assert_eq(response.status_code.to_int(), 200)
  let off = @api.load_config("\{dir}/config.json")
  assert_eq(off.shared_folders[0].strip_co_authored, None)
  assert_false(
    @fs.read_file("\{dir}/config.json").text().contains("gitStripCoAuthored"),
  )
  // folderId 缺省回退 path:按 path 也能定位
  let response = @mocket.dispatch_http(
    app, "POST", "/api/folders/git-strip-co-authored", headers, b"{\"folderId\":\"/data/other\",\"on\":true}",
  )
  assert_eq(response.status_code.to_int(), 200)
  let by_path = @api.load_config("\{dir}/config.json")
  assert_eq(by_path.shared_folders[1].strip_co_authored, Some(true))
  // 未知目录:400 + Node 同款文案
  let response = @mocket.dispatch_http(
    app, "POST", "/api/folders/git-strip-co-authored", headers, b"{\"folderId\":\"no-such\",\"on\":true}",
  )
  assert_eq(response.status_code.to_int(), 400)
  let body : Json = response.read_body()
  match body {
    Object(obj) =>
      assert_true(
        obj.get("error") is Some(String("未找到共享目录:「no-such」")),
      )
    _ => fail("响应应为对象")
  }
  // 缺 folderId:on 非布尔:均 400
  let response = @mocket.dispatch_http(
    app, "POST", "/api/folders/git-strip-co-authored", headers, b"{\"on\":true}",
  )
  assert_eq(response.status_code.to_int(), 400)
  let body : Json = response.read_body()
  match body {
    Object(obj) =>
      assert_true(obj.get("error") is Some(String("folderId is required")))
    _ => fail("响应应为对象")
  }
  let response = @mocket.dispatch_http(
    app, "POST", "/api/folders/git-strip-co-authored", headers, b"{\"folderId\":\"repo-1\",\"on\":\"yes\"}",
  )
  assert_eq(response.status_code.to_int(), 400)
  let body : Json = response.read_body()
  match body {
    Object(obj) =>
      assert_true(obj.get("error") is Some(String("on must be a boolean")))
    _ => fail("响应应为对象")
  }
}

///|
async test "POST /api/folders/schedule:旧字符串归一化落盘,null 清除,400 校验" {
  let dir = test_config_dir("folderschedule")
  let app = @api.build_app(options_with("folderschedule", dir))
  let secret = @api.session_secret("test-token")
  let ticket = @api.sign_session(
    { via: "token", sub: "token", exp: @api.now_ms() + 60_000L, },
    secret,
  )
  let headers : Map[@http.CaseInsensitiveString, StringView] = {
    "Cookie": "syncx_session=\{ticket}",
  }
  // 先建一个目录
  let response = @mocket.dispatch_http(
    app, "POST", "/api/folders", headers, b"{\"path\":\"/tmp/syncx-mb-api-sched\"}",
  )
  assert_eq(response.status_code.to_int(), 201)
  // 旧 HH:MM-HH:MM 字符串 → 归一化数组形态落盘(与 Node 同款);
  // folderId 用自动生成的 id(与 Node folderIdFor:f.id ?? f.path 同口径)
  let saved0 = @api.load_config("\{dir}/config.json")
  let folder_id = saved0.shared_folders[0].id.unwrap()
  let response = @mocket.dispatch_http(
    app,
    "POST",
    "/api/folders/schedule",
    headers,
    @utf8.encode(
      "{\"folderId\":\"" + folder_id + "\",\"schedule\":\"22:00-08:00\"}",
    ),
  )
  assert_eq(response.status_code.to_int(), 200)
  let saved = @api.load_config("\{dir}/config.json")
  let folder = saved.shared_folders[0]
  match folder.schedule {
    Some(Array(rules)) => assert_eq(rules.length(), 1)
    _ => fail("schedule 应为归一化数组")
  }
  // null = 清除
  let response = @mocket.dispatch_http(
    app,
    "POST",
    "/api/folders/schedule",
    headers,
    @utf8.encode("{\"folderId\":\"" + folder_id + "\",\"schedule\":null}"),
  )
  assert_eq(response.status_code.to_int(), 200)
  let saved = @api.load_config("\{dir}/config.json")
  assert_true(saved.shared_folders[0].schedule is None)
  // 类型不合法:400
  let response = @mocket.dispatch_http(
    app,
    "POST",
    "/api/folders/schedule",
    headers,
    @utf8.encode("{\"folderId\":\"" + folder_id + "\",\"schedule\":true}"),
  )
  assert_eq(response.status_code.to_int(), 400)
  // 目录不存在:400(与 Node「未找到共享目录」同文案口径)
  let response = @mocket.dispatch_http(
    app, "POST", "/api/folders/schedule", headers, b"{\"folderId\":\"nope\",\"schedule\":\"09:00-18:00\"}",
  )
  assert_eq(response.status_code.to_int(), 400)
}

///|
async test "POST /api/schedule/override:落盘到期时刻,minutes<=0 取消" {
  let dir = test_config_dir("schedoverride")
  let app = @api.build_app(options_with("schedoverride", dir))
  let secret = @api.session_secret("test-token")
  let ticket = @api.sign_session(
    { via: "token", sub: "token", exp: @api.now_ms() + 60_000L, },
    secret,
  )
  let headers : Map[@http.CaseInsensitiveString, StringView] = {
    "Cookie": "syncx_session=\{ticket}",
  }
  // 放行 30 分钟:回包带 until,落盘同一时刻
  let before = @api.now_ms()
  let response = @mocket.dispatch_http(
    app, "POST", "/api/schedule/override", headers, b"{\"minutes\":30}",
  )
  assert_eq(response.status_code.to_int(), 200)
  let body : Json = response.read_body()
  let until : Int64 = match body {
    Object(obj) =>
      match obj.get("until") {
        Some(Number(n, ..)) => n.to_int64()
        _ => fail("应带 until")
      }
    _ => fail("响应应为对象")
  }
  assert_true(until > before)
  assert_true(until - before <= 31 * 60_000L)
  let saved = @api.load_config("\{dir}/config.json")
  assert_eq(saved.schedule_override_until, Some(until))
  // 上限 24 小时:minutes 超限截断
  let response = @mocket.dispatch_http(
    app, "POST", "/api/schedule/override", headers, b"{\"minutes\":99999}",
  )
  assert_eq(response.status_code.to_int(), 200)
  let body : Json = response.read_body()
  let capped : Int64 = match body {
    Object(obj) =>
      match obj.get("until") {
        Some(Number(n, ..)) => n.to_int64()
        _ => fail("应带 until")
      }
    _ => fail("响应应为对象")
  }
  assert_true(capped - @api.now_ms() <= 24 * 60 * 60_000L)
  // minutes <= 0:取消(回包不带 until,落盘清零)
  let response = @mocket.dispatch_http(
    app, "POST", "/api/schedule/override", headers, b"{\"minutes\":0}",
  )
  assert_eq(response.status_code.to_int(), 200)
  let body : Json = response.read_body()
  match body {
    Object(obj) => assert_true(obj.get("until") is None)
    _ => fail("响应应为对象")
  }
  let saved = @api.load_config("\{dir}/config.json")
  assert_true(saved.schedule_override_until is None)
  // 非数字:400
  let response = @mocket.dispatch_http(
    app, "POST", "/api/schedule/override", headers, b"{\"minutes\":\"soon\"}",
  )
  assert_eq(response.status_code.to_int(), 400)
}

///|
/// Git 数据面夹具:真 git 仓库(根提交 a.txt)+ 未跟踪文件;返回 (仓库路径, 会话头)。
async fn git_repo_fixture(tag : String) -> String {
  let repo = "/tmp/syncx-mb-api-gitrepo-\{tag}-\{@api.now_ms()}"
  @fs.mkdir(repo, recursive=true, allow_exist=true)
  let code = @process.run(
    "git",
    ["init", "-q"],
    cwd=repo,
    no_console_window=true,
  )
  assert_eq(code, 0)
  let _ = @process.run(
    "git",
    ["config", "user.name", "syncx-test"],
    cwd=repo,
    no_console_window=true,
  )
  let _ = @process.run(
    "git",
    ["config", "user.email", "t@example.com"],
    cwd=repo,
    no_console_window=true,
  )
  @fs.write_file("\{repo}/a.txt", "v1")
  let _ = @process.run(
    "git",
    ["add", "a.txt"],
    cwd=repo,
    no_console_window=true,
  )
  let _ = @process.run(
    "git",
    ["commit", "-q", "-m", "init"],
    cwd=repo,
    no_console_window=true,
  )
  @fs.write_file("\{repo}/new.txt", "untracked")
  repo
}

///|
async test "Git 数据面:改动/历史/提交文件/对比/未推送/推送 全链路" {
  let dir = test_config_dir("gitdata")
  let app = @api.build_app(options_with("gitdata", dir))
  let secret = @api.session_secret("test-token")
  let ticket = @api.sign_session(
    { via: "token", sub: "token", exp: @api.now_ms() + 60_000L, },
    secret,
  )
  let headers : Map[@http.CaseInsensitiveString, StringView] = {
    "Cookie": "syncx_session=\{ticket}",
  }
  let repo = git_repo_fixture("gd")
  // 登记共享目录
  let body = @utf8.encode("{\"path\":\"" + repo + "\"}")
  let response = @mocket.dispatch_http(
    app, "POST", "/api/folders", headers, body,
  )
  assert_eq(response.status_code.to_int(), 201)
  let saved = @api.load_config("\{dir}/config.json")
  let folder_id = saved.shared_folders[0].id.unwrap()
  // 改动清单:未跟踪一条 added;非仓库目录 → gitRepo:false
  let response = @mocket.dispatch_http(
    app,
    "GET",
    "/api/folders/git-changes?folderId=\{folder_id}",
    headers,
    b"",
  )
  assert_eq(response.status_code.to_int(), 200)
  let data : Json = response.read_body()
  match data {
    Object(obj) => assert_true(obj.get("gitRepo") is None)
    _ => fail("应为对象")
  }
  // 提交历史:1 笔 + gitRepo:true;非法 limit 400
  let response = @mocket.dispatch_http(
    app,
    "GET",
    "/api/folders/git-log?folderId=\{folder_id}",
    headers,
    b"",
  )
  assert_eq(response.status_code.to_int(), 200)
  let data : Json = response.read_body()
  match data {
    Object(obj) => {
      assert_true(obj.get("gitRepo") is Some(True))
      match obj.get("commits") {
        Some(Array(items)) => assert_eq(items.length(), 1)
        _ => fail("应有提交")
      }
    }
    _ => fail("应为对象")
  }
  let response = @mocket.dispatch_http(
    app,
    "GET",
    "/api/folders/git-log?folderId=\{folder_id}&limit=0",
    headers,
    b"",
  )
  assert_eq(response.status_code.to_int(), 400)
  // 提交文件清单:根提交全是 A;非法哈希 400
  let root = @daemon.get_last_commit_hash(repo).unwrap()
  let response = @mocket.dispatch_http(
    app,
    "GET",
    "/api/folders/git-commit-files?folderId=\{folder_id}&hash=\{root}",
    headers,
    b"",
  )
  assert_eq(response.status_code.to_int(), 200)
  let data : Json = response.read_body()
  match data {
    Object(obj) =>
      match obj.get("files") {
        Some(Array(items)) => assert_eq(items.length(), 1)
        _ => fail("应有文件")
      }
    _ => fail("应为对象")
  }
  let response = @mocket.dispatch_http(
    app,
    "GET",
    "/api/folders/git-commit-files?folderId=\{folder_id}&hash=-evil",
    headers,
    b"",
  )
  assert_eq(response.status_code.to_int(), 400)
  // 提交对比:根提交的父侧不存在,提交侧是文本 v1
  let response = @mocket.dispatch_http(
    app,
    "GET",
    "/api/folders/git-commit-diff?folderId=\{folder_id}&hash=\{root}&path=a.txt",
    headers,
    b"",
  )
  assert_eq(response.status_code.to_int(), 200)
  let data : Json = response.read_body()
  match data {
    Object(obj) => {
      match obj.get("parent") {
        Some(Object(p)) => assert_true(p.get("exists") is Some(False))
        _ => fail("应有 parent 侧")
      }
      match obj.get("commit") {
        Some(Object(c)) => assert_eq(c.get("text"), Some(Json::string("v1")))
        _ => fail("应有 commit 侧")
      }
    }
    _ => fail("应为对象")
  }
  // 工作区对比:HEAD 侧 v1;盘上被改后 worktree 侧 v2
  @fs.write_file("\{repo}/a.txt", "v2")
  let response = @mocket.dispatch_http(
    app,
    "GET",
    "/api/folders/git-diff?folderId=\{folder_id}&path=a.txt",
    headers,
    b"",
  )
  assert_eq(response.status_code.to_int(), 200)
  let data : Json = response.read_body()
  match data {
    Object(obj) => {
      match obj.get("head") {
        Some(Object(h)) => assert_eq(h.get("text"), Some(Json::string("v1")))
        _ => fail("应有 head 侧")
      }
      match obj.get("worktree") {
        Some(Object(w)) => assert_eq(w.get("text"), Some(Json::string("v2")))
        _ => fail("应有 worktree 侧")
      }
    }
    _ => fail("应为对象")
  }
  // 未推送:无上游 → 空列表
  let response = @mocket.dispatch_http(
    app, "GET", "/api/folders/git-unpushed", headers, b"",
  )
  assert_eq(response.status_code.to_int(), 200)
  let data : Json = response.read_body()
  match data {
    Object(obj) =>
      match obj.get("folders") {
        Some(Array(items)) => assert_eq(items.length(), 0)
        _ => fail("应有 folders")
      }
    _ => fail("应为对象")
  }
  // 推送:无上游 → 200 {ok:false, error};非法目录 → 400
  let response = @mocket.dispatch_http(
    app,
    "POST",
    "/api/folders/git-push",
    headers,
    @utf8.encode("{\"folderId\":\"" + folder_id + "\"}"),
  )
  assert_eq(response.status_code.to_int(), 200)
  let data : Json = response.read_body()
  match data {
    Object(obj) => assert_true(obj.get("ok") is Some(False))
    _ => fail("应为对象")
  }
  let response = @mocket.dispatch_http(
    app, "POST", "/api/folders/git-push", headers, b"{\"folderId\":\"nope\"}",
  )
  assert_eq(response.status_code.to_int(), 400)
}

///|
async test "Git 剔除路由:剔除成功落新链,脏工作区与缺上游 400" {
  let dir = test_config_dir("gitstrip")
  let app = @api.build_app(options_with("gitstrip", dir))
  let secret = @api.session_secret("test-token")
  let ticket = @api.sign_session(
    { via: "token", sub: "token", exp: @api.now_ms() + 60_000L, },
    secret,
  )
  let headers : Map[@http.CaseInsensitiveString, StringView] = {
    "Cookie": "syncx_session=\{ticket}",
  }
  // 带上游的仓库:推送一笔干净提交,再攒一笔带尾注的未推送提交
  let base = "/tmp/syncx-mb-api-gitstrip-\{@api.now_ms()}"
  @fs.mkdir(base, recursive=true, allow_exist=true)
  let origin = "\{base}/origin.git"
  assert_eq(
    @process.run(
      "git",
      ["init", "-q", "--bare", origin],
      no_console_window=true,
    ),
    0,
  )
  let repo = "\{base}/work"
  assert_eq(
    @process.run("git", ["clone", "-q", origin, repo], no_console_window=true),
    0,
  )
  let _ = @process.run(
    "git",
    ["config", "user.name", "syncx-test"],
    cwd=repo,
    no_console_window=true,
  )
  let _ = @process.run(
    "git",
    ["config", "user.email", "t@example.com"],
    cwd=repo,
    no_console_window=true,
  )
  @fs.write_file("\{repo}/a.txt", "v1")
  let _ = @process.run(
    "git",
    ["add", "a.txt"],
    cwd=repo,
    no_console_window=true,
  )
  let _ = @process.run(
    "git",
    ["commit", "-q", "-m", "feat: a"],
    cwd=repo,
    no_console_window=true,
  )
  let _ = @process.run(
    "git",
    ["push", "-q", "-u", "origin", "HEAD"],
    cwd=repo,
    no_console_window=true,
  )
  @fs.write_file("\{repo}/b.txt", "v1")
  let _ = @process.run(
    "git",
    ["add", "b.txt"],
    cwd=repo,
    no_console_window=true,
  )
  let _ = @process.run(
    "git",
    ["commit", "-q", "-m", "feat: b\n\nCo-Authored-By: MOSS <moss@example.com>"],
    cwd=repo,
    no_console_window=true,
  )
  // 登记共享目录
  let body = @utf8.encode("{\"path\":\"" + repo + "\"}")
  let response = @mocket.dispatch_http(
    app, "POST", "/api/folders", headers, body,
  )
  assert_eq(response.status_code.to_int(), 201)
  let saved = @api.load_config("\{dir}/config.json")
  let folder_id = saved.shared_folders[0].id.unwrap()
  // 缺上游的目录:400 结构性不可用
  let plain_repo = git_repo_fixture("strip-plain")
  let body = @utf8.encode("{\"path\":\"" + plain_repo + "\"}")
  let response = @mocket.dispatch_http(
    app, "POST", "/api/folders", headers, body,
  )
  assert_eq(response.status_code.to_int(), 201)
  let saved = @api.load_config("\{dir}/config.json")
  let plain_id = saved.shared_folders[1].id.unwrap()
  let response = @mocket.dispatch_http(
    app,
    "POST",
    "/api/folders/git-strip-coauthored-unpushed",
    headers,
    @utf8.encode("{\"folderId\":\"" + plain_id + "\"}"),
  )
  assert_eq(response.status_code.to_int(), 400)
  // 剔除成功:1/1,落新链后消息不带尾注
  let response = @mocket.dispatch_http(
    app,
    "POST",
    "/api/folders/git-strip-coauthored-unpushed",
    headers,
    @utf8.encode("{\"folderId\":\"" + folder_id + "\"}"),
  )
  assert_eq(response.status_code.to_int(), 200)
  let data : Json = response.read_body()
  match data {
    Object(obj) => {
      assert_true(obj.get("ok") is Some(True))
      assert_eq(obj.get("stripped"), Some(Json::number(1)))
      assert_eq(obj.get("rewritten"), Some(Json::number(1)))
    }
    _ => fail("应为对象")
  }
  // 未推送列表还在(个数不变),subject 相同且不再带尾注
  let response = @mocket.dispatch_http(
    app,
    "GET",
    "/api/folders/git-unpushed?folderId=\{folder_id}",
    headers,
    b"",
  )
  assert_eq(response.status_code.to_int(), 200)
  let data : Json = response.read_body()
  match data {
    Object(obj) =>
      match obj.get("folders") {
        Some(Array(items)) => {
          assert_eq(items.length(), 1)
          match items[0] {
            Object(row) =>
              match row.get("commits") {
                Some(Array(commits)) => {
                  assert_eq(commits.length(), 1)
                  match commits[0] {
                    Object(c) => {
                      assert_eq(c.get("subject"), Some(Json::string("feat: b")))
                      assert_false(
                        c
                        .get("body")
                        .unwrap_or(Json::string(""))
                        .stringify()
                        .contains("Co-Authored-By"),
                      )
                    }
                    _ => fail("应有提交")
                  }
                }
                _ => fail("应有提交列表")
              }
            _ => fail("应有目录行")
          }
        }
        _ => fail("应有 folders")
      }
    _ => fail("应为对象")
  }
  // 脏工作区:400 带原因
  @fs.write_file("\{repo}/dirty.txt", "x")
  let response = @mocket.dispatch_http(
    app,
    "POST",
    "/api/folders/git-strip-coauthored-unpushed",
    headers,
    @utf8.encode("{\"folderId\":\"" + folder_id + "\"}"),
  )
  assert_eq(response.status_code.to_int(), 400)
}
