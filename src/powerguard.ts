/**
 * 计费网络 / 电池感知(Windows):周期探测系统状态,命中「按流量计费的联网」或
 * 「用电池且电量过低」时向会话管理器上报一个挂起原因(reason),数据面随之停摆
 * (见 session-manager.setPowerGuardReason);条件解除自动恢复。
 *
 * 设计要点:
 * - 只在 win32 启用(探测脚本依赖 WinRT NetworkInformation + Win32_Battery);
 *   其他平台 start() 是空操作,不产生子进程。
 * - 探针是**一次** PowerShell 调用输出两行键值(`COST=...` / `BAT=<pct>,<status>`),
 *   解析与状态机(parseProbeOutput / computeReason)纯函数化,exec 可注入,单测不起真进程。
 * - 探测失败(电源管理接口偶发抛错、powershell 不可用)只 warn 并维持上一次判定,
 *   绝不让旁路功能拖垮同步;定时器 unref,不阻止进程退出。
 * - 开关与阈值每次探测现读配置(loadConfig 口径),设置弹窗改完即时生效,无需重启。
 */

/** 一次探测的原始读数;字段缺省 = 该项没探到(不是网络无成本,而是「未知」→ 不据此挂起)。 */
export interface PowerReading {
  /** WinRT ConnectionCost.CostType 字符串,如 'Roaming' / 'ApproachingDataCap' / 'Standard'。 */
  costType?: string;
  /** Win32_Battery.EstimatedChargeRemaining(0–100)。 */
  batteryPercent?: number;
  /** true = 正在用电池(BatteryStatus===1 且无 AC);BatteryStatus 2 = 外接供电。 */
  onBattery?: boolean;
}

/** WinRT 里视为「会计费/有流量顾虑」的成本类型。Standard/None/NoDataPlansFound/Unknown 等不计入。 */
export const METERED_COST_TYPES: ReadonlySet<string> = new Set([
  'Roaming',
  'OverDataCap',
  'ApproachingDataCap',
  'Fixed',
  'TrafficDisabledForRoaming',
  'SharedData',
  // 蜂窝数据(WWAN)无流量上限概念上也是计费网络:部分 PowerShell 版本枚举投影失败,
  // 探针按布尔属性回退合成该标记(见 PROBE_SCRIPT)
  'Wwan',
]);

/**
 * 解析探针输出:逐行找 `COST=<枚举名>` 与 `BAT=<pct>,<batteryStatus>`,其余行(PS 警告、
 * 空行)忽略。数字非法(NaN/负/超 100)按未探到处理,宁可少挂起也不误伤。
 */
export function parseProbeOutput(out: string): PowerReading {
  const reading: PowerReading = {};
  for (const line of out.split(/\r?\n/)) {
    const cost = /^COST=(\S+)\s*$/.exec(line.trim());
    if (cost) {
      reading.costType = cost[1];
      continue;
    }
    const bat = /^BAT=(\d+(?:\.\d+)?),(\d+)\s*$/.exec(line.trim());
    if (bat) {
      const pct = Number(bat[1]);
      const status = Number(bat[2]);
      if (Number.isFinite(pct) && pct >= 0 && pct <= 100) reading.batteryPercent = pct;
      // BatteryStatus:1=放电(用电池),2=交流供电;其余(缺失/异常)按未知处理
      if (status === 1 || status === 2) reading.onBattery = status === 1;
    }
  }
  return reading;
}

/** 生效中的电源守卫设置(每次探测现读)。 */
export interface PowerGuardSettings {
  pauseOnMeteredNetwork?: boolean;
  pauseOnLowBattery?: boolean;
  /** 低电量挂起阈值(%);缺省 20。 */
  batteryPauseThreshold?: number;
}

export const DEFAULT_BATTERY_PAUSE_THRESHOLD = 20;

/**
 * 由读数 + 设置算挂起原因;null = 无需挂起。两条规则都开时原因用「、」并联。
 * 计费网络只看 costType;低电量必须「在用电池」且 pct <= 阈值,插电时再低的百分比也不管
 * (台式机可能根本没有 BatteryStatus 行 → onBattery undefined → 不挂起)。
 */
export function computeReason(reading: PowerReading, settings: PowerGuardSettings): string | null {
  const parts: string[] = [];
  if (settings.pauseOnMeteredNetwork === true && reading.costType && METERED_COST_TYPES.has(reading.costType)) {
    parts.push(`计费网络(${reading.costType})`);
  }
  if (
    settings.pauseOnLowBattery === true &&
    reading.onBattery === true &&
    reading.batteryPercent !== undefined &&
    reading.batteryPercent <= (settings.batteryPauseThreshold ?? DEFAULT_BATTERY_PAUSE_THRESHOLD)
  ) {
    parts.push(`低电量(${reading.batteryPercent}%)`);
  }
  return parts.length > 0 ? parts.join('、') : null;
}

