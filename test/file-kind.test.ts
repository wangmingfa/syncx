import { describe, expect, it } from 'vitest';
import {
  compareContentLimit,
  imageMimeOf,
  IMAGE_PREVIEW_MAX_BYTES,
  TEXT_COMPARE_MAX_BYTES,
} from '../src/file-kind.js';

describe('imageMimeOf:可预览图片按后缀判定', () => {
  it('认出常见图片后缀并给出正确的 MIME', () => {
    const cases: Array<[string, string]> = [
      ['a.png', 'image/png'],
      ['b.jpg', 'image/jpeg'],
      ['c.jpeg', 'image/jpeg'],
      ['d.gif', 'image/gif'],
      ['e.webp', 'image/webp'],
      ['f.bmp', 'image/bmp'],
      ['g.ico', 'image/x-icon'],
      ['h.avif', 'image/avif'],
      ['i.svg', 'image/svg+xml'],
    ];
    for (const [name, mime] of cases) expect(imageMimeOf(name), name).toBe(mime);
  });

  it('大小写与目录路径都不影响判定', () => {
    expect(imageMimeOf('PHOTO.PNG')).toBe('image/png');
    expect(imageMimeOf('sub/dir/pic.JpG')).toBe('image/jpeg');
  });

  it('只认最后一个后缀(.mbt.md 这类复合名按最后一段算)', () => {
    expect(imageMimeOf('logo.png.md')).toBeUndefined();
    expect(imageMimeOf('notes.md')).toBeUndefined();
  });

  it('非图片返回 undefined', () => {
    for (const name of ['a.txt', 'b.zip', 'c.mp4', 'd.pdf', 'README', '.env', '.gitignore']) {
      expect(imageMimeOf(name), name).toBeUndefined();
    }
  });

  it('浏览器不能解码的图片后缀故意不收(tiff):宁可老实降级成「二进制」', () => {
    expect(imageMimeOf('scan.tiff')).toBeUndefined();
    expect(imageMimeOf('scan.tif')).toBeUndefined();
  });
});

describe('compareContentLimit:上限按类型分档', () => {
  it('图片走预览上限,其余走文本上限', () => {
    expect(compareContentLimit('pic.png')).toBe(IMAGE_PREVIEW_MAX_BYTES);
    expect(compareContentLimit('src/main.ts')).toBe(TEXT_COMPARE_MAX_BYTES);
    expect(compareContentLimit('README')).toBe(TEXT_COMPARE_MAX_BYTES);
  });

  it('图片上限比文本上限大:截图/照片动辄几 MB,2 MiB 会把最该看的文件挡在门外', () => {
    expect(IMAGE_PREVIEW_MAX_BYTES).toBeGreaterThan(TEXT_COMPARE_MAX_BYTES);
  });
});
