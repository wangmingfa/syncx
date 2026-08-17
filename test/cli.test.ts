import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli.js';

describe('cli parseArgs', () => {
  it('parses the start command with defaults', () => {
    expect(parseArgs(['start'])).toEqual({
      command: 'start',
      configPath: undefined,
      port: undefined,
    });
  });

  it('parses the status command with defaults', () => {
    expect(parseArgs(['status'])).toEqual({
      command: 'status',
      configPath: undefined,
      port: undefined,
    });
  });

  it('parses --config and --port options', () => {
    expect(parseArgs(['start', '--config', '/etc/syncx.json', '--port', '22000'])).toEqual({
      command: 'start',
      configPath: '/etc/syncx.json',
      port: 22000,
    });
  });

  it('rejects an unknown command', () => {
    expect(() => parseArgs(['frobnicate'])).toThrow(/unknown command/);
  });
});
