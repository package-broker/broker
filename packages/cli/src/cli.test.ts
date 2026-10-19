import { expect, it, vi } from 'vitest';
import { run } from './cli.js';

it('lists only working commands in --help', async () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    expect(await run(['--help'])).toBe(0);
    expect(output).toHaveBeenCalledTimes(1);
    const help = String(output.mock.calls[0]?.[0]);
    const commands = [...help.matchAll(/(?:Usage: |^\s+)pb (.+?)(?= --| \[|$)/gm)].map(
      (match) => match[1],
    );
    expect(commands).toEqual([
      'build',
      'migrate',
      'bootstrap',
      'cloudflare migrate',
      'cloudflare bootstrap',
      'secrets generate-master-key',
      'admin bootstrap',
      'admin reset-local',
      'admin rebind-provider',
      'admin show-provider-binding',
      'version',
    ]);
    expect(help).not.toContain('pb openapi');
  } finally {
    output.mockRestore();
  }
});
