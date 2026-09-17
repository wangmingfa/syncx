<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NButton } from 'naive-ui';
import { useStatusContext } from '../composables/statusContext';
import { stripWs } from '../utils/format';
import type { FolderDiffItem, FolderDiffKind } from '../types';

const {
  status,
  diffOpen,
  diffFolder,
  diffDevice,
  diffDevices,
  diffData,
  diffLoading,
  diffError,
  closeDiff,
  runDiff,
  switchDiffDevice,
  copyDiff,
  fmtTime,
} = useStatusContext();

/**
 * 分组定义与提示。顺序即「值得看的程度」:内容错位最可疑,规则使然的差异放最后 ——
 * 后者不是故障,排在前面会把真正的问题挤下去(用户照着它去排查等于白费功夫)。
 */
const GROUPS: Array<{ kind: FolderDiffKind; label: string; hint: string; noise?: boolean }> = [
  { kind: 'content-mismatch', label: '内容错位', hint: '版本相同但内容不一致,正常不该出现' },
  { kind: 'conflict', label: '冲突', hint: '两边都改过,看 .sync-conflict-* 副本' },
  { kind: 'local-newer', label: '待推送', hint: '本机较新,应推给对端;长期不变说明推送卡住' },
  { kind: 'remote-newer', label: '待拉取', hint: '对端较新,应拉回本机;接收模式的目录里属正常' },
  { kind: 'ignored-locally', label: '本机按规则忽略', hint: '对端有、本机按忽略规则不收 —— 不是故障', noise: true },
  { kind: 'ignored-remotely', label: '对端按规则忽略', hint: '本机有、对端按它自己的规则不收 —— 不是故障', noise: true },
];

/** 每组最多直接列出多少条,超出折叠(否则一个 5000 条差异的目录会把页面拖死)。 */
const PAGE = 50;

const expanded = ref<Record<string, boolean>>({});
const showAll = ref<Record<string, boolean>>({});

// 数据刷新后重置折叠状态:「有问题的」默认展开,「规则使然」默认收起
watch(
  diffData,
  (data) => {
    const next: Record<string, boolean> = {};
    for (const g of GROUPS) next[g.kind] = data ? !g.noise : false;
    expanded.value = next;
    showAll.value = {};
  },
  { immediate: true },
);

function toggle(kind: string): void {
  expanded.value = { ...expanded.value, [kind]: !expanded.value[kind] };
}

const itemsOf = (kind: FolderDiffKind): FolderDiffItem[] =>
  diffData.value ? diffData.value.diff.items.filter((i) => i.kind === kind) : [];

const visibleOf = (kind: FolderDiffKind): FolderDiffItem[] => {
  const items = itemsOf(kind);
  return showAll.value[kind] ? items : items.slice(0, PAGE);
};

const totalDiff = computed<number>(() => {
  const counts = diffData.value?.diff.counts;
  if (!counts) return 0;
  return GROUPS.reduce((sum, g) => sum + (counts[g.kind] ?? 0), 0);
});

/**
 * 设备 id 后面的「主机名 · IP」。
 *
 * 缺项就少一项、不做占位:旧版本对端不宣告主机名、还没学到地址时没有 IP,填一个
 * 「未知」既占地方又不提供信息。对端多带一个版本号 —— 它和主机名一样是「这是哪台
 * 机器」的属性,顺带说明该版本是否支持「规则使然」这类新能力。
 */
const localWhere = computed<string>(() => {
  const d = diffData.value;
  if (!d) return '';
  return [d.localHostname, ...d.localAddresses].filter(Boolean).join(' · ');
});

const remoteWhere = computed<string>(() => {
  const d = diffData.value;
  if (!d) return '';
  return [
    d.deviceHostname ?? '',
    d.deviceUrl ? stripWs(d.deviceUrl) : '',
    d.deviceVersion ? `syncx ${d.deviceVersion}` : '',
  ].filter(Boolean).join(' · ');
});

/** 「刚刚 / N 分钟前」:一眼判断这份快照新不新。 */
function agoText(ts: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}

