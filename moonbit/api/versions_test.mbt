///|
/// 文件版本(时间机器)与回收站操作面的行为测试(黑盒,dispatch_http 全链
/// 路,真实盘面)。装配:临时根目录 + share 共享目录 + config.json 登记
/// id=f1;版本/回收站目录按 sha1("f1") 前 16 位预铺。actor 未接(None):
/// 恢复端点必须降级为不触发扫描且不炸。

///|
/// 版本/回收站测试的装配:返回 (临时根, 共享目录)。
async fn tv_setup(tag : String) -> (String, String) {
  let dir = @fs.tmpdir(prefix="syncx-mb-api-tv-\{tag}")
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
/// f1 的版本目录(预建,返回绝对路径)。
async fn tv_versions_dir(dir : String) -> String {
  let v = "\{dir}/versions/\{@api.folder_index_hash("f1")}"
  @fs.mkdir(v, recursive=true, allow_exist=true)
  v
}

///|
/// f1 的回收站目录(预建,返回绝对路径)。
async fn tv_trash_dir(dir : String) -> String {
  let t = "\{dir}/trash/\{@api.folder_index_hash("f1")}"
  @fs.mkdir(t, recursive=true, allow_exist=true)
  t
}

///|
/// 会话请求头。
fn tv_headers() -> Map[@http.CaseInsensitiveString, StringView] {
  let secret = @api.session_secret("test-token")
  let ticket = @api.sign_session(
    { via: "token", sub: "token", exp: @api.now_ms() + 60_000L, },
    secret,
  )
  { "Cookie": "syncx_session=\{ticket}" }
}

///|
async test "GET /api/folders/versions:列表形态、排序与杂散文件" {
  let (dir, _share) = tv_setup("ver-list")
  let v = tv_versions_dir(dir)
  @fs.mkdir("\{v}/docs", recursive=true, allow_exist=true)
  @fs.write_file("\{v}/docs/plan.md.syncx-v-mtest001", "older", create_mode=CreateOrTruncate)
  @fs.write_file("\{v}/b.txt.syncx-v-mtest002", "bbb", create_mode=CreateOrTruncate)
  // 非版本命名的杂散文件也照列(Node listVersionFiles 同口径,path 原样)
  @fs.write_file("\{v}/junk.txt", "stray", create_mode=CreateOrTruncate)
  let app = @api.build_app(options_with("ver-list", dir))
  let response = @mocket.dispatch_http(
    app,
    "GET",
    "/api/folders/versions?folderId=f1",
    tv_headers(),
    b"",
  )
  assert_eq(response.status_code.to_int(), 200)
  let body : Json = response.read_body()
  match body {
    Object(obj) =>
      match obj.get("versions") {
        Some(Array(items)) => {
          // path 主序:b.txt < docs/plan.md < junk.txt
          assert_eq(items.length(), 3)
          let expected : Array[String] = ["b.txt", "docs/plan.md", "junk.txt"]
          for i, item in items {
            match item {
              Object(entry) =>
                match entry.get("path") {
                  Some(String(p)) => assert_eq(p, expected[i])
                  _ => fail("path 应为字符串")
                }
              _ => fail("versions[i] 应为对象")
            }
          }
          // 第一行的形态:file 保留命名、size 为字节数、mtime 为数值
          match items[0] {
            Object(entry) => {
              assert_true(entry.get("file") is Some(String("b.txt.syncx-v-mtest002")))
              assert_true(entry.get("size") is Some(Number(3.0, ..)))
              assert_true(entry.get("mtime") is Some(Number(_, ..)))
            }
            _ => fail("versions[0] 应为对象")
          }
        }
        _ => fail("versions 应为数组")
      }
    _ => fail("响应应为对象")
  }
  // 缺 folderId → 400(Node 同款文案)
  let response = @mocket.dispatch_http(
    app, "GET", "/api/folders/versions", tv_headers(), b"",
  )
  assert_eq(response.status_code.to_int(), 400)
  let body : Json = response.read_body()
  match body {
    Object(obj) =>
      assert_true(obj.get("error") is Some(String("folderId is required")))
    _ => fail("响应应为对象")
  }
  // 未知目录 → 400 folder not found
  let response = @mocket.dispatch_http(
    app, "GET", "/api/folders/versions?folderId=no-such", tv_headers(), b"",
  )
  assert_eq(response.status_code.to_int(), 400)
}

///|
async test "POST /api/folders/versions/restore:恢复落盘、当前内容留档、防护" {
  let (dir, share) = tv_setup("ver-restore")
  let v = tv_versions_dir(dir)
  @fs.mkdir("\{v}/docs", recursive=true, allow_exist=true)
  @fs.write_file("\{v}/docs/plan.md.syncx-v-mtest001", "v1", create_mode=CreateOrTruncate)
  @fs.mkdir("\{share}/docs", recursive=true, allow_exist=true)
  @fs.write_file("\{share}/docs/plan.md", "current", create_mode=CreateOrTruncate)
  let app = @api.build_app(options_with("ver-restore", dir))
  // 恢复:200 ok:true,原路径变成版本内容
  let response = @mocket.dispatch_http(
    app,
    "POST",
    "/api/folders/versions/restore",
    tv_headers(),
    b"{\"folderId\":\"f1\",\"file\":\"docs/plan.md.syncx-v-mtest001\"}",
  )
  assert_eq(response.status_code.to_int(), 200)
  let body : Json = response.read_body()
  match body {
    Object(obj) => assert_true(obj.get("ok") is Some(True))
    _ => fail("响应应为对象")
  }
  assert_eq(@fs.read_file("\{share}/docs/plan.md").text(), "v1")
  // 恢复前备份确实产生:版本目录多了一份「current」的留档(可逆)
  let names = @fs.readdir("\{v}/docs")
  assert_eq(names.length(), 2)
  let mut backup = ""
  for name in names {
    if name != "plan.md.syncx-v-mtest001" {
      backup = name
    }
  }
  assert_true(backup.has_prefix("plan.md.syncx-v-"))
  assert_eq(@fs.read_file("\{v}/docs/\{backup}").text(), "current")
  // 缺参 → 400(Node 同款文案)
  let response = @mocket.dispatch_http(
    app, "POST", "/api/folders/versions/restore", tv_headers(), b"{}",
  )
  assert_eq(response.status_code.to_int(), 400)
  let body : Json = response.read_body()
  match body {
    Object(obj) =>
      assert_true(
        obj.get("error") is Some(String("folderId and file are required")),
      )
    _ => fail("响应应为对象")
  }
  // 版本不存在 → 400
  let response = @mocket.dispatch_http(
    app,
    "POST",
    "/api/folders/versions/restore",
    tv_headers(),
    b"{\"folderId\":\"f1\",\"file\":\"docs/plan.md.syncx-v-mtest999\"}",
  )
  assert_eq(response.status_code.to_int(), 400)
  // 名字不带 .syncx-v- 标记 → 400 invalid version file
  let response = @mocket.dispatch_http(
    app,
    "POST",
    "/api/folders/versions/restore",
    tv_headers(),
    b"{\"folderId\":\"f1\",\"file\":\"docs/plan.md\"}",
  )
  assert_eq(response.status_code.to_int(), 400)
  // .. 逃逸 → 400 unsafe version file
  let response = @mocket.dispatch_http(
    app,
    "POST",
    "/api/folders/versions/restore",
    tv_headers(),
    b"{\"folderId\":\"f1\",\"file\":\"../../escape.txt.syncx-v-mtest001\"}",
  )
  assert_eq(response.status_code.to_int(), 400)
  // 反解出的原路径是硬忽略路径(.git)→ 400(即使版本目录里真有这份留档)
  @fs.mkdir("\{v}/.git", recursive=true, allow_exist=true)
  @fs.write_file("\{v}/.git/config.syncx-v-mtest001", "g", create_mode=CreateOrTruncate)
  let response = @mocket.dispatch_http(
    app,
    "POST",
    "/api/folders/versions/restore",
    tv_headers(),
    b"{\"folderId\":\"f1\",\"file\":\".git/config.syncx-v-mtest001\"}",
  )
  assert_eq(response.status_code.to_int(), 400)
  let body : Json = response.read_body()
  match body {
    Object(obj) =>
      assert_true(
        obj.get("error") is Some(String("hard-ignored path: .git/config")),
      )
    _ => fail("响应应为对象")
  }
  // 未知目录 → 400 folder not found
  let response = @mocket.dispatch_http(
    app,
    "POST",
    "/api/folders/versions/restore",
    tv_headers(),
    b"{\"folderId\":\"no-such\",\"file\":\"docs/plan.md.syncx-v-mtest001\"}",
  )
  assert_eq(response.status_code.to_int(), 400)
}

///|
async test "POST /api/folders/versions/delete:删除生效、缺失与非法名报 400" {
  let (dir, _share) = tv_setup("ver-del")
  let v = tv_versions_dir(dir)
  @fs.write_file("\{v}/a.txt.syncx-v-mtest001", "x", create_mode=CreateOrTruncate)
  let app = @api.build_app(options_with("ver-del", dir))
  let response = @mocket.dispatch_http(
    app,
    "POST",
    "/api/folders/versions/delete",
    tv_headers(),
    b"{\"folderId\":\"f1\",\"file\":\"a.txt.syncx-v-mtest001\"}",
  )
  assert_eq(response.status_code.to_int(), 200)
  let body : Json = response.read_body()
  match body {
    Object(obj) => assert_true(obj.get("ok") is Some(True))
    _ => fail("响应应为对象")
  }
  assert_true(!@fs.exists("\{v}/a.txt.syncx-v-mtest001"))
  // 再删:文件已不在 → 400(rmSync 抛错同口径)
  let response = @mocket.dispatch_http(
    app,
    "POST",
    "/api/folders/versions/delete",
    tv_headers(),
    b"{\"folderId\":\"f1\",\"file\":\"a.txt.syncx-v-mtest001\"}",
  )
  assert_eq(response.status_code.to_int(), 400)
  // 非法名字 → 400
  let response = @mocket.dispatch_http(
    app, "POST", "/api/folders/versions/delete", tv_headers(),
    b"{\"folderId\":\"f1\",\"file\":\"a.txt\"}",
  )
  assert_eq(response.status_code.to_int(), 400)
  let body : Json = response.read_body()
  match body {
    Object(obj) =>
      assert_true(obj.get("error") is Some(String("invalid version file")))
    _ => fail("响应应为对象")
  }
  // 逃逸名字 → 400
  let response = @mocket.dispatch_http(
    app,
    "POST",
    "/api/folders/versions/delete",
    tv_headers(),
    b"{\"folderId\":\"f1\",\"file\":\"../x.syncx-v-mtest001\"}",
  )
  assert_eq(response.status_code.to_int(), 400)
}

///|
async test "GET /api/folders/versions/content:text、binary、tooLarge、缺失与逃逸" {
  let (dir, _share) = tv_setup("ver-content")
  let v = tv_versions_dir(dir)
  @fs.write_file("\{v}/a.txt.syncx-v-mtest001", "hello", create_mode=CreateOrTruncate)
  @fs.write_file("\{v}/bin.syncx-v-mtest001", b"ab\x00cd", create_mode=CreateOrTruncate)
  @fs.write_file("\{v}/big.syncx-v-mtest001", Bytes::repeat(b"x", 1000001), create_mode=CreateOrTruncate)
  let app = @api.build_app(options_with("ver-content", dir))
  let headers = tv_headers()
  // 文本:exists + size + text
  let response = @mocket.dispatch_http(
    app, "GET", "/api/folders/versions/content?folderId=f1&file=a.txt.syncx-v-mtest001",
    headers, b"",
  )
  assert_eq(response.status_code.to_int(), 200)
  let body : Json = response.read_body()
  match body {
    Object(obj) => {
      assert_true(obj.get("exists") is Some(True))
      assert_true(obj.get("size") is Some(Number(5.0, ..)))
      assert_true(obj.get("text") is Some(String("hello")))
      assert_true(obj.get("binary") is None)
    }
    _ => fail("响应应为对象")
  }
  // 含 \0:binary,不回 text
  let response = @mocket.dispatch_http(
    app, "GET", "/api/folders/versions/content?folderId=f1&file=bin.syncx-v-mtest001",
    headers, b"",
  )
  assert_eq(response.status_code.to_int(), 200)
  let body : Json = response.read_body()
  match body {
    Object(obj) => {
      assert_true(obj.get("exists") is Some(True))
      assert_true(obj.get("binary") is Some(True))
      assert_true(obj.get("text") is None)
    }
    _ => fail("响应应为对象")
  }
  // 超 1MB:只报大小不回内容
  let response = @mocket.dispatch_http(
    app, "GET", "/api/folders/versions/content?folderId=f1&file=big.syncx-v-mtest001",
    headers, b"",
  )
  assert_eq(response.status_code.to_int(), 200)
  let body : Json = response.read_body()
  match body {
    Object(obj) => {
      assert_true(obj.get("exists") is Some(True))
      assert_true(obj.get("size") is Some(Number(1000001.0, ..)))
      assert_true(obj.get("tooLarge") is Some(True))
      assert_true(obj.get("text") is None)
    }
    _ => fail("响应应为对象")
  }
  // 版本不存在:exists:false
  let response = @mocket.dispatch_http(
    app, "GET", "/api/folders/versions/content?folderId=f1&file=nope.syncx-v-mtest001",
    headers, b"",
  )
  assert_eq(response.status_code.to_int(), 200)
  let body : Json = response.read_body()
  match body {
    Object(obj) => assert_true(obj.get("exists") is Some(False))
    _ => fail("响应应为对象")
  }
  // 缺 file → 400;非法名 → 400;逃逸 → 400
  let response = @mocket.dispatch_http(
    app, "GET", "/api/folders/versions/content?folderId=f1", headers, b"",
  )
  assert_eq(response.status_code.to_int(), 400)
  let response = @mocket.dispatch_http(
    app, "GET", "/api/folders/versions/content?folderId=f1&file=a.txt",
    headers, b"",
  )
  assert_eq(response.status_code.to_int(), 400)
  let body : Json = response.read_body()
  match body {
    Object(obj) =>
      assert_true(obj.get("error") is Some(String("invalid version file")))
    _ => fail("响应应为对象")
  }
  let response = @mocket.dispatch_http(
    app,
    "GET",
    "/api/folders/versions/content?folderId=f1&file=../x.syncx-v-mtest001",
    headers,
    b"",
  )
  assert_eq(response.status_code.to_int(), 400)
}

///|
async test "GET /api/trash:列表形态、新删在前、非副本命名不列" {
  let (dir, _share) = tv_setup("trash-list")
  let t = tv_trash_dir(dir)
  @fs.mkdir("\{t}/docs", recursive=true, allow_exist=true)
  @fs.write_file("\{t}/top.txt.mtest001", "one", create_mode=CreateOrTruncate)
  @fs.write_file("\{t}/docs/deep.txt.mtest002", "two", create_mode=CreateOrTruncate)
  // 无时间戳尾巴的文件不是回收站副本,不列(Node listTrashRefs 同口径)
  @fs.write_file("\{t}/ignoreme.txt", "keep", create_mode=CreateOrTruncate)
  let app = @api.build_app(options_with("trash-list", dir))
  let response = @mocket.dispatch_http(
    app, "GET", "/api/trash?folderId=f1", tv_headers(), b"",
  )
  assert_eq(response.status_code.to_int(), 200)
  let body : Json = response.read_body()
  match body {
    Object(obj) =>
      match obj.get("entries") {
        Some(Array(items)) => {
          // 新删在前:ts 降序 → mtest002 的 docs/deep.txt 在前
          assert_eq(items.length(), 2)
          match items[0] {
            Object(entry) => {
              assert_true(
                entry.get("file") is Some(String("docs/deep.txt.mtest002")),
              )
              assert_true(entry.get("path") is Some(String("docs/deep.txt")))
              assert_true(entry.get("size") is Some(Number(3.0, ..)))
              assert_true(entry.get("ts") is Some(Number(_, ..)))
            }
            _ => fail("entries[0] 应为对象")
          }
          match items[1] {
            Object(entry) =>
              assert_true(entry.get("file") is Some(String("top.txt.mtest001")))
            _ => fail("entries[1] 应为对象")
          }
        }
        _ => fail("entries 应为数组")
      }
    _ => fail("响应应为对象")
  }
  // 缺 folderId → 400;未知目录 → 400
  let response = @mocket.dispatch_http(app, "GET", "/api/trash", tv_headers(), b"")
  assert_eq(response.status_code.to_int(), 400)
  let response = @mocket.dispatch_http(
    app, "GET", "/api/trash?folderId=no-such", tv_headers(), b"",
  )
  assert_eq(response.status_code.to_int(), 400)
}

///|
async test "POST /api/trash/restore:搬回原路径、同名实体让位进回收站、防护" {
  let (dir, share) = tv_setup("trash-restore")
  let t = tv_trash_dir(dir)
  @fs.mkdir("\{t}/docs", recursive=true, allow_exist=true)
  @fs.write_file("\{t}/docs/a.txt.mtest001", "trashed", create_mode=CreateOrTruncate)
  @fs.mkdir("\{share}/docs", recursive=true, allow_exist=true)
  @fs.write_file("\{share}/docs/a.txt", "live", create_mode=CreateOrTruncate)
  let app = @api.build_app(options_with("trash-restore", dir))
  let response = @mocket.dispatch_http(
    app,
    "POST",
    "/api/trash/restore",
    tv_headers(),
    b"{\"folderId\":\"f1\",\"file\":\"docs/a.txt.mtest001\"}",
  )
  assert_eq(response.status_code.to_int(), 200)
  let body : Json = response.read_body()
  match body {
    Object(obj) => assert_true(obj.get("ok") is Some(True))
    _ => fail("响应应为对象")
  }
  // 原路径 = 副本内容
  assert_eq(@fs.read_file("\{share}/docs/a.txt").text(), "trashed")
  // 同名实体已让位进回收站(还原动作本身可逆),原副本已搬走
  assert_true(!@fs.exists("\{t}/docs/a.txt.mtest001"))
  let names = @fs.readdir("\{t}/docs")
  assert_eq(names.length(), 1)
  assert_true(names[0].has_prefix("a.txt."))
  assert_eq(@fs.read_file("\{t}/docs/\{names[0]}").text(), "live")
  // 再还原同一份:副本已不在 → 400(Node 同款文案)
  let response = @mocket.dispatch_http(
    app,
    "POST",
    "/api/trash/restore",
    tv_headers(),
    b"{\"folderId\":\"f1\",\"file\":\"docs/a.txt.mtest001\"}",
  )
  assert_eq(response.status_code.to_int(), 400)
  let body : Json = response.read_body()
  match body {
    Object(obj) =>
      assert_true(obj.get("error") is Some(String("回收站里没有这个副本")))
    _ => fail("响应应为对象")
  }
  // 命名无法识别 → 400
  @fs.write_file("\{t}/weird.txt", "x", create_mode=CreateOrTruncate)
  let response = @mocket.dispatch_http(
    app,
    "POST",
    "/api/trash/restore",
    tv_headers(),
    b"{\"folderId\":\"f1\",\"file\":\"weird.txt\"}",
  )
  assert_eq(response.status_code.to_int(), 400)
  let body : Json = response.read_body()
  match body {
    Object(obj) =>
      assert_true(
        obj.get("error") is Some(String("回收站副本命名无法识别")),
      )
    _ => fail("响应应为对象")
  }
  // 越界(../ 逃出回收站)→ 400 unsafe path
  let response = @mocket.dispatch_http(
    app,
    "POST",
    "/api/trash/restore",
    tv_headers(),
    b"{\"folderId\":\"f1\",\"file\":\"../outside.mtest001\"}",
  )
  assert_eq(response.status_code.to_int(), 400)
  // 缺 file / 缺 folderId → 400(Node 同款文案,两个键分开报)
  let response = @mocket.dispatch_http(
    app, "POST", "/api/trash/restore", tv_headers(), b"{\"folderId\":\"f1\"}",
  )
  assert_eq(response.status_code.to_int(), 400)
  let body : Json = response.read_body()
  match body {
    Object(obj) =>
      assert_true(obj.get("error") is Some(String("file is required")))
    _ => fail("响应应为对象")
  }
  let response = @mocket.dispatch_http(
    app, "POST", "/api/trash/restore", tv_headers(), b"{}",
  )
  assert_eq(response.status_code.to_int(), 400)
  let body : Json = response.read_body()
  match body {
    Object(obj) =>
      assert_true(obj.get("error") is Some(String("folderId is required")))
    _ => fail("响应应为对象")
  }
}

///|
async test "POST /api/trash/purge:单副本、整仓清空、缺失报 400" {
  let (dir, _share) = tv_setup("trash-purge")
  let t = tv_trash_dir(dir)
  @fs.mkdir("\{t}/docs", recursive=true, allow_exist=true)
  @fs.write_file("\{t}/top.txt.mtest001", "one", create_mode=CreateOrTruncate)
  @fs.write_file("\{t}/docs/deep.txt.mtest002", "two", create_mode=CreateOrTruncate)
  let app = @api.build_app(options_with("trash-purge", dir))
  // 单副本:只清指定那份
  let response = @mocket.dispatch_http(
    app,
    "POST",
    "/api/trash/purge",
    tv_headers(),
    b"{\"folderId\":\"f1\",\"file\":\"top.txt.mtest001\"}",
  )
  assert_eq(response.status_code.to_int(), 200)
  let body : Json = response.read_body()
  match body {
    Object(obj) => assert_true(obj.get("ok") is Some(True))
    _ => fail("响应应为对象")
  }
  assert_true(!@fs.exists("\{t}/top.txt.mtest001"))
  assert_true(@fs.exists("\{t}/docs/deep.txt.mtest002"))
  // 不存在的副本 → 400
  let response = @mocket.dispatch_http(
    app,
    "POST",
    "/api/trash/purge",
    tv_headers(),
    b"{\"folderId\":\"f1\",\"file\":\"top.txt.mtest001\"}",
  )
  assert_eq(response.status_code.to_int(), 400)
  let body : Json = response.read_body()
  match body {
    Object(obj) =>
      assert_true(obj.get("error") is Some(String("回收站里没有这个副本")))
    _ => fail("响应应为对象")
  }
  // file 非字符串 → 400
  let response = @mocket.dispatch_http(
    app,
    "POST",
    "/api/trash/purge",
    tv_headers(),
    b"{\"folderId\":\"f1\",\"file\":42}",
  )
  assert_eq(response.status_code.to_int(), 400)
  let body : Json = response.read_body()
  match body {
    Object(obj) =>
      assert_true(obj.get("error") is Some(String("file must be a string")))
    _ => fail("响应应为对象")
  }
  // file 空串 = 清空整个回收站(Node `file === ''` 同口径)
  let response = @mocket.dispatch_http(
    app, "POST", "/api/trash/purge", tv_headers(), b"{\"folderId\":\"f1\",\"file\":\"\"}",
  )
  assert_eq(response.status_code.to_int(), 200)
  assert_true(!(@fs.exists(t) catch { _ => false }))
  // 缺 folderId → 400
  let response = @mocket.dispatch_http(app, "POST", "/api/trash/purge", tv_headers(), b"{}")
  assert_eq(response.status_code.to_int(), 400)
}

///|
async test "回收站 file 缺省 = 清空整个回收站" {
  let (dir, _share) = tv_setup("trash-purge-all")
  let t = tv_trash_dir(dir)
  @fs.write_file("\{t}/a.txt.mtest001", "a", create_mode=CreateOrTruncate)
  @fs.write_file("\{t}/b.txt.mtest002", "b", create_mode=CreateOrTruncate)
  let app = @api.build_app(options_with("trash-purge-all", dir))
  let response = @mocket.dispatch_http(
    app, "POST", "/api/trash/purge", tv_headers(), b"{\"folderId\":\"f1\"}",
  )
  assert_eq(response.status_code.to_int(), 200)
  assert_true(!(@fs.exists(t) catch { _ => false }))
}
