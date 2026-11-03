///|
/// 上传换入测试:包名/semver 解析是纯逻辑;包识别与二进制安装用真实
/// `tar` 在临时目录里构造 pack:local 同构的安装包(node tgz / rs / mbt
/// 后端包),不依赖本机构建产物,任何机器上 `moon test` 都可复现。
/// 换入的看门狗交接(spawn_upload_swap)拉起 detached 进程,不做端到端
/// 测试 —— 回滚/健康标记语义已由 update_test 的作业文件往返覆盖字段面。

///|
/// 后端包目录名解析:正式版 / 预发布 / 非法输入。
test "upload: 后端包目录名解析" {
  // 正式版
  guard @cli.parse_backend_dir_name("syncx-rs-v0.4.1-aarch64-apple-darwin")
    is Some((backend, version, target)) else {
    panic()
  }
  assert_eq(backend, "rust")
  assert_eq(version, "0.4.1")
  assert_eq(target, "aarch64-apple-darwin")
  // 预发布后缀里可以含 `-`,不能把它当三元组边界
  guard @cli.parse_backend_dir_name(
      "syncx-mbt-v0.4.1-local.1-x86_64-unknown-linux-gnu",
    )
    is Some((backend, version, target)) else {
    panic()
  }
  assert_eq(backend, "moonbit")
  assert_eq(version, "0.4.1-local.1")
  assert_eq(target, "x86_64-unknown-linux-gnu")
  // 带构建元数据
  guard @cli.parse_backend_dir_name(
      "syncx-rs-v1.2.3-beta.4+build.7-x86_64-pc-windows-msvc",
    )
    is Some((_, version, _)) else {
    panic()
  }
  assert_eq(version, "1.2.3-beta.4+build.7")
  // 非法:版本不是 semver
  assert_true(
    @cli.parse_backend_dir_name("syncx-rs-vX.Y.Z-aarch64-apple-darwin") is None,
  )
  // 非法:不是已知三元组
  assert_true(
    @cli.parse_backend_dir_name("syncx-rs-v0.4.1-riscv64-unknown") is None,
  )
  // 非法:前缀不对(node 包目录 / 任意目录)
  assert_true(@cli.parse_backend_dir_name("package") is None)
  assert_true(
    @cli.parse_backend_dir_name("syncx-mb-v0.4.1-aarch64-apple-darwin") is None,
  )
}

///|
test "upload: semver 形状校验" {
  assert_true(@cli.valid_semver("0.4.1"))
  assert_true(@cli.valid_semver("1.2.3"))
  assert_true(@cli.valid_semver("0.2.14-local.1"))
  assert_true(@cli.valid_semver("0.7.0-beta.10"))
  assert_true(@cli.valid_semver("1.2.3-beta.4+build.7"))
  assert_true(@cli.valid_semver("10.20.30"))
  // 非法:段数 / 空段 / 非数字 / 空 pre / 非法字符
  assert_true(!@cli.valid_semver("1.2"))
  assert_true(!@cli.valid_semver("1.2.3.4"))
  assert_true(!@cli.valid_semver("1..3"))
  assert_true(!@cli.valid_semver("x.y.z"))
  assert_true(!@cli.valid_semver("1.2.3-"))
  assert_true(!@cli.valid_semver("1.2.3-beta!1"))
  assert_true(!@cli.valid_semver(""))
  assert_true(!@cli.valid_semver("1.2.3+"))
}

///|
/// 重启参数折算:去程序名 + 挑出 --log-file。
test "upload: 重启参数折算" {
  let restart = @cli.build_update_restart([
    "/usr/local/bin/syncx-mb", "start", "--config", "/tmp/x/config.json",
  ])
  assert_eq(restart.args, ["start", "--config", "/tmp/x/config.json"])
  assert_true(restart.log_file is None)
  assert_true(restart.cwd is None)
  // --log-file 空格形式(args.ts 同款)
  let restart = @cli.build_update_restart([
    "syncx-mb", "start", "--config", "/tmp/y/config.json", "--log-file", "/tmp/y/syncx.log",
  ])
  assert_eq(restart.log_file, Some("/tmp/y/syncx.log"))
  // 空参(缺省打印版本态,实际不会走到换入,但不应崩)
  let restart = @cli.build_update_restart([])
  assert_eq(restart.args, [])
}

