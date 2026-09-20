/**
 * 字节数 → 人读的大小。抽出来是因为对比弹窗与升级弹窗都要用同一套口径 ——
 * 两处各写一份的话,「同一个文件在两边显示成 2.4 MB 与 2 MB」这类不一致迟早出现。
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
