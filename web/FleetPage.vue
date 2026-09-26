<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { NButton, NInput } from 'naive-ui';
import ToastView from './components/ToastView.vue';
import { useToast } from './composables/useToast';
import { apiPost, errText } from './utils/api';
import type { StatusData } from './types';

/**
 * 多实例集中管理页(路由 /fleet)。
 *
 * 一个 UI 看管多台 daemon:实例注册表(url + 控制令牌)存**浏览器本地**
 * (localStorage)—— 这台"控制台"属于操作者本人,不该写进任何一台 daemon 的
 * 配置里被别的浏览器/机器看到。
 *
 * 跨 daemon 请求全部经本机 /api/fleet/call 白名单代理转发(远端 daemon 没有
 * CORS,浏览器直连读不到响应;详见 src/api/routes/fleet.ts)。本页只转三个
 * 端点:status(看)、pause(停)、folders/pause(单目录停)。令牌只在本机
 * 代理请求的头里出现,状态卡片不回显。
 */

interface FleetInstance {
  /** 稳定 id(添加时生成,做 v-for key 与状态映射)。 */
  id: string;
  name: string;
  url: string;
  token: string;
}

/** 每个实例的运行态:最近一次代理结果。 */
interface InstanceView {
  loading: boolean;
  status: StatusData | null;
  /** 不可达原因(网络/超时/远端 401 等);null = 上次探测成功。 */
  error: string | null;
  /** 最近一次成功探测的时刻(毫秒),用于"多久没更新了"。 */
  lastOk: number | null;
}

const STORAGE_KEY = 'syncx.fleet.v1';
const POLL_MS = 15_000;

const { showToast } = useToast();

const instances = ref<FleetInstance[]>([]);
const views = ref<Record<string, InstanceView>>({});

// 添加表单
const formUrl = ref('');
const formToken = ref('');
const formName = ref('');
const adding = ref(false);

function loadRegistry(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const list = JSON.parse(raw) as FleetInstance[];
    if (Array.isArray(list)) {
      instances.value = list.filter((x) => x && typeof x.url === 'string' && typeof x.token === 'string');
    }
  } catch {
    // 注册表坏了:当作空,下一次保存会覆盖
  }
}

function saveRegistry(): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(instances.value));
}

type FleetCall = 'status' | 'pause' | 'folderPause';

/** 经本机代理调远端;返回信封里的 data(失败抛错,错误文案可直接 toast)。 */
async function call(inst: FleetInstance, kind: FleetCall, body?: unknown): Promise<{ status: number; data: unknown }> {
  const path = kind === 'status' ? '/api/status' : kind === 'pause' ? '/api/pause' : '/api/folders/pause';
  const env = await apiPost<{
    ok: boolean;
    status?: number;
    data?: unknown;
    error?: string;
  }>('/api/fleet/call', { url: inst.url, token: inst.token, path, ...(body !== undefined ? { body } : {}) });
  if (!env.ok) throw new Error(env.error ?? '远端不可达');
  if (env.status !== undefined && env.status >= 400) {
    throw new Error(env.status === 401 ? '令牌无效(远端拒绝)' : `远端返回 ${env.status}`);
  }
  return { status: env.status ?? 200, data: env.data };
}

async function probe(inst: FleetInstance): Promise<void> {
  const v = (views.value[inst.id] ??= { loading: false, status: null, error: null, lastOk: null });
  v.loading = true;
  try {
    const { data } = await call(inst, 'status');
    v.status = data as StatusData;
    v.error = null;
    v.lastOk = Date.now();
  } catch (e) {
    v.error = errText(e, '探测失败');
  } finally {
    v.loading = false;
    views.value = { ...views.value };
  }
}

async function probeAll(): Promise<void> {
  await Promise.all(instances.value.map((i) => probe(i)));
}

async function togglePause(inst: FleetInstance): Promise<void> {
  const paused = !(views.value[inst.id]?.status?.paused ?? false);
  try {
    await call(inst, 'pause', { paused });
    showToast(paused ? `已暂停 ${labelOf(inst)} 的同步` : `已恢复 ${labelOf(inst)} 的同步`);
    await probe(inst);
  } catch (e) {
    showToast(errText(e, '操作失败'), 'alert');
  }
}

