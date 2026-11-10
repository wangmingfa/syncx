///|
// 自更新纯逻辑测试:资产名拼装、semver 比较、checksums 解析、target 探测、
// 通道挑选与作业文件 JSON 往返。不发真实网络请求;对应用例抄自
// rust/crates/syncx-cli/src/update.rs 的 tests 模块。

///|
// 构造 asset JSON(fixture 用,不发网络)。
fn asset_json(name : String) -> Json {
  let map : Map[String, Json] = Map([])
  map.set("name", Json::string(name))
  map.set("browser_download_url", Json::string("https://x/\{name}"))
  Json::object(map)
}

///|
/// 六个发布目标各一份资产:pick_release 按本机 target 匹配,
/// fixture 全量覆盖后测试不依赖跑测试的机器。
fn all_target_assets(version : String) -> Array[Json] {
  let assets : Array[Json] = []
  for
    target in [
      "x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu", "x86_64-apple-darwin",
      "aarch64-apple-darwin", "x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc",
    ] {
    assets.push(
      asset_json("syncx-mbt-v\{version}-\{target}.\{suffix_of(target)}"),
    )
  }
  assets.push(asset_json("checksums.txt"))
  assets
}

///|
fn suffix_of(target : String) -> String {
  if target.contains("windows") {
    "zip"
  } else {
    "tar.gz"
  }
}

///|
fn release_json(
  tag : String,
  prerelease~ : Bool,
  draft~ : Bool,
  assets~ : Array[Json],
) -> Json {
  let map : Map[String, Json] = Map([])
  map.set("tag_name", Json::string(tag))
  map.set("prerelease", Json::boolean(prerelease))
  map.set("draft", Json::boolean(draft))
  map.set("assets", Json::array(assets))
  Json::object(map)
}

///|
test "update: semver 比较与 Rust/Node 规则一致" {
  assert_eq(@cliapp.compare_semver("1.2.3", "1.2.3"), 0)
  assert_eq(@cliapp.compare_semver("1.2.4", "1.2.3"), 1)
  assert_eq(@cliapp.compare_semver("1.3.0", "1.2.9"), 1)
  assert_eq(@cliapp.compare_semver("0.9.9", "1.0.0"), -1)
  // 正式版大于同号预发布
  assert_eq(@cliapp.compare_semver("1.2.3", "1.2.3-beta.1"), 1)
  assert_eq(@cliapp.compare_semver("1.2.3-beta.1", "1.2.3"), -1)
  // 预发布迭代号按数值比
  assert_eq(@cliapp.compare_semver("1.2.3-beta.10", "1.2.3-beta.9"), 1)
  assert_eq(@cliapp.compare_semver("1.2.3-beta.2", "1.2.3-beta.10"), -1)
  // 通道名字典序
  assert_eq(@cliapp.compare_semver("1.2.3-alpha", "1.2.3-beta"), -1)
  // 无迭代号的预发布按 0 号
  assert_eq(@cliapp.compare_semver("1.2.3-beta", "1.2.3-beta.0"), 0)
  // 脏数据不 panic,按 0.0.0 处理
  assert_eq(@cliapp.compare_semver("", ""), 0)
  assert_eq(@cliapp.compare_semver("x.y.z", "1.0.0"), -1)
  assert_eq(@cliapp.compare_semver("1.2", "1.2.0"), 0)
}

///|
test "update: 升级通道校验与规范化" {
  assert_eq(@cliapp.normalize_upgrade_tag(None), "latest")
  assert_eq(@cliapp.normalize_upgrade_tag(Some("  ")), "latest")
  assert_eq(@cliapp.normalize_upgrade_tag(Some("beta")), "beta")
  assert_eq(@cliapp.normalize_upgrade_tag(Some("  rc.1_v2-a  ")), "rc.1_v2-a")
  // 非法输入抛错(catch 后拿不到合法通道名)
  assert_eq(@cliapp.normalize_upgrade_tag(Some("bad tag")) catch { _ => "" }, "")
  assert_eq(@cliapp.normalize_upgrade_tag(Some("-leading")) catch { _ => "" }, "")
  assert_eq(@cliapp.normalize_upgrade_tag(Some("a/b")) catch { _ => "" }, "")
  assert_eq(@cliapp.normalize_upgrade_tag(Some("")), "latest")
}

