///|
/// syncx MoonBit 后端的结构化日志(ADR-0026;三方库 moonrockz/
/// moon-lander-logging@0.11.0)。本包只做三件事:
///   - 两个后端(PrintLogger / FileLogger,库自身零 I/O,后端自己写);
///   - 进程级单槽(init / get,见 facade.mbt);
///   - 门面直通函数(调用点一行搞定,不用先取 Logger 再调)。
/// 级别过滤/分组等组合能力(min_level / fan_out / with_category)由库提供,
/// 装配层(init_print / init_file)按需套用。

///|
/// PrintLogger:每个事件一行打到标准输出(dev/缺省形态,保持既有 stdout
/// 行为不回归)。带 error 的事件无需特殊处理 —— 库的 to_line 会自动追加
/// `  error: <text>` 第二行。无状态,用单例枚举承载(空 struct 字面量与
/// Map 字面量同形,会造成歧义)。
pub enum PrintLogger {
  PrintLogger
}

///|
pub fn PrintLogger::new() -> PrintLogger {
  PrintLogger
}

///|
pub impl @logging.Logger for PrintLogger with fn log(_self, event) {
  let line = @utf8.encode(event.to_line() + "\n")
  let _ = c_log_stdout(line, line.length())
}

///|
/// stdout 逐行写出(见 logger.c 的 syncx_log_stdout):每行 flush,绕开
/// println 在「常驻进程 + 管道/重定向」下的全缓冲 —— 否则 concurrently、
/// 重定向排查时横幅永远躺在缓冲区里不出现。返回值一律忽略(失败静默)。
#borrow(line)
extern "C" fn c_log_stdout(line : Bytes, line_len : Int32) -> Int32 = "syncx_log_stdout"

///|
/// impl 方法的显式提升声明(库的 MemoryLogger 同款):不写的话编译器按
/// 隐式提升告警。
pub extend PrintLogger with @logging.Logger::{enabled, log}

///|
/// FileLogger:按行追加写日志文件(--log-file)。句柄由 C 侧缓存复用
/// (进程内同一路径只 fopen 一次,见 logger.c),写失败一律静默 —— 日志
/// 永不打断主流程。行内容走库的 to_line。
pub struct FileLogger {
  priv path : String
}

///|
pub fn FileLogger::new(path : String) -> FileLogger {
  { path, }
}

///|
/// C 侧追加写(见 logger.c):路径与行均以 UTF-8 字节传入;返回 1 = 落盘,
/// 0 = 静默失败。调用方一律忽略返回值。
#borrow(path, line)
extern "C" fn c_log_append(
  path : Bytes,
  path_len : Int32,
  line : Bytes,
  line_len : Int32,
) -> Int32 = "syncx_log_append"

///|
pub impl @logging.Logger for FileLogger with fn log(self, event) {
  let path = @utf8.encode(self.path)
  let line = @utf8.encode(event.to_line() + "\n")
  let _ = c_log_append(path, path.length(), line, line.length())
}

///|
pub extend FileLogger with @logging.Logger::{enabled, log}
