<script setup lang="ts">
import { computed, ref } from 'vue';
import { NButton, NInput, NCheckbox } from 'naive-ui';
import { useStatusContext } from '../composables/statusContext';
import { folderPathPlaceholder } from '../utils/format';
import type { OfferInfo } from '../types';

const {
  status,
  busy,
  pendingOffers,
  declinedOffers,
  declinedOpen,
  reusedFolderPath,
  offerPaths,
  offerReceiveOnly,
  acceptOffer,
  declineOffer,
  restoreOffer,
} = useStatusContext();

/** 路径示例按 daemon 平台给(Windows 显示 F:\shared\docs),避免在 Windows 上提示 POSIX 路径。 */
const pathPlaceholder = computed(() => folderPathPlaceholder(status.value.platform));

/**
 * 目录邀请需要本机落地路径:默认收起成一行「灵动岛」胶囊,点「填写路径」展开内联表单
 * (路径 + 接收模式),填完在表单右下角点「确定」才真正接受。用文字按钮而非勾号,
 * 是刻意的:勾号语义是「点即完成」,但目录邀请点它只是展开表单,会误导用户。
 * 配对请求无需路径、可复用本机目录的目录邀请无需填写,这两类点勾号直接完成。
 * expandedOfferId 记录当前展开表单的那条邀请。
 */
const expandedOfferId = ref<string | null>(null);
</script>

<template>
  <div v-if="status.offers && status.offers.length" class="offers">
    <div class="col-head">
      <span>待确认</span>
      <span class="badge">{{ pendingOffers.length }}</span>
    </div>

    <!-- TransitionGroup:邀请到达(enter)与确认/忽略(leave)时胶囊淡入淡出,
         其余胶囊经 .offer-move 平滑补位。tag="div" 让组本身是 flex 列容器(见 .offer-list)。 -->
    <TransitionGroup name="offer" tag="div" class="offer-list">
      <div
        v-for="o in pendingOffers"
        :key="o.id"
        class="offer-pill"
        :class="{ 'is-expanded': expandedOfferId === o.id }"
      >
        <div class="offer-pill__row">
          <span class="offer-icon" aria-hidden="true">
            <!-- 目录邀请:文件夹图标;配对请求:链接图标 -->
            <svg v-if="o.kind === 'folder'" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            </svg>
            <svg v-else viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M9 15l6-6M10 6l1-1a4 4 0 0 1 6 6l-1 1M14 18l-1 1a4 4 0 0 1-6-6l1-1" />
            </svg>
          </span>
          <div class="offer-text">
            <div class="offer-title">
              <template v-if="o.kind === 'folder'">目录共享邀请 · {{ o.folderName }}</template>
              <template v-else>配对请求</template>
            </div>
            <div class="offer-sub">来自 <span class="mono">{{ o.fromDeviceId }}</span><span v-if="o.fromIp || o.fromHostname"> · <template v-if="o.fromIp">{{ o.fromIp }}</template><template v-if="o.fromHostname">{{ o.fromIp ? ' · ' : '' }}{{ o.fromHostname }}</template></span></div>
          </div>
          <div class="offer-actions">
            <template v-if="o.kind === 'folder' && !reusedFolderPath(o)">
              <!-- 需要填路径:文字按钮明确「还有后续步骤」;展开后消失,
                   确认动作移到表单右下角的「确定」 -->
              <button
                v-if="expandedOfferId !== o.id"
                type="button"
                class="offer-btn offer-btn--fill"
                :disabled="busy"
                @click="expandedOfferId = o.id"
              >填写路径</button>
            </template>
            <!-- 配对请求 / 可复用本机目录:点勾即完成,无后续步骤 -->
            <button
              v-else
              type="button"
              class="offer-btn offer-btn--accept"
              :disabled="busy"
              title="确认"
              @click="acceptOffer(o)"
            >
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7" /></svg>
            </button>
            <button type="button" class="offer-btn offer-btn--decline" :disabled="busy" title="忽略" @click="declineOffer(o)">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          </div>
        </div>

        <!-- 目录邀请展开的内联表单:路径 + 接收模式。取消 = 收起 -->
        <div v-if="o.kind === 'folder' && expandedOfferId === o.id" class="offer-form">
          <template v-if="reusedFolderPath(o)">
            <p class="form-hint offer-reuse-hint">本机已有同 ID 目录,确认后直接复用它:<span class="mono">{{ reusedFolderPath(o) }}</span></p>
          </template>
          <template v-else>
            <n-input v-model:value="offerPaths[o.id]" :placeholder="pathPlaceholder" />
            <p class="form-hint">目录不存在时会自动创建</p>
            <n-checkbox v-model:checked="offerReceiveOnly[o.id]" class="ro-check">
              接收模式(只拉不推):只从对方拉取变更,不把本机改动同步出去
            </n-checkbox>
          </template>
          <div class="offer-form__actions">
            <n-button size="small" tertiary :disabled="busy" @click="expandedOfferId = null">取消</n-button>
            <n-button size="small" type="primary" :disabled="busy" @click="acceptOffer(o)">确定</n-button>
          </div>
        </div>
      </div>
    </TransitionGroup>

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
        class="offer-pill is-declined"
      >
        <div class="offer-pill__row">
          <span class="offer-icon" aria-hidden="true">
            <svg v-if="o.kind === 'folder'" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            </svg>
            <svg v-else viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M9 15l6-6M10 6l1-1a4 4 0 0 1 6 6l-1 1M14 18l-1 1a4 4 0 0 1-6-6l1-1" />
            </svg>
          </span>
          <div class="offer-text">
            <div class="offer-title">
              <template v-if="o.kind === 'folder'">目录共享邀请 · {{ o.folderName }}</template>
              <template v-else>配对请求</template>
            </div>
            <div class="offer-sub">来自 <span class="mono">{{ o.fromDeviceId }}</span><span v-if="o.fromIp || o.fromHostname"> · <template v-if="o.fromIp">{{ o.fromIp }}</template><template v-if="o.fromHostname">{{ o.fromIp ? ' · ' : '' }}{{ o.fromHostname }}</template></span></div>
          </div>
          <div class="offer-actions">
            <button type="button" class="offer-btn offer-btn--restore" :disabled="busy" title="恢复" @click="restoreOffer(o)">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></svg>
            </button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
