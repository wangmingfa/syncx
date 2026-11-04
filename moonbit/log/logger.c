// log 包的原生桩:FileLogger 的按行追加写。
//
// 为什么走 C stdio:Logger trait 的 log 是同步签名(Unit),moonbitlang/async
// 的文件写全是 async,跨不过去;日志又必须逐行落盘。这里直接用 C stdio:
// 句柄在进程内打开一次缓存复用(不每行重开),写失败一律静默 —— 日志永不
// 打断主流程。
//
// 线程前提:MoonBit native 目标是单线程协作式 async(所有任务跑在同一事件
// 循环里),下面的全局句柄/路径缓存没有并发竞争;若未来引入真线程,这里要
// 换成带锁的实现。
#include "moonbit.h"
#include <stdio.h>
#include <string.h>

// 进程级缓存:同一路径的句柄只打开一次。不同路径交替出现(测试里每个用例
// 一个临时日志文件)时按路径切换重开;生产全进程只有一个 FileLogger 写入方。
static FILE *log_handle = NULL;
static char log_path[1024] = {0};

// 追加写一行(path/line 均为 UTF-8 字节,line 自带换行)。返回 1 = 落盘,
// 0 = 静默失败(参数异常、路径超长、打开或写失败)。调用方一律忽略返回值。
int32_t
syncx_log_append(const uint8_t *path, int32_t path_len, const uint8_t *line, int32_t line_len)
{
	if (path == NULL || path_len <= 0 || line == NULL || line_len < 0)
		return 0;
	char path_buf[1024];
	if ((size_t)path_len >= sizeof(path_buf))
		return 0; /* 超长路径按写失败静默处理 */
	memcpy(path_buf, path, (size_t)path_len);
	path_buf[path_len] = '\0';
	if (log_handle == NULL || strcmp(log_path, path_buf) != 0) {
		if (log_handle != NULL)
			fclose(log_handle);
		log_handle = fopen(path_buf, "a");
		if (log_handle == NULL) {
			log_path[0] = '\0';
			return 0;
		}
		strncpy(log_path, path_buf, sizeof(log_path) - 1);
		log_path[sizeof(log_path) - 1] = '\0';
	}
	if (fwrite(line, 1, (size_t)line_len, log_handle) != (size_t)line_len)
		return 0;
	if (fflush(log_handle) != 0)
		return 0;
	return 1;
}

// PrintLogger 的 stdout 写出:println 在「常驻进程 + stdout 连到管道/重定向」
// 场景是全缓冲(4KB),横幅会一直躺在缓冲区里不出现(concurrently、tail -f
// 日志排查全都会扑空);短命进程靠退出时的 flush 掩盖了这一点。这里每行
// fwrite + fflush,与 FileLogger 的逐行落盘口径一致。返回 1 = 写出,0 = 静默失败。
int32_t
syncx_log_stdout(const uint8_t *line, int32_t line_len)
{
	if (line == NULL || line_len < 0)
		return 0;
	if (fwrite(line, 1, (size_t)line_len, stdout) != (size_t)line_len)
		return 0;
	if (fflush(stdout) != 0)
		return 0;
	return 1;
}