///|
test "update: 资产名拼装对齐 workflow 命名" {
  assert_eq(
    @cliapp.asset_name("0.6.1", "x86_64-unknown-linux-gnu"),
    "syncx-mbt-v0.6.1-x86_64-unknown-linux-gnu.tar.gz",
  )
  assert_eq(
    @cliapp.asset_name("0.6.1", "aarch64-pc-windows-msvc"),
    "syncx-mbt-v0.6.1-aarch64-pc-windows-msvc.zip",
  )
  // 预发布版本号带通道后缀
  assert_eq(
    @cliapp.asset_name("0.7.0-beta.1", "aarch64-apple-darwin"),
    "syncx-mbt-v0.7.0-beta.1-aarch64-apple-darwin.tar.gz",
  )
}

///|
test "update: 目标三元组探测只认 6 个发布目标" {
  assert_eq(
    @cliapp.target_triple("linux", "x86_64"),
    Some("x86_64-unknown-linux-gnu"),
  )
  assert_eq(
    @cliapp.target_triple("linux", "aarch64"),
    Some("aarch64-unknown-linux-gnu"),
  )
  assert_eq(@cliapp.target_triple("macos", "x86_64"), Some("x86_64-apple-darwin"))
  assert_eq(
    @cliapp.target_triple("macos", "aarch64"),
    Some("aarch64-apple-darwin"),
  )
  assert_eq(
    @cliapp.target_triple("windows", "x86_64"),
    Some("x86_64-pc-windows-msvc"),
  )
  assert_eq(
    @cliapp.target_triple("windows", "aarch64"),
    Some("aarch64-pc-windows-msvc"),
  )
  // 不在矩阵内的组合拒绝
  assert_true(@cliapp.target_triple("freebsd", "x86_64") is None)
  assert_true(@cliapp.target_triple("linux", "riscv64") is None)
}