///|
/// 作业文件新字段:跨后端换入字段经 JSON 往返不丢;旧版作业文件
/// (无新字段)按缺省解析,发布路径行为不变。
test "upload: UpdateJob 跨后端字段往返" {
  let job : @cli.UpdateJob = {
    parent_pid: 42,
    staging: "/data/bin/syncx-rs",
    exe: "/usr/local/bin/syncx-mb",
    old_exe: "/usr/local/bin/syncx-mb.old",
    marker: "/tmp/marker",
    done: "/tmp/done.json",
    restart_args: Some(["start"]),
    restart_cwd: None,
    log_file: None,
    wait_ms: 120_000L,
    verify_ms: 30_000L,
    version: "0.4.1",
    restart_exe: Some("/data/bin/syncx-rs"),
    no_swap: true,
    kill_parent_ms: 600L,
    health_url: Some("http://127.0.0.1:8384/health"),
  }
  let json = @json.parse(job.to_json().stringify()) catch { _ => panic() }
  guard @cli.UpdateJob::from_json(json) is Some(back) else { panic() }
  assert_eq(back.restart_exe, Some("/data/bin/syncx-rs"))
  assert_true(back.no_swap)
  assert_eq(back.kill_parent_ms, 600L)
  assert_eq(back.health_url, Some("http://127.0.0.1:8384/health"))
  // 旧版作业文件(发布路径写出的)没有新字段:按缺省解析
  let legacy = @json.parse(
    "{\"parent_pid\":42,\"staging\":\"/s\",\"exe\":\"/e\",\"old_exe\":\"/o\",\"marker\":\"/m\",\"done\":\"/d\",\"restart_args\":null,\"restart_cwd\":null,\"log_file\":null,\"wait_ms\":1,\"verify_ms\":1,\"version\":\"0\"}",
  ) catch {
    _ => panic()
  }
  guard @cli.UpdateJob::from_json(legacy) is Some(old) else { panic() }
  assert_true(old.restart_exe is None)
  assert_true(!old.no_swap)
  assert_eq(old.kill_parent_ms, 0L)
}

// ---- 真实安装包(tar 构造) ----

///|
/// 打一个后端安装包(结构与 pack-local / Release 资产一致):
/// 顶层 `syncx-{kind}-v{version}-{triple}/` 内含单二进制。
async fn make_backend_pkg(
  kind : String,
  version : String,
  triple : String,
  bin_content : String,
  executable~ : Bool = false,
) -> Bytes? {
  let work = @fs.tmpdir(prefix="syncx-mb-upload-test") catch {
    _ => return None
  }
  let stage_dir = "syncx-\{kind}-v\{version}-\{triple}"
  let stage = "\{work}/\{stage_dir}"
  @fs.mkdir(stage, recursive=true, allow_exist=true) catch {
    _ => return None
  }
  let bin_name = if kind == "rs" { "syncx-rs" } else { "syncx-mb" }
  let bin_path = "\{stage}/\{bin_name}"
  @fs.write_file(bin_path, bin_content) catch {
    _ => return None
  }
  if executable {
    @fs.chmod(bin_path, 493) catch {
      _ => return None
    }
  }
  let archive = "\{work}/pkg.tar.gz"
  let code = @process.run(
    "tar",
    ["-czf", archive, "-C", work, stage_dir],
    inherit_env=true,
  ) catch {
    _ => return None
  }
  if code != 0 {
    return None
  }
  let data = @fs.read_file(archive) catch { _ => return None }
  Some(data.binary())
}

///|
/// 打一个 npm 载体 tgz(顶层 package/)。
async fn make_node_pkg(
  name : String,
  version : String,
  with_bundle~ : Bool = true,
) -> Bytes? {
  let work = @fs.tmpdir(prefix="syncx-mb-upload-test") catch {
    _ => return None
  }
  let pkg = "\{work}/package"
  @fs.mkdir("\{pkg}/dist", recursive=true, allow_exist=true) catch {
    _ => return None
  }
  @fs.write_file(
    "\{pkg}/package.json",
    "{\"name\":\"\{name}\",\"version\":\"\{version}\"}",
  ) catch {
    _ => return None
  }
  if with_bundle {
    @fs.write_file(
      "\{pkg}/dist/syncx.js",
      "#!/usr/bin/env node\nconsole.log('syncx')\n",
    ) catch {
      _ => return None
    }
  }
  let archive = "\{work}/pkg.tgz"
  let code = @process.run(
    "tar",
    ["-czf", archive, "-C", work, "package"],
    inherit_env=true,
  ) catch {
    _ => return None
  }
  if code != 0 {
    return None
  }
  let data = @fs.read_file(archive) catch { _ => return None }
  Some(data.binary())
}

