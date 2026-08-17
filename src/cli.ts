export interface ParsedArgs {
  command: 'start' | 'status';
  configPath?: string;
  port?: number;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;

  const result: ParsedArgs = { command: command as 'start' | 'status' };
  if (result.command !== 'start' && result.command !== 'status') {
    throw new Error(`unknown command: ${String(command)}`);
  }

  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (flag === '--config') {
      result.configPath = value;
      i++;
    } else if (flag === '--port') {
      result.port = Number(value);
      i++;
    } else {
      throw new Error(`unknown option: ${flag}`);
    }
  }

  return result;
}

import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { loadOrCreateIdentity } from './identity.js';
import { loadConfig } from './config.js';
import { openIndexStore } from './indexstore.js';

/**
 * Run a command against the daemon's data directory. The lifecycle is kept
 * thin on purpose: real daemon integration tests are a later batch.
 */
export async function run(args: ParsedArgs): Promise<void> {
  const configDir = args.configPath ? dirname(args.configPath) : join(homedir(), '.syncx');

  const identity = loadOrCreateIdentity(configDir);
  const config = loadConfig(join(configDir, 'config.json'));
  const index = openIndexStore(join(configDir, 'index.db'));

  if (args.command === 'status') {
    console.log(`device: ${identity.deviceId}`);
    console.log(`shared folders: ${config.sharedFolders.length}`);
    index.close();
    return;
  }

  console.log(`syncx daemon started (device ${identity.deviceId})`);
  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      index.close();
      resolve();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}
