export interface InstallTarget {
  executable: string;
  configPath: string;
}

export function renderSystemdUnit(target: InstallTarget): string {
  return `[Unit]
Description=syncx file sync daemon
After=network.target

[Service]
Type=simple
ExecStart=${target.executable} start --config ${target.configPath}
Restart=on-failure

[Install]
WantedBy=multi-user.target
`;
}

export function renderLaunchdPlist(target: InstallTarget): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.syncx.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${target.executable}</string>
    <string>start</string>
    <string>--config</string>
    <string>${target.configPath}</string>
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
  return `sc create syncx binPath= "${target.executable} start --config ${target.configPath}" start= auto
sc start syncx
`;
}
