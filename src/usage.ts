import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 运行期读取 syncx 自身的版本号。
 *
 * 解析规则基于「模块自身位置」,两种情况都能命中:
 * - 打包后 dist/syncx.js  → 包根 package.json(全局安装时同理,位于包目录内)
 * - 开发态 src/usage.ts   → 项目根 package.json
 *
 * 逐级向上找,并用 name 校验命中的确实是 syncx 自己的 package.json
 * (避免读到某个父目录里无关的包描述文件)。读不到时返回 'unknown',
 * 不让 --version 因为取版本号而崩掉。
 */
export function packageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const names = new Set(['@wangmingfa/syncx', 'syncx']);
  let fallback: string | undefined;
  for (const rel of ['..', '../..', '../../..']) {
    try {
      const pkg = JSON.parse(readFileSync(join(here, rel, 'package.json'), 'utf8')) as {
        name?: unknown;
        version?: unknown;
      };
      if (typeof pkg.version !== 'string') continue;
      if (typeof pkg.name === 'string' && names.has(pkg.name)) return pkg.version;
      fallback ??= pkg.version;
    } catch {
      // 路径不存在或不是合法 JSON:继续向上一级
    }
  }
  return fallback ?? 'unknown';
}

/** 帮助/版本开关:任一参数精确匹配即生效(与 npm 等常见 CLI 行为一致)。 */
const HELP_FLAGS = new Set(['-h', '--help']);
const VERSION_FLAGS = new Set(['-v', '--version']);

export function wantsHelp(argv: readonly string[]): boolean {
  return argv.some((a) => HELP_FLAGS.has(a));
}

export function wantsVersion(argv: readonly string[]): boolean {
  return argv.some((a) => VERSION_FLAGS.has(a));
}

/** 顶层帮助文本。version 由调用方注入(运行期读取,不硬编码)。 */
export function helpText(version: string): string {
  return [
    `syncx ${version} - 局域网 P2P 文件同步`,
    '',
    '用法:',
    '  syncx <command> [options]',
    '',
    '命令:',
    '  start                     启动 daemon(默认命令,可省略)',
    '  stop                      停止运行中的 daemon(优先优雅关闭)',
    '  status                    查看 Device ID 与共享目录概况',
    '  install                   输出系统服务模板(systemd / launchd / Windows)',
    '  invite <folder-path>      为已配置的共享目录生成一次性邀请码',
    '  join <code> <local-path>  接受邀请并添加本地共享目录',
    '  revoke <code>             吊销一个已发出的邀请码',
    '',
    '选项:',
    '  -h, --help                显示本帮助',
    '  -v, --version             显示版本号',
    '  --config <path>           配置文件路径(默认 ~/.syncx/config.json)',
    '  --port <port>             peer 监听端口(默认 22000)',
    '  --control-port <port>     Web UI / 控制 API 端口(默认 8384)',
    '  --host <host>             控制 API 绑定地址(默认 127.0.0.1)',
    '  --expose-control          允许把控制 API 绑到非回环地址(明文 HTTP,谨慎使用)',
    '  --log-file <path>         同时把日志写入文件',
    '  --dev-vite <url>          开发用:把 Web UI 请求代理到 vite dev server',
    '',
    '示例:',
    '  syncx start                    启动 daemon,打开 http://127.0.0.1:8384',
    '  syncx stop                     停止运行中的 daemon',
    '  syncx status                   查看本机 Device ID',
    '  syncx invite D:/sync           生成邀请码交给对端',
    '  syncx join <code> D:/sync      接受邀请并开始同步',
    '',
  ].join('\n');
}