///|
/// 清掉解包临时目录。
async fn cleanup(work_dir : String) -> Unit {
  @fs.rmdir(work_dir, recursive=true) catch {
    _ => ()
  }
}

///|
async test "upload: 识别 rs / mbt 后端安装包" {
  let target = @cli.detect_target() catch { _ => panic() }
  // rs 包
  guard make_backend_pkg("rs", "0.4.1", target, "fake-rs-binary") is Some(bytes) else {
    panic()
  }
  match @cli.inspect_uploaded_package(bytes, min_bytes=1) {
    Ok(info) => {
      assert_eq(info.backend, "rust")
      assert_eq(info.version, "0.4.1")
      assert_eq(info.target, Some(target))
      assert_true(info.name is None)
    }
    Err(e) => fail("rs 包识别失败:\{e}")
  }
  // mbt 包(带预发布后缀)
  guard make_backend_pkg("mbt", "0.4.2-local.3", target, "fake-mb-binary")
    is Some(bytes) else {
    panic()
  }
  match @cli.inspect_uploaded_package(bytes, min_bytes=1) {
    Ok(info) => {
      assert_eq(info.backend, "moonbit")
      assert_eq(info.version, "0.4.2-local.3")
      assert_eq(info.target, Some(target))
    }
    Err(e) => fail("mbt 包识别失败:\{e}")
  }
}

///|
async test "upload: 识别 npm tgz(node 包)" {
  guard make_node_pkg("@wangmingfa/syncx", "0.4.1") is Some(bytes) else {
    panic()
  }
  match @cli.inspect_uploaded_package(bytes, min_bytes=1) {
    Ok(info) => {
      assert_eq(info.backend, "node")
      assert_eq(info.version, "0.4.1")
      assert_eq(info.name, Some("@wangmingfa/syncx"))
      assert_true(info.target is None)
    }
    Err(e) => fail("node 包识别失败:\{e}")
  }
}

///|
async test "upload: 目标平台不符 / 坏包 / 缺二进制一律拒绝" {
  let target = @cli.detect_target() catch { _ => panic() }
  // 挑一个与本机不同的三元组(防 arm/x64 混装是硬闸门)
  let other = if target.contains("darwin") {
    "x86_64-unknown-linux-gnu"
  } else {
    "aarch64-apple-darwin"
  }
  guard make_backend_pkg("rs", "0.4.1", other, "fake-binary") is Some(wrong) else {
    panic()
  }
  match @cli.inspect_uploaded_package(wrong, min_bytes=1) {
    Ok(_) => fail("目标不符的包不应通过")
    Err(e) => assert_true(e.contains("目标平台"))
  }
  // 顶层目录在、二进制缺失
  let work = @fs.tmpdir(prefix="syncx-mb-upload-test") catch { _ => panic() }
  let stage_dir = "syncx-rs-v0.4.1-\{target}"
  @fs.mkdir("\{work}/\{stage_dir}", recursive=true, allow_exist=true) catch {
    _ => panic()
  }
  let archive = "\{work}/pkg.tar.gz"
  let code = @process.run(
    "tar",
    ["-czf", archive, "-C", work, stage_dir],
    inherit_env=true,
  ) catch {
    _ => panic()
  }
  assert_eq(code, 0)
  let bytes = @fs.read_file(archive).binary()
  match @cli.inspect_uploaded_package(bytes, min_bytes=1) {
    Ok(_) => fail("缺二进制的包不应通过")
    Err(e) => assert_true(e.contains("syncx-rs"))
  }
  cleanup(work)
  // 不是 tar 包(随机字节)
  match
    @cli.inspect_uploaded_package(b"this is not a tarball at all", min_bytes=1) {
    Ok(_) => fail("非安装包不应通过")
    Err(_) => ()
  }
  // 空包 / 过小包
  match @cli.inspect_uploaded_package(b"") {
    Ok(_) => fail("空包不应通过")
    Err(e) => assert_true(e.contains("疑似损坏"))
  }
  // 未知顶层结构
  guard make_node_pkg("@other/pkg", "1.0.0", with_bundle=false) is Some(random) else {
    panic()
  }
  match @cli.inspect_uploaded_package(random, min_bytes=1) {
    Ok(_) => fail("包名异常不应通过")
    Err(e) => assert_true(e.contains("包名异常"))
  }
  // 版本号非法
  guard make_node_pkg("@wangmingfa/syncx", "not-semver") is Some(badver) else {
    panic()
  }
  match @cli.inspect_uploaded_package(badver, min_bytes=1) {
    Ok(_) => fail("版本非法不应通过")
    Err(e) => assert_true(e.contains("版本号异常"))
  }
}