function openUi(inst: FleetInstance): void {
  window.open(inst.url, '_blank', 'noopener');
}

function labelOf(inst: FleetInstance): string {
  const s = views.value[inst.id]?.status;
  return inst.name || s?.hostname || inst.url;
}

async function addInstance(): Promise<void> {
  const url = formUrl.value.trim();
  const token = formToken.value.trim();
  if (!url || !token) {
    showToast('url 与控制令牌都不能为空', 'alert');
    return;
  }
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('scheme');
    if (u.pathname !== '/' && u.pathname !== '') throw new Error('path');
  } catch {
    showToast('url 须为 http(s) 地址且不含路径(如 http://192.168.1.20:8384)', 'alert');
    return;
  }
  adding.value = true;
  const inst: FleetInstance = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: formName.value.trim(),
    url,
    token,
  };
  instances.value = [...instances.value, inst];
  saveRegistry();
  formUrl.value = '';
  formToken.value = '';
  formName.value = '';
  adding.value = false;
  await probe(inst);
}

function removeInstance(inst: FleetInstance): void {
  instances.value = instances.value.filter((x) => x.id !== inst.id);
  const rest = { ...views.value };
  delete rest[inst.id];
  views.value = rest;
  saveRegistry();
}

let pollTimer: ReturnType<typeof setInterval> | undefined;

onMounted(() => {
  loadRegistry();
  if (instances.value.length) void probeAll();
  pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible' && instances.value.length) void probeAll();
  }, POLL_MS);
});

onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer);
});

/** 卡片副行:目录数 / 设备在线数 / 索引条目数;缺项显示 –。 */
function summaryOf(s: StatusData | null): string {
  if (!s) return '';
  const devs = s.devices ?? [];
  const online = devs.filter((d) => d.online).length;
  return `${s.folders?.length ?? 0} 个目录 · ${online}/${devs.length} 台设备在线 · ${s.entries ?? 0} 条索引`;
}

function agoOf(ms: number | null): string {
  if (!ms) return '';
  const d = Math.max(0, Date.now() - ms);
  return d < 20_000 ? '刚刚' : `${Math.round(d / 1000)}s 前`;
}
</script>

<template>
  <div class="fl-page">
    <ToastView />

    <header class="fl-top">
      <a class="fl-back" href="/" title="返回状态页">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M15 18l-6-6 6-6" />
        </svg>
        <span>状态页</span>
      </a>
      <h1 class="fl-title">多实例管理</h1>
      <div class="fl-actions">
        <n-button size="small" tertiary :disabled="!instances.length" @click="probeAll">立即刷新</n-button>
      </div>
    </header>

    <main class="fl-main">
      <!-- 注册表单:url + 令牌 + 备注名;凭据只存这台浏览器的 localStorage -->
      <section class="fl-add panel">
        <div class="fl-add-title">添加实例</div>
        <div class="fl-add-row">
          <n-input v-model:value="formUrl" size="small" placeholder="http://192.168.1.20:8384" class="fl-add-url" />
          <n-input v-model:value="formToken" size="small" type="password" show-password-on="click" placeholder="该实例的控制令牌" class="fl-add-token" />
          <n-input v-model:value="formName" size="small" placeholder="备注名(可空)" class="fl-add-name" />
          <n-button size="small" type="primary" :loading="adding" @click="addInstance">添加并探测</n-button>
        </div>
        <p class="fl-hint muted">
          令牌在目标实例「设置 → 控制令牌」处获取;跨实例请求经本机 daemon 白名单代理转发(status / 暂停 / 目录暂停),其余端点不透出。
        </p>
      </section>

      <p v-if="!instances.length" class="fl-state muted">还没有登记任何实例。添加一台,这里就是它的总览卡片。</p>

      <section v-for="inst in instances" :key="inst.id" class="fl-card panel">
        <header class="fl-card-head">
          <span class="fl-dot" :class="views[inst.id]?.error ? 'is-bad' : views[inst.id]?.status ? 'is-ok' : 'is-idle'" />
          <span class="fl-card-name">{{ labelOf(inst) }}</span>
          <span class="fl-card-url mono muted">{{ inst.url }}</span>
          <span v-if="views[inst.id]?.status?.paused" class="fl-badge is-pause">{{ views[inst.id]!.status!.powerGuard ? '自动挂起' : '已暂停' }}</span>
          <span v-if="views[inst.id]?.status?.updateAvailable" class="fl-badge is-update">可更新</span>
        </header>

        <div v-if="views[inst.id]?.loading && !views[inst.id]?.status" class="fl-card-body muted">探测中…</div>
        <div v-else-if="views[inst.id]?.error" class="fl-card-body">
          <span class="fl-err">{{ views[inst.id]?.error }}</span>
        </div>
        <div v-else-if="views[inst.id]?.status" class="fl-card-body">
          <div class="fl-line">{{ summaryOf(views[inst.id]?.status ?? null) }}</div>
          <div v-if="views[inst.id]?.status?.powerGuard" class="fl-line fl-line--warn">自动挂起:{{ views[inst.id]!.status!.powerGuard }}</div>
          <div class="fl-line muted">
            设备 {{ views[inst.id]?.status?.deviceId?.slice(0, 10) ?? '–' }} · v{{ views[inst.id]?.status?.version ?? '?' }} · {{ views[inst.id]?.status?.platform ?? '?' }}
            <template v-if="(views[inst.id]?.status?.offers ?? []).length"> · {{ (views[inst.id]?.status?.offers ?? []).filter((o) => o.status === 'pending').length }} 条待确认邀请</template>
            · {{ agoOf(views[inst.id]?.lastOk ?? null) }}更新
          </div>
        </div>
        <div v-else class="fl-card-body muted">尚未探测。</div>

        <footer class="fl-card-foot">
          <n-button size="tiny" tertiary :disabled="views[inst.id]?.loading" @click="probe(inst)">刷新</n-button>
          <n-button size="tiny" tertiary :disabled="!views[inst.id]?.status" @click="togglePause(inst)">
            {{ views[inst.id]?.status?.paused ? '恢复同步' : '暂停同步' }}
          </n-button>
          <n-button size="tiny" tertiary @click="openUi(inst)">打开该 UI</n-button>
          <n-button size="tiny" class="fl-del" @click="removeInstance(inst)">移除</n-button>
        </footer>
      </section>
    </main>
  </div>