/** 版本向量 → `本机:2 对端:1`(第三个设备的贡献原样显示其 id)。 */
function versionText(version: Array<[string, number]>, remoteDeviceId: string): string {
  if (version.length === 0) return '无版本';
  return version
    .map(([device, count]) => {
      const label = device === status.value.deviceId ? '本机' : device === remoteDeviceId ? '对端' : device;
      return `${label}:${count}`;
    })
    .join(' ');
}

function sideText(side: FolderDiffItem['local'], remoteDeviceId: string): string {
  if (!side) return '无';
  const size = side.deleted ? '已删除' : `${side.size}B`;
  const digest = side.digest ? side.digest.slice(0, 8) : '—';
  return `${size} · ${digest} · ${versionText(side.version, remoteDeviceId)}`;
}

function progressTextOf(p?: { pending: number; sending: number; receiving: number }): string {
  if (!p) return '';
  return `发送 ${p.sending} · 接收 ${p.receiving} · 待处理 ${p.pending}`;
}

/**
 * 进度是否表示「此刻真的有传输在跑」。
 *
 * 目录的进度常态存在(空闲时是 0/0/0),所以不能只看字段有没有 —— 否则报告会对着一份
 * 完全空闲的索引说「本机此刻在传输(发送 0 · 接收 0 · 待处理 0)」,把真正有价值的提示
 * 淹掉。后端已经不再下发全 0 的进度,这里是第二道:组件不假设载荷一定干净。
 */
function transferring(p?: { pending: number; sending: number; receiving: number }): boolean {
  return !!p && p.pending + p.sending + p.receiving > 0;
}
</script>

