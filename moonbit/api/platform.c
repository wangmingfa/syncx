// /api/status 的 platform 字段:取编译目标 OS,取值口径对齐 Node 的
// process.platform(darwin / win32 / linux),前端 osIconKind 只认这三个。
// 与 cli/update_platform.c 的 syncx_os_name(macos/windows/linux)是两套口径,
// 各自对齐各自消费方,不要混用。
#include "moonbit.h"
#include <string.h>
#include <stdlib.h>
// Windows 无 gethostname 头/无 getifaddrs,相关 POSIX 头只在不区分平台的
// 分支里引入,保证 win runner 上 moon build 照常通过
#if !defined(_WIN32) && !defined(_WIN64)
#include <unistd.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <ifaddrs.h>
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

// /api/status 的 hostname 字段:daemon 所在机器的主机名(gethostname,
// Unix/Termux 即 Linux 与 Android 均有效)。取不到(系统调用失败/结果为空)
// 返回空串,MoonBit 侧据此不上线该字段(缺省 = 旧后端口径,前端不显示)。
// Windows 侧 gethostname 需要链接 winsock2,这里退 COMPUTERNAME 环境变量
// (Rust 侧 current_hostname 同口径);取不到同样返回空串。
moonbit_string_t syncx_status_hostname(void) {
#if defined(_WIN32) || defined(_WIN64)
  const char *name = getenv("COMPUTERNAME");
  if (name == NULL || name[0] == '\0') {
    return ascii_str("");
  }
  return ascii_str(name);
#else
  char buf[256];
  memset(buf, 0, sizeof(buf));
  if (gethostname(buf, sizeof(buf) - 1) != 0) {
    return ascii_str("");
  }
  buf[sizeof(buf) - 1] = '\0';
  return ascii_str(buf);
#endif
}

// /api/status 的 localAddresses 字段:局域网 IPv4 列表,口径对齐 Node 的
// getLanAddresses(src/net/addresses.ts):
//   - 只取 AF_INET(IPv4),IPv6 不进列表;
//   - 排除回环(127.x)与链路本地(169.254.x);
//   - 不按接口名过滤(lo/docker/veth 等):回环已被 127.x 口径挡住,
//     docker/veth 上的真实 IPv4 对「对端可达地址」同样成立。
// 多值返回选「C 侧拼 JSON 数组字符串,MoonBit 侧 @json.parse 拆包」:
// 地址全是 ASCII 点分数字,无需转义;跨 FFI 只传一个字符串,内存管理全部
// 收在本次调用内(getifaddrs 遍历完即 freeifaddrs),最简单也最安全。
// 取不到(getifaddrs 失败/无合格地址)返回 "[]";Windows 无 getifaddrs,
// 固定回 "[]"(MoonBit 侧视作取不到,字段不上线 = 旧后端口径)。
moonbit_string_t syncx_status_lan_addresses(void) {
#if defined(_WIN32) || defined(_WIN64)
  return ascii_str("[]");
#else
  struct ifaddrs *ifs = NULL;
  if (getifaddrs(&ifs) != 0 || ifs == NULL) {
    return ascii_str("[]");
  }
  char buf[4096];
  size_t used = 0;
  buf[used++] = '[';
  for (struct ifaddrs *ifa = ifs; ifa != NULL; ifa = ifa->ifa_next) {
    if (ifa->ifa_addr == NULL || ifa->ifa_addr->sa_family != AF_INET) {
      continue;
    }
    struct sockaddr_in *sa = (struct sockaddr_in *)ifa->ifa_addr;
    const unsigned char *ip_bytes = (const unsigned char *)&sa->sin_addr;
    if (ip_bytes[0] == 127) {
      continue; // 回环
    }
    if (ip_bytes[0] == 169 && ip_bytes[1] == 254) {
      continue; // 链路本地
    }
    char ip[INET_ADDRSTRLEN];
    if (inet_ntop(AF_INET, &sa->sin_addr, ip, sizeof(ip)) == NULL) {
      continue;
    }
    size_t n = strlen(ip);
    // 尾部预留 ']' 与 '\0'(外加引号/逗号余量),超出即封口;实际网卡数远达不到
    if (used + n + 4 >= sizeof(buf)) {
      break;
    }
    if (used > 1) {
      buf[used++] = ',';
    }
    buf[used++] = '"';
    memcpy(buf + used, ip, n);
    used += n;
    buf[used++] = '"';
  }
  freeifaddrs(ifs);
  buf[used++] = ']';
  buf[used] = '\0';
  return ascii_str(buf);
#endif
}
