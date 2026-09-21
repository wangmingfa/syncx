import { describe, expect, it } from 'vitest';
import { folderPathPlaceholder } from '../web/utils/format.js';

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
