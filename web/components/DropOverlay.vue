<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';

/**
 * 页面级拖入上传:把安装包拖到 syncx 页面任意处即出现遮罩,
 * 在中间虚线框内松手走上传预检,松在外围则什么都不做。
 *
 * 监听挂在 window 上而不是某个元素上:这样不依赖 z-index 与层级,
 * 弹窗开着、页面滚动、鼠标在子元素上都不影响判定。
 */

/** pack:local 打出的是 .tgz;手工 tar 的可能是 .tar.gz。 */
const PACKAGE_RE = /\.(tgz|tar\.gz)$/i;

const emit = defineEmits<{ package: [File] }>();

const active = ref(false);
const inside = ref(false);
/**
 * 投放区的内缩量,供渲染使用。命中判定每次事件都重算(zoneInset 是纯函数),
 * 这里只保证「画出来的框」跟着窗口一起变:拖动中每帧 dragover 刷新,窗口缩放也监听。
 */
const inset = ref(zoneInset());
function syncInset(): void {
  inset.value = zoneInset();
}

/**
 * 投放区的基准内缩量:视口短边的 8%,夹在 24~72px。
 */
function baseGutter(): number {
  const min = Math.min(window.innerWidth, window.innerHeight);
  return Math.max(24, Math.min(72, Math.round(min * 0.08)));
}

/** 在基准尺寸上再缩掉的比例(宽高各缩 10%)。 */
const ZONE_SHRINK = 0.9;

/**
 * 投放区四边的内缩量。渲染与命中判定共用这一个函数,
 * 保证「看起来在框里」和「算作在框里」永远一致。
 * x/y 分开算:区域宽高各按 0.9 缩,居中后每边的量自然不同(视口非正方)。
 */
function zoneInset(): { x: number; y: number } {
  const g = baseGutter();
  return {
    x: Math.round((window.innerWidth - (window.innerWidth - 2 * g) * ZONE_SHRINK) / 2),
    y: Math.round((window.innerHeight - (window.innerHeight - 2 * g) * ZONE_SHRINK) / 2),
  };
}

/** 只在拖「文件」时接管:拖选中的文字/链接不参与,免得页面毫无预兆地变暗。 */
function isFileDrag(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files');
}

/** 直接用指针坐标和投放区矩形比对:拖动过程中每帧都有坐标,比跟踪 enter/leave 稳。 */
function inZone(e: DragEvent): boolean {
  const { x, y } = zoneInset();
  return (
    e.clientX >= x && e.clientX <= window.innerWidth - x && e.clientY >= y && e.clientY <= window.innerHeight - y
  );
}

function hide(): void {
  active.value = false;
  inside.value = false;
}

function onDragEnter(e: DragEvent): void {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  syncInset();
  active.value = true;
  inside.value = inZone(e);
}

function onDragOver(e: DragEvent): void {
  if (!isFileDrag(e)) return;
  // 必须 preventDefault:否则浏览器判定这里不接受投放,后面根本不会派发 drop
  e.preventDefault();
  syncInset();
  active.value = true;
  inside.value = inZone(e);
  // 光标随之变化,是「松手会生效 / 松手会取消」最直接的提示
  if (e.dataTransfer) e.dataTransfer.dropEffect = inside.value ? 'copy' : 'none';
}

function onDragLeave(e: DragEvent): void {
  // relatedTarget 还在页面内 = 只是从子元素挪到子元素,不收起;
  // 为空才是真的把文件拖出了窗口。
  if (e.relatedTarget) return;
  hide();
}

function onDrop(e: DragEvent): void {
  if (!isFileDrag(e)) return;
  e.preventDefault(); // 即使不接收,也不让浏览器直接打开这个文件
  const hit = inZone(e);
  hide();
  if (!hit) return;
  const picked = e.dataTransfer?.files?.[0] ?? null;
  // 非安装包静默忽略:不弹窗、不报错,拖错文件不该打断当前操作
  if (!picked || !PACKAGE_RE.test(picked.name)) return;
  emit('package', picked);
}

onMounted(() => {
  window.addEventListener('dragenter', onDragEnter);
  window.addEventListener('dragover', onDragOver);
  window.addEventListener('dragleave', onDragLeave);
  window.addEventListener('drop', onDrop);
  // 拖拽被中断(拖回桌面、按 Esc)时浏览器不一定补 dragleave,兜一道
  window.addEventListener('dragend', hide);
  // 遮罩只在拖动中出现,但窗口可能在拖动前就被改过大小,缩放时同步一次内缩量
  window.addEventListener('resize', syncInset);
});

onUnmounted(() => {
  window.removeEventListener('dragenter', onDragEnter);
  window.removeEventListener('dragover', onDragOver);
  window.removeEventListener('dragleave', onDragLeave);
  window.removeEventListener('drop', onDrop);
  window.removeEventListener('dragend', hide);
  window.removeEventListener('resize', syncInset);
});
</script>

<template>
  <Transition name="guide">
    <div v-if="active" class="drop-mask" :class="{ 'drop-mask--inside': inside }" aria-hidden="true">
      <div class="drop-mask__zone" :style="{ inset: `${inset.y}px ${inset.x}px` }">
        <div class="drop-mask__inner">
          <svg
            viewBox="0 0 24 24"
            width="34"
            height="34"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M12 16V4" />
            <path d="m7 9 5-5 5 5" />
            <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
          </svg>
          <!-- 文案随指针位置切换:框外先指路,框内才是「松手就生效」的确认 -->
          <span class="drop-mask__title">
            {{ inside ? '释放鼠标即可上传' : '拖到中间区域即可上传' }}
          </span>
          <span class="drop-mask__hint">
            {{ inside ? '仅支持 pack:local 打出的 .tgz 安装包' : '在框内松手才会开始上传，框外松手取消' }}
          </span>
        </div>
      </div>
    </div>
  </Transition>
</template>