/**
 * 一次 PowerShell 探测:网络成本 + 电池,任一接口不可用只是少了相应输出行,不视为失败。
 * 成本优先取 CostType 枚举名;部分 Windows PowerShell 5.1 版本的 WinRT 枚举投影返回
 * null(实测),此时按布尔属性回退合成等价的类型名(Roaming / OverDataCap /
 * ApproachingDataCap / Wwan / SharedData),探不到就报 Standard(= 不计费)。
 */
export const PROBE_SCRIPT = [
  'try { $p = [Windows.Networking.Connectivity.NetworkInformation,Windows.Networking.Connectivity,ContentType=WindowsRuntime]::GetInternetConnectionProfile();',
  '  if ($p) { $c = $p.GetConnectionCost(); $t = ""; try { $t = $c.CostType.ToString() } catch {}',
  "    if (-not $t) { if ($c.Roaming) { $t = 'Roaming' } elseif ($c.OverDataLimit) { $t = 'OverDataCap' } elseif ($c.ApproachingDataLimit) { $t = 'ApproachingDataCap' } elseif ($p.IsWwanConnectionProfile) { $t = 'Wwan' } elseif ($c.SharedOutbound -or $c.SharedInbound) { $t = 'SharedData' } else { $t = 'Standard' } }",
  "    Write-Output ('COST=' + $t) } } catch {}",
  'try { $b = Get-CimInstance -ClassName Win32_Battery -ErrorAction Stop;',
  '  if ($b) { Write-Output ("BAT=" + [math]::Round($b.EstimatedChargeRemaining) + "," + $b.BatteryStatus) } } catch {}',
].join(' ');

export interface PowerGuardOptions {
  /** 运行一次探针脚本并返回 stdout(execFile powershell -NoProfile -NonInteractive -Command …)。 */
  exec: (script: string) => Promise<string>;
  /** 现读守卫设置(daemon 侧传 () => loadConfig(configPath),改设置免重启)。 */
  getSettings: () => PowerGuardSettings;
  /** 挂起原因变化时回调(null = 解除);仅在真变化时触发。 */
  onStateChange: (reason: string | null) => void;
  /** 平台注入(默认 process.platform);非 win32 时整个守卫禁用。 */
  platform?: string;
  /** 轮询间隔 ms,默认 60s;测试注入小值 + fake timers。 */
  intervalMs?: number;
  logger?: { info(m: string): void; warn(m: string): void };
}

export interface PowerGuard {
  /** 是否启用(仅 win32)。 */
  readonly enabled: boolean;
  /** 当前挂起原因(状态回显用;未启用/未探到则 null)。 */
  current(): string | null;
  /** 启动:立即探测一次,随后按间隔轮询;重复调用幂等。 */
  start(): void;
  /** 停止轮询并解除已上报的挂起(关闭 daemon 时调用)。 */
  stop(): void;
}

const DEFAULT_INTERVAL_MS = 60_000;

export function createPowerGuard(opts: PowerGuardOptions): PowerGuard {
  const platform = opts.platform ?? process.platform;
  const enabled = platform === 'win32';
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const logger = opts.logger ?? { info: () => {}, warn: () => {} };
  let reason: string | null = null;
  let timer: NodeJS.Timeout | undefined;
  let inFlight = false;

  function report(next: string | null): void {
    if (next === reason) return;
    reason = next;
    if (next !== null) logger.info(`power guard: sync suspended (${next})`);
    else logger.info('power guard: condition cleared, sync resumed');
    try {
      opts.onStateChange(next);
    } catch (err) {
      logger.warn(`power guard state change failed: ${String(err)}`);
    }
  }

  async function probe(): Promise<void> {
    if (inFlight) return; // 上一轮还没回来(慢机器):跳过本 tick,不叠加子进程
    inFlight = true;
    try {
      const out = await opts.exec(PROBE_SCRIPT);
      report(computeReason(parseProbeOutput(out), opts.getSettings()));
    } catch (err) {
      // 探测失败维持上次判定:宁可晚一拍恢复,不要无依据地放行/挂起
      logger.warn(`power guard probe failed: ${String(err)}`);
    } finally {
      inFlight = false;
    }
  }

  return {
    enabled,
    current: () => reason,
    start() {
      if (!enabled || timer !== undefined) return;
      void probe();
      timer = setInterval(() => void probe(), intervalMs);
      timer.unref();
    },
    stop() {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      report(null);
    },
  };
}
