/**
 * 同步时段的客户端判定。与后端 src/config.ts 的 isWithinSchedule 同语义 ——
 * 客户端 bundle 不 import 后端模块(客户端不进 node 侧依赖),两边各留一份,
 * 改一侧务必同步改另一侧。
 *
 * 注意:这里按浏览器本地时间判定,daemon 按 daemon 本机时间执行。两者跨时区时
 * 徽标可能偏差,以 daemon 实际行为为准;徽标只做状态提示,不做门控。
 */

const SCHEDULE_RE = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/;

/** 某时刻是否处于同步时段内(空/缺省/非法 = 全天同步;支持跨午夜)。 */
export function isWithinSchedule(schedule: string | undefined, now: Date = new Date()): boolean {
  const s = schedule?.trim();
  if (!s) return true;
  const m = SCHEDULE_RE.exec(s);
  if (!m) return true;
  const h1 = Number(m[1]);
  const m1 = Number(m[2]);
  const h2 = Number(m[3]);
  const m2 = Number(m[4]);
  if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) return true;
  const from = h1 * 60 + m1;
  const to = h2 * 60 + m2;
  if (from === to) return true;
  const cur = now.getHours() * 60 + now.getMinutes();
  if (from < to) return cur >= from && cur < to;
  return cur >= from || cur < to;
}

/** 目录此刻是否「时段外」(配置了时段且当前不在窗口内)。 */
export function outsideSchedule(f: { schedule?: string }, now: Date = new Date()): boolean {
  return !!f.schedule && !isWithinSchedule(f.schedule, now);
}
