import { expect, it, vi } from 'vitest';
import { run } from './cli.js';
import { runCloudflareProvision } from './commands/cloudflare/provision.js';

vi.mock('./commands/cloudflare/provision.js', () => ({
  runCloudflareProvision: vi.fn(async () => 0),
}));

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
      'cloudflare setup',
      'cloudflare provision',
      'cloudflare deploy',
      'cloudflare smoke',
      'cloudflare teardown',
      'cloudflare janitor',
      'cloudflare migrate',
      'cloudflare bootstrap',
      'secrets generate-master-key',
      'admin bootstrap',
      'admin reset-local',
      'admin rebind-provider',
      'admin show-provider-binding',
      'import cutover-check',
      'import private-packagist fetch',
      'import satis plan',
      'import submit',
      'import status <run>',
      'import credentials <run>',
      'import verify <run>',
      'import accept <run>',
      'source accept-removal',
      'version',
    ]);
    expect(help).not.toContain('pb openapi');
  } finally {
    output.mockRestore();
  }
});

it('accepts --abandon-intent only on provision and requires a value', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const provision = vi.mocked(runCloudflareProvision);
    provision.mockClear();
    expect(
      await run(['cloudflare', 'provision', '--worker-name', 'broker', '--abandon-intent', 'op-1']),
    ).toBe(0);
    expect(provision).toHaveBeenCalledWith(expect.objectContaining({ abandonIntent: 'op-1' }));
    expect(
      await run(['cloudflare', 'provision', '--worker-name', 'broker', '--abandon-intent']),
    ).toBe(2);
    expect(
      await run(['cloudflare', 'migrate', '--database-id', 'x', '--abandon-intent', 'op-1']),
    ).toBe(2);
    expect(provision).toHaveBeenCalledTimes(1);
  } finally {
    error.mockRestore();
  }
});
