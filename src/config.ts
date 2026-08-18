import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export interface SharedFolderConfig {
  path: string;
  devices: string[];
}

export interface Config {
  sharedFolders: SharedFolderConfig[];
  /** 手动配置的对端 ws:// 地址列表(mDNS 不可用时的回退)。 */
  peers: string[];
}

export const DEFAULT_CONFIG: Config = {
  sharedFolders: [],
  peers: [],
};

export function loadConfig(configPath: string): Config {
  if (!existsSync(configPath)) {
    return structuredClone(DEFAULT_CONFIG);
  }
  const raw = readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(raw) as Config;
  return {
    sharedFolders: parsed.sharedFolders ?? [],
    peers: parsed.peers ?? [],
  };
}

export function saveConfig(configPath: string, config: Config): void {
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}
