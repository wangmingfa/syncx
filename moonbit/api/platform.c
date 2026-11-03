// /api/status 的 platform 字段:取编译目标 OS,取值口径对齐 Node 的
// process.platform(darwin / win32 / linux),前端 osIconKind 只认这三个。
// 与 cli/update_platform.c 的 syncx_os_name(macos/windows/linux)是两套口径,
// 各自对齐各自消费方,不要混用。
#include "moonbit.h"
#include <string.h>

// ASCII C 字符串 → MoonBit String(探测结果全是 ASCII,无需 UTF-8 处理)
static moonbit_string_t ascii_str(const char *s) {
  int len = (int)strlen(s);
  moonbit_string_t out = moonbit_make_string(len, 0);
  for (int i = 0; i < len; i++) {
    out[i] = (uint16_t)(unsigned char)s[i];
  }
  return out;
}

moonbit_string_t syncx_status_platform(void) {
#if defined(__APPLE__)
  return ascii_str("darwin");
#elif defined(_WIN32) || defined(_WIN64)
  return ascii_str("win32");
#elif defined(__linux__)
  return ascii_str("linux");
#else
  return ascii_str("unknown");
#endif
}