</template>

<style scoped>
.fl-page {
  min-height: 100vh;
  padding: 18px clamp(12px, 4vw, 32px) 48px;
}
.fl-top {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 18px;
}
.fl-back {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: inherit;
  text-decoration: none;
  opacity: 0.75;
}
.fl-back:hover {
  opacity: 1;
}
.fl-title {
  font-size: 18px;
  margin: 0;
}
.fl-actions {
  margin-left: auto;
  display: flex;
  gap: 8px;
}
.fl-main {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-width: 860px;
}
.panel {
  background: var(--surface-1, rgba(0, 0, 0, 0.03));
  border: 1px solid var(--border, rgba(0, 0, 0, 0.08));
  border-radius: 10px;
  padding: 14px 16px;
}
.fl-add-title {
  font-weight: 600;
  margin-bottom: 10px;
}
.fl-add-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.fl-add-url { flex: 2 1 220px; }
.fl-add-token { flex: 2 1 200px; }
.fl-add-name { flex: 1 1 140px; }
.fl-hint {
  margin: 8px 0 0;
  font-size: 12px;
}
.fl-state {
  font-size: 13px;
}
.fl-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.fl-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex: none;
}
.fl-dot.is-ok { background: var(--success, #16a34a); }
.fl-dot.is-bad { background: var(--danger, #dc2626); }
.fl-dot.is-idle { background: var(--muted, #9ca3af); }
.fl-card-name {
  font-weight: 600;
}
.fl-card-url {
  font-size: 12px;
}
.fl-badge {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid currentColor;
}
.fl-badge.is-pause { color: var(--warning, #d97706); }
.fl-badge.is-update { color: var(--primary, #4a7fc0); }
.fl-card-body {
  margin-top: 10px;
  min-height: 20px;
}
.fl-line {
  font-size: 13px;
}
.fl-line--warn {
  color: var(--warning, #d97706);
}
.fl-err {
  color: var(--danger, #dc2626);
  font-size: 13px;
}
.fl-card-foot {
  margin-top: 12px;
  display: flex;
  gap: 8px;
}
.fl-del {
  margin-left: auto;
  color: var(--danger, #dc2626);
}
</style>
