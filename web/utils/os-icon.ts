/**
 * process.platform 字符串 → 操作系统图标类别。纯函数,便于单测(与 file-icon.ts 同构:
 * 图标组件只管画,「该画哪一个」的判定单独留在这里)。
 *
 * 只认三个真实会出现在 syncx 部署面上的值,其余一律归 `unknown`:
 *  - `win32` → Windows(node:process.platform 在 Windows 上恒为 'win32',与 32/64 位无关,
 *    别被这个数字骗过去找「Windows 3.x」的图标)
 *  - `darwin` → macOS
 *  - `linux` → Linux
 *
 * 为什么不「拿 unknown 当 Linux 凑数」:图标是提示、不是判定依据,但**画错的提示比没有提示
 * 更坏** —— 把 freebsd 画成 Tux,用户就会拿 Linux 的路子去排查一台根本不是 Linux 的机器。
 * 未知平台该长得像「我不知道」,而不是像某个我知道的平台。
 *
 * undefined 也走 unknown:后端的 platform 是新增字段,拿的是对端 hello 宣告,
 * 旧版本对端不发这个字段(undefined),此时宁可显示中性图标也不能空出一个位置。
 */
export type OsIconKind = 'windows' | 'macos' | 'linux' | 'unknown';

export function osIconKind(platform: string | undefined): OsIconKind {
  switch (platform) {
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'macos';
    case 'linux':
      return 'linux';
    default:
      return 'unknown';
  }
}

/** 图标的可读名称,给 title / aria-label 用。
 *  形状 + 颜色是本组件唯一的状态载体,色觉障碍用户在深色主题下可能只看到「一个灰图形」,
 *  这条文本是唯一的兜底通道。 */
export function osIconLabel(platform: string | undefined): string {
  switch (osIconKind(platform)) {
    case 'windows':
      return 'Windows';
    case 'macos':
      return 'macOS';
    case 'linux':
      return 'Linux';
    default:
      return '未知系统';
  }
}
