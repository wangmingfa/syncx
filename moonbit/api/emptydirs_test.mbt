///|
/// 空目录盘点与清理两端点的行为测试(黑盒 dispatch_http 全链路,真实盘面)。
/// 装配同 versions_test:临时根目录 + share 共享目录 + config.json 登记 id=f1,
/// 会话头走 token 签发;actor 未接 —— 本工具本就刻意不触发扫描。

///|
/// 空目录测试的装配:返回 (临时根, 共享目录)。
async fn ed_setup(tag : String) -> (String, String) {
  let dir = @fs.tmpdir(prefix="syncx-mb-api-ed-\{tag}")
  let share = "\{dir}/share"
  @fs.mkdir(share, recursive=true, allow_exist=true)
  @fs.write_file(
    "\{dir}/config.json",
    "{\"sharedFolders\":[{\"path\":\"\{share}\",\"id\":\"f1\"}],\"formatVersion\":1}",
    create_mode=CreateOrTruncate,
  )
  (dir, share)
}

///|
async test "GET /api/folders/empty-dirs:盘点形态、缺参与未知目录" {
  let (dir, share) = ed_setup("list")
  @fs.mkdir("\{share}/a/b", recursive=true, allow_exist=true)
  @fs.write_file("\{share}/a/b/f.txt", "x", create_mode=CreateOrTruncate)
  @fs.mkdir("\{share}/empty/leaf", recursive=true, allow_exist=true)
  let app = @api.build_app(options_with("ed-list", dir))
  let response = @mocket.dispatch_http(
    app,
    "GET",
    "/api/folders/empty-dirs?folderId=f1",
    tv_headers(),
    b"",
  )
  assert_eq(response.status_code.to_int(), 200)
  let body : Json = response.read_body()
  match body {
    Object(obj) => {
      match obj.get("dirs") {
        Some(Array(items)) => {
          // 有文件的 a 链不列;empty 与 empty/leaf 全列,字典序
          assert_eq(items.length(), 2)
          match items[0] {
            String(p) => assert_eq(p, "empty")
            _ => fail("dirs[0] 应为字符串")
          }
          match items[1] {
            String(p) => assert_eq(p, "empty/leaf")
            _ => fail("dirs[1] 应为字符串")
          }
        }
        _ => fail("dirs 应为数组")
      }
      assert_true(obj.get("truncated") is Some(False))
    }
    _ => fail("响应应为对象")
  }
  // 缺 folderId → 400(Node 同款文案)
  let response = @mocket.dispatch_http(
    app, "GET", "/api/folders/empty-dirs", tv_headers(), b"",
  )
  assert_eq(response.status_code.to_int(), 400)
  let body : Json = response.read_body()
  match body {
    Object(obj) =>
      assert_true(obj.get("error") is Some(String("folderId is required")))
    _ => fail("响应应为对象")
  }
  // 未知目录 → 400 共享目录不存在(可能刚被移除)
  let response = @mocket.dispatch_http(
    app, "GET", "/api/folders/empty-dirs?folderId=no-such", tv_headers(), b"",
  )
  assert_eq(response.status_code.to_int(), 400)
  let body : Json = response.read_body()
  match body {
    Object(obj) =>
      assert_true(obj.get("error") is Some(String("共享目录不存在(可能刚被移除)")))
    _ => fail("响应应为对象")
  }
}

///|
async test "POST /api/folders/empty-dirs/delete:删除、逐条结果与非法 paths" {
  let (dir, share) = ed_setup("delete")
  @fs.mkdir("\{share}/a/b", recursive=true, allow_exist=true)
  @fs.mkdir("\{share}/keep", recursive=true, allow_exist=true)
  @fs.write_file("\{share}/keep/f.txt", "x", create_mode=CreateOrTruncate)
  let app = @api.build_app(options_with("ed-delete", dir))
  let response = @mocket.dispatch_http(
    app,
    "POST",
    "/api/folders/empty-dirs/delete",
    tv_headers(),
    b"{\"folderId\":\"f1\",\"paths\":[\"a/b\",\"a\",\"keep\"]}",
  )
  assert_eq(response.status_code.to_int(), 200)
  let body : Json = response.read_body()
  match body {
    Object(obj) =>
      match obj.get("results") {
        Some(Array(items)) => {
          assert_eq(items.length(), 3)
          // 深路径先处理:a/b 先删 → a 复核放行;keep 有文件 → ok:false 带原因
          match items[0] {
            Object(entry) => {
              assert_true(entry.get("path") is Some(String("a/b")))
              assert_true(entry.get("ok") is Some(True))
            }
            _ => fail("results[0] 应为对象")
          }
          match items[1] {
            Object(entry) => {
              assert_true(entry.get("path") is Some(String("a")))
              assert_true(entry.get("ok") is Some(True))
              // 删除成功不带 reason 字段(Node JSON.stringify 同口径)
              assert_true(entry.get("reason") is None)
            }
            _ => fail("results[1] 应为对象")
          }
          match items[2] {
            Object(entry) => {
              assert_true(entry.get("path") is Some(String("keep")))
              assert_true(entry.get("ok") is Some(False))
              assert_true(
                entry.get("reason") is Some(String("目录内现在有文件,跳过")),
              )
            }
            _ => fail("results[2] 应为对象")
          }
        }
        _ => fail("results 应为数组")
      }
    _ => fail("响应应为对象")
  }
  // a 链盘上删净;keep 连同塞进去的文件原样保留
  assert_true(!(@fs.exists("\{share}/a") catch { _ => true }))
  assert_true(@fs.exists("\{share}/keep/f.txt") catch { _ => false })
  assert_true(@fs.exists("\{share}/keep") catch { _ => false })
  // 非法 paths:空数组 → 400(Node 同款文案)
  let response = @mocket.dispatch_http(
    app,
    "POST",
    "/api/folders/empty-dirs/delete",
    tv_headers(),
    b"{\"folderId\":\"f1\",\"paths\":[]}",
  )
  assert_eq(response.status_code.to_int(), 400)
  let body : Json = response.read_body()
  match body {
    Object(obj) =>
      assert_true(
        obj.get("error") is Some(String("paths must be a non-empty string array")),
      )
    _ => fail("响应应为对象")
  }
  // paths 里混入非字符串 → 400
  let response = @mocket.dispatch_http(
    app,
    "POST",
    "/api/folders/empty-dirs/delete",
    tv_headers(),
    b"{\"folderId\":\"f1\",\"paths\":[\"a\",42]}",
  )
  assert_eq(response.status_code.to_int(), 400)
  // 缺 folderId → 400
  let response = @mocket.dispatch_http(
    app,
    "POST",
    "/api/folders/empty-dirs/delete",
    tv_headers(),
    b"{\"paths\":[\"a\"]}",
  )
  assert_eq(response.status_code.to_int(), 400)
  let body : Json = response.read_body()
  match body {
    Object(obj) =>
      assert_true(obj.get("error") is Some(String("folderId is required")))
    _ => fail("响应应为对象")
  }
  // 未知目录 → 400 共享目录不存在(可能刚被移除)
  let response = @mocket.dispatch_http(
    app,
    "POST",
    "/api/folders/empty-dirs/delete",
    tv_headers(),
    b"{\"folderId\":\"no-such\",\"paths\":[\"a\"]}",
  )
  assert_eq(response.status_code.to_int(), 400)
  let body : Json = response.read_body()
  match body {
    Object(obj) =>
      assert_true(obj.get("error") is Some(String("共享目录不存在(可能刚被移除)")))
    _ => fail("响应应为对象")
  }
}
