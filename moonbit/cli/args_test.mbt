///|
// args.mbt / entry.mbt 的纯逻辑测试:参数解析、分发选择、路径折算。
// 不发网络、不碰真实数据目录。

///|
test "args: 合法完整参数面" {
  let args = match
    @cli.parse_start_args([
      "--config", "/tmp/a/config.json", "--config-dir", "/tmp/b", "--host", "127.0.0.1",
      "--port", "22000", "--control-port", "8385", "--log-file", "/tmp/log", "--dev-vite",
      "http://127.0.0.1:5173", "--expose-control",
    ]) {
    Ok(args) => args
    Err(e) => abort(e)
  }
  assert_eq(args.config_path, Some("/tmp/a/config.json"))
  assert_eq(args.config_dir, Some("/tmp/b"))
  assert_eq(args.host, Some("127.0.0.1"))
  assert_eq(args.port, Some(22000))
  assert_eq(args.control_port, Some(8385))
  assert_eq(args.log_file, Some("/tmp/log"))
  assert_eq(args.dev_vite_url, Some("http://127.0.0.1:5173"))
  assert_eq(args.expose_control, true)
  assert_eq(args.positionals.length(), 0)
}

///|
test "args: 缺省全空" {
  let args = match @cli.parse_start_args([]) {
    Ok(args) => args
    Err(e) => abort(e)
  }
  assert_true(args.config_path is None)
  assert_true(args.config_dir is None)
  assert_true(args.host is None)
  assert_true(args.port is None)
  assert_true(args.control_port is None)
  assert_true(args.log_file is None)
  assert_true(args.dev_vite_url is None)
  assert_false(args.expose_control)
}

///|
test "args: 未知选项报错" {
  match @cli.parse_start_args(["--bogus"]) {
    Ok(_) => abort("应报错")
    Err(e) => assert_eq(e, "unknown option: --bogus")
  }
}

///|
test "args: 未知命令报错(分发层)" {
  match @cli.pick_mode(["frobnicate"]) {
    Ok(_) => abort("应报错")
    Err(e) => assert_eq(e, "unknown command: frobnicate")
  }
}

///|
test "args: 已知但未实现的命令给出明确提示" {
  match @cli.pick_mode(["stop"]) {
    Ok(_) => abort("应报错")
    Err(e) =>
      inspect(
        e,
        content="命令 stop 尚未在 MoonBit 后端实现(当前仅支持 start)",
      )
  }
}

///|
test "args: 非回环 host 必须显式 --expose-control" {
  match @cli.parse_start_args(["--host", "0.0.0.0"]) {
    Ok(_) => abort("应报错")
    Err(e) =>
      inspect(
        e,
        content="--host 0.0.0.0 exposes the control API over plain HTTP on the LAN; pass --expose-control to allow it",
      )
  }
  // 显式放行后通过
  let args = match
    @cli.parse_start_args(["--host", "0.0.0.0", "--expose-control"]) {
    Ok(args) => args
    Err(e) => abort(e)
  }
  assert_eq(args.host, Some("0.0.0.0"))
  assert_true(args.expose_control)
}

///|
test "args: 非法端口 / 非法 vite 基址 / 缺取值" {
  match @cli.parse_start_args(["--port", "abc"]) {
    Ok(_) => abort("应报错")
    Err(e) => assert_eq(e, "invalid --port: abc")
  }
  match @cli.parse_start_args(["--control-port", "70000"]) {
    Ok(_) => abort("应报错")
    Err(e) => assert_eq(e, "invalid --control-port: 70000")
  }
  match @cli.parse_start_args(["--dev-vite", "ftp://x"]) {
    Ok(_) => abort("应报错")
    Err(e) => assert_eq(e, "invalid --dev-vite url: ftp://x")
  }
  match @cli.parse_start_args(["--host"]) {
    Ok(_) => abort("应报错")
    Err(e) => assert_eq(e, "缺少 --host 的取值")
  }
  // https 形态合法
  let args = match
    @cli.parse_start_args(["--dev-vite", "https://dev.local:5173"]) {
    Ok(args) => args
    Err(e) => abort(e)
  }
  assert_eq(args.dev_vite_url, Some("https://dev.local:5173"))
}

///|
test "分发: 缺省打印版本 / start / --update-swap" {
  assert_true(@cli.pick_mode([]) is Ok(Version))
  match @cli.pick_mode(["start", "--config-dir", "/tmp/x"]) {
    Ok(Start(args)) => assert_eq(args.config_dir, Some("/tmp/x"))
    _ => abort("应分发到 Start")
  }
  // --update-swap 必须先于一切初始化:带作业文件与不带都直达
  assert_true(
    @cli.pick_mode(["--update-swap", "job.json"]) is Ok(UpdateSwap("job.json")),
  )
  assert_true(@cli.pick_mode(["--update-swap"]) is Ok(UpdateSwap("")))
}

///|
test "路径折算: --config 优先于 --config-dir;目录部分正确" {
  let both : @cli.StartArgs = {
    config_path: Some("/tmp/a/config.json"),
    config_dir: Some("/tmp/b"),
    host: None,
    port: None,
    control_port: None,
    log_file: None,
    dev_vite_url: None,
    expose_control: false,
    positionals: [],
  }
  assert_eq(@cli.resolve_config_path(both), "/tmp/a/config.json")
  assert_eq(@cli.parent_dir_of("/tmp/a/config.json"), "/tmp/a")
  assert_eq(@cli.parent_dir_of("config.json"), ".")
  let dir_only : @cli.StartArgs = {
    ..both,
    config_path: None,
    config_dir: Some("/tmp/b"),
  }
  assert_eq(@cli.resolve_config_path(dir_only), "/tmp/b/config.json")
}

///|
test "dev 态判定: --dev-vite 或 dist 缺失" {
  let plain : @cli.StartArgs = {
    config_path: None,
    config_dir: None,
    host: None,
    port: None,
    control_port: None,
    log_file: None,
    dev_vite_url: None,
    expose_control: false,
    positionals: [],
  }
  assert_false(@cli.is_dev_mode(plain, false))
  assert_true(@cli.is_dev_mode(plain, true))
  assert_true(
    @cli.is_dev_mode(
      { ..plain, dev_vite_url: Some("http://127.0.0.1:5173"), },
      false,
    ),
  )
}
