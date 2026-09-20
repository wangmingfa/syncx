/**
 * 文件类别判定:哪些文件在对比弹窗里能「看图」而不是「看字」。
 *
 * 两条信息由这里统一给出,后端三处(本机读取 / 对端索取 / 本机取字节)必须用同一份,
 * 否则会出现「本机说能预览、对端却拒绝回传」这类只在特定大小下暴露的不一致:
 *  - `imageMimeOf` —— 后缀 → MIME(同时就是「是不是可预览图片」的判据);
 *  - `compareContentLimit` —— 该文件走哪个体积上限。
 *
 * 上限按类型分档,是因为两类文件「值得看」的体量差一个量级:文本超过 2 MiB 已经
 * 逐行读不动了,而截图/照片动辄好几 MB,2 MiB 会把最需要「看一眼差在哪」的文件
 * 挡在门外。图片给到 8 MiB(两侧 base64 后 ×4/3,再一起进一份 JSON)。
 */
export const TEXT_COMPARE_MAX_BYTES = 2 * 1024 * 1024;
export const IMAGE_PREVIEW_MAX_BYTES = 8 * 1024 * 1024;

/**
 * 可预览图片的后缀 → MIME。
 *
 * 只收**浏览器能直接解码**的格式:`.tiff`(Chromium 不支持)这类即便后缀看着是图片
 * 也故意不在表里 —— 放进去只会得到一个坏图标的 <img>,还不如老实降级成「二进制,不可预览」。
 * `.svg` 也在表里:它既是图片,又是可读文本,前端两种视图都拿得到(见 FileDiffModal)。
 */
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  svg: 'image/svg+xml',
};

/**
 * 取路径最后一段的小写后缀(不含点)。隐藏文件(`.env`)、无后缀、以点开头的一律返回空串。
 *
 * 与 Web 端 `web/utils/file-icon.ts` 的 `extOf` 同规则(两边各自持有:src 与 web 是
 * 两个独立的 tsconfig 工程,不互相 import)。
 */
function extOf(filePath: string): string {
  const base = filePath.slice(filePath.lastIndexOf('/') + 1);
  const i = base.lastIndexOf('.');
  if (i <= 0) return '';
  return base.slice(i + 1).toLowerCase();
}

/** 可预览图片的 MIME;不是(可预览的)图片返回 undefined。仅按后缀判定,不嗅探内容。 */
export function imageMimeOf(filePath: string): string | undefined {
  return IMAGE_MIME[extOf(filePath)];
}

/** 该文件在对比通道里的体积上限:图片走预览上限,其余按文本上限。 */
export function compareContentLimit(filePath: string): number {
  return imageMimeOf(filePath) ? IMAGE_PREVIEW_MAX_BYTES : TEXT_COMPARE_MAX_BYTES;
}
