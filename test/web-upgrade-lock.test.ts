import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

const shell = read('../web/components/ModalShell.vue');
const lock = read('../web/components/UpgradeRequiredModal.vue');
const host = read('../web/components/UpgradeLockHost.vue');
const app = read('../web/App.vue');
const statusPage = read('../web/StatusPage.vue');
const useDevices = read('../web/composables/useDevices.ts');
const useStatus = read('../web/composables/useStatus.ts');
const useStatusFeed = read('../web/composables/useStatusFeed.ts');
const useUpgrade = read('../web/composables/useUpgrade.ts');

/** 取模板里最后一个组件标签(` <Component`)的名字,用于断言 DOM 顺序。 */
function lastTag(source: string): string {
  const template = source.slice(source.indexOf('<template>'));
  const tags = [...template.matchAll(/<([A-Z][\w.]*)/g)].map((m) => m[1]);
  return tags[tags.length - 1] ?? '';
}

/**
 * 版本一致锁:在线配对设备比本机新时,**每一条路由**都被一层关不掉的升级弹窗盖住。
 * 「关不掉」和「盖到全部页面」是两件事,各自都有很便宜的回归路径,所以两边都钉:
 *  1. 右上角 × 不渲染(hideClose);
 *  2. 遮罩点击不触发 close(hideClose 与 closeDisabled 同挡);
 *  3. 弹窗判定直接吃 daemon 算好的 canUpgrade,web 端不出现第二份版本比较;
 *  4. 离线对端不锁(版本是握手缓存,升级也需要对方在线);
 *  5. 宿主挂在 App 层且是模板最后一个节点 —— 各页不再自己挂,也就没有「某一页忘了挂」;
 *  6. 宿主自带状态订阅,不依赖页面把 status 传下来(终端页/文件页根本没有共享 status)。
 */
describe('web: 版本一致锁(强制升级弹窗)', () => {
  it('ModalShell 的 hideClose 三路全断:不渲染 ×、遮罩点击不再触发 close', () => {
    expect(shell).toContain('<ModalCloseButton v-if="!hideClose"');
    // 遮罩的 @click.self 必须同时被 closeDisabled 与 hideClose 挡住
    expect(shell).toContain("!closeDisabled && !hideClose && emit('close')");
  });

  it('锁弹窗确实 hide-close,且判定只认「在线且 daemon 判定可升级」的行', () => {
    expect(lock).toContain('hide-close');
    // 不在前端重写版本比较:唯一判定来源是 status.devices 里的 canUpgrade
    expect(lock).toContain('d.online && d.canUpgrade');
    expect(lock).not.toContain('compareVersions');
    expect(useDevices).not.toContain('compareVersions');
    expect(host).not.toContain('compareVersions');
  });

  it('锁挂在 App 层的宿主上,且宿主是 App 模板最后一个节点(同 z-index 靠 DOM 顺序盖住整页)', () => {
    expect(app).toContain('<UpgradeLockHost');
    expect(lastTag(app)).toBe('UpgradeLockHost');
    // 各页不再自己挂:唯一的挂载点就是宿主,漏挂一页这种失效模式从此不存在
    expect(statusPage).not.toContain('UpgradeRequiredModal');
    expect(lock).not.toContain('StatusPage');
  });

  it('未登录时不挂宿主:否则 /login 上那条 401 会让页面无限自刷', () => {
    // 宿主自带 /api/status 订阅(见下条),它在登录页上也会发起请求;
    // apiJson 见 401 就 location.assign('/login'),而 /login 正是当前页 —— 自刷循环。
    const mount = app.slice(app.indexOf('<UpgradeLockHost'));
    expect(mount).toMatch(/^<UpgradeLockHost v-if="status"/);
  });

  it('宿主自持状态订阅,不靠页面传 status', () => {
    expect(host).toContain('useStatusFeed');
    expect(host).not.toContain('defineProps');
  });

  it('推送通道与升级动作各只有一份实现', () => {
    // status 订阅从 useStatus 抽进 useStatusFeed 后,两处都得走它,否则迟早漂移
    expect(useStatus).toContain('useStatusFeed');
    expect(useStatus).not.toContain('new WebSocket');
    expect(useStatusFeed).toContain("const EVENTS_PATH = '/api/events'");
    // 「从对端升级」有两个调用方(设备卡 askUpgrade / 锁宿主),POST 只允许写在 useUpgrade 里
    expect(useUpgrade).toContain("'/api/devices/upgrade'");
    expect(useDevices).not.toContain('/api/devices/upgrade');
    expect(host).toContain('useUpgrade');
  });
});
