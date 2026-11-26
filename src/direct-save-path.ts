/**
 * 直发「保存到指定目录」的落点校验(ADR-0028):浏览器给的是 daemon 所在机器的
 * 绝对路径,因此一律在 daemon 侧用 process.platform 判定,不能读浏览器 navigator。
 *
 * 只校验目录、不创建目录:写文件的事交给 direct 服务在收齐并校验 sha256 之后做。
 * 校验放在「确认接收」这一步,而且比「写之前再看一眼」严格 —— 提权只发生一次,
 * 传输可能要几分钟,期间该目录完全可能被改成共享目录;落盘前再校验一次并不能
 * 撤销「提权已发出去」这件事,所以干脆在这里就拒掉可疑位置:直发文件永远不该
 * 落进会被同步的目录。
 */
import { realpathSync, statSync } from 'node:fs';
import { homedir, platform as runtimePlatform } from 'node:os';
import { isAbsolute, parse, resolve, sep } from 'node:path';

export interface DirectSaveDirOptions {
  /** daemon 数据目录(<configDir>):直发状态自己住的地方,不允许另存进去。 */
  configDir: string;
  /** 当前共享目录路径(每次请求现读配置,热重载后也生效)。 */
  sharedFolders: readonly string[];
  /** 仅供测试注入;缺省取 daemon 的 process.platform。 */
  platform?: NodeJS.Platform;
  homeDir?: string;
}

/** 尽量取真实路径:符号链接指向共享目录时也必须被挡住。 */
function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function isWithin(child: string, parent: string): boolean {
  const root = canonical(parent);
  return child === root || child.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** 系统目录按平台给一小组明确名单;不试图枚举所有可能危险的位置。 */
function systemDirs(platform: NodeJS.Platform, home: string): string[] {
  if (platform === 'win32') {
    return [
      process.env.SystemRoot ?? 'C:\\Windows',
      process.env.ProgramFiles ?? 'C:\\Program Files',
      process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
      process.env.ProgramData ?? 'C:\\ProgramData',
      joinHome(home, '.ssh'),
    ];
  }
  return [
    '/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/opt',
    // 不列 /var 与 /private:macOS 的 /tmp、/var/folders 都指向 /private/var,
    // 列了会把系统临时目录一起挡掉(单测夹具就住在那里)。
    '/System', '/Library', '/proc', '/sys', '/dev', '/boot',
    joinHome(home, '.ssh'),
  ];
}

function joinHome(home: string, child: string): string {
  return `${home}${home.endsWith(sep) ? '' : sep}${child}`;
}

/** 某些 @types/node 把 os.platform 声明成函数;两种形态都接住。 */
function currentPlatform(): NodeJS.Platform {
  return typeof runtimePlatform === 'function' ? runtimePlatform() : runtimePlatform;
}

/** 校验并规范化另存目录;不合法时抛中文错误,路由直接回给 UI。 */
export function resolveDirectSaveDir(input: string, opts: DirectSaveDirOptions): string {
  const raw = input.trim();
  if (!raw) throw new Error('请填写保存目录');
  if (!isAbsolute(raw)) {
    const platform = opts.platform ?? currentPlatform();
    const example = platform === 'win32' ? 'F:\\shared\\received' : '/home/me/Downloads';
    throw new Error(`请填写 daemon 所在机器的绝对路径,如 ${example}`);
  }
  const abs = canonical(raw);
  try {
    const st = statSync(abs);
    if (!st.isDirectory()) throw new Error('保存位置必须是目录');
  } catch (err) {
    if (err instanceof Error && err.message === '保存位置必须是目录') throw err;
    throw new Error('目录不存在或无法访问');
  }

  const home = canonical(opts.homeDir ?? homedir());
  // 根目录与用户主目录本身拒绝,但允许 ~/Downloads 这类子目录。
  if (abs === canonical(parse(abs).root) || abs === home) {
    throw new Error('不能保存到磁盘根目录或用户主目录本身,请选择一个子目录');
  }
  if (isWithin(abs, opts.configDir)) {
    throw new Error('不能保存到 syncx 数据目录,请换一个普通目录');
  }
  if (opts.sharedFolders.some((f) => isWithin(abs, f))) {
    throw new Error('不能保存到已共享目录或其子目录,那会产生同步冲突');
  }
  if (systemDirs(opts.platform ?? currentPlatform(), home).some((d) => isWithin(abs, d))) {
    throw new Error('不能保存到系统目录,请选择用户自己的目录');
  }
  return abs;
}
