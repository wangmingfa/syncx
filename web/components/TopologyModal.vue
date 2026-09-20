<script setup lang="ts">
import { computed } from 'vue';
import { NButton } from 'naive-ui';
import type { StatusData } from '../types';
import { buildTopology, layoutTopology, type TopoNode } from '../utils/topology';
import ModalShell from './ModalShell.vue';

const props = defineProps<{
  open: boolean;
  status: StatusData;
}>();
const emit = defineEmits<{ close: [] }>();

const W = 460;
const H = 340;

const topo = computed(() => buildTopology(props.status));
const pos = computed(() => layoutTopology(topo.value, W, H));

/** id → 展示名(节点/设备),用于中转列表里把 id 换成易读名称。 */
const labelOf = computed(() => {
  const m = new Map<string, string>();
  for (const n of topo.value.nodes) m.set(n.id, n.label);
  return m;
});
/** 目录 id → 路径末尾名,中转列表里比裸 id 好读。 */
const folderNameOf = computed(() => {
  const m = new Map<string, string>();
  for (const f of props.status.folders) m.set(f.id ?? '', f.path.split('/').filter(Boolean).pop() ?? f.id ?? '');
  return m;
});

function relTime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s} 秒前`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟前`;
  return `${Math.round(m / 60)} 小时前`;
}

const relayList = computed(() =>
  (props.status.relayActivity ?? [])
    .slice()
    .sort((a, b) => b.at - a.at)
    .slice(0, 20),
);

function nodeClass(n: TopoNode): string {
  if (n.isSelf) return 'topo-node is-self';
  return n.online ? 'topo-node is-online' : 'topo-node is-offline';
}
</script>

<template>
  <ModalShell
    :open="open"
    title="设备同步拓扑"
    description="谁和谁在同步哪些目录"
    wide
    @close="emit('close')"
  >
    <div v-if="topo.nodes.length === 0" class="empty">还没有共享目录</div>

    <template v-else>
      <!-- 关系图:同目录的设备两两相连;本机居中 -->
      <svg class="topo-svg" :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="xMidYMid meet">
        <!-- 连边 -->
        <g v-for="(e, i) in topo.edges" :key="'e' + i">
          <line
            :x1="pos.get(e.a)!.x"
            :y1="pos.get(e.a)!.y"
            :x2="pos.get(e.b)!.x"
            :y2="pos.get(e.b)!.y"
            class="topo-edge"
          />
          <text
            :x="(pos.get(e.a)!.x + pos.get(e.b)!.x) / 2"
            :y="(pos.get(e.a)!.y + pos.get(e.b)!.y) / 2 - 4"
            class="topo-edge-label"
          >{{ e.folders.map((f) => folderNameOf.get(f) || f).join('、') }}</text>
        </g>
        <!-- 节点 -->
        <g v-for="n in topo.nodes" :key="n.id" :class="nodeClass(n)">
          <circle :cx="pos.get(n.id)!.x" :cy="pos.get(n.id)!.y" r="22" class="topo-dot" />
          <text :x="pos.get(n.id)!.x" :y="pos.get(n.id)!.y + 4" class="topo-dot-label">{{ n.isSelf ? '本机' : n.label }}</text>
          <text :x="pos.get(n.id)!.x" :y="pos.get(n.id)!.y + 38" class="topo-node-sub">{{ n.isSelf ? status.deviceId : n.shortId }}</text>
          <text v-if="!n.isSelf" :x="pos.get(n.id)!.x" :y="pos.get(n.id)!.y + 52" :class="['topo-node-state', n.online ? 'is-on' : 'is-off']">{{ n.online ? '在线' : '离线' }}</text>
        </g>
      </svg>

      <!-- 图例 -->
      <div class="topo-legend">
        <span><i class="lg lg-self"></i>本机</span>
        <span><i class="lg lg-on"></i>在线</span>
        <span><i class="lg lg-off"></i>离线</span>
        <span class="topo-legend-hint">连线 = 共享同一目录</span>
      </div>

      <!-- 最近中转 -->
      <div class="topo-relay">
        <div class="topo-relay-head">最近中转活动</div>
        <div v-if="relayList.length === 0" class="topo-relay-empty">暂无中转（各设备直连同步中）</div>
        <ul v-else class="topo-relay-list">
          <li v-for="r in relayList" :key="r.folder + r.from + r.to + r.at" class="topo-relay-row">
            <span class="topo-relay-route">
              <b>{{ labelOf.get(r.from) || r.from }}</b>
              <span class="topo-relay-arrow">→ 经本机中转 →</span>
              <b>{{ labelOf.get(r.to) || r.to }}</b>
            </span>
            <span class="topo-relay-meta">{{ folderNameOf.get(r.folder) || r.folder }} · {{ relTime(r.at) }}</span>
          </li>
        </ul>
      </div>

      <p class="topo-note">
        同一共享目录内的设备两两直连；syncx 会把收到的变更<b>中转</b>给同目录其他设备，
        因此所有成员最终一致。链路上看起来像“A↔B↔C”的中枢设备，正是承担中转的节点。
      </p>
    </template>

    <template #footer>
      <n-button type="primary" @click="emit('close')">关闭</n-button>
    </template>
  </ModalShell>
</template>
