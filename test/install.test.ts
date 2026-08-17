import { describe, expect, it } from 'vitest';
import { renderSystemdUnit, renderLaunchdPlist, renderWindowsService } from '../src/install.js';

describe('install templates', () => {
  it('renders a systemd unit that runs syncx start', () => {
    const unit = renderSystemdUnit({ executable: '/usr/bin/syncx', configPath: '/etc/syncx.json' });

    expect(unit).toContain('[Unit]');
    expect(unit).toContain('Description=syncx file sync daemon');
    expect(unit).toContain('[Service]');
    expect(unit).toContain('ExecStart=/usr/bin/syncx start --config /etc/syncx.json');
    expect(unit).toContain('[Install]');
    expect(unit).toContain('WantedBy=multi-user.target');
  });

  it('renders a launchd plist that keeps the daemon alive', () => {
    const plist = renderLaunchdPlist({
      executable: '/usr/local/bin/syncx',
      configPath: '/Users/me/.syncx/config.json',
    });

    expect(plist).toContain('Label</key>');
    expect(plist).toContain('com.syncx.daemon');
    expect(plist).toContain('KeepAlive</key>');
    expect(plist).toContain('<true/>');
    expect(plist).toContain('ProgramArguments</key>');
    expect(plist).toContain('/usr/local/bin/syncx');
    expect(plist).toContain('/Users/me/.syncx/config.json');
    expect(plist).toContain('RunAtLoad</key>');
  });

  it('renders a Windows service command line', () => {
    const service = renderWindowsService({
      executable: 'C:\\syncx\\syncx.exe',
      configPath: 'C:\\syncx\\config.json',
    });

    expect(service).toContain('syncx');
    expect(service).toContain('C:\\syncx\\syncx.exe');
    expect(service).toContain('--config C:\\syncx\\config.json');
  });
});
