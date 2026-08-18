export interface InstallTarget {
  executable: string;
  configPath: string;
}

/** systemd ExecStart 用空格分隔参数,路径内空格/反斜杠必须转义,否则会被拆成多个参数。 */
function escapeSystemd(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/ /g, '\\ ');
}

/** launchd plist 是 XML,路径中的 & < > " ' 必须转义为实体,否则生成非法 XML。 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Windows sc 的 binPath 用双引号包裹,路径内双引号会提前闭合字符串,需转义。 */
function escapeWindows(value: string): string {
  return value.replace(/"/g, '\\"');
}

export function renderSystemdUnit(target: InstallTarget): string {
  const executable = escapeSystemd(target.executable);
  const configPath = escapeSystemd(target.configPath);
  return `[Unit]
Description=syncx file sync daemon
After=network.target

[Service]
Type=simple
ExecStart=${executable} start --config ${configPath}
Restart=on-failure

[Install]
WantedBy=multi-user.target
`;
}

export function renderLaunchdPlist(target: InstallTarget): string {
  const executable = escapeXml(target.executable);
  const configPath = escapeXml(target.configPath);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.syncx.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${executable}</string>
    <string>start</string>
    <string>--config</string>
    <string>${configPath}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`;
}

export function renderWindowsService(target: InstallTarget): string {
  const executable = escapeWindows(target.executable);
  const configPath = escapeWindows(target.configPath);
  return `sc create syncx binPath= "${executable} start --config ${configPath}" start= auto
sc start syncx
`;
}
