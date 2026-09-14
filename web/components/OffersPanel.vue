<script setup lang="ts">
import { NButton, NInput } from 'naive-ui';
import { useStatusContext } from '../composables/statusContext';

const {
  status,
  busy,
  pendingOffers,
  declinedOffers,
  declinedOpen,
  reusedFolderPath,
  offerPaths,
  acceptOffer,
  declineOffer,
  restoreOffer,
} = useStatusContext();
</script>

<template>
  <div v-if="status.offers && status.offers.length" class="offers">
    <div class="col-head">
      <span>待确认</span>
      <span class="badge">{{ pendingOffers.length }}</span>
    </div>
    <div
      v-for="o in pendingOffers"
      :key="o.id"
      class="item-card offer-card"
    >
      <div class="item-top">
        <span class="avatar" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 3v18M3 12h18" />
          </svg>
        </span>
        <span class="item-title">
          <template v-if="o.kind === 'folder'">目录共享邀请 · {{ o.folderName }}</template>
          <template v-else>配对请求</template>
        </span>
      </div>
      <div class="item-sub">来自 <span class="mono">{{ o.fromDeviceId }}</span><span v-if="o.fromIp || o.fromHostname" class="muted"> · <template v-if="o.fromIp">{{ o.fromIp }}</template><template v-if="o.fromHostname">{{ o.fromIp ? ' · ' : '' }}{{ o.fromHostname }}</template></span></div>
      <div v-if="o.kind === 'folder'" class="offer-path">
        <template v-if="reusedFolderPath(o)">
          <p class="form-hint offer-reuse-hint">本机已有同 ID 目录,确认后直接复用它:<span class="mono">{{ reusedFolderPath(o) }}</span></p>
        </template>
        <template v-else>
          <n-input v-model:value="offerPaths[o.id]" placeholder="本机目录绝对路径,如 /home/me/Documents" />
          <p class="form-hint">目录不存在时会自动创建</p>
        </template>
      </div>
      <div class="actions">
        <n-button size="small" type="primary" :disabled="busy" @click="acceptOffer(o)">确认</n-button>
        <n-button size="small" tertiary :disabled="busy" @click="declineOffer(o)">忽略</n-button>
      </div>
    </div>

    <!-- 已忽略:手误忽略的兜底。默认收起,点按钮展开;已接受的不展示 -->
    <div v-if="declinedOffers.length" class="declined-toggle">
      <n-button size="tiny" quaternary :disabled="busy" @click="declinedOpen = !declinedOpen">
        {{ declinedOpen ? '▾ 收起已忽略' : `▸ 已忽略 (${declinedOffers.length})` }}
      </n-button>
    </div>
    <template v-if="declinedOpen">
      <div
        v-for="o in declinedOffers"
        :key="o.id"
        class="item-card offer-card is-declined"
      >
        <div class="item-top">
          <span class="avatar" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 3v18M3 12h18" />
            </svg>
          </span>
          <span class="item-title">
            <template v-if="o.kind === 'folder'">目录共享邀请 · {{ o.folderName }}</template>
            <template v-else>配对请求</template>
          </span>
          <span class="declined-flag">已忽略</span>
        </div>
        <div class="item-sub">来自 <span class="mono">{{ o.fromDeviceId }}</span><span v-if="o.fromIp || o.fromHostname" class="muted"> · <template v-if="o.fromIp">{{ o.fromIp }}</template><template v-if="o.fromHostname">{{ o.fromIp ? ' · ' : '' }}{{ o.fromHostname }}</template></span></div>
        <div class="actions">
          <n-button size="small" tertiary :disabled="busy" @click="restoreOffer(o)">恢复</n-button>
        </div>
      </div>
    </template>
  </div>
</template>
