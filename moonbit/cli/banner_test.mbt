///|
/// 启动横幅纯函数的行内容单测:顺序与文案逐字对齐 Node src/cli.ts 启动段。

///|
test "build_banner_lines:0.0.0.0 + dev 形态(全量横幅)" {
  let lines = @cli.build_banner_lines(
    "/home/u/.syncx",
    "0.0.0.0",
    9384,
    23000,
    "GWNZR4YPMA",
    ["172.25.48.139", "10.139.255.32"],
    Some("http://127.0.0.1:5173"),
    "tok123",
  )
  assert_eq(lines, [
    "config dir: /home/u/.syncx",
    "control UI (token in /home/u/.syncx/control.token):",
    "  http://localhost:9384",
    "  http://172.25.48.139:9384",
    "  http://10.139.255.32:9384",
    "dev mode: 访问 9384 端口的页面会自动重定向到 vite dev server http://127.0.0.1:5173(HMR 已启用)",
    "  请用 http://127.0.0.1:5173 打开 Web UI;生产构建(不带 --dev-vite)才由 9384 端口直接提供页面",
    "  登录令牌(control.token):tok123",
    "syncx daemon started (device GWNZR4YPMA, peer port 23000)",
    "peer sync (ws://ip:port):",
    "  ws://localhost:23000",
    "  ws://172.25.48.139:23000",
    "  ws://10.139.255.32:23000",
  ])
}

///|
test "build_banner_lines:具体 host + 生产形态(无 dev 不打令牌)" {
  // --host 指定具体地址:control UI 只列该地址;peer sync 仍无条件列
  // localhost + LAN(Node 侧不对称口径,照抄);非 dev 不打令牌行
  let lines = @cli.build_banner_lines(
    "/x",
    "127.0.0.1",
    8384,
    22000,
    "D",
    ["192.168.1.5"],
    None,
    "secret-token",
  )
  assert_eq(lines, [
    "config dir: /x",
    "control UI (token in /x/control.token):",
    "  http://127.0.0.1:8384",
    "syncx daemon started (device D, peer port 22000)",
    "peer sync (ws://ip:port):",
    "  ws://localhost:22000",
    "  ws://192.168.1.5:22000",
  ])
  // 令牌明文绝不出现在生产横幅里
  for line in lines {
    assert_false(line.contains("secret-token"))
  }
}
