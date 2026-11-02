///|
/// 入口:按 argv 分发 start / --update-swap / 缺省打印版本。
/// 参数面与启动编排见 args.mbt / entry.mbt;自更新看门狗见 update.mbt。
async fn main {
  let argv = @env.args()
  // args() 含程序名,剥掉(脚本/测试侧统一从命令位开始)。
  let argv = if argv.length() > 0 { argv[1:].to_owned() } else { argv }
  match pick_mode(argv) {
    Ok(UpdateSwap(job_path)) => c_exit(run_update_swap(job_path))
    Ok(Start(args)) => run_start(args)
    Ok(Version) => println("syncx \{@core.VERSION} (moonbit backend)")
    Err(message) => {
      // 参数错误必须非零退出,否则脚本/CI 的 `|| exit 1` 判断全部失灵
      eprintln(message)
      eprintln("")
      eprintln("用 `syncx start --help` 查看用法。")
      c_exit(1)
    }
  }
}
