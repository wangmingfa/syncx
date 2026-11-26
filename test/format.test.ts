import { describe, expect, it } from 'vitest';
import { deviceAddrLine, folderPathPlaceholder, pastedImageName, visibleTransferFiles, XFER_FILE_LIMIT } from '../web/utils/format.js';
import type { DeviceInfo } from '../web/types.js';

/**
 * 目录输入框的路径示例必须按 **daemon 所在平台** 给。
 * 浏览器可能跑在另一台机器上,所以后端在 status.platform 里报平台,前端据此切换示例 ——
 * 在 Windows 上提示 `/home/me/Documents` 会把用户带到「填了本机不认的路径」那条错路上。
 */
describe('folderPathPlaceholder(按 daemon 平台给示例)', () => {
  it('win32 给 Windows 盘符示例,且不带 POSIX 示例', () => {
    expect(folderPathPlaceholder('win32')).toContain('F:\\shared\\docs');
    expect(folderPathPlaceholder('win32')).not.toContain('/home/');
  });

  it('darwin / linux 给 POSIX 示例,且不带盘符示例', () => {
    for (const platform of ['darwin', 'linux']) {
      expect(folderPathPlaceholder(platform)).toContain('/home/me/Documents');
      expect(folderPathPlaceholder(platform)).not.toContain('F:\\');
    }
  });

  it('后端未提供 platform(旧版本)时退回 POSIX 示例,不抛错', () => {
    expect(folderPathPlaceholder(undefined)).toBe(folderPathPlaceholder('darwin'));
  });
});

/**
 * 目录卡「传输中文件」列表默认最多 5 条:后端 files 无条数上限(整目录首批同步可能上千条),
 * 全渲染会把卡片撑得极高、把并列的设备列甩到屏幕外。
 */
describe('visibleTransferFiles(传输中文件列表折叠)', () => {
  const files = (n: number): string[] => Array.from({ length: n }, (_, i) => `f${i}.js`);

  it('上限就是 5 条', () => {
    expect(XFER_FILE_LIMIT).toBe(5);
  });

  it('收起时只给前 N 条,且保持原顺序', () => {
    expect(visibleTransferFiles(files(100), false)).toEqual(['f0.js', 'f1.js', 'f2.js', 'f3.js', 'f4.js']);
  });

  it('展开时给全部', () => {
    expect(visibleTransferFiles(files(7), true)).toHaveLength(7);
  });

  it('恰好等于上限时,收起与展开结果一致(调用方据此不渲染「查看全部」)', () => {
    expect(visibleTransferFiles(files(5), false)).toEqual(visibleTransferFiles(files(5), true));
  });

  it('少于上限时原样返回', () => {
    expect(visibleTransferFiles(files(2), false)).toEqual(['f0.js', 'f1.js']);
  });

  it('空列表不抛错', () => {
    expect(visibleTransferFiles([], false)).toEqual([]);
  });

  it('不改动入参数组(返回新数组)', () => {
    const input = files(8);
    const out = visibleTransferFiles(input, false);
    expect(out).not.toBe(input);
    expect(input).toHaveLength(8);
  });
});

/**
 * 设备卡地址行必须和「编辑设备」弹窗同源:都优先读配置里持久化的 address。
 * 反向发现会把入站握手学到的监听端口写进会话 url,若卡片优先显示 url,
 * 就会出现「填的是 12222、编辑框是 12222、卡片显示 22000」。
 */
describe('deviceAddrLine(设备卡地址行)', () => {
  const device: DeviceInfo = {
    deviceId: 'F3B5IGZFVC',
    online: true,
    address: 'ws://172.25.48.48:12222',
    url: 'ws://172.25.48.48:22000',
    hostname: 'fedora',
    folders: [],
  };

  it('配置地址与会话地址不一致时显示配置地址(与编辑弹窗一致)', () => {
    expect(deviceAddrLine(device)).toBe('172.25.48.48:12222 · fedora');
  });

  it('没有配置地址时回退到会话地址', () => {
    expect(deviceAddrLine({ ...device, address: undefined })).toBe('172.25.48.48:22000 · fedora');
  });

  it('两者都没有时只显示主机名', () => {
    expect(deviceAddrLine({ ...device, address: undefined, url: undefined })).toBe('fedora');
  });

  it('去掉 ws:// 前缀,IPv6 方括号保留', () => {
    expect(deviceAddrLine({ ...device, address: 'ws://[2001:db8::1]:12222', hostname: undefined })).toBe('[2001:db8::1]:12222');
  });
});

/**
 * 粘贴图片没有真名字:浏览器给的 blob 往往叫 `image.png`,同一秒粘两张就重名。
 * 这里按「粘贴-年月日-时分秒」统一重命名,顺带把扩展名按 MIME 定死。
 */
describe('pastedImageName(粘贴图片命名)', () => {
  const at = new Date(2026, 10, 26, 20, 30, 5); // 本地时间 2026-11-26 20:30:05

  it('按时间戳命名并把扩展名统一成小写规范写法', () => {
    expect(pastedImageName('image/png', at)).toBe('粘贴-20261126-203005.png');
    expect(pastedImageName('image/jpeg', at)).toBe('粘贴-20261126-203005.jpg');
    expect(pastedImageName('image/svg+xml', at)).toBe('粘贴-20261126-203005.svg');
    expect(pastedImageName('IMAGE/WEBP', at)).toBe('粘贴-20261126-203005.webp');
  });

  it('同一批的第 2 张起加序号,不会自己和自己重名', () => {
    expect(pastedImageName('image/png', at, 2)).toBe('粘贴-20261126-203005-2.png');
  });

  it('不认识的图片类型退回 MIME 子类型,再不行用 png', () => {
    expect(pastedImageName('image/x-icon', at)).toBe('粘贴-20261126-203005.x-icon');
    expect(pastedImageName('image/', at)).toBe('粘贴-20261126-203005.png');
  });

  it('名字里不带路径分隔符,接收方落盘时不会被拆成子目录', () => {
    for (const mime of ['image/png', 'image/svg+xml', 'image/']) {
      const name = pastedImageName(mime, at);
      expect(name).not.toMatch(/[\\/]/);
      expect(name.startsWith('粘贴-')).toBe(true);
    }
  });
});
