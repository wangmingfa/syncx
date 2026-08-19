import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli.js';

describe('cli parseArgs', () => {
  it('parses the start command with defaults', () => {
    expect(parseArgs(['start'])).toEqual({
      command: 'start',
      configPath: undefined,
      port: undefined,
      controlPort: undefined,
      host: undefined,
      positionals: [],
    });
  });

  it('parses the status command with defaults', () => {
    expect(parseArgs(['status'])).toEqual({
      command: 'status',
      configPath: undefined,
      port: undefined,
      controlPort: undefined,
      host: undefined,
      positionals: [],
    });
  });

  it('parses --config and --port options', () => {
    expect(parseArgs(['start', '--config', '/etc/syncx.json', '--port', '22000'])).toEqual({
      command: 'start',
      configPath: '/etc/syncx.json',
      port: 22000,
      controlPort: undefined,
      host: undefined,
      positionals: [],
    });
  });

  it('parses the --control-port option', () => {
    expect(
      parseArgs(['start', '--config', '/etc/syncx.json', '--port', '22000', '--control-port', '8385']),
    ).toEqual({
      command: 'start',
      configPath: '/etc/syncx.json',
      port: 22000,
      controlPort: 8385,
      host: undefined,
      positionals: [],
    });
  });

  it('parses the --host option', () => {
    expect(
      parseArgs(['start', '--config', '/etc/syncx.json', '--host', '0.0.0.0']),
    ).toEqual({
      command: 'start',
      configPath: '/etc/syncx.json',
      port: undefined,
      controlPort: undefined,
      host: '0.0.0.0',
      positionals: [],
    });
  });

  it('parses the install command with defaults', () => {
    expect(parseArgs(['install'])).toEqual({
      command: 'install',
      configPath: undefined,
      port: undefined,
      controlPort: undefined,
      host: undefined,
      positionals: [],
    });
  });

  it('rejects an unknown command', () => {
    expect(() => parseArgs(['frobnicate'])).toThrow(/unknown command/);
  });

  it('parses the invite command with a positional folder path', () => {
    expect(parseArgs(['invite', '/data/docs'])).toEqual({
      command: 'invite',
      configPath: undefined,
      port: undefined,
      controlPort: undefined,
      host: undefined,
      positionals: ['/data/docs'],
    });
  });

  it('parses the join command with code and local path positionals', () => {
    expect(parseArgs(['join', 'SOMECODE123', '/local/path'])).toEqual({
      command: 'join',
      configPath: undefined,
      port: undefined,
      controlPort: undefined,
      host: undefined,
      positionals: ['SOMECODE123', '/local/path'],
    });
  });

  it('parses the revoke command with an invite code positional', () => {
    expect(parseArgs(['revoke', 'SOMECODE123'])).toEqual({
      command: 'revoke',
      configPath: undefined,
      port: undefined,
      controlPort: undefined,
      host: undefined,
      positionals: ['SOMECODE123'],
    });
  });

  it('collects positionals alongside flags for invite', () => {
    expect(parseArgs(['invite', '/data/docs', '--config', '/etc/syncx.json'])).toEqual({
      command: 'invite',
      configPath: '/etc/syncx.json',
      port: undefined,
      controlPort: undefined,
      host: undefined,
      positionals: ['/data/docs'],
    });
  });
});