///|
/// 换入纯逻辑:二进制安装到 <configDir>/bin/ 并实跑 --version 校验;
/// node 包换入拒绝。看门狗拉起不做端到端(detached 进程无法收尾)。
async test "upload: 安装二进制到 bin/ 并校验版本" {
  let target = @cli.detect_target() catch { _ => panic() }
  // Windows 没有可实跑的脚本二进制,本用例只在类 Unix 上执行
  if target.contains("windows") {
    return
  }
  // 一个真的能跑的假后端:--version 输出版本号
  let script = "#!/bin/sh\necho \"syncx 0.4.9-fake (fake backend)\"\n"
  guard make_backend_pkg("rs", "0.4.9-fake", target, script, executable=true)
    is Some(bytes) else {
    panic()
  }
  let config_dir = @fs.tmpdir(prefix="syncx-mb-upload-install") catch {
    _ => panic()
  }
  match @cli.extract_package(bytes, min_bytes=1) {
    Ok(pkg) => {
      match @cli.install_backend_binary(pkg, config_dir) {
        Ok(dest) => {
          assert_true(dest.has_suffix("/syncx-rs"))
          assert_true(@fs.exists(dest) catch { _ => false })
          assert_true(@fs.can_execute(dest) catch { _ => false })
        }
        Err(e) => fail("安装失败:\{e}")
      }
      cleanup(pkg.work_dir)
    }
    Err(e) => fail("解包失败:\{e}")
  }
  // 版本不符的假后端拒绝换入
  let wrong_script = "#!/bin/sh\necho \"syncx 0.0.1 (other)\"\n"
  guard make_backend_pkg(
      "mbt",
      "0.4.9-fake",
      target,
      wrong_script,
      executable=true,
    )
    is Some(wrong) else {
    panic()
  }
  match @cli.extract_package(wrong, min_bytes=1) {
    Ok(pkg) => {
      match @cli.install_backend_binary(pkg, config_dir) {
        Ok(_) => fail("版本不符不应通过")
        Err(e) => assert_true(e.contains("版本不符"))
      }
      cleanup(pkg.work_dir)
    }
    Err(e) => fail("解包失败:\{e}")
  }
  cleanup(config_dir)
}

///|
/// node 包换入的纯逻辑:控制端口/健康地址解析(npm 安装与看门狗拉起
/// 涉及真实系统状态,不做 e2e)。
test "upload: node 健康判定地址解析" {
  // 显式 --control-port
  assert_eq(
    @cli.control_port_of_args([
      "start", "--config", "/x/config.json", "--control-port", "9527",
    ]),
    9527,
  )
  // 缺省 8384;非法端口值回落缺省
  assert_eq(
    @cli.control_port_of_args(["start", "--config", "/x/config.json"]),
    8384,
  )
  assert_eq(@cli.control_port_of_args(["start", "--control-port", "abc"]), 8384)
  assert_eq(@cli.health_url_of_args(["start"]), "http://127.0.0.1:8384/health")
  assert_eq(
    @cli.health_url_of_args(["start", "--control-port", "9527"]),
    "http://127.0.0.1:9527/health",
  )
}

///|
async test "upload: node 包在 npm 不可用时明确报错,不半途换入" {
  guard make_node_pkg("@wangmingfa/syncx", "0.4.1") is Some(bytes) else {
    panic()
  }
  let config_dir = @fs.tmpdir(prefix="syncx-mb-upload-node") catch {
    _ => panic()
  }
  // npm 指向不存在的命令:启动即失败,必须给出「本机可能未安装」的明确
  // 文案,而不是换到一半
  match
    @cli.perform_upload_swap(
      bytes,
      config_dir,
      min_bytes=1,
      npm_cmd="/nonexistent/syncx-test-npm",
    ) {
    Ok(_) => fail("npm 不可用时不应换入成功")
    Err(e) => {
      assert_true(e.contains("npm install -g 失败"))
      assert_true(e.contains("无法启动 npm"))
    }
  }
  // 失败后不应写任何看门狗交接痕迹(数据目录里只有 update/ 下的 tgz)
  assert_true(!(@fs.exists("\{config_dir}/bin") catch { _ => false }))
  cleanup(config_dir)
}