///|
test "update: checksums 两空格格式解析" {
  let text = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  syncx-mbt-v0.6.1-x86_64-unknown-linux-gnu.tar.gz\n" +
    "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB  *syncx-mbt-v0.6.1-aarch64-apple-darwin.tar.gz\n" +
    "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc  syncx-mbt-v0.6.1-x86_64-pc-windows-msvc.zip\n" +
    "\n"
  let linux = @cliapp.parse_checksums(
    text, "syncx-mbt-v0.6.1-x86_64-unknown-linux-gnu.tar.gz",
  )
  assert_eq(
    linux,
    Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
  )
  // 二进制模式的 `*` 前缀剥掉后匹配;大写 hash 归一化为小写
  let darwin = @cliapp.parse_checksums(
    text, "syncx-mbt-v0.6.1-aarch64-apple-darwin.tar.gz",
  )
  assert_eq(
    darwin,
    Some("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
  )
  // 没有条目 → None(调用方据此拒绝换入)
  assert_true(
    @cliapp.parse_checksums(
      text, "syncx-mbt-v0.99.0-x86_64-unknown-linux-gnu.tar.gz",
    )
    is None,
  )
  // 空文件
  assert_true(@cliapp.parse_checksums("", "anything") is None)
}

///|
test "update: pick_release 在 latest 通道忽略 draft 与 prerelease" {
  let releases = [
    release_json(
      "v0.7.0-beta.1",
      prerelease=true,
      draft=false,
      assets=all_target_assets("0.7.0-beta.1"),
    ),
    release_json(
      "v0.6.2",
      prerelease=false,
      draft=false,
      assets=all_target_assets("0.6.2"),
    ),
    release_json("v0.9.0", prerelease=false, draft=true, assets=[]),
  ]
  guard @cliapp.pick_release(releases, None) is Some(latest) else { panic() }
  assert_eq(latest.version, "0.6.2")
  let target = @cliapp.detect_target() catch { _ => panic() }
  assert_eq(
    latest.url,
    "https://x/syncx-mbt-v0.6.2-\{target}.\{suffix_of(target)}",
  )
  assert_eq(latest.checksums_url, Some("https://x/checksums.txt"))
}

///|
test "update: 预发布通道取最高版本而非列表顺序" {
  let releases = [
    release_json(
      "v0.7.0-beta.2",
      prerelease=true,
      draft=false,
      assets=all_target_assets("0.7.0-beta.2"),
    ),
    release_json(
      "v0.7.0-beta.10",
      prerelease=true,
      draft=false,
      assets=all_target_assets("0.7.0-beta.10"),
    ),
  ]
  // 字典序会把 beta.2 排在 beta.10 之前;必须按数值取 10
  guard @cliapp.pick_release(releases, Some("beta")) is Some(beta) else { panic() }
  assert_eq(beta.version, "0.7.0-beta.10")
  // latest 通道不收预发布
  assert_true(@cliapp.pick_release(releases, None) is None)
}

///|
test "update: 缺本机资产或畸形条目时返回 None" {
  // 只有别的目标的资产 → 找不到
  let wrong = [
    release_json("v0.6.2", prerelease=false, draft=false, assets=[
      asset_json("syncx-mbt-v0.6.2-not-a-real-target.tar.gz"),
    ]),
  ]
  assert_true(@cliapp.pick_release(wrong, None) is None)
  // 没有 tag_name 的畸形条目跳过
  let empty : Map[String, Json] = Map([])
  empty.set("prerelease", Json::boolean(false))
  let malformed : Array[Json] = [Json::object(empty)]
  assert_true(@cliapp.pick_release(malformed, None) is None)
}

///|
test "update: UpdateJob 经 JSON 往返不丢字段" {
  let raw = "{\"parent_pid\":42,\"staging\":\"/tmp/staging.bin\",\"exe\":\"/usr/local/bin/syncx-mb\",\"old_exe\":\"/usr/local/bin/syncx-mb.old\",\"marker\":\"/tmp/marker\",\"done\":\"/tmp/done.json\",\"restart_args\":[\"start\",\"--port\"],\"restart_cwd\":\"/home/user\",\"log_file\":null,\"wait_ms\":120000,\"verify_ms\":30000,\"version\":\"0.5.0\"}"
  let json = @json.parse(raw) catch { _ => panic() }
  guard @cliapp.UpdateJob::from_json(json) is Some(job) else { panic() }
  assert_eq(job.parent_pid, 42)
  assert_eq(job.staging, "/tmp/staging.bin")
  assert_eq(job.restart_args, Some(["start", "--port"]))
  assert_eq(job.restart_cwd, Some("/home/user"))
  assert_eq(job.log_file, None)
  assert_eq(job.wait_ms, 120_000L)
  assert_eq(job.verify_ms, 30_000L)
  assert_eq(job.version, "0.5.0")
  // to_json → from_json 再走一遍,字段必须原样回来
  let again = @json.parse(job.to_json().stringify()) catch { _ => panic() }
  guard @cliapp.UpdateJob::from_json(again) is Some(job2) else { panic() }
  assert_eq(job2.parent_pid, job.parent_pid)
  assert_eq(job2.exe, job.exe)
  assert_eq(job2.restart_args, job.restart_args)
  assert_eq(job2.restart_cwd, job.restart_cwd)
  assert_eq(job2.log_file, job.log_file)
  assert_eq(job2.wait_ms, job.wait_ms)
  assert_eq(job2.version, job.version)
  // 缺必填字段 → None,看门狗会拒绝执行
  let broken = @json.parse("{\"parent_pid\":1}") catch { _ => panic() }
  assert_true(@cliapp.UpdateJob::from_json(broken) is None)
}

///|
test "update: 备份路径是同路径加后缀" {
  assert_eq(
    @cliapp.sibling_with_suffix("/usr/local/bin/syncx-mb", ".old"),
    "/usr/local/bin/syncx-mb.old",
  )
  assert_eq(
    @cliapp.sibling_with_suffix("C:\\bin\\syncx-mb.exe", ".old"),
    "C:\\bin\\syncx-mb.exe.old",
  )
}
