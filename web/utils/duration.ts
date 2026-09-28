/**
 * 同步耗时的人类可读形式。
 *
 * 分档规则(逐级只保留最高一档 + 其次一档,更低位丢弃):
 *   < 1s      → 小于1秒
 *   < 1min    → N秒
 *   < 1h      → N分钟[M秒]      ← 分钟档保留余秒
 *   < 1天     → N小时[M分钟]    ← 小时档丢弃秒
 *   ≥ 1天     → N天[M小时]
 *
 * 两处刻意的不对称:
 *  - **分钟档留余秒、小时档不留**:1分59秒 显示成「1分钟」会让人误判它和 1分01秒
 *    差不多,而这一档正是"这次同步到底慢不慢"最关心的区间;到小时档,秒已经无意义,
 *    带上只会让文案变长、列宽抖动。
 *  - **亚秒单独一档而不是显示「0秒」**:耗时 0 与"快到一个计时粒度里量不出来"是两件
 *    不同的事,写成「0秒」会被读成前者(像是根本没传)。
 *
 * 余数为 0 时省略低档:120s → 「2分钟」而不是「2分钟0秒」。
 */
export function formatDuration(ms: number | undefined | null): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';

  if (ms < 1000) return '小于1秒';

  const total = Math.floor(ms / 1000);
  if (total < 60) return `${total}秒`;

  if (total < 3600) {
    const m = Math.floor(total / 60);
    const s = total % 60;
    return s ? `${m}分钟${s}秒` : `${m}分钟`;
  }

  if (total < 86400) {
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    return m ? `${h}小时${m}分钟` : `${h}小时`;
  }

  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  return h ? `${d}天${h}小时` : `${d}天`;
}
