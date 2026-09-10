import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rmDir } from './helpers.js';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { run } from '../src/cli.js';
import { parseArgs } from '../src/args.js';
import { loadOrCreateIdentity } from '../src/identity.js';
import { createInviteCode, parseInviteCode } from '../src/invite.js';
import { loadConfig } from '../src/config.js';

describe('join (mutual trust)', () => {
  it('whitelists the inviter and emits a reciprocal invite for the inviter to whitelist back', async () => {
    const base = mkdtempSync(join(tmpdir(), 'syncx-join-'));
    const configPath = join(base, 'config.json');
    writeFileSync(configPath, JSON.stringify({ sharedFolders: [], peers: [] }));

    // 模拟对端(邀请方)生成的邀请码
    const inviter = loadOrCreateIdentity(join(base, 'inviter'));
    const code = createInviteCode(inviter, '/data/shared');

    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((m) => logs.push(String(m)));
    try {
      await run(parseArgs(['join', code, '/local/share', '--config', configPath]));
    } finally {
      spy.mockRestore();
    }

    // 本机已把邀请方加入白名单
    const cfg = loadConfig(configPath);
    expect(cfg.sharedFolders).toHaveLength(1);
    expect(cfg.sharedFolders[0]!.path).toBe(resolve('/local/share'));
    expect(cfg.sharedFolders[0]!.devices).toContain(inviter.deviceId);

    // 输出了回邀码,且回邀码解析出本机设备 ID(邀请方据此把本机加入白名单)
    const local = loadOrCreateIdentity(base);
    let reciprocalCode: string | undefined;
    for (const line of logs) {
      try {
        const parsed = parseInviteCode(line.trim());
        if (parsed.deviceId === local.deviceId) {
          reciprocalCode = line.trim();
          break;
        }
      } catch {
        // 普通日志行,非邀请码
      }
    }
    expect(reciprocalCode).toBeTruthy();

    rmDir(base);
  });
});
