import { describe, expect, it } from 'vitest';
import { extOf, fileIconKind } from '../web/utils/file-icon.js';

describe('extOf', () => {
  it('取小写扩展名', () => {
    expect(extOf('a/b/README.MD')).toBe('md');
    expect(extOf('photo.JPG')).toBe('jpg');
    expect(extOf('archive.tar.gz')).toBe('gz');
  });

  it('无扩展名 / 隐藏文件返回空串', () => {
    expect(extOf('Makefile')).toBe('');
    expect(extOf('.gitignore')).toBe('');
    expect(extOf('a/b/.env')).toBe('');
  });
});

describe('fileIconKind:代码按语言细分', () => {
  const byLang: Array<[string, string[]]> = [
    ['rust', ['main.rs', 'build.rs']],
    ['js', ['index.js', 'a.mjs', 'b.cjs']],
    ['ts', ['main.ts', 'types.d.mts', 'c.cts']],
    ['react', ['App.jsx', 'Panel.tsx']],
    ['vue', ['App.vue']],
    ['python', ['script.py', 'stub.pyi']],
    ['go', ['main.go']],
    ['java', ['Main.java']],
    ['c', ['a.c', 'b.h', 'c.cpp', 'd.hpp', 'e.cc', 'f.hh']],
    ['html', ['index.html', 'page.htm']],
    ['css', ['style.css', 'a.scss', 'b.less']],
    ['sql', ['schema.sql']],
    ['shell', ['run.sh', 'setup.bash', 'x.zsh', 'build.ps1', 'a.bat']],
  ];

  it('每种语言一个类别', () => {
    for (const [kind, names] of byLang) {
      for (const n of names) expect(fileIconKind(n)).toBe(kind);
    }
  });

  it('没有专属图形的语言归通用 code', () => {
    for (const n of ['App.svelte', 'page.astro', 'x.rb', 'y.php', 'z.swift', 'a.kt', 'b.cs', 'c.dart']) {
      expect(fileIconKind(n)).toBe('code');
    }
  });

  it('js / ts / react 三个后缀不混淆', () => {
    expect(fileIconKind('a.js')).toBe('js');
    expect(fileIconKind('a.ts')).toBe('ts');
    expect(fileIconKind('a.jsx')).toBe('react');
    expect(fileIconKind('a.tsx')).toBe('react');
    expect(fileIconKind('a.vue')).toBe('vue');
  });
});

describe('fileIconKind:非代码文件', () => {
  it('配置 / 结构化数据归 data', () => {
    for (const n of ['package.json', 'pnpm-lock.yaml', 'Cargo.toml', 'tsconfig.json', '.npmrc']) {
      expect(fileIconKind(n)).toBe('data');
    }
    expect(fileIconKind('.env')).toBe('data');
    expect(fileIconKind('.env.local')).toBe('data');
  });

  it('文档 / 纯文本归 doc', () => {
    for (const n of ['README.md', 'notes.txt', 'CHANGELOG', 'LICENSE', 'app.log']) {
      expect(fileIconKind(n)).toBe('doc');
    }
  });

  it('图片 / 压缩包 / 音视频 / 表格 / PDF 各有其类', () => {
    expect(fileIconKind('logo.png')).toBe('image');
    expect(fileIconKind('icon.svg')).toBe('image');
    expect(fileIconKind('dist.zip')).toBe('archive');
    expect(fileIconKind('bundle.tar.gz')).toBe('archive');
    expect(fileIconKind('clip.mp4')).toBe('media');
    expect(fileIconKind('song.mp3')).toBe('media');
    expect(fileIconKind('data.csv')).toBe('sheet');
    expect(fileIconKind('book.pdf')).toBe('pdf');
  });

  it('无扩展名 / 未知扩展名归 file', () => {
    expect(fileIconKind('weird.xyz')).toBe('file');
    expect(fileIconKind('Makefile.unknown')).toBe('file');
    expect(fileIconKind('noext')).toBe('file');
    expect(fileIconKind('.bashrc')).toBe('file'); // 未在 NAME_KIND 中的隐藏文件
    expect(fileIconKind('Dockerfile')).toBe('code'); // 已知无扩展名但确属源码
  });
});

describe('fileIconKind:大小写与路径', () => {
  it('大小写不敏感', () => {
    expect(fileIconKind('MAIN.TS')).toBe('ts');
    expect(fileIconKind('Main.RS')).toBe('rust');
    expect(fileIconKind('Logo.PNG')).toBe('image');
  });

  it('只看文件名部分,不看目录名', () => {
    expect(fileIconKind('src/rust/tool.rs')).toBe('rust');
    expect(fileIconKind('a/b/c/app.vue')).toBe('vue');
    expect(fileIconKind('notes/readme.md')).toBe('doc');
  });
});
