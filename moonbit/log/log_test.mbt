///|
/// log 包测试(黑盒,@log = 本包,@logging = moon-lander-logging)。
/// 单槽是进程级全局态:每个用例开头 init 自己的 Logger、结尾恢复
/// null_logger,避免用例间串扰;FileLogger 走临时目录真实落盘断言。

///|
test "门面直通:事件转发到当前进程 Logger,模板按序绑定" {
  let memory = @logging.MemoryLogger::new()
  let logger : &@logging.Logger = memory
  @log.init_logger(logger)
  @log.info("Loaded {Count} files from {Path}", [Json::number(3), Json::string("src")])
  @log.warn("低电量 {Level}", [Json::string("low")])
  let events = memory.events()
  assert_eq(events.length(), 2)
  assert_eq(events[0].level, Information)
  assert_eq(events[0].message(), "Loaded 3 files from src")
  assert_eq(events[1].level, Warning)
  assert_eq(events[1].message(), "低电量 low")
  // 收尾恢复静默
  @log.init_logger(@logging.null_logger())
}

///|
test "级别过滤:min_level(Error) 之后 info 不记、error 记" {
  let memory = @logging.MemoryLogger::new()
  @log.init_logger(@logging.min_level(memory, Error))
  @log.debug("不记", [])
  @log.info("也不记", [])
  @log.warn("还不记", [])
  @log.error("记下 {Reason}", [Json::string("disk full")])
  let events = memory.events()
  assert_eq(events.length(), 1)
  assert_eq(events[0].level, Error)
  assert_eq(events[0].message(), "记下 disk full")
  @log.init_logger(@logging.null_logger())
}

///|
test "未装配时门面静默(null_logger 兜底,不抛错不刷屏)" {
  @log.init_logger(@logging.null_logger())
  @log.info("谁也收不到", [])
  @log.critical("同样静默", [])
}

///|
async test "FileLogger:两行落盘,行首级别码 [INF]/[WRN]" {
  let dir = @fs.tmpdir(prefix="syncx-mb-log") catch { _ => fail("临时目录创建失败") }
  let path = "\{dir}/syncx.log"
  let file_logger = @log.FileLogger::new(path)
  let logger : &@logging.Logger = file_logger
  logger.info("第一行 {Count}", [Json::number(1)])
  logger.warn("第二行", [])
  // 逐行追加 + 每行 fflush,读回即见
  let text = @fs.read_file(path).text()
  let lines = text.split("\n").collect()
  assert_true(lines[0].has_prefix("[INF] "))
  assert_true(lines[0].contains("第一行 1"))
  assert_true(lines[1].has_prefix("[WRN] "))
  assert_true(lines[1].contains("第二行"))
}

///|
async test "FileLogger:写失败静默(目录不存在不炸主流程)" {
  // 路径指向一个必然不是目录的位置:打开失败应静默,log 调用照常返回
  let file_logger = @log.FileLogger::new("/proc/syncx-no-such-dir/x.log")
  let logger : &@logging.Logger = file_logger
  logger.error("这一行落不进盘,但不能抛错", [])
  assert_true(true)
}
