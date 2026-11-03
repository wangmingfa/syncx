// 自更新平台探测 FFI(update.mbt 专用)。
//
// MoonBit 侧没有编译期目标三元组,TARGET 靠本文件在**目标机上编译时**由
// 预处理器宏定死 os/arch,再由 MoonBit 侧映射到 workflow 的 6 个 target
// (x86_64/aarch64 × linux-gnu/apple-darwin/windows-msvc)。另提供当前可执行
// 文件路径、pid 与进程存活探测(看门狗等旧进程退出用)。
#include "moonbit.h"
#include <string.h>
#include <stdlib.h>
#if defined(_WIN32) || defined(_WIN64)
#include <process.h>
#else
#include <unistd.h>
#endif

#if defined(__APPLE__)
#include <mach-o/dyld.h>
#include <unistd.h>
#include <signal.h>
#include <sys/types.h>
#elif defined(_WIN32) || defined(_WIN64)
#include <windows.h>
#include <process.h>
#else
#include <unistd.h>
#include <signal.h>
#include <sys/types.h>
#endif

// ASCII C 字符串 → MoonBit String(探测结果全是 ASCII,无需 UTF-8 处理)
static moonbit_string_t ascii_str(const char *s) {
  int len = (int)strlen(s);
  moonbit_string_t out = moonbit_make_string(len, 0);
  for (int i = 0; i < len; i++) {
    out[i] = (uint16_t)(unsigned char)s[i];
  }
  return out;
}

moonbit_string_t syncx_os_name(void) {
#if defined(__APPLE__)
  return ascii_str("macos");
#elif defined(_WIN32) || defined(_WIN64)
  return ascii_str("windows");
#elif defined(__linux__)
  return ascii_str("linux");
#else
  return ascii_str("unknown");
#endif
}

moonbit_string_t syncx_arch_name(void) {
#if defined(__x86_64__) || defined(_M_X64)
  return ascii_str("x86_64");
#elif defined(__aarch64__) || defined(_M_ARM64)
  return ascii_str("aarch64");
#else
  return ascii_str("unknown");
#endif
}

int syncx_getpid(void) {
#if defined(_WIN32) || defined(_WIN64)
  return (int)_getpid();
#else
  return (int)getpid();
#endif
}

// 当前可执行文件绝对路径;取不到返回空串,由 MoonBit 侧判空拒绝升级。
moonbit_string_t syncx_current_exec_path(void) {
  static char buf[4096];
#if defined(__APPLE__)
  uint32_t size = sizeof(buf);
  if (_NSGetExecutablePath(buf, &size) == 0) {
    return ascii_str(buf);
  }
#elif defined(_WIN32) || defined(_WIN64)
  DWORD n = GetModuleFileNameA(NULL, buf, sizeof(buf));
  if (n > 0 && n < sizeof(buf)) {
    return ascii_str(buf);
  }
#else
  ssize_t n = readlink("/proc/self/exe", buf, sizeof(buf) - 1);
  if (n > 0) {
    buf[n] = '\0';
    return ascii_str(buf);
  }
#endif
  return ascii_str("");
}

// 进程存活探测:看门狗等旧进程退出用。非 0 = 存活。
int syncx_is_process_alive(int pid) {
  if (pid <= 0) {
    return 0;
  }
#if defined(_WIN32) || defined(_WIN64)
  HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, (DWORD)pid);
  if (h == NULL) {
    return 0;
  }
  DWORD code = 0;
  BOOL ok = GetExitCodeProcess(h, &code);
  CloseHandle(h);
  return ok && code == STILL_ACTIVE;
#else
  return kill((pid_t)pid, 0) == 0;
#endif
}

// 向指定进程发 SIGTERM(上传换入:看门狗在宽限期后请旧进程让位)。
// Unix 走 SIGTERM;Windows 上旧进程没有信号概念,等价物是强杀 ——
// 上传换入场景旧进程的职责就是退出,无需优雅钩子。
void syncx_send_sigterm(int pid) {
  if (pid <= 0) {
    return;
  }
#if defined(_WIN32) || defined(_WIN64)
  HANDLE h = OpenProcess(PROCESS_TERMINATE, FALSE, (DWORD)pid);
  if (h != NULL) {
    TerminateProcess(h, 0);
    CloseHandle(h);
  }
#else
  kill((pid_t)pid, SIGTERM);
#endif
}

// ---- 启动编排(entry.mbt)专用 FFI ----

// 系统熵源取 n 字节随机数(控制令牌等凭据生成;失败返回 0 长度)。
// 命名带 cli_ 前缀:net 包的 crypto.c 里已有 syncx_random_bytes,
// 两个 stub 会链接进同一个二进制,重名即冲突。
moonbit_bytes_t syncx_cli_random_bytes(int32_t len) {
  if (len <= 0) {
    return moonbit_make_bytes(0, 0);
  }
  moonbit_bytes_t out = moonbit_make_bytes(len, 0);
  unsigned char *buf = (unsigned char *)out;
#if defined(__APPLE__)
  arc4random_buf(buf, (size_t)len);
  return out;
#elif defined(_WIN32) || defined(_WIN64)
  // rand_s 走 RtlGenRandom,是 Win32 下的用户态 CSPRNG
  for (int32_t i = 0; i < len; i++) {
    unsigned int v = 0;
    if (rand_s(&v) != 0) {
      return moonbit_make_bytes(0, 0);
    }
    buf[i] = (unsigned char)v;
  }
  return out;
#else
  // Linux:读 /dev/urandom(getrandom 头文件可用性参差,urandom 等价且可移植)
  FILE *f = fopen("/dev/urandom", "rb");
  if (f == NULL) {
    return moonbit_make_bytes(0, 0);
  }
  size_t got = fread(buf, 1, (size_t)len, f);
  fclose(f);
  if (got != (size_t)len) {
    return moonbit_make_bytes(0, 0);
  }
  return out;
#endif
}

// 以指定退出码结束进程(致命错误的统一出口)。
void syncx_exit(int code) {
  _exit(code);
}
