import { describe, expect, it } from 'vitest';
import { buildTopology, layoutTopology } from '../web/utils/topology.js';
import type { StatusData } from '../web/types.js';

function statusWith(folders: StatusData['folders'], devices: StatusData['devices']): StatusData {
  return {
    deviceId: 'self000000',
    entries: 0,
    tombstones: 0,
    folders,
    devices,
    syncProgress: [],
    offers: [],
  };
}

describe('buildTopology', () => {
  it('单目录三设备 => 三角全连', () => {
    const folders = [{ id: 'f1', path: '/x', devices: ['self000000', 'aaa111', 'bbb222'] }];
    const devices = [
      { deviceId: 'self000000', online: true, folders: ['f1'] },
      { deviceId: 'aaa111', online: true, hostname: 'alpha', folders: ['f1'] },
      { deviceId: 'bbb222', online: false, folders: ['f1'] },
    ];
    const topo = buildTopology(statusWith(folders, devices));
    expect(topo.nodes.map((n) => n.id).sort()).toEqual(['aaa111', 'bbb222', 'self000000']);
    // 3 个节点两两相连 = 3 条边
    expect(topo.edges).toHaveLength(3);
    const pairKeys = topo.edges.map((e) => [e.a, e.b].sort().join('|')).sort();
    expect(pairKeys).toEqual(
      ['aaa111|bbb222', 'aaa111|self000000', 'bbb222|self000000'].sort(),
    );
    // 每条边都标注了共享目录 f1
    expect(topo.edges.every((e) => e.folders.includes('f1'))).toBe(true);
  });

  it('两个目录形成 A-B-C 链(无 A-C 直连)', () => {
    const folders = [
      { id: 'f1', path: '/x', devices: ['self000000', 'aaa111'] },
      { id: 'f2', path: '/y', devices: ['aaa111', 'bbb222'] },
    ];
    const devices = [
      { deviceId: 'self000000', online: true, folders: ['f1'] },
      { deviceId: 'aaa111', online: true, folders: ['f1', 'f2'] },
      { deviceId: 'bbb222', online: true, folders: ['f2'] },
    ];
    const topo = buildTopology(statusWith(folders, devices));
    // self 与 bbb222 没有直接共同目录 => 无 self-bbb222 边
    const hasSelfB = topo.edges.some(
      (e) => (e.a === 'self000000' && e.b === 'bbb222') || (e.a === 'bbb222' && e.b === 'self000000'),
    );
    expect(hasSelfB).toBe(false);
    // aaa111 是中枢:与 self、bbb222 都相连
    const aaaEdges = topo.edges.filter((e) => e.a === 'aaa111' || e.b === 'aaa111');
    expect(aaaEdges).toHaveLength(2);
  });

  it('共享同一目录的多条目录边被合并累加', () => {
    const folders = [
      { id: 'f1', path: '/x', devices: ['self000000', 'aaa111'] },
      { id: 'f2', path: '/z', devices: ['self000000', 'aaa111'] },
    ];
    const devices = [
      { deviceId: 'self000000', online: true, folders: ['f1', 'f2'] },
      { deviceId: 'aaa111', online: true, folders: ['f1', 'f2'] },
    ];
    const topo = buildTopology(statusWith(folders, devices));
    expect(topo.edges).toHaveLength(1);
    expect(topo.edges[0]!.folders.sort()).toEqual(['f1', 'f2']);
  });

  it('无目录 => 只有本机节点、无边', () => {
    const topo = buildTopology(statusWith([], [{ deviceId: 'self000000', online: true, folders: [] }]));
    expect(topo.nodes).toHaveLength(1);
    expect(topo.nodes[0]!.isSelf).toBe(true);
    expect(topo.edges).toHaveLength(0);
  });

  it('在线/离线与标签取主机名', () => {
    const folders = [{ id: 'f1', path: '/x', devices: ['self000000', 'aaa111'] }];
    const devices = [
      { deviceId: 'self000000', online: true, folders: ['f1'] },
      { deviceId: 'aaa111', online: false, hostname: 'alpha', folders: ['f1'] },
    ];
    const topo = buildTopology(statusWith(folders, devices));
    const a = topo.nodes.find((n) => n.id === 'aaa111')!;
    expect(a.online).toBe(false);
    expect(a.label).toBe('alpha');
    expect(a.shortId).toBe('aaa111');
  });
});

describe('layoutTopology', () => {
  it('本机居中、其余落在圆周、确定性', () => {
    const topo = buildTopology(
      statusWith(
        [{ id: 'f1', path: '/x', devices: ['self000000', 'aaa111', 'bbb222'] }],
        [
          { deviceId: 'self000000', online: true, folders: ['f1'] },
          { deviceId: 'aaa111', online: true, folders: ['f1'] },
          { deviceId: 'bbb222', online: true, folders: ['f1'] },
        ],
      ),
    );
    const pos = layoutTopology(topo, 400, 400);
    expect(pos.get('self000000')).toEqual({ x: 200, y: 200 });
    expect(pos.size).toBe(3);
    // 两次布局一致(确定性)
    const pos2 = layoutTopology(topo, 400, 400);
    expect([...pos.entries()]).toEqual([...pos2.entries()]);
  });
});
