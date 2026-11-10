///|
/// 可执行入口:全部实现(参数面、启动编排、git 镜像、自更新、上传识别)
/// 都在 `cliapp` 包,本包只保留 main 入口 —— main 包的黑盒测试将被弃用
/// (见 moon 提示),实现一律随 cliapp 包测试。
async fn main {
  @cliapp.run_from_argv()
}
