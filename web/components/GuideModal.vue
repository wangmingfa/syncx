<script setup lang="ts">
import { NButton } from 'naive-ui';
import ModalShell from './ModalShell.vue';

defineProps<{ open: boolean; isDev: boolean; controlPort: string }>();
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <ModalShell :open="open" title="使用指南" wide @close="emit('close')">
    <p class="modal-lead">四步把两台设备连起来，开始局域网同步。</p>

    <!-- 中文段落一律写成「单个源行」:HTML 会把源码里的换行折叠成一个半角空格,
         一旦落在标点后面就会渲染成「生成， 但」这种多余空格。只有中英混排处
         (如 Termux 与中文之间)才值得换行,那种位置的空格本来就是想要的。 -->
    <ol class="guide-steps">
      <li>
        <div class="guide-step-h">① 添加共享目录</div>
        <div class="guide-step-b">在左侧「共享目录」填写<strong>本地目录绝对路径</strong>（如 <code class="mono">/home/me/Documents</code>）。目录 ID 留空会自动生成，但<strong>跨机同步时对方须用同一个目录 ID</strong>（可点目录卡上的「复制」发给对方）。</div>
      </li>
      <li>
        <div class="guide-step-h">② 添加对方设备</div>
        <div class="guide-step-b">在右侧「设备」粘贴对方的<strong>设备 ID</strong>（对方网页顶部那串字符），点「添加设备」。对方网页会立刻弹出<strong>配对请求</strong>，点「确认」即完成双向配对。</div>
      </li>
      <li>
        <div class="guide-step-h">③ 指派目录给设备</div>
        <div class="guide-step-b">在左侧目录卡上的「选择可同步此目录的设备」里勾选刚添加的设备。对方网页会弹出<strong>目录共享邀请</strong>，点「确认」并选好本机路径，目录即开始双向同步。</div>
      </li>
      <li>
        <div class="guide-step-h">④ 等待同步</div>
        <div class="guide-step-b">配对成功后，该目录会出现在双方设备上。状态显示为「在线 / 传输中 / 已同步」；进度条流动代表正在传数据。</div>
      </li>
    </ol>

    <!-- 常见误解之一:同步的两端里只要有一端是手机,就会偶发十几秒。默认收起
         (展开后比四步正文还高),展开/收起的细节样式见 style.css 的 .guide-faq。
         措辞注意「哪一端是手机都成立」,不要写成「对端是手机」——本机也可能是手机。 -->
    <details class="guide-faq">
      <summary class="guide-faq-h">其中一端是手机时，偶尔要等十几秒？</summary>
      <div class="guide-faq-b">这不是 syncx 的故障：手机空闲时会把 Termux 冻住、并让整机进入休眠，这段时间里手机那侧的事件循环不会运行，发给它的请求要一直等到它被唤醒 —— 所以<strong>几 KB 的小文件也一样慢</strong>，瓶颈不是传文件，而是叫醒手机（手机在本机还是在对方都一样）。</div>
      <div class="guide-faq-h guide-faq-h--sub">在手机上这样处理</div>
      <ul class="guide-faq-list">
        <li>设置 → 应用 → Termux → 电池，选「<strong>不受限制</strong>」（Android 12 以上这是允许后台运行的前提）。</li>
        <li>Termux <strong>切到前台</strong>（不要用 ssh）执行 <code class="mono">termux-wake-lock</code>；通知栏出现 <strong>Termux wake lock held</strong> 即生效。</li>
        <li>想开机自动：装上 <strong>Termux:Boot</strong> 并先手动启动一次该 App。</li>
      </ul>
      <div class="guide-faq-b">改好后，同一个操作应在几十毫秒内返回。</div>
    </details>

    <div v-if="isDev" class="guide-note">开发提示：本界面当前由控制端口 <code class="mono">{{ controlPort }}</code> 提供；dev 模式请访问 <code class="mono">5173</code>（HMR 实时热更新）。</div>

    <template #footer>
      <n-button type="primary" @click="emit('close')">我知道了</n-button>
    </template>
  </ModalShell>
</template>