<template>
  <Transition name="guide">
    <div v-if="diffOpen" class="modal-overlay" @click.self="closeDiff()">
      <div class="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="diff-title">
        <n-button quaternary circle class="modal-close" aria-label="关闭" @click="closeDiff()">×</n-button>
        <div class="modal-title-row">
          <h2 id="diff-title" class="modal-title">对比</h2>
          <span class="modal-title-path mono" :title="diffFolder?.path">{{ diffFolder?.path }}</span>
        </div>

        <!-- 对端选择 + 重跑:目录只指派了一个设备时只剩「重新对比」 -->
        <div v-if="diffDevices.length > 0" class="diff-bar">
          <span class="diff-bar__label">对端</span>
          <n-button
            v-for="d in diffDevices"
            :key="d"
            size="small"
            class="mono"
            :type="d === diffDevice ? 'primary' : 'default'"
            :tertiary="d !== diffDevice"
            :disabled="diffLoading"
            @click="switchDiffDevice(d)"
          >{{ d }}</n-button>
          <n-button size="small" tertiary :disabled="diffLoading" class="diff-bar__rerun" @click="runDiff">重新对比</n-button>
        </div>

        <div v-if="diffDevices.length === 0" class="empty">
          该目录还没有指派设备 · 先在目录卡的「设置」里指派后再对比
        </div>

        <div v-else-if="diffLoading" class="diff-loading">
          正在取对端的索引快照…
          <p class="diff-hint">对端离线、或版本过旧不支持该功能时会失败并给出原因。</p>
        </div>

        <div v-else-if="diffError" class="diff-error" role="alert">
          <div class="diff-error__msg break">{{ diffError }}</div>
          <n-button size="small" tertiary :disabled="diffLoading" @click="runDiff">重试</n-button>
        </div>

        <template v-else-if="diffData">
          <div class="diff-meta">
            对端快照取自 {{ fmtTime(diffData.remoteAt) }}（{{ agoText(diffData.remoteAt) }}）·
            本机索引 {{ diffData.diff.localTotal }} 条 · 对端 {{ diffData.diff.remoteTotal }} 条 ·
            双方一致 {{ diffData.diff.counts['in-sync'] }} 条
          </div>

          <!-- 设备身份:本机 / 对端各一行(主机名 + IP)。多设备时「在跟哪台机器比」比设备
               id 好认,也便于确认这份报告出自哪台机器(同一台机器开多个界面时尤其明显)。 -->
          <div class="diff-legend mono">
            <div class="diff-legend__row">
              <span class="diff-legend__role">本机</span>
              <span class="diff-legend__id">{{ status.deviceId }}</span>
              <span v-if="localWhere" class="diff-legend__where">{{ localWhere }}</span>
            </div>
            <div class="diff-legend__row">
              <span class="diff-legend__role">对端</span>
              <span class="diff-legend__id">{{ diffData.deviceId }}</span>
              <span v-if="remoteWhere" class="diff-legend__where">{{ remoteWhere }}</span>
            </div>
          </div>

          <!-- 报告可信度提示:传输中 / 对端规则缺失都会让结论打折,先讲清楚 -->
          <p v-if="transferring(diffData.localProgress)" class="diff-note">
            本机此刻在传输（{{ progressTextOf(diffData.localProgress) }}），本报告可能含传输中的中间态。
          </p>
          <p v-if="transferring(diffData.remoteProgress)" class="diff-note">
            对端此刻在传输（{{ progressTextOf(diffData.remoteProgress) }}），本报告可能含传输中的中间态。
          </p>
          <p v-if="!diffData.diff.remoteRulesKnown" class="diff-note">
            对端未提供忽略规则（版本较旧），「规则使然」的差异无法区分，已按普通差异计入。
          </p>

          <div v-if="totalDiff === 0" class="diff-clean">
            <span class="diff-clean__mark" aria-hidden="true">✔</span>
            没有差异：两端同一目录 id 的内容一致。
          </div>

          <div v-else class="diff-groups">
            <section v-for="g in GROUPS" :key="g.kind" class="diff-group">
              <button
                v-if="itemsOf(g.kind).length > 0"
                type="button"
                class="diff-group__head"
                :aria-expanded="expanded[g.kind] === true"
                @click="toggle(g.kind)"
              >
                <span class="diff-group__caret" :class="{ 'is-open': expanded[g.kind] }" aria-hidden="true">▸</span>
                <span class="diff-group__label">{{ g.label }}</span>
                <span class="diff-group__count" :class="{ 'is-noise': g.noise }">{{ itemsOf(g.kind).length }}</span>
                <span class="diff-group__hint">{{ g.hint }}</span>
              </button>

              <ul v-if="itemsOf(g.kind).length > 0 && expanded[g.kind]" class="diff-items">
                <li v-for="item in visibleOf(g.kind)" :key="item.path" class="diff-item">
                  <div class="diff-item__path mono break">{{ item.path }}</div>

                  <div v-if="item.rule" class="diff-item__rule">
                    命中规则 <code class="mono">{{ item.rule }}</code>
                    <span v-if="item.hard" class="diff-chip diff-chip--hard">硬忽略,不可解除</span>
                  </div>

                  <template v-else>
                    <div class="diff-item__side">
                      <span class="diff-item__side-label">本机</span>
                      <span class="mono">{{ sideText(item.local, diffData.deviceId) }}</span>
                    </div>
                    <div class="diff-item__side">
                      <span class="diff-item__side-label">对端</span>
                      <span class="mono">{{ sideText(item.remote, diffData.deviceId) }}</span>
                    </div>
                  </template>

                  <div v-if="item.disk === 'missing'" class="diff-item__warn">本机盘上已无此文件 —— 索引陈旧,不是两端不同步</div>
                  <div v-else-if="item.disk === 'size-differs'" class="diff-item__warn">本机盘上大小与索引不符 —— 索引陈旧</div>
                </li>
                <li v-if="itemsOf(g.kind).length > PAGE && !showAll[g.kind]" class="diff-more">
                  <n-button size="tiny" tertiary @click="showAll = { ...showAll, [g.kind]: true }">
                    展开全部 {{ itemsOf(g.kind).length }} 条
                  </n-button>
                </li>
              </ul>
            </section>
          </div>
        </template>

        <!-- 操作行常驻:加载中/出错时也要有关闭入口(不能只靠右上角的 ×) -->
        <div class="modal-actions">
          <n-button :disabled="!diffData || totalDiff === 0" @click="copyDiff">复制结果</n-button>
          <n-button type="primary" @click="closeDiff()">关闭</n-button>
        </div>
      </div>
    </div>
  </Transition>
</template>
