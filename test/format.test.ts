import { describe, expect, it } from 'vitest';
import { folderPathPlaceholder, visibleTransferFiles, XFER_FILE_LIMIT } from '../web/utils/format.js';

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
