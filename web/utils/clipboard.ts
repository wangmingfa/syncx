/**
 * 将文本写入系统剪贴板,兼容非安全上下文(局域网 HTTP / 老浏览器)。
 *
 * 优先使用现代异步 Clipboard API(navigator.clipboard,需安全上下文:
 * localhost 或 https);受限时降级到临时 textarea + document.execCommand('copy')。
 *
 * 与 toast 解耦:本函数只负责「写入剪贴板」并返回是否成功,提示文案由调用方决定
 * (不同场景的文案不同,如「已复制全部日志」/「已复制全部同步记录」)。
 *
 * @param text 待复制的文本(空字符串直接返回 false)
 * @returns 是否成功写入剪贴板
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;

  // 1. 优先现代 Clipboard API(安全上下文:localhost 或 https)
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 落到降级分支
    }
  }

  // 2. 降级:临时 textarea + execCommand(局域网 http / 老浏览器兜底)
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
