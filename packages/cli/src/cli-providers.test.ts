import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { run } from './cli.js';
import { runCloudflareDeploy } from './commands/cloudflare/deploy.js';
import { runCloudflareSetup } from './commands/cloudflare/setup.js';

vi.mock('./commands/cloudflare/deploy.js', () => ({
  runCloudflareDeploy: vi.fn(async () => 0),
}));
vi.mock('./commands/cloudflare/setup.js', () => ({
  runCloudflareSetup: vi.fn(async () => 0),
}));

it('passes a parsed providers file to deploy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-providers-'));
  try {
    const file = join(dir, 'x.json');
    await writeFile(file, '[\n  \n]');
    const deploy = vi.mocked(runCloudflareDeploy);
    deploy.mockClear();
    expect(
      await run(['cloudflare', 'deploy', '--worker-name', 'broker', '--providers', file]),
    ).toBe(0);
    expect(deploy).toHaveBeenCalledWith(
      expect.objectContaining({ providers: { kind: 'set', value: '[]', ids: [] } }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('passes explicit providers removal to setup', async () => {
  const setup = vi.mocked(runCloudflareSetup);
  setup.mockClear();
  expect(await run(['cloudflare', 'setup', '--providers', 'none'])).toBe(0);
  expect(setup).toHaveBeenCalledWith(expect.objectContaining({ providers: { kind: 'remove' } }));
});

it('reports invalid providers as an input error before calling deploy', async () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const deploy = vi.mocked(runCloudflareDeploy);
  deploy.mockClear();
  try {
    expect(
      await run(['cloudflare', 'deploy', '--worker-name', 'broker', '--providers', '', '--json']),
    ).toBe(2);
    expect(deploy).not.toHaveBeenCalled();
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({
      error: { code: 'invalid_input', message: 'Invalid providers: unreadable', stage: 'deploy' },
    });
  } finally {
    output.mockRestore();
  }
});

it('reports setup provider errors at the setup stage', async () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const setup = vi.mocked(runCloudflareSetup);
  setup.mockClear();
  try {
    expect(await run(['cloudflare', 'setup', '--providers', '', '--json'])).toBe(2);
    expect(setup).not.toHaveBeenCalled();
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({
      error: { code: 'invalid_input', stage: 'setup' },
    });
  } finally {
    output.mockRestore();
  }
});

it('documents removal and escaping a file named none in help', async () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    expect(await run(['--help'])).toBe(0);
    expect(String(output.mock.calls[0]?.[0])).toContain(
      '--providers <file|none>: none removes the definitions; pass a file named none as ./none.',
    );
  } finally {
    output.mockRestore();
  }
});
