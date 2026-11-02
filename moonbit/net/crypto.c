// syncx/net 系统熵源的最小 C stub。
//
// 密码学原语(SHA-256 / Ed25519 / X25519)已整体切换到三方库
// mooncakes.io `cc06b/mooncry`(纯 MoonBit 实现,见 identity.mbt 与
// handshake.mbt),但 mooncry 不含安全随机数,身份密钥与一次性 X25519
// 私钥的 32 字节熵仍从这里取。跨平台熵源:
//   - Windows:CryptGenRandom;
//   - macOS/BSD:arc4random_buf;
//   - Linux:getrandom(2),回退 /dev/urandom。

#include "crypto.h"

#include <stdlib.h>

#if defined(_WIN32)
#include <windows.h>
#include <wincrypt.h>
#elif defined(__APPLE__) || defined(__OpenBSD__) || defined(__FreeBSD__)
#include <stdlib.h>
#else
#include <errno.h>
#include <sys/random.h>
#include <stdio.h>
#include <unistd.h>
#endif

// 填充密码学随机字节。返回 0 = 成功,非 0 = 熵源不可用。
static int fill_random(unsigned char *out, size_t n) {
#if defined(_WIN32)
    HCRYPTPROV prov = 0;
    if (!CryptAcquireContextA(&prov, NULL, NULL, PROV_RSA_FULL, CRYPT_VERIFYCONTEXT)) {
        return -1;
    }
    if (!CryptGenRandom(prov, (DWORD)n, out)) {
        CryptReleaseContext(prov, 0);
        return -1;
    }
    CryptReleaseContext(prov, 0);
    return 0;
#elif defined(__APPLE__) || defined(__OpenBSD__) || defined(__FreeBSD__)
    arc4random_buf(out, n);
    return 0;
#else
    // Linux:优先 getrandom(2)(可能部分填充,循环补齐;被信号打断亦重试),
    // 内核不支持时回退 /dev/urandom。
    size_t done = 0;
    while (done < n) {
        ssize_t r = getrandom(out + done, n - done, 0);
        if (r < 0) {
            if (errno == EINTR) {
                continue;
            }
            done = (size_t)-1;
            break;
        }
        done += (size_t)r;
    }
    if (done != (size_t)-1) {
        return 0;
    }
    FILE *f = fopen("/dev/urandom", "rb");
    if (f == NULL) {
        return -1;
    }
    size_t got = fread(out, 1, n, f);
    fclose(f);
    return got == n ? 0 : -1;
#endif
}

// 失败(长度为负/熵源不可用)按约定返回 0 长度 Bytes,上层用长度判断抛错。
moonbit_bytes_t syncx_random_bytes(int32_t len) {
    if (len < 0) {
        return moonbit_make_bytes(0, 0);
    }
    moonbit_bytes_t out = moonbit_make_bytes(len, 0);
    if (len > 0 && fill_random(out, (size_t)len) != 0) {
        return moonbit_make_bytes(0, 0);
    }
    return out;
}
