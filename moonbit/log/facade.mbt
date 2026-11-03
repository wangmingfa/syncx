///|
/// 进程级单槽:全后端共用一个 Logger 实例。MoonBit native 目标是单线程
/// 协作式 async(所有任务跑在同一事件循环里),普通 mut 全局没有并发竞争,
/// 无需锁;若未来引入真线程,这里要换成原子/锁。
let mut current_logger : @logging.Logger = @logging.null_logger()

///|
/// 装配进程级 Logger(cli 启动时调用一次;测试注入 MemoryLogger)。
pub fn init(logger : @logging.Logger) -> Unit {
  current_logger = logger
}

///|
/// 装配 stdout 形态:PrintLogger 包 min_level(缺省 Information 及以上,
/// 与 Node 后端缺省级别同口径 —— Debug 只留给文件通道,stdout 不刷屏)。
pub fn init_print(minimum~ : @logging.Level = Information) -> Unit {
  init(@logging.min_level(PrintLogger::new(), minimum))
}

///|
/// 装配文件形态(--log-file):FileLogger 包 min_level(缺省 Debug,日志
/// 文件是排查通道,细节放行)。行为对齐 Node:--log-file 时日志进文件,
/// 不再刷 stdout。
pub fn init_file(path : String, minimum~ : @logging.Level = Debug) -> Unit {
  init(@logging.min_level(FileLogger::new(path), minimum))
}

///|
/// 当前进程 Logger。缺省 null_logger:未装配前一切静默,测试进程不刷屏。
pub fn get() -> @logging.Logger {
  current_logger
}

///|
/// 门面直通:透传到当前进程 Logger 的同级别方法,调用点一行搞定。
/// 参数与库一致 —— 模板用 {Name} 占位,args 按序绑定(Json 值)。
pub fn trace(template : String, args~ : Array[Json] = []) -> Unit {
  get().trace(template, args)
}

///|
pub fn debug(template : String, args~ : Array[Json] = []) -> Unit {
  get().debug(template, args)
}

///|
pub fn info(template : String, args~ : Array[Json] = []) -> Unit {
  get().info(template, args)
}

///|
pub fn warn(template : String, args~ : Array[Json] = []) -> Unit {
  get().warn(template, args)
}

///|
pub fn error(template : String, args~ : Array[Json] = []) -> Unit {
  get().error(template, args)
}

///|
pub fn critical(template : String, args~ : Array[Json] = []) -> Unit {
  get().critical(template, args)
}
