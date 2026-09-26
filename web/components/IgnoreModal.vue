<script setup lang="ts">
import { ref, watch } from 'vue';
import { NButton, NInput } from 'naive-ui';
import { apiJson, apiPost, errText } from '../utils/api';
import ModalShell from './ModalShell.vue';

/** GET /api/folders/ignore 的返回:.syncxignore 原始行 + 内置默认 + gitignore 开关。 */
interface IgnoreInfo {
  lines: string[];
  builtin: string[];
  useGitignore: boolean;
}

/** POST /api/folders/ignore/test 的判定解释。 */
interface IgnoreVerdict {
  ignored: boolean;
  hard: boolean;
  rule?: string;
  negatedRule?: string;
}

const props = defineProps<{
  /** 非空 = 打开该目录的忽略规则编辑器并拉取 .syncxignore。 */
  folder: { id?: string; path: string } | null;
  notify: (msg: string, kind?: 'info' | 'alert') => void;
  /** 保存规则会改变同步集合,完成后通知父级刷新状态。 */
  changed: () => void;
}>();
const emit = defineEmits<{ close: [] }>();

const info = ref<IgnoreInfo | null>(null);
const text = ref('');
const loading = ref(false);
const saving = ref(false);

const testPath = ref('');
const verdict = ref<IgnoreVerdict | null>(null);
const testing = ref(false);

const lastPath = ref('');

function folderId(): string {
  const f = props.folder;
  return f ? f.id ?? f.path : '';
}

async function load(id: string): Promise<void> {
  loading.value = true;
  try {
    info.value = await apiJson<IgnoreInfo>(`/api/folders/ignore?folderId=${encodeURIComponent(id)}`);
    text.value = info.value.lines.join('\n');
  } catch (e) {
    props.notify(errText(e, '读取忽略规则失败'));
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.folder,
  async (f) => {
    verdict.value = null;
    testPath.value = '';
    if (!f) return;
    lastPath.value = f.path;
    info.value = null;
    await load(folderId());
  },
);

/** 编辑框当前草稿按行拆开(保存与测试共用;空串拆成一行空行,parse 时会跳过)。 */
function draftLines(): string[] {
  return text.value.split('\n');
}

async function save(): Promise<void> {
  saving.value = true;
  try {
    await apiPost('/api/folders/ignore', { folderId: folderId(), lines: draftLines() });
    props.notify('忽略规则已保存,立即生效;被新规则忽略的存量文件会停同步并广播删除');
    props.changed();
  } catch (e) {
    props.notify(errText(e, '保存忽略规则失败'), 'alert');
  } finally {
    saving.value = false;
  }
}

/**
 * 实时测试:按「草稿保存后」的规则预测(不要求先保存)。
 * 路径以 / 结尾按目录语义测(目录规则 `foo/` 只挡目录)。
 */
async function test(): Promise<void> {
  const p = testPath.value.trim();
  if (!p) {
    verdict.value = null;
    return;
  }
  testing.value = true;
  try {
    verdict.value = await apiPost<IgnoreVerdict>('/api/folders/ignore/test', {
      folderId: folderId(),
      path: p,
      lines: draftLines(),
    });
  } catch (e) {
    props.notify(errText(e, '测试失败'), 'alert');
    verdict.value = null;
  } finally {
    testing.value = false;
  }
}
</script>

<template>
  <ModalShell
    :open="!!folder"
    title="忽略规则"
    :description="lastPath + ' · .syncxignore'"
    description-mono
    wide
    @close="emit('close')"
  >
    <p class="modal-lead">
      gitignore 语法:一行一条,后写的规则覆盖先写的,`!` 开头为放行;`#` 注释;目录规则以 `/` 结尾。
      保存即生效 —— 被新规则忽略的存量文件会停同步并广播删除。`.git` / `.hg` / `.svn` / 同步元数据是硬忽略,任何规则解不开。
      <template v-if="info && !info.useGitignore">本目录未并入 .gitignore。</template>
      <template v-else-if="info">本目录同时并入 .gitignore(优先级低于本页规则)。</template>
    </p>

    <div v-if="loading" class="history-loading">读取中…</div>
    <template v-else>
      <n-input
        v-model:value="text"
        type="textarea"
        :autosize="{ minRows: 8, maxRows: 18 }"
        placeholder="node_modules/&#10;*.tmp&#10;!logs/keep-me.log"
        mono
        spellcheck="false"
      />
      <p v-if="info && info.builtin.length" class="ignore-builtin muted">
        内置默认(可被本页负向规则在文本层覆盖,但硬忽略闸门不受影响):{{ info.builtin.join(' · ') }}
      </p>

      <!-- 实时测试器:粘贴路径即问「按当前草稿它会被忽略吗、由哪条规则决定」 -->
      <div class="ignore-test">
        <n-input
          v-model:value="testPath"
          size="small"
          placeholder="测试路径,如 build/app.js(以 / 结尾按目录测)"
          mono
          clearable
          @keyup.enter="test"
        />
        <n-button size="small" :loading="testing" @click="test">测试</n-button>
      </div>
      <p v-if="verdict" class="ignore-verdict">
        <template v-if="verdict.hard">
          <span class="ignore-verdict__no">不参与同步</span> —— 命中硬忽略(.git/.hg/.svn/同步元数据/冲突副本),不可解除
        </template>
        <template v-else-if="verdict.ignored">
          <span class="ignore-verdict__no">不参与同步</span> —— 命中规则 <code>{{ verdict.rule }}</code>
        </template>
        <template v-else-if="verdict.negatedRule">
          <span class="ignore-verdict__yes">参与同步</span> —— 被负向规则 <code>{{ verdict.negatedRule }}</code> 放行
        </template>
        <template v-else><span class="ignore-verdict__yes">参与同步</span> —— 没有规则命中它</template>
      </p>
    </template>

    <template #footer>
      <n-button @click="emit('close')">取消</n-button>
      <n-button type="primary" :loading="saving" :disabled="loading" @click="save">保存</n-button>
    </template>
  </ModalShell>
</template>

<style scoped>
.ignore-builtin {
  margin: 8px 0 0;
  font-size: 12px;
}
.ignore-test {
  display: flex;
  gap: 8px;
  margin-top: 14px;
  align-items: center;
}
.ignore-verdict {
  margin: 8px 0 0;
  font-size: 13px;
}
.ignore-verdict__no {
  color: var(--warning, #d97706);
  font-weight: 600;
}
.ignore-verdict__yes {
  color: var(--success, #16a34a);
  font-weight: 600;
}
.ignore-verdict code {
  background: var(--surface-2, rgba(0, 0, 0, 0.06));
  padding: 1px 5px;
  border-radius: 4px;
}
</style>
