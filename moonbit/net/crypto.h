// syncx/net 系统熵源的 C FFI 边界(最小 stub)。
//
// 密码学原语已切换到三方库 cc06b/mooncry(纯 MoonBit),这里只剩安全随机数:
//   - Windows CryptGenRandom / macOS·BSD arc4random_buf /
//     Linux getrandom(2) 回退 /dev/urandom。
//
// 约定:失败返回 **0 长度 Bytes**(不返回 NULL),上层用长度判断优雅抛错。
#ifndef SYNCX_NET_CRYPTO_H
#define SYNCX_NET_CRYPTO_H

#include <stdint.h>
#include "moonbit.h"

// 密码学随机字节;失败返回 0 长度 Bytes。
moonbit_bytes_t syncx_random_bytes(int32_t len);

#endif
