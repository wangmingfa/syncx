<script setup lang="ts">
import { NButton } from 'naive-ui';

defineProps<{ open: boolean; isDev: boolean; controlPort: string }>();
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <Transition name="guide">
    <div v-if="open" class="modal-overlay" @click.self="emit('close')">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="guide-title">
        <n-button quaternary circle class="modal-close" aria-label="关闭" @click="emit('close')">×</n-button>
        <h2 id="guide-title" class="modal-title">首次使用指南</h2>
        <p class="modal-lead">四步把两台设备连起来,开始局域网同步。</p>

        <ol class="guide-steps">
          <li>
            <div class="guide-step-h">① 添加共享目录</div>
            <div class="guide-step-b">
              在左侧「共享目录」填写<strong>本地目录绝对路径</strong>(如
              <code class="mono">/home/me/Documents</code>)。目录 ID 留空会自动生成,
              但<strong>跨机同步时对方须用同一个目录 ID</strong>(可点目录卡上的「复制」发给对方)。
            </div>
          </li>
          <li>
            <div class="guide-step-h">② 添加对方设备</div>
            <div class="guide-step-b">
              在右侧「设备」粘贴对方的<strong>设备 ID</strong>(对方网页顶部那串字符),点「添加设备」。
              对方网页会立刻弹出<strong>配对请求</strong>,点「确认」即完成双向配对。
            </div>
          </li>
          <li>
            <div class="guide-step-h">③ 指派目录给设备</div>
            <div class="guide-step-b">
              在左侧目录卡上的「选择可同步此目录的设备」里勾选刚添加的设备。
              对方网页会弹出<strong>目录共享邀请</strong>,点「确认」并选好本机路径,目录即开始双向同步。
            </div>
          </li>
          <li>
            <div class="guide-step-h">④ 等待同步</div>
            <div class="guide-step-b">
              配对成功后,该目录会出现在双方设备上。状态显示为「在线 / 传输中 / 已同步」;进度条流动代表正在传数据。
            </div>
          </li>
        </ol>

        <div v-if="isDev" class="guide-note">
          开发提示:本界面当前由控制端口 <code class="mono">{{ controlPort }}</code> 提供;dev 模式请访问
          <code class="mono">5173</code>(HMR 实时热更新)。
        </div>

        <n-button type="primary" block class="modal-ok" @click="emit('close')">我知道了</n-button>
      </div>
    </div>
  </Transition>
</template>
