import type { IndexEntry } from './index.js';
import { compareFileState } from './index.js';

export type PlanAction =
  | { kind: 'send'; path: string; entry: IndexEntry }
  | { kind: 'receive'; path: string; entry: IndexEntry }
  | { kind: 'delete'; path: string }
  | { kind: 'conflict'; path: string; local: IndexEntry; remote: IndexEntry };

/** 单个路径的收敛动作;双方一致时返回 undefined(无动作)。 */
export function planPath(
  path: string,
  localEntry: IndexEntry | undefined,
  remoteEntry: IndexEntry | undefined,
): PlanAction | undefined {
  const relation = compareFileState(localEntry, remoteEntry);

  switch (relation) {
    case 'equal':
      return undefined;
    case 'local-newer':
      if (localEntry!.deleted) {
        return { kind: 'delete', path };
      }
      return { kind: 'send', path, entry: localEntry! };
    case 'remote-newer':
      if (remoteEntry!.deleted) {
        return { kind: 'delete', path };
      }
      return { kind: 'receive', path, entry: remoteEntry! };
    case 'conflict':
      return { kind: 'conflict', path, local: localEntry!, remote: remoteEntry! };
  }
}

/**
 * Compare the local and remote indexes and produce the actions
 * that would bring them into agreement.
 *
 * 并集语义:只适用于**全量**索引——对端这条消息声明了它索引的全部内容,
 * 因此「本机有、消息里没有」确实意味着对端缺失,应当回推。
 */
export function buildPlan(
  local: Map<string, IndexEntry>,
  remote: Map<string, IndexEntry>,
): PlanAction[] {
  const actions: PlanAction[] = [];
  const paths = new Set([...local.keys(), ...remote.keys()]);

  for (const path of paths) {
    const action = planPath(path, local.get(path), remote.get(path));
    if (action) actions.push(action);
  }

  return actions;
}

/**
 * 增量(本轮改动)索引的规划:**只对消息里明确提到的路径**判定。
 *
 * 这里绝不能沿用 buildPlan 的并集语义。增量消息只包含「本轮改动的那几条」,
 * 「本机有、消息里没有」只说明对端这轮没提它,绝不等于对端缺失。若按并集回推,
 * 两端就会交替把「对方没提到的本地条目」互推:19 条改动 → 对端回推 246 条 →
 * 本机再回推 19 条 …… 无限循环(2026-09-16 两端卡片空转、CPU 半核的事故形态),
 * 且因为每轮条目版本其实相等,全程静默:不落盘、不记历史、不打日志。
 */
export function buildDeltaPlan(
  local: Map<string, IndexEntry>,
  remote: Map<string, IndexEntry>,
): PlanAction[] {
  const actions: PlanAction[] = [];

  for (const [path, remoteEntry] of remote) {
    const action = planPath(path, local.get(path), remoteEntry);
    if (action) actions.push(action);
  }

  return actions;
}
