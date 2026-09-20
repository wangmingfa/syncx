/**
 * 共享关系拓扑:把 status 载荷推导成「设备节点 + 目录连边」的图。
 *
 * 设计口径(与 ADR-0014 一致):
 *  - 同一共享目录的 devices 列表里的设备,彼此**两两直连**(目录会话是全 mesh);
 *  - syncx 收到某设备的变更后会**中转**给同目录其他设备,因此所有成员最终一致;
 *    中转是「同目录会话内单跳」,所以图里不存在真实的二级以上跳数,链路(如 A↔B↔C)
 *    是「共享关系」而非网络跳数。
 *  - 视图只依赖 status 里已有的 folders/devices 配置,纯前端计算,不需要后端新接口。
 */
import type { StatusData } from '../types.js';

export interface TopoNode {
  id: string;
  isSelf: boolean;
  online: boolean;
  hostname?: string;
  /** 展示用名称:优先主机名,否则短 id。 */
  label: string;
  /** id 末 6 位,作为节点副标识。 */
  shortId: string;
  /** 该设备被指派到的目录 id 列表。 */
  folders: string[];
}

export interface TopoEdge {
  a: string;
  b: string;
  /** a、b 共同所在的目录 id 列表(连边上的标签)。 */
  folders: string[];
}

export interface Topology {
  selfId: string;
  nodes: TopoNode[];
  edges: TopoEdge[];
}

function shortId(id: string): string {
  return id.length > 6 ? id.slice(-6) : id;
}

function nodeLabel(hostname: string | undefined, id: string): string {
  return hostname ?? shortId(id);
}

/** 从 status 推导共享关系图。 */
export function buildTopology(status: StatusData): Topology {
  const selfId = status.deviceId;
  const deviceById = new Map(status.devices.map((d) => [d.deviceId, d]));

  // 收集所有出现在某个目录 devices 里的设备 id(去重),并保证本机一定在内
  const ids = new Set<string>([selfId]);
  for (const f of status.folders) {
    for (const d of f.devices ?? []) ids.add(d);
  }

  // 节点
  const nodes: TopoNode[] = [];
  for (const id of ids) {
    const dev = deviceById.get(id);
    nodes.push({
      id,
      isSelf: id === selfId,
      online: dev?.online ?? false,
      hostname: dev?.hostname,
      label: nodeLabel(dev?.hostname, id),
      shortId: shortId(id),
      folders: dev?.folders ?? [],
    });
  }

  // 连边:每个目录内两两相连,按设备对去重并累加共享目录
  const edgeMap = new Map<string, TopoEdge>();
  for (const f of status.folders) {
    const members = (f.devices ?? []).filter((d) => ids.has(d));
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const x = members[i]!;
        const y = members[j]!;
        // 规范化两端顺序,保证同一设备对(跨目录出现时)命中同一条边
        const [a, b] = x < y ? [x, y] : [y, x];
        const key = `${a} ${b}`;
        const folderId = f.id ?? '';
        const existing = edgeMap.get(key);
        if (existing) {
          if (folderId && !existing.folders.includes(folderId)) existing.folders.push(folderId);
        } else {
          edgeMap.set(key, { a, b, folders: folderId ? [folderId] : [] });
        }
      }
    }
  }

  return { selfId, nodes, edges: [...edgeMap.values()] };
}

/**
 * 确定性布局:本机居中,其余节点均匀分布在半径 R 的圆周上(按 id 排序保证稳定)。
 * 返回节点 id → 坐标。viewBox 以 (0,0) 为左上、宽高由调用方给定。
 */
export function layoutTopology(
  topo: Topology,
  width: number,
  height: number,
): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>();
  const cx = width / 2;
  const cy = height / 2;
  const others = topo.nodes
    .filter((n) => !n.isSelf)
    .sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
  if (topo.nodes.length === 1) {
    pos.set(topo.selfId, { x: cx, y: cy });
    return pos;
  }
  const radius = Math.min(width, height) / 2 - 70;
  pos.set(topo.selfId, { x: cx, y: cy });
  others.forEach((n, i) => {
    const angle = (i / others.length) * Math.PI * 2 - Math.PI / 2;
    pos.set(n.id, { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) });
  });
  return pos;
}
