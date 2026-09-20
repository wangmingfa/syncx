/**
 * 文件名 → 图标类别。纯函数,便于单测:对比表按扩展名给常见文件配不同图标。
 *
 * 两级粒度:
 *  - **代码文件按语言细分**(rust / moonbit / js / ts / react / vue / python / go / java / c /
 *    html / css / sql / shell),一枚图形只对应一种语言,颜色取品牌色偏暗一档(浅底上够清晰);
 *  - 语言图形未覆盖的源码(svelte / rb / php / swift / …)统一归 `code`,
 *    非代码文件按大类(json / data / markdown / doc / image / …),未知扩展名归 `file`。
 *
 * 两处易混的取舍:
 *  - **json 与 data 分成两类**:json 用花括号(通用 JSON 图标),yaml/toml/ini/.env 这些
 *    通用配置用滑杆。两者若同用花括号,一屏里全是同一个图形,反而认不出哪个是 JSON。
 *  - **markdown 与 doc 分开**:md 用官方 mark(方块 + M + 下箭头),txt/rst/log 才是折角页。
 */
export type FileIconKind =
  // —— 代码:按语言(后缀)细分
  | 'rust'
  | 'moonbit'
  | 'js'
  | 'ts'
  | 'react'
  | 'vue'
  | 'python'
  | 'go'
  | 'java'
  | 'c'
  | 'html'
  | 'css'
  | 'sql'
  | 'shell'
  /** 通用源码:已知是代码、但没有专属图形的语言 */
  | 'code'
  // —— 非代码
  /** 一对花括号:JSON / JSONC(其余配置类归 data) */
  | 'json'
  /** 通用配置:yaml / toml / ini / .env 等(滑杆图形) */
  | 'data'
  /** 官方 mark:方块 + M + 下箭头 */
  | 'markdown'
  | 'doc'
  | 'image'
  | 'archive'
  | 'media'
  | 'sheet'
  | 'pdf'
  | 'file';

const EXT_KIND: Record<string, FileIconKind> = {
  // —— 代码:有专属图形的语言
  rs: 'rust',
  // MoonBit:.mbt 源码 / .mbti 接口文件(由 `moon info` 生成,同属这门语言)
  mbt: 'moonbit', mbti: 'moonbit',
  js: 'js', mjs: 'js', cjs: 'js',
  ts: 'ts', mts: 'ts', cts: 'ts',
  jsx: 'react', tsx: 'react', // React 组件(后缀即 JSX/TSX)
  vue: 'vue',
  py: 'python', pyi: 'python', pyw: 'python',
  go: 'go',
  java: 'java',
  c: 'c', h: 'c', cc: 'c', cpp: 'c', cxx: 'c', hpp: 'c', hh: 'c', hxx: 'c',
  html: 'html', htm: 'html', xhtml: 'html',
  css: 'css', scss: 'css', sass: 'css', less: 'css', styl: 'css',
  sql: 'sql',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
  ps1: 'shell', bat: 'shell', cmd: 'shell',

  // —— 代码:无专属图形,归通用源码图标
  svelte: 'code', astro: 'code', rb: 'code', php: 'code', swift: 'code',
  kt: 'code', kts: 'code', scala: 'code', cs: 'code', dart: 'code', lua: 'code',
  pl: 'code', r: 'code', jl: 'code', ex: 'code', exs: 'code', erl: 'code',
  clj: 'code', hs: 'code', ml: 'code', elm: 'code', zig: 'code', nim: 'code',
  groovy: 'code', gradle: 'code', proto: 'code',

  // —— 结构化数据:JSON 单独成一类(大括号),其余配置归 data
  json: 'json', json5: 'json', jsonc: 'json',
  yaml: 'data', yml: 'data', toml: 'data', ini: 'data',
  conf: 'data', cfg: 'data',

  // —— 文档 / 纯文本（.mbt.md 这类复合后缀也按最后一个后缀算,正好是 markdown）
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  txt: 'doc', rst: 'doc', log: 'doc',

  // —— 图片
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', svg: 'image',
  webp: 'image', ico: 'image', bmp: 'image', avif: 'image', tiff: 'image',

  // —— 压缩包
  zip: 'archive', tar: 'archive', gz: 'archive', tgz: 'archive',
  bz2: 'archive', xz: 'archive', '7z': 'archive', rar: 'archive', zst: 'archive',

  // —— 音视频
  mp3: 'media', wav: 'media', flac: 'media', ogg: 'media', m4a: 'media', aac: 'media',
  mp4: 'media', mov: 'media', mkv: 'media', webm: 'media', avi: 'media',

  // —— 表格
  csv: 'sheet', tsv: 'sheet', xls: 'sheet', xlsx: 'sheet', ods: 'sheet',

  // —— PDF
  pdf: 'pdf',
};

/** 无扩展名的常见文件名(小写整名匹配)。 */
const NAME_KIND: Record<string, FileIconKind> = {
  dockerfile: 'code',
  makefile: 'code',
  'cmakelists.txt': 'code',
  'cargo.lock': 'data',
  'package-lock.json': 'data',
  readme: 'doc',
  license: 'doc',
  copying: 'doc',
  changelog: 'doc',
  '.gitignore': 'data',
  '.gitattributes': 'data',
  '.dockerignore': 'data',
  '.editorconfig': 'data',
  '.npmrc': 'data',
  '.nvmrc': 'data',
};

/** 取小写扩展名(不含点);无扩展名 / 隐藏文件(如 .gitignore)返回空串。 */
export function extOf(name: string): string {
  const base = name.slice(name.lastIndexOf('/') + 1);
  const i = base.lastIndexOf('.');
  if (i <= 0) return ''; // 无点,或点在首位(隐藏文件)
  return base.slice(i + 1).toLowerCase();
}

/** 文件名 → 图标类别。识别 .env / .env.* 与常见无扩展名文件;其余按扩展名,未知归 'file'。 */
export function fileIconKind(name: string): FileIconKind {
  const base = name.slice(name.lastIndexOf('/') + 1).toLowerCase();
  if (base === '.env' || base.startsWith('.env.')) return 'data';
  const named = NAME_KIND[base];
  if (named) return named;
  return EXT_KIND[extOf(base)] ?? 'file';
}
