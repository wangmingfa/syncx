import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

const shell = read('../web/components/ModalShell.vue');
const lock = read('../web/components/UpgradeRequiredModal.vue');
const statusPage = read('../web/StatusPage.vue');
const useDevices = read('../web/composables/useDevices.ts');

/**
 * 版本一致锁:在线配对设备比本机新时,整页被一层**关不掉**的升级弹窗盖住。
 * 「不可关闭」靠三路全断撑着,任何一路回归都会让用户把锁关掉继续用旧版本
 * (然后同步语义悄悄漂移),所以全部钉进测试:
 *  1. 右上角 × 不渲染(hideClose);
 *  2. 遮罩点击不触发 close(hideClose 与 closeDisabled 同挡);
 *  3. 弹窗判定直接吃 daemon 算好的 canUpgrade,web 端不出现第二份版本比较;
 *  4. 离线对端不锁(版本是握手缓存,升级也需要对方在线)。
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
  });

  it('StatusPage 挂了锁弹窗,且挂在 DropOverlay 之后(同 z-index 靠 DOM 顺序盖住整页)', () => {
    const mount = statusPage.indexOf('<UpgradeRequiredModal');
    expect(mount).toBeGreaterThan(-1);
    expect(mount).toBeGreaterThan(statusPage.indexOf('<DropOverlay'));
    expect(statusPage).toContain(':on-upgrade="upgradeDevice"');
    expect(useDevices).toContain('upgradeDevice,');
  });
});
